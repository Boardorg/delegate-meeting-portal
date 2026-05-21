import fs from "node:fs/promises";
import path from "node:path";
import jsforce, { Connection, type Record as SfRecord } from "jsforce";
import type { Attendee, AttendeeRecordSF, AttendeeRole, CachedAuth, SponsorTier } from "@/types";

const API_VERSION = process.env.SALESFORCE_API_VERSION ?? "59.0";

const ATTENDEE_FIELDS = [
    "Id",
    "Name",
    "Company__c",
    "Attendee_Type__c",
    "Company_Employee__c",
    "What_s_your_industry__c",
    "Topics_of_Interest__c",
    "Functions_of_Interest__c",
    "Hospital_Type__c",
    "Do_you_plan_on_attending_the_tour__c",
] as const;

function attendeeSelect(): string {
    return `SELECT ${ATTENDEE_FIELDS.join(", ")} FROM Attendee__c`;
}

let cached: CachedAuth | null = null;

function readEnv() {
    const loginUrl = process.env.SALESFORCE_BASE_URL;
    const clientId = process.env.SALESFORCE_CLIENT_ID;
    const clientSecret = process.env.SALESFORCE_CLIENT_SECRET;
    if (!loginUrl || !clientId || !clientSecret) {
        throw new Error(
            "Missing Salesforce env vars: SALESFORCE_BASE_URL, SALESFORCE_CLIENT_ID, SALESFORCE_CLIENT_SECRET",
        );
    }
    return { loginUrl, clientId, clientSecret };
}

async function fetchToken(): Promise<CachedAuth> {
    const { loginUrl, clientId, clientSecret } = readEnv();
    const oauth2 = new jsforce.OAuth2({ loginUrl, clientId, clientSecret });

    // Salesforce returns no `expires_in` for client_credentials; tokens are valid
    // for the session timeout configured on the Connected App (default ~2h).
    // Cache for 30 minutes and let a 401 trigger a refresh.
    const res = await oauth2.requestToken({ grant_type: "client_credentials" });

    return {
        accessToken: res.access_token,
        instanceUrl: res.instance_url ?? loginUrl,
        expiresAt: Date.now() + 30 * 60 * 1000,
    };
}

export async function authenticate(): Promise<CachedAuth> {
    if (cached && cached.expiresAt > Date.now()) return cached;
    cached = await fetchToken();
    return cached;
}

export async function getConnection(): Promise<Connection> {
    const { accessToken, instanceUrl } = await authenticate();
    return new jsforce.Connection({
        instanceUrl,
        accessToken,
        version: API_VERSION,
    });
}

async function withConnection<T>(
    fn: (conn: Connection) => Promise<T>,
): Promise<T> {
    try {
        const conn = await getConnection();
        return await fn(conn);
    } catch (err: unknown) {
        const status =
            (err as { errorCode?: string; name?: string }).errorCode ??
            (err as { name?: string }).name;
        if (status === "INVALID_SESSION_ID") {
            cached = null;
            const conn = await getConnection();
            return await fn(conn);
        }
        throw err;
    }
}

export async function query<T extends SfRecord = SfRecord>(
    soql: string,
): Promise<T[]> {
    return withConnection(async (conn) => {
        const res = await conn.query<T>(soql);
        return res.records;
    });
}

export async function getAttendeesByEventId(
    eventId: string,
): Promise<AttendeeRecordSF[]> {
    // Field API names below are placeholders — adjust to match the Attendee__c
    // schema in this org before relying on them.
    const safeEventId = eventId.replace(/'/g, "\\'");

    if (!safeEventId) {
        throw new Error("No Event Id");
    }

    const soql = `${attendeeSelect()} WHERE Event__c = '${safeEventId}'`;
    const records = await query<AttendeeRecordSF>(soql);
    return records;
}

export async function getAttendeeById(
    attendeeId: string,
): Promise<AttendeeRecordSF> {
    // Field API names below are placeholders — adjust to match the Attendee__c
    // schema in this org before relying on them.
    const safeAttendeeId = attendeeId.replace(/'/g, "\\'");

    if (!safeAttendeeId) {
        throw new Error("No Attendee Id");
    }

    const soql = `${attendeeSelect()} WHERE Id = '${safeAttendeeId}'`;
    const records = await query<AttendeeRecordSF>(soql);

    return records[0];
}

// The SOQL above selects Salesforce field names; the scheduling engine and the
// existing mock CSV use the normalized Attendee shape. The mapping below
// assumes Attendee_Type__c contains "delegate"/"sponsor" (case-insensitive).
// sponsorTier and day1/day2 slot counts are not currently in ATTENDEE_FIELDS,
// so they default — extend ATTENDEE_FIELDS and this mapper together when those
// fields are needed.
export function attendeeRecordsToAttendees(records: AttendeeRecordSF[]): Attendee[] {
    return records.map((r) => {
        const rawType = typeof r.Attendee_Type__c === "string" ? r.Attendee_Type__c.toLowerCase() : "";
        const role: AttendeeRole = rawType === "sponsor" ? "sponsor" : "delegate";
        const rawTier = typeof r.Sponsor_Tier__c === "string" ? r.Sponsor_Tier__c.toLowerCase() : null;
        const sponsorTier: SponsorTier =
            rawTier === "diamond" || rawTier === "standard" ? rawTier : null;
        return {
            id: r.Id,
            name: r.Name,
            role,
            company: typeof r.Company__c === "string" ? r.Company__c : "",
            sponsorTier,
            day1SlotCount: typeof r.Day1_Slot_Count__c === "number" ? r.Day1_Slot_Count__c : 0,
            day2SlotCount: typeof r.Day2_Slot_Count__c === "number" ? r.Day2_Slot_Count__c : 0,
        };
    });
}

const CSV_COLUMNS: Array<keyof Attendee> = [
    "id",
    "name",
    "role",
    "company",
    "sponsorTier",
    "day1SlotCount",
    "day2SlotCount",
];

function csvCell(value: unknown): string {
    const s = value === null || value === undefined ? "" : String(value);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export async function writeAttendeesCsv(attendees: Attendee[], filename: string): Promise<string> {
    const dir = path.join(process.cwd(), "data", "temp");
    await fs.mkdir(dir, { recursive: true });
    const filePath = path.join(dir, filename);
    const header = CSV_COLUMNS.join(",");
    const rows = attendees.map((a) => CSV_COLUMNS.map((c) => csvCell(a[c])).join(","));
    await fs.writeFile(filePath, [header, ...rows].join("\n") + "\n", "utf8");
    return filePath;
}
