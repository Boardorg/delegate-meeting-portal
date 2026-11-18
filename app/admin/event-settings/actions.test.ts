import { describe, test, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Saving the appointment-type mapping in Event settings.
// The DB is mocked, so the tests can see what each save would write.
// ---------------------------------------------------------------------------

const updateSet = vi.fn();
const insertValues = vi.fn();

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
        insert: () => ({
            values: (row: unknown) => {
                insertValues(row);
                return { returning: async () => [{ code: "NEW" }] };
            },
        }),
    },
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/app/admin/actions", () => ({ setActiveEvent: vi.fn() }));

import { createEvent, updateEvent } from "./actions";

/**
 * Reads the patch the last update would have written.
 *
 * @returns {Record<string, unknown>} The patch passed to db.update().set().
 */
function lastPatch(): Record<string, unknown> {
    return updateSet.mock.calls[updateSet.mock.calls.length - 1][0];
}

beforeEach(() => {
    vi.clearAllMocks();
});

describe("updateEvent — appointment-type mapping", () => {
    test("saves a mapping with only sponsor_delegate set", async () => {
        const result = await updateEvent("NALES", {
            appointmentTypeKinds: { "t-s2d": "sponsor_delegate" },
        });

        expect(result.ok).toBe(true);
        expect(lastPatch().appointmentTypeKinds).toEqual({
            "t-s2d": "sponsor_delegate",
        });
    });

    test("rejects an unknown kind value and writes nothing", async () => {
        const result = await updateEvent("NALES", {
            appointmentTypeKinds: { "t-s2d": "sponsor_sponsor" },
        });

        expect(result.ok).toBe(false);
        expect(!result.ok && result.error).toContain("sponsor_sponsor");
        expect(updateSet).not.toHaveBeenCalled();
    });

    test("leaves the stored mapping alone when the save doesn't include one", async () => {
        const result = await updateEvent("NALES", { name: "NALES 2027" });

        expect(result.ok).toBe(true);
        expect("appointmentTypeKinds" in lastPatch()).toBe(false);
    });

    test("clears the mapping when every type is set back to not mapped", async () => {
        await updateEvent("NALES", { appointmentTypeKinds: {} });

        expect(lastPatch().appointmentTypeKinds).toBeNull();
    });
});

describe("createEvent — appointment-type mapping", () => {
    test("rejects an unknown kind value and creates nothing", async () => {
        const result = await createEvent({
            code: "NEW",
            appointmentTypeKinds: { "t-1": "bogus" },
        });

        expect(result.ok).toBe(false);
        expect(insertValues).not.toHaveBeenCalled();
    });
});
