export function TierPill({ tier }: { tier: "diamond" | "standard" }) {
    return (
        <span className={`tier-pill ${tier === "diamond" ? "tier-pill-diamond" : "tier-pill-standard"}`}>
            {tier === "diamond" ? "◆ Diamond" : "● Standard"}
        </span>
    );
}
