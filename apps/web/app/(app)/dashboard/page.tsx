import Link from "next/link";
import type { InvestmentBucketSlug } from "@family-finance/db";

import { requireAuthorizedUser } from "../../../lib/auth";
import { formatBrlCents } from "../../../lib/format";
import {
  Badge,
  Card,
  IconJar,
  PageTitle,
  PressureBars,
  RowCardList,
  StatCard,
  Table,
  TableRow,
} from "../../../components/ui";
import { loadDashboardData } from "./queries";

export const metadata = {
  title: "Dashboard — Casa",
};

// This page reads per-request, RLS-scoped data; never statically prerender it.
export const dynamic = "force-dynamic";

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

/** "2026-06" -> "junho". */
function monthNamePt(month: string): string {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  if (match === null) return month;
  const idx = Number.parseInt(match[2] as string, 10) - 1;
  return MONTH_NAMES_PT[idx] ?? month;
}

/** "2026-06" -> "junho de 2026". */
function formatMonthLabel(month: string): string {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  if (match === null) return month;
  return `${monthNamePt(month)} de ${match[1]}`;
}

/** "2026-07" -> "jul" (uppercased by the bar-label CSS). */
function monthAbbr(month: string): string {
  return monthNamePt(month).slice(0, 3);
}

/** "YYYY-MM-DD" -> "DD/MM" without constructing a Date (timezone-safe). */
function formatDateBr(iso: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (match === null) return iso;
  return `${match[3]}/${match[2]}`;
}

const BUCKET_LABEL: Record<InvestmentBucketSlug, string> = {
  filhos: "Filhos",
  casa: "Casa",
  independencia_financeira: "Independência financeira",
};

const RECENT_COLUMNS = [
  { key: "dia", label: "Dia" },
  { key: "descricao", label: "Descrição" },
  { key: "valor", label: "Valor", align: "right" as const },
];

export default async function DashboardPage() {
  await requireAuthorizedUser();
  const data = await loadDashboardData();

  const {
    month,
    summary,
    cardPressure,
    obligationsCents,
    upcomingInstallments,
    buckets,
    bucketsTotalCents,
    recent,
    pendingReview,
    loadError,
  } = data;

  // "Pressão dos cartões": existing upcoming-installments data grouped by month.
  const pressureByMonth = new Map<string, number>();
  for (const parcel of upcomingInstallments) {
    pressureByMonth.set(
      parcel.dueMonth,
      (pressureByMonth.get(parcel.dueMonth) ?? 0) + parcel.amountCents,
    );
  }
  const pressureBars = [...pressureByMonth.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([barMonth, cents]) => ({
      label: monthAbbr(barMonth),
      value: cents,
      display: Math.round(cents / 100).toLocaleString("pt-BR"),
      active: barMonth === month,
    }));

  return (
    <section>
      <PageTitle
        kicker={`Nossa casa · ${formatMonthLabel(month)}`}
        title="O mês inteiro, de uma vez"
        lead="Quanto entrou, quanto sobrou, a pressão dos cartões e as caixinhas."
        actions={
          <Link className="ff-btn ff-btn--primary" href="/transactions?novo=1">
            + Lançamento
          </Link>
        }
      />

      {loadError ? (
        <div role="alert" className="ff-alert ff-alert--negative" style={{ marginTop: 16 }}>
          Não foi possível carregar os dados agora; mostrando o resumo zerado.{" "}
          ({loadError})
        </div>
      ) : null}

      {/* Stat cards */}
      <div className="ff-grid-stats">
        <StatCard
          kicker="Entrou"
          value={formatBrlCents(summary.incomeCents)}
          tone="positive"
          hint="salários e outras entradas"
        />
        <StatCard
          kicker="Saiu"
          value={formatBrlCents(summary.expenseCents)}
          hint="Total lançado no mês."
        />
        <StatCard
          kicker="Sobrou"
          value={formatBrlCents(summary.balanceCents)}
          hint="entradas menos saídas"
        />
        <StatCard
          kicker={`Cartões em ${monthNamePt(month)}`}
          value={formatBrlCents(cardPressure.totalCents)}
          hint={`compras ${formatBrlCents(
            cardPressure.directCents,
          )} + parcelas ${formatBrlCents(cardPressure.installmentCents)}`}
        />
        <StatCard
          kicker="Obrigações fixas"
          value={formatBrlCents(obligationsCents)}
          hint="financiamentos e contas do mês"
        />
      </div>

      {/* Row 2: pressão + pra revisar */}
      <div className="ff-grid-2-1">
        <Card>
          <div className="ff-panel__head">
            <h2 className="ff-h2">Pressão dos cartões</h2>
            <span className="ff-note">parcelas já assumidas, mês a mês</span>
          </div>
          {pressureBars.length === 0 ? (
            <p className="ff-muted" style={{ marginTop: 18 }}>
              Nenhuma parcela futura.
            </p>
          ) : (
            <PressureBars bars={pressureBars} />
          )}
        </Card>

        <Card>
          <div className="ff-panel__head">
            <h2 className="ff-h2">Pra revisar</h2>
            <Badge tone={pendingReview.length > 0 ? "warn" : "positive"}>
              {pendingReview.length}
            </Badge>
          </div>
          {pendingReview.length === 0 ? (
            <p className="ff-muted" style={{ marginTop: 18 }}>
              Nada para revisar. Tudo categorizado por aqui.
            </p>
          ) : (
            <div className="ff-minicards">
              {pendingReview.map((tx) => {
                const isIncome = tx.kind === "income";
                const sign = isIncome ? "+ " : tx.kind === "expense" ? "− " : "";
                const tone = isIncome
                  ? " ff-amount--pos"
                  : tx.kind === "expense"
                    ? " ff-amount--neg"
                    : "";
                return (
                  <div key={tx.id} className="ff-minicard">
                    <div className="ff-minicard__row">
                      <span className="ff-minicard__title">
                        {tx.description || "(sem descrição)"}
                      </span>
                      <span className={`ff-minicard__amount ff-num${tone}`}>
                        {sign}
                        {formatBrlCents(tx.amountCents)}
                      </span>
                    </div>
                    <div className="ff-minicard__row ff-minicard__row--meta">
                      <span className="ff-minicard__meta">
                        {formatDateBr(tx.occurredOn)}
                      </span>
                      <Link href="/transactions?pending=1" className="ff-chip-link">
                        categorizar
                      </Link>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          <div className="ff-panel__foot">
            <Link href="/transactions?pending=1" className="ff-link">
              revisar tudo →
            </Link>
          </div>
        </Card>
      </div>

      {/* Row 3: lançamentos + caixinhas */}
      <div className="ff-grid-2-1">
        <Card>
          <div className="ff-panel__head" style={{ marginBottom: 12 }}>
            <h2 className="ff-h2">Últimos lançamentos</h2>
            <Link href="/transactions" className="ff-link">
              ver tudo →
            </Link>
          </div>
          {recent.length === 0 ? (
            <p className="ff-muted">Nenhum lançamento ainda.</p>
          ) : (
            <>
              <Table columns={RECENT_COLUMNS} gridTemplate="60px 1fr 120px">
                {recent.map((tx) => {
                  const isIncome = tx.kind === "income";
                  const sign = isIncome ? "+ " : tx.kind === "expense" ? "− " : "";
                  const tone = isIncome
                    ? " ff-amount--pos"
                    : tx.kind === "expense"
                      ? " ff-amount--neg"
                      : "";
                  return (
                    <TableRow key={tx.id}>
                      <span className="ff-note ff-num">
                        {formatDateBr(tx.occurredOn)}
                      </span>
                      <span className="ff-txrow__desc">
                        {tx.description || "(sem descrição)"}
                      </span>
                      <span
                        className={`ff-txrow__amount ff-num${tone}`}
                        style={{ textAlign: "right" }}
                      >
                        {sign}
                        {formatBrlCents(tx.amountCents)}
                      </span>
                    </TableRow>
                  );
                })}
              </Table>
              <RowCardList>
                {recent.map((tx) => {
                  const isIncome = tx.kind === "income";
                  const sign = isIncome ? "+ " : tx.kind === "expense" ? "− " : "";
                  const tone = isIncome
                    ? " ff-amount--pos"
                    : tx.kind === "expense"
                      ? " ff-amount--neg"
                      : "";
                  return (
                    <Card key={tx.id} soft className="ff-rowcard">
                      <div className="ff-txrow__main">
                        <div className="ff-txrow__desc">
                          {tx.description || "(sem descrição)"}
                        </div>
                        <div className="ff-txrow__meta">
                          {formatDateBr(tx.occurredOn)}
                        </div>
                      </div>
                      <div className={`ff-txrow__amount ff-num${tone}`}>
                        {sign}
                        {formatBrlCents(tx.amountCents)}
                      </div>
                    </Card>
                  );
                })}
              </RowCardList>
            </>
          )}
        </Card>

        <Card>
          <div className="ff-panel__head">
            <h2 className="ff-h2">Caixinhas</h2>
            <Link href="/investments" className="ff-link">
              ver →
            </Link>
          </div>
          {buckets.length === 0 ? (
            <p className="ff-muted" style={{ marginTop: 16 }}>
              Nenhuma caixinha cadastrada.
            </p>
          ) : (
            <div className="ff-caixinhas">
              {buckets.map((bucket) => (
                <div key={bucket.id} className="ff-caixinha">
                  <span className="ff-bubble">
                    <IconJar size={16} />
                  </span>
                  <span className="ff-caixinha__name">
                    {BUCKET_LABEL[bucket.slug]}
                  </span>
                  <span className="ff-caixinha__value ff-num">
                    {formatBrlCents(bucket.balance_cents)}
                  </span>
                </div>
              ))}
            </div>
          )}
          <div className="ff-caixinhas__total">
            <span className="ff-note">guardado no total</span>
            <span className="ff-caixinhas__total-value ff-serif ff-num">
              {formatBrlCents(bucketsTotalCents)}
            </span>
          </div>
        </Card>
      </div>
    </section>
  );
}
