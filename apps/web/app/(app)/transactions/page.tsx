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

export const metadata = {
  title: "Transações — Casa",
};

// This page reads per-request, RLS-scoped data; never statically prerender it.
export const dynamic = "force-dynamic";

const card = {
  background: "#fff",
  border: "1px solid #e3e6ea",
  borderRadius: 12,
  padding: 20,
  marginTop: 20,
} as const;

const inputStyle = {
  padding: "8px 10px",
  border: "1px solid #cbd2d9",
  borderRadius: 8,
  fontSize: 14,
} as const;

const btn = {
  padding: "8px 14px",
  borderRadius: 8,
  border: "1px solid #11271f",
  background: "#11271f",
  color: "#fff",
  fontSize: 14,
  cursor: "pointer",
} as const;

const stepLink = {
  ...btn,
  background: "#fff",
  color: "#11271f",
  textDecoration: "none",
  padding: "6px 12px",
  display: "inline-block",
} as const;

const pill = {
  display: "inline-block",
  borderRadius: 999,
  padding: "6px 14px",
  fontSize: 13,
  fontWeight: 600,
  textDecoration: "none",
  border: "1px solid #cbd2d9",
  color: "#334",
  background: "#fff",
} as const;

const pillActive = {
  ...pill,
  background: "#fdf3e3",
  border: "1px solid #eccf9a",
  color: "#8a5b12",
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
  const idx = Number.parseInt(match[2] as string, 10) - 1;
  return `${MONTH_NAMES_PT[idx] ?? month} de ${match[1]}`;
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

  return (
    <section>
      <h1 style={{ marginTop: 0 }}>Transações · Casa</h1>
      <p style={{ color: "#555", maxWidth: 720 }}>
        Todos os lançamentos da casa em {formatMonthLabel(month)}. Ajuste
        categoria, responsável ou descrição direto na tabela — os valores e a
        forma de pagamento ficam como foram registrados.
      </p>

      {loadError !== null ? (
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
          Não foi possível carregar os lançamentos agora.{" "}
          <span style={{ color: "#a85b5b" }}>({loadError})</span>
        </div>
      ) : null}

      {/* Filter bar */}
      <div style={card}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            flexWrap: "wrap",
          }}
        >
          {/* Month stepper */}
          <Link
            href={transactionsHref({ ...current, month: shiftMonth(month, -1) })}
            style={stepLink}
            aria-label="Mês anterior"
          >
            ‹
          </Link>
          <strong style={{ minWidth: 140, textAlign: "center" }}>
            {formatMonthLabel(month)}
          </strong>
          <Link
            href={transactionsHref({ ...current, month: shiftMonth(month, 1) })}
            style={stepLink}
            aria-label="Próximo mês"
          >
            ›
          </Link>

          {/* Pendentes pill toggle */}
          <Link
            href={transactionsHref({ ...current, pending: !current.pending })}
            style={current.pending ? pillActive : pill}
          >
            {current.pending ? "✓ pendentes" : "pendentes"}
          </Link>
        </div>

        <form
          method="get"
          action="/transactions"
          style={{
            display: "flex",
            alignItems: "flex-end",
            gap: 12,
            flexWrap: "wrap",
            marginTop: 16,
          }}
        >
          <input type="hidden" name="month" value={month} />
          {current.pending ? (
            <input type="hidden" name="pending" value="1" />
          ) : null}

          <label style={{ fontSize: 13, color: "#334" }}>
            Conta
            <br />
            <select name="account" defaultValue={current.account ?? ""} style={inputStyle}>
              <option value="">Todas</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>

          <label style={{ fontSize: 13, color: "#334" }}>
            Cartão
            <br />
            <select name="card" defaultValue={current.card ?? ""} style={inputStyle}>
              <option value="">Todos</option>
              {cards.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>

          <label style={{ fontSize: 13, color: "#334" }}>
            Categoria
            <br />
            <select name="category" defaultValue={current.category ?? ""} style={inputStyle}>
              <option value="">Todas</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>

          <label style={{ fontSize: 13, color: "#334" }}>
            Responsável
            <br />
            <select name="resp" defaultValue={current.resp ?? ""} style={inputStyle}>
              <option value="">Todos</option>
              {responsibles.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </select>
          </label>

          <label style={{ fontSize: 13, color: "#334" }}>
            Buscar na descrição
            <br />
            <input
              type="search"
              name="q"
              defaultValue={current.q ?? ""}
              placeholder="ex.: mercado"
              style={{ ...inputStyle, minWidth: 200 }}
            />
          </label>

          <button type="submit" style={btn}>
            Filtrar
          </button>
        </form>
      </div>

      {/* Listing */}
      <div style={card}>
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "baseline",
            gap: 12,
            flexWrap: "wrap",
          }}
        >
          <h2 style={{ margin: 0, fontSize: 18 }}>Lançamentos</h2>
          <span style={{ color: "#556", fontSize: 13 }}>
            {data.total === 1
              ? "1 lançamento encontrado"
              : `${data.total} lançamentos encontrados`}
          </span>
        </div>

        <div style={{ marginTop: 12 }}>
          <TransactionsTable
            rows={data.rows}
            categories={categories}
            subcategories={subcategories}
            responsibles={responsibles}
          />
        </div>

        {/* Pagination */}
        {totalPages > 1 ? (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              marginTop: 16,
            }}
          >
            {currentPage > 1 ? (
              <Link
                href={transactionsHref({ ...current, page: currentPage - 1 })}
                style={stepLink}
              >
                ‹ Anterior
              </Link>
            ) : null}
            <span style={{ color: "#556", fontSize: 13 }}>
              Página {currentPage} de {totalPages}
            </span>
            {currentPage < totalPages ? (
              <Link
                href={transactionsHref({ ...current, page: currentPage + 1 })}
                style={stepLink}
              >
                Próxima ›
              </Link>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}
