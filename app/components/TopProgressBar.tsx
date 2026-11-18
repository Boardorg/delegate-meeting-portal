"use client";

import { useEffect, useRef } from "react";
import {
    createActivityCounter,
    trackFetch,
} from "@/lib/progress/requestTracker";

// ---------------------------------------------------------------------------
// Top progress bar
//
// A thin bar across the top of every page while the app is waiting on the server.
// It covers every link and button by watching fetch (see lib/progress/requestTracker.ts).
// Mounted once in the root layout.
// ---------------------------------------------------------------------------

/** Wait this long before showing the bar, so quick actions don't flash it. */
const SHOW_DELAY_MS = 150;

/** How long the finish animation runs before the bar is hidden. */
const FINISH_MS = 300;

/** Shared across the app. One counter, one fetch wrapper. */
const counter = createActivityCounter();

/** Where the unwrapped fetch is kept, so hot reloads don't wrap it twice. */
const ORIGINAL_FETCH = Symbol.for("meetingPortal.originalFetch");

/**
 * Replaces window.fetch with the tracking wrapper.
 * Always wraps the original fetch, so running this again is safe.
 */
function installFetchTracking() {
    const w = window as typeof window & { [ORIGINAL_FETCH]?: typeof fetch };
    w[ORIGINAL_FETCH] ??= window.fetch.bind(window);
    window.fetch = trackFetch(w[ORIGINAL_FETCH], counter, window.location.origin);
}

type BarState = "hidden" | "loading" | "finishing";

export default function TopProgressBar() {
    const ref = useRef<HTMLDivElement>(null);

    // The bar updates its own class instead of going through React state.
    // It has nothing else to render, so this keeps it independent of whatever React is doing during a page change.
    useEffect(() => {
        installFetchTracking();
        const el = ref.current;
        if (!el) return;

        let shown = false;
        let showTimer: ReturnType<typeof setTimeout> | undefined;
        let hideTimer: ReturnType<typeof setTimeout> | undefined;
        const setState = (state: BarState) => {
            el.className = `top-progress top-progress-${state}`;
        };

        // Show the bar once a request has been running for a moment.
        // Hide it after the finish animation once everything settles.
        const update = () => {
            if (counter.getActive() > 0) {
                clearTimeout(hideTimer);
                if (shown) {
                    setState("loading");
                    return;
                }
                showTimer ??= setTimeout(() => {
                    showTimer = undefined;
                    shown = true;
                    setState("loading");
                }, SHOW_DELAY_MS);
                return;
            }
            clearTimeout(showTimer);
            showTimer = undefined;
            if (!shown) return;
            setState("finishing");
            hideTimer = setTimeout(() => {
                shown = false;
                setState("hidden");
            }, FINISH_MS);
        };

        const unsubscribe = counter.subscribe(update);
        return () => {
            unsubscribe();
            clearTimeout(showTimer);
            clearTimeout(hideTimer);
        };
    }, []);

    // Decorative only. Buttons that matter keep their own "Working…" labels.
    return (
        <div ref={ref} className="top-progress top-progress-hidden" aria-hidden="true">
            <div className="top-progress-bar" />
        </div>
    );
}
