import { NextRequest, NextResponse } from "next/server";
import { getAttendeeById } from "@/lib/salesforce/client";

/**
 * GET /api/salesforce/attendee?attendeeId=<id>
 *
 * Returns a single Attendee__c record by its Salesforce Id. Intended as a
 * lightweight probe / debugging helper — not part of any production flow.
 *
 * @param {NextRequest} request - Standard Next.js request; `attendeeId` is read from search params.
 * @returns {Response} `{ attendee }` on success, `{ error }` with HTTP 500 on failure.
 */
export async function GET(request: NextRequest) {
    // Read the Salesforce Attendee__c Id from the query string. An empty value
    // is passed through to getAttendeeById, which throws a clear error.
    const attendeeId = request.nextUrl.searchParams.get("attendeeId") ?? "";
    try {
        // Issues a SOQL query for the matching Attendee__c row.
        const attendee = await getAttendeeById(attendeeId);
        return NextResponse.json({ attendee });
    } catch (err) {
        // Surface SF / SOQL errors so the caller can see what went wrong.
        return NextResponse.json({ error: String(err) }, { status: 500 });
    }
}
