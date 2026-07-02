import Link from "next/link";

import { requireAuthorizedUser } from "../../../lib/auth";
import { formatBrlCents } from "../../../lib/format";
import { RecentTransactions } from "../../../components/recent-transactions";
import {
  loadResumoData,
  monthLabelPtBr,
  spendingComparisonLabel,
} from "./queries";
import { shiftMonth } from "../transactions/filters";

export const metadata = {
  title: "Resumo — Casa",
};

// Per-request, RLS-scoped data; never statically prerender.
export const dynamic = "force-dynamic";

const panel = {
  background: "#fff",
  border: "1px solid #e3e6ea",
  borderRadius: 12,
  padding: 20,
} as const;

/**
 * "/resumo" — read-only daily summary, optimized for a 10-second phone check:
 * gasto do mês + comparison, fatura projetada per card, pendentes chip and
 * the last 5 lançamentos. Single mobile-friendly column, no filters.
 */
export default async function ResumoPage() {
  await requireAuthorizedUser();
  const data = await loadResumoData();
  const { month, spentCents, deltaVsPreviousCents, cards, pendingCount, recent, loadError } =
    data;
  const previousMonth = shiftMonth(month, -1);

  return (
    <section style={{ maxWidth: 560, display: "flex", flexDirection: "column", gap: 16 }}>
      <header>
        <h1 style={{ margin: 0 }}>Como estão as contas da casa?</h1>
        <p style={{ color: "#555", margin: "6px 0 0", fontSize: 15 }}>
          {monthLabelPtBr(month)}
        </p>
      </header>

      {loadError ? (
        <div
          role="alert"
          style={{
            background: "#fdecec",
            border: "1px solid #f3b4b4",
            color: "#8a2020",
            borderRadius: 10,
            padding: 12,
            fontSize: 14,
          }}
        >
          Não foi possível carregar o resumo agora; mostrando tudo zerado.{" "}
          <span style={{ color: "#a85b5b" }}>({loadError})</span>
        </div>
      ) : null}

      {/* Gasto do mês */}
      <div style={panel}>
        <div style={{ fontSize: 13, color: "#6b7280", letterSpacing: 0.4 }}>
          GASTO DO MÊS
        </div>
        <div style={{ fontSize: 36, fontWeight: 700, marginTop: 4 }}>
          {formatBrlCents(spentCents)}
        </div>
        <div style={{ fontSize: 14, color: "#374151", marginTop: 4 }}>
          {spendingComparisonLabel(deltaVsPreviousCents, previousMonth)}
        </div>
      </div>

      {/* Fatura projetada por cartão */}
      <div style={panel}>
        <h2 style={{ marginTop: 0, fontSize: 18 }}>Fatura projetada</h2>
        {cards.length === 0 ? (
          <p style={{ color: "#6b7280", fontSize: 14, margin: 0 }}>
            Nenhum cartão cadastrado.
          </p>
        ) : (
          <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {cards.map((card) => (
              <li
                key={card.id}
                style={{
                  borderTop: "1px solid #f0f2f4",
                  padding: "10px 0",
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "baseline",
                  gap: 12,
                }}
              >
                <span style={{ fontSize: 14 }}>{card.name}</span>
                <span style={{ fontSize: 14, fontWeight: 600, whiteSpace: "nowrap" }}>
                  {formatBrlCents(card.projectedCents)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Pendentes de revisão */}
      {pendingCount > 0 ? (
        <Link
          href="/transactions?pending=1"
          style={{
            display: "block",
            background: "#fff7e6",
            border: "1px solid #f0d9a8",
            color: "#7a5b13",
            borderRadius: 12,
            padding: "14px 20px",
            fontSize: 14,
            textDecoration: "none",
            fontWeight: 600,
          }}
        >
          {pendingCount === 1
            ? "1 lançamento pendente de revisão →"
            : `${pendingCount} lançamentos pendentes de revisão →`}
        </Link>
      ) : (
        <div
          style={{
            background: "#eef7f1",
            border: "1px solid #cbe5d5",
            color: "#1f5b3c",
            borderRadius: 12,
            padding: "14px 20px",
            fontSize: 14,
          }}
        >
          Tudo revisado por aqui ✨
        </div>
      )}

      {/* Últimos lançamentos */}
      <div style={panel}>
        <h2 style={{ marginTop: 0, fontSize: 18 }}>Últimos lançamentos</h2>
        <RecentTransactions transactions={recent} formatCents={formatBrlCents} />
      </div>
    </section>
  );
}
