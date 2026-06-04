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
 * Reads and parses `requests.json` at the given path into typed `MeetingRequest` records.
 *
 * @param {string} filePath - Absolute path to the meeting requests JSON file.
 * @returns {Promise<MeetingRequest[]>} Resolves to an array of parsed `MeetingRequest` objects.
 */
export async function loadMockRequests(filePath: string): Promise<MeetingRequest[]> {

	// Read the file from disk as a UTF-8 string and parse it as JSON.
	const raw = fs.readFileSync(path.resolve(filePath), 'utf-8');
	return JSON.parse(raw) as MeetingRequest[];
}
