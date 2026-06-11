import path from "path";
import { loadMockData } from "@/lib/scheduling/loader";
import { formatProfile } from "@/lib/attendees/formatProfile";
import { getMeetingDataByEvent } from "@/lib/salesforce/client";
import { meetingDataToAttendees } from "@/lib/salesforce/attendeeMapper";
import { getEventCode } from "@/lib/helpers/getEventCode";
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
    }

    // Apply display-layer formatting to the profile data for each attendee.
    return attendees.map((a) => ({
        ...a,
        profile: formatProfile(a.profile),
    }));
}
