import fs from "node:fs/promises";
import path from "node:path";
import jsforce, { Connection, type Record as SfRecord } from "jsforce";
import { getEventSettings } from "@/lib/events/settings";
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
// Sponsors (Attendee__c, reverse-engineered Salesforce report)
//
// This is the sponsor side only. Delegates used to be queried from the same
// object with a different RecordType/StageName filter; they now come from
// CventEvents__Attendee__c further down this file.
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
    "Delegate__r.Phone",
    "Delegate__r.AccountId",
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
 * Builds the WHERE-clause fragment for the sponsors query.
 *
 * Delegates no longer share this filter set — they come from
 * CventEvents__Attendee__c instead (see getMeetingDataDelegates), so every
 * condition here is Opportunity/Contact-based and sponsor-specific.
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

// ---------------------------------------------------------------------------
// Delegates (CventEvents__Attendee__c)
//
// Delegates come from the Cvent-for-Salesforce managed package's attendee
// object rather than from Attendee__c + Opportunity. That object is the landing
// place for the event's intake-form answers, which supply nearly the whole
// delegate profile shown in the browse UI.
//
// Two naming conventions live side by side on this object and the difference
// matters when adding fields:
//   - `CventEvents__*__c`   — namespaced, shipped by the managed package.
//   - `CventEvents_NP_*__c` — NOT namespaced (single underscore); custom fields
//                             added to the packaged object to hold the intake
//                             answers.
//
// The Contact lookup is `CventEvents__Contact__c` (relationship
// `CventEvents__Contact__r`). Company name, job title and industry sectors keep
// their existing sources and are dot-walked through it, so they still come from
// Contact / Account rather than from the Cvent registration.
// ---------------------------------------------------------------------------

const CVENT_ATTENDEE_FIELDS = [
    "Id",
    "Name",
    // Registration metadata, useful when debugging who did/didn't come back.
    "CventEvents__Status__c",
    "CventEvents__Email__c",
    // Identity + the three fields that keep their pre-existing sources.
    "CventEvents__Contact__r.FirstName",
    "CventEvents__Contact__r.LastName",
    "CventEvents__Contact__r.Title",
    "CventEvents__Contact__r.Email",
    "CventEvents__Contact__r.Phone",
    "CventEvents__Contact__r.AccountId",
    "CventEvents__Contact__r.Account.Name",
    "CventEvents__Contact__r.Account.Industry_Category__c",
    // Intake-form answers. Each maps to one AttendeeProfile field; see
    // lib/salesforce/attendeeMapper.ts.
    "CventEvents_NP_Company_Size__c",
    "CventEvents_NP_Annual_Revenue__c",
    "CventEvents_NP_Budget_Responsibility__c",
    "CventEvents_NP_Current_Focus_Topics__c",
    "CventEvents_NP_Transformation_Stage__c",
    "CventEvents_NP_Systems_and_Platforms__c",
    "CventEvents_NP_One_to_One_Interests__c",
    "CventEvents_NP_Initiative_Priority__c",
] as const;

/**
 * Resolves the Cvent Event id for an event from its settings row — the same
 * value lib/cvent/client.ts uses to list attendees from the Cvent API, so the
 * Salesforce and Cvent sides are always scoped to the same event.
 *
 * @param {string} eventCode - The internal event code (e.g. "BMWS").
 * @returns {Promise<string>} The Cvent Event id (a UUID).
 * @throws {Error} When the event has no settings row or no Cvent Event id.
 */
async function requireCventEventId(eventCode: string): Promise<string> {
    const settings = await getEventSettings(eventCode);
    if (!settings) {
        throw new Error(
            `No Cvent settings configured for event "${eventCode}". ` +
                "Add them in Admin → Event settings.",
        );
    }
    if (!settings.cventEventId) {
        throw new Error(
            `Event "${eventCode}" has no Cvent Event ID set ` +
                "(Admin → Event settings).",
        );
    }
    return settings.cventEventId;
}

/**
 * Queries the CventEvents__Attendee__c records that count as delegates for the
 * given event.
 *
 * Scoping goes through the Event lookup's `CventEvents__pkg_EventStub__c`, which
 * is where the package stores the Cvent Event UUID — the exact value held in
 * event_settings.cvent_event_id. (The attendee's own
 * `CventEvents__EventTitle__c` is a display formula that renders an HTML anchor,
 * not an identifier, so it can't be used here.)
 *
 * Rows with no Contact are dropped: without one there is no name, company,
 * title, industry or Account id to show, and no email to match against Cvent.
 *
 * @param {string} eventCode - The internal event code (e.g. `"BMWS"`).
 * @returns {Promise<SfRecord[]>} The matched records with joined Contact + Account fields.
 */
export async function getMeetingDataDelegates(eventCode: string) {
    const cventEventId = await requireCventEventId(eventCode);

    // Defensively escape apostrophes; the id is admin-entered free text.
    const safeEventId = cventEventId.replace(/'/g, "\\'");

    const where = [
        `CventEvents__Event__r.CventEvents__pkg_EventStub__c = '${safeEventId}'`,
        `CventEvents__Contact__c != NULL`,
        // The package's own test-record flag. Preferred over the account-name
        // matching the sponsor query uses, which would also drop a legitimate
        // company that happens to have "Test" in its name.
        `CventEvents__Test_Record__c = FALSE`,
    ].join(" AND ");

    // Deliberately NOT filtered on CventEvents__Status__c: who is actually
    // attending is already settled by the Cvent-API cross-check in
    // lib/attendees/loader.ts, and guessing at the status vocabulary here would
    // risk silently hiding real delegates.
    const soql = `SELECT ${CVENT_ATTENDEE_FIELDS.join(", ")} FROM CventEvents__Attendee__c WHERE ${where}`;
    return query(soql);
}

/**
 * Convenience aggregator: runs the sponsor and delegate queries in parallel
 * and returns both lists keyed by role. The two hit different objects — sponsors
 * Attendee__c, delegates CventEvents__Attendee__c — so each list carries its own
 * record shape (see MeetingDataRecord / CventAttendeeRecord in the mapper).
 *
 * @param {string} eventCode - The internal event code (e.g. `"BMWS"`).
 * @returns {Promise<{ delegates: SfRecord[]; sponsors: SfRecord[] }>} The two record lists.
 */
export async function getMeetingDataByEvent(eventCode: string) {
    // Parallel because the two queries are independent.
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
