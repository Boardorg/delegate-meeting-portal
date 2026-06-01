import { NextRequest, NextResponse } from "next/server";

//Validation that will run before any api routes.
export function proxy(request: NextRequest) {
    //get the key
    const key = request.headers.get("api_key");

    if (!key) {
        return NextResponse.json(
            { error: "Authentication required. Please provide an API key" },
            { status: 401 },
        );
    }

    // Verify api key
    const validated = key === process.env.API_KEY;

    if (validated) {
        return NextResponse.next();
    } else {
        return NextResponse.json({ error: "Invalid API Key" }, { status: 401 });
    }
}

export const config = {
    matcher: "/api/:path*",
};
