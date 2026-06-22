/**
 * RLS-aware repository functions named around domain concepts.
 *
 * These functions take an already-authenticated Supabase client (one carrying
 * the user's JWT). They never pass a household id that bypasses RLS — the
 * database policies in 0001_initial_schema.sql ensure a caller can only read or
 * write rows of households they are an active member of. Repositories therefore
 * stay thin: they translate between the domain contracts and the table rows.
 *
 * The pure mapping/query-builder helpers (`*Insert`, `mapTransactionRow`,
 * `summarizeMonth`) carry no I/O and are unit-tested without a live database.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  brl,
  type MoneyAmount,
  type TransactionDraft,
  type TransactionKind,
} from "@family-finance/domain";
import type {
  Database,
  TransactionRow,
  TransactionInsert,
  CategoryRow,
  SubcategoryRow,
} from "./types.js";

export type AppSupabaseClient = SupabaseClient<Database>;

// ---------------------------------------------------------------------------
// Pure mappers / query builders (no I/O — unit-testable).
// ---------------------------------------------------------------------------

/**
 * Build the insert payload for a transaction from a validated domain draft.
 *
 * Pure: performs no I/O. Money is taken straight from the draft's integer
 * cents, payment is mapped to the account/card column pair, and responsibility
 * is split into scope + optional user id to match the table's CHECK constraint.
 */
export function transactionInsertFromDraft(
  draft: TransactionDraft,
  options: { importBatchId?: string; installmentId?: string } = {},
): TransactionInsert {
  const isUser = draft.responsibility.scope === "user";
  return {
    household_id: draft.householdId,
    kind: draft.kind,
    amount_cents: draft.amount.cents,
    occurred_on: draft.occurredOn,
    description: draft.description,
    category_id: draft.category.categoryId ?? null,
    subcategory_id: draft.category.subcategoryId ?? null,
    account_id:
      draft.payment.type === "account" ? draft.payment.accountId : null,
    credit_card_id:
      draft.payment.type === "card" ? draft.payment.creditCardId : null,
    installment_id: options.installmentId ?? null,
    responsibility_scope: isUser ? "user" : "household",
    responsible_user_id:
      draft.responsibility.scope === "user"
        ? draft.responsibility.userId
        : null,
    created_by_user_id: draft.createdByUserId,
    import_batch_id: options.importBatchId ?? null,
  };
}

/** A persisted transaction with money surfaced as a domain `MoneyAmount`. */
export type PersistedTransaction = {
  id: string;
  householdId: string;
  kind: TransactionKind;
  amount: MoneyAmount;
  occurredOn: string;
  description: string;
  categoryId: string | null;
  subcategoryId: string | null;
  createdByUserId: string;
};

/** Map a raw transaction row back to a domain-shaped object. Pure. */
export function mapTransactionRow(row: TransactionRow): PersistedTransaction {
  return {
    id: row.id,
    householdId: row.household_id,
    kind: row.kind,
    amount: brl(row.amount_cents),
    occurredOn: row.occurred_on,
    description: row.description,
    categoryId: row.category_id,
    subcategoryId: row.subcategory_id,
    createdByUserId: row.created_by_user_id,
  };
}

/** Inclusive ISO date bounds (YYYY-MM-DD) for a `YYYY-MM` month. Pure. */
export function monthDateRange(month: string): { start: string; end: string } {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(month);
  if (match === null) {
    throw new Error(`Invalid month "${month}", expected YYYY-MM`);
  }
  const year = Number.parseInt(match[1] as string, 10);
  const monthNum = Number.parseInt(match[2] as string, 10);
  const start = `${month}-01`;
  // Last day of the month: day 0 of next month.
  const lastDay = new Date(Date.UTC(year, monthNum, 0)).getUTCDate();
  const end = `${month}-${String(lastDay).padStart(2, "0")}`;
  return { start, end };
}

export type MonthlySummary = {
  month: string;
  incomeCents: number;
  expenseCents: number;
  /** income - expense, in integer cents (can be negative). */
  balanceCents: number;
};

/**
 * Reduce a set of transaction rows into a monthly income/expense/balance
 * summary. Pure: callers fetch the month's rows (via RLS) and pass them here,
 * which keeps the aggregation logic testable without a database. `transfer`
 * rows are ignored for the income/expense totals.
 */
export function summarizeMonth(
  month: string,
  rows: Pick<TransactionRow, "kind" | "amount_cents">[],
): MonthlySummary {
  let incomeCents = 0;
  let expenseCents = 0;
  for (const row of rows) {
    if (row.kind === "income") {
      incomeCents += row.amount_cents;
    } else if (row.kind === "expense") {
      expenseCents += row.amount_cents;
    }
  }
  return {
    month,
    incomeCents,
    expenseCents,
    balanceCents: incomeCents - expenseCents,
  };
}

// ---------------------------------------------------------------------------
// Repository functions (I/O — require an authenticated client).
// ---------------------------------------------------------------------------

/**
 * Persist a transaction from a validated domain draft and return the stored
 * row mapped back to a domain shape. RLS guarantees the insert is rejected if
 * the caller is not a member of `draft.householdId`.
 */
export async function createTransaction(
  client: AppSupabaseClient,
  draft: TransactionDraft,
  options: { importBatchId?: string; installmentId?: string } = {},
): Promise<PersistedTransaction> {
  const payload = transactionInsertFromDraft(draft, options);
  const { data, error } = await client
    .from("transactions")
    .insert(payload)
    .select("*")
    .single();
  if (error !== null) {
    throw new Error(`createTransaction failed: ${error.message}`);
  }
  return mapTransactionRow(data as TransactionRow);
}

/**
 * Look up active macro categories for a household, ordered by name. RLS scopes
 * the result to households the caller belongs to.
 */
export async function findCategoriesByHousehold(
  client: AppSupabaseClient,
  householdId: string,
): Promise<CategoryRow[]> {
  const { data, error } = await client
    .from("categories")
    .select("*")
    .eq("household_id", householdId)
    .eq("is_active", true)
    .order("name", { ascending: true });
  if (error !== null) {
    throw new Error(`findCategoriesByHousehold failed: ${error.message}`);
  }
  return (data ?? []) as CategoryRow[];
}

/** Look up active subcategories under one macro category. */
export async function findSubcategoriesByCategory(
  client: AppSupabaseClient,
  householdId: string,
  categoryId: string,
): Promise<SubcategoryRow[]> {
  const { data, error } = await client
    .from("subcategories")
    .select("*")
    .eq("household_id", householdId)
    .eq("category_id", categoryId)
    .eq("is_active", true)
    .order("name", { ascending: true });
  if (error !== null) {
    throw new Error(`findSubcategoriesByCategory failed: ${error.message}`);
  }
  return (data ?? []) as SubcategoryRow[];
}

/**
 * Read the current-month income/expense/balance summary for a household.
 * Fetches the month's transaction rows (RLS-scoped) and reduces them with the
 * pure `summarizeMonth` helper.
 */
export async function getMonthlySummary(
  client: AppSupabaseClient,
  householdId: string,
  month: string,
): Promise<MonthlySummary> {
  const { start, end } = monthDateRange(month);
  const { data, error } = await client
    .from("transactions")
    .select("kind, amount_cents")
    .eq("household_id", householdId)
    .gte("occurred_on", start)
    .lte("occurred_on", end);
  if (error !== null) {
    throw new Error(`getMonthlySummary failed: ${error.message}`);
  }
  const rows = (data ?? []) as Pick<TransactionRow, "kind" | "amount_cents">[];
  return summarizeMonth(month, rows);
}
