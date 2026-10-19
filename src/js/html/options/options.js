import {
    DEFAULT_SETTINGS,
    getSettings,
    saveSettings,
} from "../../config/config.js";
import { clearCurrentEntry } from "../../entry-state/entry-state.js";
import {
    getAccessToken,
    countEntries,
} from "../../wallabag-api/wallabag-api.js";
import { signOut, resetAll } from "../../account/account.js";

const $ = (id) => document.getElementById(id);

const settingsForm = $("settings-form");
const saveButton = $("save");
const checkButton = $("check");
const testNotificationButton = $("test-notification");
const message = $("message");
const notificationsOn = $("notificationsOn");
const scheduleFieldsContainer = $("schedule-fields");
const tagInput = $("tag");
const tagWarning = $("tag-warning");
const signOutButton = $("sign-out");
const resetAllButton = $("reset-all");

let savedTag = "";

function setMessage(text, state = "info") {
    if (!text) {
        message.hidden = true;
        return;
    }
    message.textContent = text;
    message.dataset.state = state;
    message.hidden = false;
}

function setBusy(isBusy) {
    [saveButton, checkButton, testNotificationButton].forEach((btn) => {
        btn.disabled = isBusy;
    });
}

// permissions.request needs a live user gesture, so call this early in the click handler
async function ensureHostPermission(baseUrl) {
    try {
        const url = new URL(baseUrl);
        const pattern = `${url.origin}/*`;
        const hasPermission = await chrome.permissions.contains({
            origins: [pattern],
        });
        if (hasPermission) {
            return true;
        }
        const granted = await chrome.permissions.request({
            origins: [pattern],
        });
        return granted;
    } catch (error) {
        return false;
    }
}

function fillForm(settings) {
    // input ids match the settings keys
    for (const key in settings) {
        const field = $(key);
        if (field) {
            if (field.type === "checkbox") {
                field.checked = settings[key];
            } else {
                field.value = settings[key];
            }
        }
    }
    updateScheduleVisibility();
}

function readForm() {
    const settings = {};
    for (const key in DEFAULT_SETTINGS) {
        const field = $(key);
        if (field) {
            if (field.type === "checkbox") {
                settings[key] = field.checked;
            } else {
                settings[key] = field.value;
            }
        }
    }
    return settings;
}

function updateScheduleVisibility() {
    if (notificationsOn.checked) {
        scheduleFieldsContainer.querySelectorAll("input").forEach((input) => {
            input.disabled = false;
        });
    } else {
        scheduleFieldsContainer.querySelectorAll("input").forEach((input) => {
            input.disabled = true;
        });
    }
}

async function persist() {
    const patch = readForm();
    const ok = await ensureHostPermission(patch.baseUrl);
    if (!ok) {
        setMessage(
            "You need to allow access to the server (or the address is incorrect)",
            "error",
        );
        return false;
    }
    const oldSettings = await getSettings();
    const fieldsToCheck = [
        "baseUrl",
        "clientId",
        "clientSecret",
        "username",
        "password",
    ];
    // tokens were issued for the old credentials and would break later
    const clean = (field, value) =>
        field === "password" ? value : String(value).trim().replace(/\/+$/, "");
    const shouldRemoveAuth = fieldsToCheck.some(
        (field) => clean(field, patch[field]) !== clean(field, oldSettings[field]),
    );
    if (shouldRemoveAuth) {
        await chrome.storage.local.remove("auth");
    }
    // the current entry belongs to the old tag
    if (patch.tag.trim() !== oldSettings.tag) {
        await clearCurrentEntry();
    }
    await saveSettings(patch);
    savedTag = patch.tag.trim();
    tagWarning.hidden = true;
    return true;
}

async function onSave(event) {
    event.preventDefault();
    setBusy(true);
    try {
        if (await persist()) {
            setMessage("Saved", "ok");
        }
    } catch (error) {
        setMessage(error.message, "error");
    } finally {
        setBusy(false);
    }
}

async function onCheck() {
    setBusy(true);
    setMessage("Checking...", "info");
    try {
        if (!(await persist())) {
            return;
        }
        await getAccessToken();
        const n = await countEntries();
        if (n === 0) {
            setMessage(
                "Connection works, but no unarchived entries have this tag yet",
                "info",
            );
        } else {
            setMessage(`Connection works. Entries with tag: ${n}`, "ok");
        }
    } catch (error) {
        setMessage(error.message, "error");
    } finally {
        setBusy(false);
    }
}

async function onTestNotification() {
    try {
        const result = await chrome.runtime.sendMessage({
            type: "test-notification",
        });
        if (result?.shown) {
            setMessage("Test notification sent", "ok");
        } else {
            setMessage(
                `Notification was not shown: ${result?.reason ?? "unknown reason"}`,
                "error",
            );
        }
    } catch (error) {
        setMessage(
            `Failed to reach the background worker: ${error.message}`,
            "error",
        );
    }
}

async function onSignOut() {
    if (!confirm("Remove the saved account data from this browser?")) return;
    try {
        await signOut();
    } catch (error) {
        setMessage(error.message, "error");
        return;
    }
    fillForm(await getSettings());
    setMessage("Account data removed", "ok");
}

async function onResetAll() {
    if (!confirm("Remove all saved data from this browser?")) return;
    try {
        await resetAll();
    } catch (error) {
        setMessage(error.message, "error");
        return;
    }
    const settings = await getSettings();
    fillForm(settings);
    savedTag = settings.tag;
    tagWarning.hidden = true;
    setMessage("All extension data removed", "ok");
}

async function init() {
    const settings = await getSettings();
    fillForm(settings);
    savedTag = settings.tag;
    tagInput.addEventListener("input", () => {
        tagWarning.hidden = tagInput.value.trim() === savedTag;
    });
    settingsForm.addEventListener("submit", onSave);
    checkButton.addEventListener("click", onCheck);
    testNotificationButton.addEventListener("click", onTestNotification);
    notificationsOn.addEventListener("change", updateScheduleVisibility);
    signOutButton.addEventListener("click", onSignOut);
    resetAllButton.addEventListener("click", onResetAll);
}

init();
