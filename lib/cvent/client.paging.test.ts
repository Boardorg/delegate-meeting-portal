import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Paging through the event's appointment list when Cvent's response fails SDK validation.
// NALES has more than 100 appointments, so push's type lookup must read every page.
// The SDK is mocked at the module boundary, so the real paging code in client.ts runs.
// ---------------------------------------------------------------------------

const listAppointments = vi.fn();

vi.mock("@cvent/sdk", () => ({
    CventSDK: class {
        appointments = {
            listAppointments: (...a: unknown[]) => listAppointments(...a),
        };
    },
}));
vi.mock("@/lib/events/settings", () => ({
    getEventSettings: async () => ({ cventAppointmentEventId: "ae-1" }),
}));

import { getAppointmentsByEvent } from "./client";
import { existingAppointmentLookup } from "./push";

/**
 * Builds one raw listed appointment, as Cvent sends it.
 *
 * @param {string} id - The appointment id.
 * @param {string} typeName - The appointment type's name.
 * @returns {object} The raw appointment.
 */
function rawAppointment(id: string, typeName: string) {
    return {
        id,
        start: "2026-01-20T10:00:00Z",
        end: "2026-01-20T10:20:00Z",
        location: { name: "Booth 1" },
        type: { name: typeName },
    };
}

/**
 * Builds the error the SDK throws when a 2xx body fails its response validation.
 *
 * @param {unknown} body - The raw response body Cvent sent.
 * @returns {Error} The SDK-shaped error carrying the status and raw body.
 */
function validationError(body: unknown): Error {
    return Object.assign(new Error("Response validation failed"), {
        statusCode: 200,
        body: JSON.stringify(body),
    });
}

// A full first page of 100 appointments, none of them the target.
const PAGE_ONE = Array.from({ length: 100 }, (_, i) =>
    rawAppointment(`appt-${i + 1}`, "Delegate Group Meetings"),
);

beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("USE_MOCK", "false");
    vi.stubEnv("CVENT_CLIENT_ID", "test-id");
    vi.stubEnv("CVENT_CLIENT_SECRET", "test-secret");
});

afterEach(() => {
    vi.unstubAllEnvs();
});

describe("appointment list paging when a page fails SDK validation", () => {
    test("reads the second page by following the token in the failed first page's raw body", async () => {
        listAppointments.mockImplementation(async (req: { token?: string }) => {
            if (!req.token) {
                throw validationError({ data: PAGE_ONE, paging: { nextToken: "tok-2" } });
            }
            return {
                result: {
                    data: [
                        {
                            ...rawAppointment("target", "Sponsor to Delegate Meetings"),
                            start: new Date("2026-01-20T10:00:00Z"),
                            end: new Date("2026-01-20T10:20:00Z"),
                        },
                    ],
                    paging: {},
                },
            };
        });

        const appointments = await getAppointmentsByEvent("NALES");

        expect(appointments).toHaveLength(101);
        expect(listAppointments).toHaveBeenCalledTimes(2);
        expect(listAppointments.mock.calls[1][0]).toMatchObject({ token: "tok-2" });
        expect(appointments.find((a) => a.id === "target")?.typeName).toBe(
            "Sponsor to Delegate Meetings",
        );
    });

    test("push's lookup finds an appointment's type and time on the second page when both pages fail validation", async () => {
        listAppointments.mockImplementation(async (req: { token?: string }) => {
            if (!req.token) {
                throw validationError({ data: PAGE_ONE, paging: { nextToken: "tok-2" } });
            }
            throw validationError({
                data: [rawAppointment("target", "Sponsor to Delegate Meetings")],
                paging: {},
            });
        });

        const existingAppointmentOf = existingAppointmentLookup("NALES");

        expect(await existingAppointmentOf("target")).toEqual({
            startTime: new Date("2026-01-20T10:00:00Z"),
            typeName: "Sponsor to Delegate Meetings",
        });
        expect((await existingAppointmentOf("appt-1"))?.typeName).toBe("Delegate Group Meetings");
        expect(await existingAppointmentOf("not-listed")).toBeNull();
        // The list is read once and shared by every lookup.
        expect(listAppointments).toHaveBeenCalledTimes(2);
    });
});
