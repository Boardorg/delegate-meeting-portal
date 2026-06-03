import { NextRequest, NextResponse } from "next/server";
import {
    getMeetingDataByEvent,
    writeJsonToTemp,
} from "@/lib/salesforce/client";
import { meetingDataToAttendees } from "@/lib/salesforce/attendeeMapper";
import { generateMockRequests } from "@/lib/salesforce/requestsMock";

/**
 * GET /api/salesforce/meeting-data?eventCode=<code>[&json=true][&placeholders=true]
 *
 * Returns the attendee list (delegates + sponsors) for a conference using the
 * reverse-engineered "Master List: Summit Reg Attendee Count" filter set.
 *
 * Query params:
 *   - `eventCode` (required): conference code, e.g. `NAMLS`.
 *   - `json=true` (optional): write the mapped Attendee[] to
 *       `data/temp/attendees-<event>-<ts>.json`.
 *   - `placeholders=true` (optional): generate synthetic values for fields
 *       with no SF source (id, cventContactId, scheduling). When combined
 *       with `json=true`, also writes a mocked
 *       `data/temp/requests-<event>-<ts>.json` for the scheduling engine.
 *
 * @param {NextRequest} request - Standard Next.js request; params read from search params.
 * @returns {Response} JSON with counts, attendees (when json=true), and optional file paths.
 */
export async function GET(request: NextRequest) {
    // Read query params controlling the run.
    const eventCode = request.nextUrl.searchParams.get("eventCode");
    const usePlaceholders =
        request.nextUrl.searchParams.get("placeholders") === "true";
    const writeJson = request.nextUrl.searchParams.get("json") === "true";

    // eventCode is required because the underlying SOQL is scoped to a single
    // conference; without it the query would either error or return nothing.
    if (!eventCode) {
        return NextResponse.json(
            { error: "Missing required query param: eventCode" },
            { status: 400 },
        );
    }
    try {
        // Single round-trip to Salesforce: returns { delegates, sponsors }.
        let data = await getMeetingDataByEvent(eventCode);

        if (writeJson) {
            // Convert raw SF records into the normalized Attendee shape used
            // by the scheduling engine. Placeholder fields are filled in here
            // when usePlaceholders is true.
            const attendees = meetingDataToAttendees(data, usePlaceholders);

            // Shared timestamp so the paired attendees / requests files
            // written below share an obvious naming relationship.
            const stamp = Date.now();
            const jsonPath = await writeJsonToTemp(
                attendees,
                `attendees-${eventCode}-${stamp}.json`,
            );

            // When placeholders are enabled, also write a synthetic
            // requests.json so the engine has a complete input set.
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
            // Without `json=true` we return the raw SF records as queried,
            // keyed by role. Skips the Attendee mapping entirely.
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
        // Surface SF / SOQL errors so the caller can see what went wrong.
        return NextResponse.json({ error: String(err) }, { status: 500 });
    }
}
