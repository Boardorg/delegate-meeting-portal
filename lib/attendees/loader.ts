import path from "path";
import { loadMockData } from "@/lib/scheduling/loader";
import { formatProfile } from "@/lib/attendees/formatProfile";
import { getMeetingDataByEvent } from "@/lib/salesforce/client";
import { meetingDataToAttendees } from "@/lib/salesforce/attendeeMapper";
import { getEventCode } from "@/lib/helpers/getEventCode";
import { getEventAttendees } from "@/lib/cvent/client";
import { Attendee } from "@/types";

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
            cventAttendees.map((c) => [c.email.toLowerCase(), c.contactId]),
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
