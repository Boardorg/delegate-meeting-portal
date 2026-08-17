"use client";

import "@/app/frontend.css";
import { useState, useMemo, useRef, useEffect, useCallback } from "react";
import { contractedMeetings } from "@/lib/attendees/caps";
import { partyId } from "@/lib/attendees/companies";
import { Attendee, AttendeeProfile, MeetingRequest } from "@/types";
import TopBar, { type TopBarEventLogo } from "@/app/components/TopBar";
import DetailsModal from "@/app/components/DetailsModal";
import {
    REV_TIERS,
    revClass,
    dotTags,
    str,
    hasValue,
} from "@/app/components/catalogFormat";

// ── Constants ──────────────────────────────────────────────────────────────

const SORT_ORDER: Record<string, string[]> = {
    annualRevenue: REV_TIERS,
    budgetaryResponsibility: [
        "<1M",
        "1M-10M",
        "10M-50M",
        "50M-100M",
        "100M-500M",
        "500M-1B",
        ">1B",
    ],
    plannedSpend: ["<1M", "1M-5M", "5M-25M", "25M-100M", ">100M"],
    companySize: [
        "1-50",
        "51-200",
        "200-500",
        "500-1000",
        "1000-5000",
        ">5000",
    ],
};

const LIST_BREAK = 860;
// Trailing 96px column is the (header-less) "More details" button.
const LIST_COLS = "140px 110px 72px 82px 72px 68px 1fr 1fr 1fr 96px";
const LIST_HEADERS = [
    "Name / Title",
    "Company",
    "Revenue",
    "Budget Resp.",
    "Planned Spend",
    "Co. Size",
    "Specialization",
    "Industries",
    "Priorities",
    "",
];

// ── Types ──────────────────────────────────────────────────────────────────

type ViewMode = "grid" | "list";
type SortDir = "asc" | "desc";

interface FilterConfig {
    id: string;
    label: string;
    type: "single" | "multi";
    options: string[];
}

interface Props {
    delegates: Attendee[];
    currentSponsor: Attendee;
    /** Current-event logo for the header, or null when the event has none. */
    eventLogo?: TopBarEventLogo | null;
}

// ── Pure helpers ───────────────────────────────────────────────────────────
// Presentational helpers (revClass, dotTags, str, hasValue) live in
// ./catalogFormat and are imported above so DetailsModal can share them.

function getSortVal(d: Attendee, field: string): string | number {
    if (field === "name") return d.name.toLowerCase();
    if (field === "title") return d.title.toLowerCase();
    if (field === "company") return d.company.toLowerCase();
    const v = (d.profile as unknown as Record<string, unknown>)[field];
    if (v == null) return -1;
    const ord = SORT_ORDER[field];
    return ord ? ord.indexOf(String(v)) : -1;
}

// ── Sub-components ─────────────────────────────────────────────────────────

function CardMoreToggle({ p }: { p: AttendeeProfile }) {
    const [open, setOpen] = useState(false);
    const groups = [
        { label: "Specialization", items: p.areasOfSpecialization },
        { label: "Industries", items: p.industrySectors },
        { label: "Regions", items: p.regionsOverseen },
        { label: "Priorities", items: p.strategicPriorities },
    ].filter((g) => g.items?.length);

    if (!groups.length) return null;

    return (
        <div className={`card-more ${open ? "open" : ""}`}>
            <button
                className="card-more-trigger"
                onClick={() => setOpen((o) => !o)}
            >
                <span>More details</span>
                <span className="card-more-chevron">▼</span>
            </button>
            {open && (
                <div className="card-more-body">
                    {groups.map((g) => (
                        <div key={g.label}>
                            <div className="card-more-group-label">
                                {g.label}
                            </div>
                            <div className="card-more-group-val">
                                {g.items.join(" · ")}
                            </div>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}

/**
 * The Request → Edit / Remove action group for a single delegate, including the
 * interest-level picker. Presentational: all state (which target is being
 * picked, the just-requested lock) lives in SponsorCatalog and is passed in, so
 * the same group can render in the grid card, the list row, and the details
 * modal off one implementation.
 */
function RequestActions({
    d,
    req,
    isPicking,
    justRequested,
    onStartPick,
    onCancelPick,
    onSelectRank,
    onRemove,
}: {
    d: Attendee;
    /** The delegate's existing request, or undefined when none. */
    req: MeetingRequest | undefined;
    /** True while this delegate's interest-level picker is open. */
    isPicking: boolean;
    /** True during the 2s locked "Requested" confirmation after a save. */
    justRequested: boolean;
    onStartPick: (d: Attendee) => void;
    onCancelPick: () => void;
    onSelectRank: (d: Attendee, rank: number) => void;
    onRemove: (d: Attendee) => void;
}) {
    if (isPicking) {
        return (
            <div className="rank-picker">
                <div className="rank-pips">
                    {[1, 2, 3, 4, 5].map((n) => (
                        <div
                            key={n}
                            className="rank-pip"
                            onClick={() => onSelectRank(d, n)}
                        >
                            {n}
                        </div>
                    ))}
                </div>
                <div className="rank-picker-label">Rate interest level</div>
                <button className="rank-pip-cancel" onClick={onCancelPick}>
                    Cancel
                </button>
            </div>
        );
    }

    if (req !== undefined) {
        // Locked confirmation for 2s after requesting; then editable/removable.
        if (justRequested) {
            return (
                <button className="requested-btn" disabled>
                    👍 Requested
                </button>
            );
        }
        return (
            <div className="req-edit-actions">
                <button className="req-btn" onClick={() => onStartPick(d)}>
                    Edit request
                </button>
                <button className="req-remove-btn" onClick={() => onRemove(d)}>
                    Remove
                </button>
            </div>
        );
    }

    return (
        <button className="req-btn" onClick={() => onStartPick(d)}>
            + Request Meeting
        </button>
    );
}

function DrawerItem({
    d,
    rank,
    onRank,
    onRemove,
}: {
    d: Attendee;
    rank: number;
    onRank: (delegate: Attendee, r: number) => void;
    onRemove: (delegate: Attendee) => void;
}) {
    const [detailOpen, setDetailOpen] = useState(false);
    const p = d.profile;
    const rc = revClass(p.annualRevenue) || "rev-na";

    return (
        <div className="d-item">
            <div className="d-item-hero">
                <div className="d-meta">
                    <div className="d-company">{d.company}</div>
                    <div className="d-name">{d.name}</div>
                    <div className="d-title">{d.title}</div>
                </div>
                <button
                    className="d-remove"
                    onClick={() => onRemove(d)}
                    title="Remove"
                >
                    ✕
                </button>
            </div>
            <button
                className="d-detail-toggle"
                onClick={() => setDetailOpen((o) => !o)}
            >
                <span>Details</span>
                <span
                    className="d-detail-chevron"
                    style={{ transform: detailOpen ? "rotate(180deg)" : "" }}
                >
                    ▼
                </span>
            </button>
            <div className={`d-detail-body ${detailOpen ? "open" : ""}`}>
                <div
                    style={{
                        display: "flex",
                        justifyContent: "space-between",
                        gap: "8px",
                        fontSize: "11px",
                        alignItems: "center",
                    }}
                >
                    <span style={{ color: "var(--t3)", flexShrink: 0 }}>
                        Revenue
                    </span>
                    <span className={`${rc} rev-chip`}>
                        {str(p.annualRevenue)}
                    </span>
                </div>
                <div
                    style={{
                        display: "flex",
                        justifyContent: "space-between",
                        gap: "8px",
                        fontSize: "11px",
                    }}
                >
                    <span style={{ color: "var(--t3)", flexShrink: 0 }}>
                        Budget resp.
                    </span>
                    <span style={{ color: "var(--t2)", textAlign: "right" }}>
                        {p.budgetaryResponsibility || "N/A"}
                    </span>
                </div>
                <div
                    style={{
                        display: "flex",
                        justifyContent: "space-between",
                        gap: "8px",
                        fontSize: "11px",
                    }}
                >
                    <span style={{ color: "var(--t3)", flexShrink: 0 }}>
                        Planned spend
                    </span>
                    <span style={{ color: "var(--t2)", textAlign: "right" }}>
                        {p.plannedSpend || "N/A"}
                    </span>
                </div>
                <div
                    style={{
                        display: "flex",
                        justifyContent: "space-between",
                        gap: "8px",
                        fontSize: "11px",
                    }}
                >
                    <span style={{ color: "var(--t3)", flexShrink: 0 }}>
                        Co. size
                    </span>
                    <span style={{ color: "var(--t2)", textAlign: "right" }}>
                        {str(p.companySize)}
                    </span>
                </div>
                <div
                    style={{
                        display: "flex",
                        justifyContent: "space-between",
                        gap: "8px",
                        fontSize: "11px",
                        marginTop: "2px",
                    }}
                >
                    <span style={{ color: "var(--t3)", flexShrink: 0 }}>
                        Specialization
                    </span>
                    <span style={{ color: "var(--t2)", textAlign: "right" }}>
                        {dotTags(p.areasOfSpecialization) || "N/A"}
                    </span>
                </div>
                <div
                    style={{
                        display: "flex",
                        justifyContent: "space-between",
                        gap: "8px",
                        fontSize: "11px",
                    }}
                >
                    <span style={{ color: "var(--t3)", flexShrink: 0 }}>
                        Industries
                    </span>
                    <span style={{ color: "var(--t2)", textAlign: "right" }}>
                        {dotTags(p.industrySectors) || "N/A"}
                    </span>
                </div>
            </div>
            <div className="d-rank-label">Interest level</div>
            <div className="d-rank-pips">
                {[1, 2, 3, 4, 5].map((n) => (
                    <div
                        key={n}
                        className={`d-rank-pip ${n === rank ? "sel" : ""}`}
                        onClick={() => onRank(d, n)}
                    >
                        {n}
                    </div>
                ))}
            </div>
        </div>
    );
}

function FiltersPanel({
    prefix,
    filterConfig,
    activeFilters,
    openAccordions,
    onToggleAccordion,
    onApplyFilter,
}: {
    prefix: string;
    filterConfig: FilterConfig[];
    activeFilters: Record<string, string[]>;
    openAccordions: Set<string>;
    onToggleAccordion: (id: string) => void;
    onApplyFilter: (
        id: string,
        val: string,
        checked: boolean,
        type: "single" | "multi",
    ) => void;
}) {
    return (
        <>
            {filterConfig.map((f) => {
                const isOpen = openAccordions.has(f.id);
                const count = (activeFilters[f.id] || []).length;
                return (
                    <div
                        key={f.id}
                        className={`acc-item ${isOpen ? "open" : ""}`}
                    >
                        <button
                            className="acc-trigger"
                            onClick={() => onToggleAccordion(f.id)}
                        >
                            <span className="acc-arrow" />
                            <span className="acc-label">{f.label}</span>
                            {count > 0 && (
                                <span className="acc-badge-cnt">{count}</span>
                            )}
                        </button>
                        <div className="acc-body">
                            {f.options.map((opt) => (
                                <label key={opt} className="filter-opt">
                                    <input
                                        type={
                                            f.type === "multi"
                                                ? "checkbox"
                                                : "radio"
                                        }
                                        name={`${prefix}-f-${f.id}`}
                                        value={opt}
                                        checked={(
                                            activeFilters[f.id] || []
                                        ).includes(opt)}
                                        onChange={(e) =>
                                            onApplyFilter(
                                                f.id,
                                                opt,
                                                e.target.checked,
                                                f.type,
                                            )
                                        }
                                    />
                                    {opt}
                                </label>
                            ))}
                        </div>
                    </div>
                );
            })}
        </>
    );
}

// ── Main component ─────────────────────────────────────────────────────────

export default function SponsorCatalog({
    delegates,
    currentSponsor,
    eventLogo,
}: Props) {
    // The current company's party id (its Account id) — the key the server uses
    // for this company's shared request set. Extracted so it can be a stable,
    // statically-checkable effect dependency.
    const currentPartyId = partyId(currentSponsor);
    // This company's saved requests (shared across all of the company's reps;
    // the server keys them by the company party id). Each links to its delegate
    // via targetId (a Salesforce id), so the catalog never translates ids.
    const [requests, setRequests] = useState<MeetingRequest[]>([]);
    const [pickingId, setPickingId] = useState<string | null>(null);
    // Targets (by salesforceId) whose request was just placed/edited in this
    // session. Each shows a locked "Requested" confirmation for 2s before the
    // button re-enables as "Edit request". Requests loaded from the server are
    // never in this set, so they're editable immediately.
    const [justRequestedIds, setJustRequestedIds] = useState<Set<string>>(
        new Set(),
    );
    // Pending 2s timers keyed by target id, so we can clear them on unmount.
    const justRequestedTimers = useRef<
        Map<string, ReturnType<typeof setTimeout>>
    >(new Map());
    const [activeFilters, setActiveFilters] = useState<
        Record<string, string[]>
    >({});
    const [viewMode, setViewMode] = useState<ViewMode>("list");
    const [sortField, setSortField] = useState("company");
    const [sortDir, setSortDir] = useState<SortDir>("asc");
    const [searchQuery, setSearchQuery] = useState("");
    const [drawerOpen, setDrawerOpen] = useState(false);
    // Delegate whose "More details" modal is open (list view), or null.
    const [detailsDelegate, setDetailsDelegate] = useState<Attendee | null>(
        null,
    );
    const [filterDrawerOpen, setFilterDrawerOpen] = useState(false);
    const [openAccordions, setOpenAccordions] = useState<Set<string>>(
        new Set(),
    );
    const [catalogWidth, setCatalogWidth] = useState(999);
    const catalogRef = useRef<HTMLDivElement>(null);

    // The contracted amount is a reference point, not a cap: requesters can
    // file as many requests as they like (the scheduling engine still only
    // schedules up to the contracted amount). `reachedPackage` just drives an
    // informational nudge once they've filed enough to fill that amount.
    const maxMeetings = contractedMeetings(currentSponsor.sponsorTier);
    const reqCount = requests.length;
    const reachedPackage = reqCount >= maxMeetings;

    // ── Filter config ──

    const filterConfig = useMemo((): FilterConfig[] => {
        const collect = (key: keyof AttendeeProfile): string[] =>
            [
                ...new Set(
                    delegates.flatMap((d) => {
                        const v = d.profile[key];
                        return Array.isArray(v) ? (v as string[]) : [];
                    }),
                ),
            ].sort();

        return [
            {
                id: "annualRevenue",
                label: "Annual company revenue",
                type: "single" as const,
                options: REV_TIERS,
            },
            {
                id: "budgetaryResponsibility",
                label: "Personal budgetary responsibility",
                type: "single" as const,
                options: [
                    "<1M",
                    "1M-10M",
                    "10M-50M",
                    "50M-100M",
                    "100M-500M",
                    "500M-1B",
                    ">1B",
                ],
            },
            {
                id: "areasOfSpecialization",
                label: "Areas of specialization",
                type: "multi" as const,
                options: collect("areasOfSpecialization"),
            },
            {
                id: "plannedSpend",
                label: "Planned spend (next 12–24 months)",
                type: "single" as const,
                options: ["<1M", "1M-5M", "5M-25M", "25M-100M", ">100M"],
            },
            {
                id: "industrySectors",
                label: "Industry sectors",
                type: "multi" as const,
                options: collect("industrySectors"),
            },
            {
                id: "companySize",
                label: "Company size (employees)",
                type: "single" as const,
                options: SORT_ORDER.companySize,
            },
            {
                id: "regionsOverseen",
                label: "Regions overseen",
                type: "multi" as const,
                options: collect("regionsOverseen"),
            },
            {
                id: "strategicPriorities",
                label: "Strategic priorities",
                type: "multi" as const,
                options: collect("strategicPriorities"),
            },
        ].filter((f) => f.options.length > 0);
    }, [delegates]);

    useEffect(() => {
        setOpenAccordions(new Set(filterConfig.slice(0, 2).map((f) => f.id)));
    }, [filterConfig]);

    // ── Resize observer ──

    useEffect(() => {
        const el = catalogRef.current;
        if (!el) return;
        const ro = new ResizeObserver((entries) => {
            setCatalogWidth(entries[0].contentRect.width);
        });
        ro.observe(el);
        return () => ro.disconnect();
    }, []);

    // ── Filtered + sorted pool ──

    const pool = useMemo(() => {
        const q = searchQuery.toLowerCase();
        let result = [...delegates];

        if (q) {
            result = result.filter(
                (d) =>
                    d.name.toLowerCase().includes(q) ||
                    d.company.toLowerCase().includes(q) ||
                    d.title.toLowerCase().includes(q),
            );
        }

        for (const [key, vals] of Object.entries(activeFilters)) {
            if (!vals?.length) continue;
            result = result.filter((d) => {
                const v = (d.profile as unknown as Record<string, unknown>)[
                    key
                ];
                if (v == null) return false;
                return Array.isArray(v)
                    ? vals.some((x) => (v as string[]).includes(x))
                    : vals.includes(String(v));
            });
        }

        result.sort((a, b) => {
            const av = getSortVal(a, sortField);
            const bv = getSortVal(b, sortField);
            if (typeof av === "string") {
                return sortDir === "asc"
                    ? av.localeCompare(bv as string)
                    : (bv as string).localeCompare(av);
            }
            return sortDir === "asc"
                ? (av as number) - (bv as number)
                : (bv as number) - (av as number);
        });

        return result;
    }, [delegates, searchQuery, activeFilters, sortField, sortDir]);

    // ── Request lookups ──

    // Requests indexed by the delegate they target (Salesforce id) for O(1)
    // card lookups, and delegates indexed the same way so the drawer can map a
    // request back to its delegate for display. Each just indexes a collection
    // by a field it already has — no cross-id translation.
    const requestByTarget = useMemo(() => {
        const m = new Map<string, MeetingRequest>();
        for (const r of requests) m.set(r.targetId, r);
        return m;
    }, [requests]);

    const delegateBySf = useMemo(() => {
        const m = new Map<string, Attendee>();
        for (const d of delegates) m.set(d.salesforceId, d);
        return m;
    }, [delegates]);

    // ── Handlers ──

    // Load the current company's saved requests. Keyed on the party id (the
    // company Account id for sponsors) so it re-fetches when the identity
    // changes without a reload — e.g. the testing-mode spoof-sponsor switch,
    // where router.refresh() swaps in a new `currentSponsor` prop but doesn't
    // remount this component. Switching between reps of the SAME company keeps
    // the same party id, so the shared request set isn't needlessly refetched.
    // The `active` guard drops a stale in-flight response if it changes again
    // mid-fetch.
    useEffect(() => {
        let active = true;
        fetch("/api/requests")
            .then((r) => (r.ok ? r.json() : { requests: [] }))
            .then((data: { requests?: MeetingRequest[] }) => {
                if (active) setRequests(data.requests ?? []);
            })
            .catch(console.error);
        return () => {
            active = false;
        };
    }, [currentPartyId]);

    // Upsert a request for a delegate. `targetId` is the unique key per company
    // (one request per delegate), so a save replaces any existing entry for that
    // target. New requests show optimistically; the server returns the saved row
    // (with its real id) which then replaces the optimistic one. The requester
    // is derived from the session server-side, so we only send the target id.
    const saveRequest = useCallback(
        async (target: Attendee, rank: number) => {
            const isNew = !requestByTarget.has(target.salesforceId);
            const replaceTarget =
                (req: MeetingRequest) => (prev: MeetingRequest[]) => [
                    ...prev.filter((r) => r.targetId !== target.salesforceId),
                    req,
                ];

            // Optimistic add for brand-new requests (no id until the server
            // responds). Re-ranks are left until the response so an error keeps
            // the prior rank. The requester id is cosmetic here (the server is
            // authoritative and keys by the company party id).
            if (isNew) {
                setRequests(
                    replaceTarget({
                        id: `temp:${target.salesforceId}`,
                        requesterId: partyId(currentSponsor),
                        targetId: target.salesforceId,
                        rank,
                    }),
                );
            }
            try {
                const res = await fetch("/api/requests", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        targetId: target.salesforceId,
                        rank,
                    }),
                });
                if (!res.ok) throw new Error(`save failed: ${res.status}`);
                const { request } = (await res.json()) as {
                    request: MeetingRequest;
                };
                setRequests(replaceTarget(request));
            } catch (err) {
                console.error(err);
                // Roll back only the optimistic new entry; existing rows are
                // untouched above, so there's nothing to restore for re-ranks.
                if (isNew) {
                    setRequests((prev) =>
                        prev.filter((r) => r.targetId !== target.salesforceId),
                    );
                }
            }
        },
        [requestByTarget, currentSponsor],
    );

    // Remove a delegate's request: optimistically drop it, then tell the server.
    const deleteRequest = useCallback(
        (target: Attendee) => {
            if (!requestByTarget.has(target.salesforceId)) return;
            setRequests((prev) =>
                prev.filter((r) => r.targetId !== target.salesforceId),
            );
            fetch("/api/requests", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    targetId: target.salesforceId,
                    delete: true,
                }),
            }).catch(console.error);
        },
        [requestByTarget],
    );

    // Mark a target as just-requested, then clear that flag after 2s so the
    // button re-enables as "Edit request". Re-requesting restarts the timer.
    const markJustRequested = useCallback((targetId: string) => {
        setJustRequestedIds((prev) => new Set(prev).add(targetId));
        const timers = justRequestedTimers.current;
        const existing = timers.get(targetId);
        if (existing) clearTimeout(existing);
        timers.set(
            targetId,
            setTimeout(() => {
                setJustRequestedIds((prev) => {
                    const next = new Set(prev);
                    next.delete(targetId);
                    return next;
                });
                timers.delete(targetId);
            }, 2000),
        );
    }, []);

    // Clear any pending confirmation timers on unmount.
    useEffect(() => {
        const timers = justRequestedTimers.current;
        return () => {
            timers.forEach(clearTimeout);
            timers.clear();
        };
    }, []);

    const handleSelectRank = useCallback(
        (delegate: Attendee, rank: number) => {
            setPickingId(null);
            saveRequest(delegate, rank);
            markJustRequested(delegate.salesforceId);
        },
        [saveRequest, markJustRequested],
    );

    const handleApplyFilter = useCallback(
        (
            id: string,
            val: string,
            checked: boolean,
            type: "single" | "multi",
        ) => {
            setActiveFilters((prev) => {
                if (type === "single") {
                    return { ...prev, [id]: checked ? [val] : [] };
                }
                const current = prev[id] || [];
                return {
                    ...prev,
                    [id]: checked
                        ? [...new Set([...current, val])]
                        : current.filter((v) => v !== val),
                };
            });
        },
        [],
    );

    const handleClearFilters = useCallback(() => {
        setActiveFilters({});
        setSearchQuery("");
    }, []);

    const handleToggleAccordion = useCallback((id: string) => {
        setOpenAccordions((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    }, []);

    const handleSetView = useCallback((mode: ViewMode) => {
        setViewMode(mode);
        setPickingId(null);
    }, []);

    // ── Shared filter panel props ──

    const filterPanelProps = {
        filterConfig,
        activeFilters,
        openAccordions,
        onToggleAccordion: handleToggleAccordion,
        onApplyFilter: handleApplyFilter,
    };

    const totalFilters = Object.values(activeFilters).reduce(
        (s, v) => s + (v?.length || 0),
        0,
    );

    // ── Card action ──

    function renderCardAction(d: Attendee) {
        const req = requestByTarget.get(d.salesforceId);
        const isPicking = pickingId === d.id;

        if (isPicking) {
            return (
                <div className="rank-picker">
                    <div className="rank-picker-label">
                        Select interest level
                    </div>
                    <div className="rank-pips">
                        {[1, 2, 3, 4, 5].map((n) => (
                            <div
                                key={n}
                                className="rank-pip"
                                data-rank={n}
                                onClick={() => handleSelectRank(d, n)}
                            >
                                {n}
                            </div>
                        ))}
                    </div>
                    <button
                        className="rank-pip-cancel"
                        onClick={() => setPickingId(null)}
                    >
                        Cancel
                    </button>
                </div>
            );
        }

        if (req !== undefined) {
            // Locked confirmation for 2s after requesting; then editable.
            if (justRequestedIds.has(d.salesforceId)) {
                return (
                    <button className="requested-btn" disabled>
                        👍 Requested
                    </button>
                );
            }
            return (
                <button className="req-btn" onClick={() => setPickingId(d.id)}>
                    Edit Request
                </button>
            );
        }

        return (
            <button className="req-btn" onClick={() => setPickingId(d.id)}>
                + Request Meeting
            </button>
        );
    }

    // ── Grid view ──

    function renderGrid() {
        if (!pool.length)
            return (
                <div className="no-results">
                    No delegates match your filters.
                </div>
            );
        return (
            <div className="card-grid">
                {pool.map((d) => {
                    const req = requestByTarget.get(d.salesforceId);
                    const p = d.profile;
                    const rc = revClass(p.annualRevenue) || "rev-na";
                    return (
                        <div
                            key={d.id}
                            className={`a-card ${req !== undefined ? "is-requested" : ""}`}
                        >
                            <div className="card-identity">
                                <div className="card-company">{d.company}</div>
                                <div className="card-name">{d.name}</div>
                                <div className="card-title">{d.title}</div>
                            </div>
                            <div className="card-attrs">
                                <div className="card-attr">
                                    <span className="ca-label">Revenue</span>
                                    <span className={`${rc} rev-chip`}>
                                        {str(p.annualRevenue)}
                                    </span>
                                </div>
                                {hasValue(p.budgetaryResponsibility) && (
                                    <div className="card-attr">
                                        <span className="ca-label">
                                            Budget resp.
                                        </span>
                                        <span className="ca-value">
                                            {p.budgetaryResponsibility}
                                        </span>
                                    </div>
                                )}
                                {hasValue(p.plannedSpend) && (
                                    <div className="card-attr">
                                        <span className="ca-label">
                                            Planned spend
                                        </span>
                                        <span className="ca-value">
                                            {p.plannedSpend}
                                        </span>
                                    </div>
                                )}
                                <div className="card-attr">
                                    <span className="ca-label">Co. size</span>
                                    <span className="ca-value">
                                        {str(p.companySize)}
                                    </span>
                                </div>
                            </div>
                            <CardMoreToggle p={p} />
                            <div className="card-action">
                                {renderCardAction(d)}
                            </div>
                        </div>
                    );
                })}
            </div>
        );
    }

    // ── List view ──

    function renderList() {
        if (!pool.length)
            return (
                <div className="no-results">
                    No delegates match your filters.
                </div>
            );
        return (
            <div className="list-wrap">
                <div
                    className="list-view"
                    style={{ "--list-cols": LIST_COLS } as React.CSSProperties}
                >
                    <div
                        className="list-header"
                        style={
                            { "--list-cols": LIST_COLS } as React.CSSProperties
                        }
                    >
                        {LIST_HEADERS.map((h) => (
                            <div key={h} className="list-header-cell">
                                {h}
                            </div>
                        ))}
                    </div>
                    {pool.map((d) => {
                        const req = requestByTarget.get(d.salesforceId);
                        const isPicking = pickingId === d.id;
                        const p = d.profile;
                        const rc = revClass(p.annualRevenue) || "rev-na";

                        let action: React.ReactNode;
                        if (isPicking) {
                            action = (
                                <div className="list-rank-picker">
                                    <span className="list-rank-label">
                                        Rate interest level
                                    </span>
                                    <div className="list-rank-pips">
                                        {[1, 2, 3, 4, 5].map((n) => (
                                            <div
                                                key={n}
                                                className="list-rank-pip"
                                                onClick={() =>
                                                    handleSelectRank(d, n)
                                                }
                                            >
                                                {n}
                                            </div>
                                        ))}
                                    </div>
                                    {/* Cancel on its own line — inside the pip
                                        row it overflowed the narrow name column
                                        and got clipped by .list-cell. */}
                                    <button
                                        className="list-rank-cancel"
                                        onClick={() => setPickingId(null)}
                                    >
                                        Cancel
                                    </button>
                                </div>
                            );
                        } else if (req !== undefined) {
                            // Locked confirmation for 2s, then editable.
                            action = justRequestedIds.has(d.salesforceId) ? (
                                <button className="list-requested-btn" disabled>
                                    👍 Requested
                                </button>
                            ) : (
                                <div className="list-edit-actions">
                                    <button
                                        className="list-req-btn"
                                        onClick={() => setPickingId(d.id)}
                                    >
                                        Edit
                                    </button>
                                    <button
                                        className="list-remove-btn"
                                        onClick={() => deleteRequest(d)}
                                    >
                                        Remove
                                    </button>
                                </div>
                            );
                        } else {
                            action = (
                                <button
                                    className="list-req-btn"
                                    onClick={() => setPickingId(d.id)}
                                >
                                    + Request
                                </button>
                            );
                        }

                        return (
                            <div
                                key={d.id}
                                className={`list-row ${req !== undefined ? "is-requested" : ""}`}
                            >
                                <div className="list-cell">
                                    <div className="lc-name">{d.name}</div>
                                    <div className="lc-title">{d.title}</div>
                                    <div className="list-action-cell">
                                        {action}
                                    </div>
                                </div>
                                <div className="list-cell">
                                    <div className="lc-company">
                                        {d.company}
                                    </div>
                                </div>
                                <div className="list-cell">
                                    <span className={`${rc} rev-chip`}>
                                        {str(p.annualRevenue)}
                                    </span>
                                </div>
                                <div className="list-cell">
                                    <span className="lc-val">
                                        {p.budgetaryResponsibility || "N/A"}
                                    </span>
                                </div>
                                <div className="list-cell">
                                    <span className="lc-val">
                                        {p.plannedSpend || "N/A"}
                                    </span>
                                </div>
                                <div className="list-cell">
                                    <span className="lc-val">
                                        {str(p.companySize)}
                                    </span>
                                </div>
                                <div className="list-cell">
                                    <span className="lc-tags">
                                        {dotTags(p.areasOfSpecialization)}
                                    </span>
                                </div>
                                <div className="list-cell">
                                    <span className="lc-tags">
                                        {dotTags(p.industrySectors)}
                                    </span>
                                </div>
                                <div className="list-cell">
                                    <span className="lc-tags">
                                        {dotTags(p.strategicPriorities)}
                                    </span>
                                </div>
                                <div className="list-cell list-details-cell">
                                    <button
                                        className="list-details-btn"
                                        onClick={() => setDetailsDelegate(d)}
                                    >
                                        More details
                                    </button>
                                </div>
                            </div>
                        );
                    })}
                </div>
            </div>
        );
    }

    // ── Horizontal card view ──

    function renderHCards() {
        if (!pool.length)
            return (
                <div className="no-results">
                    No delegates match your filters.
                </div>
            );
        return (
            <div className="hcard-list">
                {pool.map((d) => {
                    const req = requestByTarget.get(d.salesforceId);
                    const isPicking = pickingId === d.id;
                    const p = d.profile;
                    const rc = revClass(p.annualRevenue) || "rev-na";

                    let action: React.ReactNode;
                    if (isPicking) {
                        action = (
                            <div className="hcard-rank-picker">
                                <span className="hcard-rank-label">
                                    Interest level:
                                </span>
                                <div className="hcard-rank-pips">
                                    {[1, 2, 3, 4, 5].map((n) => (
                                        <div
                                            key={n}
                                            className="hcard-rank-pip"
                                            onClick={() =>
                                                handleSelectRank(d, n)
                                            }
                                        >
                                            {n}
                                        </div>
                                    ))}
                                </div>
                                <button
                                    className="hcard-cancel"
                                    onClick={() => setPickingId(null)}
                                >
                                    Cancel
                                </button>
                            </div>
                        );
                    } else if (req !== undefined) {
                        // Locked confirmation for 2s, then editable.
                        action = justRequestedIds.has(d.salesforceId) ? (
                            <button className="requested-btn" disabled>
                                👍 Requested
                            </button>
                        ) : (
                            <button
                                className="req-btn"
                                onClick={() => setPickingId(d.id)}
                            >
                                Edit Request
                            </button>
                        );
                    } else {
                        action = (
                            <button
                                className="req-btn"
                                onClick={() => setPickingId(d.id)}
                            >
                                + Request Meeting
                            </button>
                        );
                    }

                    return (
                        <div
                            key={d.id}
                            className={`hcard ${req !== undefined ? "is-requested" : ""}`}
                        >
                            <div className="hcard-top">
                                <div className="hcard-identity">
                                    <div className="hcard-company">
                                        {d.company}
                                    </div>
                                    <div className="hcard-name">{d.name}</div>
                                    <div className="hcard-title">{d.title}</div>
                                </div>
                                <span className={`${rc} rev-chip`}>
                                    {str(p.annualRevenue)}
                                </span>
                            </div>
                            <div className="hcard-body-cols">
                                <div className="hcard-left">
                                    {hasValue(p.budgetaryResponsibility) && (
                                        <div className="hcard-attr">
                                            <span className="hca-label">
                                                Budget resp.
                                            </span>
                                            <span className="hca-value">
                                                {p.budgetaryResponsibility}
                                            </span>
                                        </div>
                                    )}
                                    {hasValue(p.plannedSpend) && (
                                        <div className="hcard-attr">
                                            <span className="hca-label">
                                                Planned spend
                                            </span>
                                            <span className="hca-value">
                                                {p.plannedSpend}
                                            </span>
                                        </div>
                                    )}
                                    <div className="hcard-attr">
                                        <span className="hca-label">
                                            Co. size
                                        </span>
                                        <span className="hca-value">
                                            {str(p.companySize)}
                                        </span>
                                    </div>
                                </div>
                                <div className="hcard-right">
                                    <div className="hcard-tag-attr">
                                        <span className="hca-label">
                                            Specialization
                                        </span>
                                        <span className="hca-value">
                                            {dotTags(p.areasOfSpecialization) ||
                                                "N/A"}
                                        </span>
                                    </div>
                                    <div className="hcard-tag-attr">
                                        <span className="hca-label">
                                            Industries
                                        </span>
                                        <span className="hca-value">
                                            {dotTags(p.industrySectors) ||
                                                "N/A"}
                                        </span>
                                    </div>
                                    <div className="hcard-tag-attr">
                                        <span className="hca-label">
                                            Regions
                                        </span>
                                        <span className="hca-value">
                                            {dotTags(p.regionsOverseen) ||
                                                "N/A"}
                                        </span>
                                    </div>
                                    <div className="hcard-tag-attr">
                                        <span className="hca-label">
                                            Priorities
                                        </span>
                                        <span className="hca-value">
                                            {dotTags(p.strategicPriorities) ||
                                                "N/A"}
                                        </span>
                                    </div>
                                </div>
                            </div>
                            <div className="hcard-action">{action}</div>
                        </div>
                    );
                })}
            </div>
        );
    }

    // ── Request drawer content ──

    const drawerEntries = requests
        .map((req) => ({ d: delegateBySf.get(req.targetId), rank: req.rank }))
        .filter((e): e is { d: Attendee; rank: number } => Boolean(e.d))
        .sort((a, b) => b.rank - a.rank);

    const pkgLabel =
        currentSponsor.sponsorTier === "diamond" ? "◆ Diamond" : "● Standard";
    // Counter sits on the solid --blue-deep "My Requests" button, so this needs
    // to read on a dark background. The count is a reference against the package
    // amount, not a limit, so hitting it isn't flagged — full white once any
    // request exists, dimmed when empty.
    const reqCountColor = reqCount > 0 ? "#ffffff" : "rgba(255,255,255,0.7)";

    const showHCards = viewMode === "list" && catalogWidth < LIST_BREAK;

    // ── JSX ──

    return (
        <>
            <TopBar
                user={{
                    name: currentSponsor.name,
                    title: currentSponsor.company || currentSponsor.title,
                }}
                eventLogo={eventLogo}
                actions={
                    <button
                        className={`requests-btn ${reqCount > 0 ? "has-items" : ""}`}
                        onClick={() => setDrawerOpen(true)}
                    >
                        My Requests{" "}
                        <span
                            style={{
                                fontFamily: "var(--mono)",
                                fontSize: "11px",
                                color: reqCountColor,
                            }}
                        >
                            {reqCount}
                        </span>
                    </button>
                }
            />

            {/* Page layout */}
            <div className="page">
                {/* Filter sidebar (desktop) */}
                <aside className="filter-col">
                    <div className="filter-head">
                        <span className="filter-head-title">Filter</span>
                        <button
                            className="filter-clear"
                            onClick={handleClearFilters}
                        >
                            Clear all
                        </button>
                    </div>
                    <FiltersPanel prefix="sidebar" {...filterPanelProps} />
                </aside>

                {/* Catalog column */}
                <div className="catalog-col">
                    <div className="toolbar">
                        <button
                            className={`filter-btn ${totalFilters > 0 ? "has-filters" : ""}`}
                            onClick={() => setFilterDrawerOpen(true)}
                        >
                            ⚙ Filter
                            {totalFilters > 0 && (
                                <span className="filter-btn-badge">
                                    {totalFilters}
                                </span>
                            )}
                        </button>
                        <div className="search-wrap">
                            <span className="search-icon">⌕</span>
                            <input
                                className="search-input"
                                type="text"
                                placeholder="Search name, company, title…"
                                value={searchQuery}
                                onChange={(e) => setSearchQuery(e.target.value)}
                            />
                        </div>
                        <div className="sort-wrap">
                            <span className="sort-label">Sort</span>
                            <select
                                className="sort-select"
                                value={sortField}
                                onChange={(e) => setSortField(e.target.value)}
                            >
                                <option value="company">Company</option>
                                <option value="name">Name</option>
                                <option value="title">Title</option>
                                <option value="annualRevenue">
                                    Annual Revenue
                                </option>
                                <option value="budgetaryResponsibility">
                                    Budgetary Resp.
                                </option>
                                <option value="plannedSpend">
                                    Planned Spend
                                </option>
                                <option value="companySize">
                                    Company Size
                                </option>
                            </select>
                            <button
                                className="sort-dir-btn"
                                onClick={() =>
                                    setSortDir((d) =>
                                        d === "asc" ? "desc" : "asc",
                                    )
                                }
                            >
                                {sortDir === "asc" ? "↑" : "↓"}
                            </button>
                        </div>
                        <div className="view-toggle">
                            <button
                                className={`view-btn ${viewMode === "grid" ? "active" : ""}`}
                                onClick={() => handleSetView("grid")}
                                title="Grid view"
                            >
                                ⊞
                            </button>
                            <button
                                className={`view-btn ${viewMode === "list" ? "active" : ""}`}
                                onClick={() => handleSetView("list")}
                                title="List view"
                            >
                                ☰
                            </button>
                        </div>
                        <span className="result-count">
                            {pool.length} delegate{pool.length !== 1 ? "s" : ""}
                        </span>
                    </div>

                    {reachedPackage && (
                        <div className="info-banner">
                            <span className="info-banner-icon">✓</span>
                            <span>
                                You&apos;ve made enough requests to meet your
                                package amount. Keep adding requests so we can
                                provide you the best match based on delegate
                                availability.
                            </span>
                        </div>
                    )}

                    <div ref={catalogRef}>
                        {viewMode === "grid" && renderGrid()}
                        {viewMode === "list" &&
                            (showHCards ? renderHCards() : renderList())}
                    </div>
                </div>
            </div>

            {/* Mobile filter drawer */}
            <div
                className={`filter-overlay ${filterDrawerOpen ? "open" : ""}`}
                onClick={() => setFilterDrawerOpen(false)}
            />
            <div className={`filter-drawer ${filterDrawerOpen ? "open" : ""}`}>
                <div className="filter-drawer-head">
                    <span className="filter-drawer-title">Filter</span>
                    <div
                        style={{
                            display: "flex",
                            alignItems: "center",
                            gap: "8px",
                        }}
                    >
                        <button
                            className="filter-clear"
                            style={{ fontSize: "12px" }}
                            onClick={handleClearFilters}
                        >
                            Clear all
                        </button>
                        <button
                            className="filter-drawer-close"
                            onClick={() => setFilterDrawerOpen(false)}
                        >
                            ✕
                        </button>
                    </div>
                </div>
                <FiltersPanel prefix="drawer" {...filterPanelProps} />
            </div>

            {/* Request drawer */}
            <div
                className={`overlay ${drawerOpen ? "open" : ""}`}
                onClick={() => setDrawerOpen(false)}
            />
            <div className={`drawer ${drawerOpen ? "open" : ""}`}>
                <div className="drawer-head">
                    <span className="drawer-title">My Requests</span>
                    <button
                        className="drawer-close"
                        onClick={() => setDrawerOpen(false)}
                    >
                        ✕
                    </button>
                </div>
                <div className="drawer-notice">
                    <strong>Requests are saved automatically.</strong> You can
                    edit interest levels or remove requests at any time before
                    the window closes.
                </div>
                <div className="drawer-body">
                    <div className="pkg-bar">
                        <span
                            className={`pkg-label ${currentSponsor.sponsorTier === "diamond" ? "pkg-label-diamond" : ""}`}
                        >
                            {pkgLabel} package
                        </span>
                        {/* The package amount is a reference, not a cap: show
                            the contracted meeting count and make clear requests
                            themselves are unlimited. */}
                        <span className="pkg-val pkg-ok">
                            {maxMeetings} meetings, unlimited requests
                        </span>
                    </div>
                    {drawerEntries.length === 0 ? (
                        <div className="drawer-empty">
                            <div className="drawer-empty-icon">○</div>
                            <div
                                style={{
                                    fontSize: "13px",
                                    fontWeight: 500,
                                    marginBottom: "6px",
                                }}
                            >
                                No requests yet
                            </div>
                            <div style={{ fontSize: "12px" }}>
                                Click &quot;+ Request Meeting&quot; on any
                                delegate to get started.
                            </div>
                        </div>
                    ) : (
                        drawerEntries.map(({ d, rank }) => (
                            <DrawerItem
                                key={d.id}
                                d={d}
                                rank={rank}
                                onRank={saveRequest}
                                onRemove={deleteRequest}
                            />
                        ))
                    )}
                </div>
            </div>

            {/* Delegate "More details" modal (list view) */}
            {detailsDelegate && (
                <DetailsModal
                    d={detailsDelegate}
                    onClose={() => setDetailsDelegate(null)}
                >
                    <RequestActions
                        d={detailsDelegate}
                        req={requestByTarget.get(detailsDelegate.salesforceId)}
                        isPicking={pickingId === detailsDelegate.id}
                        justRequested={justRequestedIds.has(
                            detailsDelegate.salesforceId,
                        )}
                        onStartPick={(x) => setPickingId(x.id)}
                        onCancelPick={() => setPickingId(null)}
                        onSelectRank={handleSelectRank}
                        onRemove={deleteRequest}
                    />
                </DetailsModal>
            )}
        </>
    );
}
