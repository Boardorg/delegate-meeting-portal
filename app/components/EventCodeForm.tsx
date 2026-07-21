"use client";

import { useState, type SubmitEvent } from "react";
import { useRouter } from "next/navigation";

// ---------------------------------------------------------------------------
// EventCodeForm — shown on "/" when the logged-in session has no event code
// attached (no `?event=` was present at login). Lets the user type the code
// from their event email instead of being sent back through OTP login.
// POST /api/auth/event re-validates the code against Salesforce before
// attaching it to the session.
// ---------------------------------------------------------------------------

/**
 * Small form that submits a manually-entered event code to
 * `/api/auth/event` and refreshes the page on success so the server
 * components re-render with the now-complete session.
 */
export default function EventCodeForm() {
    const router = useRouter();
    const [eventCode, setEventCode] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [pending, setPending] = useState(false);

    async function handleSubmit(e: SubmitEvent<HTMLFormElement>) {
        e.preventDefault();
        setError(null);
        setPending(true);
        try {
            const res = await fetch("/api/auth/event", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ eventCode: eventCode.trim() }),
            });
            const data = await res.json();
            if (!res.ok) {
                setError(data.error ?? "Could not set event code.");
                return;
            }
            router.refresh();
        } catch {
            setError("Network error. Please try again.");
        } finally {
            setPending(false);
        }
    }

    return (
        <form className="login-form" onSubmit={handleSubmit}>
            <div className="login-field">
                <label className="login-label" htmlFor="eventCode">
                    Event code
                </label>
                <input
                    id="eventCode"
                    name="eventCode"
                    type="text"
                    autoComplete="off"
                    placeholder="e.g. SPRING2026"
                    required
                    autoFocus
                    className="login-input"
                    value={eventCode}
                    onChange={(e) => setEventCode(e.target.value)}
                />
            </div>
            <button
                type="submit"
                className="login-btn-primary"
                disabled={pending || eventCode.trim().length === 0}
            >
                {pending ? "Checking…" : "Continue"}
            </button>
            {error && (
                <p className="login-error" role="alert">
                    {error}
                </p>
            )}
        </form>
    );
}
