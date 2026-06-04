import { NextRequest, NextResponse } from "next/server";
import { decryptSession, SESSION_COOKIE } from "@/lib/auth/session";

// ---------------------------------------------------------------------------
// proxy.ts — runs before every page and API route.
// ---------------------------------------------------------------------------

// Page paths that are always reachable without a session. /login is the form itself.
const PUBLIC_PAGE_PATHS = ["/login"];

// /api/* paths that are exempt from the API_KEY header check.
const PUBLIC_API_PATHS = [
    "/api/auth/login",
    "/api/auth/verify",
    "/api/auth/logout",
];

/**
 * Validates the incoming request based on its path: API key for /api/*,
 * session cookie for everything else.
 *
 * @param {NextRequest} request - The incoming request.
 * @returns {Promise<NextResponse>} Either a passthrough, a redirect to /login, or a 401.
 */
export async function proxy(request: NextRequest) {
    const { pathname } = request.nextUrl;

    // ----- API routes -----
    if (pathname.startsWith("/api/")) {
        // Browser-facing auth endpoints don't require the integration API key.
        if (PUBLIC_API_PATHS.includes(pathname)) {
            return NextResponse.next();
        }

        // Server-to-server integrations: API key header takes priority.
        const key = request.headers.get("api_key");
        if (key) {
            if (key !== process.env.API_KEY) {
                return NextResponse.json(
                    { error: "Invalid API Key" },
                    { status: 401 },
                );
            }
            return NextResponse.next();
        }

        // Browser-initiated requests (e.g. from the sponsor catalog) may
        // authenticate with the session cookie instead of an API key.
        const token = request.cookies.get(SESSION_COOKIE)?.value;
        const session = await decryptSession(token);
        if (session || process.env.DISABLE_FRONT_END_LOGIN === "true") {
            return NextResponse.next();
        }

        return NextResponse.json(
            { error: "Authentication required. Please provide an API key" },
            { status: 401 },
        );
    }

    // ----- Frontend pages -----

    // Allow listed public pages straight through (login form, etc.).
    if (
        PUBLIC_PAGE_PATHS.includes(pathname) ||
        process.env.DISABLE_FRONT_END_LOGIN === "true"
    ) {
        return NextResponse.next();
    }

    // Read and verify the session cookie. decryptSession returns null for
    // missing, tampered, or expired tokens — all of which we treat the same.
    const token = request.cookies.get(SESSION_COOKIE)?.value;
    const session = await decryptSession(token);

    if (!session) {
        // Preserve the originally-requested URL so login can bounce the user
        // back to it on success.
        const loginUrl = new URL("/login", request.url);
        loginUrl.searchParams.set("next", pathname + request.nextUrl.search);
        return NextResponse.redirect(loginUrl);
    }

    return NextResponse.next();
}

// Run on all routes except Next.js internals and common static asset files.
export const config = {
    matcher: [
        "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|jpeg|svg|gif|webp|ico)$).*)",
    ],
};
