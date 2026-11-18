import { describe, test, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import type { Attendee, Location } from "@/types";
import { sponsorCompaniesByAccountId } from "@/lib/attendees/companies";
import { companyMaximumMeetings, companyMeetingsAtOnce } from "@/lib/attendees/caps";
import { resolveCompanyBooths } from "./booths";

// ---------------------------------------------------------------------------
// The mock fixtures in data/mock cover every booth and meeting-count case,
// so mock mode shows each one on the Sponsor booths page.
// ---------------------------------------------------------------------------

/**
 * Reads a JSON fixture from data/mock.
 *
 * @param {string} file - The path under data/mock.
 * @returns {unknown} The parsed JSON.
 */
function fixture(file: string): unknown {
    return JSON.parse(fs.readFileSync(path.join(process.cwd(), "data", "mock", file), "utf-8"));
}

const attendees = fixture("attendees.json") as Attendee[];
const locations: Location[] = (
    fixture("cvent/locations.json") as { data: { id: string; name: string }[] }
).data.map((l) => ({ id: l.id, name: l.name, capacity: Infinity, parentLocationId: null }));
const companies = sponsorCompaniesByAccountId(attendees);
const booths = resolveCompanyBooths([...companies.values()], locations, null);

/**
 * Finds a mock company by name.
 *
 * @param {string} name - The company name.
 * @returns The company.
 */
function company(name: string) {
    const c = [...companies.values()].find((x) => x.name === name);
    if (!c) throw new Error(`No mock company named ${name}`);
    return c;
}

describe("mock booth fixtures", () => {
    test.each([
        ["Helix Manufacturing Partners", "no_booth"],
        ["Vericel Sciences", "booth_not_found"],
        ["Northwind Analytics", "booth_conflict"],
        ["Brightline Labs", "booth_conflict"],
        ["Keystone Bio", "multiple_opportunities"],
        ["Lumen Exhibits", "no_package_meetings"],
    ])("%s has the %s problem", (name, problem) => {
        expect(booths.get(company(name).accountId)!.problems).toContain(problem);
    });

    test("the other sponsors match their booths by name", () => {
        expect(booths.get(company("Project Farma").accountId)!.location?.name).toBe("Booth 1");
        expect(booths.get(company("Cellavance Solutions").accountId)!.location?.name).toBe("Booth 2");
        expect(booths.get(company("OmniPath Biotech").accountId)!.location?.name).toBe("Booth 3");
    });

    test("cover each way the maximum is worked out", () => {
        expect(companyMaximumMeetings(company("Project Farma"))).toEqual({ maximum: 4, source: "maximum" });
        expect(companyMaximumMeetings(company("Cellavance Solutions"))).toEqual({ maximum: 7, source: "purchased_plus_bonus" });
        expect(companyMaximumMeetings(company("OmniPath Biotech"))).toEqual({ maximum: 5, source: "tier" });
    });

    test("cover meetings at once with two reps, one rep and a blank Diaries field", () => {
        expect(companyMeetingsAtOnce(company("Project Farma"))).toBe(2);
        expect(companyMeetingsAtOnce(company("OmniPath Biotech"))).toBe(1);
        expect(companyMeetingsAtOnce(company("Cellavance Solutions"))).toBe(1);
    });
});
