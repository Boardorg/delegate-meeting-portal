import { notFound } from "next/navigation";
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
    searchParams,
}: {
    params: Promise<{ sponsorId: string }>;
    searchParams: Promise<{ event?: string }>;
}) {
    const { sponsorId } = await params;
    const { event } = await searchParams;
    const decodedId = decodeURIComponent(sponsorId);

    if (!event) notFound();

    const detail = await getMeetingDetail({
        sponsorId: decodedId,
        eventCode: event,
    });

    if (!detail) notFound();

    return (
        <MeetingDetail
            sponsor={detail.sponsor}
            meetings={detail.meetings}
            eventCode={event}
        />
    );
}
