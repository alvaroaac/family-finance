import type { DashboardTransaction } from "@family-finance/db";

/**
 * Presentational list of recent transactions ("Últimos lançamentos"). The
 * caller passes already-mapped `DashboardTransaction` rows and a money
 * formatter; this component renders pt-BR labels and signs income/expense
 * without any data fetching or domain logic. Skinned with the `.ff-txrow`
 * classes from the "Editorial acolhedor" design system.
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
    return <p className="ff-muted">Nenhum lançamento ainda.</p>;
  }

  return (
    <ul className="ff-txlist">
      {transactions.map((tx) => {
        const isIncome = tx.kind === "income";
        const sign = isIncome ? "+ " : tx.kind === "expense" ? "− " : "";
        const amountTone = isIncome
          ? " ff-amount--pos"
          : tx.kind === "expense"
            ? " ff-amount--neg"
            : "";
        return (
          <li key={tx.id} className="ff-txrow">
            <div className="ff-txrow__main">
              <div className="ff-txrow__desc">
                {tx.description || "(sem descrição)"}
              </div>
              <div className="ff-txrow__meta">
                {formatDateBr(tx.occurredOn)} · {KIND_LABEL[tx.kind]}
                {tx.onCard ? " · cartão" : ""}
                {tx.hasCategory ? "" : " · sem categoria"}
              </div>
            </div>
            <div className={`ff-txrow__amount ff-num${amountTone}`}>
              {sign}
              {formatCents(tx.amountCents)}
            </div>
          </li>
        );
      })}
    </ul>
  );
}
