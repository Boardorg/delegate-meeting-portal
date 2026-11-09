import { NextRequest, NextResponse } from 'next/server';
import { runScheduler } from '@/lib/scheduling/engine';
import { resolveCompanyBooths, type BoothLocations } from '@/lib/scheduling/booths';
import { sponsorCompaniesByAccountId } from '@/lib/attendees/companies';
import { Attendee, Location, MeetingRequest, Timeslot } from '@/types';

// Define the expected shape of the request body for scheduling.
// boothLocations is the optional manual booth mapping, the same shape event_settings stores.
type SchedulingRequestBody = {
	attendees: Attendee[];
	requests: MeetingRequest[];
	timeslots: Timeslot[];
	locations: Location[];
	boothLocations?: BoothLocations | null;
};

/**
 * Handle POST requests for the scheduling endpoint.
 *
 * Accepts attendee and meeting request data from the request body, runs the
 * scheduler with that data, and returns the generated scheduling result as JSON.
 * Each sponsor company only meets at its booth, matched against the given locations.
 */
export async function POST(request: NextRequest) {
	try {

		// Parse the request body as JSON and extract attendees and requests.
		const body = await request.json() as SchedulingRequestBody;

		// Resolve each sponsor company's booth from the provided locations and mapping.
		const attendees = body.attendees ?? [];
		const locations = body.locations ?? [];
		const booths = resolveCompanyBooths(
			[...sponsorCompaniesByAccountId(attendees).values()],
			locations,
			body.boothLocations ?? null,
		);

		// Run the scheduler with the provided data.
		const result = await runScheduler(
			attendees,
			body.requests ?? [],
			body.timeslots ?? [],
			locations,
			{},
			booths,
		);

		// Return the generated schedule and attendee schedules. skipReasons is a
		// Map, which JSON.stringify silently turns into {}, so convert it to a
		// plain object first.
		return NextResponse.json({
			...result,
			skipReasons: Object.fromEntries(result.skipReasons),
		});

	} catch (err) {

		// If there was an error, return it with a 500 status code.
		return NextResponse.json({ error: String(err) }, { status: 500 });
	}
}
