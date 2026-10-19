import { describe, test, expect, vi, afterEach } from "vitest";
import {
    MAX_TRACKED_MS,
    createActivityCounter,
    shouldTrackRequest,
    trackFetch,
} from "./requestTracker";

const ORIGIN = "https://portal.example.com";

/**
 * Builds a streaming response whose body finishes only when `close` is called.
 *
 * @returns {{ response: Response; close: () => void }} The response and a function that ends its body.
 */
function streamingResponse() {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
        start(c) {
            controller = c;
            c.enqueue(new TextEncoder().encode("first chunk"));
        },
    });
    return { response: new Response(body), close: () => controller.close() };
}

/**
 * Waits for pending promise callbacks to run.
 *
 * @returns {Promise<void>} Resolves on the next macrotask.
 */
function flush(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0));
}

afterEach(() => {
    vi.useRealTimers();
});

describe("shouldTrackRequest", () => {
    test("tracks same-origin page, action and API requests", () => {
        expect(shouldTrackRequest("/admin/meetings", undefined, ORIGIN)).toBe(true);
        expect(shouldTrackRequest(`${ORIGIN}/api/requests`, { method: "POST" }, ORIGIN)).toBe(true);
        expect(
            shouldTrackRequest(new URL("/", ORIGIN), { headers: { "next-action": "abc" } }, ORIGIN),
        ).toBe(true);
    });

    test("ignores Next's background prefetches", () => {
        expect(
            shouldTrackRequest("/admin", { headers: { "next-router-prefetch": "1" } }, ORIGIN),
        ).toBe(false);
        expect(
            shouldTrackRequest(
                new Request(`${ORIGIN}/admin`, { headers: { "Next-Router-Prefetch": "2" } }),
                undefined,
                ORIGIN,
            ),
        ).toBe(false);
    });

    test("ignores other origins and Next's own asset requests", () => {
        expect(shouldTrackRequest("https://api.cvent.com/x", undefined, ORIGIN)).toBe(false);
        expect(shouldTrackRequest("/_next/static/chunk.js", undefined, ORIGIN)).toBe(false);
    });
});

describe("createActivityCounter", () => {
    test("counts in-flight requests and notifies listeners", () => {
        const counter = createActivityCounter();
        const listener = vi.fn();
        counter.subscribe(listener);

        const endA = counter.start();
        const endB = counter.start();
        expect(counter.getActive()).toBe(2);

        endA();
        endA();
        expect(counter.getActive()).toBe(1);

        endB();
        expect(counter.getActive()).toBe(0);
        expect(listener).toHaveBeenCalledTimes(4);
    });
});

describe("trackFetch", () => {
    test("stays active until the response body finishes streaming", async () => {
        const counter = createActivityCounter();
        const { response, close } = streamingResponse();
        const fetchImpl = vi.fn(async () => response);
        const tracked = trackFetch(fetchImpl as typeof fetch, counter, ORIGIN);

        const res = await tracked("/admin/meetings");
        expect(counter.getActive()).toBe(1);

        // The caller can still read the body we were watching.
        const reading = res.text();
        close();
        expect(await reading).toBe("first chunk");
        await flush();
        expect(counter.getActive()).toBe(0);
    });

    test("ends when the request fails", async () => {
        const counter = createActivityCounter();
        const fetchImpl = vi.fn(async () => {
            throw new TypeError("network down");
        });
        const tracked = trackFetch(fetchImpl as typeof fetch, counter, ORIGIN);

        await expect(tracked("/admin")).rejects.toThrow("network down");
        expect(counter.getActive()).toBe(0);
    });

    test("does not count untracked requests", async () => {
        const counter = createActivityCounter();
        const fetchImpl = vi.fn(async () => new Response("ok"));
        const tracked = trackFetch(fetchImpl as typeof fetch, counter, ORIGIN);

        await tracked("/admin", { headers: { "next-router-prefetch": "1" } });
        expect(counter.getActive()).toBe(0);
        expect(fetchImpl).toHaveBeenCalledOnce();
    });

    test("gives up after the time limit so the bar can't stick", async () => {
        vi.useFakeTimers();
        const counter = createActivityCounter();
        const { response } = streamingResponse();
        const tracked = trackFetch((async () => response) as typeof fetch, counter, ORIGIN);

        await tracked("/admin/meetings");
        expect(counter.getActive()).toBe(1);

        vi.advanceTimersByTime(MAX_TRACKED_MS);
        expect(counter.getActive()).toBe(0);
    });
});
