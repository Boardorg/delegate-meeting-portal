import { notFound } from "next/navigation";
import { getActiveEventCode } from "@/lib/admin/globalState";
import { getDelegateMeetingDetail } from "./actions";
import DelegateMeetingDetail from "./DelegateMeetingDetail";

// ---------------------------------------------------------------------------
// /admin/delegate-meetings/[delegateId] — one delegate's meetings.
//
// Mirrors /admin/meetings/[sponsorId]. The delegateId param is the delegate's Salesforce id, URL-encoded.
// ---------------------------------------------------------------------------

/**
 * Renders one delegate's meeting page.
 *
 * @param {{ params: Promise<{ delegateId: string }> }} props - Route props.
 * @returns {Promise<JSX.Element>} The page element.
 */
export default async function DelegateMeetingPage({
    params,
}: {
    params: Promise<{ delegateId: string }>;
}) {
    const { delegateId } = await params;
    const event = await getActiveEventCode();
    if (!event) notFound();

    const detail = await getDelegateMeetingDetail({
        delegateId: decodeURIComponent(delegateId),
        eventCode: event,
    });
    if (!detail) notFound();

    return (
        <DelegateMeetingDetail
            delegate={detail.delegate}
            meetings={detail.meetings}
            eventCode={event}
            timezone={detail.timezone}
        />
    );
}
