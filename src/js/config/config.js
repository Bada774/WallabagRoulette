export const DEFAULT_SETTINGS = {
    baseUrl: "",
    clientId: "",
    clientSecret: "",
    username: "",
    password: "",
    tag: "watchPlugin",
    intervalDays: 1,
    timeOfDay: "20:00",
    notificationsOn: true,
};

export async function getSettings() {
    const settings = await chrome.storage.local.get("settings");
    return { ...DEFAULT_SETTINGS, ...settings.settings };
}

export async function saveSettings(patch) {
    const current = await getSettings();
    const merged = { ...current, ...patch };

    merged.baseUrl = merged.baseUrl.trim().replace(/\/+$/, "");
    for (const key in merged) {
        // passwords may legitimately start or end with spaces
        if (typeof merged[key] === "string" && key !== "password") {
            merged[key] = merged[key].trim();
        }
    }
    merged.intervalDays = Math.max(
        1,
        Math.min(30, Number(merged.intervalDays) || 1),
    );
    await chrome.storage.local.set({ settings: merged });
}
