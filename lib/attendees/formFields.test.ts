import { describe, test, expect } from "vitest";
import {
    buildFormFields,
    coreKeyForLabel,
    isCoreKey,
    CORE_FIELD_KEYS,
    INDUSTRIES_KEY,
    type PicklistFieldDef,
} from "./formFields";

// ---------------------------------------------------------------------------
// Dynamic intake-form field model.
//
// Covers the label→core-key matching and the value shaping (multipicklist
// splitting, empty skipping, core vs. non-core keying) that turns described
// Salesforce picklist fields + a delegate's raw answers into AttendeeFormField[].
// ---------------------------------------------------------------------------

describe("coreKeyForLabel", () => {
    test("maps each core form label to its stable key", () => {
        expect(coreKeyForLabel("Company Size")).toBe("companySize");
        expect(coreKeyForLabel("Annual Revenue")).toBe("annualRevenue");
        expect(coreKeyForLabel("Budget Responsibility")).toBe(
            "budgetResponsibility",
        );
        expect(coreKeyForLabel("Planned Investment")).toBe("plannedInvestment");
        expect(coreKeyForLabel("Systems and Platforms")).toBe(
            "systemsAndPlatforms",
        );
        expect(coreKeyForLabel("Current Focus Topics")).toBe(
            "currentFocusTopics",
        );
    });

    test("is case- and whitespace-insensitive", () => {
        expect(coreKeyForLabel("  annual   REVENUE ")).toBe("annualRevenue");
    });

    test("returns undefined for non-core labels", () => {
        expect(coreKeyForLabel("Regions Overseen")).toBeUndefined();
        expect(coreKeyForLabel("")).toBeUndefined();
    });

    test("does not match Industries (Account-derived, not a form question)", () => {
        // Industries has no `match` in CORE_FIELDS; it's keyed directly upstream.
        expect(coreKeyForLabel("Industries")).toBeUndefined();
    });
});

describe("core key set + order", () => {
    test("CORE_FIELD_KEYS is the requested column order, Industries last", () => {
        expect(CORE_FIELD_KEYS).toEqual([
            "companySize",
            "annualRevenue",
            "budgetResponsibility",
            "plannedInvestment",
            "systemsAndPlatforms",
            "currentFocusTopics",
            INDUSTRIES_KEY,
        ]);
    });

    test("isCoreKey reflects membership", () => {
        expect(isCoreKey("annualRevenue")).toBe(true);
        expect(isCoreKey(INDUSTRIES_KEY)).toBe(true);
        expect(isCoreKey("SomeCustom__c")).toBe(false);
    });
});

describe("buildFormFields", () => {
    const defs: PicklistFieldDef[] = [
        { name: "CventEvents__Annual_Revenue__c", label: "Annual Revenue", multi: false },
        { name: "CventEvents__Systems__c", label: "Systems and Platforms", multi: true },
        { name: "CventEvents__Custom_Q__c", label: "Favorite Session Track", multi: true },
        { name: "CventEvents__Empty__c", label: "Unanswered", multi: false },
    ];

    test("keys a core-labeled field by its core key and marks it core", () => {
        const [rev] = buildFormFields([defs[0]], {
            [defs[0].name]: "50M-100M",
        });
        expect(rev).toEqual({
            key: "annualRevenue",
            label: "Annual Revenue",
            values: ["50M-100M"],
            multi: false,
            core: true,
        });
    });

    test("keys a non-core field by its SF API name and marks it non-core", () => {
        const [custom] = buildFormFields([defs[2]], {
            [defs[2].name]: "Keynotes",
        });
        expect(custom).toMatchObject({
            key: "CventEvents__Custom_Q__c",
            label: "Favorite Session Track",
            core: false,
        });
    });

    test("splits a multipicklist ';'-joined value into trimmed values", () => {
        const [systems] = buildFormFields([defs[1]], {
            [defs[1].name]: "AWS; Azure ;GCP",
        });
        expect(systems.values).toEqual(["AWS", "Azure", "GCP"]);
        expect(systems.multi).toBe(true);
    });

    test("skips fields with no answer (null / empty)", () => {
        const out = buildFormFields(defs, {
            [defs[0].name]: "50M-100M",
            [defs[1].name]: "",
            [defs[3].name]: null,
            // defs[2] absent from the record entirely
        });
        expect(out.map((f) => f.key)).toEqual(["annualRevenue"]);
    });

    test("returns [] when the values record is empty", () => {
        expect(buildFormFields(defs, {})).toEqual([]);
    });

    test("preserves the defs order in the output", () => {
        const out = buildFormFields(defs, {
            [defs[0].name]: "50M-100M",
            [defs[1].name]: "AWS",
            [defs[2].name]: "Keynotes",
        });
        expect(out.map((f) => f.label)).toEqual([
            "Annual Revenue",
            "Systems and Platforms",
            "Favorite Session Track",
        ]);
    });
});
