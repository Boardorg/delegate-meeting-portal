"use client";

import "@/app/frontend.css";
import { useState, SubmitEvent } from "react";
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

export default function LoginPage() {
    const router = useRouter();
    const searchParams = useSearchParams();

    // Where to send the user after a successful login. Proxy.ts adds `?next=`
    // when it redirects an unauthenticated request to /login.
    const next = searchParams.get("next") || "/";

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
                body: JSON.stringify({ phone: phoneInput }),
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
                body: JSON.stringify({ phone: normalizedPhone, code }),
            });
            const data = await res.json();
            if (!res.ok) {
                setError(data.error ?? "Could not verify code.");
                return;
            }
            // router.refresh() ensures any server components re-render against
            // the now-authenticated cookie before/after the push.
            router.push(next);
            router.refresh();
        } catch {
            setError("Network error. Please try again.");
        } finally {
            setPending(false);
        }
    }

    return (
        <main
            style={{
                fontFamily: "sans-serif",
                maxWidth: 360,
                margin: "80px auto",
                padding: "0 24px",
                textAlign: "center",
            }}
        >
            <img
                src="https://placehold.co/200x80?text=Logo"
                alt="Logo"
                width={200}
                height={80}
                style={{ marginBottom: 32 }}
            />

            {step === "phone" ? (
                <form onSubmit={handleRequestCode}>
                    <label
                        htmlFor="phone"
                        style={{ display: "block", marginBottom: 8 }}
                    >
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
                        style={{
                            width: "100%",
                            padding: "10px 12px",
                            fontSize: 16,
                            boxSizing: "border-box",
                        }}
                    />
                    <button
                        type="submit"
                        disabled={pending}
                        style={{
                            marginTop: 16,
                            width: "100%",
                            padding: "10px 12px",
                            fontSize: 16,
                        }}
                    >
                        {pending ? "Sending…" : "Send code"}
                    </button>
                </form>
            ) : (
                <form onSubmit={handleVerifyCode}>
                    <p style={{ marginBottom: 16, color: "#555" }}>
                        Enter the code sent to {normalizedPhone}.
                    </p>
                    <label
                        htmlFor="code"
                        style={{ display: "block", marginBottom: 8 }}
                    >
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
                        style={{
                            width: "100%",
                            padding: "10px 12px",
                            fontSize: 16,
                            boxSizing: "border-box",
                            letterSpacing: 4,
                            textAlign: "center",
                        }}
                    />
                    <button
                        type="submit"
                        disabled={pending}
                        style={{
                            marginTop: 16,
                            width: "100%",
                            padding: "10px 12px",
                            fontSize: 16,
                        }}
                    >
                        {pending ? "Verifying…" : "Verify"}
                    </button>
                    <button
                        type="button"
                        onClick={() => {
                            setStep("phone");
                            setCode("");
                            setError(null);
                        }}
                        style={{
                            marginTop: 8,
                            background: "none",
                            border: "none",
                            color: "#0070f3",
                            cursor: "pointer",
                        }}
                    >
                        Use a different phone number
                    </button>
                </form>
            )}

            {error && (
                <p style={{ color: "#c00", marginTop: 16 }} role="alert">
                    {error}
                </p>
            )}
        </main>
    );
}
