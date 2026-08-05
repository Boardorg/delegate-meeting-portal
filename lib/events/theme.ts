import type { CSSProperties } from "react";

// ---------------------------------------------------------------------------
// Frontend theming from a per-event Brand Color.
//
// The catalog's primary accent is the --accent family of CSS variables defined in
// globals.css. Those literals are only the FALLBACK; when the active event has a
// Brand Color set (event_settings.theme_color), we override the family at the
// catalog root so buttons, request highlights, etc. reflect the event's color.
// ---------------------------------------------------------------------------

/**
 * Builds the CSS custom-property overrides that theme the frontend to a given
 * per-event Brand Color.
 *
 * Returns an empty object when `color` is null/empty so the globals.css
 * defaults apply — i.e. the default teal is the fallback. The --accent-deep
 * (darken-on-hover) and --accent-grey (muted, unselected) partners are derived
 * from the base with color-mix so hovers and quiet states stay coherent with
 * the chosen color instead of reverting to teal.
 *
 * The value is a validated `#rrggbb` hex (see normalizeColor in the event
 * settings action), so it is safe to interpolate into the CSS values here.
 *
 * @param {string | null | undefined} color - The event's Brand Color hex.
 * @returns {CSSProperties} Inline style carrying the variable overrides.
 */
export function eventThemeVars(
    color: string | null | undefined,
): CSSProperties {
    if (!color) return {};
    return {
        "--accent": color,
        // ~32% toward black — mirrors how the default --accent-deep darkens --accent.
        "--accent-deep": `color-mix(in srgb, ${color} 68%, #000)`,
        // Desaturated sibling for unselected states — mix toward a neutral grey.
        "--accent-grey": `color-mix(in srgb, ${color} 55%, #6b6b6b)`,
    } as CSSProperties;
}
