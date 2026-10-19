const THEME_KEY = "toolbarDark";
const OFFSCREEN_PATH = "src/html/offscreen/offscreen.html";

let creating = null;

function iconPaths(dark) {
    const variant = dark ? "for-dark" : "for-light";
    // a relative path is resolved against the worker file, not the extension root
    return Object.fromEntries(
        [16, 24, 32].map((size) => [
            size,
            chrome.runtime.getURL(`src/icons/icon-${variant}-${size}.png`),
        ]),
    );
}

export async function applyToolbarIcon(dark) {
    await chrome.storage.local.set({ [THEME_KEY]: dark });
    await chrome.action.setIcon({ path: iconPaths(dark) });
}

// setIcon is forgotten when the browser restarts, so re-apply the last known theme
export async function restoreToolbarIcon() {
    const stored = await chrome.storage.local.get(THEME_KEY);
    if (typeof stored[THEME_KEY] === "boolean") {
        await chrome.action.setIcon({ path: iconPaths(stored[THEME_KEY]) });
    }
}

// A service worker has no matchMedia, so a hidden offscreen page watches the
// color scheme and reports every change (see offscreen.js)
export async function ensureThemeWatcher() {
    if (await chrome.offscreen.hasDocument()) {
        return;
    }
    // parallel callers must not create two documents
    creating ??= chrome.offscreen
        .createDocument({
            url: OFFSCREEN_PATH,
            reasons: ["MATCH_MEDIA"],
            justification: "Detect the browser color scheme to pick the toolbar icon",
        })
        .finally(() => {
            creating = null;
        });
    await creating;
}
