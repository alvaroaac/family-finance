import type { InvestmentBucketSlug } from "@family-finance/db";

import { requireAuthorizedUser } from "../../../lib/auth";
import { SummaryCard } from "../../../components/summary-card";
import { RecentTransactions } from "../../../components/recent-transactions";
import { PendingReviewList } from "../../../components/pending-review-list";
import { loadDashboardData, formatBrlCents } from "./queries";

export const metadata = {
  title: "Dashboard — Casa",
};

// This page reads per-request, RLS-scoped data; never statically prerender it.
export const dynamic = "force-dynamic";

const panel = {
  background: "#fff",
  border: "1px solid #e3e6ea",
  borderRadius: 12,
  padding: 20,
} as const;

const MONTH_NAMES_PT = [
  "janeiro",
  "fevereiro",
  "março",
  "abril",
  "maio",
  "junho",
  "julho",
  "agosto",
  "setembro",
  "outubro",
  "novembro",
  "dezembro",
];

/** "2026-06" -> "junho de 2026". */
function formatMonthLabel(month: string): string {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  if (match === null) return month;
  const year = match[1];
  const idx = Number.parseInt(match[2] as string, 10) - 1;
  const name = MONTH_NAMES_PT[idx] ?? month;
  return `${name} de ${year}`;
}

const BUCKET_LABEL: Record<InvestmentBucketSlug, string> = {
  filhos: "Filhos",
  casa: "Casa",
  independencia_financeira: "Independência financeira",
};

export default async function DashboardPage() {
  await requireAuthorizedUser();
  const data = await loadDashboardData();

  const {
    month,
    summary,
    cardPressure,
    upcomingInstallments,
    buckets,
    recent,
    pendingReview,
    loadError,
  } = data;

  const balanceTone = summary.balanceCents >= 0 ? "positive" : "negative";
  const bucketsHint =
    buckets.length === 0
      ? "Nenhuma caixinha cadastrada."
      : buckets.map((b) => BUCKET_LABEL[b.slug]).join(" · ");

  return (
    <section>
      <h1 style={{ marginTop: 0 }}>Dashboard · Casa</h1>
      <p style={{ color: "#555", maxWidth: 720 }}>
        Resumo mensal da família no workspace <strong>Casa</strong>:{" "}
        {formatMonthLabel(month)}. Quanto entrou, quanto sobrou, a pressão dos
        cartões, as caixinhas e o que ainda precisa de revisão.
      </p>

      {loadError ? (
        <div
          role="alert"
          style={{
            background: "#fdecec",
            border: "1px solid #f3b4b4",
            color: "#8a2020",
            borderRadius: 10,
            padding: 12,
            marginTop: 16,
            fontSize: 14,
          }}
        >
          Não foi possível carregar os dados agora; mostrando o resumo zerado.{" "}
          <span style={{ color: "#a85b5b" }}>({loadError})</span>
        </div>
      ) : null}

      {/* Summary cards */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
          gap: 16,
          marginTop: 24,
        }}
      >
        <SummaryCard
          label="Receitas do mês"
          value={formatBrlCents(summary.incomeCents)}
          tone="positive"
          hint="Quanto entrou no mês."
        />
        <SummaryCard
          label="Despesas do mês"
          value={formatBrlCents(summary.expenseCents)}
          tone="negative"
          hint="Total lançado no mês."
        />
        <SummaryCard
          label="Saldo estimado"
          value={formatBrlCents(summary.balanceCents)}
          tone={balanceTone}
          hint="Entradas menos saídas."
        />
        <SummaryCard
          label="Cartões"
          value={formatBrlCents(cardPressure.totalCents)}
          tone="warning"
          hint={`Compras ${formatBrlCents(
            cardPressure.directCents,
          )} + parcelas ${formatBrlCents(cardPressure.installmentCents)}`}
        />
        <SummaryCard
          label="Caixinhas"
          value={String(buckets.length)}
          tone="neutral"
          hint={bucketsHint}
        />
        <SummaryCard
          label="Pendentes de revisão"
          value={String(pendingReview.length)}
          tone={pendingReview.length > 0 ? "warning" : "neutral"}
          hint={
            pendingReview.length > 0
              ? "Itens sem categoria."
              : "Tudo categorizado."
          }
        />
      </div>

      {/* Two-column detail panels */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
          gap: 16,
          marginTop: 24,
        }}
      >
        <div style={panel}>
          <h2 style={{ marginTop: 0, fontSize: 18 }}>Lançamentos recentes</h2>
          <RecentTransactions transactions={recent} formatCents={formatBrlCents} />
        </div>

        <div style={panel}>
          <h2 style={{ marginTop: 0, fontSize: 18 }}>Precisa de revisão</h2>
          <PendingReviewList items={pendingReview} formatCents={formatBrlCents} />
        </div>

        <div style={panel}>
          <h2 style={{ marginTop: 0, fontSize: 18 }}>Próximas parcelas</h2>
          {upcomingInstallments.length === 0 ? (
            <p style={{ color: "#6b7280", fontSize: 14, marginTop: 0 }}>
              Nenhuma parcela futura.
            </p>
          ) : (
            <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
              {upcomingInstallments.map((parcel) => (
                <li
                  key={parcel.id}
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
                      {parcel.description || "(sem descrição)"}
                    </div>
                    <div
                      style={{ fontSize: 12, color: "#6b7280", marginTop: 2 }}
                    >
                      {formatMonthLabel(parcel.dueMonth)} · parcela{" "}
                      {parcel.number}/{parcel.installmentCount}
                    </div>
                  </div>
                  <div
                    style={{
                      fontSize: 14,
                      fontWeight: 600,
                      whiteSpace: "nowrap",
                    }}
                  >
                    {formatBrlCents(parcel.amountCents)}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}
