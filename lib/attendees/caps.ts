import type { SponsorTier } from "@/types";

/**
 * Returns the contracted (package) meeting count for a sponsor tier.
 * Diamond sponsors get 8; standard and untiered get 5.
 */
export function contractedMeetings(tier: SponsorTier): number {
    return tier === "diamond" ? 8 : 5;
}
