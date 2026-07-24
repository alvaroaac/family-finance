import Link from "next/link";

import {
  findHouseholdIdForCurrentUser,
  findTransactionsFiltered,
  listAccounts,
  listCreditCards,
  listAllCategories,
  listAllSubcategories,
  listHouseholdMembers,
  type TransactionPage,
} from "@family-finance/db";

import { requireAuthorizedUser } from "../../../lib/auth";
import {
  Field,
  MonthStepper,
  NavigationSubmitButton,
  PillToggle,
  Select,
  Input,
  PageTitle,
} from "../../../components/ui";
import {
  parseTransactionsSearchParams,
  transactionsHref,
  shiftMonth,
  PAGE_SIZE,
  type TransactionsSearchParams,
} from "./filters";
import {
  TransactionsTable,
  type CategoryOption,
  type SubcategoryOption,
  type ResponsibleOption,
} from "./transactions-table";
import { NewTransactionForm } from "./new-transaction-form";

export const metadata = {
  title: "Transações — Casa",
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

const EMPTY_PAGE: TransactionPage = {
  rows: [],
  total: 0,
  page: 1,
  pageSize: PAGE_SIZE,
};

export default async function TransactionsPage({
  searchParams,
}: {
  searchParams: Promise<TransactionsSearchParams>;
}) {
  await requireAuthorizedUser();
  const params = await searchParams;
  const { month, page, filters } = parseTransactionsSearchParams(params);
  const novoRaw = params.novo;
  const novo = (Array.isArray(novoRaw) ? novoRaw[0] : novoRaw) === "1";

  let data = EMPTY_PAGE;
  let accounts: { id: string; name: string }[] = [];
  let cards: { id: string; name: string }[] = [];
  let categories: CategoryOption[] = [];
  let subcategories: SubcategoryOption[] = [];
  let responsibles: ResponsibleOption[] = [{ value: "household", label: "Casa" }];
  let loadError: string | null = null;

  try {
    const { createServerSupabaseClient } = await import("../../../lib/supabase");
    const client = await createServerSupabaseClient();
    const householdId = await findHouseholdIdForCurrentUser(client);
    if (householdId === null) {
      throw new Error("Nenhuma casa ativa para o usuário atual.");
    }

    const [pageData, accountRows, cardRows, categoryRows, subcategoryRows, members] =
      await Promise.all([
        findTransactionsFiltered(client, householdId, filters, page, PAGE_SIZE),
        listAccounts(client, householdId),
        listCreditCards(client, householdId),
        listAllCategories(client, householdId),
        listAllSubcategories(client, householdId),
        listHouseholdMembers(client, householdId),
      ]);

    data = pageData;
    accounts = accountRows.map((a) => ({ id: a.id, name: a.name }));
    cards = cardRows.map((c) => ({ id: c.id, name: c.name }));
    categories = categoryRows.map((c) => ({ id: c.id, name: c.name }));
    subcategories = subcategoryRows.map((s) => ({
      id: s.id,
      categoryId: s.category_id,
      name: s.name,
    }));
    responsibles = [
      { value: "household", label: "Casa" },
      ...members.map((m) => ({
        value: m.userId,
        label: m.displayName ?? "Membro",
      })),
    ];
  } catch (error) {
    loadError =
      error instanceof Error
        ? error.message
        : "Não foi possível carregar os lançamentos.";
  }

  // Current filter values echoed into links/selects.
  const current = {
    month,
    account: filters.accountId,
    card: filters.creditCardId,
    category: filters.categoryId,
    resp: filters.responsible,
    pending: filters.pendingOnly === true,
    q: filters.search,
  };

  const totalPages = Math.max(1, Math.ceil(data.total / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);

  const footNote =
    data.total === 1
      ? `1 lançamento em ${monthNamePt(month)}`
      : `${data.total} lançamentos em ${monthNamePt(month)}`;

  const pagination =
    totalPages > 1 ? (
      <span style={{ display: "flex", gap: 6, alignItems: "center" }}>
        {currentPage > 1 ? (
          <Link
            href={transactionsHref({ ...current, page: currentPage - 1 })}
            className="ff-pagebtn"
          >
            ‹ anterior
          </Link>
        ) : null}
        <span className="ff-note ff-num">
          página {currentPage} de {totalPages}
        </span>
        {currentPage < totalPages ? (
          <Link
            href={transactionsHref({ ...current, page: currentPage + 1 })}
            className="ff-pagebtn"
          >
            próxima ›
          </Link>
        ) : null}
      </span>
    ) : null;

  return (
    <section>
      <PageTitle
        kicker={`Nossa casa · ${formatMonthLabel(month)}`}
        title="Transações"
        lead="Tudo que entrou e saiu — dá pra ajustar categoria, descrição e responsável direto na lista."
      />

      {loadError !== null ? (
        <div
          role="alert"
          className="ff-alert ff-alert--negative"
          style={{ marginTop: 16 }}
        >
          Não foi possível carregar os lançamentos agora. ({loadError})
        </div>
      ) : null}

      <NewTransactionForm
        accounts={accounts}
        cards={cards}
        categories={categories}
        subcategories={subcategories}
        responsibles={responsibles}
        initiallyOpen={novo}
      />

      {/* Filter bar */}
      <div className="ff-filterbar">
        <MonthStepper
          label={formatMonthLabel(month)}
          prevHref={transactionsHref({ ...current, month: shiftMonth(month, -1) })}
          nextHref={transactionsHref({ ...current, month: shiftMonth(month, 1) })}
        />

        <form method="get" action="/transactions" className="ff-filterbar__form">
          <input type="hidden" name="month" value={month} />
          {current.pending ? (
            <input type="hidden" name="pending" value="1" />
          ) : null}

          <div className="ff-filterbar__field">
            <Field label="Conta">
              <Select name="account" defaultValue={current.account ?? ""}>
                <option value="">Todas</option>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </Select>
            </Field>
          </div>

          <div className="ff-filterbar__field">
            <Field label="Cartão">
              <Select name="card" defaultValue={current.card ?? ""}>
                <option value="">Todos</option>
                {cards.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            </Field>
          </div>

          <div className="ff-filterbar__field">
            <Field label="Categoria">
              <Select name="category" defaultValue={current.category ?? ""}>
                <option value="">Todas</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            </Field>
          </div>

          <div className="ff-filterbar__field">
            <Field label="Quem">
              <Select name="resp" defaultValue={current.resp ?? ""}>
                <option value="">todo mundo</option>
                {responsibles.map((r) => (
                  <option key={r.value} value={r.value}>
                    {r.label}
                  </option>
                ))}
              </Select>
            </Field>
          </div>

          <div className="ff-filterbar__field" style={{ minWidth: 200 }}>
            <Field label="Buscar na descrição">
              <Input
                type="search"
                name="q"
                defaultValue={current.q ?? ""}
                placeholder="ex.: mercado"
              />
            </Field>
          </div>

          <NavigationSubmitButton pendingLabel="Filtrando…">
            Filtrar
          </NavigationSubmitButton>
        </form>

        <span className="ff-filterbar__push">
          <PillToggle
            active={current.pending}
            href={transactionsHref({ ...current, pending: !current.pending })}
          >
            {current.pending ? `Só pendentes · ${data.total}` : "Só pendentes"}
          </PillToggle>
        </span>
      </div>

      {/* Listing (desktop grid + mobile row cards, CSS picks) */}
      <TransactionsTable
        rows={data.rows}
        categories={categories}
        subcategories={subcategories}
        responsibles={responsibles}
        accounts={accounts}
        cards={cards}
        footer={
          <div className="ff-table__foot">
            <span className="ff-table__foot-note ff-num">{footNote}</span>
            {pagination}
          </div>
        }
      />

      {/* Mobile twin of the table footer (the table is hidden under 720px). */}
      {data.rows.length > 0 ? (
        <div className="ff-mobile-foot">
          <span className="ff-table__foot-note ff-num">{footNote}</span>
          {pagination}
        </div>
      ) : null}
    </section>
  );
}
