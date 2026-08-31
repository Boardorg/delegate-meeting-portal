import path from "path";
import { cache } from "react";
import { loadMockData } from "@/lib/scheduling/loader";
import {
    formatRevenue,
    formatCompanySize,
    formatIndustrySectors,
} from "@/lib/attendees/formatProfile";
import {
    getMeetingDataByEvent,
    describeAttendeePicklistFields,
    getEventAttendeeForms,
    type AttendeePicklistFieldDef,
    type AttendeeFormRecord,
} from "@/lib/salesforce/client";
import { meetingDataToAttendees } from "@/lib/salesforce/attendeeMapper";
import { getEventCode } from "@/lib/helpers/getEventCode";
import { getEventAttendees } from "@/lib/cvent/client";
import { isTestingMode } from "@/lib/helpers/testingMode";
import { Attendee } from "@/types";
import {
    buildFormFields,
    coreKeyForLabel,
    CORE_FIELD_KEYS,
    INDUSTRIES_KEY,
    type AttendeeFormField,
    type AttendeeFieldMeta,
    type CoreFieldKey,
} from "@/lib/attendees/formFields";

// In TESTING_MODE, Cvent email addresses are obfuscated so real contacts can't
// receive real communications on non-prod events. Two schemes are recognized,
// both case-insensitive:
//   - wrapped:  "xxmary@site.comxx"  (an "xx" marker on both ends)
//   - suffixed: "mary@site.comx"     (a single trailing "x")
// We strip whichever is present before matching against Salesforce.
const EMAIL_SAFE_WRAP = "xx";
const EMAIL_SAFE_SUFFIX = "x";

/**
 * Normalizes a Cvent contact email for matching against Salesforce: lowercased,
 * and (in TESTING_MODE) with obfuscation stripped so "xxmary@site.comxx" or
 * "mary@site.comx" both match Salesforce's "mary@site.com".
 *
 * @param {string} email - The raw Cvent contact email.
 * @returns {string} The comparison key.
 */
function normalizeCventEmail(email: string): string {
    const lower = email.trim().toLowerCase();
    if (!isTestingMode()) return lower;

    // Wrapped scheme: only unwrap when the marker is present on both ends, so a
    // stray un-obfuscated address still compares correctly. Checked first, since
    // a wrapped address also ends in "x" and would be mis-stripped by the
    // suffix rule below.
    if (
        lower.startsWith(EMAIL_SAFE_WRAP) &&
        lower.endsWith(EMAIL_SAFE_WRAP) &&
        lower.length > EMAIL_SAFE_WRAP.length * 2
    ) {
        return lower.slice(
            EMAIL_SAFE_WRAP.length,
            lower.length - EMAIL_SAFE_WRAP.length,
        );
    }

    // Suffixed scheme: a single trailing "x".
    if (
        lower.endsWith(EMAIL_SAFE_SUFFIX) &&
        lower.length > EMAIL_SAFE_SUFFIX.length
    ) {
        return lower.slice(0, lower.length - EMAIL_SAFE_SUFFIX.length);
    }

    return lower;
}

// ---------------------------------------------------------------------------
// Intake-form join
// ---------------------------------------------------------------------------

/**
 * Fetches the event's intake-form picklist fields and merges each delegate's
 * answers onto their Attendee (matched by Contact email). The Account-derived
 * Industries field set by the mapper is preserved. On any Salesforce failure
 * the attendees are returned unchanged (Industries-only), never dropped.
 *
 * @param {Attendee[]} attendees - Attendees from the meeting-data pull.
 * @param {string} eventCode - The event whose form answers to pull.
 * @returns {Promise<Attendee[]>} Attendees with intake-form fields merged in.
 */
async function attachFormFields(
    attendees: Attendee[],
    eventCode: string,
): Promise<Attendee[]> {
    let defs: AttendeePicklistFieldDef[] = [];
    const byEmail = new Map<string, AttendeeFormRecord>();
    try {
        defs = await describeAttendeePicklistFields();
        const forms = await getEventAttendeeForms(
            eventCode,
            defs.map((d) => d.name),
        );
        for (const f of forms) if (f.email) byEmail.set(f.email, f);
    } catch (err) {
        console.warn(
            `loadAttendees: intake-form pull failed for "${eventCode}" — ` +
                `delegate cards fall back to Industries only. ` +
                `${err instanceof Error ? err.message : String(err)}`,
        );
        return attendees;
    }

    return attendees.map((a) => {
        if (a.role !== "delegate") return a;
        const form = byEmail.get(a.email.toLowerCase());
        const fromForm = buildFormFields(defs, form?.fields ?? {});
        return fromForm.length
            ? { ...a, formFields: [...a.formFields, ...fromForm] }
            : a;
    });
}

// ---------------------------------------------------------------------------
// Field metadata (labels, multi-ness, and value order) for the browse UI
// ---------------------------------------------------------------------------

/** Orders field meta: core columns first (in display order), then the rest by label. */
function sortFieldMeta(meta: AttendeeFieldMeta[]): AttendeeFieldMeta[] {
    const coreIndex = (key: string): number => {
        const i = CORE_FIELD_KEYS.indexOf(key as CoreFieldKey);
        return i < 0 ? Number.MAX_SAFE_INTEGER : i;
    };
    return [...meta].sort((a, b) => {
        const ca = coreIndex(a.key);
        const cb = coreIndex(b.key);
        return ca !== cb ? ca - cb : a.label.localeCompare(b.label);
    });
}

/** Turns described picklist fields into browse-UI field metadata (+ Industries). */
function defsToFieldMeta(defs: AttendeePicklistFieldDef[]): AttendeeFieldMeta[] {
    const meta: AttendeeFieldMeta[] = defs.map((d) => {
        const coreKey = coreKeyForLabel(d.label);
        return {
            key: coreKey ?? d.name,
            label: d.label,
            multi: d.multi,
            order: d.values,
        };
    });
    // Industries is Account-derived (not on CventEvents__Attendee__c). Its order
    // isn't a fixed picklist, so leave it empty — the frontend falls back to the
    // observed unique values (alphabetical) for empty-order fields.
    meta.push({ key: INDUSTRIES_KEY, label: "Industries", multi: true, order: [] });
    return sortFieldMeta(meta);
}

// ---------------------------------------------------------------------------
// Mock-mode support: map the legacy fixed profile → dynamic formFields so the
// USE_MOCK catalog still renders. Best-effort — the old mock JSON predates the
// intake-form model, so these are stand-ins, not real form answers.
// ---------------------------------------------------------------------------

/** The legacy fixed-profile shape still present in data/mock/attendees.json. */
type LegacyMockProfile = {
    annualRevenue: number | string | null;
    budgetaryResponsibility: string | null;
    areasOfSpecialization: string[];
    industrySectors: string[];
    plannedSpend: string | null;
    companySize: number | string | null;
    regionsOverseen: string[];
    strategicPriorities: string[];
};

/** A mock attendee as parsed from JSON: carries the legacy `profile`, not `formFields`. */
type LegacyMockAttendee = Omit<Attendee, "formFields"> & {
    profile?: LegacyMockProfile;
};

/** Maps a legacy mock profile to dynamic formFields (core columns + one extra). */
function mockProfileToFormFields(p?: LegacyMockProfile): AttendeeFormField[] {
    if (!p) return [];
    const out: AttendeeFormField[] = [];
    const single = (key: string, label: string, val: string | null) => {
        if (val != null && val !== "")
            out.push({ key, label, values: [val], multi: false, core: true });
    };
    const multi = (
        key: string,
        label: string,
        vals: string[],
        core: boolean,
    ) => {
        const values = (vals ?? []).filter(Boolean);
        if (values.length) out.push({ key, label, values, multi: true, core });
    };

    single("annualRevenue", "Annual Revenue", formatRevenue(p.annualRevenue));
    single("companySize", "Company Size", formatCompanySize(p.companySize));
    single("budgetResponsibility", "Budget Responsibility", p.budgetaryResponsibility);
    single("plannedInvestment", "Planned Investment", p.plannedSpend);
    multi("systemsAndPlatforms", "Systems and Platforms", p.areasOfSpecialization, true);
    multi("currentFocusTopics", "Current Focus Topics", p.strategicPriorities, true);
    multi(INDUSTRIES_KEY, "Industries", formatIndustrySectors(p.industrySectors), true);
    // A non-core field so the modal + superset filters have an example beyond core.
    multi("regionsOverseen", "Regions Overseen", p.regionsOverseen, false);
    return out;
}

/** Field metadata for mock mode, mirroring mockProfileToFormFields' fields. */
const MOCK_FIELD_META: AttendeeFieldMeta[] = sortFieldMeta([
    { key: "annualRevenue", label: "Annual Revenue", multi: false, order: ["<10M", "10M-50M", "50M-100M", "100M-500M", "500M-1B", "1B-5B", ">5B"] },
    { key: "budgetResponsibility", label: "Budget Responsibility", multi: false, order: ["<1M", "1M-10M", "10M-50M", "50M-100M", "100M-500M", "500M-1B", ">1B"] },
    { key: "plannedInvestment", label: "Planned Investment", multi: false, order: ["<1M", "1M-5M", "5M-25M", "25M-100M", ">100M"] },
    { key: "companySize", label: "Company Size", multi: false, order: ["1-50", "51-200", "200-500", "500-1000", "1000-5000", ">5000"] },
    { key: "systemsAndPlatforms", label: "Systems and Platforms", multi: true, order: [] },
    { key: "currentFocusTopics", label: "Current Focus Topics", multi: true, order: [] },
    { key: INDUSTRIES_KEY, label: "Industries", multi: true, order: [] },
    { key: "regionsOverseen", label: "Regions Overseen", multi: true, order: [] },
]);

// ---------------------------------------------------------------------------
// Public loaders
// ---------------------------------------------------------------------------

/**
 * Loads the full attendee list (delegates + sponsors) for the event, with each
 * delegate's browse `formFields` populated (Account-derived Industries + the
 * intake-form picklist answers).
 *
 * Data source is controlled by the USE_MOCK env var:
 *   - `true`: reads data/mock/attendees.json (legacy profile mapped to formFields)
 *   - anything else: Salesforce, using `eventCode` when provided (the login flow,
 *     which has no session yet), otherwise getEventCode() (env var → session).
 *
 * @param {boolean} [mock] - Force the mock JSON source.
 * @param {string} [eventCode] - Explicit event code override for the SF query.
 */
export async function loadAttendees(
    mock: boolean = false,
    eventCode?: string,
): Promise<Attendee[]> {
    const useMock = process.env.USE_MOCK === "true" || mock;
    const resolvedEventCode = useMock
        ? ""
        : (eventCode ?? (await getEventCode()));
    return loadAttendeesCached(useMock, resolvedEventCode);
}

/**
 * Request-memoized core of {@link loadAttendees}, keyed on the already-resolved
 * (useMock, eventCode) so multiple callers in one render share a single
 * Salesforce + Cvent round-trip.
 *
 * NOTE: React's `cache` hands every caller the *same* array instance within a
 * request. Treat the result as read-only — filter/map to derive, never sort or
 * splice it in place, or you'll corrupt other callers' view.
 *
 * @param {boolean} useMock - Whether to read the mock JSON source.
 * @param {string} eventCode - Resolved event code ("" in mock mode).
 * @returns {Promise<Attendee[]>} The attendee list with formFields populated.
 */
const loadAttendeesCached = cache(
    async (useMock: boolean, eventCode: string): Promise<Attendee[]> => {
        // Mock: map the legacy fixed profile in the JSON to dynamic formFields.
        if (useMock) {
            const base = path.join(process.cwd(), "data", "mock");
            const raw = (await loadMockData(
                path.join(base, "attendees.json"),
            )) as unknown as LegacyMockAttendee[];
            return raw.map((a) => {
                const { profile, ...rest } = a;
                return {
                    ...(rest as Omit<Attendee, "formFields">),
                    formFields:
                        a.role === "delegate"
                            ? mockProfileToFormFields(profile)
                            : [],
                } as Attendee;
            });
        }

        // Live: meeting-data pull → base attendees (with Account Industries).
        const data = await getMeetingDataByEvent(eventCode);
        let attendees = meetingDataToAttendees(data, false);

        // Cross-check against Cvent: keep only attendees who also exist in Cvent
        // for this event (matched by email), and enrich each with its real Cvent
        // contact id (needed to push appointments). Cvent presence is required —
        // if the lookup can't run (no Cvent Event ID, or the API fails), return
        // no attendees rather than exposing/scheduling people we can't push.
        let cventAttendees;
        try {
            cventAttendees = await getEventAttendees(eventCode);
        } catch (err) {
            console.warn(
                `loadAttendees: Cvent attendee lookup failed for "${eventCode}" — ` +
                    `returning no attendees. ${err instanceof Error ? err.message : String(err)}`,
            );
            return [];
        }

        const cventAttendeesNormalized = cventAttendees.map((c) => ({
            email: normalizeCventEmail(c.email),
            contactId: c.contactId,
        }));

        attendees = attendees
            .filter(
                (a) =>
                    a.email &&
                    cventAttendeesNormalized.find(
                        (c) => c.email === a.email.toLowerCase(),
                    ),
            )
            .map((a) => ({
                ...a,
                cventContactId:
                    cventAttendeesNormalized.find(
                        (c) => c.email === a.email.toLowerCase(),
                    )?.contactId ?? "",
            }));

        // Merge each delegate's intake-form picklist answers onto their record.
        return attachFormFields(attendees, eventCode);
    },
);

/**
 * Loads the browse-UI field metadata (labels, multi-ness, and value order) for
 * the event: one entry per qualifying intake-form picklist field, plus the
 * Account-derived Industries field. Drives the sidebar filter list, filter
 * option order, and core-field sort order. Request-memoized like loadAttendees.
 *
 * @param {string} [eventCode] - Explicit event code override for the SF describe.
 * @returns {Promise<AttendeeFieldMeta[]>} Field metadata, core columns first.
 */
export async function loadAttendeeFieldMeta(
    eventCode?: string,
): Promise<AttendeeFieldMeta[]> {
    const useMock = process.env.USE_MOCK === "true";
    const resolvedEventCode = useMock
        ? ""
        : (eventCode ?? (await getEventCode()));
    return loadAttendeeFieldMetaCached(useMock, resolvedEventCode);
}

const loadAttendeeFieldMetaCached = cache(
    async (
        useMock: boolean,
        eventCode: string,
    ): Promise<AttendeeFieldMeta[]> => {
        if (useMock) return MOCK_FIELD_META;
        try {
            return defsToFieldMeta(await describeAttendeePicklistFields());
        } catch (err) {
            console.warn(
                `loadAttendeeFieldMeta: describe failed for "${eventCode}" — ` +
                    `filters fall back to Industries only. ` +
                    `${err instanceof Error ? err.message : String(err)}`,
            );
            return [
                { key: INDUSTRIES_KEY, label: "Industries", multi: true, order: [] },
            ];
        }
    },
);
