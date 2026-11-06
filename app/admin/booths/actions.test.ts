import { describe, test, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Saving a manual booth mapping on the Sponsor booths page.
// The DB and the Cvent schedule loader are mocked, so the tests can see what each save writes.
// ---------------------------------------------------------------------------

const updateSet = vi.fn();
const loadEventScheduleData = vi.fn();

vi.mock("@/lib/db/client", () => ({
    db: {
        update: () => ({
            set: (patch: unknown) => {
                updateSet(patch);
                return {
                    where: () => ({ returning: async () => [{ code: "NALES" }] }),
                };
            },
        }),
    },
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/cvent/mapper", () => ({
    loadEventScheduleData: (...a: unknown[]) => loadEventScheduleData(...a),
}));

import { saveBoothMapping } from "./actions";

beforeEach(() => {
    vi.clearAllMocks();
    loadEventScheduleData.mockResolvedValue({
        locations: [
            { id: "loc-booth-3", name: "Booth 3", capacity: Infinity, parentLocationId: null },
            { id: "loc-booth-5", name: "Booth 5", capacity: Infinity, parentLocationId: null },
        ],
    });
});

describe("saveBoothMapping", () => {
    test("returns an error and saves nothing for a location id the event doesn't have", async () => {
        const result = await saveBoothMapping({
            eventCode: "NALES",
            boothNo: "3",
            locationId: "loc-from-another-event",
        });

        expect(result.ok).toBe(false);
        expect(updateSet).not.toHaveBeenCalled();
    });

    test("returns an error and saves nothing when Cvent can't be reached to check the location", async () => {
        loadEventScheduleData.mockResolvedValue({ locations: [] });

        const result = await saveBoothMapping({ eventCode: "NALES", boothNo: "3", locationId: "loc-booth-5" });

        expect(result.ok).toBe(false);
        expect(updateSet).not.toHaveBeenCalled();
    });

    test("returns an error and saves nothing for a blank booth number", async () => {
        const result = await saveBoothMapping({ eventCode: "NALES", boothNo: "  ", locationId: null });

        expect(result.ok).toBe(false);
        expect(updateSet).not.toHaveBeenCalled();
    });

    test("saves a mapping to one of the event's locations", async () => {
        const result = await saveBoothMapping({ eventCode: "NALES", boothNo: " 3 ", locationId: "loc-booth-5" });

        expect(result).toEqual({ ok: true });
        expect(updateSet).toHaveBeenCalledTimes(1);
        expect(Object.keys(updateSet.mock.calls[0][0])).toEqual(["boothLocations", "updatedAt"]);
    });

    test("removes a mapping without checking Cvent", async () => {
        const result = await saveBoothMapping({ eventCode: "NALES", boothNo: "3", locationId: null });

        expect(result).toEqual({ ok: true });
        expect(loadEventScheduleData).not.toHaveBeenCalled();
        expect(updateSet).toHaveBeenCalledTimes(1);
    });
});
