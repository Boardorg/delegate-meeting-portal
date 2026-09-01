import {
    formatCompanySize,
    formatRevenue,
    splitPicklist,
} from "@/lib/attendees/formatProfile";
import type {
    Attendee,
    AttendeeProfile,
    AttendeeRole,
    SponsorTier,
} from "@/types";

// ---------------------------------------------------------------------------
// Types
//
// The two roles are sourced from two different Salesforce objects, so each has
// its own raw record shape:
//   - sponsors  → Attendee__c            → MeetingDataRecord
//   - delegates → CventEvents__Attendee__c → CventAttendeeRecord
// ---------------------------------------------------------------------------

/**
 * Loose shape of the subset of a sponsor (Attendee__c) Salesforce record we read.
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
        // Salesforce Account id of the contact's employer. The company key that
        // groups a sponsor's reps (see lib/attendees/companies.ts).
        AccountId?: string | null;
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
 * Loose shape of the subset of a delegate (CventEvents__Attendee__c) record we
 * read. Same all-optional convention as MeetingDataRecord.
 *
 * Note the two field-naming conventions: `CventEvents__*` is the managed
 * package's namespace, while the intake-form answers are non-namespaced custom
 * fields that merely start with `CventEvents_NP_`. Every intake value arrives as
 * free text, semicolon-delimited where the form allowed multiple answers.
 */
export type CventAttendeeRecord = {
    Id?: string;
    CventEvents__Status__c?: string | null;
    CventEvents__Email__c?: string | null;
    CventEvents__Contact__r?: {
        FirstName?: string | null;
        LastName?: string | null;
        Title?: string | null;
        Email?: string | null;
        Phone?: string | null;
        // Salesforce Account id of the delegate's employer. Informational for
        // delegates (they schedule by their own id) but still used by the
        // engine's company-diversity rule — see lib/scheduling/helpers.ts.
        AccountId?: string | null;
        Account?: {
            Name?: string | null;
            Industry_Category__c?: string | null;
        } | null;
    } | null;
    CventEvents_NP_Company_Size__c?: string | null;
    CventEvents_NP_Annual_Revenue__c?: string | null;
    CventEvents_NP_Budget_Responsibility__c?: string | null;
    CventEvents_NP_Current_Focus_Topics__c?: string | null;
    CventEvents_NP_Transformation_Stage__c?: string | null;
    CventEvents_NP_Systems_and_Platforms__c?: string | null;
    CventEvents_NP_One_to_One_Interests__c?: string | null;
    CventEvents_NP_Initiative_Priority__c?: string | null;
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

// ---------------------------------------------------------------------------
// Field mappers — one self-contained function per Attendee field.
//
// There is one mapper set per role, because the two roles come from different
// Salesforce objects: `attendeeFieldMappers` (sponsors, Attendee__c) and
// `delegateFieldMappers` (delegates, CventEvents__Attendee__c). Both are typed
// against the same exhaustive mapped type, so adding a field to Attendee is a
// compile error until both roles say where it comes from.
//
// To change how a field is derived, edit its function. Each mapper decides
// internally whether to use a real SF value or, when ctx.usePlaceholders is on,
// a generated placeholder.
// ---------------------------------------------------------------------------

/**
 * Function signature for a single Attendee-field mapper: given a raw SF record
 * of shape `R` and context, return the value for one specific Attendee field.
 */
type FieldMapper<R, K extends keyof Attendee> = (
    record: R,
    ctx: MappingContext,
) => Attendee[K];

/**
 * Mapper object shape for one source record type. The mapped type forces a
 * mapper to exist for every Attendee key, so adding a new Attendee field is
 * caught at compile time.
 */
type AttendeeFieldMappers<R> = {
    [K in keyof Attendee]: FieldMapper<R, K>;
};

/**
 * Trims a raw Salesforce text value down to a display string, collapsing blanks
 * to null so the UI's `|| "N/A"` fallbacks and the catalog's filters (which drop
 * null values) behave consistently.
 *
 * @param {string | null | undefined} raw - The raw SF value.
 * @returns {string | null} The trimmed value, or null when absent/blank.
 */
function textOrNull(raw: string | null | undefined): string | null {
    const trimmed = (raw ?? "").trim();
    return trimmed || null;
}

/**
 * Maps a sponsor record's nested Account fields into the Attendee `profile`
 * sub-object.
 *
 * Sponsors have no intake form, so only the three Account-derived fields can be
 * populated; the rest are delegate-only and default. Revenue and company size
 * arrive from the Account as raw numbers, so they're bucketed here — that keeps
 * AttendeeProfile a string-only shape, matching the delegate side where the
 * values are already worded text.
 *
 * Nothing in the UI reads a sponsor's profile today; this is kept populated so
 * the sponsor record stays self-describing.
 *
 * @param {MeetingDataRecord} record - The raw SF record.
 * @returns {AttendeeProfile} The mapped profile.
 */
const sponsorProfileMapper: FieldMapper<MeetingDataRecord, "profile"> = (
    record,
): AttendeeProfile => {
    // Pull the joined Account once; every populated profile field reads from it.
    const account = record.Delegate__r?.Account ?? null;
    const industry = account?.Industry_Category__c ?? null;

    return {
        annualRevenue: formatRevenue(account?.AnnualRevenue ?? null),
        budgetaryResponsibility: null,
        companySize: formatCompanySize(account?.NumberOfEmployees ?? null),
        industrySectors: splitPicklist(industry),
        interestAreas: [],
        transformationStage: null,
        systemsAndPlatforms: [],
        meetingInterests: [],
        priorityInitiative: null,
    };
};

/**
 * Maps a delegate's intake-form answers into the Attendee `profile` sub-object.
 *
 * Every value is free text in Salesforce. Fields whose form question allowed
 * multiple answers come back semicolon-delimited and are split into arrays;
 * single-answer questions stay scalar strings. Industry sectors are the one
 * field that keeps its pre-existing source (the Account), alongside company name
 * and job title which live on the Attendee itself.
 *
 * @param {CventAttendeeRecord} record - The raw CventEvents__Attendee__c record.
 * @returns {AttendeeProfile} The mapped profile.
 */
const delegateProfileMapper: FieldMapper<CventAttendeeRecord, "profile"> = (
    record,
): AttendeeProfile => {
    const account = record.CventEvents__Contact__r?.Account ?? null;

    return {
        annualRevenue: textOrNull(record.CventEvents_NP_Annual_Revenue__c),
        budgetaryResponsibility: textOrNull(
            record.CventEvents_NP_Budget_Responsibility__c,
        ),
        companySize: textOrNull(record.CventEvents_NP_Company_Size__c),
        industrySectors: splitPicklist(account?.Industry_Category__c),
        interestAreas: splitPicklist(
            record.CventEvents_NP_Current_Focus_Topics__c,
        ),
        transformationStage: textOrNull(
            record.CventEvents_NP_Transformation_Stage__c,
        ),
        systemsAndPlatforms: splitPicklist(
            record.CventEvents_NP_Systems_and_Platforms__c,
        ),
        meetingInterests: splitPicklist(
            record.CventEvents_NP_One_to_One_Interests__c,
        ),
        priorityInitiative: textOrNull(
            record.CventEvents_NP_Initiative_Priority__c,
        ),
    };
};

/**
 * Per-field resolvers for SPONSORS (Attendee__c records). Each function reads
 * one Attendee field from the SF record (or, for placeholder-only fields,
 * generates one when the flag is on).
 */
export const attendeeFieldMappers: AttendeeFieldMappers<MeetingDataRecord> = {
    // App-level id. Use a generated short id with placeholders on; otherwise
    // fall back to the Salesforce record Id, which is always unique.
    id: (record, ctx) =>
        ctx.usePlaceholders ? placeholderId(ctx) : String(record.Id ?? ""),

    // Cvent contact UUID; no SF source today. Fabricate when placeholders on.
    cventContactId: (_record, ctx) =>
        ctx.usePlaceholders ? `cvent-${placeholderId(ctx)}-uuid` : "",

    // Attendee__c.Id from Salesforce. Coerced to string for safety.
    salesforceId: (record) => String(record.Id ?? ""),

    // Salesforce Account id of the contact's employer. For sponsors this is the
    // party id that bundles all of a company's reps (lib/attendees/companies.ts).
    accountId: (record, ctx) =>
        ctx.usePlaceholders
            ? `acct-${placeholderId(ctx)}`
            : String(record.Delegate__r?.AccountId ?? ""),

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
            packageLabel.toLowerCase().includes("diamond")
                ? (packageType = "diamond")
                : (packageType = "standard");
        }
        return packageType;
    },

    // Delegated to sponsorProfileMapper to keep this object readable.
    profile: sponsorProfileMapper,

    // Availability is no longer per-attendee — it comes from the event-global
    // Timeslot[] sourced from Cvent (see lib/cvent/mapper.ts). The only
    // per-attendee scheduling constraint left is the company-diversity cap:
    // null for sponsors (rule doesn't apply), 2 for delegates.
    scheduling: (_record, ctx) => ({
        maxSameCompanyMeetings: ctx.role === "sponsor" ? null : 2,
    }),
};

/**
 * Per-field resolvers for DELEGATES (CventEvents__Attendee__c records).
 *
 * Identity, company name, job title and Account id are all dot-walked through
 * the record's Contact lookup, so those keep the sources they had before
 * delegates moved objects. The profile comes from the intake-form answers.
 */
export const delegateFieldMappers: AttendeeFieldMappers<CventAttendeeRecord> = {
    // App-level id. Use a generated short id with placeholders on; otherwise
    // fall back to the Salesforce record Id, which is always unique.
    id: (record, ctx) =>
        ctx.usePlaceholders ? placeholderId(ctx) : String(record.Id ?? ""),

    // Cvent contact UUID; not on this object. Filled in from the Cvent attendee
    // API by email match in lib/attendees/loader.ts. Fabricate when placeholders on.
    cventContactId: (_record, ctx) =>
        ctx.usePlaceholders ? `cvent-${placeholderId(ctx)}-uuid` : "",

    // CventEvents__Attendee__c.Id. This is the delegate's storage key — it lands
    // in meeting_requests.target_id and scheduled_meetings.attendee_a/b.
    salesforceId: (record) => String(record.Id ?? ""),

    // Account id of the delegate's employer. Informational for delegates, but
    // read by the engine's company-diversity rule.
    accountId: (record, ctx) =>
        ctx.usePlaceholders
            ? `acct-${placeholderId(ctx)}`
            : String(record.CventEvents__Contact__r?.AccountId ?? ""),

    // Combine first + last into a single display name.
    name: (record) => {
        const first = record.CventEvents__Contact__r?.FirstName ?? "";
        const last = record.CventEvents__Contact__r?.LastName ?? "";
        return `${first} ${last}`.trim();
    },

    // Contact.Email, falling back to the address Cvent registered them with.
    // This drives the Cvent cross-check, so an address matters more than its
    // provenance.
    email: (record) =>
        record.CventEvents__Contact__r?.Email ??
        record.CventEvents__Email__c ??
        "",

    // Contact.Phone. Used to match the SMS-login phone to an attendee record
    // when the user isn't in the local users table (see lib/auth/identity.ts).
    phone: (record) => record.CventEvents__Contact__r?.Phone ?? "",

    // Role isn't on the SF record itself; it's tagged by the caller via ctx
    // based on which sub-list (delegates vs sponsors) the record came from.
    role: (_record, ctx) => ctx.role,

    // Account.Name on the joined Contact — unchanged source.
    company: (record) =>
        record.CventEvents__Contact__r?.Account?.Name ?? "",

    // Contact.Title — unchanged source.
    title: (record) => record.CventEvents__Contact__r?.Title ?? "",

    // Delegates have no sponsorship package.
    sponsorTier: () => null,

    // Delegated to delegateProfileMapper to keep this object readable.
    profile: delegateProfileMapper,

    // Same event-global availability model as sponsors; delegates carry the
    // company-diversity cap.
    scheduling: (_record, ctx) => ({
        maxSameCompanyMeetings: ctx.role === "sponsor" ? null : 2,
    }),
};

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/**
 * Constructs a single `Attendee` by invoking every field mapper in turn.
 *
 * Explicitly listing each key (rather than looping) gives TypeScript the
 * strongest possible per-field type inference, and generic over the record type
 * so one implementation serves both roles' mapper sets.
 *
 * @param {R} record - The source SF record.
 * @param {MappingContext} ctx - Role / index / placeholders flag for this record.
 * @param {AttendeeFieldMappers<R>} mappers - The mapper set matching the record's object.
 * @returns {Attendee} A fully populated Attendee.
 */
function buildAttendee<R>(
    record: R,
    ctx: MappingContext,
    mappers: AttendeeFieldMappers<R>,
): Attendee {
    return {
        id: mappers.id(record, ctx),
        cventContactId: mappers.cventContactId(record, ctx),
        salesforceId: mappers.salesforceId(record, ctx),
        accountId: mappers.accountId(record, ctx),
        name: mappers.name(record, ctx),
        email: mappers.email(record, ctx),
        phone: mappers.phone(record, ctx),
        role: mappers.role(record, ctx),
        company: mappers.company(record, ctx),
        title: mappers.title(record, ctx),
        sponsorTier: mappers.sponsorTier(record, ctx),
        profile: mappers.profile(record, ctx),
        scheduling: mappers.scheduling(record, ctx),
    };
}

/**
 * Converts a meeting-data pull (delegate and sponsor record arrays from two
 * different Salesforce objects) into a single flat `Attendee[]`.
 *
 * @param {{ delegates: CventAttendeeRecord[]; sponsors: MeetingDataRecord[] }} data - Output of getMeetingDataByEvent().
 * @param {boolean} usePlaceholders - Whether to generate synthetic values for fields with no SF source.
 * @returns {Attendee[]} The combined attendee list (delegates first, sponsors second).
 */
export function meetingDataToAttendees(
    data: { delegates: CventAttendeeRecord[]; sponsors: MeetingDataRecord[] },
    usePlaceholders: boolean,
): Attendee[] {
    // Map each role's records independently — with its own mapper set, since the
    // two come from different objects — so the index counter also restarts at 0
    // for the placeholder ids (`d1, d2, …` then `s1, s2, …`).
    const delegates = data.delegates.map((r, index) =>
        buildAttendee(
            r,
            { role: "delegate", index, usePlaceholders },
            delegateFieldMappers,
        ),
    );
    const sponsors = data.sponsors.map((r, index) =>
        buildAttendee(
            r,
            { role: "sponsor", index, usePlaceholders },
            attendeeFieldMappers,
        ),
    );
    return [...delegates, ...sponsors];
}
