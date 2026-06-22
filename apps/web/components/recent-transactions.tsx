import type { DashboardTransaction } from "@family-finance/db";

/**
 * Presentational list of recent transactions for the dashboard. The caller
 * passes already-mapped `DashboardTransaction` rows and a money formatter; this
 * component renders pt-BR labels and signs income/expense without any data
 * fetching or domain logic.
 */

export type RecentTransactionsProps = {
  transactions: DashboardTransaction[];
  /** Format integer BRL cents into a display string, e.g. "R$ 12,34". */
  formatCents: (cents: number) => string;
};

const KIND_LABEL: Record<DashboardTransaction["kind"], string> = {
  income: "Entrada",
  expense: "Saída",
  transfer: "Transferência",
};

function formatDateBr(iso: string): string {
  // iso is YYYY-MM-DD; render as DD/MM without constructing a Date (timezone-safe).
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (match === null) return iso;
  return `${match[3]}/${match[2]}`;
}

export function RecentTransactions({
  transactions,
  formatCents,
}: RecentTransactionsProps) {
  if (transactions.length === 0) {
    return (
      <p style={{ color: "#6b7280", fontSize: 14, marginTop: 0 }}>
        Nenhum lançamento ainda.
      </p>
    );
  }

  return (
    <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
      {transactions.map((tx) => {
        const isIncome = tx.kind === "income";
        const sign = isIncome ? "+" : tx.kind === "expense" ? "−" : "";
        return (
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
              <div style={{ fontSize: 12, color: "#6b7280", marginTop: 2 }}>
                {formatDateBr(tx.occurredOn)} · {KIND_LABEL[tx.kind]}
                {tx.onCard ? " · cartão" : ""}
                {tx.hasCategory ? "" : " · sem categoria"}
              </div>
            </div>
            <div
              style={{
                fontSize: 14,
                fontWeight: 600,
                whiteSpace: "nowrap",
                color: isIncome ? "#137a4b" : "#11271f",
              }}
            >
              {sign}
              {formatCents(tx.amountCents)}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
