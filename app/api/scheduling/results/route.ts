import { NextResponse } from 'next/server';
import { loadMockData, loadMockRequests, runScheduler } from '@/lib/scheduling/engine';
import path from 'path';

/**
 * Handle GET requests for the mock scheduling endpoint.
 *
 * Loads mock attendee and request data from local CSV files, runs the scheduler,
 * summarizes the generated meetings, and returns the full scheduling result as JSON.
 */
export async function GET() {
	try {

		// Build the absolute path to the local mock data directory.
		const base = path.join(process.cwd(), 'data', 'mock');

		// Load attendee and request data.
		const [attendees, requests] = await Promise.all([
			loadMockData(path.join(base, 'attendees.json')),
			loadMockRequests(path.join(base, 'requests.json')),
		]);

		// Run the scheduler to generate the meeting schedule and individual attendee schedules.
		const { schedule, attendeeSchedules } = await runScheduler(attendees, requests);

		// Initialize a constant to count how many meetings were created during each scheduler pass.
		const meetingsByPass: Record<number, number> = {};

		// Loop through the generated schedule and add up the pass counts for each meeting.
		for (const m of schedule) {
			meetingsByPass[m.passNumber] = (meetingsByPass[m.passNumber] ?? 0) + 1;
		}

		// Get the list of all attendees who have at least one scheduled meeting.
		const scheduledIds = new Set(schedule.flatMap(m => [m.attendeeA, m.attendeeB]));

		// Create a list of all attendees who were not scheduled into any meetings.
		const unmatchedAttendees = attendees
			.filter(a => !scheduledIds.has(a.id))
			.map(a => `${a.id} (${a.name})`);

		// Return a summary, the full schedule, and the individual attendee schedules as JSON.
		return NextResponse.json({
			summary: { totalMeetings: schedule.length, meetingsByPass, unmatchedAttendees },
			attendeeSchedules,
			allMeetings: schedule,
		});

	} catch (err) {

		// If there was an error, return it with a 500 status code.
		return NextResponse.json({ error: String(err) }, { status: 500 });
	}
}
