export function StatChip({
    label,
    value,
    valueColor,
}: {
    label: string;
    value: string;
    valueColor?: string;
}) {
    return (
        <div className="adm-stat-chip">
            <span className="adm-stat-label">{label}</span>
            <span
                className="adm-stat-value"
                style={valueColor ? { color: valueColor } : undefined}
            >
                {value}
            </span>
        </div>
    );
}
