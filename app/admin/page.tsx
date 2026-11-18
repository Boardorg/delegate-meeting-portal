import type { ReactNode } from "react";
import Link from "next/link";
import { getAdminState } from "@/lib/admin/globalState";
import { loadEventOverview } from "@/lib/admin/overviewData";
import { StatChip } from "@/app/admin/meetings/_components/StatChip";

// ---------------------------------------------------------------------------
// /admin — the Overview of the selected event.
//
// One card per step, in the order an event is scheduled.
// Each card shows counts and links to the page that does the work.
// ---------------------------------------------------------------------------

/**
 * One Overview card: a title, its counts and warnings, and a link to its page.
 *
 * @param {{ title: string; href: string; linkLabel: string; children: ReactNode }} props - The card's content.
 * @returns {JSX.Element} The card.
 */
function OverviewCard({
    title,
    href,
    linkLabel,
    children,
}: {
    title: string;
    href: string;
    linkLabel: string;
    children: ReactNode;
}) {
    return (
        <section className="adm-card adm-overview-card">
            <div className="adm-card-head">
                <h2 className="adm-overview-card-title">{title}</h2>
                <Link href={href} className="adm-overview-link">
                    {linkLabel} →
                </Link>
            </div>
            {children}
        </section>
    );
}

/**
 * A warning line inside an Overview card.
 *
 * @param {{ children: ReactNode }} props - The warning text.
 * @returns {JSX.Element} The warning.
 */
function Warning({ children }: { children: ReactNode }) {
    return <div className="adm-modal-warn-at adm-overview-warning">{children}</div>;
}

/**
 * Renders the Overview page for the selected event.
 *
 * @returns {Promise<JSX.Element>} The page element.
 */
export default async function AdminOverviewPage() {
    const { events, activeEventCode } = await getAdminState();
    const event = events.find((e) => e.code === activeEventCode) ?? null;

    if (!event) {
        return (
            <div className="adm-page">
                <div className="adm-page-head">
                    <h1 className="adm-page-title">Overview</h1>
                </div>
                <div className="adm-empty adm-empty-lg">
                    {events.length === 0
                        ? "No events yet. Click “+ New Event” under the event picker to add one."
                        : "Pick an event in the event picker to see its overview."}
                </div>
            </div>
        );
    }

    const overview = await loadEventOverview(event);
    const { setup, boothProblems, requests, meetings } = overview;
    const setupOk = setup.missingFields.length === 0 && setup.sponsorTypeMapped;

    return (
        <div className="adm-page">
            <div className="adm-page-head">
                <h1 className="adm-page-title">Overview</h1>
            </div>
            <p className="adm-help-note adm-overview-intro">
                {event.name ?? event.code}, in the order meetings are scheduled.
            </p>

            <OverviewCard title="Setup" href="/admin/event-settings" linkLabel="Event Settings">
                {setupOk ? (
                    <div className="adm-card-sub">Event Settings are complete and sponsor meetings have an appointment type.</div>
                ) : (
                    <>
                        {setup.missingFields.length > 0 && (
                            <Warning>Missing in Event Settings: {setup.missingFields.join(", ")}.</Warning>
                        )}
                        {!setup.sponsorTypeMapped && (
                            <Warning>
                                No Cvent appointment type is mapped to sponsor to delegate, so sponsor meetings
                                can&apos;t be scheduled.
                            </Warning>
                        )}
                    </>
                )}
            </OverviewCard>

            <OverviewCard title="Sponsor Booths" href="/admin/booths" linkLabel="Sponsor Booths">
                {boothProblems === null ? (
                    <Warning>The booths couldn&apos;t be checked because Cvent or Salesforce couldn&apos;t be reached.</Warning>
                ) : boothProblems > 0 ? (
                    <Warning>
                        {boothProblems === 1
                            ? "1 sponsor company has a booth or package problem and will get no meetings."
                            : `${boothProblems} sponsor companies have a booth or package problem and will get no meetings.`}
                    </Warning>
                ) : (
                    <div className="adm-card-sub">Every sponsor company has a booth and a meeting package.</div>
                )}
            </OverviewCard>

            <OverviewCard title="Sponsor Meeting Requests" href="/admin/requests" linkLabel="Sponsor Meeting Requests">
                <div className="adm-card-row">
                    <StatChip label="Requests" value={String(requests.requests)} />
                    <StatChip label="Sponsor companies" value={String(requests.companies)} />
                </div>
            </OverviewCard>

            <OverviewCard title="Sponsor Meetings" href="/admin/meetings" linkLabel="Sponsor Meetings">
                <div className="adm-card-row">
                    <StatChip label="Scheduled" value={String(meetings.scheduled)} />
                    <StatChip label="Synced" value={String(meetings.synced)} />
                    <StatChip label="Modified" value={String(meetings.modified)} />
                    <StatChip label="Not pushed" value={String(meetings.notPushed)} />
                    <StatChip
                        label="Only in Cvent"
                        value={meetings.onlyInCvent === null ? "—" : String(meetings.onlyInCvent)}
                    />
                </div>
                {meetings.onlyInCvent === null && (
                    <Warning>Cvent couldn&apos;t be reached, so meetings only in Cvent aren&apos;t counted.</Warning>
                )}
            </OverviewCard>
        </div>
    );
}
