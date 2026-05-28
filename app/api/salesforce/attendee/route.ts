import { NextRequest, NextResponse } from "next/server";
import { getAttendeeById } from "@/lib/salesforce/client";

export async function GET(request: NextRequest) {
    const attendeeId = request.nextUrl.searchParams.get("attendeeId") ?? "";
    try {
        const attendee = await getAttendeeById(attendeeId);
        return NextResponse.json({ attendee });
    } catch (err) {
        return NextResponse.json({ error: String(err) }, { status: 500 });
    }
}
