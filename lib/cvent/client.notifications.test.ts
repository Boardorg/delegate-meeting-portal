import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Cvent emails participants when an appointment is cancelled, unless the call suppresses it.
// Unpush and Remove both cancel, so they must honor CVENT_SUPPRESS_NOTIFICATIONS like create and update.
// The SDK is mocked at the module boundary, so the real cancel code in client.ts runs.
// ---------------------------------------------------------------------------

const cancelAppointmentSdk = vi.fn();

vi.mock("@cvent/sdk", () => ({
    CventSDK: class {
        appointments = {
            cancelAppointment: (...a: unknown[]) => cancelAppointmentSdk(...a),
        };
    },
}));
vi.mock("@/lib/events/settings", () => ({
    getEventSettings: async () => ({ cventAppointmentEventId: "ae-1" }),
}));

import { cancelAppointment } from "./client";

beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("USE_MOCK", "false");
    vi.stubEnv("CVENT_CLIENT_ID", "test-id");
    vi.stubEnv("CVENT_CLIENT_SECRET", "test-secret");
});

afterEach(() => {
    vi.unstubAllEnvs();
});

describe("cancelAppointment notifications", () => {
    test("suppresses Cvent's cancellation emails when CVENT_SUPPRESS_NOTIFICATIONS is true", async () => {
        vi.stubEnv("CVENT_SUPPRESS_NOTIFICATIONS", "true");
        await cancelAppointment("NALES", "appt-1");
        expect(cancelAppointmentSdk).toHaveBeenCalledWith({
            id: "ae-1",
            apptId: "appt-1",
            suppressNotifications: true,
        });
    });

    test("lets Cvent send its emails when the setting is off", async () => {
        vi.stubEnv("CVENT_SUPPRESS_NOTIFICATIONS", "false");
        await cancelAppointment("NALES", "appt-1");
        expect(cancelAppointmentSdk).toHaveBeenCalledWith({
            id: "ae-1",
            apptId: "appt-1",
            suppressNotifications: false,
        });
    });
});
