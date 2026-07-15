import path from "path";
import { loadMockData } from "@/lib/scheduling/loader";
import { formatProfile } from "@/lib/attendees/formatProfile";
import { getMeetingDataByEvent } from "@/lib/salesforce/client";
import { meetingDataToAttendees } from "@/lib/salesforce/attendeeMapper";
import { getEventCode } from "@/lib/helpers/getEventCode";
import { getEventAttendees } from "@/lib/cvent/client";
import { Attendee } from "@/types";

// In EMAIL_SAFE_MODE, Cvent email addresses are obfuscated by wrapping the real
// address in this marker — e.g. Salesforce "mary@site.com" appears in Cvent as
// "xxmary@site.comxx". We strip the wrapper before matching. Used for non-prod
// events where real contacts must not receive real communications.
const EMAIL_SAFE_WRAP = "xx";

/**
 * Normalizes a Cvent contact email for matching against Salesforce: lowercased,
 * and (in EMAIL_SAFE_MODE) with the obfuscation wrapper stripped so
 * "xxmary@site.comxx" matches Salesforce's "mary@site.com".
 *
 * @param {string} email - The raw Cvent contact email.
 * @returns {string} The comparison key.
 */
function normalizeCventEmail(email: string): string {
    const lower = email.trim().toLowerCase();
    if (process.env.EMAIL_SAFE_MODE !== "true") return lower;

    // Only unwrap when the marker is present on both ends, so a stray un-obfuscated
    // address still compares correctly.
    if (
        lower.startsWith(EMAIL_SAFE_WRAP) &&
        lower.endsWith(EMAIL_SAFE_WRAP) &&
        lower.length > EMAIL_SAFE_WRAP.length * 2
    ) {
        return lower.slice(EMAIL_SAFE_WRAP.length, lower.length - EMAIL_SAFE_WRAP.length);
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
 * @param {boolean} [mock] - Force the mock JSON source.
 * @param {string} [eventCode] - Explicit event code override for the SF query.
 */
export async function loadAttendees(
    mock: boolean = false,
    eventCode?: string,
): Promise<Attendee[]> {
    let attendees: Attendee[];

    // Are we using mock data?
    if (process.env.USE_MOCK === "true" || mock) {
        // Load from the mock JSON file.
        const base = path.join(process.cwd(), "data", "mock");
        attendees = await loadMockData(path.join(base, "attendees.json"));

        // Not using mock data, so load from Salesforce.
    } else {
        // Use the explicit code when given (login, pre-session), otherwise
        // resolve it from the env var / session cookie.
        const resolvedEventCode = eventCode ?? (await getEventCode());

        // Load from Salesforce using the event code.
        const data = await getMeetingDataByEvent(resolvedEventCode);
        attendees = meetingDataToAttendees(data, false);

        // Cross-check against Cvent: keep only attendees who also exist in Cvent
        // for this event (matched by email), and enrich each with its real Cvent
        // contact id (needed to push appointments). Cvent presence is required —
        // if the lookup can't run (no Cvent Event ID, or the API fails), return
        // no attendees rather than exposing/scheduling people we can't push.
        let cventAttendees;
        try {
            cventAttendees = await getEventAttendees(resolvedEventCode);
        } catch (err) {
            console.warn(
                `loadAttendees: Cvent attendee lookup failed for "${resolvedEventCode}" — ` +
                    `returning no attendees. ${err instanceof Error ? err.message : String(err)}`,
            );
            return [];
        }

        const contactIdByEmail = new Map(
            cventAttendees.map((c) => [normalizeCventEmail(c.email), c.contactId]),
        );
        attendees = attendees
            .filter((a) => a.email && contactIdByEmail.has(a.email.toLowerCase()))
            .map((a) => ({
                ...a,
                cventContactId: contactIdByEmail.get(a.email.toLowerCase())!,
            }));
    }

    // Apply display-layer formatting to the profile data for each attendee.
    return attendees.map((a) => ({
        ...a,
        profile: formatProfile(a.profile),
    }));
}
