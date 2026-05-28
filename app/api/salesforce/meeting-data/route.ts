import { NextRequest, NextResponse } from "next/server";
import {
    getMeetingDataByEvent,
    writeJsonToTemp,
} from "@/lib/salesforce/client";
import { meetingDataToAttendees } from "@/lib/salesforce/attendeeMapper";
import { generateMockRequests } from "@/lib/salesforce/requestsMock";

export async function GET(request: NextRequest) {
    const eventCode = request.nextUrl.searchParams.get("eventCode");
    const usePlaceholders =
        request.nextUrl.searchParams.get("placeholders") === "true";
    const writeJson = request.nextUrl.searchParams.get("json") === "true";
    if (!eventCode) {
        return NextResponse.json(
            { error: "Missing required query param: eventCode" },
            { status: 400 },
        );
    }
    try {
        let data = await getMeetingDataByEvent(eventCode);

        if (writeJson) {
            const attendees = meetingDataToAttendees(data, usePlaceholders);
            const stamp = Date.now();
            const jsonPath = await writeJsonToTemp(
                attendees,
                `attendees-${eventCode}-${stamp}.json`,
            );

            let requestsPath: string | undefined;
            if (usePlaceholders) {
                const requests = generateMockRequests(attendees);
                requestsPath = await writeJsonToTemp(
                    requests,
                    `requests-${eventCode}-${stamp}.json`,
                );
            }

            return NextResponse.json({
                eventCode,
                counts: {
                    delegates: data.delegates.length,
                    sponsors: data.sponsors.length,
                },
                jsonPath,
                requestsPath,
                attendees,
            });
        } else {
            return NextResponse.json({
                eventCode,
                counts: {
                    delegates: data.delegates.length,
                    sponsors: data.sponsors.length,
                },
                ...data,
            });
        }
    } catch (err) {
        return NextResponse.json({ error: String(err) }, { status: 500 });
    }
}
