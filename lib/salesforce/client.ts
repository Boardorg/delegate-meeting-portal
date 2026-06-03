import fs from "node:fs/promises";
import path from "node:path";
import jsforce, { Connection, type Record as SfRecord } from "jsforce";
import type { AttendeeRecordSF, CachedAuth } from "@/types";

// ---------------------------------------------------------------------------
// Module configuration and constants
// ---------------------------------------------------------------------------

// Salesforce REST API version to negotiate against. Overridable via env so the
// org can be pinned to a known-good version when needed.
const API_VERSION = process.env.SALESFORCE_API_VERSION ?? "59.0";

// Field list used by the simple per-event / per-id Attendee__c fetches below.
// Distinct from MEETING_DATA_FIELDS, which targets the much wider meeting-data
// report fields and is filtered/joined differently.
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

/**
 * Builds the `SELECT … FROM Attendee__c` prefix shared by the simple
 * attendee lookups. Centralized so adding a field to ATTENDEE_FIELDS picks up
 * in every query.
 *
 * @returns {string} A SOQL string up through (but not including) any WHERE clause.
 */
function attendeeSelect(): string {
    return `SELECT ${ATTENDEE_FIELDS.join(", ")} FROM Attendee__c`;
}

// Module-level token cache. Lives for the lifetime of the Node process — each
// serverless invocation / dev-server instance has its own copy. See
// authenticate() for the refresh strategy.
let cached: CachedAuth | null = null;

// ---------------------------------------------------------------------------
// OAuth (Client Credentials) and connection management
// ---------------------------------------------------------------------------

/**
 * Reads the three required Salesforce env vars and throws a single combined
 * error if any are missing.
 *
 * @returns {{ loginUrl: string; clientId: string; clientSecret: string }} The validated credentials.
 */
function readEnv() {
    // Pull each value individually so the error message can list all three.
    const loginUrl = process.env.SALESFORCE_BASE_URL;
    const clientId = process.env.SALESFORCE_CLIENT_ID;
    const clientSecret = process.env.SALESFORCE_CLIENT_SECRET;

    // Fail loudly at the boundary instead of letting a downstream OAuth call
    // produce an opaque "invalid_grant" or "invalid_client" error.
    if (!loginUrl || !clientId || !clientSecret) {
        throw new Error(
            "Missing Salesforce env vars: SALESFORCE_BASE_URL, SALESFORCE_CLIENT_ID, SALESFORCE_CLIENT_SECRET",
        );
    }
    return { loginUrl, clientId, clientSecret };
}

/**
 * Performs the OAuth 2.0 Client Credentials exchange against Salesforce's
 * token endpoint and returns the resulting access token plus a derived
 * cache-expiry timestamp.
 *
 * @returns {Promise<CachedAuth>} The fresh credential bundle.
 */
async function fetchToken(): Promise<CachedAuth> {
    // Load + validate config before making the network call.
    const { loginUrl, clientId, clientSecret } = readEnv();

    // jsforce's OAuth2 helper handles the form-encoded POST to /services/oauth2/token.
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

/**
 * Returns a valid Salesforce access token, refreshing it if the cache has
 * expired. The token is held in `cached` across requests in the same Node
 * process to avoid hitting the token endpoint on every API call.
 *
 * @returns {Promise<CachedAuth>} A non-expired credential bundle.
 */
export async function authenticate(): Promise<CachedAuth> {
    // Fast path: return the cached token if it's still within its TTL.
    if (cached && cached.expiresAt > Date.now()) return cached;

    // Otherwise fetch a fresh one and update the cache.
    cached = await fetchToken();
    return cached;
}

/**
 * Builds a jsforce `Connection` bound to the cached access token and the
 * instance URL returned at auth time. Each call produces a new Connection
 * object but shares the underlying token via authenticate().
 *
 * @returns {Promise<Connection>} A ready-to-use jsforce connection.
 */
export async function getConnection(): Promise<Connection> {
    // Ensure we have a valid token before constructing the connection.
    const { accessToken, instanceUrl } = await authenticate();
    return new jsforce.Connection({
        instanceUrl,
        accessToken,
        version: API_VERSION,
    });
}

/**
 * Runs the provided callback with an authenticated `Connection`, and on a
 * Salesforce `INVALID_SESSION_ID` error clears the token cache and retries
 * once. This makes cached-token expiry between requests self-healing without
 * burdening callers with retry logic.
 *
 * @param {(conn: Connection) => Promise<T>} fn - The work to run against the connection.
 * @returns {Promise<T>} The callback's return value.
 */
async function withConnection<T>(
    fn: (conn: Connection) => Promise<T>,
): Promise<T> {
    try {
        // First attempt with the current (possibly cached) token.
        const conn = await getConnection();
        return await fn(conn);
    } catch (err: unknown) {
        // jsforce surfaces session expiry as either errorCode or name depending on the API surface.
        const status =
            (err as { errorCode?: string; name?: string }).errorCode ??
            (err as { name?: string }).name;

        // If — and only if — the token went stale, drop it and try once more.
        if (status === "INVALID_SESSION_ID") {
            cached = null;
            const conn = await getConnection();
            return await fn(conn);
        }

        // Anything else (network, permission, bad SOQL) bubbles up unchanged.
        throw err;
    }
}

// ---------------------------------------------------------------------------
// Generic SOQL execution
// ---------------------------------------------------------------------------

/**
 * Executes a SOQL query and returns just the `records` array. Generic over the
 * row shape — callers pass a type to get back typed records (or fall back to
 * the loose jsforce `Record` shape).
 *
 * @param {string} soql - The SOQL statement to execute.
 * @returns {Promise<T[]>} The records returned by Salesforce.
 */
export async function query<T extends SfRecord = SfRecord>(
    soql: string,
): Promise<T[]> {
    return withConnection(async (conn) => {
        // jsforce returns `{ records, totalSize, done, ... }`; we only need the rows.
        const res = await conn.query<T>(soql);
        return res.records;
    });
}

// ---------------------------------------------------------------------------
// Meeting-data query (reverse-engineered Salesforce report)
// ---------------------------------------------------------------------------

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

// Discount codes that mark an Opportunity as a test/placeholder and should be
// excluded from the attendee list regardless of stage.
const EXCLUDED_DISCOUNT_CODES = ["JUSTTESTING", "DOLLARTEST", "ONEDOLLARTEST"];

// Discount codes that let a non–Closed-Won delegate Opportunity still count
// (e.g. comp passes, speaker passes, board-member replacements).
const SPECIAL_DELEGATE_DISCOUNT_CODES = [
    "SPEAKERPASS",
    "BOARDMEMBERBUNDLE",
    "BOARDMEMBERPO",
    "REPLACEMENT",
    "BOARDMEMBERCOMP",
    "BOARDMEMBERSWAP",
];

// Account-name substrings used to filter out internal/test accounts in the
// source report. Matching is case-insensitive (SOQL LIKE).
const EXCLUDED_ACCOUNT_NAME_FRAGMENTS = [
    "Test",
    "Testing",
    "SocialMedia",
    "Assemble",
];

/**
 * Formats an array of strings as a SOQL `IN (...)` value list, single-quoting
 * each entry and escaping embedded apostrophes.
 *
 * @param {readonly string[]} values - Raw values to format.
 * @returns {string} The joined `'a', 'b', 'c'` body for an `IN (...)` clause.
 */
function soqlStringList(values: readonly string[]): string {
    return values.map((v) => `'${v.replace(/'/g, "\\'")}'`).join(", ");
}

/**
 * Builds the WHERE-clause fragment that applies to BOTH the sponsors and the
 * delegates queries. The role-specific RecordType / StageName conditions are
 * appended by the per-role helpers below.
 *
 * @param {string} eventCode - The conference code being queried (e.g. `"NAMLS"`).
 * @returns {string} A `cond1 AND cond2 AND …` SOQL fragment.
 */
function commonMeetingDataWhere(eventCode: string): string {
    // Defensively escape apostrophes in the event code; it comes from the URL.
    const safeEvent = eventCode.replace(/'/g, "\\'");

    // Each fragment must exclude any of the EXCLUDED_ACCOUNT_NAME_FRAGMENTS substrings.
    const accountNotContain = EXCLUDED_ACCOUNT_NAME_FRAGMENTS.map(
        (f) => `(NOT Delegate__r.Account.Name LIKE '%${f}%')`,
    ).join(" AND ");

    // Conditions match the source report's filter graph; see the file header
    // comment for the boolean-logic mapping.
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

/**
 * Queries Attendee__c records that count as sponsors for the given event:
 * Opportunity RecordType = "Sponsor" and StageName in Closed-Won / Registered.
 *
 * @param {string} eventCode - The conference code (e.g. `"NAMLS"`).
 * @returns {Promise<SfRecord[]>} The matched Attendee__c records with joined Contact + Opportunity fields.
 */
export async function getMeetingDataSponsors(eventCode: string) {
    // Append the sponsor-specific clauses to the shared filter.
    const where = [
        commonMeetingDataWhere(eventCode),
        `Registration__r.RecordType.Name = 'Sponsor'`,
        `Registration__r.StageName IN ('Closed-Won', 'Registered')`,
    ].join(" AND ");
    const soql = `SELECT ${MEETING_DATA_FIELDS.join(", ")} FROM Attendee__c WHERE ${where}`;
    return query(soql);
}

/**
 * Queries Attendee__c records that count as delegates for the given event:
 * Opportunity RecordType in (Board Event, Delegate), AND either Closed-Won OR
 * carrying one of SPECIAL_DELEGATE_DISCOUNT_CODES (which permit Registered /
 * other stages).
 *
 * @param {string} eventCode - The conference code (e.g. `"NAMLS"`).
 * @returns {Promise<SfRecord[]>} The matched Attendee__c records with joined Contact + Opportunity fields.
 */
export async function getMeetingDataDelegates(eventCode: string) {
    // Append the delegate-specific clauses to the shared filter.
    const where = [
        commonMeetingDataWhere(eventCode),
        `Registration__r.RecordType.Name IN ('Board Event', 'Delegate')`,
        `(Registration__r.StageName = 'Closed-Won' OR Registration__r.Discount_Code__c IN (${soqlStringList(SPECIAL_DELEGATE_DISCOUNT_CODES)}))`,
    ].join(" AND ");
    const soql = `SELECT ${MEETING_DATA_FIELDS.join(", ")} FROM Attendee__c WHERE ${where}`;
    return query(soql);
}

/**
 * Convenience aggregator: runs the sponsor and delegate queries in parallel
 * and returns both lists keyed by role.
 *
 * @param {string} eventCode - The conference code (e.g. `"NAMLS"`).
 * @returns {Promise<{ delegates: SfRecord[]; sponsors: SfRecord[] }>} The two record lists.
 */
export async function getMeetingDataByEvent(eventCode: string) {
    // Parallel because the two queries are independent and similarly sized.
    const [delegates, sponsors] = await Promise.all([
        getMeetingDataDelegates(eventCode),
        getMeetingDataSponsors(eventCode),
    ]);
    return { delegates, sponsors };
}

// ---------------------------------------------------------------------------
// Simple Attendee__c lookups (separate from meeting-data)
// ---------------------------------------------------------------------------

/**
 * Returns all Attendee__c records linked to the given Event__c id.
 *
 * @param {string} eventId - Salesforce Event__c record id.
 * @returns {Promise<AttendeeRecordSF[]>} The matched Attendee__c records.
 */
export async function getAttendeesByEventId(
    eventId: string,
): Promise<AttendeeRecordSF[]> {
    // Field API names in ATTENDEE_FIELDS are placeholders — adjust to match the
    // Attendee__c schema in this org before relying on them.
    const safeEventId = eventId.replace(/'/g, "\\'");

    // The route layer should validate this, but guard here too so a stray
    // call doesn't issue a "WHERE Event__c = ''" query that scans everything.
    if (!safeEventId) {
        throw new Error("No Event Id");
    }

    const soql = `${attendeeSelect()} WHERE Event__c = '${safeEventId}'`;
    const records = await query<AttendeeRecordSF>(soql);
    return records;
}

/**
 * Returns the single Attendee__c record with the given Id, or undefined if
 * no match exists.
 *
 * @param {string} attendeeId - Salesforce Attendee__c record id.
 * @returns {Promise<AttendeeRecordSF>} The first matched record (zero or one).
 */
export async function getAttendeeById(
    attendeeId: string,
): Promise<AttendeeRecordSF> {
    // Field API names in ATTENDEE_FIELDS are placeholders — adjust to match the
    // Attendee__c schema in this org before relying on them.
    const safeAttendeeId = attendeeId.replace(/'/g, "\\'");

    // Guard against an empty id that would otherwise produce a runtime error.
    if (!safeAttendeeId) {
        throw new Error("No Attendee Id");
    }

    const soql = `${attendeeSelect()} WHERE Id = '${safeAttendeeId}'`;
    const records = await query<AttendeeRecordSF>(soql);

    // Querying by Id always yields zero or one row; return the first (or undefined).
    return records[0];
}

// ---------------------------------------------------------------------------
// Local filesystem helpers
// ---------------------------------------------------------------------------

/**
 * Writes arbitrary JSON-serializable data to `data/temp/<filename>`, creating
 * the directory if needed. Used by the meeting-data route to persist
 * generated attendees / requests payloads for inspection.
 *
 * @param {unknown} data - The value to JSON.stringify.
 * @param {string} filename - The destination file name (no path).
 * @returns {Promise<string>} The absolute path written.
 */
export async function writeJsonToTemp(
    data: unknown,
    filename: string,
): Promise<string> {
    // Resolve the destination relative to the process cwd so callers don't
    // need to compute paths themselves.
    const dir = path.join(process.cwd(), "data", "temp");

    // Idempotent: safe to call even when the directory already exists.
    await fs.mkdir(dir, { recursive: true });
    const filePath = path.join(dir, filename);

    // Pretty-print so the files are easy to diff and grep by hand.
    await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf8");
    return filePath;
}
