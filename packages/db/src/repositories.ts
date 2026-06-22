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
  CategorizationMemoryRow,
  CategorizationMemoryInsert,
  ImportBatchRow,
  ImportBatchInsert,
  AccountRow,
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

// ---------------------------------------------------------------------------
// Import batches (Task 5).
//
// We persist ONLY the batch metadata — source, status, and row counts — never
// the original file bytes (privacy decision: raw imports are not retained). The
// row-level `import_rows` table can carry minimal normalized fields, but the web
// action records just the summary batch by default. RLS scopes every write to
// the caller's household.
// ---------------------------------------------------------------------------

/**
 * List a household's accounts (checking + investment), ordered by name. Used by
 * the import UI to pick the target account for the batch. RLS scopes the result.
 */
export async function findAccountsByHousehold(
  client: AppSupabaseClient,
  householdId: string,
): Promise<AccountRow[]> {
  const { data, error } = await client
    .from("accounts")
    .select("*")
    .eq("household_id", householdId)
    .order("name", { ascending: true });
  if (error !== null) {
    throw new Error(`findAccountsByHousehold failed: ${error.message}`);
  }
  return (data ?? []) as AccountRow[];
}

/**
 * Persist an import batch summary and return the stored row. The caller passes
 * an explicit `household_id` (double-enforced by RLS) and the source/status plus
 * counts. The raw file is never part of this payload.
 */
export async function createImportBatch(
  client: AppSupabaseClient,
  payload: ImportBatchInsert,
): Promise<ImportBatchRow> {
  const { data, error } = await client
    .from("import_batches")
    .insert(payload)
    .select("*")
    .single();
  if (error !== null) {
    throw new Error(`createImportBatch failed: ${error.message}`);
  }
  return data as ImportBatchRow;
}

// ---------------------------------------------------------------------------
// Category cleanup + categorization memory (Task 6).
//
// These power the web "Categorias" cleanup UI: list (including archived)
// categories/subcategories, archive a category, merge one category into
// another, and manage explainable categorization-memory patterns. Every call
// is RLS-scoped by `household_id`; we also pass `household_id` explicitly so a
// caller can never widen the blast radius beyond a single household.
// ---------------------------------------------------------------------------

/**
 * Resolve the single household the authenticated caller belongs to. RLS limits
 * `household_members` to the caller's own active memberships, so this returns
 * the first active membership's `household_id`. The MVP has exactly one
 * household ("Casa"); this avoids hardcoding the seed id in the app.
 */
export async function findHouseholdIdForCurrentUser(
  client: AppSupabaseClient,
): Promise<string | null> {
  const { data, error } = await client
    .from("household_members")
    .select("household_id")
    .eq("is_active", true)
    .limit(1)
    .maybeSingle();
  if (error !== null) {
    throw new Error(`findHouseholdIdForCurrentUser failed: ${error.message}`);
  }
  return data?.household_id ?? null;
}

/** List ALL macro categories for a household (active and archived), by name. */
export async function listAllCategories(
  client: AppSupabaseClient,
  householdId: string,
): Promise<CategoryRow[]> {
  const { data, error } = await client
    .from("categories")
    .select("*")
    .eq("household_id", householdId)
    .order("name", { ascending: true });
  if (error !== null) {
    throw new Error(`listAllCategories failed: ${error.message}`);
  }
  return (data ?? []) as CategoryRow[];
}

/** List ALL subcategories for a household (active and archived), by name. */
export async function listAllSubcategories(
  client: AppSupabaseClient,
  householdId: string,
): Promise<SubcategoryRow[]> {
  const { data, error } = await client
    .from("subcategories")
    .select("*")
    .eq("household_id", householdId)
    .order("name", { ascending: true });
  if (error !== null) {
    throw new Error(`listAllSubcategories failed: ${error.message}`);
  }
  return (data ?? []) as SubcategoryRow[];
}

/**
 * Archive (soft-delete) a macro category by setting `is_active = false`. The
 * category is kept so historical transactions retain their reference; it just
 * disappears from active pickers. RLS scopes the update to the household.
 */
export async function archiveCategory(
  client: AppSupabaseClient,
  householdId: string,
  categoryId: string,
): Promise<void> {
  const { error } = await client
    .from("categories")
    .update({ is_active: false })
    .eq("household_id", householdId)
    .eq("id", categoryId);
  if (error !== null) {
    throw new Error(`archiveCategory failed: ${error.message}`);
  }
}

/** Re-activate an archived macro category. */
export async function restoreCategory(
  client: AppSupabaseClient,
  householdId: string,
  categoryId: string,
): Promise<void> {
  const { error } = await client
    .from("categories")
    .update({ is_active: true })
    .eq("household_id", householdId)
    .eq("id", categoryId);
  if (error !== null) {
    throw new Error(`restoreCategory failed: ${error.message}`);
  }
}

/**
 * Merge `sourceCategoryId` into `targetCategoryId`: re-point every transaction,
 * installment group, installment, and subcategory from the source onto the
 * target, then archive the now-empty source category. This consolidates an
 * existing taxonomy instead of creating new categories — the spec's anti-sprawl
 * goal. All updates are household-scoped.
 *
 * Note: this is a best-effort sequence of scoped updates (Supabase JS has no
 * client-side transaction); each step is idempotent and re-runnable.
 */
export async function mergeCategory(
  client: AppSupabaseClient,
  householdId: string,
  sourceCategoryId: string,
  targetCategoryId: string,
): Promise<void> {
  if (sourceCategoryId === targetCategoryId) {
    throw new Error("mergeCategory: source and target must differ");
  }

  const repoint = async (
    table: "transactions" | "installment_groups" | "installments",
  ): Promise<void> => {
    const { error } = await client
      .from(table)
      .update({ category_id: targetCategoryId })
      .eq("household_id", householdId)
      .eq("category_id", sourceCategoryId);
    if (error !== null) {
      throw new Error(`mergeCategory(${table}) failed: ${error.message}`);
    }
  };

  await repoint("transactions");
  await repoint("installment_groups");
  await repoint("installments");

  // Move subcategories under the target macro category.
  const { error: subError } = await client
    .from("subcategories")
    .update({ category_id: targetCategoryId })
    .eq("household_id", householdId)
    .eq("category_id", sourceCategoryId);
  if (subError !== null) {
    throw new Error(`mergeCategory(subcategories) failed: ${subError.message}`);
  }

  // Re-point active memory entries so learned patterns follow the merge.
  const { error: memError } = await client
    .from("categorization_memory")
    .update({ category_id: targetCategoryId })
    .eq("household_id", householdId)
    .eq("category_id", sourceCategoryId);
  if (memError !== null) {
    throw new Error(`mergeCategory(memory) failed: ${memError.message}`);
  }

  await archiveCategory(client, householdId, sourceCategoryId);
}

/** List all categorization-memory patterns for a household (active first). */
export async function listCategorizationMemory(
  client: AppSupabaseClient,
  householdId: string,
): Promise<CategorizationMemoryRow[]> {
  const { data, error } = await client
    .from("categorization_memory")
    .select("*")
    .eq("household_id", householdId)
    .order("is_active", { ascending: false })
    .order("pattern", { ascending: true });
  if (error !== null) {
    throw new Error(`listCategorizationMemory failed: ${error.message}`);
  }
  return (data ?? []) as CategorizationMemoryRow[];
}

/** Only the ACTIVE memory patterns for a household — used by the engine store. */
export async function listActiveCategorizationMemory(
  client: AppSupabaseClient,
  householdId: string,
): Promise<CategorizationMemoryRow[]> {
  const { data, error } = await client
    .from("categorization_memory")
    .select("*")
    .eq("household_id", householdId)
    .eq("is_active", true)
    .order("pattern", { ascending: true });
  if (error !== null) {
    throw new Error(`listActiveCategorizationMemory failed: ${error.message}`);
  }
  return (data ?? []) as CategorizationMemoryRow[];
}

/**
 * Insert a categorization-memory pattern (e.g. mapping an old/imported category
 * name to a current one, or recording a confirmed correction). `household_id`
 * is required on the payload and double-enforced by RLS.
 */
export async function createCategorizationMemory(
  client: AppSupabaseClient,
  payload: CategorizationMemoryInsert,
): Promise<CategorizationMemoryRow> {
  const { data, error } = await client
    .from("categorization_memory")
    .insert(payload)
    .select("*")
    .single();
  if (error !== null) {
    throw new Error(`createCategorizationMemory failed: ${error.message}`);
  }
  return data as CategorizationMemoryRow;
}

/** Enable/disable a memory pattern without deleting it (auditable history). */
export async function setCategorizationMemoryActive(
  client: AppSupabaseClient,
  householdId: string,
  memoryId: string,
  isActive: boolean,
): Promise<void> {
  const { error } = await client
    .from("categorization_memory")
    .update({ is_active: isActive })
    .eq("household_id", householdId)
    .eq("id", memoryId);
  if (error !== null) {
    throw new Error(`setCategorizationMemoryActive failed: ${error.message}`);
  }
}
