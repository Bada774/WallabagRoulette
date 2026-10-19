import { addEntry, normalizeTag } from "../wallabag-api/wallabag-api.js";
import { rememberCategories } from "../categories/categories.js";

export const QUEUE_ALARM = "wallabag-roulette-queue";
export const ADD_QUEUE_KEY = "addQueue";
export const ADD_JOB_KEY = "addJob";

// LOCK_QUEUE guards read-modify-write of the stored state, LOCK_RUN lets only one processor run at a time
const LOCK_QUEUE = "wallabag-add-queue";
const LOCK_RUN = "wallabag-add-run";
const MAX_ATTEMPTS = 5;
const MAX_ERRORS = 20;

const EMPTY_JOB = {
    total: 0,
    done: 0,
    failed: 0,
    running: false,
    stalled: null,
    errors: [],
    finishedAt: null,
};

function isHttpUrl(value) {
    try {
        const { protocol } = new URL(value);
        return protocol === "http:" || protocol === "https:";
    } catch {
        return false;
    }
}

async function readState() {
    const stored = await chrome.storage.local.get([ADD_QUEUE_KEY, ADD_JOB_KEY]);
    return {
        queue: stored[ADD_QUEUE_KEY] ?? [],
        job: { ...EMPTY_JOB, ...(stored[ADD_JOB_KEY] ?? {}) },
    };
}

// enqueueTabs and processQueue run concurrently and would overwrite each other without this lock
function withQueueLock(fn) {
    return navigator.locks.request(LOCK_QUEUE, fn);
}

export async function enqueueTabs(
    items,
    { closeTabs = false, extraTags = [] } = {},
) {
    const valid = (Array.isArray(items) ? items : []).filter(
        (item) => item && typeof item.url === "string" && isHttpUrl(item.url),
    );
    if (valid.length === 0) {
        throw new Error("enqueueTabs: no valid http(s) URLs to add");
    }
    const tags = (Array.isArray(extraTags) ? extraTags : [])
        .map(normalizeTag)
        .filter(Boolean);

    await withQueueLock(async () => {
        const { queue, job } = await readState();
        const queued = new Set(queue.map((item) => item.url));
        const fresh = [];
        for (const item of valid) {
            // already waiting in the queue
            if (queued.has(item.url)) {
                continue;
            }
            queued.add(item.url);
            fresh.push({
                url: item.url,
                title: String(item.title || item.url),
                tabId: Number.isInteger(item.tabId) ? item.tabId : null,
                closeTab: Boolean(closeTabs),
                extraTags: tags,
                attempts: 0,
            });
        }
        if (fresh.length === 0) {
            return;
        }
        // keep the counters if a job is in progress or items are left over from a stalled one
        const base = job.running || queue.length > 0 ? job : { ...EMPTY_JOB };
        await chrome.storage.local.set({
            [ADD_QUEUE_KEY]: [...queue, ...fresh],
            [ADD_JOB_KEY]: {
                ...base,
                total: base.total + fresh.length,
                running: true,
                stalled: null,
                finishedAt: null,
            },
        });
        await chrome.alarms.create(QUEUE_ALARM, { periodInMinutes: 1 });
    });

    processQueue().catch((error) => console.error("processQueue:", error));
}

async function tryAdd(item) {
    try {
        await addEntry(item.url, item.extraTags);
        return { type: "done" };
    } catch (error) {
        const message = error?.message ?? String(error);
        if (error?.auth) {
            return { type: "stall", message };
        }
        const transient =
            // fetch rejects with TypeError when there is no network
            error instanceof TypeError ||
            error?.name === "TimeoutError" ||
            error?.name === "AbortError" ||
            error?.status >= 500;
        return { type: transient ? "retry" : "failed", message };
    }
}

export async function processQueue() {
    // runs are serialized: a redundant run finds the queue empty and exits right away
    await navigator.locks.request(LOCK_RUN, async () => {
        await withQueueLock(async () => {
            const { queue, job } = await readState();
            if (queue.length === 0) {
                return;
            }
            await chrome.storage.local.set({
                [ADD_JOB_KEY]: {
                    ...job,
                    total: Math.max(
                        job.total,
                        job.done + job.failed + queue.length,
                    ),
                    running: true,
                    stalled: null,
                    finishedAt: null,
                },
            });
            await chrome.alarms.create(QUEUE_ALARM, { periodInMinutes: 1 });
        });

        while (true) {
            // the item stays in the queue until its outcome is recorded, so a killed worker does not lose it
            const item = await withQueueLock(async () => {
                const { queue, job } = await readState();
                if (queue.length > 0) {
                    return queue[0];
                }
                // close the job in the same critical section, so new tabs cannot slip in between the check and the exit
                if (job.running) {
                    await chrome.storage.local.set({
                        [ADD_JOB_KEY]: {
                            ...job,
                            running: false,
                            stalled: null,
                            finishedAt: Date.now(),
                        },
                    });
                }
                await chrome.alarms.clear(QUEUE_ALARM);
                return null;
            });
            if (!item) {
                return;
            }

            const outcome = await tryAdd(item);

            let stop = false;
            let vanished = false;
            await withQueueLock(async () => {
                const { queue, job } = await readState();
                const index = queue.findIndex(
                    (entry) => entry.url === item.url,
                );
                // the queue was wiped while the request was in flight (sign out / reset): record nothing
                if (index === -1) {
                    vanished = true;
                    return;
                }
                const next = [...queue];
                const update = { ...job };

                // login failed: keep every item and wait until the settings are fixed
                if (outcome.type === "stall") {
                    update.running = false;
                    update.stalled = outcome.message;
                    await chrome.storage.local.set({ [ADD_JOB_KEY]: update });
                    await chrome.alarms.clear(QUEUE_ALARM);
                    stop = true;
                    return;
                }

                if (outcome.type === "retry" && index !== -1) {
                    const attempts = (next[index].attempts ?? 0) + 1;
                    // transient error: leave the item in place, the guard alarm retries in a minute
                    if (attempts < MAX_ATTEMPTS) {
                        next[index] = { ...next[index], attempts };
                        update.stalled = outcome.message;
                        await chrome.storage.local.set({
                            [ADD_QUEUE_KEY]: next,
                            [ADD_JOB_KEY]: update,
                        });
                        stop = true;
                        return;
                    }
                }

                if (index !== -1) {
                    next.splice(index, 1);
                }
                update.stalled = null;
                if (outcome.type === "done") {
                    update.done += 1;
                } else {
                    update.failed += 1;
                    update.errors = [
                        ...update.errors,
                        `${item.title}: ${outcome.message}`,
                    ].slice(-MAX_ERRORS);
                }
                await chrome.storage.local.set({
                    [ADD_QUEUE_KEY]: next,
                    [ADD_JOB_KEY]: update,
                });
            });

            if (vanished) {
                return;
            }
            if (outcome.type === "done") {
                try {
                    // side effects after a success must not break the queue
                    await rememberCategories(item.extraTags);
                } catch (error) {
                    console.error("rememberCategories:", error);
                }
                if (item.closeTab && item.tabId !== null) {
                    try {
                        await chrome.tabs.remove(item.tabId);
                    } catch {
                        // the tab was already closed manually
                    }
                }
            }
            if (stop) {
                return;
            }
        }
    });
}
