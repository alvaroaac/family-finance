import {
  currentMonth,
  findAccountsByHousehold,
  findCategoriesByHousehold,
  findHouseholdIdForCurrentUser,
  type AccountRow,
  type CategoryRow,
} from "@family-finance/db";
import { currentHouseholdDate } from "@family-finance/domain";

import { PageTitle, StatCard } from "../../../components/ui";
import { requireAuthorizedUser } from "../../../lib/auth";
import { formatBrlCents, monthNamePtBr } from "../../../lib/format";
import {
  cancelObligationAction,
  createObligationAction,
  markObligationPaidAction,
  undoObligationPaymentAction,
  updateObligationAction,
} from "./actions";
import { NewObligationDialog } from "./new-obligation-dialog";
import { ObligationsTable } from "./obligations-table";
import {
  buildObligationsData,
  emptyObligationsData,
  type ObligationsData,
} from "./queries";
import { ThisMonthCard } from "./this-month-card";
import { TimelineCard } from "./timeline-card";
import {
  committedPerMonth,
  isFinished,
  nextDue,
  nextDueLabel,
  reliefNote,
  timelineChanges,
} from "./view-model";

export const metadata = {
  title: "Obrigações — Casa",
};

// This page reads per-request, RLS-scoped data; never statically prerender it.
export const dynamic = "force-dynamic";

type PageData = {
  data: ObligationsData;
  accounts: AccountRow[];
  categories: CategoryRow[];
};

/**
 * ONE client + ONE household resolution per request; the dataset and the two
 * form lookups load in parallel. Degrades to the zero state instead of
 * throwing (same contract as the resumo/dashboard loaders).
 */
async function loadPageData(
  now: Date = new Date(),
  options: { includeEnded?: boolean } = {},
): Promise<PageData> {
  const month = currentMonth(now);
  try {
    const { createServerSupabaseClient } =
      await import("../../../lib/supabase");
    const client = await createServerSupabaseClient();
    const householdId = await findHouseholdIdForCurrentUser(client);
    if (householdId === null) {
      return {
        data: emptyObligationsData(month, null),
        accounts: [],
        categories: [],
      };
    }
    const [data, accounts, categories] = await Promise.all([
      buildObligationsData(client, householdId, now, options),
      findAccountsByHousehold(client, householdId),
      findCategoriesByHousehold(client, householdId),
    ]);
    return { data, accounts, categories };
  } catch (error) {
    return {
      data: emptyObligationsData(
        month,
        error instanceof Error
          ? error.message
          : "Não foi possível carregar as obrigações.",
      ),
      accounts: [],
      categories: [],
    };
  }
}

export default async function ObligationsPage({
  searchParams,
}: {
  searchParams: Promise<{ encerradas?: string | string[] }>;
}) {
  await requireAuthorizedUser();
  const params = await searchParams;
  const encerradas = Array.isArray(params.encerradas)
    ? params.encerradas[0]
    : params.encerradas;
  const showEnded = encerradas === "1";

  const now = new Date();
  const today = currentHouseholdDate(now);
  const { data, accounts, categories } = await loadPageData(now, {
    includeEnded: showEnded,
  });

  const accountName = (id: string): string =>
    accounts.find((a) => a.id === id)?.name ?? "Conta";
  const categoryName = (id: string | null): string | null =>
    id === null ? null : (categories.find((c) => c.id === id)?.name ?? null);
  const accountOptions = accounts.map((a) => ({ id: a.id, name: a.name }));
  const categoryOptions = categories.map((c) => ({ id: c.id, name: c.name }));

  const committed = committedPerMonth(data.obligations, data.month);
  const next = nextDue(data, today);
  const paidCents = data.thisMonth.paid.reduce(
    (sum, p) => sum + p.amountCents,
    0,
  );
  const thisMonthTotal = data.timeline[0]?.totalCents ?? 0;
  const paidCount = data.thisMonth.paid.length;
  const monthCount = paidCount + data.thisMonth.unpaid.length;
  const paidPct =
    thisMonthTotal === 0
      ? 0
      : Math.round((paidCents / thisMonthTotal) * 1000) / 10;

  // Only the current month's paid names are known (the timeline carries the
  // amounts, not the descriptions, for the months ahead).
  const paidByMonth = new Map<string, string[]>([
    [data.month, data.thisMonth.paid.map((p) => p.description)],
  ]);

  // Templates whose term already ran out read as archive, not as commitments.
  const active = data.obligations.filter(
    (item) => !isFinished(item, data.month),
  );
  const finished = data.obligations.filter((item) =>
    isFinished(item, data.month),
  );
  const byAmount = (a: { amountCents: number }, b: { amountCents: number }) =>
    b.amountCents - a.amountCents;

  const newObligationProps = {
    accounts: accountOptions,
    categories: categoryOptions,
    currentMonth: data.month,
    monthTotals: Object.fromEntries(
      data.timeline.map((slot) => [slot.month, slot.totalCents]),
    ),
    action: createObligationAction,
  };

  return (
    <section
      className="ff-stack ff-has-sticky-cta"
      style={{ maxWidth: 980, margin: "0 auto" }}
    >
      <PageTitle
        kicker="Nossa casa"
        title="Obrigações fixas"
        lead="Financiamentos e contas que se repetem todo mês — projetados, não lançados."
        actions={
          <NewObligationDialog {...newObligationProps} trigger="header" />
        }
      />

      {data.loadError ? (
        <div role="alert" className="ff-alert ff-alert--negative">
          {data.loadError}
        </div>
      ) : null}

      <div className="ff-oblig-stats">
        <StatCard
          kicker="Comprometido por mês"
          value={formatBrlCents(committed.totalCents)}
          hint={
            <>
              {committed.activeCount === 1
                ? "1 obrigação ativa"
                : `${committed.activeCount} obrigações ativas`}
              {committed.fromMonth === null
                ? null
                : ` · a partir de ${monthNamePtBr(committed.fromMonth)}`}
            </>
          }
        />
        <StatCard
          kicker={`Este mês · ${monthNamePtBr(data.month)}`}
          value={
            <>
              {formatBrlCents(paidCents)}{" "}
              <span className="ff-oblig-stat-of">
                de {formatBrlCents(thisMonthTotal)}
              </span>
            </>
          }
          hint={
            <>
              <div className="ff-track ff-oblig-stat-track">
                <div
                  className="ff-track__fill ff-track__fill--positive"
                  style={{ width: `${paidPct}%` }}
                />
              </div>
              {monthCount === 0
                ? "nada a pagar"
                : `${paidCount} de ${monthCount} pagas`}
            </>
          }
        />
        <StatCard
          kicker="Próximo vencimento"
          value={next === null ? "—" : nextDueLabel(next)}
          hint={
            next === null
              ? "Nada projetado"
              : `${next.description} · dia ${next.dueDay}`
          }
        />
      </div>

      <ThisMonthCard
        data={data}
        today={today}
        accountName={accountName}
        categoryName={categoryName}
        markPaidAction={markObligationPaidAction}
        undoAction={undoObligationPaymentAction}
      />

      <TimelineCard
        timeline={data.timeline}
        changes={timelineChanges(data.obligations, data.timeline)}
        relief={reliefNote(data.obligations, data.timeline)}
        paidByMonth={paidByMonth}
      />

      <ObligationsTable
        items={[...active].sort(byAmount)}
        ended={[...finished, ...data.ended].sort(byAmount)}
        showEnded={showEnded}
        currentMonth={data.month}
        accountName={accountName}
        categoryName={categoryName}
        accounts={accountOptions}
        categories={categoryOptions}
        updateAction={updateObligationAction}
        cancelAction={cancelObligationAction}
      />

      <NewObligationDialog {...newObligationProps} trigger="sticky" />
    </section>
  );
}
