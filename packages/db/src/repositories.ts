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
  type AccountKind,
  type InvestmentBucketSlug,
  type InstallmentPlan,
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
  AccountRow,
  InvestmentBucketRow,
  CreditCardRow,
  InstallmentGroupRow,
  InstallmentRow,
  InstallmentGroupInsertPayload,
  InstallmentInsertPayload,
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
