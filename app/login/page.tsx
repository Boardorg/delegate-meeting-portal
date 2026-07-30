"use client";

import "@/app/frontend.css";
import { Suspense, useEffect, useRef, useState, type SubmitEvent } from "react";
import Image from "next/image";
import { useRouter, useSearchParams } from "next/navigation";
import type { Channel } from "@/types";

// ---------------------------------------------------------------------------
// /login — two-step one-time-code login over phone or email.
//
// Step "contact": a single field accepts either a phone number or an email
//                 address. The channel is detected as the user types (an
//                 "@" means email) and confirmed back in the helper text —
//                 no separate toggle to tap. POST /api/auth/login sends the
//                 code over whichever channel was detected.
// Step "code":    the user enters the 6-digit code. A hidden input with
//                 autoComplete="one-time-code" backs the boxes so browser/OS
//                 SMS and email autofill still works, while the visible
//                 boxes give the same at-a-glance affordance as a bank or
//                 delivery app's code entry. POST /api/auth/verify checks it
//                 and sets the session cookie on success.
//
// On success we navigate to the `next` query param (the originally-requested
// page injected by proxy.ts) or the server's role-based default.
// ---------------------------------------------------------------------------

type Step = "contact" | "code";

const RESEND_COOLDOWN_SECONDS = 30;
const CODE_LENGTH = 6;

/**
 * Detects which channel a raw contact string looks like, or null while
 * it's still ambiguous. An "@" means email. Letters with no "@" yet could
 * still become an email address and can never be a phone number, so that
 * case stays undetermined rather than guessing "sms". Digits and phone
 * punctuation only (no letters, no "@") reads as an in-progress phone
 * number.
 *
 * @param {string} value - The raw, untrimmed contact input.
 * @returns {Channel | null} "email", "sms", or null while undetermined.
 */
function detectChannel(value: string): Channel | null {
    if (value.includes("@")) return "email";
    if (!value || /[a-zA-Z]/.test(value)) return null;
    return "sms";
}

/**
 * The login page wraps the form in a Suspense boundary because the form reads
 * `useSearchParams()`, which Next requires to be suspense-bounded so the
 * rest of the route can still be prerendered.
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
    // we fall back to the role-based default returned by /api/auth/verify.
    const explicitNext = searchParams.get("next");

    // Event code captured from the first visit (`?event=`, carried onto /login
    // by proxy.ts). Sent in the body of the auth requests so the server can
    // match against the right event and persist the code to the session.
    const event = searchParams.get("event")?.trim() || undefined;

    const [step, setStep] = useState<Step>("contact");
    const [contactInput, setContactInput] = useState("");
    const [sentContact, setSentContact] = useState("");
    const [sentChannel, setSentChannel] = useState<Channel>("sms");
    const [code, setCode] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [pending, setPending] = useState(false);
    const [resendSecondsLeft, setResendSecondsLeft] = useState(0);
    const [justResent, setJustResent] = useState(false);

    // Whether to show the event-code field on the contact step. Most logins
    // arrive via `?event=` and never need it; it's only revealed once the
    // server tells us the contact has no row in the portal's own users table
    // and can't be checked against Salesforce without one (see requestCode
    // below).
    const [needsEventCode, setNeedsEventCode] = useState(false);
    const [eventCodeInput, setEventCodeInput] = useState("");
    // The code link's event wins when present; otherwise fall back to
    // whatever the user typed once the field is revealed.
    const effectiveEventCode = event ?? (eventCodeInput.trim() || undefined);

    const codeInputRef = useRef<HTMLInputElement>(null);
    const eventCodeInputRef = useRef<HTMLInputElement>(null);

    // Counts the resend cooldown down to zero once a code has been sent.
    useEffect(() => {
        if (step !== "code" || resendSecondsLeft <= 0) return;
        const timer = setTimeout(
            () => setResendSecondsLeft((s) => s - 1),
            1000,
        );
        return () => clearTimeout(timer);
    }, [step, resendSecondsLeft]);

    // Focus the event-code field the moment it's revealed.
    useEffect(() => {
        if (needsEventCode) eventCodeInputRef.current?.focus();
    }, [needsEventCode]);

    const trimmedContact = contactInput.trim();
    const detectedChannel = detectChannel(trimmedContact);
    const helperText =
        detectedChannel === "email"
            ? "We'll email a code to this address."
            : detectedChannel === "sms"
              ? "We'll text a code to this number."
              : "Enter your phone number or email to get a code.";

    /**
     * Calls /api/auth/login for the given contact + channel. Shared by the
     * initial send and the resend button so both go through one code path.
     *
     * @param {string} contact - Raw or previously-confirmed contact value.
     * @param {Channel} channel - Which channel to send the code over.
     * @returns {Promise<boolean>} True if the code was sent successfully.
     */
    async function requestCode(
        contact: string,
        channel: Channel,
    ): Promise<boolean> {
        const res = await fetch("/api/auth/login", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ contact, channel, eventCode: effectiveEventCode }),
        });
        const data = await res.json();
        if (!res.ok) {
            if (data.eventCodeRequired) setNeedsEventCode(true);
            setError(data.error ?? "Could not send code.");
            return false;
        }
        setSentContact(data.contact);
        setSentChannel(data.channel);
        return true;
    }

    /** Handles the contact-entry submit: requests a code, then advances to the code step. */
    async function handleRequestCode(e: SubmitEvent<HTMLFormElement>) {
        e.preventDefault();
        setError(null);
        setPending(true);
        try {
            const ok = await requestCode(
                trimmedContact,
                detectedChannel ?? "sms",
            );
            if (ok) {
                setCode("");
                setStep("code");
                setResendSecondsLeft(RESEND_COOLDOWN_SECONDS);
                setTimeout(() => codeInputRef.current?.focus(), 0);
            }
        } catch {
            setError("Network error. Please try again.");
        } finally {
            setPending(false);
        }
    }

    /** Re-sends a code to the already-confirmed contact and restarts the cooldown. */
    async function handleResend() {
        setError(null);
        try {
            const ok = await requestCode(sentContact, sentChannel);
            if (ok) {
                setResendSecondsLeft(RESEND_COOLDOWN_SECONDS);
                setJustResent(true);
                setTimeout(() => setJustResent(false), 2000);
            }
        } catch {
            setError("Network error. Please try again.");
        }
    }

    /** Handles the code-entry submit: verifies the code, then navigates on success. */
    async function handleVerifyCode(e: SubmitEvent<HTMLFormElement>) {
        e.preventDefault();
        setError(null);
        setPending(true);
        try {
            const res = await fetch("/api/auth/verify", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    contact: sentContact,
                    channel: sentChannel,
                    code,
                    eventCode: effectiveEventCode,
                }),
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
                explicitNext ||
                (typeof data.redirectTo === "string" ? data.redirectTo : "/");
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
        <main className="login-page">
            <div className="login-card">
                <div className="login-brand">
                    <Image
                        className="brand-logo"
                        src="/assemble-logo.svg"
                        alt="Assemble"
                        width={152}
                        height={22}
                        priority
                    />
                </div>

                {step === "contact" ? (
                    <>
                        <div className="login-heading">
                            <span className="login-eyebrow">Sign in</span>
                            <h1 className="login-title">
                                Access your meeting preferences
                            </h1>
                        </div>
                        <form
                            className="login-form"
                            onSubmit={handleRequestCode}
                        >
                            <div className="login-field">
                                <label
                                    className="login-label"
                                    htmlFor="contact"
                                >
                                    Phone or email
                                </label>
                                <input
                                    id="contact"
                                    name="contact"
                                    type="text"
                                    autoComplete="username"
                                    placeholder="you@company.com or (555) 555-0123"
                                    required
                                    autoFocus
                                    className="login-input"
                                    value={contactInput}
                                    onChange={(e) =>
                                        setContactInput(e.target.value)
                                    }
                                />
                                <div
                                    className={`login-helper${detectedChannel ? " detected" : ""}`}
                                >
                                    {helperText}
                                </div>
                            </div>
                            {needsEventCode && (
                                <div className="login-field">
                                    <label
                                        className="login-label"
                                        htmlFor="eventCode"
                                    >
                                        Event code
                                    </label>
                                    <input
                                        ref={eventCodeInputRef}
                                        id="eventCode"
                                        name="eventCode"
                                        type="text"
                                        autoComplete="off"
                                        placeholder="e.g. SPRING2026"
                                        required
                                        className="login-input"
                                        value={eventCodeInput}
                                        onChange={(e) =>
                                            setEventCodeInput(e.target.value)
                                        }
                                    />
                                    <div className="login-helper detected">
                                        We couldn&apos;t find you without an
                                        event code.
                                    </div>
                                </div>
                            )}
                            <button
                                type="submit"
                                className="login-btn-primary"
                                disabled={
                                    pending ||
                                    !detectedChannel ||
                                    trimmedContact.length < 4 ||
                                    (needsEventCode &&
                                        !eventCodeInput.trim())
                                }
                            >
                                {pending ? "Sending…" : "Send code"}
                            </button>
                        </form>
                    </>
                ) : (
                    <>
                        <button
                            type="button"
                            className="login-back-link"
                            onClick={() => {
                                setStep("contact");
                                setCode("");
                                setError(null);
                            }}
                        >
                            ← Use a different phone or email
                        </button>
                        <div className="login-heading">
                            <span className="login-eyebrow">
                                Check your{" "}
                                {sentChannel === "email" ? "email" : "phone"}
                            </span>
                            <h1 className="login-title">Enter your code</h1>
                            <p className="login-lede">Sent to {sentContact}</p>
                        </div>
                        <form
                            className="login-form"
                            onSubmit={handleVerifyCode}
                        >
                            <div className="login-otp-wrap">
                                <input
                                    ref={codeInputRef}
                                    className="login-otp-native"
                                    type="text"
                                    inputMode="numeric"
                                    pattern="[0-9]*"
                                    autoComplete="one-time-code"
                                    maxLength={CODE_LENGTH}
                                    aria-label="One-time code"
                                    value={code}
                                    onChange={(e) =>
                                        setCode(
                                            e.target.value
                                                .replace(/\D/g, "")
                                                .slice(0, CODE_LENGTH),
                                        )
                                    }
                                />
                                <div
                                    className="login-otp-row"
                                    aria-hidden="true"
                                >
                                    {Array.from({ length: CODE_LENGTH }).map(
                                        (_, i) => (
                                            <div
                                                key={i}
                                                className={`login-otp-box${i === code.length ? " is-active" : ""}`}
                                            >
                                                {code[i] ?? ""}
                                            </div>
                                        ),
                                    )}
                                </div>
                            </div>
                            <button
                                type="submit"
                                className="login-btn-primary"
                                disabled={pending || code.length < CODE_LENGTH}
                            >
                                {pending ? "Verifying…" : "Verify"}
                            </button>
                            <div className="login-resend-row">
                                {resendSecondsLeft > 0 ? (
                                    <span className="login-resend-timer">
                                        Resend code in 0:
                                        {String(resendSecondsLeft).padStart(
                                            2,
                                            "0",
                                        )}
                                    </span>
                                ) : (
                                    <span />
                                )}
                                <button
                                    type="button"
                                    className="login-resend-btn"
                                    disabled={resendSecondsLeft > 0}
                                    onClick={handleResend}
                                >
                                    {justResent ? "Code resent" : "Resend code"}
                                </button>
                            </div>
                        </form>
                    </>
                )}

                {error && (
                    <p className="login-error" role="alert">
                        {error}
                    </p>
                )}
            </div>
        </main>
    );
}
