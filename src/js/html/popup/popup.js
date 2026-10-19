import { normalizeTag } from "../../wallabag-api/wallabag-api.js";
import {
    getUsableCurrentEntry,
    pickNewEntry,
    markWatched,
    matchesFilter,
} from "../../entry-state/entry-state.js";
import {
    getKnownCategories,
    refreshServerTags,
    findSimilarCategory,
    getFilter,
    setFilter,
} from "../../categories/categories.js";
import { ADD_JOB_KEY } from "../../queue/queue.js";
import { getSettings } from "../../config/config.js";

const ADD_TAGS_KEY = "addTags";
const CLOSE_AFTER_KEY = "closeAfterAdd";
const JOB_VISIBLE_MS = 2 * 60 * 1000;

let currentEntry = null;
let filterValue = "";
let known = { used: [], other: [] };
let addTags = [];
// pendingTag: { tag, similar, rest }, waiting for the user to decide on a similar tag
let pendingTag = null;
let jobWasRunning = false;

const $ = (id) => document.getElementById(id);

const status = $("status");
const card = $("card");
const preview = $("preview");
const title = $("title");
const domain = $("domain");
const readingTime = $("reading-time");
const entryTags = $("entry-tags");

const openBtn = $("open");
const rerollBtn = $("reroll");
const doneBtn = $("done");
const settingsBtn = $("settings");

const filterSection = $("filter");
const filterChips = $("filter-chips");

const tagChips = $("tag-chips");
const tagInput = $("tag-input");
const tagAddBtn = $("tag-add");
const tagDatalist = $("tag-suggestions");
const tagHint = $("tag-hint");
const tagQuick = $("tag-quick");

const addTabBtn = $("add-tab");
const addAllBtn = $("add-all");
const closeAfter = $("close-after");
const notice = $("notice");

function setStatus(text, state = "info") {
    status.textContent = text;
    status.dataset.state = state;
    status.hidden = !text;
}

function setNotice(text, state = "info") {
    notice.textContent = text;
    notice.dataset.state = state;
    notice.hidden = !text;
}

function setBusy(isBusy) {
    const disabled = isBusy || !currentEntry;
    openBtn.disabled = disabled;
    rerollBtn.disabled = disabled;
    doneBtn.disabled = disabled;

    addTabBtn.disabled = isBusy;
    addAllBtn.disabled = isBusy;
}

// textContent only: tags come from the server and the user and must not be parsed as HTML
function makeChip(label, { pressed, onClick, title: tooltip } = {}) {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "chip";
    chip.textContent = label;
    if (pressed !== undefined) {
        chip.setAttribute("aria-pressed", String(pressed));
    }
    if (tooltip) {
        chip.title = tooltip;
    }
    chip.addEventListener("click", onClick);
    return chip;
}

async function renderEntryTags(entry) {
    const system = normalizeTag((await getSettings()).tag);
    const own = (entry?.tags ?? []).filter((tag) => tag !== system);
    entryTags.textContent = own.map((tag) => `#${tag}`).join(" ");
    entryTags.hidden = own.length === 0;
}

function render(entry) {
    if (!entry) {
        setStatus(
            filterValue
                ? `No unarchived entries tagged "${filterValue}" yet`
                : "No unarchived entries with this tag yet",
        );
        card.hidden = true;
        return;
    }

    setStatus("");
    card.hidden = false;

    title.textContent = entry.title || entry.url;
    domain.textContent = entry.domainName || "";
    readingTime.textContent = entry.readingTime
        ? `~${entry.readingTime} min`
        : "";
    renderEntryTags(entry).catch(() => {
        entryTags.hidden = true;
    });

    if (entry.previewPicture) {
        preview.src = entry.previewPicture;
        preview.hidden = false;
        preview.onerror = () => {
            preview.hidden = true;
        };
    } else {
        preview.hidden = true;
    }
}

async function pick({ avoidCurrent = false } = {}) {
    setBusy(true);
    setStatus("Loading...");
    try {
        currentEntry = await pickNewEntry({ avoidCurrent });
        render(currentEntry);
    } catch (e) {
        currentEntry = null;
        if (e.message.includes("baseUrl is not set")) {
            setStatus(
                "Base URL is not set. Please open settings and configure it.",
                "error",
            );
        } else {
            setStatus(e.message, "error");
        }
        card.hidden = true;
    } finally {
        setBusy(false);
    }
}

function onOpen() {
    if (!currentEntry) {
        return;
    }
    chrome.tabs.create({ url: currentEntry.url });
    window.close();
}

async function onReroll() {
    await pick({ avoidCurrent: true });
}

async function onDone() {
    if (!currentEntry) {
        return;
    }
    setBusy(true);
    try {
        const result = await markWatched(currentEntry);
        if (result.gone) {
            setNotice("That entry no longer exists in wallabag", "info");
        }
    } catch (e) {
        setStatus(`Could not archive: ${e.message}`, "error");
        setBusy(false);
        return;
    }
    currentEntry = null;
    await pick();
}

function onSettings() {
    chrome.runtime.openOptionsPage();
    window.close();
}

function renderFilter() {
    const categories = [...known.used];
    if (filterValue && !categories.includes(filterValue)) {
        categories.push(filterValue);
    }
    filterSection.hidden = categories.length === 0;
    filterChips.replaceChildren(
        makeChip("All", {
            pressed: filterValue === "",
            onClick: () => onFilterClick(""),
        }),
        ...categories.map((tag) =>
            makeChip(tag, {
                pressed: tag === filterValue,
                onClick: () => onFilterClick(tag),
            }),
        ),
    );
}

async function onFilterClick(tag) {
    if (tag === filterValue) {
        return;
    }
    filterValue = tag;
    renderFilter();
    try {
        await setFilter(tag);
    } catch (e) {
        setStatus(e.message, "error");
        return;
    }
    if (!currentEntry || !matchesFilter(currentEntry, filterValue)) {
        await pick();
    }
}

function allKnown() {
    return [...known.used, ...known.other];
}

function renderTagControls() {
    tagChips.replaceChildren(
        ...addTags.map((tag) =>
            makeChip(`${tag} ×`, {
                pressed: true,
                title: `Remove "${tag}"`,
                onClick: () => removeAddTag(tag),
            }),
        ),
    );
    tagQuick.replaceChildren(
        ...known.used
            .filter((tag) => !addTags.includes(tag))
            .slice(0, 8)
            .map((tag) =>
                makeChip(`+ ${tag}`, {
                    pressed: false,
                    onClick: () => addTag(tag),
                }),
            ),
    );
    tagDatalist.replaceChildren(
        ...allKnown().map((tag) => {
            const option = document.createElement("option");
            option.value = tag;
            return option;
        }),
    );
}

function saveAddTags() {
    chrome.storage.local.set({ [ADD_TAGS_KEY]: addTags });
}

function addTag(tag) {
    if (!addTags.includes(tag)) {
        addTags.push(tag);
        saveAddTags();
    }
    renderTagControls();
}

function removeAddTag(tag) {
    addTags = addTags.filter((existing) => existing !== tag);
    saveAddTags();
    renderTagControls();
}

function hideTagHint() {
    tagHint.hidden = true;
    tagHint.replaceChildren();
}

async function parseTags(raw) {
    const system = normalizeTag((await getSettings()).tag);
    return [
        ...new Set(
            String(raw)
                .split(/[,;]/)
                .map(normalizeTag)
                .filter((tag) => tag && tag !== system),
        ),
    ];
}

async function addTagsFromInput() {
    const typed = await parseTags(tagInput.value);
    tagInput.value = "";
    return processTyped(typed);
}

function processTyped(typed) {
    const existing = allKnown();
    for (let i = 0; i < typed.length; i++) {
        const tag = typed[i];
        if (addTags.includes(tag)) {
            continue;
        }
        let similar = null;
        if (!existing.includes(tag)) {
            try {
                similar = findSimilarCategory(tag, existing);
            } catch {
                similar = null;
            }
        }
        // ask even if the similar tag is already selected
        if (similar && similar !== tag) {
            pendingTag = { tag, similar, rest: typed.slice(i + 1) };
            showSimilarHint();
            return false;
        }
        addTag(tag);
    }
    return true;
}

function showSimilarHint() {
    const { tag, similar } = pendingTag;
    tagHint.replaceChildren(
        `"${tag}" looks like the existing tag "${similar}". `,
        makeChip(`Use "${similar}"`, {
            onClick: () => resolvePending(similar),
        }),
        makeChip(`Keep "${tag}"`, { onClick: () => resolvePending(tag) }),
    );
    tagHint.hidden = false;
}

function resolvePending(choice) {
    const { rest } = pendingTag;
    pendingTag = null;
    hideTagHint();
    addTag(choice);
    processTyped(rest);
}

async function onTagAdd() {
    if (pendingTag) {
        return;
    }
    await addTagsFromInput();
}

function isAddable(url) {
    try {
        const { protocol } = new URL(url);
        return protocol === "http:" || protocol === "https:";
    } catch {
        return false;
    }
}

async function collectTabs(allInWindow) {
    const tabs = allInWindow
        ? await chrome.tabs.query({ currentWindow: true })
        : await chrome.tabs.query({ active: true, currentWindow: true });
    const seen = new Set();
    const items = [];
    for (const tab of tabs) {
        if (!tab.url || !isAddable(tab.url) || seen.has(tab.url)) {
            continue;
        }
        seen.add(tab.url);
        items.push({
            url: tab.url,
            title: tab.title || tab.url,
            tabId: tab.id,
        });
    }
    return items;
}

async function startAdding(allInWindow) {
    if (pendingTag) {
        setNotice("Choose how to handle the similar tag first", "error");
        return;
    }
    if (tagInput.value.trim() && !(await addTagsFromInput())) {
        setNotice("Choose how to handle the similar tag first", "error");
        return;
    }
    const items = await collectTabs(allInWindow);
    if (items.length === 0) {
        setNotice(
            allInWindow ? "No tabs can be added" : "This tab can't be added",
            "error",
        );
        return;
    }
    setNotice("Adding...", "info");
    try {
        const reply = await chrome.runtime.sendMessage({
            type: "add-tabs",
            items,
            closeTabs: closeAfter.checked,
            extraTags: addTags,
        });
        if (!reply?.ok) {
            setNotice(
                reply?.reason ?? "No reply from the background worker",
                "error",
            );
        }
    } catch (e) {
        setNotice(
            `Could not reach the background worker: ${e.message}`,
            "error",
        );
    }
}

function renderJob(job) {
    if (!job || !job.total) {
        return;
    }
    const processed = job.done + job.failed;
    if (job.running) {
        jobWasRunning = true;
        if (job.stalled) {
            setNotice(
                `Paused (${job.stalled}). Will retry shortly...`,
                "error",
            );
        } else {
            setNotice(`Adding ${processed} of ${job.total}...`, "info");
        }
        return;
    }
    if (job.stalled) {
        jobWasRunning = false;
        setNotice(
            `Stopped: ${job.stalled}. Check the settings, the rest will resume later.`,
            "error",
        );
        return;
    }
    if (job.finishedAt && Date.now() - job.finishedAt < JOB_VISIBLE_MS) {
        const failedPart = job.failed ? `, ${job.failed} failed` : "";
        const lastError = job.failed ? ` Last error: ${job.errors.at(-1)}` : "";
        setNotice(
            `Added ${job.done} of ${job.total}${failedPart}.${lastError}`,
            job.failed ? "error" : "ok",
        );
    }
    // the list may have been empty before: show an entry once something is added
    if (jobWasRunning && job.done > 0 && !currentEntry) {
        pick();
    }
    jobWasRunning = false;
}

async function loadKnown() {
    try {
        known = await getKnownCategories();
    } catch {
        known = { used: [], other: [] };
    }
    renderFilter();
    renderTagControls();
}

async function init() {
    openBtn.addEventListener("click", onOpen);
    rerollBtn.addEventListener("click", onReroll);
    doneBtn.addEventListener("click", onDone);
    settingsBtn.addEventListener("click", onSettings);
    tagAddBtn.addEventListener("click", onTagAdd);
    tagInput.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
            event.preventDefault();
            onTagAdd();
        }
    });
    tagInput.addEventListener("input", () => {
        if (pendingTag) {
            pendingTag = null;
            hideTagHint();
        }
    });
    addTabBtn.addEventListener("click", () => startAdding(false));
    addAllBtn.addEventListener("click", () => startAdding(true));
    closeAfter.addEventListener("change", () => {
        chrome.storage.local.set({ [CLOSE_AFTER_KEY]: closeAfter.checked });
    });

    chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== "local") {
            return;
        }
        if (changes[ADD_JOB_KEY]) {
            renderJob(changes[ADD_JOB_KEY].newValue);
        }
        // a scheduled notification may issue a new entry while the popup is open
        const incoming = changes.currentEntry?.newValue;
        if (incoming && incoming.id !== currentEntry?.id) {
            currentEntry = incoming;
            render(incoming);
            setBusy(false);
        }
    });

    const stored = await chrome.storage.local.get([
        ADD_TAGS_KEY,
        CLOSE_AFTER_KEY,
        ADD_JOB_KEY,
    ]);
    addTags = Array.isArray(stored[ADD_TAGS_KEY]) ? stored[ADD_TAGS_KEY] : [];
    closeAfter.checked = Boolean(stored[CLOSE_AFTER_KEY]);

    filterValue = await getFilter();
    await loadKnown();
    renderJob(stored[ADD_JOB_KEY]);

    currentEntry = await getUsableCurrentEntry();
    if (currentEntry) {
        render(currentEntry);
        setBusy(false);
    } else {
        await pick();
    }

    refreshServerTags()
        .then(loadKnown)
        .catch(() => {});
}

init().catch((e) => setStatus(e.message, "error"));
