import { getSettings } from "../config/config.js";

async function requestToken(params) {
    const baseUrl = (await getSettings()).baseUrl;

    if (!baseUrl) {
        throw new Error("requestToken: baseUrl is not set in settings");
    }

    const body = new URLSearchParams(params);
    const response = await fetch(`${baseUrl}/oauth/v2/token`, {
        method: "POST",
        body,
        headers: {
            "Content-Type": "application/x-www-form-urlencoded",
        },
    });
    if (!response.ok) {
        let details = "";
        try {
            const err = await response.json();
            details = err.error_description || err.error || "";
        } catch {}
        const error = new Error(`requestToken: ${response.status} ${details}`);
        error.status = response.status;
        // login problem (client/user/password), not a network one
        error.auth = true;
        throw error;
    }
    const data = await response.json();
    return {
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        expires_at: Date.now() + data.expires_in * 1000,
    };
}

export async function getAccessToken() {
    // the lock stops parallel callers from requesting several tokens at once
    return navigator.locks.request("wallabag-token", async () => {
        const auth = (await chrome.storage.local.get("auth")).auth;
        const settings = await getSettings();

        if (
            auth &&
            auth.access_token &&
            auth.expires_at > Date.now() + 60 * 1000
        ) {
            return auth.access_token;
        } else if (auth && auth.refresh_token) {
            try {
                const newAuth = await requestToken({
                    grant_type: "refresh_token",
                    client_id: settings.clientId,
                    client_secret: settings.clientSecret,
                    refresh_token: auth.refresh_token,
                });
                await chrome.storage.local.set({ auth: newAuth });
                return newAuth.access_token;
            } catch (error) {
                // expired or revoked refresh token: fall through to the password grant
                console.error("Refresh token failed:", error);
            }
        }
        const newAuth = await requestToken({
            grant_type: "password",
            client_id: settings.clientId,
            client_secret: settings.clientSecret,
            username: settings.username,
            password: settings.password,
        });
        await chrome.storage.local.set({ auth: newAuth });
        return newAuth.access_token;
    });
}

async function apiFetch(path, options = {}, retry = true) {
    const { baseUrl } = await getSettings();

    if (!baseUrl) {
        throw new Error("apiFetch: baseUrl is not set in settings");
    }

    const token = await getAccessToken();
    const response = await fetch(`${baseUrl}${path}`, {
        ...options,
        headers: { Authorization: `Bearer ${token}`, ...options.headers },
    });
    // token may have been revoked: drop it and retry once with a fresh one
    if (response.status === 401 && retry) {
        await chrome.storage.local.remove("auth");
        return apiFetch(path, options, false);
    }
    if (!response.ok) {
        const error = new Error(
            "apiFetch: failed with status " + response.status,
        );
        error.status = response.status;
        error.auth = response.status === 401;
        throw error;
    }
    return response.json();
}

// one canonical form for tags: lowercase, no commas (the API uses them as a separator)
export function normalizeTag(raw) {
    return String(raw ?? "")
        .replace(/[,;]+/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .toLowerCase();
}

// wallabag returns only entries that have ALL tags listed in ?tags=
function uniqueTags(...tags) {
    return [...new Set(tags.flat().map(normalizeTag).filter(Boolean))];
}

export async function countEntries({ category } = {}) {
    const response = await fetchEntriesPage(
        uniqueTags((await getSettings()).tag, category),
        1,
    );
    if (!response || typeof response.total !== "number") {
        throw new Error("countEntries: invalid response format");
    }
    return response.total;
}

export async function getRandomEntry({ category, excludeId } = {}) {
    const tags = uniqueTags((await getSettings()).tag, category);
    const total = await countEntries({ category });
    if (total === 0) {
        return null;
    }
    // with perPage=1 the page number is the entry index, so a random page is a random entry
    let page = 1 + Math.floor(Math.random() * total);
    let item = firstItem(await fetchEntriesPage(tags, page));
    if (item && excludeId != null && item.id === excludeId && total > 1) {
        // got the same entry again: take the next page, wrapping around
        page = (page % total) + 1;
        item = firstItem(await fetchEntriesPage(tags, page));
    }
    if (!item) {
        return null;
    }
    return {
        id: item.id,
        title: item.title,
        url: item.url,
        domainName: item.domain_name,
        previewPicture: item.preview_picture,
        readingTime: item.reading_time,
        tags: Array.isArray(item.tags)
            ? item.tags.map((tag) => normalizeTag(tag.label))
            : [],
    };
}

function firstItem(response) {
    const items = response?._embedded?.items;
    return Array.isArray(items) && items.length > 0 ? items[0] : null;
}

async function fetchEntriesPage(tags, page) {
    const response = await apiFetch(
        `/api/entries?tags=${encodeURIComponent(
            tags.join(","),
        )}&archive=0&perPage=1&page=${page}`,
    );
    return response;
}

export async function archiveEntry(id) {
    const response = await apiFetch(`/api/entries/${id}.json`, {
        method: "PATCH",
        body: JSON.stringify({ archive: 1 }),
        headers: {
            "Content-Type": "application/json",
        },
    });
    return response;
}

export async function listTags() {
    const response = await apiFetch("/api/tags");
    if (!Array.isArray(response)) {
        throw new Error("listTags: invalid response format");
    }
    return [
        ...new Set(
            response.map((tag) => normalizeTag(tag.label)).filter(Boolean),
        ),
    ];
}

export async function addEntry(url, extraTags = []) {
    const tag = (await getSettings()).tag;
    if (!tag) {
        throw new Error("addEntry: tag is not set in settings");
    }
    const response = await apiFetch(`/api/entries.json`, {
        method: "POST",
        body: JSON.stringify({
            url,
            tags: uniqueTags(tag, extraTags).join(","),
        }),
        // wallabag downloads the page itself; do not let one hung page block the queue
        signal: AbortSignal.timeout(90_000),
        headers: {
            "Content-Type": "application/json",
        },
    });
    return response;
}
