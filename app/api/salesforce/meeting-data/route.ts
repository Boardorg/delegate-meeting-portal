import { NextRequest, NextResponse } from "next/server";
import { getMeetingDataByEvent } from "@/lib/salesforce/client";

export async function GET(request: NextRequest) {
    const eventCode = request.nextUrl.searchParams.get("eventCode");
    if (!eventCode) {
        return NextResponse.json(
            { error: "Missing required query param: eventCode" },
            { status: 400 },
        );
    }
    try {
        const data = await getMeetingDataByEvent(eventCode);
        return NextResponse.json({
            eventCode,
            counts: { delegates: data.delegates.length, sponsors: data.sponsors.length },
            ...data,
        });
    } catch (err) {
        return NextResponse.json({ error: String(err) }, { status: 500 });
    }
}
