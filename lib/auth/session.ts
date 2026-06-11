import "server-only";
import { cookies } from "next/headers";
import { SignJWT, jwtVerify, type JWTPayload } from "jose";

// ---------------------------------------------------------------------------
// Module configuration and constants
// ---------------------------------------------------------------------------

// Name of the cookie that carries the signed session JWT.
export const SESSION_COOKIE = "dmp_session";

// Session lifetime, 1 week.
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// Shape of the data we sign into the session JWT.
export type SessionPayload = JWTPayload & {
    phone: string;
    issuedAt: number;
    // Event code captured from the `?event=` query param at login.
    eventCode?: string;
};

/**
 * Loads and validates SESSION_SECRET from the environment
 *
 * @returns {Uint8Array} The encoded secret key.
 */
function encodedSecret(): Uint8Array {
    const secret = process.env.SESSION_SECRET;
    if (!secret) {
        throw new Error(
            "Missing SESSION_SECRET env var — required to sign session cookies.",
        );
    }
    return new TextEncoder().encode(secret);
}

// ---------------------------------------------------------------------------
// JWT encrypt/decrypt
// ---------------------------------------------------------------------------

/**
 * Signs the given payload as an HS256 JWT with a fixed expiry. The returned
 * string is what gets stored in the session cookie.
 *
 * @param {SessionPayload} payload - Claims to embed in the token.
 * @returns {Promise<string>} The signed JWT.
 */
export async function encryptSession(payload: SessionPayload): Promise<string> {
    return new SignJWT(payload)
        .setProtectedHeader({ alg: "HS256" })
        .setIssuedAt()
        .setExpirationTime(new Date(Date.now() + SESSION_TTL_MS))
        .sign(encodedSecret());
}

/**
 * Verifies and decodes a session JWT. Returns null on any failure (missing,
 * tampered, or expired) so callers can treat all invalid sessions uniformly.
 *
 * @param {string | undefined} token - The raw cookie value, if present.
 * @returns {Promise<SessionPayload | null>} The decoded payload, or null.
 */
export async function decryptSession(
    token: string | undefined,
): Promise<SessionPayload | null> {
    if (!token) return null;
    try {
        const { payload } = await jwtVerify<SessionPayload>(
            token,
            encodedSecret(),
            { algorithms: ["HS256"] },
        );
        return payload;
    } catch {
        // Invalid signature, expired, malformed — all surface as "no session".
        return null;
    }
}

/**
 * Reads and verifies the session cookie, returning its payload or null. A
 * convenience wrapper over `decryptSession` for callers that just need the
 * current session without juggling the cookie jar themselves.
 *
 * @returns {Promise<SessionPayload | null>} The current session, or null.
 */
export async function getSession(): Promise<SessionPayload | null> {
    const jar = await cookies();
    return decryptSession(jar.get(SESSION_COOKIE)?.value);
}

// ---------------------------------------------------------------------------
// Cookie management (server-side only)
// ---------------------------------------------------------------------------

/**
 * Creates a new session for the given phone number and writes the signed JWT
 * to the `session` cookie. Called from the verify route after Twilio confirms
 * the one-time code.
 *
 * @param {string} phone - E.164-normalized phone number to associate with the session.
 * @param {string} [eventCode] - Event code from the login URL to persist for the session's lifetime.
 * @returns {Promise<void>}
 */
export async function createSession(
    phone: string,
    eventCode?: string,
): Promise<void> {
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
    const token = await encryptSession({ phone, issuedAt: Date.now(), eventCode });

    // HttpOnly so client JS can't read it; Secure so it only goes over HTTPS
    // in production; SameSite=lax keeps it out of cross-site POSTs while still
    // allowing top-level navigation.
    const jar = await cookies();
    jar.set(SESSION_COOKIE, token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        expires: expiresAt,
        sameSite: "lax",
        path: "/",
    });
}

/**
 * Removes the session cookie, effectively logging the user out.
 *
 * @returns {Promise<void>}
 */
export async function destroySession(): Promise<void> {
    const jar = await cookies();
    jar.delete(SESSION_COOKIE);
}
