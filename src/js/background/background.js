import {
    ALARM_NAME,
    scheduleNext,
    ensureScheduled,
    scheduleSettingsChanged,
} from "../scheduler/scheduler.js";
import { pickNewEntry } from "../entry-state/entry-state.js";
import { QUEUE_ALARM, enqueueTabs, processQueue } from "../queue/queue.js";
import { getSettings } from "../config/config.js";
import {
    applyToolbarIcon,
    restoreToolbarIcon,
    ensureThemeWatcher,
} from "../theme/theme.js";
import { registerMenus, onMenuClick, onCommand } from "../menu/menu.js";

// listeners are registered synchronously at top level, otherwise the event that woke the worker is lost
chrome.runtime.onInstalled.addListener(async () => {
    console.log("onInstalled");
    registerMenus().catch((error) => console.error("registerMenus:", error));
    await ensureScheduled();
    resumeQueue();
});

chrome.runtime.onStartup.addListener(async () => {
    console.log("onStartup");
    await ensureScheduled();
    resumeQueue();
});

function resumeQueue() {
    processQueue().catch((error) => console.error("processQueue:", error));
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
    if (alarm.name === QUEUE_ALARM) {
        resumeQueue();
        return;
    }
    if (alarm.name !== ALARM_NAME) {
        return;
    }
    console.log("Alarm fired:", alarm.name);
    // reschedule before any network call so the schedule survives wallabag being down
    await scheduleNext({ afterFire: true });
    await showPick();
});

async function showPick({ force = false, avoidCurrent = false } = {}) {
    const settings = await getSettings();
    if (!settings.notificationsOn && !force) {
        return { shown: false, reason: "notifications are turned off" };
    }

    let entry;
    try {
        entry = await pickNewEntry({ avoidCurrent });
    } catch (error) {
        console.error("Error fetching entry:", error);
        return { shown: false, reason: error.message };
    }
    if (!entry) {
        console.log("No entries available");
        return { shown: false, reason: "no unarchived entries with this tag" };
    }

    const notificationId = `pick-${Date.now()}`;
    // store the entry first, so a fast click cannot beat the write
    await chrome.storage.session.set({ [notificationId]: entry });

    try {
        await chrome.notifications.create(notificationId, {
            type: "basic",
            // a relative iconUrl is resolved against the worker file, not the extension root
            iconUrl: chrome.runtime.getURL("src/icons/icon-for-light-128.png"),
            title: "Today:",
            message: entry.title || entry.url,
            contextMessage: entry.domainName,
            buttons: [{ title: "Open" }, { title: "Other" }],
            requireInteraction: true,
        });
    } catch (error) {
        console.error("notifications.create:", error);
        await chrome.storage.session.remove(notificationId);
        return { shown: false, reason: error.message };
    }
    return { shown: true };
}

async function takeEntry(id) {
    // get() returns { [id]: entry }, not the entry itself
    const stored = await chrome.storage.session.get(id);
    await chrome.storage.session.remove(id);
    return stored[id];
}

chrome.notifications.onClicked.addListener(async (id) => {
    const entry = await takeEntry(id);
    if (entry) {
        chrome.tabs.create({ url: entry.url });
    }
    chrome.notifications.clear(id);
});

chrome.notifications.onButtonClicked.addListener(async (id, buttonIndex) => {
    const entry = await takeEntry(id);
    chrome.notifications.clear(id);
    if (buttonIndex === 0 && entry) {
        chrome.tabs.create({ url: entry.url });
    } else if (buttonIndex === 1) {
        await showPick({ force: true, avoidCurrent: true });
    }
});

// return true keeps the channel open for the async reply
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.type === "test-notification") {
        showPick({ force: true })
            .then(sendResponse)
            .catch((error) =>
                sendResponse({ shown: false, reason: error.message }),
            );
        return true;
    }

    if (message?.type === "toolbar-theme") {
        applyToolbarIcon(Boolean(message.dark)).catch((error) =>
            console.error("applyToolbarIcon:", error),
        );
        return;
    }

    // the work runs in the worker, so closing the popup does not interrupt it
    if (message?.type === "add-tabs") {
        enqueueTabs(message.items, {
            closeTabs: Boolean(message.closeTabs),
            extraTags: message.extraTags ?? [],
        })
            .then(() => sendResponse({ ok: true }))
            .catch((error) =>
                sendResponse({ ok: false, reason: error.message }),
            );
        return true;
    }
});

chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes.settings) {
        return;
    }
    const { oldValue, newValue } = changes.settings;
    if (scheduleSettingsChanged(oldValue, newValue)) {
        scheduleNext();
    }
});

chrome.contextMenus.onClicked.addListener(onMenuClick);
chrome.commands.onCommand.addListener(onCommand);

restoreToolbarIcon().catch((error) => console.error("restoreToolbarIcon:", error));
ensureThemeWatcher().catch((error) => console.error("ensureThemeWatcher:", error));
