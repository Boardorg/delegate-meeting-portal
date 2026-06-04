import path from 'path';
import { loadMockData } from '@/lib/scheduling/loader';
import { formatProfile } from '@/lib/attendees/formatProfile';
import { getMeetingDataByEvent } from '@/lib/salesforce/client';
import { meetingDataToAttendees } from '@/lib/salesforce/attendeeMapper';
import { Attendee } from '@/types';

/**
 * Loads the full attendee list (delegates + sponsors) for the event and
 * applies display-layer profile formatting.
 *
 * Data source is controlled by the USE_MOCK env var:
 *   - `true`: reads from data/mock/attendees.json
 *   - anything else: queries Salesforce using SF_EVENT_CODE
 */
export async function loadAttendees(): Promise<Attendee[]> {
    let attendees: Attendee[];

    // Are we using mock data?
    if (process.env.USE_MOCK === 'true') {

        // Load from the mock JSON file.
        const base = path.join(process.cwd(), 'data', 'mock');
        attendees = await loadMockData(path.join(base, 'attendees.json'));

    // Not using mock data, so load from Salesforce.
    } else {

        // Validate the event code.
        const eventCode = process.env.SF_EVENT_CODE;
        if (!eventCode) {
            throw new Error('SF_EVENT_CODE env var is required when USE_MOCK is not "true"');
        }

        // Load from Salesforce using the event code.
        const data = await getMeetingDataByEvent(eventCode);
        attendees = meetingDataToAttendees(data, false);
    }

    // Apply display-layer formatting to the profile data for each attendee.
    return attendees.map(a => ({
        ...a,
        profile: formatProfile(a.profile),
    }));
}
