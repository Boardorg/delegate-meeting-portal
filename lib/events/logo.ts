import "server-only";
import { cache } from "react";
import { readFileSync } from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Per-event header logo, resolved by convention.
//
// Event logos live in `public/events/logo-<code>.png` (e.g. BMWS →
// public/events/logo-bmws.png), served from the site root at
// `/events/logo-<code>.png`. This module maps an event code to that file when
// it exists and reads the PNG's intrinsic dimensions, so `next/image` can
// render it at a fixed header height without layout shift. No DB/config entry
// is needed — dropping a correctly named PNG into the folder is enough.
// ---------------------------------------------------------------------------

/** A resolved event logo ready to hand to `next/image`. */
export type EventLogo = {
    /** Public URL, e.g. "/events/logo-bmws.png". */
    src: string;
    /** Intrinsic pixel width (for aspect ratio). */
    width: number;
    /** Intrinsic pixel height (for aspect ratio). */
    height: number;
};

/** Directory holding the PNGs, relative to the project root. */
const EVENTS_DIR = path.join(process.cwd(), "public", "events");

/**
 * Reads a PNG's pixel dimensions from its IHDR header. A valid PNG starts with
 * the 8-byte signature, then the IHDR chunk carrying width/height as big-endian
 * uint32s at byte offsets 16 and 20. Returns null for anything that isn't a
 * PNG (e.g. a wrong-format file dropped in by mistake).
 *
 * @param {Buffer} buf - The file's leading bytes (≥24).
 * @returns {{ width: number; height: number } | null} Dimensions, or null.
 */
function readPngSize(buf: Buffer): { width: number; height: number } | null {
    // PNG signature: 89 50 4E 47 0D 0A 1A 0A.
    const isPng =
        buf.length >= 24 &&
        buf[0] === 0x89 &&
        buf[1] === 0x50 &&
        buf[2] === 0x4e &&
        buf[3] === 0x47;
    if (!isPng) return null;
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/**
 * Resolves the header logo for an event code, or null when the event has no
 * logo file (the common case — most events fall back to just the Assemble
 * mark). Request-memoized so the frontend and admin headers don't re-read the
 * file within one render.
 *
 * The code is lowercased and stripped to `[a-z0-9-]` before building the path,
 * both to match the file naming convention and to keep a cookie/env-sourced
 * code from escaping the events directory.
 *
 * @param {string | null | undefined} code - The active event code.
 * @returns {EventLogo | null} The resolved logo, or null when none exists.
 */
export const getEventLogo = cache(
    (code: string | null | undefined): EventLogo | null => {
        if (!code) return null;
        const slug = code.toLowerCase().replace(/[^a-z0-9-]/g, "");
        if (!slug) return null;

        const file = `logo-${slug}.png`;
        try {
            // Read the file (small PNGs) and parse its header for dimensions.
            // A missing file throws ENOENT → treated as "no logo".
            const buf = readFileSync(path.join(EVENTS_DIR, file));
            const size = readPngSize(buf);
            if (!size) return null;
            return { src: `/events/${file}`, ...size };
        } catch {
            return null;
        }
    },
);
