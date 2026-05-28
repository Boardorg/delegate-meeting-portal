import type {
    Attendee,
    AttendeeProfile,
    AttendeeRole,
    AttendeeSlot,
    SponsorTier,
} from "@/types";

// Loose shape of the subset of a meeting-data SF record we read. Kept permissive
// (everything optional) because the SOQL field list changes frequently.
export type MeetingDataRecord = {
    Id?: string;
    Attendee_Type__c?: unknown;
    Delegate__r?: {
        FirstName?: string | null;
        LastName?: string | null;
        Title?: string | null;
        Email?: string | null;
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

function placeholderId(ctx: MappingContext): string {
    return `${ctx.role === "sponsor" ? "s" : "d"}${ctx.index + 1}`;
}

function placeholderSlots(role: AttendeeRole, id: string): AttendeeSlot[] {
    // Mirrors data/mock/attendees.json: 7 day-1 slots for everyone, plus 2 day-2
    // slots for delegates only. 20-minute slots starting 09:00 UTC.
    const make = (day: 1 | 2, count: number): AttendeeSlot[] => {
        const dateBase = day === 1 ? "2026-10-14" : "2026-10-15";
        return Array.from({ length: count }, (_, i) => {
            const startHour = 9 + Math.floor((i * 30) / 60);
            const startMin = (i * 30) % 60;
            const endMin = startMin + 20;
            const pad = (n: number) => String(n).padStart(2, "0");
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

type FieldMapper<K extends keyof Attendee> = (
    record: MeetingDataRecord,
    ctx: MappingContext,
) => Attendee[K];

type AttendeeFieldMappers = { [K in keyof Attendee]: FieldMapper<K> };

const profileMapper: FieldMapper<"profile"> = (record): AttendeeProfile => {
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

export const attendeeFieldMappers: AttendeeFieldMappers = {
    id: (_record, ctx) => (ctx.usePlaceholders ? placeholderId(ctx) : ""),
    cventContactId: (_record, ctx) =>
        ctx.usePlaceholders ? `cvent-${placeholderId(ctx)}-uuid` : "",
    salesforceId: (record) => String(record.Id ?? ""),
    name: (record) => {
        const first = record.Delegate__r?.FirstName ?? "";
        const last = record.Delegate__r?.LastName ?? "";
        return `${first} ${last}`.trim();
    },
    email: (record) => record.Delegate__r?.Email ?? "",
    role: (_record, ctx) => ctx.role,
    company: (record) => record.Delegate__r?.Account?.Name ?? "",
    title: (record) => record.Delegate__r?.Title ?? "",
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
    profile: profileMapper,
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
        role: attendeeFieldMappers.role(record, ctx),
        company: attendeeFieldMappers.company(record, ctx),
        title: attendeeFieldMappers.title(record, ctx),
        sponsorTier: attendeeFieldMappers.sponsorTier(record, ctx),
        profile: attendeeFieldMappers.profile(record, ctx),
        scheduling: attendeeFieldMappers.scheduling(record, ctx),
    };
}

export function meetingDataToAttendees(
    data: { delegates: MeetingDataRecord[]; sponsors: MeetingDataRecord[] },
    usePlaceholders: boolean,
): Attendee[] {
    const delegates = data.delegates.map((r, index) =>
        buildAttendee(r, { role: "delegate", index, usePlaceholders }),
    );
    const sponsors = data.sponsors.map((r, index) =>
        buildAttendee(r, { role: "sponsor", index, usePlaceholders }),
    );
    return [...delegates, ...sponsors];
}
