import "server-only";
import { getSession } from "@/lib/auth/session";

/**
 * Resolves the active event code for a request that has session context
 * (server components, post-login route handlers).
 *
 * Resolution order:
 *   1. `SF_EVENT_CODE` env var — pins a deployment to a single event.
 *   2. The `eventCode` saved on the session cookie at login — lets one
 *      deployment serve multiple events off the same URL via `?event=`.
 *
 * The login flow is the one caller that runs before a session exists; it reads
 * the event code from the request body and passes it explicitly instead.
 *
 * @returns {Promise<string>} The resolved event code.
 * @throws {Error} When neither source provides a code.
 */
export async function getEventCode(): Promise<string> {
    const fromEnv = process.env.SF_EVENT_CODE;
    if (fromEnv) return fromEnv;

    const session = await getSession();
    if (session?.eventCode) return session.eventCode;

    throw new Error(
        "No event code available — set SF_EVENT_CODE or log in with an `?event=` query param.",
    );
}
