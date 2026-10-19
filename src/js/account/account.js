import { DEFAULT_SETTINGS, getSettings } from "../config/config.js";
import { ALARM_NAME } from "../scheduler/scheduler.js";
import { QUEUE_ALARM, ADD_QUEUE_KEY, ADD_JOB_KEY } from "../queue/queue.js";

// fields that identify the user on the wallabag server.
// everything else in `settings` (tag, schedule) is harmless and stays on sign-out.
const CREDENTIAL_FIELDS = [
    "baseUrl",
    "clientId",
    "clientSecret",
    "username",
    "password",
];

export async function signOut() {
    const current = await getSettings();

    await revokeServerPermission(current.baseUrl);

    const newSettings = { ...current };
    for (const key of CREDENTIAL_FIELDS) {
        newSettings[key] = DEFAULT_SETTINGS[key];
    }
    await chrome.storage.local.set({ settings: newSettings });
    await chrome.storage.local.remove([
        "auth",
        "nextAlarmTime",
        ADD_QUEUE_KEY,
        ADD_JOB_KEY,
    ]);

    await stopBackgroundWork();
}

export async function resetAll() {
    const current = await getSettings();
    await revokeServerPermission(current.baseUrl);
    await stopBackgroundWork();
    await chrome.storage.local.clear();
    await chrome.storage.session.clear();
}

async function stopBackgroundWork() {
    await chrome.alarms.clear(ALARM_NAME);
    await chrome.alarms.clear(QUEUE_ALARM);

    const all = await chrome.notifications.getAll();
    for (const id of Object.keys(all)) {
        await chrome.notifications.clear(id);
    }
}

async function revokeServerPermission(baseUrl) {
    if (!baseUrl) {
        return;
    }
    try {
        await chrome.permissions.remove({
            origins: [`${new URL(baseUrl).origin}/*`],
        });
    } catch (error) {
        console.error("revokeServerPermission:", error);
    }
}
