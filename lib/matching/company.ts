// ---------------------------------------------------------------------------
// The same-company rule for delegate matching.
//
// No two people from the same company are paired for D2D or seated at the same roundtable.
// Pure, so both engines and the admin move checks share it.
// ---------------------------------------------------------------------------

/** The parts of a delegate the same-company rule reads. */
export type CompanyRef = { accountId: string; company: string };

/**
 * Normalizes a company name for comparing: trimmed and lowercased.
 *
 * @param {string} name - The company name.
 * @returns {string} The comparison key, or "" when blank.
 */
export function normalizeCompany(name: string): string {
    return (name ?? "").trim().toLowerCase();
}

/**
 * Whether two delegates work for the same company.
 * They do when they share an Account id, or when their names match after trimming and lowercasing.
 * Matching on either keeps the rule safe when one Account id is missing or an account is duplicated.
 *
 * @param {CompanyRef} a - One delegate.
 * @param {CompanyRef} b - The other delegate.
 * @returns {boolean} True when they are from the same company.
 */
export function sameCompany(a: CompanyRef, b: CompanyRef): boolean {
    if (a.accountId && b.accountId && a.accountId === b.accountId) return true;
    const na = normalizeCompany(a.company);
    return na !== "" && na === normalizeCompany(b.company);
}
