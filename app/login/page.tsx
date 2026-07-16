"use client";

import "@/app/frontend.css";
import { Suspense, useState, SubmitEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";

// ---------------------------------------------------------------------------
// /login — minimal two-step SMS one-time-code login.
//
// Step 1 ("phone"): user enters a phone number; POST /api/auth/login asks
//                   Twilio Verify to send an SMS code.
// Step 2 ("code"):  user enters the code; POST /api/auth/verify checks it and
//                   sets the session cookie on success.
//
// On success we navigate to the `next` query param (the originally-requested
// page injected by proxy.ts) or "/" as a safe default.
// ---------------------------------------------------------------------------

type Step = "phone" | "code";

/**
 * The login page wraps the form in a Suspense boundary because the form reads
 * `useSearchParams()` (next/event), which Next requires to be suspense-bounded
 * so the rest of the route can still be prerendered.
 */
export default function LoginPage() {
    return (
        <Suspense>
            <LoginForm />
        </Suspense>
    );
}

function LoginForm() {
    const router = useRouter();
    const searchParams = useSearchParams();

    // Where to send the user after a successful login. Proxy.ts adds `?next=`
    // when it redirects an unauthenticated request to /login, so if it's set
    // we honor it (the user was trying to go somewhere specific). Otherwise
    // we fall back to the role-based default returned by /api/auth/verify
    // (admins land on /admin, everyone else on /).
    const explicitNext = searchParams.get("next");

    // Event code captured from the first visit (`?event=`, carried onto /login
    // by proxy.ts). Sent in the body of the auth requests so the server can
    // match against the right event and persist the code to the session.
    const event = searchParams.get("event") ?? undefined;

    // UI state machine: which step we're on, what was entered, what the server
    // echoed back, and whether a request is in flight.
    const [step, setStep] = useState<Step>("phone");
    const [phoneInput, setPhoneInput] = useState("");
    const [normalizedPhone, setNormalizedPhone] = useState("");
    const [code, setCode] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [pending, setPending] = useState(false);

    /**
     * Handles the phone-entry submit: requests an SMS code, then advances to
     * the code-entry step using the server's normalized phone value.
     */
    async function handleRequestCode(e: SubmitEvent<HTMLFormElement>) {
        e.preventDefault();
        setError(null);
        setPending(true);
        try {
            const res = await fetch("/api/auth/login", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ phone: phoneInput, eventCode: event }),
            });
            const data = await res.json();
            if (!res.ok) {
                setError(data.error ?? "Could not send code.");
                return;
            }
            // Use the server-normalized phone on the verify call so both
            // requests reference the exact same E.164 string.
            setNormalizedPhone(data.phone);
            setStep("code");
        } catch {
            setError("Network error. Please try again.");
        } finally {
            setPending(false);
        }
    }

    /**
     * Handles the code-entry submit: verifies the code, then navigates to the
     * originally-requested page on success.
     */
    async function handleVerifyCode(e: SubmitEvent<HTMLFormElement>) {
        e.preventDefault();
        setError(null);
        setPending(true);
        try {
            const res = await fetch("/api/auth/verify", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ phone: normalizedPhone, code, eventCode: event }),
            });
            const data = await res.json();
            if (!res.ok) {
                setError(data.error ?? "Could not verify code.");
                return;
            }
            // Prefer the user's originally-requested page (if proxy.ts
            // injected one) over the role-based default suggested by the
            // server.
            const target =
                explicitNext || (typeof data.redirectTo === "string" ? data.redirectTo : "/");
            // router.refresh() ensures any server components re-render against
            // the now-authenticated cookie before/after the push.
            router.push(target);
            router.refresh();
        } catch {
            setError("Network error. Please try again.");
        } finally {
            setPending(false);
        }
    }

    return (
        <main className="login-main">
            <img
                src="https://placehold.co/200x80?text=Logo"
                alt="Logo"
                width={200}
                height={80}
                className="login-logo"
            />

            {step === "phone" ? (
                <form onSubmit={handleRequestCode}>
                    <label htmlFor="phone" className="login-label">
                        Phone number
                    </label>
                    <input
                        id="phone"
                        name="phone"
                        type="tel"
                        autoComplete="tel"
                        placeholder="+1 555 555 0123"
                        required
                        value={phoneInput}
                        onChange={(e) => setPhoneInput(e.target.value)}
                        className="login-input"
                    />
                    <button type="submit" disabled={pending} className="login-submit">
                        {pending ? "Sending…" : "Send code"}
                    </button>
                </form>
            ) : (
                <form onSubmit={handleVerifyCode}>
                    <p className="login-hint">
                        Enter the code sent to {normalizedPhone}.
                    </p>
                    <label htmlFor="code" className="login-label">
                        One-time code
                    </label>
                    <input
                        id="code"
                        name="code"
                        type="text"
                        inputMode="numeric"
                        autoComplete="one-time-code"
                        placeholder="123456"
                        required
                        value={code}
                        onChange={(e) => setCode(e.target.value)}
                        className="login-input login-input-code"
                    />
                    <button type="submit" disabled={pending} className="login-submit">
                        {pending ? "Verifying…" : "Verify"}
                    </button>
                    <button
                        type="button"
                        onClick={() => {
                            setStep("phone");
                            setCode("");
                            setError(null);
                        }}
                        className="login-linkbtn"
                    >
                        Use a different phone number
                    </button>
                </form>
            )}

            {error && (
                <p className="login-error" role="alert">
                    {error}
                </p>
            )}
        </main>
    );
}
