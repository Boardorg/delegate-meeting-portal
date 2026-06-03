import { NextRequest, NextResponse } from "next/server";
import { getAttendeesByEventId } from "@/lib/salesforce/client";

/**
 * GET /api/salesforce/attendees?eventId=<id>
 *
 * Returns every Attendee__c record linked to the given Event__c id. Uses the
 * simple per-event attendee query (NOT the reverse-engineered meeting-data
 * filter set) — useful for inspecting raw attendee data for a specific event.
 *
 * @param {NextRequest} request - Standard Next.js request; `eventId` is read from search params.
 * @returns {Response} `{ attendees }` on success, `{ error }` with HTTP 500 on failure.
 */
export async function GET(request: NextRequest) {
    // Read the Salesforce Event__c id from the query string. The default of
    // "" is passed through to getAttendeesByEventId, which throws if empty.
    const eventId = request.nextUrl.searchParams.get("eventId") ?? "";
    try {
        // Run the SOQL query for all Attendee__c rows belonging to that event.
        const attendees = await getAttendeesByEventId(eventId);
        return NextResponse.json({ attendees });
    } catch (err) {
        // Surface SF / SOQL errors so the caller can see what went wrong.
        return NextResponse.json({ error: String(err) }, { status: 500 });
    }
}
