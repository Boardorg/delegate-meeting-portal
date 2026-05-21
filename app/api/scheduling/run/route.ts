import { NextRequest, NextResponse } from 'next/server';
import { runScheduler } from '@/lib/scheduling/engine';
import { Attendee, MeetingRequest } from '@/types';

// Define the expected shape of the request body for scheduling.
type SchedulingRequestBody = {
	attendees: Attendee[];
	requests: MeetingRequest[];
};

/**
 * Handle POST requests for the scheduling endpoint.
 *
 * Accepts attendee and meeting request data from the request body, runs the
 * scheduler with that data, and returns the generated scheduling result as JSON.
 */
export async function POST(request: NextRequest) {
	try {

		// Parse the request body as JSON and extract attendees and requests.
		const body = await request.json() as SchedulingRequestBody;

		// Run the scheduler with the provided data.
		const result = await runScheduler(body.attendees ?? [], body.requests ?? []);

		// Return the generated schedule and attendee schedules.
		return NextResponse.json(result);

	} catch (err) {

		// If there was an error, return it with a 500 status code.
		return NextResponse.json({ error: String(err) }, { status: 500 });
	}
}
