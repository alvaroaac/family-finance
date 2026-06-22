/**
 * Presentational summary card for the monthly dashboard. No data fetching and
 * no domain logic — it just renders a labelled figure (already formatted) with
 * an optional hint line and tone. Money is formatted by the caller from BRL
 * cents via `formatBrlCents` (see queries.ts).
 */

export type SummaryCardTone = "neutral" | "positive" | "negative" | "warning";

const TONE_COLOR: Record<SummaryCardTone, string> = {
  neutral: "#11271f",
  positive: "#137a4b",
  negative: "#8a2020",
  warning: "#9a6b00",
};

export type SummaryCardProps = {
  label: string;
  /** Already-formatted main value (e.g. "R$ 1.234,56" or "3"). */
  value: string;
  /** Optional secondary line under the value. */
  hint?: string;
  tone?: SummaryCardTone;
};

export function SummaryCard({
  label,
  value,
  hint,
  tone = "neutral",
}: SummaryCardProps) {
  return (
    <div
      style={{
        background: "#fff",
        border: "1px solid #e3e6ea",
        borderRadius: 12,
        padding: 16,
        minWidth: 0,
      }}
    >
      <div style={{ fontSize: 13, color: "#6b7280" }}>{label}</div>
      <div
        style={{
          fontSize: 26,
          fontWeight: 700,
          marginTop: 8,
          color: TONE_COLOR[tone],
          overflowWrap: "anywhere",
        }}
      >
        {value}
      </div>
      {hint ? (
        <div style={{ fontSize: 12, color: "#6b7280", marginTop: 6 }}>
          {hint}
        </div>
      ) : null}
    </div>
  );
}
