import fs from "node:fs/promises";
import path from "node:path";
import jsforce, { Connection, type Record as SfRecord } from "jsforce";
import type { AttendeeRecordSF, CachedAuth } from "@/types";

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

// Reverse-engineered from report 00OPZ00000DSuhJ2AT ("Contacts with Attendees
// and Registration", "Master List: Summit Reg Attendee Count").
// We query Attendee__c directly with the same field set
// and filter logic as the report, scoped to one conference.
//
// The Contact lookup on Attendee__c is `Delegate__c` (relationship `Delegate__r`).
// Attendee__c also has a `Contact__c` field labeled "Test SFDC contact" — do not
// use that one. We also require Delegate__c != NULL to mimic the report's
// inner join through Contact.
const MEETING_DATA_FIELDS = [
    "Id",
    "Name",
    "Status__c",
    "Replaced_By__c",
    "Speaker__c",
    "Conference__c",
    "Conference_Year__c",
    "Attendee_Type__c",
    "Delegate__r.FirstName",
    "Delegate__r.LastName",
    "Delegate__r.Title",
    "Delegate__r.Email",
    "Delegate__r.Account.Name",
    "Delegate__r.Account.Website",
    "Delegate__r.Account.Industry_Category__c",
    "Delegate__r.Account.AnnualRevenue",
    "Delegate__r.Account.NumberOfEmployees",
    "Delegate__r.Dietary_Requirements__c",
    "Delegate__r.Dietary_Restrictions__c",
    "Delegate__r.Special_Accommodations__c",
    "Registration__r.Name",
    "Registration__r.StageName",
    "Registration__r.Discount_Code__c",
    "Registration__r.RecordType.Name",
    "Registration__r.Sponsorship_Package__c",
] as const;

const EXCLUDED_DISCOUNT_CODES = ["JUSTTESTING", "DOLLARTEST", "ONEDOLLARTEST"];
const SPECIAL_DELEGATE_DISCOUNT_CODES = [
    "SPEAKERPASS",
    "BOARDMEMBERBUNDLE",
    "BOARDMEMBERPO",
    "REPLACEMENT",
    "BOARDMEMBERCOMP",
    "BOARDMEMBERSWAP",
];
const EXCLUDED_ACCOUNT_NAME_FRAGMENTS = [
    "Test",
    "Testing",
    "SocialMedia",
    "Assemble",
];

function soqlStringList(values: readonly string[]): string {
    return values.map((v) => `'${v.replace(/'/g, "\\'")}'`).join(", ");
}

function commonMeetingDataWhere(eventCode: string): string {
    const safeEvent = eventCode.replace(/'/g, "\\'");
    const accountNotContain = EXCLUDED_ACCOUNT_NAME_FRAGMENTS.map(
        (f) => `(NOT Delegate__r.Account.Name LIKE '%${f}%')`,
    ).join(" AND ");
    return [
        `Delegate__c != NULL`,
        `Delegate__r.AccountId != NULL`,
        `Registration__r.Active_Conference__c = TRUE`,
        `Registration__r.Discount_Code__c NOT IN (${soqlStringList(EXCLUDED_DISCOUNT_CODES)})`,
        `Registration__r.Conference__c = '${safeEvent}'`,
        accountNotContain,
        `(Status__c = NULL OR Status__c = 'Pending Replacement')`,
    ].join(" AND ");
}

export async function getMeetingDataSponsors(eventCode: string) {
    const where = [
        commonMeetingDataWhere(eventCode),
        `Registration__r.RecordType.Name = 'Sponsor'`,
        `Registration__r.StageName IN ('Closed-Won', 'Registered')`,
    ].join(" AND ");
    const soql = `SELECT ${MEETING_DATA_FIELDS.join(", ")} FROM Attendee__c WHERE ${where}`;
    return query(soql);
}

export async function getMeetingDataDelegates(eventCode: string) {
    const where = [
        commonMeetingDataWhere(eventCode),
        `Registration__r.RecordType.Name IN ('Board Event', 'Delegate')`,
        `(Registration__r.StageName = 'Closed-Won' OR Registration__r.Discount_Code__c IN (${soqlStringList(SPECIAL_DELEGATE_DISCOUNT_CODES)}))`,
    ].join(" AND ");
    const soql = `SELECT ${MEETING_DATA_FIELDS.join(", ")} FROM Attendee__c WHERE ${where}`;
    return query(soql);
}

export async function getMeetingDataByEvent(eventCode: string) {
    const [delegates, sponsors] = await Promise.all([
        getMeetingDataDelegates(eventCode),
        getMeetingDataSponsors(eventCode),
    ]);
    return { delegates, sponsors };
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

export async function writeJsonToTemp(
    data: unknown,
    filename: string,
): Promise<string> {
    const dir = path.join(process.cwd(), "data", "temp");
    await fs.mkdir(dir, { recursive: true });
    const filePath = path.join(dir, filename);
    await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf8");
    return filePath;
}
