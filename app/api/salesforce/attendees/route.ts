import { NextRequest, NextResponse } from "next/server";
import {
    attendeeRecordsToAttendees,
    getAttendeesByEventId,
    writeAttendeesCsv,
} from "@/lib/salesforce/client";

export async function GET(request: NextRequest) {
    const eventId = request.nextUrl.searchParams.get("eventId") ?? "";
    const csv = request.nextUrl.searchParams.get("csv") === "true";
    try {
        const records = await getAttendeesByEventId(eventId);
        let csvPath: string | undefined;
        if (csv) {
            const attendees = attendeeRecordsToAttendees(records);
            csvPath = await writeAttendeesCsv(
                attendees,
                `attendees-${eventId}-${Date.now()}.csv`,
            );
        }
        return NextResponse.json({ attendees: records, csvPath });
    } catch (err) {
        return NextResponse.json({ error: String(err) }, { status: 500 });
    }
}
