import path from "path";
import { cache } from "react";
import { loadMockData } from "@/lib/scheduling/loader";
import { formatProfile } from "@/lib/attendees/formatProfile";
import { getMeetingDataByEvent } from "@/lib/salesforce/client";
import { meetingDataToAttendees } from "@/lib/salesforce/attendeeMapper";
import { getEventCode } from "@/lib/helpers/getEventCode";
import { getEventAttendees } from "@/lib/cvent/client";
import { isTestingMode } from "@/lib/helpers/testingMode";
import { Attendee } from "@/types";

// In TESTING_MODE, Cvent email addresses are obfuscated by wrapping the real
// address in this marker — e.g. Salesforce "mary@site.com" appears in Cvent as
// "xxmary@site.comxx". We strip the wrapper before matching. Used for non-prod
// events where real contacts must not receive real communications.
const EMAIL_SAFE_WRAP = "xx";

/**
 * Normalizes a Cvent contact email for matching against Salesforce: lowercased,
 * and (in TESTING_MODE) with the obfuscation wrapper stripped so
 * "xxmary@site.comxx" matches Salesforce's "mary@site.com".
 *
 * @param {string} email - The raw Cvent contact email.
 * @returns {string} The comparison key.
 */
function normalizeCventEmail(email: string): string {
    const lower = email.trim().toLowerCase();
    if (!isTestingMode()) return lower;

    // Only unwrap when the marker is present on both ends, so a stray un-obfuscated
    // address still compares correctly.
    if (
        lower.startsWith(EMAIL_SAFE_WRAP) &&
        lower.endsWith(EMAIL_SAFE_WRAP) &&
        lower.length > EMAIL_SAFE_WRAP.length * 2
    ) {
        return lower.slice(
            EMAIL_SAFE_WRAP.length,
            lower.length - EMAIL_SAFE_WRAP.length,
        );
    }
    return lower;
}

/**
 * Loads the full attendee list (delegates + sponsors) for the event and
 * applies display-layer profile formatting.
 *
 * Data source is controlled by the USE_MOCK env var:
 *   - `true`: reads from data/mock/attendees.json
 *   - anything else: queries Salesforce using `eventCode` when provided (the
 *     login flow, which has no session yet), otherwise the code resolved by
 *     getEventCode() (env var → session).
 *
 * This is a thin front door: it resolves the effective data source and event
 * code, then delegates to the request-memoized core. Resolving here means every
 * caller in a request shares one cache entry regardless of how they spelled the
 * arguments — `loadAttendees()`, `loadAttendees(false, undefined)`, and
 * `loadAttendees(false, "BMWS")` all collapse to the same normalized key.
 *
 * @param {boolean} [mock] - Force the mock JSON source.
 * @param {string} [eventCode] - Explicit event code override for the SF query.
 */
export async function loadAttendees(
    mock: boolean = false,
    eventCode?: string,
): Promise<Attendee[]> {
    const useMock = process.env.USE_MOCK === "true" || mock;

    // Resolve the code once. Mock mode reads a static file and ignores the code,
    // so key it empty; otherwise use the explicit code (login, pre-session) or
    // fall back to the env var / session cookie via getEventCode().
    const resolvedEventCode = useMock
        ? ""
        : (eventCode ?? (await getEventCode()));

    return loadAttendeesCached(useMock, resolvedEventCode);
}

/**
 * Request-memoized core of {@link loadAttendees}, keyed on the already-resolved
 * (useMock, eventCode) so multiple callers in one render share a single
 * Salesforce + Cvent round-trip.
 *
 * NOTE: React's `cache` hands every caller the *same* array instance within a
 * request. Treat the result as read-only — filter/map to derive, never sort or
 * splice it in place, or you'll corrupt other callers' view.
 *
 * @param {boolean} useMock - Whether to read the mock JSON source.
 * @param {string} eventCode - Resolved event code ("" in mock mode).
 * @returns {Promise<Attendee[]>} The formatted attendee list.
 */
const loadAttendeesCached = cache(
    async (useMock: boolean, eventCode: string): Promise<Attendee[]> => {
        let attendees: Attendee[];

        // Are we using mock data?
        if (useMock) {
            // Load from the mock JSON file.
            const base = path.join(process.cwd(), "data", "mock");
            attendees = await loadMockData(path.join(base, "attendees.json"));

            // Not using mock data, so load from Salesforce.
        } else {
            // Load from Salesforce using the event code.
            const data = await getMeetingDataByEvent(eventCode);
            attendees = meetingDataToAttendees(data, false);

            // Cross-check against Cvent: keep only attendees who also exist in Cvent
            // for this event (matched by email), and enrich each with its real Cvent
            // contact id (needed to push appointments). Cvent presence is required —
            // if the lookup can't run (no Cvent Event ID, or the API fails), return
            // no attendees rather than exposing/scheduling people we can't push.
            let cventAttendees;
            try {
                cventAttendees = await getEventAttendees(eventCode);
            } catch (err) {
                console.warn(
                    `loadAttendees: Cvent attendee lookup failed for "${eventCode}" — ` +
                        `returning no attendees. ${err instanceof Error ? err.message : String(err)}`,
                );
                return [];
            }

            const cventAttendeesNormalized = cventAttendees.map((c) => ({
                email: normalizeCventEmail(c.email),
                contactId: c.contactId,
            }));

            attendees = attendees
                .filter(
                    (a) =>
                        a.email &&
                        cventAttendeesNormalized.find(
                            (c) => c.email === a.email.toLowerCase(),
                        ),
                )
                .map((a) => ({
                    ...a,
                    cventContactId:
                        cventAttendeesNormalized.find(
                            (c) => c.email === a.email.toLowerCase(),
                        )?.contactId ?? "",
                }));
        }

        // Apply display-layer formatting to the profile data for each attendee.
        return attendees.map((a) => ({
            ...a,
            profile: formatProfile(a.profile),
        }));
    },
);
