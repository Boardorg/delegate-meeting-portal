"use client";

import "@/app/frontend.css";
import { useState, useMemo, useRef, useEffect, useCallback } from "react";
import { contractedMeetings } from "@/lib/attendees/caps";
import { Attendee, AttendeeProfile, MeetingRequest } from "@/types";
import TopBar from "@/app/components/TopBar";

// ── Constants ──────────────────────────────────────────────────────────────

const REV_TIERS = [
    "<10M",
    "10M-50M",
    "50M-100M",
    "100M-500M",
    "500M-1B",
    "1B-5B",
    ">5B",
];

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
const LIST_COLS = "140px 110px 72px 82px 72px 68px 1fr 1fr 1fr 1fr";
const LIST_HEADERS = [
    "Name / Title",
    "Company",
    "Revenue",
    "Budget Resp.",
    "Planned Spend",
    "Co. Size",
    "Specialization",
    "Industries",
    "Regions",
    "Priorities",
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
}

// ── Pure helpers ───────────────────────────────────────────────────────────

function revClass(val: string | number | null | undefined): string {
    if (!val) return "";
    const i = REV_TIERS.indexOf(String(val));
    return i >= 0 ? `rev-${i + 1}` : "";
}

function getSortVal(d: Attendee, field: string): string | number {
    if (field === "name") return d.name.toLowerCase();
    if (field === "title") return d.title.toLowerCase();
    if (field === "company") return d.company.toLowerCase();
    const v = (d.profile as unknown as Record<string, unknown>)[field];
    if (v == null) return -1;
    const ord = SORT_ORDER[field];
    return ord ? ord.indexOf(String(v)) : -1;
}

function dotTags(arr: string[] | null | undefined): string {
    return (arr || []).join(" · ");
}

function str(v: unknown): string {
    return v != null ? String(v) : "N/A";
}

/** Returns true if a scalar profile value should be shown on a card. */
function hasValue(v: unknown): boolean {
    return v != null && v !== "";
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

export default function SponsorCatalog({ delegates, currentSponsor }: Props) {
    // This sponsor's saved requests. Each links to its delegate via targetId
    // (a Salesforce id), so the catalog never translates between id spaces.
    const [requests, setRequests] = useState<MeetingRequest[]>([]);
    const [pickingId, setPickingId] = useState<string | null>(null);
    const [activeFilters, setActiveFilters] = useState<
        Record<string, string[]>
    >({});
    const [viewMode, setViewMode] = useState<ViewMode>("grid");
    const [sortField, setSortField] = useState("company");
    const [sortDir, setSortDir] = useState<SortDir>("asc");
    const [searchQuery, setSearchQuery] = useState("");
    const [drawerOpen, setDrawerOpen] = useState(false);
    const [filterDrawerOpen, setFilterDrawerOpen] = useState(false);
    const [openAccordions, setOpenAccordions] = useState<Set<string>>(
        new Set(),
    );
    const [catalogWidth, setCatalogWidth] = useState(999);
    const catalogRef = useRef<HTMLDivElement>(null);

    const maxMeetings = contractedMeetings(currentSponsor.sponsorTier);
    const reqCount = requests.length;
    const atCap = reqCount >= maxMeetings;

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

    // Load the current sponsor's saved requests. Keyed on the sponsor id so it
    // re-fetches when the identity changes without a reload — e.g. the
    // testing-mode spoof-sponsor switch, where router.refresh() swaps in a new
    // `currentSponsor` prop but doesn't remount this component. The `active`
    // guard drops a stale in-flight response if the sponsor changes again mid-fetch.
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
    }, [currentSponsor.salesforceId]);

    // Upsert a request for a delegate. `targetId` is the unique key per sponsor
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
            // the prior rank.
            if (isNew) {
                setRequests(
                    replaceTarget({
                        id: `temp:${target.salesforceId}`,
                        requesterId: currentSponsor.salesforceId,
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
                        prev.filter(
                            (r) => r.targetId !== target.salesforceId,
                        ),
                    );
                }
            }
        },
        [requestByTarget, currentSponsor.salesforceId],
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

    const handleSelectRank = useCallback(
        (delegate: Attendee, rank: number) => {
            setPickingId(null);
            saveRequest(delegate, rank);
        },
        [saveRequest],
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

        if (req !== undefined && !isPicking) {
            return (
                <button className="requested-btn" disabled>
                    👍 Requested
                </button>
            );
        }

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
                    const capped = atCap && req === undefined;
                    const p = d.profile;
                    const rc = revClass(p.annualRevenue) || "rev-na";
                    return (
                        <div
                            key={d.id}
                            className={`a-card ${req !== undefined ? "is-requested" : ""} ${capped ? "is-capped" : ""}`}
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
                        const capped = atCap && req === undefined;
                        const p = d.profile;
                        const rc = revClass(p.annualRevenue) || "rev-na";

                        let action: React.ReactNode;
                        if (req !== undefined && !isPicking) {
                            action = (
                                <button className="list-requested-btn" disabled>
                                    👍 Requested
                                </button>
                            );
                        } else if (isPicking) {
                            action = (
                                <div className="list-rank-picker">
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
                                    <button
                                        className="list-rank-cancel"
                                        onClick={() => setPickingId(null)}
                                    >
                                        ✕
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
                                className={`list-row ${req !== undefined ? "is-requested" : ""} ${capped ? "is-capped" : ""}`}
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
                                        {dotTags(p.regionsOverseen)}
                                    </span>
                                </div>
                                <div className="list-cell">
                                    <span className="lc-tags">
                                        {dotTags(p.strategicPriorities)}
                                    </span>
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
                    const capped = atCap && req === undefined;
                    const p = d.profile;
                    const rc = revClass(p.annualRevenue) || "rev-na";

                    let action: React.ReactNode;
                    if (req !== undefined && !isPicking) {
                        action = (
                            <button className="requested-btn" disabled>
                                👍 Requested
                            </button>
                        );
                    } else if (isPicking) {
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
                            className={`hcard ${req !== undefined ? "is-requested" : ""} ${capped ? "is-capped" : ""}`}
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
    // Counter sits on the solid --blue-deep "My Requests" button, so these
    // need to read on a dark background rather than the light --red/--t2 tones
    // used elsewhere.
    const reqCountColor =
        reqCount >= maxMeetings
            ? "#ffb3ae"
            : reqCount > 0
              ? "#ffffff"
              : "rgba(255,255,255,0.7)";

    const showHCards = viewMode === "list" && catalogWidth < LIST_BREAK;

    // ── JSX ──

    return (
        <>
            <TopBar
                user={{
                    name: currentSponsor.name,
                    title: currentSponsor.title,
                }}
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
                            {reqCount}/{maxMeetings}
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

                    {atCap && (
                        <div className="cap-banner">
                            <span className="cap-banner-icon">⚠</span>
                            <span>
                                You&apos;ve reached your limit of {maxMeetings}{" "}
                                meeting requests. Remove a request to add a new
                                one.
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
                        <span
                            className={`pkg-val ${drawerEntries.length >= maxMeetings ? "pkg-full" : "pkg-ok"}`}
                        >
                            {drawerEntries.length} / {maxMeetings} meetings
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
        </>
    );
}
