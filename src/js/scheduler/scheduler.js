import { getSettings } from "../config/config.js";

export const ALARM_NAME = "wallabag-roulette";

export function computeNextRun(settings, from = new Date()) {
    settings = settings || {};
    const timeOfDay = settings.timeOfDay || "20:00";
    const [hours, minutes] = timeOfDay.split(":").map(Number);

    // today at HH:MM, or tomorrow if that time has already passed
    const candidate = new Date(from);
    candidate.setHours(hours, minutes, 0, 0);

    if (candidate.getTime() <= from.getTime()) {
        candidate.setDate(candidate.getDate() + 1);
    }
    return candidate.getTime();
}

export async function scheduleNext({ afterFire = false } = {}) {
    const settings = await getSettings();
    if (!settings.notificationsOn || !settings.baseUrl) {
        await chrome.alarms.clear(ALARM_NAME);
        await chrome.storage.local.remove("nextAlarmTime");
        return;
    }

    let when;
    if (!afterFire) {
        when = computeNextRun(settings);
    } else {
        const nextRun = computeNextRun(settings);
        const intervalDays = settings.intervalDays || 1;
        const nextDate = new Date(nextRun);
        // setDate instead of adding 24h in ms, so a DST change does not shift the time
        nextDate.setDate(nextDate.getDate() + (intervalDays - 1));
        when = nextDate.getTime();
    }
    chrome.alarms.create(ALARM_NAME, { when });
    await chrome.storage.local.set({ nextAlarmTime: when });
}

export async function ensureScheduled() {
    const alarm = await chrome.alarms.get(ALARM_NAME);
    if (!alarm) {
        await scheduleNext();
    }
}

// only schedule fields matter, otherwise saving e.g. the password would move the next notification
export function scheduleSettingsChanged(oldSettings, newSettings) {
    if (!oldSettings || !newSettings) {
        return true;
    }
    return ["notificationsOn", "intervalDays", "timeOfDay"].some(
        (key) => oldSettings[key] !== newSettings[key],
    );
}
