import type { DashboardTransaction } from "@family-finance/db";

/**
 * Presentational list of transactions that still need review (no macro category
 * yet). The caller passes already-mapped rows and a money formatter; this
 * component renders pt-BR labels and points to the Categorias screen. No data
 * fetching or domain logic here.
 */

export type PendingReviewListProps = {
  items: DashboardTransaction[];
  /** Format integer BRL cents into a display string, e.g. "R$ 12,34". */
  formatCents: (cents: number) => string;
};

function formatDateBr(iso: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (match === null) return iso;
  return `${match[3]}/${match[2]}`;
}

export function PendingReviewList({ items, formatCents }: PendingReviewListProps) {
  if (items.length === 0) {
    return (
      <p style={{ color: "#6b7280", fontSize: 14, marginTop: 0 }}>
        Nada para revisar. Tudo categorizado por aqui.
      </p>
    );
  }

  return (
    <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
      {items.map((tx) => (
        <li
          key={tx.id}
          style={{
            borderTop: "1px solid #f0f2f4",
            padding: "10px 0",
            display: "flex",
            gap: 12,
            alignItems: "baseline",
            justifyContent: "space-between",
          }}
        >
          <div style={{ minWidth: 0 }}>
            <div
              style={{
                fontSize: 14,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {tx.description || "(sem descrição)"}
            </div>
            <div style={{ fontSize: 12, color: "#9a6b00", marginTop: 2 }}>
              {formatDateBr(tx.occurredOn)} · precisa de categoria
            </div>
          </div>
          <div style={{ fontSize: 14, fontWeight: 600, whiteSpace: "nowrap" }}>
            {formatCents(tx.amountCents)}
          </div>
        </li>
      ))}
    </ul>
  );
}
