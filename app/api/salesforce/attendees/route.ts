import { NextRequest, NextResponse } from "next/server";
import { getAttendeesByEventId } from "@/lib/salesforce/client";

export async function GET(request: NextRequest) {
    const eventId = request.nextUrl.searchParams.get("eventId") ?? "";
    try {
        const attendees = await getAttendeesByEventId(eventId);
        return NextResponse.json({ attendees });
    } catch (err) {
        return NextResponse.json({ error: String(err) }, { status: 500 });
    }
}
