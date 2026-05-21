import { NextRequest, NextResponse } from "next/server";
import {
    attendeeRecordsToAttendees,
    getAttendeeById,
    writeAttendeesCsv,
} from "@/lib/salesforce/client";

export async function GET(request: NextRequest) {
    const attendeeId = request.nextUrl.searchParams.get("attendeeId") ?? "";
    const csv = request.nextUrl.searchParams.get("csv") === "true";
    try {
        const record = await getAttendeeById(attendeeId);
        let csvPath: string | undefined;
        if (csv) {
            const attendees = attendeeRecordsToAttendees([record]);
            csvPath = await writeAttendeesCsv(
                attendees,
                `attendee-${attendeeId}-${Date.now()}.csv`,
            );
        }
        return NextResponse.json({ attendee: record, csvPath });
    } catch (err) {
        return NextResponse.json({ error: String(err) }, { status: 500 });
    }
}
