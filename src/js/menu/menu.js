import { enqueueTabs } from "../queue/queue.js";

// same key as in popup.js, where the selected tags are saved
const ADD_TAGS_KEY = "addTags";

const MENU_PAGE = "add-page";
const MENU_LINK = "add-link";
const MENU_ALL = "add-all";
const BADGE_MS = 3000;

export async function registerMenus() {
    await chrome.contextMenus.removeAll();
    chrome.contextMenus.create({
        id: MENU_PAGE,
        title: "Add this page to wallabag",
        // "page" only fires on an empty spot, so selected text needs its own context; "action" is the toolbar icon
        contexts: ["page", "selection", "action"],
    });
    chrome.contextMenus.create({
        id: MENU_LINK,
        title: "Add this link to wallabag",
        contexts: ["link"],
    });
    chrome.contextMenus.create({
        id: MENU_ALL,
        title: "Add all tabs in this window",
        contexts: ["action"],
    });
}

async function getQuickTags() {
    const stored = await chrome.storage.local.get(ADD_TAGS_KEY);
    return Array.isArray(stored[ADD_TAGS_KEY]) ? stored[ADD_TAGS_KEY] : [];
}

async function flashBadge(text, color) {
    await chrome.action.setBadgeBackgroundColor({ color });
    await chrome.action.setBadgeText({ text });
    setTimeout(() => chrome.action.setBadgeText({ text: "" }), BADGE_MS);
}

async function quickAdd(items) {
    const extraTags = await getQuickTags();

    try {
        // enqueueTabs drops non-http(s) URLs and duplicates, and throws if nothing is left
        await enqueueTabs(items, {
            closeTabs: false,
            extraTags,
        });
        // the badge only means the tabs were queued; the popup shows the actual result
        await flashBadge("OK", "#742e7d");
    } catch (error) {
        console.error("quickAdd:", error);
        await flashBadge("!", "#c62828");
    }
}

export async function onMenuClick(info, tab) {
    if (info.menuItemId === MENU_PAGE) {
        await quickAdd([{ url: tab.url, title: tab.title, tabId: tab.id }]);
        return;
    }

    if (info.menuItemId === MENU_LINK) {
        await quickAdd([
            {
                url: info.linkUrl,
                // a link has no title and no tab of its own
                title: info.selectionText || info.linkUrl,
                tabId: null,
            },
        ]);
        return;
    }

    if (info.menuItemId === MENU_ALL) {
        // currentWindow is unreliable in a service worker, so take the window from the clicked tab
        const tabs = await chrome.tabs.query({ windowId: tab.windowId });

        const items = tabs
            .filter((t) => t.url)
            .map((t) => ({ url: t.url, title: t.title, tabId: t.id }));

        await quickAdd(items);
    }
}

export async function onCommand(command, tab) {
    if (command !== "add-current-tab") {
        return;
    }
    if (!tab || !tab.url) {
        await flashBadge("!", "#c62828");
        return;
    }
    await quickAdd([{ url: tab.url, title: tab.title, tabId: tab.id }]);
}
