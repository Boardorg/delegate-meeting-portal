// ---------------------------------------------------------------------------
// Request tracking for the top progress bar.
//
// Every slow thing a user can trigger goes through fetch.
// That includes page changes, router refreshes, server actions and our own API calls.
// Wrapping fetch once lets the progress bar cover every link and button,
// including ones added later, without wiring each one up.
//
// Pure and browser-agnostic so it can be unit-tested. The component in
// app/components/TopProgressBar.tsx installs it on window.fetch.
// ---------------------------------------------------------------------------

/** Header Next's router sets on background prefetches. These aren't user actions, so they're ignored. */
const PREFETCH_HEADER = "next-router-prefetch";

/**
 * Upper bound on how long one request keeps the bar showing.
 * Matches Vercel's default function timeout, so a long push still shows the bar the whole way.
 * It stops a request that never settles from leaving the bar on forever.
 */
export const MAX_TRACKED_MS = 300_000;

/**
 * Whether a fetch call is user-visible work that should show the progress bar.
 * Only same-origin requests count.
 * Next's prefetches and its own /_next/ asset and dev-server requests are skipped.
 *
 * @param {RequestInfo | URL} input - The fetch input.
 * @param {RequestInit | undefined} init - The fetch options.
 * @param {string} origin - The page's origin, e.g. "https://example.com".
 * @returns {boolean} True when the request should show the bar.
 */
export function shouldTrackRequest(
    input: RequestInfo | URL,
    init: RequestInit | undefined,
    origin: string,
): boolean {
    const isRequest = typeof Request !== "undefined" && input instanceof Request;
    const rawUrl = isRequest ? input.url : String(input);

    let url: URL;
    try {
        url = new URL(rawUrl, origin);
    } catch {
        return false;
    }
    if (url.origin !== origin) return false;
    if (url.pathname.startsWith("/_next/")) return false;

    // Headers on init win over headers on a Request input, matching fetch itself.
    const headers = new Headers(
        init?.headers ?? (isRequest ? input.headers : undefined),
    );
    return !headers.has(PREFETCH_HEADER);
}

/** A count of in-flight tracked requests that listeners can subscribe to. */
export type ActivityCounter = {
    /** Marks one request as started. Returns a function that marks it finished. Calling that more than once is safe. */
    start: () => () => void;
    /** How many tracked requests are in flight right now. */
    getActive: () => number;
    /** Calls the listener whenever the count changes. Returns an unsubscribe function. */
    subscribe: (listener: () => void) => () => void;
};

/**
 * Creates a counter of in-flight requests.
 * Shaped for React's useSyncExternalStore.
 *
 * @returns {ActivityCounter} The counter.
 */
export function createActivityCounter(): ActivityCounter {
    let active = 0;
    const listeners = new Set<() => void>();
    const notify = () => listeners.forEach((l) => l());

    return {
        start() {
            active++;
            notify();
            let ended = false;
            return () => {
                if (ended) return;
                ended = true;
                active--;
                notify();
            };
        },
        getActive: () => active,
        subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
    };
}

/**
 * Resolves once a response body has been fully received.
 * Next streams pages, so the response arrives well before the page data is complete.
 * Reads a clone so the caller's copy of the body is untouched.
 * Errors and aborts also resolve, since either way the request is over.
 *
 * @param {Response} res - The response to wait on.
 * @returns {Promise<void>} Resolves when the body is done.
 */
async function waitForBody(res: Response): Promise<void> {
    if (!res.body || res.bodyUsed) return;
    try {
        const reader = res.clone().body!.getReader();
        while (!(await reader.read()).done) {
            // Draining the clone. The caller reads the original.
        }
    } catch {
        // An aborted or failed stream still means the request is finished.
    }
}

/**
 * Wraps a fetch function so tracked requests count as activity until their body finishes.
 * Untracked requests pass straight through.
 *
 * @param {typeof fetch} fetchImpl - The real fetch to call.
 * @param {ActivityCounter} counter - Where in-flight requests are counted.
 * @param {string} origin - The page's origin.
 * @returns {typeof fetch} The wrapped fetch.
 */
export function trackFetch(
    fetchImpl: typeof fetch,
    counter: ActivityCounter,
    origin: string,
): typeof fetch {
    return async (input, init) => {
        if (!shouldTrackRequest(input, init, origin)) {
            return fetchImpl(input, init);
        }

        const end = counter.start();
        const timeout = setTimeout(end, MAX_TRACKED_MS);
        const finish = () => {
            clearTimeout(timeout);
            end();
        };

        try {
            const res = await fetchImpl(input, init);
            void waitForBody(res).then(finish);
            return res;
        } catch (err) {
            finish();
            throw err;
        }
    };
}
