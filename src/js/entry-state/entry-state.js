import {
    getRandomEntry,
    archiveEntry,
    normalizeTag,
} from "../wallabag-api/wallabag-api.js";
import { getFilter } from "../categories/categories.js";

const KEY = "currentEntry";

export async function getCurrentEntry() {
    const stored = await chrome.storage.local.get(KEY);
    return stored[KEY] ?? null;
}

export async function setCurrentEntry(entry) {
    await chrome.storage.local.set({ [KEY]: entry });
}

export async function clearCurrentEntry() {
    await chrome.storage.local.remove(KEY);
}

// entries saved before tags were stored have no tags and never match a non-empty filter
export function matchesFilter(entry, category) {
    const wanted = normalizeTag(category);
    if (!wanted) {
        return true;
    }
    return Array.isArray(entry?.tags) && entry.tags.includes(wanted);
}

export async function getUsableCurrentEntry() {
    const [entry, category] = await Promise.all([
        getCurrentEntry(),
        getFilter(),
    ]);
    return entry && matchesFilter(entry, category) ? entry : null;
}

export async function pickNewEntry({ avoidCurrent = false } = {}) {
    const category = await getFilter();
    const previous = avoidCurrent ? await getCurrentEntry() : null;
    const entry = await getRandomEntry({ category, excludeId: previous?.id });
    if (entry) {
        await setCurrentEntry(entry);
    } else {
        // nothing matches, so the previous entry is stale too (archived elsewhere or filtered out)
        await clearCurrentEntry();
    }
    return entry;
}

export async function markWatched(entry) {
    if (!entry) {
        return { archived: false, gone: false };
    }
    let gone = false;
    try {
        await archiveEntry(entry.id);
    } catch (error) {
        if (error?.status !== 404) {
            throw error;
        }
        // 404: the entry is already gone, which is the same result for the user
        gone = true;
    }
    const current = await getCurrentEntry();
    // a scheduled notification may have replaced the current entry while the popup was open
    if (current?.id === entry.id) {
        await clearCurrentEntry();
    }
    return { archived: !gone, gone };
}
