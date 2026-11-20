import { describe, test, expect, vi, beforeEach } from "vitest";
import { DEFAULT_MATCHING_SETTINGS } from "@/lib/matching/settings";

// ---------------------------------------------------------------------------
// saveMatchingSettings. The DB is mocked.
// ---------------------------------------------------------------------------

const setValues = vi.fn();
let returned: { code: string }[] = [{ code: "EVT" }];

vi.mock("@/lib/db/client", () => ({
    db: {
        update: () => ({
            set: (values: unknown) => {
                setValues(values);
                return { where: () => ({ returning: async () => returned }) };
            },
        }),
    },
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { saveMatchingSettings } from "./actions";

beforeEach(() => {
    vi.clearAllMocks();
    returned = [{ code: "EVT" }];
});

describe("saveMatchingSettings", () => {
    test("saves the reordered question list so a reload shows it", async () => {
        const reordered = {
            ...DEFAULT_MATCHING_SETTINGS,
            d2d: { ...DEFAULT_MATCHING_SETTINGS.d2d, questions: [...DEFAULT_MATCHING_SETTINGS.d2d.questions].reverse() },
        };

        const result = await saveMatchingSettings("EVT", reordered);

        expect(result.ok).toBe(true);
        const saved = setValues.mock.calls[0][0] as { matchingSettings: typeof reordered };
        expect(saved.matchingSettings.d2d.questions[0].id).toBe("budget_responsibility");
    });

    test("refuses bad settings with a message and saves nothing", async () => {
        const result = await saveMatchingSettings("EVT", {
            ...DEFAULT_MATCHING_SETTINGS,
            d2d: { ...DEFAULT_MATCHING_SETTINGS.d2d, capWithS2D: 2.5 },
        });

        expect(result.ok).toBe(false);
        expect(setValues).not.toHaveBeenCalled();
    });

    test("says so when the event doesn't exist", async () => {
        returned = [];
        expect(await saveMatchingSettings("NOPE", DEFAULT_MATCHING_SETTINGS)).toEqual({
            ok: false,
            error: "Error: event not found",
        });
    });
});
