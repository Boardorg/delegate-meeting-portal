import { describe, expect, test } from "vitest";
import { ADMIN_NAV } from "./nav";

// ---------------------------------------------------------------------------
// The admin menu's groups and order.
// ---------------------------------------------------------------------------

describe("ADMIN_NAV", () => {
    test("puts a Delegate Meetings group after the sponsor pages and before Event Settings", () => {
        expect(ADMIN_NAV.map((i) => i.label)).toEqual([
            "Overview",
            "Sponsor Meetings",
            "Delegate Meetings",
            "Event Settings",
            "Users",
        ]);
        const group = ADMIN_NAV.find((i) => i.label === "Delegate Meetings")!;
        expect(group.href).toBeUndefined();
        expect(group.children?.map((c) => [c.label, c.href])).toEqual([
            ["Delegate Meetings", "/admin/delegate-meetings"],
            ["Roundtables", "/admin/roundtables"],
            ["Matching Settings", "/admin/matching-settings"],
        ]);
    });
});
