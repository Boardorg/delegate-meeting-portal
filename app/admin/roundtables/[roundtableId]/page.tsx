import { notFound } from "next/navigation";
import { getActiveEventCode } from "@/lib/admin/globalState";
import { getRoundtableDetail } from "./actions";
import RoundtableDetailView from "./RoundtableDetail";

// ---------------------------------------------------------------------------
// /admin/roundtables/[roundtableId] — one roundtable.
//
// Mirrors /admin/meetings/[sponsorId]. The roundtableId param is the roundtable's id, URL-encoded.
// ---------------------------------------------------------------------------

/**
 * Renders one roundtable's page.
 *
 * @param {{ params: Promise<{ roundtableId: string }> }} props - Route props.
 * @returns {Promise<JSX.Element>} The page element.
 */
export default async function RoundtablePage({
    params,
}: {
    params: Promise<{ roundtableId: string }>;
}) {
    const { roundtableId } = await params;
    const event = await getActiveEventCode();
    if (!event) notFound();

    const detail = await getRoundtableDetail({
        roundtableId: decodeURIComponent(roundtableId),
        eventCode: event,
    });
    if (!detail) notFound();

    return <RoundtableDetailView detail={detail} eventCode={event} />;
}
