export function TierPill({ tier }: { tier: "diamond" | "standard" }) {
    const isDiamond = tier === "diamond";
    return (
        <span
            style={{
                fontSize: "10px",
                padding: "2px 8px",
                borderRadius: "100px",
                fontWeight: 500,
                background: isDiamond ? "rgba(155,114,245,0.12)" : "rgba(46,201,126,0.1)",
                color: isDiamond ? "var(--purple)" : "var(--green)",
                border: `1px solid ${isDiamond ? "rgba(155,114,245,0.25)" : "rgba(46,201,126,0.3)"}`,
                whiteSpace: "nowrap",
            }}
        >
            {isDiamond ? "◆ Diamond" : "● Standard"}
        </span>
    );
}
