import fs from 'fs';
import path from 'path';
import { Attendee, MeetingRequest } from '@/types';

/**
 * Reads and parses `attendees.json` at the given path into typed `Attendee` records.
 *
 * @param {string} filePath - Absolute path to the attendees JSON file.
 * @returns {Promise<Attendee[]>} Resolves to an array of parsed `Attendee` objects.
 */
export async function loadMockData(filePath: string): Promise<Attendee[]> {

	// Read the file from disk as a UTF-8 string and parse it as JSON.
	const raw = fs.readFileSync(path.resolve(filePath), 'utf-8');
	return JSON.parse(raw) as Attendee[];
}

/**
 * Represents the raw shape of a meeting request as stored in the mock JSON file.
 * 
 * We need this because the JSON file uses snake_case keys that match the DB schema,
 * but our app code uses camelCase. Drizzle's schema already handles the snake_case
 * to camelCase mapping for DB queries, but since we're loading from a static JSON
 * file for mocks, we need to define this intermediate type to parse the raw data.
 */
type RawMockRequest = {
	id: number;
	requester_id: string;
	target_id: string;
	rank: number;
	event_code: string;
	created_at: string;
	updated_at: string;
};

/**
 * Reads and parses `requests.json` at the given path into typed `MeetingRequest` records.
 * The file uses the same snake_case schema as the DB table; this function maps it to
 * the camelCase `MeetingRequest` shape the engine expects.
 *
 * @param {string} filePath - Absolute path to the meeting requests JSON file.
 * @returns {Promise<MeetingRequest[]>} Resolves to an array of parsed `MeetingRequest` objects.
 */
export async function loadMockRequests(filePath: string): Promise<MeetingRequest[]> {
	const raw = fs.readFileSync(path.resolve(filePath), 'utf-8');
	const rows = JSON.parse(raw) as RawMockRequest[];
	return rows.map((r) => ({
		id: String(r.id),
		requesterId: r.requester_id,
		targetId: r.target_id,
		rank: r.rank,
	}));
}
