import { getSettings } from "../config/config.js";
import { listTags, normalizeTag } from "../wallabag-api/wallabag-api.js";

// categoryStats: { tag: usage count }, serverTags: { tags, fetchedAt }, activeFilter: tag or ""
export const CATEGORY_STATS_KEY = "categoryStats";
export const SERVER_TAGS_KEY = "serverTags";
export const FILTER_KEY = "activeFilter";
const SERVER_TAGS_TTL_MS = 24 * 60 * 60 * 1000;

async function readLocal(key, fallback) {
    const stored = await chrome.storage.local.get(key);
    return stored[key] ?? fallback;
}

async function getSystemTag() {
    const settings = await getSettings();
    return normalizeTag(settings.tag);
}

function cleanTags(tags, systemTag = "") {
    const normalized = (tags ?? []).map(normalizeTag).filter(Boolean);
    return [...new Set(normalized)].filter((tag) => tag !== systemTag);
}

export async function rememberCategories(tags) {
    const clean = cleanTags(tags, await getSystemTag());
    if (clean.length === 0) {
        return;
    }
    const stats = await readLocal(CATEGORY_STATS_KEY, {});

    clean.forEach((tag) => {
        stats[tag] = (stats[tag] ?? 0) + 1;
    });
    await chrome.storage.local.set({ [CATEGORY_STATS_KEY]: stats });
}

export async function refreshServerTags({ force = false } = {}) {
    const cache = await readLocal(SERVER_TAGS_KEY, null);
    const isFresh = cache && Date.now() - cache.fetchedAt < SERVER_TAGS_TTL_MS;
    if (isFresh && !force) {
        return;
    }

    try {
        const tags = await listTags();
        await chrome.storage.local.set({
            [SERVER_TAGS_KEY]: { tags, fetchedAt: Date.now() },
        });
    } catch (error) {
        console.warn("refreshServerTags:", error);
    }
}

export async function getKnownCategories() {
    const systemTag = await getSystemTag();
    const stats = await readLocal(CATEGORY_STATS_KEY, {});
    const server = await readLocal(SERVER_TAGS_KEY, { tags: [] });

    const usedTags = cleanTags(Object.keys(stats), systemTag);
    const serverTags = cleanTags(server.tags, systemTag);

    const used = usedTags.sort(
        (a, b) => stats[b] - stats[a] || a.localeCompare(b),
    );
    const other = serverTags
        .filter((tag) => !usedTags.includes(tag))
        .sort((a, b) => a.localeCompare(b));
    return { used, other };
}

function levenshtein(a, b) {
    const s = [...a];
    const t = [...b];

    let prev = Array.from({ length: t.length + 1 }, (_, j) => j);
    for (let i = 1; i <= s.length; i++) {
        const curr = [i];
        for (let j = 1; j <= t.length; j++) {
            const cost = s[i - 1] === t[j - 1] ? 0 : 1;
            curr[j] = Math.min(
                prev[j] + 1,
                curr[j - 1] + 1,
                prev[j - 1] + cost,
            );
        }
        prev = curr;
    }
    return prev[t.length];
}

export function findSimilarCategory(raw, known) {
    const tag = normalizeTag(raw);
    if (!tag || known.includes(tag)) {
        return null;
    }

    let best = null;

    for (const candidate of known) {
        const distance = levenshtein(tag, candidate);
        // compared by code points, so an emoji counts as one character
        const short =
            [...tag].length <= [...candidate].length ? tag : candidate;
        // prefix match ("кино" / "киносмотреть"), but only from 3 characters
        const isPrefix =
            [...short].length >= 3 &&
            (tag.startsWith(candidate) || candidate.startsWith(tag));
        // stricter for short tags: "кино" must not match "книга"
        const threshold = [...short].length <= 5 ? 1 : 2;
        const similar = isPrefix || distance <= threshold;

        if (
            similar &&
            (!best ||
                distance < best.distance ||
                (distance === best.distance &&
                    [...candidate].length < [...best.candidate].length))
        ) {
            best = { candidate, distance };
        }
    }
    return best ? best.candidate : null;
}

export async function getFilter() {
    const value = await readLocal(FILTER_KEY, "");
    return typeof value === "string" ? normalizeTag(value) : "";
}

export async function setFilter(tag) {
    await chrome.storage.local.set({ [FILTER_KEY]: normalizeTag(tag) });
}
