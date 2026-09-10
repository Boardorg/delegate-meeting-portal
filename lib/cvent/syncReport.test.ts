import { describe, it, expect } from "vitest";
import {
    buildSyncReport,
    classifyPushError,
    isAppointmentAlreadyGone,
    parseCventError,
    type MeetingSyncOutcome,
} from "./syncReport";

// A minimal stand-in for a Cvent SDK error: an Error carrying `statusCode` and
// a raw JSON `body`, matching what push.ts duck-types against.
function cventError(
    message: string,
    statusCode?: number,
    body?: unknown,
): Error {
    return Object.assign(new Error(message), { statusCode, body });
}

describe("parseCventError", () => {
    it("extracts message and code from a JSON body", () => {
        const body = JSON.stringify({
            message: "no more appointments",
            code: "NO_MORE_APPT_AT_THIS_TIME_FOR_HOST",
        });
        expect(parseCventError(body)).toEqual({
            message: "no more appointments",
            code: "NO_MORE_APPT_AT_THIS_TIME_FOR_HOST",
        });
    });

    it("returns nulls for non-JSON, empty, or non-string bodies", () => {
        expect(parseCventError("not json")).toEqual({ message: null, code: null });
        expect(parseCventError("")).toEqual({ message: null, code: null });
        expect(parseCventError(undefined)).toEqual({ message: null, code: null });
    });
});

describe("classifyPushError", () => {
    it("maps HTTP statuses to reasons", () => {
        expect(classifyPushError(cventError("x", 401))).toBe("cvent_auth");
        expect(classifyPushError(cventError("x", 403))).toBe("cvent_auth");
        expect(classifyPushError(cventError("x", 404))).toBe("cvent_not_found");
        expect(classifyPushError(cventError("x", 429))).toBe("cvent_rate_limited");
        expect(classifyPushError(cventError("x", 400))).toBe("cvent_validation");
        expect(classifyPushError(cventError("x", 422))).toBe("cvent_validation");
        expect(classifyPushError(cventError("x", 500))).toBe("cvent_server_error");
        expect(classifyPushError(cventError("x", 503))).toBe("cvent_server_error");
    });

    it("distinguishes a full-host 409 from a plain conflict via the code", () => {
        const full = cventError(
            "conflict",
            409,
            JSON.stringify({ code: "NO_MORE_APPT_AT_THIS_TIME_FOR_HOST" }),
        );
        expect(classifyPushError(full)).toBe("cvent_no_availability");

        const conflict = cventError(
            "conflict",
            409,
            JSON.stringify({ code: "DUPLICATE_CODE" }),
        );
        expect(classifyPushError(conflict)).toBe("cvent_conflict");
    });

    it("treats a status-less transport failure as a network error", () => {
        expect(classifyPushError(new Error("fetch failed"))).toBe("network_error");
        expect(classifyPushError(new Error("connect ETIMEDOUT"))).toBe(
            "network_error",
        );
    });

    it("falls back to unknown for non-errors and unmapped statuses", () => {
        expect(classifyPushError("just a string")).toBe("unknown");
        expect(classifyPushError(cventError("teapot", 418))).toBe("unknown");
        expect(classifyPushError(new Error("something odd"))).toBe("unknown");
    });
});

describe("isAppointmentAlreadyGone", () => {
    it("treats a 404 as already gone", () => {
        expect(isAppointmentAlreadyGone(cventError("x", 404))).toBe(true);
    });

    it("detects Cvent's already-cancelled message", () => {
        const err = cventError(
            "bad request",
            400,
            JSON.stringify({ message: "This appointment has been cancelled." }),
        );
        expect(isAppointmentAlreadyGone(err)).toBe(true);
    });

    it("detects not-found / does-not-exist wording", () => {
        expect(
            isAppointmentAlreadyGone(
                cventError("x", 400, JSON.stringify({ message: "Appointment does not exist" })),
            ),
        ).toBe(true);
        expect(
            isAppointmentAlreadyGone(new Error("no such appointment")),
        ).toBe(true);
    });

    it("is false for genuine failures and non-errors", () => {
        expect(isAppointmentAlreadyGone(cventError("host full", 409))).toBe(false);
        expect(isAppointmentAlreadyGone(cventError("server error", 500))).toBe(false);
        expect(isAppointmentAlreadyGone("just a string")).toBe(false);
    });
});

describe("buildSyncReport", () => {
    const results: MeetingSyncOutcome[] = [
        { meetingId: "m1", label: "A & B", ok: true, kind: "create" },
        { meetingId: "m2", label: "C & D", ok: true, kind: "update" },
        {
            meetingId: "m3",
            label: "E & F",
            ok: true,
            kind: "create",
            warning: "target not linked",
        },
        {
            meetingId: "m4",
            label: "G & H",
            ok: false,
            kind: "create",
            reason: "cvent_no_availability",
            error: "host full",
        },
        {
            meetingId: "m5",
            label: "I & J",
            ok: false,
            kind: "update",
            // reason intentionally omitted to test the fallback
            error: "mystery",
        },
    ];

    it("tallies created/updated/failed and splits failures + warnings", () => {
        const report = buildSyncReport({
            eventCode: "BMWS",
            generatedAt: "2026-07-27T00:00:00.000Z",
            totalPortalMeetings: 8,
            alreadySynced: 3,
            results,
        });

        expect(report.totalPortalMeetings).toBe(8);
        expect(report.alreadySynced).toBe(3);
        expect(report.attempted).toBe(5);
        expect(report.created).toBe(2);
        expect(report.updated).toBe(1);
        expect(report.succeeded).toBe(3);
        expect(report.failed).toBe(2);

        expect(report.warnings).toEqual([
            { meetingId: "m3", label: "E & F", detail: "target not linked" },
        ]);

        expect(report.failures).toEqual([
            {
                meetingId: "m4",
                label: "G & H",
                reason: "cvent_no_availability",
                detail: "host full",
            },
            {
                meetingId: "m5",
                label: "I & J",
                reason: "unknown",
                detail: "mystery",
            },
        ]);
    });

    it("is fully JSON-serializable", () => {
        const report = buildSyncReport({
            eventCode: "BMWS",
            generatedAt: "2026-07-27T00:00:00.000Z",
            totalPortalMeetings: 0,
            alreadySynced: 0,
            results: [],
        });
        expect(JSON.parse(JSON.stringify(report))).toEqual(report);
    });
});
