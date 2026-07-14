import { notFound } from "next/navigation";
import { getActiveEventCode } from "@/lib/admin/globalState";
import { getMeetingDetail } from "./actions";
import MeetingDetail from "./MeetingDetail";

// ---------------------------------------------------------------------------
// /admin/meetings/[sponsorId] — per-sponsor meeting detail page.
//
// Server component: loads sponsor + meeting data for the selected event,
// then hands it off to the MeetingDetail client component for display.
// The sponsorId param is the attendee's Salesforce id (URL-encoded).
// ---------------------------------------------------------------------------

/**
 * Renders the per-sponsor meeting detail page.
 *
 * @param {{ params: Promise<{ sponsorId: string }>; searchParams: Promise<{ event?: string }> }} props
 * @returns {Promise<JSX.Element>} The page element.
 */
export default async function SponsorMeetingsPage({
    params,
}: {
    params: Promise<{ sponsorId: string }>;
}) {
    // Get the sponsorId from the route params; the event is global (cookie-backed).
    const { sponsorId } = await params;
    const event = await getActiveEventCode();

    // Decode the sponsorId since it is URL-encoded in the route.
    const decodedId = decodeURIComponent(sponsorId);

    // No active event → nothing to show.
    if (!event) notFound();

    // Fetch the meeting detail data for the sponsor and event.
    const detail = await getMeetingDetail({
        sponsorId: decodedId,
        eventCode: event,
    });

    // If no meeting detail is found, return a 404 page.
    if (!detail) notFound();

    // Render the meeting detail page with the fetched data.
    return (
        <MeetingDetail
            sponsor={detail.sponsor}
            meetings={detail.meetings}
            eventCode={event}
        />
    );
}
