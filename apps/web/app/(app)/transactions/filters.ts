import { currentMonth, type TransactionFilters, type TransactionPatch } from "@family-finance/db";

import { parseReaisToCents } from "../../../lib/format";

/**
 * Pure helpers shared by the "/transactions" server component (searchParams ->
 * repository filters, filter-bar links) and its server actions (FormData ->
 * `TransactionPatch`). No I/O — covered by integration/transactions-page.test.ts.
 *
 * URL contract: /transactions?month=YYYY-MM&account=&card=&category=&resp=&pending=1&q=&page=N
 * (all optional; month defaults to the current month).
 */

export const PAGE_SIZE = 50;

export type TransactionsSearchParams = Record<
  string,
  string | string[] | undefined
>;

export type ParsedTransactionsParams = {
  month: string;
  page: number;
  filters: TransactionFilters;
};

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** First value of a possibly-repeated query param, trimmed; "" -> undefined. */
function first(
  params: TransactionsSearchParams,
  key: string,
): string | undefined {
  const raw = params[key];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * Parse the page's searchParams into the month, page number and repository
 * filters. Invalid months fall back to the current month; invalid pages to 1.
 */
export function parseTransactionsSearchParams(
  params: TransactionsSearchParams,
  now?: Date,
): ParsedTransactionsParams {
  const monthParam = first(params, "month");
  const month =
    monthParam !== undefined && MONTH_RE.test(monthParam)
      ? monthParam
      : currentMonth(now);

  const pageParam = first(params, "page");
  const pageNumber =
    pageParam !== undefined ? Number.parseInt(pageParam, 10) : Number.NaN;
  const page = Number.isInteger(pageNumber) && pageNumber >= 1 ? pageNumber : 1;

  const filters: TransactionFilters = { month };
  const account = first(params, "account");
  if (account !== undefined) filters.accountId = account;
  const card = first(params, "card");
  if (card !== undefined) filters.creditCardId = card;
  const category = first(params, "category");
  if (category !== undefined) filters.categoryId = category;
  const resp = first(params, "resp");
  if (resp !== undefined) filters.responsible = resp;
  if (first(params, "pending") === "1") filters.pendingOnly = true;
  const q = first(params, "q");
  if (q !== undefined) filters.search = q;

  return { month, page, filters };
}

/** Step a `YYYY-MM` month by `delta` months (crosses year boundaries). Pure. */
export function shiftMonth(month: string, delta: number): string {
  const [yearStr, monthStr] = month.split("-");
  const index =
    Number.parseInt(yearStr ?? "", 10) * 12 +
    (Number.parseInt(monthStr ?? "", 10) - 1) +
    delta;
  const year = Math.floor(index / 12);
  const m = (index % 12) + 1;
  return `${year}-${String(m).padStart(2, "0")}`;
}

export type TransactionsHrefParams = {
  month: string;
  account?: string;
  card?: string;
  category?: string;
  resp?: string;
  pending?: boolean;
  q?: string;
  page?: number;
};

/**
 * Build a `/transactions` href preserving the given filters. Empty values and
 * `page: 1` are omitted so links stay canonical.
 */
export function transactionsHref(params: TransactionsHrefParams): string {
  const search = new URLSearchParams();
  search.set("month", params.month);
  if (params.account !== undefined && params.account !== "") {
    search.set("account", params.account);
  }
  if (params.card !== undefined && params.card !== "") {
    search.set("card", params.card);
  }
  if (params.category !== undefined && params.category !== "") {
    search.set("category", params.category);
  }
  if (params.resp !== undefined && params.resp !== "") {
    search.set("resp", params.resp);
  }
  if (params.pending === true) search.set("pending", "1");
  if (params.q !== undefined && params.q !== "") search.set("q", params.q);
  if (params.page !== undefined && params.page > 1) {
    search.set("page", String(params.page));
  }
  return `/transactions?${search.toString()}`;
}

export type ManualEntryInput = {
  kind: "expense" | "income";
  amountCents: number;
  description: string;
  occurredOn: string;
  categoryId?: string;
  subcategoryId?: string;
  payment:
    | { type: "account"; accountId: string }
    | { type: "card"; creditCardId: string };
  responsible: string;
};

/** Decode the form's "account:<id>" / "card:<id>" payment value. */
function decodePayment(
  raw: string,
): { type: "account"; accountId: string } | { type: "card"; creditCardId: string } {
  const [kind, id] = [raw.slice(0, raw.indexOf(":")), raw.slice(raw.indexOf(":") + 1)];
  if (kind === "account" && id !== "") return { type: "account", accountId: id };
  if (kind === "card" && id !== "") return { type: "card", creditCardId: id };
  throw new Error("Escolha a conta ou o cartão do lançamento.");
}

/** Parse a required pt-BR amount into positive integer cents. */
function requirePositiveCents(raw: string): number {
  const cents = parseReaisToCents(raw);
  if (cents === null || cents <= 0) {
    throw new Error('Não entendi o valor — use algo como "56,13".');
  }
  return cents;
}

/**
 * Translate the "Novo lançamento" FormData into a validated manual-entry
 * input. Throws pt-BR errors the action surfaces to the household as-is.
 */
export function manualEntryFromFormData(formData: FormData): ManualEntryInput {
  const kindRaw = formData.get("kind");
  const kind = kindRaw === "income" ? "income" : "expense";

  const amountCents = requirePositiveCents(String(formData.get("amount") ?? ""));

  const description = String(formData.get("description") ?? "").trim();
  if (description === "") {
    throw new Error("A descrição não pode ficar vazia.");
  }

  const occurredOn = String(formData.get("occurredOn") ?? "");
  if (!ISO_DATE_RE.test(occurredOn)) {
    throw new Error("Data inválida — use o formato AAAA-MM-DD.");
  }

  const payment = decodePayment(String(formData.get("payment") ?? ""));
  if (kind === "income" && payment.type === "card") {
    throw new Error("Entrada é sempre numa conta — escolha uma conta.");
  }

  const categoryId = String(formData.get("categoryId") ?? "");
  const subcategoryId = String(formData.get("subcategoryId") ?? "");
  const responsible = String(formData.get("responsible") ?? "household");

  return {
    kind,
    amountCents,
    description,
    occurredOn,
    ...(categoryId !== "" ? { categoryId } : {}),
    ...(subcategoryId !== "" ? { subcategoryId } : {}),
    payment,
    responsible: responsible === "" ? "household" : responsible,
  };
}

/**
 * Translate a server-action FormData into a `TransactionPatch`: only the keys
 * PRESENT in the form are patched (the client table sends just the edited
 * field). Empty category/subcategory selects mean "sem categoria" (null);
 * validation of description/occurredOn stays in the repo layer (pt-BR errors).
 */
export function transactionPatchFromFormData(
  formData: FormData,
): TransactionPatch {
  const patch: TransactionPatch = {};

  const description = formData.get("description");
  if (typeof description === "string") {
    patch.description = description;
  }

  const categoryId = formData.get("categoryId");
  if (typeof categoryId === "string") {
    patch.categoryId = categoryId === "" ? null : categoryId;
  }

  const subcategoryId = formData.get("subcategoryId");
  if (typeof subcategoryId === "string") {
    patch.subcategoryId = subcategoryId === "" ? null : subcategoryId;
  }

  const responsible = formData.get("responsible");
  if (typeof responsible === "string" && responsible !== "") {
    patch.responsibility =
      responsible === "household"
        ? { scope: "household" }
        : { scope: "user", userId: responsible };
  }

  const occurredOn = formData.get("occurredOn");
  if (typeof occurredOn === "string") {
    patch.occurredOn = occurredOn;
  }

  const amount = formData.get("amount");
  if (typeof amount === "string") {
    patch.amountCents = requirePositiveCents(amount);
  }

  const payment = formData.get("payment");
  if (typeof payment === "string" && payment !== "") {
    patch.payment = decodePayment(payment);
  }

  return patch;
}
