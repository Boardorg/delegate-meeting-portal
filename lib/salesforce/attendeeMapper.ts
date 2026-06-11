import type {
    Attendee,
    AttendeeProfile,
    AttendeeRole,
    AttendeeSlot,
    SponsorTier,
} from "@/types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Loose shape of the subset of a meeting-data Salesforce record we read.
 *
 * Every field is optional so the SOQL field list can change without breaking
 * the mapper at the type level — individual mappers handle null/missing
 * values defensively.
 */
export type MeetingDataRecord = {
    Id?: string;
    Attendee_Type__c?: unknown;
    Delegate__r?: {
        FirstName?: string | null;
        LastName?: string | null;
        Title?: string | null;
        Email?: string | null;
        Phone?: string | null;
        Account?: {
            Name?: string | null;
            Website?: string | null;
            Industry_Category__c?: string | null;
            AnnualRevenue?: number | string | null;
            NumberOfEmployees?: number | string | null;
        } | null;
        Dietary_Requirements__c?: string | null;
        Dietary_Restrictions__c?: string | null;
        Special_Accommodations__c?: string | null;
    } | null;
    Registration__r?: {
        Name?: string | null;
        StageName?: string | null;
        Discount_Code__c?: string | null;
        Sponsorship_Package__c?: string | null;
        RecordType?: { Name?: string | null } | null;
    } | null;
    [key: string]: unknown;
};

/**
 * Per-record context threaded through every field mapper. Lets a mapper know
 * the role it's building, its position in the input list, and whether
 * placeholder data is enabled.
 */
export type MappingContext = {
    role: AttendeeRole;
    /** 0-based position within its role group. Used to generate stable placeholder ids. */
    index: number;
    /** When true, fields with no real SF source get generated placeholder data. */
    usePlaceholders: boolean;
};

// ---------------------------------------------------------------------------
// Placeholder generators — only invoked when ctx.usePlaceholders is true.
// ---------------------------------------------------------------------------

/**
 * Builds a stable placeholder id of the form `d1`, `s3`, … from the role +
 * 0-based index. Matches the id convention used in data/mock/attendees.json.
 *
 * @param {MappingContext} ctx - Mapping context carrying role and index.
 * @returns {string} The placeholder id.
 */
function placeholderId(ctx: MappingContext): string {
    return `${ctx.role === "sponsor" ? "s" : "d"}${ctx.index + 1}`;
}

/**
 * Generates a deterministic set of placeholder slots for one attendee:
 * sponsors get 7 day-1 slots; delegates get 7 day-1 + 2 day-2. Slot times are
 * 20 minutes apart starting at 09:00 UTC on the event days, matching
 * data/mock/attendees.json so the scheduling engine sees a familiar shape.
 *
 * @param {AttendeeRole} role - Role of the attendee receiving slots.
 * @param {string} id - The attendee id used to build unique `slotId`s.
 * @returns {AttendeeSlot[]} The generated slot list.
 */
function placeholderSlots(role: AttendeeRole, id: string): AttendeeSlot[] {
    // Local helper that builds a fixed-count list of slots for one day.
    const make = (day: 1 | 2, count: number): AttendeeSlot[] => {
        // Day 1 and Day 2 are consecutive calendar dates; adjust here if the
        // event's real dates change or become parameterized.
        const dateBase = day === 1 ? "2026-10-14" : "2026-10-15";

        return Array.from({ length: count }, (_, i) => {
            // Slots are 30 minutes apart, each 20 minutes long (10-min gap).
            const startHour = 9 + Math.floor((i * 30) / 60);
            const startMin = (i * 30) % 60;
            const endMin = startMin + 20;
            const pad = (n: number) => String(n).padStart(2, "0");

            // Roll over to the next hour when 20-minute window crosses :60.
            const endHour = endMin >= 60 ? startHour + 1 : startHour;
            return {
                slotId: `${id}-d${day}-${pad(i + 1)}`,
                day,
                startTime: `${dateBase}T${pad(startHour)}:${pad(startMin)}:00Z`,
                endTime: `${dateBase}T${pad(endHour)}:${pad(endMin % 60)}:00Z`,
                status: "available" as const,
            };
        });
    };

    // Sponsors only need day-1 slots; delegates get both days.
    return role === "sponsor" ? make(1, 7) : [...make(1, 7), ...make(2, 2)];
}

// ---------------------------------------------------------------------------
// Field mappers — one self-contained function per Attendee field.
//
// To change how a field is derived, edit its function. To add a new field,
// add a key here (TypeScript enforces that every Attendee field is present).
// Each mapper decides internally whether to use a real SF value or, when
// ctx.usePlaceholders is on, a generated placeholder.
// ---------------------------------------------------------------------------

/**
 * Function signature for a single Attendee-field mapper: given a raw SF record
 * and context, return the value for one specific Attendee field.
 */
type FieldMapper<K extends keyof Attendee> = (
    record: MeetingDataRecord,
    ctx: MappingContext,
) => Attendee[K];

/**
 * Mapper object shape. The mapped type forces a mapper to exist for every
 * Attendee key, so adding a new Attendee field is caught at compile time.
 */
type AttendeeFieldMappers = { [K in keyof Attendee]: FieldMapper<K> };

/**
 * Maps the SF record's nested Account fields into the Attendee `profile`
 * sub-object. Only `industrySectors` has a clean SF source today; the
 * bucketed string fields the UI expects need derivation rules and currently
 * default to null/empty.
 *
 * @param {MeetingDataRecord} record - The raw SF record.
 * @returns {AttendeeProfile} The mapped profile.
 */
const profileMapper: FieldMapper<"profile"> = (record): AttendeeProfile => {
    // Pull the joined Account once; many profile fields read from it.
    const account = record.Delegate__r?.Account ?? null;
    const industry = account?.Industry_Category__c ?? null;

    // Only industrySectors has a clean SF source today. The remaining profile
    // fields are bucketed strings the UI expects; we have no mapping yet, so
    // they default. Add derivation logic here as sources are identified.
    return {
        annualRevenue: account?.AnnualRevenue ?? null,
        budgetaryResponsibility: null,
        areasOfSpecialization: [],
        industrySectors: industry ? [industry] : [],
        plannedSpend: null,
        companySize: account?.NumberOfEmployees ?? null,
        regionsOverseen: [],
        strategicPriorities: [],
    };
};

/**
 * Per-field resolvers. Each function reads one Attendee field from the SF
 * record (or, for placeholder-only fields, generates one when the flag is on).
 */
export const attendeeFieldMappers: AttendeeFieldMappers = {
    // App-level id. Use a generated short id with placeholders on; otherwise
    // fall back to the Salesforce record Id, which is always unique.
    id: (record, ctx) =>
        ctx.usePlaceholders ? placeholderId(ctx) : String(record.Id ?? ""),

    // Cvent contact UUID; no SF source today. Fabricate when placeholders on.
    cventContactId: (_record, ctx) =>
        ctx.usePlaceholders ? `cvent-${placeholderId(ctx)}-uuid` : "",

    // Attendee__c.Id from Salesforce. Coerced to string for safety.
    salesforceId: (record) => String(record.Id ?? ""),

    // Combine first + last into a single display name.
    name: (record) => {
        const first = record.Delegate__r?.FirstName ?? "";
        const last = record.Delegate__r?.LastName ?? "";
        return `${first} ${last}`.trim();
    },

    // Direct passthrough from the joined Contact.
    email: (record) => record.Delegate__r?.Email ?? "",

    // Contact.Phone. Used to match the SMS-login phone to an attendee record
    // when the user isn't in the local users table (see lib/auth/identity.ts).
    phone: (record) => record.Delegate__r?.Phone ?? "",

    // Role isn't on the SF record itself; it's tagged by the caller via ctx
    // based on which sub-list (delegates vs sponsors) the record came from.
    role: (_record, ctx) => ctx.role,

    // Account.Name on the joined Contact.
    company: (record) => record.Delegate__r?.Account?.Name ?? "",

    // Contact.Title.
    title: (record) => record.Delegate__r?.Title ?? "",

    // Maps the Opportunity's Sponsorship_Package__c label into the strict
    // SponsorTier union. Anything containing "diamond" becomes diamond;
    // any other non-empty label becomes standard; missing → null.
    sponsorTier: (record) => {
        const packageLabel = record.Registration__r?.Sponsorship_Package__c;
        let packageType: SponsorTier = null;
        if (typeof packageLabel == "string") {
            packageLabel.includes("diamond")
                ? (packageType = "diamond")
                : (packageType = "standard");
        }
        return packageType;
    },

    // Delegated to profileMapper to keep this object readable.
    profile: profileMapper,

    // Scheduling has no SF source — when placeholders are on we generate slots
    // and a default same-company cap; otherwise we return an empty shell.
    scheduling: (_record, ctx) => {
        if (!ctx.usePlaceholders) {
            return { slots: [], maxSameCompanyMeetings: null };
        }
        return {
            slots: placeholderSlots(ctx.role, placeholderId(ctx)),
            maxSameCompanyMeetings: ctx.role === "sponsor" ? null : 2,
        };
    },
};

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/**
 * Constructs a single `Attendee` by invoking every field mapper in turn.
 *
 * Explicitly listing each key (rather than looping) gives TypeScript the
 * strongest possible per-field type inference.
 *
 * @param {MeetingDataRecord} record - The source SF record.
 * @param {MappingContext} ctx - Role / index / placeholders flag for this record.
 * @returns {Attendee} A fully populated Attendee.
 */
function buildAttendee(
    record: MeetingDataRecord,
    ctx: MappingContext,
): Attendee {
    return {
        id: attendeeFieldMappers.id(record, ctx),
        cventContactId: attendeeFieldMappers.cventContactId(record, ctx),
        salesforceId: attendeeFieldMappers.salesforceId(record, ctx),
        name: attendeeFieldMappers.name(record, ctx),
        email: attendeeFieldMappers.email(record, ctx),
        phone: attendeeFieldMappers.phone(record, ctx),
        role: attendeeFieldMappers.role(record, ctx),
        company: attendeeFieldMappers.company(record, ctx),
        title: attendeeFieldMappers.title(record, ctx),
        sponsorTier: attendeeFieldMappers.sponsorTier(record, ctx),
        profile: attendeeFieldMappers.profile(record, ctx),
        scheduling: attendeeFieldMappers.scheduling(record, ctx),
    };
}

/**
 * Converts a meeting-data pull (separate delegate and sponsor record arrays from Salesforce)
 * into a single flat `Attendee[]`.
 *
 * @param {{ delegates: MeetingDataRecord[]; sponsors: MeetingDataRecord[] }} data - Output of getMeetingDataByEvent().
 * @param {boolean} usePlaceholders - Whether to generate synthetic values for fields with no SF source.
 * @returns {Attendee[]} The combined attendee list (delegates first, sponsors second).
 */
export function meetingDataToAttendees(
    data: { delegates: MeetingDataRecord[]; sponsors: MeetingDataRecord[] },
    usePlaceholders: boolean,
): Attendee[] {
    // Map each role's records independently so the index counter restarts at
    // 0 for the placeholder ids (`d1, d2, …` then `s1, s2, …`).
    const delegates = data.delegates.map((r, index) =>
        buildAttendee(r, { role: "delegate", index, usePlaceholders }),
    );
    const sponsors = data.sponsors.map((r, index) =>
        buildAttendee(r, { role: "sponsor", index, usePlaceholders }),
    );
    return [...delegates, ...sponsors];
}
