// ---------------------------------------------------------------------------
// Dynamic intake-form fields — shared, client-safe definitions.
//
// The delegate browse UI (cards, rows, details modal, sidebar filters, sort) is
// driven by the picklist answers a delegate gave on the pre-event intake form
// (Salesforce `CventEvents__Attendee__c`), plus the Account-derived Industries
// field. This module is the single source of truth for that field model and is
// PURE (no server-only imports) so both the server loader and the client
// `SponsorCatalog` can import it.
// ---------------------------------------------------------------------------

/**
 * One field's answer for a single attendee.
 *
 * A "field" is either a qualifying picklist question from the intake form, or
 * the Account-derived Industries field. `values` holds the selected option(s):
 * a single-select picklist yields 0–1, a multi-select 0–n.
 */
export interface AttendeeFormField {
    /**
     * Stable lookup key: the core key (e.g. "annualRevenue") for a matched core
     * field, the Salesforce field API name for any other picklist, or
     * "industries" for the Account-derived field.
     */
    key: string;
    /** Display label — the Salesforce field label, or "Industries". */
    label: string;
    /** Selected value(s). Single-select → 0–1; multi-select → 0–n. */
    values: string[];
    /** Whether the source field is multi-select; drives filter input + display. */
    multi: boolean;
    /** True for the hardcoded core columns shown on cards/rows. */
    core: boolean;
}

/**
 * Field-level metadata for one qualifying field, independent of any delegate.
 * Sourced from the Salesforce describe (picklist values in their defined order)
 * so the frontend can order filter options and sort ordinal ranges correctly.
 */
export interface AttendeeFieldMeta {
    /** Same key space as {@link AttendeeFormField.key}. */
    key: string;
    /** Display label. */
    label: string;
    /** Whether the field is multi-select. */
    multi: boolean;
    /**
     * The field's values in Salesforce's defined picklist order (Industries has
     * no picklist, so its order is just its observed unique values). Drives
     * filter-option order and core-field sort order.
     */
    order: string[];
}

/** The `key` used for the Account-derived Industries field everywhere. */
export const INDUSTRIES_KEY = "industries";

/**
 * The hardcoded "core" fields shown as columns on the grid cards / list rows,
 * in display order. This is the single place to edit that column set.
 *
 * Each form field is matched to a live Salesforce picklist by its normalized
 * label (`match`); a matched field adopts the stable core `key` so the frontend
 * can look it up by column regardless of the SF API name. `industries` is not a
 * form question — it's derived from the Account (see the loader).
 *
 * TODO: confirm the exact SF field labels/API names for the six core questions
 * once the intake form is finalized; adjust `match` (or switch to API-name
 * matching) accordingly.
 */
export const CORE_FIELDS = [
    { key: "companySize", label: "Company Size", match: "company size" },
    { key: "annualRevenue", label: "Annual Revenue", match: "annual revenue" },
    {
        key: "budgetResponsibility",
        label: "Budget Responsibility",
        match: "budget responsibility",
    },
    {
        key: "plannedInvestment",
        label: "Planned Investment",
        match: "planned investment",
    },
    {
        key: "systemsAndPlatforms",
        label: "Systems and Platforms",
        match: "systems and platforms",
    },
    {
        key: "currentFocusTopics",
        label: "Current Focus Topics",
        match: "current focus topics",
    },
    // Account-derived, not a form question. No `match` — assigned directly.
    { key: INDUSTRIES_KEY, label: "Industries", source: "account" },
] as const;

/** A core field key, e.g. "annualRevenue". */
export type CoreFieldKey = (typeof CORE_FIELDS)[number]["key"];

/** Core field keys in display order — the card/row column order. */
export const CORE_FIELD_KEYS: readonly CoreFieldKey[] = CORE_FIELDS.map(
    (f) => f.key,
);

/** Lowercases + collapses whitespace so label matching is forgiving. */
function normalizeLabel(label: string): string {
    return label.trim().toLowerCase().replace(/\s+/g, " ");
}

// Form core fields only (Industries is Account-derived, matched separately),
// indexed by normalized label for O(1) lookup.
const CORE_KEY_BY_LABEL = new Map<string, CoreFieldKey>(
    CORE_FIELDS.filter((f) => "match" in f).map((f) => [
        normalizeLabel((f as { match: string }).match),
        f.key,
    ]),
);

/**
 * Resolves a Salesforce field label to its core key, or undefined when the
 * field isn't one of the core form questions.
 *
 * @param {string} label - The Salesforce field label.
 * @returns {CoreFieldKey | undefined} The core key, or undefined.
 */
export function coreKeyForLabel(label: string): CoreFieldKey | undefined {
    return CORE_KEY_BY_LABEL.get(normalizeLabel(label));
}

/** True when a field key is one of the core columns. */
export function isCoreKey(key: string): boolean {
    return CORE_FIELD_KEYS.includes(key as CoreFieldKey);
}

/**
 * Minimal shape of a described picklist field needed to build a form field.
 * Structurally satisfied by the Salesforce client's AttendeePicklistFieldDef,
 * kept here (rather than importing it) so this module stays server-free.
 */
export interface PicklistFieldDef {
    /** Salesforce field API name — the key into the raw values record. */
    name: string;
    /** Field label — the display title and the core-column match key. */
    label: string;
    /** True for multipicklist (multi-select) fields. */
    multi: boolean;
}

/**
 * Builds a delegate's `AttendeeFormField[]` from the described picklist fields
 * and that delegate's raw field values (SF API name → value). Unanswered fields
 * are skipped; a multipicklist's `"A;B;C"` value is split into individual
 * values; a field whose label matches a core column adopts the stable core key
 * (and `core: true`) so the frontend can look it up by column.
 *
 * @param {PicklistFieldDef[]} defs - The qualifying picklist fields.
 * @param {Record<string, string | null | undefined>} values - Raw field values by API name.
 * @returns {AttendeeFormField[]} The delegate's answered fields.
 */
export function buildFormFields(
    defs: PicklistFieldDef[],
    values: Record<string, string | null | undefined>,
): AttendeeFormField[] {
    const out: AttendeeFormField[] = [];
    for (const def of defs) {
        const raw = values[def.name];
        if (raw == null || raw === "") continue;
        const parsed = def.multi
            ? raw
                  .split(";")
                  .map((s) => s.trim())
                  .filter(Boolean)
            : [raw.trim()].filter(Boolean);
        if (parsed.length === 0) continue;
        const coreKey = coreKeyForLabel(def.label);
        out.push({
            key: coreKey ?? def.name,
            label: def.label,
            values: parsed,
            multi: def.multi,
            core: coreKey != null,
        });
    }
    return out;
}
