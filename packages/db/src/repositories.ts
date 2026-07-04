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
  paidKey,
  projectObligations,
  type MoneyAmount,
  type TransactionDraft,
  type TransactionKind,
  type AccountKind,
  type InvestmentBucketSlug,
  type InstallmentPlan,
  type ObligationDraft,
  type ProjectableObligation,
  type ProjectedEntry,
} from "@family-finance/domain";
import type {
  Database,
  TransactionRow,
  TransactionInsert,
  CategoryRow,
  SubcategoryRow,
  CategorizationMemoryRow,
  CategorizationMemoryInsert,
  BotInteractionRow,
  BotInteractionInsert,
  ImportBatchRow,
  ImportBatchInsert,
  ConfirmImportBatchPayload,
  ConfirmImportRowPayload,
  ConfirmImportResult,
  AccountRow,
  InvestmentBucketRow,
  CreditCardRow,
  InstallmentGroupRow,
  InstallmentRow,
  InstallmentGroupInsertPayload,
  InstallmentInsertPayload,
  HouseholdMemberRow,
  ResponsibilityScope,
  BotConversationRow,
  ObligationRow,
  ObligationInsert,
  ObligationStatus,
  MaterializeObligationPaymentResult,
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
// Dashboard aggregation (Task 10).
//
// The monthly dashboard is deliberately simple (no charts/projections). These
// pure reducers turn RLS-scoped row sets into the numbers the dashboard cards
// show, so the aggregation stays unit-testable without a database.
// ---------------------------------------------------------------------------

/** Current `YYYY-MM` month string in UTC. Pure given `now`. */
export function currentMonth(now: Date = new Date()): string {
  const year = now.getUTCFullYear();
  const monthNum = now.getUTCMonth() + 1;
  return `${year}-${String(monthNum).padStart(2, "0")}`;
}

export type CardPressure = {
  month: string;
  /** Sum of this month's card transactions booked directly on a card. */
  directCents: number;
  /** Sum of this month's installment parcels (due_month === month). */
  installmentCents: number;
  /** directCents + installmentCents — the month's total card pressure. */
  totalCents: number;
};

/**
 * Reduce this month's card-paid transactions and due installments into a single
 * card-pressure figure. Pure: callers fetch the rows (RLS-scoped) and pass them
 * here. Only `expense` card transactions count toward direct pressure; refunds
 * on a card (income) are ignored to keep the "how much the cards cost" reading
 * honest.
 */
export function summarizeCardPressure(
  month: string,
  cardTransactions: Pick<TransactionRow, "kind" | "amount_cents">[],
  dueInstallments: Pick<InstallmentRow, "amount_cents">[],
): CardPressure {
  let directCents = 0;
  for (const tx of cardTransactions) {
    if (tx.kind === "expense") {
      directCents += tx.amount_cents;
    }
  }
  let installmentCents = 0;
  for (const parcel of dueInstallments) {
    installmentCents += parcel.amount_cents;
  }
  return {
    month,
    directCents,
    installmentCents,
    totalCents: directCents + installmentCents,
  };
}

/** One upcoming installment parcel, surfaced for the dashboard. */
export type UpcomingInstallment = {
  id: string;
  description: string;
  number: number;
  installmentCount: number;
  amountCents: number;
  dueMonth: string;
  creditCardId: string;
};

/** Pure: map an installment row to the dashboard's upcoming-parcel shape. */
export function mapUpcomingInstallment(
  row: Pick<
    InstallmentRow,
    | "id"
    | "description"
    | "number"
    | "installment_count"
    | "amount_cents"
    | "due_month"
    | "credit_card_id"
  >,
): UpcomingInstallment {
  return {
    id: row.id,
    description: row.description,
    number: row.number,
    installmentCount: row.installment_count,
    amountCents: row.amount_cents,
    dueMonth: row.due_month,
    creditCardId: row.credit_card_id,
  };
}

/** A transaction surfaced in the dashboard's "recent" / "pending review" lists. */
export type DashboardTransaction = {
  id: string;
  kind: TransactionKind;
  amountCents: number;
  occurredOn: string;
  description: string;
  hasCategory: boolean;
  onCard: boolean;
};

/** Pure: map a transaction row to the dashboard's list shape. */
export function mapDashboardTransaction(
  row: Pick<
    TransactionRow,
    | "id"
    | "kind"
    | "amount_cents"
    | "occurred_on"
    | "description"
    | "category_id"
    | "credit_card_id"
  >,
): DashboardTransaction {
  return {
    id: row.id,
    kind: row.kind,
    amountCents: row.amount_cents,
    occurredOn: row.occurred_on,
    description: row.description,
    hasCategory: row.category_id !== null,
    onCard: row.credit_card_id !== null,
  };
}

/**
 * Decide whether a transaction needs review. In the MVP an item "needs review"
 * when it has no macro category yet (imports and quick bot entries can land
 * uncategorized). Pure so the rule lives in one place. `transfer` rows are not
 * surfaced for review.
 */
export function needsReview(
  row: Pick<TransactionRow, "kind" | "category_id">,
): boolean {
  return row.kind !== "transfer" && row.category_id === null;
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

/**
 * Atomically confirm a reviewed import: create the import_batch, bulk-insert the
 * kept transactions linked to that batch via `import_batch_id`, and write the
 * per-row `import_rows` audit trail — all in ONE transaction. Returns the stored
 * batch plus the count of transactions actually written.
 *
 * Atomicity: this calls the `confirm_import` plpgsql function (see
 * supabase/migrations/0004_confirm_import.sql), whose body runs in a single
 * transaction — so the previous per-row insert LOOP (with the batch created
 * AFTER the rows, no import_batch_id link, and no audit trail) can no longer
 * leave transactions unlinked or the batch counts disagreeing with what was
 * written. The function is SECURITY DEFINER and re-asserts household membership
 * (via `is_household_member`) before writing, preserving the RLS/household
 * isolation the table policies enforce. The caller still validates each row into
 * a draft in TypeScript, so the domain rules + per-row error reporting stay in
 * the app; the parcels' batch link + audit `transaction_id` are set server-side.
 */
export async function confirmImport(
  client: AppSupabaseClient,
  batch: ConfirmImportBatchPayload,
  rows: ConfirmImportRowPayload[],
): Promise<ConfirmImportResult> {
  const { data, error } = await client.rpc("confirm_import", {
    batch_payload: batch,
    rows_payload: rows,
  });
  if (error !== null) {
    throw new Error(`confirmImport failed: ${error.message}`);
  }
  const result = data as ConfirmImportResult;
  return {
    batch: result.batch,
    imported_rows: result.imported_rows ?? 0,
  };
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
 * installment group, installment, subcategory, and categorization-memory row
 * from the source onto the target, then archive the now-empty source category.
 * This consolidates an existing taxonomy instead of creating new categories —
 * the spec's anti-sprawl goal. All updates are household-scoped.
 *
 * Atomicity: this calls the `merge_category` plpgsql function (see
 * supabase/migrations/0003_merge_category.sql), whose body runs in a single
 * transaction — so a failure mid-merge can no longer leave a PARTIAL state with
 * some rows re-pointed and the source still active. The function is SECURITY
 * DEFINER and re-asserts household membership (via `is_household_member`) before
 * writing, preserving the RLS/household isolation the table policies enforce.
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

  const { error } = await client.rpc("merge_category", {
    target_household_id: householdId,
    source_category_id: sourceCategoryId,
    target_category_id: targetCategoryId,
  });
  if (error !== null) {
    throw new Error(`mergeCategory failed: ${error.message}`);
  }
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

// ---------------------------------------------------------------------------
// Bot interactions (auditing).
//
// Every bot turn is recorded for auditing (channel, who, what, the suggested
// confidence/explanation, and the resulting transaction id). The bot goes
// through this repository instead of writing the table directly so every write
// path stays in one place; `household_id` is required on the payload and
// double-enforced by RLS.
// ---------------------------------------------------------------------------

/**
 * Persist a bot interaction audit row and return the stored row. The caller
 * passes an explicit `household_id` (double-enforced by RLS) plus the channel,
 * input kind, and the optional suggestion/transaction details.
 */
export async function createBotInteraction(
  client: AppSupabaseClient,
  payload: BotInteractionInsert,
): Promise<BotInteractionRow> {
  const { data, error } = await client
    .from("bot_interactions")
    .insert(payload)
    .select("*")
    .single();
  if (error !== null) {
    throw new Error(`createBotInteraction failed: ${error.message}`);
  }
  return data as BotInteractionRow;
}

// ---------------------------------------------------------------------------
// Accounts, investment buckets (caixinhas), and credit cards (Task 9).
//
// These power the web "Contas", "Investimentos", and "Cartões" screens. Each
// repository is household-scoped: callers pass an explicit `household_id` and RLS
// double-enforces it. The pure `*Insert` builders carry no I/O so they are
// unit-tested without a live database (they normalize names and shape the row).
// ---------------------------------------------------------------------------

/** Pure: build a household-scoped account insert payload (trims the name). */
export function accountInsert(input: {
  householdId: string;
  kind: AccountKind;
  name: string;
}): Pick<AccountRow, "household_id" | "kind" | "name"> {
  return {
    household_id: input.householdId,
    kind: input.kind,
    name: input.name.trim(),
  };
}

/** Pure: build a household-scoped investment bucket (caixinha) insert payload. */
export function investmentBucketInsert(input: {
  householdId: string;
  slug: InvestmentBucketSlug;
  name: string;
}): Pick<InvestmentBucketRow, "household_id" | "slug" | "name"> {
  return {
    household_id: input.householdId,
    slug: input.slug,
    name: input.name.trim(),
  };
}

/** Pure: build a household-scoped credit card insert payload. */
export function creditCardInsert(input: {
  householdId: string;
  name: string;
  closingDay?: number;
  dueDay?: number;
}): Pick<
  CreditCardRow,
  "household_id" | "name" | "closing_day" | "due_day"
> {
  return {
    household_id: input.householdId,
    name: input.name.trim(),
    closing_day: input.closingDay ?? null,
    due_day: input.dueDay ?? null,
  };
}

/**
 * Pure: map a domain `InstallmentPlan` parent group into the DB insert payload.
 * The plan is produced by `@family-finance/domain createInstallmentPlan`, so the
 * money split / due-month logic lives in the domain, not here.
 */
export function installmentGroupInsertFromPlan(
  plan: InstallmentPlan,
): InstallmentGroupInsertPayload {
  const { group } = plan;
  const isUser = group.responsibility.scope === "user";
  return {
    household_id: group.householdId,
    credit_card_id: group.creditCardId,
    description: group.description,
    total_amount_cents: group.totalAmount.cents,
    installment_count: group.installmentCount,
    purchased_on: group.purchasedOn,
    category_id: group.category.categoryId ?? null,
    subcategory_id: group.category.subcategoryId ?? null,
    responsibility_scope: isUser ? "user" : "household",
    responsible_user_id:
      group.responsibility.scope === "user"
        ? group.responsibility.userId
        : null,
    created_by_user_id: group.createdByUserId,
  };
}

/**
 * Pure: map a domain `InstallmentPlan`'s generated parcels into DB insert rows,
 * linking each to the already-persisted parent group's id. The amounts and due
 * months come straight from the domain plan (they sum back to the total).
 */
export function installmentInsertsFromPlan(
  plan: InstallmentPlan,
  installmentGroupId: string,
): Array<
  Pick<
    InstallmentRow,
    | "household_id"
    | "installment_group_id"
    | "credit_card_id"
    | "number"
    | "installment_count"
    | "amount_cents"
    | "due_month"
    | "description"
    | "category_id"
    | "subcategory_id"
    | "responsibility_scope"
    | "responsible_user_id"
    | "created_by_user_id"
  >
> {
  return plan.installments.map((parcel) => {
    const isUser = parcel.responsibility.scope === "user";
    return {
      household_id: parcel.householdId,
      installment_group_id: installmentGroupId,
      credit_card_id: parcel.creditCardId,
      number: parcel.number,
      installment_count: parcel.installmentCount,
      amount_cents: parcel.amount.cents,
      due_month: parcel.dueMonth,
      description: parcel.description,
      category_id: parcel.category.categoryId ?? null,
      subcategory_id: parcel.category.subcategoryId ?? null,
      responsibility_scope: isUser ? "user" : "household",
      responsible_user_id:
        parcel.responsibility.scope === "user"
          ? parcel.responsibility.userId
          : null,
      created_by_user_id: parcel.createdByUserId,
    };
  });
}

/**
 * Pure: map a domain `InstallmentPlan`'s parcels into the RPC payload shape for
 * `create_installment_purchase`. Unlike `installmentInsertsFromPlan`, this omits
 * `installment_group_id`: the SQL function fills it from the group id it inserts
 * in the same transaction, so the caller never has to know it in advance.
 */
export function installmentInsertPayloadsFromPlan(
  plan: InstallmentPlan,
): InstallmentInsertPayload[] {
  return plan.installments.map((parcel) => {
    const isUser = parcel.responsibility.scope === "user";
    return {
      household_id: parcel.householdId,
      credit_card_id: parcel.creditCardId,
      number: parcel.number,
      installment_count: parcel.installmentCount,
      amount_cents: parcel.amount.cents,
      due_month: parcel.dueMonth,
      description: parcel.description,
      category_id: parcel.category.categoryId ?? null,
      subcategory_id: parcel.category.subcategoryId ?? null,
      responsibility_scope: isUser ? "user" : "household",
      responsible_user_id:
        parcel.responsibility.scope === "user"
          ? parcel.responsibility.userId
          : null,
      created_by_user_id: parcel.createdByUserId,
    };
  });
}

// --- Accounts (conta corrente / conta investimento) ------------------------

/** List ALL accounts for a household (checking + investment), ordered by name. */
export async function listAccounts(
  client: AppSupabaseClient,
  householdId: string,
): Promise<AccountRow[]> {
  const { data, error } = await client
    .from("accounts")
    .select("*")
    .eq("household_id", householdId)
    .order("name", { ascending: true });
  if (error !== null) {
    throw new Error(`listAccounts failed: ${error.message}`);
  }
  return (data ?? []) as AccountRow[];
}

/** Create an account (checking or investment). RLS scopes the insert. */
export async function createAccount(
  client: AppSupabaseClient,
  input: { householdId: string; kind: AccountKind; name: string },
): Promise<AccountRow> {
  const { data, error } = await client
    .from("accounts")
    .insert(accountInsert(input))
    .select("*")
    .single();
  if (error !== null) {
    throw new Error(`createAccount failed: ${error.message}`);
  }
  return data as AccountRow;
}

/** Rename an account. RLS scopes the update to the household. */
export async function updateAccount(
  client: AppSupabaseClient,
  householdId: string,
  accountId: string,
  changes: { name: string },
): Promise<void> {
  const { error } = await client
    .from("accounts")
    .update({ name: changes.name.trim() })
    .eq("household_id", householdId)
    .eq("id", accountId);
  if (error !== null) {
    throw new Error(`updateAccount failed: ${error.message}`);
  }
}

/** Delete an account. RLS scopes the delete; FK restrict blocks if in use. */
export async function deleteAccount(
  client: AppSupabaseClient,
  householdId: string,
  accountId: string,
): Promise<void> {
  const { error } = await client
    .from("accounts")
    .delete()
    .eq("household_id", householdId)
    .eq("id", accountId);
  if (error !== null) {
    throw new Error(`deleteAccount failed: ${error.message}`);
  }
}

// --- Investment buckets (caixinhas) ----------------------------------------

/** List investment buckets (caixinhas) for a household, ordered by name. */
export async function listInvestmentBuckets(
  client: AppSupabaseClient,
  householdId: string,
): Promise<InvestmentBucketRow[]> {
  const { data, error } = await client
    .from("investment_buckets")
    .select("*")
    .eq("household_id", householdId)
    .order("name", { ascending: true });
  if (error !== null) {
    throw new Error(`listInvestmentBuckets failed: ${error.message}`);
  }
  return (data ?? []) as InvestmentBucketRow[];
}

/**
 * Create an investment bucket. The `(household_id, slug)` unique constraint means
 * each caixinha kind (filhos / casa / independencia_financeira) exists once per
 * household; RLS scopes the insert.
 */
export async function createInvestmentBucket(
  client: AppSupabaseClient,
  input: { householdId: string; slug: InvestmentBucketSlug; name: string },
): Promise<InvestmentBucketRow> {
  const { data, error } = await client
    .from("investment_buckets")
    .insert(investmentBucketInsert(input))
    .select("*")
    .single();
  if (error !== null) {
    throw new Error(`createInvestmentBucket failed: ${error.message}`);
  }
  return data as InvestmentBucketRow;
}

/** Rename an investment bucket. RLS scopes the update to the household. */
export async function updateInvestmentBucket(
  client: AppSupabaseClient,
  householdId: string,
  bucketId: string,
  changes: { name: string },
): Promise<void> {
  const { error } = await client
    .from("investment_buckets")
    .update({ name: changes.name.trim() })
    .eq("household_id", householdId)
    .eq("id", bucketId);
  if (error !== null) {
    throw new Error(`updateInvestmentBucket failed: ${error.message}`);
  }
}

/** Delete an investment bucket. RLS scopes the delete to the household. */
export async function deleteInvestmentBucket(
  client: AppSupabaseClient,
  householdId: string,
  bucketId: string,
): Promise<void> {
  const { error } = await client
    .from("investment_buckets")
    .delete()
    .eq("household_id", householdId)
    .eq("id", bucketId);
  if (error !== null) {
    throw new Error(`deleteInvestmentBucket failed: ${error.message}`);
  }
}

// --- Credit cards ----------------------------------------------------------

/** List credit cards for a household, ordered by name. */
export async function listCreditCards(
  client: AppSupabaseClient,
  householdId: string,
): Promise<CreditCardRow[]> {
  const { data, error } = await client
    .from("credit_cards")
    .select("*")
    .eq("household_id", householdId)
    .order("name", { ascending: true });
  if (error !== null) {
    throw new Error(`listCreditCards failed: ${error.message}`);
  }
  return (data ?? []) as CreditCardRow[];
}

/**
 * All installment groups of a household, for import-preview dedupe (spec §4).
 * Household-wide on purpose: the preview runs before a target card is chosen,
 * and a broader candidate set only ADDS visible, overridable "already exists"
 * flags. RLS re-checks the household filter.
 */
export async function listInstallmentGroupsByHousehold(
  client: AppSupabaseClient,
  householdId: string,
): Promise<InstallmentGroupRow[]> {
  const { data, error } = await client
    .from("installment_groups")
    .select("*")
    .eq("household_id", householdId);
  if (error !== null) {
    throw new Error(`listInstallmentGroupsByHousehold failed: ${error.message}`);
  }
  return (data ?? []) as InstallmentGroupRow[];
}

/** Minimal card-paid transaction summary for against-DB import dedupe. */
export type CardChargeSummary = {
  occurred_on: string;
  amount_cents: number;
  kind: string;
  description: string;
};

/**
 * Card-paid transactions of a household inside [startDate, endDate], for the
 * against-DB flat-charge dedupe (spec §4): a re-imported fatura must flag rows
 * already written instead of silently duplicating them.
 */
export async function findCardChargesBetween(
  client: AppSupabaseClient,
  householdId: string,
  startDate: string,
  endDate: string,
): Promise<CardChargeSummary[]> {
  const { data, error } = await client
    .from("transactions")
    .select("occurred_on, amount_cents, kind, description")
    .eq("household_id", householdId)
    .not("credit_card_id", "is", null)
    .gte("occurred_on", startDate)
    .lte("occurred_on", endDate);
  if (error !== null) {
    throw new Error(`findCardChargesBetween failed: ${error.message}`);
  }
  return (data ?? []) as CardChargeSummary[];
}

/** Create a credit card. RLS scopes the insert to the household. */
export async function createCreditCard(
  client: AppSupabaseClient,
  input: {
    householdId: string;
    name: string;
    closingDay?: number;
    dueDay?: number;
  },
): Promise<CreditCardRow> {
  const { data, error } = await client
    .from("credit_cards")
    .insert(creditCardInsert(input))
    .select("*")
    .single();
  if (error !== null) {
    throw new Error(`createCreditCard failed: ${error.message}`);
  }
  return data as CreditCardRow;
}

/** Update a credit card's name and optional invoice days. */
export async function updateCreditCard(
  client: AppSupabaseClient,
  householdId: string,
  cardId: string,
  changes: { name: string; closingDay?: number; dueDay?: number },
): Promise<void> {
  const { error } = await client
    .from("credit_cards")
    .update({
      name: changes.name.trim(),
      closing_day: changes.closingDay ?? null,
      due_day: changes.dueDay ?? null,
    })
    .eq("household_id", householdId)
    .eq("id", cardId);
  if (error !== null) {
    throw new Error(`updateCreditCard failed: ${error.message}`);
  }
}

/** Delete a credit card. RLS scopes the delete; FK restrict blocks if in use. */
export async function deleteCreditCard(
  client: AppSupabaseClient,
  householdId: string,
  cardId: string,
): Promise<void> {
  const { error } = await client
    .from("credit_cards")
    .delete()
    .eq("household_id", householdId)
    .eq("id", cardId);
  if (error !== null) {
    throw new Error(`deleteCreditCard failed: ${error.message}`);
  }
}

/**
 * Persist a parcelado card purchase from a validated domain `InstallmentPlan`:
 * insert the parent installment group and all of its month-attributed parcels in
 * ONE transaction. Returns the stored group + installment rows.
 *
 * Atomicity: this calls the `create_installment_purchase` plpgsql function (see
 * supabase/migrations/0002_create_installment_purchase.sql), whose body runs in a
 * single transaction — so a failed parcel insert can no longer orphan a childless
 * group. The function is SECURITY DEFINER and re-asserts household membership
 * (via `is_household_member`) before writing, preserving the RLS/household
 * isolation the table policies enforce. The amounts/due months come from the
 * domain plan; the parcels' group link is set server-side from the inserted id.
 */
export async function createInstallmentPurchase(
  client: AppSupabaseClient,
  plan: InstallmentPlan,
): Promise<{ group: InstallmentGroupRow; installments: InstallmentRow[] }> {
  const { data, error } = await client.rpc("create_installment_purchase", {
    group_payload: installmentGroupInsertFromPlan(plan),
    installments_payload: installmentInsertPayloadsFromPlan(plan),
  });
  if (error !== null) {
    throw new Error(`createInstallmentPurchase failed: ${error.message}`);
  }

  const result = data as {
    group: InstallmentGroupRow;
    installments: InstallmentRow[];
  };
  return {
    group: result.group,
    installments: result.installments ?? [],
  };
}

// ---------------------------------------------------------------------------
// Dashboard reads (Task 10) — all RLS-scoped by household_id.
// ---------------------------------------------------------------------------

/**
 * This month's card pressure for a household: direct card-paid transactions
 * (occurred in the month) plus installment parcels attributed to the month.
 * Reduced with the pure `summarizeCardPressure` helper.
 */
export async function getCardPressure(
  client: AppSupabaseClient,
  householdId: string,
  month: string,
): Promise<CardPressure> {
  const { start, end } = monthDateRange(month);

  const { data: txData, error: txError } = await client
    .from("transactions")
    .select("kind, amount_cents")
    .eq("household_id", householdId)
    .not("credit_card_id", "is", null)
    .gte("occurred_on", start)
    .lte("occurred_on", end);
  if (txError !== null) {
    throw new Error(`getCardPressure(transactions) failed: ${txError.message}`);
  }

  const { data: instData, error: instError } = await client
    .from("installments")
    .select("amount_cents")
    .eq("household_id", householdId)
    .eq("due_month", month);
  if (instError !== null) {
    throw new Error(`getCardPressure(installments) failed: ${instError.message}`);
  }

  return summarizeCardPressure(
    month,
    (txData ?? []) as Pick<TransactionRow, "kind" | "amount_cents">[],
    (instData ?? []) as Pick<InstallmentRow, "amount_cents">[],
  );
}

/**
 * Card pressure for ONE credit card in a month: direct card purchases plus
 * parcelas due that month, both scoped to `creditCardId`. Same reduction as
 * the household-wide `getCardPressure` (pure `summarizeCardPressure`); the
 * /resumo screen calls this per card for the "fatura projetada" list.
 */
export async function getCardPressureForCard(
  client: AppSupabaseClient,
  householdId: string,
  creditCardId: string,
  month: string,
): Promise<CardPressure> {
  const { start, end } = monthDateRange(month);

  const { data: txData, error: txError } = await client
    .from("transactions")
    .select("kind, amount_cents")
    .eq("household_id", householdId)
    .eq("credit_card_id", creditCardId)
    .gte("occurred_on", start)
    .lte("occurred_on", end);
  if (txError !== null) {
    throw new Error(
      `getCardPressureForCard(transactions) failed: ${txError.message}`,
    );
  }

  const { data: instData, error: instError } = await client
    .from("installments")
    .select("amount_cents")
    .eq("household_id", householdId)
    .eq("credit_card_id", creditCardId)
    .eq("due_month", month);
  if (instError !== null) {
    throw new Error(
      `getCardPressureForCard(installments) failed: ${instError.message}`,
    );
  }

  return summarizeCardPressure(
    month,
    (txData ?? []) as Pick<TransactionRow, "kind" | "amount_cents">[],
    (instData ?? []) as Pick<InstallmentRow, "amount_cents">[],
  );
}

/**
 * Upcoming installment parcels from this month onward, ordered by due month,
 * limited for the dashboard. Surfaces "próximas parcelas relevantes".
 */
export async function findUpcomingInstallments(
  client: AppSupabaseClient,
  householdId: string,
  fromMonth: string,
  limit = 5,
): Promise<UpcomingInstallment[]> {
  const { data, error } = await client
    .from("installments")
    .select(
      "id, description, number, installment_count, amount_cents, due_month, credit_card_id",
    )
    .eq("household_id", householdId)
    .gte("due_month", fromMonth)
    .order("due_month", { ascending: true })
    .order("description", { ascending: true })
    .limit(limit);
  if (error !== null) {
    throw new Error(`findUpcomingInstallments failed: ${error.message}`);
  }
  return (
    (data ?? []) as Array<
      Pick<
        InstallmentRow,
        | "id"
        | "description"
        | "number"
        | "installment_count"
        | "amount_cents"
        | "due_month"
        | "credit_card_id"
      >
    >
  ).map(mapUpcomingInstallment);
}

/**
 * The most recently recorded transactions for a household, newest first
 * (by occurred date, then insert time). Used by the dashboard "recent" list.
 */
export async function findRecentTransactions(
  client: AppSupabaseClient,
  householdId: string,
  limit = 8,
): Promise<DashboardTransaction[]> {
  const { data, error } = await client
    .from("transactions")
    .select(
      "id, kind, amount_cents, occurred_on, description, category_id, credit_card_id",
    )
    .eq("household_id", householdId)
    .order("occurred_on", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error !== null) {
    throw new Error(`findRecentTransactions failed: ${error.message}`);
  }
  return (
    (data ?? []) as Array<
      Pick<
        TransactionRow,
        | "id"
        | "kind"
        | "amount_cents"
        | "occurred_on"
        | "description"
        | "category_id"
        | "credit_card_id"
      >
    >
  ).map(mapDashboardTransaction);
}

/**
 * Transactions that still need review (no macro category yet), newest first.
 * The `category_id IS NULL` filter is the MVP "needs review" rule (see the pure
 * `needsReview` helper); `transfer` rows are excluded.
 */
export async function findPendingReviewTransactions(
  client: AppSupabaseClient,
  householdId: string,
  limit = 8,
): Promise<DashboardTransaction[]> {
  const { data, error } = await client
    .from("transactions")
    .select(
      "id, kind, amount_cents, occurred_on, description, category_id, credit_card_id",
    )
    .eq("household_id", householdId)
    .is("category_id", null)
    .neq("kind", "transfer")
    .order("occurred_on", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error !== null) {
    throw new Error(`findPendingReviewTransactions failed: ${error.message}`);
  }
  return (
    (data ?? []) as Array<
      Pick<
        TransactionRow,
        | "id"
        | "kind"
        | "amount_cents"
        | "occurred_on"
        | "description"
        | "category_id"
        | "credit_card_id"
      >
    >
  ).map(mapDashboardTransaction);
}

// ---------------------------------------------------------------------------
// Transações view (v1.0 Task 2) — filtered listing, inline edit, delete.
//
// These power the web "/transactions" screen: a paginated, filterable listing
// plus per-row category/responsibility/description/date edits and deletion.
// Every query is household-scoped (`.eq("household_id", ...)`) on top of RLS.
// ---------------------------------------------------------------------------

/** Filters accepted by `findTransactionsFiltered`. All optional / combinable. */
export type TransactionFilters = {
  /** `YYYY-MM` — restricts `occurred_on` to the month via `monthDateRange`. */
  month?: string;
  accountId?: string;
  creditCardId?: string;
  categoryId?: string;
  /** A member's user id, or the literal `"household"` for scope = household. */
  responsible?: string | "household";
  /** Only rows needing review: kind != 'transfer' AND category_id IS NULL. */
  pendingOnly?: boolean;
  /** Case-insensitive substring match on the description. */
  search?: string;
};

/**
 * A listing row for the Transações screen: the domain-shaped transaction plus
 * the linkage fields the table renders/edits (payment source, parcela link,
 * current responsibility).
 */
export type TransactionListItem = PersistedTransaction & {
  accountId: string | null;
  creditCardId: string | null;
  /** Non-null marks a parcela row (delete is refused for these). */
  installmentId: string | null;
  responsibilityScope: ResponsibilityScope;
  responsibleUserId: string | null;
};

/** Map a raw row to a `TransactionListItem`. Pure. */
export function mapTransactionListItem(row: TransactionRow): TransactionListItem {
  return {
    ...mapTransactionRow(row),
    accountId: row.account_id,
    creditCardId: row.credit_card_id,
    installmentId: row.installment_id,
    responsibilityScope: row.responsibility_scope,
    responsibleUserId: row.responsible_user_id,
  };
}

export type TransactionPage = {
  rows: TransactionListItem[];
  /** Total rows matching the filters (across all pages). */
  total: number;
  page: number;
  pageSize: number;
};

/** Escape `%`/`_`/`\` so a user search term is matched literally by ilike. */
function escapeIlikePattern(term: string): string {
  return term.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/**
 * Paginated, filtered transaction listing for the Transações screen. Newest
 * first (occurred date, then insert time); `total` comes from the query's
 * exact count so the UI can render "anterior/próxima" pagination.
 */
export async function findTransactionsFiltered(
  client: AppSupabaseClient,
  householdId: string,
  filters: TransactionFilters,
  page = 1,
  pageSize = 50,
): Promise<TransactionPage> {
  let query = client
    .from("transactions")
    .select("*", { count: "exact" })
    .eq("household_id", householdId);

  if (filters.month !== undefined) {
    const { start, end } = monthDateRange(filters.month);
    query = query.gte("occurred_on", start).lte("occurred_on", end);
  }
  if (filters.accountId !== undefined) {
    query = query.eq("account_id", filters.accountId);
  }
  if (filters.creditCardId !== undefined) {
    query = query.eq("credit_card_id", filters.creditCardId);
  }
  if (filters.categoryId !== undefined) {
    query = query.eq("category_id", filters.categoryId);
  }
  if (filters.responsible !== undefined) {
    if (filters.responsible === "household") {
      query = query.eq("responsibility_scope", "household");
    } else {
      query = query.eq("responsible_user_id", filters.responsible);
    }
  }
  if (filters.pendingOnly === true) {
    // Same rule as the pure `needsReview` helper.
    query = query.neq("kind", "transfer").is("category_id", null);
  }
  if (filters.search !== undefined && filters.search.trim() !== "") {
    query = query.ilike(
      "description",
      `%${escapeIlikePattern(filters.search.trim())}%`,
    );
  }

  const from = (page - 1) * pageSize;
  const { data, error, count } = await query
    .order("occurred_on", { ascending: false })
    .order("created_at", { ascending: false })
    .range(from, from + pageSize - 1);
  if (error !== null) {
    throw new Error(`findTransactionsFiltered failed: ${error.message}`);
  }

  return {
    rows: ((data ?? []) as TransactionRow[]).map(mapTransactionListItem),
    total: count ?? 0,
    page,
    pageSize,
  };
}

/** Editable fields of a transaction row. Absent keys are left untouched. */
export type TransactionPatch = {
  categoryId?: string | null;
  subcategoryId?: string | null;
  description?: string;
  responsibility?: { scope: "household" } | { scope: "user"; userId: string };
  occurredOn?: string; // ISO date (YYYY-MM-DD)
  /** Integer cents > 0. Parcela rows refuse this (managed via the group). */
  amountCents?: number;
  /**
   * Swap the payment instrument. Maps to BOTH columns in one UPDATE so the
   * DB CHECK (exactly one of account/card) can never be violated mid-edit.
   * Parcela rows refuse this (managed via the group).
   */
  payment?:
    | { type: "account"; accountId: string }
    | { type: "card"; creditCardId: string };
};

/**
 * Pure: map a `TransactionPatch` onto the column-keyed partial update object.
 * Validates `occurredOn` (strict `YYYY-MM-DD`) and rejects an empty
 * description; error messages are pt-BR because the web actions surface them
 * to the household directly.
 */
export function transactionUpdateFromPatch(
  patch: TransactionPatch,
): Partial<TransactionInsert> {
  const update: Partial<TransactionInsert> = {};

  if (patch.categoryId !== undefined) {
    update.category_id = patch.categoryId;
  }
  if (patch.subcategoryId !== undefined) {
    update.subcategory_id = patch.subcategoryId;
  }
  if (patch.description !== undefined) {
    const description = patch.description.trim();
    if (description === "") {
      throw new Error("A descrição não pode ficar vazia.");
    }
    update.description = description;
  }
  if (patch.responsibility !== undefined) {
    if (patch.responsibility.scope === "user") {
      update.responsibility_scope = "user";
      update.responsible_user_id = patch.responsibility.userId;
    } else {
      update.responsibility_scope = "household";
      update.responsible_user_id = null;
    }
  }
  if (patch.occurredOn !== undefined) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(patch.occurredOn)) {
      throw new Error(
        `Data inválida "${patch.occurredOn}" — use o formato AAAA-MM-DD.`,
      );
    }
    update.occurred_on = patch.occurredOn;
  }
  if (patch.amountCents !== undefined) {
    if (!Number.isInteger(patch.amountCents) || patch.amountCents <= 0) {
      throw new Error("O valor precisa ser maior que zero.");
    }
    update.amount_cents = patch.amountCents;
  }
  if (patch.payment !== undefined) {
    if (patch.payment.type === "account") {
      if (patch.payment.accountId === "") {
        throw new Error("Escolha a conta do lançamento.");
      }
      update.account_id = patch.payment.accountId;
      update.credit_card_id = null;
    } else {
      if (patch.payment.creditCardId === "") {
        throw new Error("Escolha o cartão do lançamento.");
      }
      update.credit_card_id = patch.payment.creditCardId;
      update.account_id = null;
    }
  }

  return update;
}

/**
 * Apply a partial edit to one transaction. Validation happens in the pure
 * `transactionUpdateFromPatch`; an empty patch is a no-op (no query issued).
 * Parcela rows (linked to an installment) are refused for amount/payment edits:
 * installments are managed through their group, so editing a lone parcela's
 * amount or payment would silently unbalance the plan.
 */
export async function updateTransaction(
  client: AppSupabaseClient,
  householdId: string,
  transactionId: string,
  patch: TransactionPatch,
): Promise<void> {
  const update = transactionUpdateFromPatch(patch);
  if (Object.keys(update).length === 0) {
    return;
  }

  if (patch.amountCents !== undefined || patch.payment !== undefined) {
    const { data, error: lookupError } = await client
      .from("transactions")
      .select("installment_id, kind")
      .eq("household_id", householdId)
      .eq("id", transactionId)
      .maybeSingle();
    if (lookupError !== null) {
      throw new Error(`updateTransaction lookup failed: ${lookupError.message}`);
    }
    if (data !== null && data.installment_id !== null) {
      throw new Error(
        "Parcelas são gerenciadas pelo grupo do parcelamento — edite o parcelamento, não a parcela avulsa.",
      );
    }
    if (
      data !== null &&
      patch.payment !== undefined &&
      patch.payment.type === "card" &&
      data.kind === "income"
    ) {
      throw new Error("Entrada é sempre numa conta — escolha uma conta.");
    }
  }

  const { error } = await client
    .from("transactions")
    .update(update)
    .eq("household_id", householdId)
    .eq("id", transactionId);
  if (error !== null) {
    throw new Error(`updateTransaction failed: ${error.message}`);
  }
}

/**
 * Delete one transaction. Parcela rows (linked to an installment) are refused:
 * installments are managed through their group, so deleting a lone parcela
 * would silently unbalance the plan. The error message is pt-BR because the
 * web action surfaces it to the household directly.
 */
export async function deleteTransaction(
  client: AppSupabaseClient,
  householdId: string,
  transactionId: string,
): Promise<void> {
  const { data, error: lookupError } = await client
    .from("transactions")
    .select("installment_id")
    .eq("household_id", householdId)
    .eq("id", transactionId)
    .maybeSingle();
  if (lookupError !== null) {
    throw new Error(`deleteTransaction lookup failed: ${lookupError.message}`);
  }
  if (data === null) {
    return; // Nothing to delete (already gone or not this household's).
  }
  if (data.installment_id !== null) {
    throw new Error(
      "Parcelas são gerenciadas pelo grupo do parcelamento — não dá para excluir uma parcela avulsa.",
    );
  }

  const { error } = await client
    .from("transactions")
    .delete()
    .eq("household_id", householdId)
    .eq("id", transactionId);
  if (error !== null) {
    throw new Error(`deleteTransaction failed: ${error.message}`);
  }
}

// ---------------------------------------------------------------------------
// Household member profiles (v1.0 Task 2) — display names + Telegram link.
// ---------------------------------------------------------------------------

/** A household member as the settings screen shows it. */
export type HouseholdMemberProfile = {
  id: string;
  userId: string;
  role: string;
  isActive: boolean;
  displayName: string | null;
  telegramUserId: number | null;
  telegramUsername: string | null;
};

/** List a household's members (active first, then by creation time). */
export async function listHouseholdMembers(
  client: AppSupabaseClient,
  householdId: string,
): Promise<HouseholdMemberProfile[]> {
  const { data, error } = await client
    .from("household_members")
    .select("*")
    .eq("household_id", householdId)
    .order("created_at", { ascending: true });
  if (error !== null) {
    throw new Error(`listHouseholdMembers failed: ${error.message}`);
  }
  return ((data ?? []) as HouseholdMemberRow[]).map((row) => ({
    id: row.id,
    userId: row.user_id,
    role: row.role,
    isActive: row.is_active,
    displayName: row.display_name,
    telegramUserId: row.telegram_user_id,
    telegramUsername: row.telegram_username,
  }));
}

/**
 * Normalize a user-typed Telegram @username: strips the "@", trims and
 * lowercases (Telegram usernames are case-insensitive). Returns null for
 * blank input. Pure.
 */
export function normalizeTelegramUsername(value: string | null): string | null {
  const cleaned = (value ?? "").trim().replace(/^@/, "").toLowerCase();
  return cleaned === "" ? null : cleaned;
}

/**
 * Update a member's profile fields (display name and/or Telegram user id).
 * A blank display name is stored as null; the Telegram id must be an integer
 * (or null to unlink). Absent keys are left untouched.
 */
export async function updateHouseholdMember(
  client: AppSupabaseClient,
  householdId: string,
  memberId: string,
  changes: {
    displayName?: string | null;
    telegramUserId?: number | null;
    telegramUsername?: string | null;
  },
): Promise<void> {
  const update: Partial<HouseholdMemberRow> = {};
  if (changes.displayName !== undefined) {
    const name = changes.displayName?.trim() ?? "";
    update.display_name = name === "" ? null : name;
  }
  if (changes.telegramUserId !== undefined) {
    if (
      changes.telegramUserId !== null &&
      !Number.isSafeInteger(changes.telegramUserId)
    ) {
      throw new Error("O ID do Telegram precisa ser um número inteiro.");
    }
    update.telegram_user_id = changes.telegramUserId;
  }
  if (changes.telegramUsername !== undefined) {
    update.telegram_username = normalizeTelegramUsername(
      changes.telegramUsername,
    );
  }
  if (Object.keys(update).length === 0) {
    return;
  }
  const { data, error } = await client
    .from("household_members")
    .update(update)
    .eq("household_id", householdId)
    .eq("id", memberId)
    .select("id");
  if (error !== null) {
    throw new Error(`updateHouseholdMember failed: ${error.message}`);
  }
  // Under RLS a denied/missing row is NOT an error — it just updates nothing.
  // Surface that loudly instead of pretending the save worked.
  if ((data ?? []).length === 0) {
    throw new Error(
      "Não consegui salvar — nenhuma linha foi atualizada (permissão ou membro inexistente).",
    );
  }
}

// ---------------------------------------------------------------------------
// Investment bucket balances (v1.0 Task 2) — manual caixinha balance updates.
// ---------------------------------------------------------------------------

/**
 * Set a caixinha's manually-tracked balance (integer cents, never negative).
 * Validation runs BEFORE any I/O; the message is pt-BR because the web action
 * surfaces it to the household directly.
 */
export async function updateInvestmentBucketBalance(
  client: AppSupabaseClient,
  householdId: string,
  bucketId: string,
  balanceCents: number,
): Promise<void> {
  if (!Number.isInteger(balanceCents) || balanceCents < 0) {
    throw new Error(
      "O saldo precisa ser um valor não negativo, em centavos inteiros.",
    );
  }
  const { error } = await client
    .from("investment_buckets")
    .update({ balance_cents: balanceCents })
    .eq("household_id", householdId)
    .eq("id", bucketId);
  if (error !== null) {
    throw new Error(`updateInvestmentBucketBalance failed: ${error.message}`);
  }
}

// ---------------------------------------------------------------------------
// Bot heartbeat (v1.0 Task 2) — when did the bot last talk to us?
// ---------------------------------------------------------------------------

/** The most recent bot interaction of a household, or null if none yet. */
export async function findLastBotInteraction(
  client: AppSupabaseClient,
  householdId: string,
): Promise<
  Pick<BotInteractionRow, "created_at" | "input_kind" | "transaction_id"> | null
> {
  const { data, error } = await client
    .from("bot_interactions")
    .select("created_at, input_kind, transaction_id")
    .eq("household_id", householdId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error !== null) {
    throw new Error(`findLastBotInteraction failed: ${error.message}`);
  }
  return (
    (data as Pick<
      BotInteractionRow,
      "created_at" | "input_kind" | "transaction_id"
    > | null) ?? null
  );
}

// ---------------------------------------------------------------------------
// Bot identity + persistent conversations (v1.0 Task 8).
//
// These run ONLY with the bot's service-role client (see
// `createServiceRoleClient` in index.ts): `bot_conversations` has RLS enabled
// with zero policies, so anon/authenticated callers are denied every row, and
// the member lookup by Telegram id happens before there is any authenticated
// user session to scope RLS with.
// ---------------------------------------------------------------------------

/** The household member behind a Telegram user id, as the bot needs it. */
export type BotMemberIdentity = {
  householdId: string;
  userId: string;
  displayName: string | null;
};

/**
 * Resolve a Telegram user id to an active household member. Returns null when
 * no active member is linked to that Telegram id — the bot then politely
 * refuses instead of writing anything.
 */
export async function findMemberByTelegramUserId(
  client: AppSupabaseClient,
  telegramUserId: number,
): Promise<BotMemberIdentity | null> {
  const { data, error } = await client
    .from("household_members")
    .select("household_id, user_id, display_name")
    .eq("telegram_user_id", telegramUserId)
    .eq("is_active", true)
    .maybeSingle();
  if (error !== null) {
    throw new Error(`findMemberByTelegramUserId failed: ${error.message}`);
  }
  if (data === null) {
    return null;
  }
  const row = data as Pick<
    HouseholdMemberRow,
    "household_id" | "user_id" | "display_name"
  >;
  return {
    householdId: row.household_id,
    userId: row.user_id,
    displayName: row.display_name,
  };
}

/**
 * Resolve a Telegram sender to an active member: by the stable numeric id
 * first, then by @username (Telegram sends both in every update; usernames
 * are optional and changeable, ids are forever). On a username match the
 * numeric id is back-filled so future updates take the stable path even if
 * the username later changes. Service-role client only.
 */
export async function resolveTelegramMember(
  client: AppSupabaseClient,
  sender: { telegramUserId: number; telegramUsername?: string | null },
): Promise<BotMemberIdentity | null> {
  const byId = await findMemberByTelegramUserId(client, sender.telegramUserId);
  if (byId !== null) {
    return byId;
  }
  const username = normalizeTelegramUsername(sender.telegramUsername ?? null);
  if (username === null) {
    return null;
  }
  const { data, error } = await client
    .from("household_members")
    .select("id, household_id, user_id, display_name")
    .eq("telegram_username", username)
    .eq("is_active", true)
    .maybeSingle();
  if (error !== null) {
    throw new Error(`resolveTelegramMember failed: ${error.message}`);
  }
  if (data === null) {
    return null;
  }
  const row = data as Pick<
    HouseholdMemberRow,
    "id" | "household_id" | "user_id" | "display_name"
  >;
  // Best-effort back-fill; a failure here must not block the lançamento.
  try {
    await client
      .from("household_members")
      .update({ telegram_user_id: sender.telegramUserId })
      .eq("id", row.id);
  } catch {
    // ignored — resolution by username keeps working
  }
  return {
    householdId: row.household_id,
    userId: row.user_id,
    displayName: row.display_name,
  };
}

/**
 * Load a chat's persisted conversation state, or null when none exists. The
 * state is stored as opaque jsonb; the bot validates its shape on load (a
 * malformed or stale row is treated as absent there, not here).
 */
export async function loadBotConversation(
  client: AppSupabaseClient,
  chatId: number,
): Promise<{ state: unknown; updatedAt: string } | null> {
  const { data, error } = await client
    .from("bot_conversations")
    .select("state, updated_at")
    .eq("chat_id", chatId)
    .maybeSingle();
  if (error !== null) {
    throw new Error(`loadBotConversation failed: ${error.message}`);
  }
  if (data === null) {
    return null;
  }
  const row = data as Pick<BotConversationRow, "state" | "updated_at">;
  return { state: row.state, updatedAt: row.updated_at };
}

/** Upsert a chat's conversation state, refreshing `updated_at` to now. */
export async function saveBotConversation(
  client: AppSupabaseClient,
  chatId: number,
  state: unknown,
): Promise<void> {
  const { error } = await client.from("bot_conversations").upsert({
    chat_id: chatId,
    state,
    updated_at: new Date().toISOString(),
  });
  if (error !== null) {
    throw new Error(`saveBotConversation failed: ${error.message}`);
  }
}

/** Delete a chat's conversation state (finished or stale conversations). */
export async function deleteBotConversation(
  client: AppSupabaseClient,
  chatId: number,
): Promise<void> {
  const { error } = await client
    .from("bot_conversations")
    .delete()
    .eq("chat_id", chatId);
  if (error !== null) {
    throw new Error(`deleteBotConversation failed: ${error.message}`);
  }
}

// ---------------------------------------------------------------------------
// Obligations (recurring fixed obligations — migration 0011).
//
// An obligation is a TEMPLATE; months are projected by the pure domain
// `projectObligations` engine and a mark-paid materializes exactly one
// transactions row via the atomic `materialize_obligation_payment` RPC
// (idempotent through the unique partial index — no double-pay).
// ---------------------------------------------------------------------------

/** Pure: build the obligations insert payload from a validated domain draft. */
export function obligationInsertFromDraft(
  draft: ObligationDraft,
): ObligationInsert {
  const isUser = draft.responsibility.scope === "user";
  return {
    household_id: draft.householdId,
    description: draft.description,
    amount_cents: draft.amountCents,
    start_month: draft.startMonth,
    term_months: draft.termMonths,
    due_day: draft.dueDay,
    category_id: draft.category.categoryId ?? null,
    subcategory_id: draft.category.subcategoryId ?? null,
    responsibility_scope: isUser ? "user" : "household",
    responsible_user_id:
      draft.responsibility.scope === "user"
        ? draft.responsibility.userId
        : null,
    account_id: draft.accountId,
    status: "active",
    created_by_user_id: draft.createdByUserId,
  };
}

/** A persisted obligation surfaced in a domain-friendly camelCase shape. */
export type PersistedObligation = ProjectableObligation & {
  householdId: string;
  categoryId: string | null;
  subcategoryId: string | null;
  responsibilityScope: ResponsibilityScope;
  responsibleUserId: string | null;
  createdByUserId: string;
};

/** Pure: map an obligations row to the domain-facing shape. */
export function mapObligationRow(row: ObligationRow): PersistedObligation {
  return {
    id: row.id,
    householdId: row.household_id,
    description: row.description,
    amountCents: row.amount_cents,
    startMonth: row.start_month,
    termMonths: row.term_months,
    dueDay: row.due_day,
    categoryId: row.category_id,
    subcategoryId: row.subcategory_id,
    responsibilityScope: row.responsibility_scope,
    responsibleUserId: row.responsible_user_id,
    accountId: row.account_id,
    status: row.status,
    createdByUserId: row.created_by_user_id,
  };
}

/** Persist an obligation template. RLS scopes the insert to the household. */
export async function createObligation(
  client: AppSupabaseClient,
  draft: ObligationDraft,
): Promise<ObligationRow> {
  const { data, error } = await client
    .from("obligations")
    .insert(obligationInsertFromDraft(draft))
    .select("*")
    .single();
  if (error !== null) {
    throw new Error(`createObligation failed: ${error.message}`);
  }
  return data as ObligationRow;
}

/**
 * List a household's obligations, active only by default, ordered by
 * description. Pass a status to inspect ended/canceled templates too.
 */
export async function listObligations(
  client: AppSupabaseClient,
  householdId: string,
  options: { status?: ObligationStatus } = {},
): Promise<ObligationRow[]> {
  const { data, error } = await client
    .from("obligations")
    .select("*")
    .eq("household_id", householdId)
    .eq("status", options.status ?? "active")
    .order("description", { ascending: true });
  if (error !== null) {
    throw new Error(`listObligations failed: ${error.message}`);
  }
  return (data ?? []) as ObligationRow[];
}

/**
 * Cancel an obligation (soft: status = canceled). Past materialized payments
 * are kept; the projector simply stops emitting months for it.
 */
export async function cancelObligation(
  client: AppSupabaseClient,
  householdId: string,
  obligationId: string,
): Promise<void> {
  const { error } = await client
    .from("obligations")
    .update({ status: "canceled" })
    .eq("household_id", householdId)
    .eq("id", obligationId);
  if (error !== null) {
    throw new Error(`cancelObligation failed: ${error.message}`);
  }
}

/** Editable obligation fields. Absent keys are left untouched. */
export type ObligationChanges = {
  description?: string;
  amountCents?: number;
  dueDay?: number;
  accountId?: string;
  termMonths?: number | null;
  categoryId?: string | null;
  subcategoryId?: string | null;
};

/**
 * Pure: map `ObligationChanges` onto the column-keyed partial update.
 * Error messages are pt-BR because the web actions surface them directly.
 */
export function obligationUpdateFromChanges(
  changes: ObligationChanges,
): Partial<ObligationInsert> {
  const update: Partial<ObligationInsert> = {};
  if (changes.description !== undefined) {
    const description = changes.description.trim();
    if (description === "") {
      throw new Error("A descrição não pode ficar vazia.");
    }
    update.description = description;
  }
  if (changes.amountCents !== undefined) {
    if (!Number.isInteger(changes.amountCents) || changes.amountCents <= 0) {
      throw new Error("O valor mensal precisa ser positivo, em centavos inteiros.");
    }
    update.amount_cents = changes.amountCents;
  }
  if (changes.dueDay !== undefined) {
    if (
      !Number.isInteger(changes.dueDay) ||
      changes.dueDay < 1 ||
      changes.dueDay > 28
    ) {
      throw new Error("O dia de vencimento precisa estar entre 1 e 28.");
    }
    update.due_day = changes.dueDay;
  }
  if (changes.accountId !== undefined) {
    update.account_id = changes.accountId;
  }
  if (changes.termMonths !== undefined) {
    if (
      changes.termMonths !== null &&
      (!Number.isInteger(changes.termMonths) || changes.termMonths < 1)
    ) {
      throw new Error("O prazo precisa ser um número de meses positivo (ou vazio).");
    }
    update.term_months = changes.termMonths;
  }
  if (changes.categoryId !== undefined) {
    update.category_id = changes.categoryId;
  }
  if (changes.subcategoryId !== undefined) {
    update.subcategory_id = changes.subcategoryId;
  }
  return update;
}

/** Apply a partial edit to one obligation. Empty patch = no-op. */
export async function updateObligation(
  client: AppSupabaseClient,
  householdId: string,
  obligationId: string,
  changes: ObligationChanges,
): Promise<void> {
  const update = obligationUpdateFromChanges(changes);
  if (Object.keys(update).length === 0) {
    return;
  }
  const { error } = await client
    .from("obligations")
    .update(update)
    .eq("household_id", householdId)
    .eq("id", obligationId);
  if (error !== null) {
    throw new Error(`updateObligation failed: ${error.message}`);
  }
}

/**
 * Materialize one obligation month as a real transaction via the atomic
 * `materialize_obligation_payment` RPC (see migration 0011). Idempotent: a
 * repeat call for an already-paid month returns `already_paid: true` and
 * writes nothing. `paidOn` overrides the default `month + dueDay` occurred
 * date (the bot passes the message send date).
 */
export async function materializeObligationPayment(
  client: AppSupabaseClient,
  args: { obligationId: string; month: string; paidOn?: string },
): Promise<MaterializeObligationPaymentResult> {
  const { data, error } = await client.rpc("materialize_obligation_payment", {
    target_obligation_id: args.obligationId,
    target_month: args.month,
    paid_on: args.paidOn ?? null,
  });
  if (error !== null) {
    throw new Error(`materializeObligationPayment failed: ${error.message}`);
  }
  return data as MaterializeObligationPaymentResult;
}

/** Pure: `obligation_month` date ("2026-10-01") -> `YYYY-MM` ("2026-10"). */
export function obligationMonthYm(obligationMonth: string): string {
  const match = /^(\d{4}-(?:0[1-9]|1[0-2]))-\d{2}$/.exec(obligationMonth);
  if (match === null) {
    throw new Error(
      `Invalid obligation_month "${obligationMonth}", expected YYYY-MM-DD`,
    );
  }
  return match[1] as string;
}

export type ObligationPaymentKey = {
  obligationId: string;
  month: string;
  /** The MATERIALIZED transaction's amount — the actual paid, not the
   * (editable) template amount. */
  amountCents: number;
};

/**
 * The `(obligationId, month)` pairs already materialized inside a month
 * window — the paid set the projector subtracts (anti-double-count) — plus
 * each payment's actual amount, so callers never re-query the same rows.
 */
export async function listObligationPayments(
  client: AppSupabaseClient,
  householdId: string,
  fromMonth: string,
  toMonth: string,
): Promise<ObligationPaymentKey[]> {
  const { data, error } = await client
    .from("transactions")
    .select("obligation_id, obligation_month, amount_cents")
    .eq("household_id", householdId)
    .not("obligation_id", "is", null)
    .gte("obligation_month", `${fromMonth}-01`)
    .lte("obligation_month", `${toMonth}-01`);
  if (error !== null) {
    throw new Error(`listObligationPayments failed: ${error.message}`);
  }
  return (
    (data ?? []) as Array<
      Pick<
        TransactionRow,
        "obligation_id" | "obligation_month" | "amount_cents"
      >
    >
  ).map((row) => ({
    obligationId: row.obligation_id as string,
    month: obligationMonthYm(row.obligation_month as string),
    amountCents: row.amount_cents,
  }));
}

export type ObligationsPressure = {
  month: string;
  /** Sum of the month's projected obligations not yet paid. */
  projectedUnpaidCents: number;
  /** Sum of the month's materialized obligation payments (actuals). */
  paidCents: number;
  /** projectedUnpaidCents + paidCents — the month's fixed-obligation total. */
  totalCents: number;
};

/**
 * Reduce a month's projected entries + materialized payment rows into the
 * fixed-obligation pressure figure. Pure: callers fetch/project and pass here.
 */
export function summarizeObligationsPressure(
  month: string,
  projected: ProjectedEntry[],
  paidRows: Pick<TransactionRow, "amount_cents">[],
): ObligationsPressure {
  let projectedUnpaidCents = 0;
  for (const entry of projected) {
    projectedUnpaidCents += entry.amountCents;
  }
  let paidCents = 0;
  for (const row of paidRows) {
    paidCents += row.amount_cents;
  }
  return {
    month,
    projectedUnpaidCents,
    paidCents,
    totalCents: projectedUnpaidCents + paidCents,
  };
}

/**
 * This month's fixed-obligation pressure for a household: projected-unpaid
 * (via the pure domain projector, minus already-paid months) plus the month's
 * materialized actuals.
 */
export async function getObligationsPressure(
  client: AppSupabaseClient,
  householdId: string,
  month: string,
): Promise<ObligationsPressure> {
  // Independent reads — one parallel round trip; the payments query already
  // carries each actual's amount, so no third query over the same rows.
  const [obligations, payments] = await Promise.all([
    listObligations(client, householdId),
    listObligationPayments(client, householdId, month, month),
  ]);
  const paid = new Set(payments.map((p) => paidKey(p.obligationId, p.month)));
  const projected = projectObligations(obligations.map(mapObligationRow), {
    fromMonth: month,
    toMonth: month,
    paid,
  });

  return summarizeObligationsPressure(
    month,
    projected,
    payments.map((p) => ({ amount_cents: p.amountCents })),
  );
}
