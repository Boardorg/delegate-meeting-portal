import { NextResponse } from "next/server";
import { authenticate } from "@/lib/salesforce/client";

/**
 * GET /api/salesforce/auth
 *
 * Health-check endpoint that exercises the Salesforce OAuth Client Credentials
 * flow without performing any data queries. Useful for confirming env vars
 * are set correctly and the Connected App is reachable from this environment.
 *
 * @returns {Response} `{ status: 'connected', instanceUrl }` on success, or
 *   `{ status: 'error', message }` with HTTP 500 on failure.
 */
export async function GET() {
    try {
        // authenticate() returns the cached token (or fetches a fresh one) and the
        // Salesforce instance URL. We only surface the instance URL to confirm
        // identity — never return the access token itself.
        const { instanceUrl } = await authenticate();
        return NextResponse.json({ status: "connected", instanceUrl });
    } catch (err) {
        // Surface the underlying error message so misconfiguration is debuggable.
        return NextResponse.json(
            { status: "error", message: String(err) },
            { status: 500 },
        );
    }
}
