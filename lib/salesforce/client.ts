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
