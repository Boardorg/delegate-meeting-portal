import { NextResponse } from 'next/server';
import { loadMockData, loadMockRequests } from '@/lib/scheduling/engine';
import path from 'path';

/**
 * Handle GET requests for the mock scheduling data endpoint.
 *
 * Loads mock attendee and meeting request data from local CSV files and returns
 * both datasets as JSON.
 */
export async function GET() {
	try {

		// Build the absolute path to the local mock data directory.
		const base = path.join(process.cwd(), 'data', 'mock');

		// Load attendee and meeting request data.
		const [attendees, requests] = await Promise.all([
			loadMockData(path.join(base, 'attendees.json')),
			loadMockRequests(path.join(base, 'requests.json')),
		]);

		// Return the loaded attendees and meeting requests as JSON.
		return NextResponse.json({ attendees, requests });

	} catch (err) {

		// If there was an error, return it with a 500 status code.
		return NextResponse.json({ error: String(err) }, { status: 500 });
	}
}
