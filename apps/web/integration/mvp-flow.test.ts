/**
 * MVP end-to-end review loop — OFFLINE service-level integration test (Task 11).
 *
 * This is the runnable half of Task 11. It exercises the WHOLE MVP story through
 * the real shared packages, with only the Supabase/Postgres edge replaced by an
 * in-memory fake (see ./fake-supabase.ts) and Telegram/AI replaced by injected
 * test doubles. There are NO live network calls. It runs under `pnpm test`
 * (vitest discovers `*.test.ts` in apps/web).
 *
 * The browser-level Playwright version of the same story lives in
 * `apps/web/e2e/mvp-flow.spec.ts` and runs against a real dev server + Supabase
 * (see docs/runbooks/local-mvp-verification.md); it is excluded from vitest.
 *
 * Story under test (spec §08 "the recorded data is useful"):
 *   1. Seed household "Casa" with two authorized users + accounts/card/catalog.
 *   2. Import synthetic fixture transactions via @family-finance/importers and
 *      CONFIRM them (persist through the domain + db write path).
 *   3. Correct ONE category -> a categorization_memory record is created AND it
 *      improves the next suggestion (source flips deterministic -> memory).
 *   4. Simulate a Telegram TEXT transaction through the bot conversation flow and
 *      confirm it (shared domain/categorization/db services, no second write
 *      path).
 *   5. Add ONE parcelado credit-card purchase (domain installment generation).
 *   6. Compute the dashboard totals via the Task 10 db queries and ASSERT they
 *      reconcile: income, expenses (imports + bot transaction), and card pressure
 *      (direct + this-month installment parcel).
 */

import { describe, it, expect, beforeEach } from "vitest";

import {
  importAdapters,
  buildImportPreview,
  type NormalizedImportRow,
} from "@family-finance/importers";
import {
  suggestCategory,
  memoryEntryFromCorrection,
  type CategoryCatalog,
  type CategorizationMemoryStore,
  type CategorizationContext,
  type CategorizationResult,
} from "@family-finance/categorization";
import {
  createTransactionDraft,
  createInstallmentPlan,
  type TransactionDraft,
} from "@family-finance/domain";
import {
  createTransaction,
  confirmImport as confirmImportBatch,
  transactionInsertFromDraft,
  createInstallmentPurchase,
  createCategorizationMemory,
  listActiveCategorizationMemory,
  findHouseholdIdForCurrentUser,
  getMonthlySummary,
  getCardPressure,
  findUpcomingInstallments,
  findRecentTransactions,
  findPendingReviewTransactions,
  listInvestmentBuckets,
  type AppSupabaseClient,
  type CategorizationMemoryRow,
  type ConfirmImportRowPayload,
} from "@family-finance/db";

import {
  startConversation,
  applyMessage,
  applyCallback,
  type ConversationDeps,
} from "../../bot/src/conversation.js";

import {
  FakeSupabaseStore,
  createFakeSupabaseClient,
} from "./fake-supabase.js";

// ---------------------------------------------------------------------------
// Fixed identifiers + a fixed "today" so every assertion is deterministic.
// ---------------------------------------------------------------------------

const HOUSEHOLD = "household-casa";
const ALVARO = "user-alvaro";
const KAROL = "user-karol";
const ACCOUNT = "account-corrente";
const INVEST_ACCOUNT = "account-investimento";
const CARD = "card-nubank";

const CAT_ALIMENTACAO = "cat-alimentacao";
const SUB_DELIVERY = "sub-delivery";
const CAT_TRANSPORTE = "cat-transporte";
const CAT_MORADIA = "cat-moradia";

const MONTH = "2026-06";
const TODAY = "2026-06-22";
// A Date inside MONTH; the dashboard queries take `now` to derive the month.
const NOW = new Date("2026-06-22T12:00:00Z");

// The household catalog the categorization engine + bot resolve names against.
const CATALOG: CategoryCatalog = {
  householdId: HOUSEHOLD,
  categories: [
    { id: CAT_ALIMENTACAO, name: "Alimentação" },
    { id: CAT_TRANSPORTE, name: "Transporte" },
    { id: CAT_MORADIA, name: "Moradia" },
  ],
  subcategories: [
    { id: SUB_DELIVERY, categoryId: CAT_ALIMENTACAO, name: "Delivery" },
  ],
};

// ---------------------------------------------------------------------------
// Synthetic fixture (NO real personal financial data) — Minhas Finanças CSV.
// June rows only, so they all land in the dashboard month.
// ---------------------------------------------------------------------------

const MINHAS_FINANCAS_CSV = [
  "Data;Descrição;Categoria;Valor;Tipo",
  "05/06/2026;Salário;Receita;5000,00;Receita",
  "08/06/2026;iFood pedido noite;;-45,90;Despesa",
  "12/06/2026;Mercado do Bairro;;-150,00;Despesa",
  "18/06/2026;Farmácia Saúde;;-30,00;Despesa",
].join("\n");

// Expected normalized magnitudes (cents) for the four CSV rows.
const SALARY_CENTS = 500000;
const IFOOD_CENTS = 4590;
const MERCADO_CENTS = 15000;
const FARMACIA_CENTS = 3000;

// ---------------------------------------------------------------------------
// Test harness: a freshly-seeded fake DB + the real repositories on top of it.
// ---------------------------------------------------------------------------

function seedStore(): FakeSupabaseStore {
  const ts = "2026-06-01T00:00:00Z";
  return new FakeSupabaseStore({
    households: [
      { id: HOUSEHOLD, name: "Casa", created_at: ts, updated_at: ts },
    ],
    household_members: [
      {
        id: "member-alvaro",
        household_id: HOUSEHOLD,
        user_id: ALVARO,
        role: "owner",
        is_active: true,
        created_at: ts,
        updated_at: ts,
      },
      {
        id: "member-karol",
        household_id: HOUSEHOLD,
        user_id: KAROL,
        role: "member",
        is_active: true,
        created_at: ts,
        updated_at: ts,
      },
    ],
    accounts: [
      {
        id: ACCOUNT,
        household_id: HOUSEHOLD,
        kind: "checking",
        name: "Conta Corrente",
        created_at: ts,
        updated_at: ts,
      },
      {
        id: INVEST_ACCOUNT,
        household_id: HOUSEHOLD,
        kind: "investment",
        name: "Conta Investimento",
        created_at: ts,
        updated_at: ts,
      },
    ],
    credit_cards: [
      {
        id: CARD,
        household_id: HOUSEHOLD,
        name: "Nubank",
        closing_day: 3,
        due_day: 10,
        created_at: ts,
        updated_at: ts,
      },
    ],
    investment_buckets: [
      {
        id: "bucket-filhos",
        household_id: HOUSEHOLD,
        slug: "filhos",
        name: "Filhos",
        created_at: ts,
        updated_at: ts,
      },
      {
        id: "bucket-casa",
        household_id: HOUSEHOLD,
        slug: "casa",
        name: "Casa",
        created_at: ts,
        updated_at: ts,
      },
      {
        id: "bucket-ifi",
        household_id: HOUSEHOLD,
        slug: "independencia_financeira",
        name: "Independência Financeira",
        created_at: ts,
        updated_at: ts,
      },
    ],
    categories: CATALOG.categories.map((c) => ({
      id: c.id,
      household_id: HOUSEHOLD,
      name: c.name,
      is_active: true,
      created_at: ts,
      updated_at: ts,
    })),
    subcategories: CATALOG.subcategories.map((s) => ({
      id: s.id,
      household_id: HOUSEHOLD,
      category_id: s.categoryId,
      name: s.name,
      is_active: true,
      created_at: ts,
      updated_at: ts,
    })),
    transactions: [],
    installment_groups: [],
    installments: [],
    categorization_memory: [],
    bot_interactions: [],
  });
}

/** A memory store backed by the REAL db read, so the engine sees corrections. */
function memoryStore(client: AppSupabaseClient): CategorizationMemoryStore {
  return {
    async findActiveByHousehold(householdId) {
      const rows: CategorizationMemoryRow[] =
        await listActiveCategorizationMemory(client, householdId);
      return rows.map((r) => ({
        id: r.id,
        householdId: r.household_id,
        pattern: r.pattern,
        categoryId: r.category_id,
        subcategoryId: r.subcategory_id,
        confidence: r.confidence,
        explanation: r.explanation,
        isActive: r.is_active,
      }));
    },
  };
}

let store: FakeSupabaseStore;
let client: AppSupabaseClient;

beforeEach(() => {
  store = seedStore();
  client = createFakeSupabaseClient(store) as unknown as AppSupabaseClient;
});

// ---------------------------------------------------------------------------
// Step 1 — household + members resolve through the real repository.
// ---------------------------------------------------------------------------

describe("MVP review loop — household + members", () => {
  it("resolves the seeded Casa household for an authorized member", async () => {
    const resolved = await findHouseholdIdForCurrentUser(client);
    expect(resolved).toBe(HOUSEHOLD);

    const members = store.table("household_members");
    expect(members.filter((m) => m.is_active === true)).toHaveLength(2);
    expect(members.map((m) => m.user_id)).toEqual(
      expect.arrayContaining([ALVARO, KAROL]),
    );
  });
});

// ---------------------------------------------------------------------------
// Step 2 — import synthetic fixtures and confirm them as transactions.
// ---------------------------------------------------------------------------

/** Parse + preview the CSV (the importer never touches the DB). */
async function previewFixture(): Promise<NormalizedImportRow[]> {
  const adapter = importAdapters["minhas-financas"];
  const result = await adapter.parse(MINHAS_FINANCAS_CSV);
  expect(result.errors).toEqual([]);

  const preview = buildImportPreview({
    source: result.source,
    rows: result.rows,
    errors: result.errors,
  });
  expect(preview.errorCount).toBe(0);
  expect(preview.duplicateCount).toBe(0);
  expect(preview.importableCount).toBe(4);
  return preview.rows;
}

/**
 * Confirm imported rows through the PRODUCTION write path: run each normalized
 * row through the categorization engine (memory -> rules -> none), build a domain
 * draft, then hand the drafts + per-row audit records to the REAL db repository
 * `confirmImport`, which calls the `confirm_import` RPC (the fake `.rpc`
 * emulation here stands in for the plpgsql function). This mirrors what the web
 * action `confirmImport` does, so the atomic batch + `import_batch_id` linkage +
 * `import_rows` audit trail are exercised by the same code path production uses —
 * not a per-row `createTransaction` loop. Returns each persisted transaction id +
 * its row for asserts.
 */
async function confirmImport(
  rows: NormalizedImportRow[],
): Promise<
  Array<{ id: string; row: NormalizedImportRow; categoryId?: string }>
> {
  // One audit/transaction payload per row, in order — the shape the RPC consumes.
  const suggestions: Array<{ row: NormalizedImportRow; categoryId?: string }> =
    [];
  const rowPayloads: ConfirmImportRowPayload[] = [];

  for (const row of rows) {
    const suggestion = await suggestCategory(
      {
        householdId: HOUSEHOLD,
        description: row.description,
        amountCents: row.amount.cents,
        occurredOn: row.occurredOn,
      },
      { catalog: CATALOG, memoryStore: memoryStore(client) },
    );
    const categoryId = suggestion.suggestion?.macroCategoryId;
    const subcategoryId = suggestion.suggestion?.subcategoryId;

    const built = createTransactionDraft({
      householdId: HOUSEHOLD,
      kind: row.kind,
      amount: row.amount,
      occurredOn: row.occurredOn,
      description: row.description,
      createdByUserId: ALVARO,
      payment: { type: "account", accountId: ACCOUNT },
      category:
        categoryId !== undefined ? { categoryId, subcategoryId } : undefined,
    });
    expect(built.ok).toBe(true);
    if (!built.ok) throw new Error("draft build failed");

    // The transaction payload the RPC bulk-inserts — without import_batch_id,
    // which the function fills from the batch it creates in the same transaction.
    const { import_batch_id: _drop, ...transaction } = transactionInsertFromDraft(
      built.value,
    );
    rowPayloads.push({
      household_id: HOUSEHOLD,
      source_line: row.sourceLine,
      occurred_on: row.occurredOn,
      amount_cents: row.kind === "expense" ? -row.amount.cents : row.amount.cents,
      description: row.description,
      error_message: null,
      is_duplicate: false,
      transaction,
    });
    suggestions.push({ row, categoryId });
  }

  // Atomic write: batch + kept transactions (linked via import_batch_id) +
  // import_rows audit trail, through the real repository RPC wrapper.
  const { batch, imported_rows } = await confirmImportBatch(
    client,
    {
      household_id: HOUSEHOLD,
      source: "minhas_financas_csv",
      status: "confirmed",
      total_rows: rows.length,
      imported_rows: rows.length,
      duplicate_rows: 0,
      error_rows: 0,
      notes: null,
      created_by_user_id: ALVARO,
    },
    rowPayloads,
  );
  expect(imported_rows).toBe(rows.length);

  // Resolve each persisted transaction id by joining the inserted batch's rows
  // back to the suggestion list, in insertion order (the RPC preserves it).
  const imported = store
    .table("transactions")
    .filter((t) => t.import_batch_id === batch.id);
  return suggestions.map((s, index) => {
    const tx = imported[index];
    if (tx === undefined) throw new Error("imported transaction missing");
    return { id: tx.id as string, row: s.row, categoryId: s.categoryId };
  });
}

describe("MVP review loop — import + confirm", () => {
  it("imports four synthetic rows and persists them on the checking account", async () => {
    const rows = await previewFixture();
    const persisted = await confirmImport(rows);

    expect(persisted).toHaveLength(4);
    const txTable = store.table("transactions");
    expect(txTable).toHaveLength(4);

    // Salary is income; the three expenses keep positive magnitudes + expense kind.
    const salary = txTable.find((t) => t.description === "Salário");
    expect(salary?.kind).toBe("income");
    expect(salary?.amount_cents).toBe(SALARY_CENTS);

    // iFood is categorized deterministically by the built-in rule (Alimentação > Delivery).
    const ifood = persisted.find((p) => p.row.description.includes("iFood"));
    expect(ifood?.categoryId).toBe(CAT_ALIMENTACAO);
    const ifoodRow = txTable.find((t) => t.id === ifood?.id);
    expect(ifoodRow?.subcategory_id).toBe(SUB_DELIVERY);

    // Mercado + Farmácia have no rule and no memory yet -> uncategorized.
    const mercado = persisted.find((p) =>
      p.row.description.includes("Mercado"),
    );
    expect(mercado?.categoryId).toBeUndefined();

    // The atomic confirm RPC created exactly one batch, linked EVERY imported
    // transaction to it via import_batch_id, and wrote one import_rows audit
    // record per row linked to both the batch and the produced transaction —
    // the audit trail + batch linkage the old per-row loop never populated.
    const batches = store.table("import_batches");
    expect(batches).toHaveLength(1);
    const batch = batches[0];
    expect(batch?.imported_rows).toBe(4);
    for (const tx of txTable) {
      expect(tx.import_batch_id).toBe(batch?.id);
    }
    const auditRows = store
      .table("import_rows")
      .filter((r) => r.import_batch_id === batch?.id);
    expect(auditRows).toHaveLength(4);
    // Every kept row's audit record points back at its persisted transaction.
    expect(auditRows.map((r) => r.transaction_id).sort()).toEqual(
      txTable.map((t) => t.id).sort(),
    );
  });
});

// ---------------------------------------------------------------------------
// Step 3 — correct a category, create memory, and prove the next suggestion improves.
// ---------------------------------------------------------------------------

describe("MVP review loop — category correction creates learning memory", () => {
  it("turns a correction into a categorization_memory record that improves the next suggestion", async () => {
    const rows = await previewFixture();
    await confirmImport(rows);

    // Before correction: "Mercado do Bairro" is uncategorized.
    const before = await suggestCategory(
      {
        householdId: HOUSEHOLD,
        description: "Mercado do Bairro",
        occurredOn: TODAY,
      },
      { catalog: CATALOG, memoryStore: memoryStore(client) },
    );
    expect(before.status).toBe("uncategorized");
    expect(before.suggestion).toBeNull();

    // The user corrects it to Alimentação. Build the memory entry (pure domain
    // of categorization) and persist it through the real repository.
    const entry = memoryEntryFromCorrection({
      householdId: HOUSEHOLD,
      pattern: "Mercado",
      categoryId: CAT_ALIMENTACAO,
      subcategoryId: null,
      catalog: CATALOG,
    });
    await createCategorizationMemory(client, {
      household_id: entry.householdId,
      pattern: entry.pattern,
      category_id: entry.categoryId,
      subcategory_id: entry.subcategoryId,
      confidence: entry.confidence,
      explanation: entry.explanation,
      is_active: entry.isActive,
      created_by_user_id: KAROL,
    });

    const memTable = store.table("categorization_memory");
    expect(memTable).toHaveLength(1);
    expect(memTable[0]?.pattern).toBe("Mercado");
    expect(memTable[0]?.category_id).toBe(CAT_ALIMENTACAO);

    // After correction: the SAME description now resolves from memory, with a
    // confident, explainable suggestion (the loop "learns").
    const after = await suggestCategory(
      {
        householdId: HOUSEHOLD,
        description: "Mercado do Bairro",
        occurredOn: TODAY,
      },
      { catalog: CATALOG, memoryStore: memoryStore(client) },
    );
    expect(after.status).toBe("matched");
    expect(after.suggestion?.source).toBe("memory");
    expect(after.suggestion?.macroCategoryId).toBe(CAT_ALIMENTACAO);
    expect(after.requiresConfirmation).toBe(false);
    expect(after.suggestion?.explanation).toContain("MERCADO");

    // And a brand-new "Mercado Central" purchase also benefits from the memory.
    const generalized = await suggestCategory(
      {
        householdId: HOUSEHOLD,
        description: "Mercado Central",
        occurredOn: TODAY,
      },
      { catalog: CATALOG, memoryStore: memoryStore(client) },
    );
    expect(generalized.suggestion?.source).toBe("memory");
    expect(generalized.suggestion?.macroCategoryId).toBe(CAT_ALIMENTACAO);
  });
});

// ---------------------------------------------------------------------------
// Step 4 — a Telegram text transaction through the SAME bot conversation flow.
// ---------------------------------------------------------------------------

/** Wire the bot conversation to the real shared services over the fake DB. */
function conversationDeps(): ConversationDeps {
  return {
    householdId: HOUSEHOLD,
    catalog: CATALOG,
    defaultAccountId: ACCOUNT,
    resolveCardId: () => CARD,
    resolveAccountId: () => ACCOUNT,
    resolveResponsibleUserId: (name: string) =>
      name.toLowerCase().includes("karol") ? KAROL : undefined,
    suggestCategory: (
      context: CategorizationContext,
    ): Promise<CategorizationResult> =>
      suggestCategory(context, {
        catalog: CATALOG,
        memoryStore: memoryStore(client),
      }),
    createTransaction: async (draft: TransactionDraft) =>
      createTransaction(client, draft),
    logInteraction: async (entry) => {
      store.table("bot_interactions").push({
        id: `bot-${store.table("bot_interactions").length + 1}`,
        household_id: HOUSEHOLD,
        channel: "telegram",
        external_chat_id: null,
        user_id: entry.fromUserId,
        input_kind: entry.inputKind,
        message_text: entry.messageText,
        confidence: entry.confidence ?? null,
        explanation: entry.explanation ?? null,
        transaction_id: entry.transactionId ?? null,
        created_at: NOW.toISOString(),
        updated_at: NOW.toISOString(),
      });
    },
  };
}

describe("MVP review loop — Telegram text entry", () => {
  it("turns a confirmed text message into a card transaction via the shared services", async () => {
    const deps = conversationDeps();

    // "Uber 32 reais hoje no cartão" -> Transporte by rule, on the card.
    const started = await startConversation(
      { text: "Uber 32 reais hoje no cartão", fromUserId: ALVARO },
      deps,
      { today: TODAY },
    );
    expect(started.state.status).toBe("awaiting_confirmation");
    expect(started.state.draft.amountCents).toBe(3200);
    expect(started.state.draft.cardId).toBe(CARD);
    expect(started.state.draft.categoryId).toBe(CAT_TRANSPORTE);

    // Confirmation is ON by default; nothing is saved until the user confirms.
    expect(store.table("transactions")).toHaveLength(0);

    const confirmed = await applyMessage(started.state, "confirmar", deps, {
      today: TODAY,
    });
    expect(confirmed.state.status).toBe("saved");
    expect(confirmed.transactionId).toBeDefined();

    const tx = store
      .table("transactions")
      .find((t) => t.id === confirmed.transactionId);
    expect(tx?.kind).toBe("expense");
    expect(tx?.amount_cents).toBe(3200);
    expect(tx?.credit_card_id).toBe(CARD);
    expect(tx?.occurred_on).toBe(TODAY);
    expect(tx?.created_by_user_id).toBe(ALVARO);
    // Default responsibility is the SENDER (2026-07-03 bot fix); "responsável
    // casa" moves it back to the house.
    expect(tx?.responsibility_scope).toBe("user");
    expect(tx?.responsible_user_id).toBe(ALVARO);

    // The interaction was logged for auditing.
    expect(store.table("bot_interactions")).toHaveLength(1);

    const buttonStarted = await startConversation(
      { text: "Uber 25 reais hoje no cartão", fromUserId: ALVARO },
      deps,
      { today: TODAY },
    );
    const buttonConfirmed = await applyCallback(buttonStarted.state, "cf", deps, {
      today: TODAY,
    });
    expect(buttonConfirmed.state.status).toBe("saved");
    expect(buttonConfirmed.transactionId).toBeDefined();
    expect(
      store.table("transactions").some((t) => t.id === buttonConfirmed.transactionId),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Step 5 — a parcelado credit-card purchase (domain installment generation).
// ---------------------------------------------------------------------------

describe("MVP review loop — parcelado card purchase", () => {
  it("generates and persists month-attributed installments that sum to the total", async () => {
    const plan = createInstallmentPlan({
      householdId: HOUSEHOLD,
      creditCardId: CARD,
      description: "Geladeira",
      totalAmount: { currency: "BRL", cents: 120000 },
      installmentCount: 3,
      purchasedOn: "2026-06-15",
      createdByUserId: ALVARO,
      category: { categoryId: CAT_MORADIA },
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) throw new Error("plan failed");

    const { group, installments } = await createInstallmentPurchase(
      client,
      plan.value,
    );
    expect(group.installment_count).toBe(3);
    expect(installments).toHaveLength(3);
    expect(installments.map((i) => i.due_month)).toEqual([
      "2026-06",
      "2026-07",
      "2026-08",
    ]);
    expect(installments.reduce((s, i) => s + i.amount_cents, 0)).toBe(120000);
    // 120000 / 3 splits evenly.
    expect(installments.map((i) => i.amount_cents)).toEqual([
      40000, 40000, 40000,
    ]);

    // The atomic RPC persisted the group AND every parcel, each linked to the
    // group id and scoped to the household (the SQL fills these server-side).
    const persistedGroups = store.table("installment_groups");
    expect(persistedGroups).toHaveLength(1);
    const persisted = store.table("installments");
    expect(persisted).toHaveLength(3);
    for (const parcel of persisted) {
      expect(parcel.installment_group_id).toBe(group.id);
      expect(parcel.household_id).toBe(HOUSEHOLD);
      expect(parcel.id).toBeDefined();
    }
  });
});

// ---------------------------------------------------------------------------
// Step 6 — the FULL story, then assert the dashboard reconciles.
//
// This mirrors `loadDashboardData` (apps/web/app/(app)/dashboard/queries.ts):
// the same six RLS-scoped reads, here over the fake DB, computed by the same
// Task 10 repository code.
// ---------------------------------------------------------------------------

async function runFullStory(): Promise<void> {
  // 2. Import + confirm.
  const rows = await previewFixture();
  await confirmImport(rows);

  // 3. Correct "Mercado" -> memory, then re-categorize the imported Mercado tx.
  const entry = memoryEntryFromCorrection({
    householdId: HOUSEHOLD,
    pattern: "Mercado",
    categoryId: CAT_ALIMENTACAO,
    subcategoryId: null,
    catalog: CATALOG,
  });
  await createCategorizationMemory(client, {
    household_id: entry.householdId,
    pattern: entry.pattern,
    category_id: entry.categoryId,
    subcategory_id: entry.subcategoryId,
    confidence: entry.confidence,
    explanation: entry.explanation,
    is_active: entry.isActive,
    created_by_user_id: KAROL,
  });
  // Apply the correction to the already-imported Mercado transaction.
  const mercadoTx = store
    .table("transactions")
    .find((t) => String(t.description).includes("Mercado"));
  if (mercadoTx !== undefined) {
    mercadoTx.category_id = CAT_ALIMENTACAO;
  }

  // 4. Telegram text -> confirmed card transaction.
  const deps = conversationDeps();
  const started = await startConversation(
    { text: "Uber 32 reais hoje no cartão", fromUserId: ALVARO },
    deps,
    { today: TODAY },
  );
  await applyMessage(started.state, "confirmar", deps, { today: TODAY });
  const buttonStarted = await startConversation(
    { text: "Uber 25 reais hoje no cartão", fromUserId: ALVARO },
    deps,
    { today: TODAY },
  );
  const buttonConfirmed = await applyCallback(buttonStarted.state, "cf", deps, {
    today: TODAY,
  });
  expect(buttonConfirmed.state.status).toBe("saved");

  // 5. Parcelado card purchase (Geladeira 3x).
  const plan = createInstallmentPlan({
    householdId: HOUSEHOLD,
    creditCardId: CARD,
    description: "Geladeira",
    totalAmount: { currency: "BRL", cents: 120000 },
    installmentCount: 3,
    purchasedOn: "2026-06-15",
    createdByUserId: ALVARO,
    category: { categoryId: CAT_MORADIA },
  });
  if (!plan.ok) throw new Error("plan failed");
  await createInstallmentPurchase(client, plan.value);
}

describe("MVP review loop — dashboard reconciles with the whole scenario", () => {
  it("income, expenses (imports + bot tx), and card pressure all add up", async () => {
    await runFullStory();

    const householdId = await findHouseholdIdForCurrentUser(client);
    expect(householdId).toBe(HOUSEHOLD);
    if (householdId === null) throw new Error("no household");

    // The same composition `loadDashboardData` performs (Task 10 reads).
    const [summary, cardPressure, upcoming, buckets, recent, pendingReview] =
      await Promise.all([
        getMonthlySummary(client, householdId, MONTH),
        getCardPressure(client, householdId, MONTH),
        findUpcomingInstallments(client, householdId, MONTH),
        listInvestmentBuckets(client, householdId),
        findRecentTransactions(client, householdId),
        findPendingReviewTransactions(client, householdId),
      ]);

    // --- Income: only the imported salary is income this month. ----------
    expect(summary.month).toBe(MONTH);
    expect(summary.incomeCents).toBe(SALARY_CENTS);

    // --- Expenses: three imported expenses + typed + inline bot card txs. -
    const BOT_UBER_CENTS = 3200;
    const BOT_BUTTON_UBER_CENTS = 2500;
    const expectedExpense =
      IFOOD_CENTS +
      MERCADO_CENTS +
      FARMACIA_CENTS +
      BOT_UBER_CENTS +
      BOT_BUTTON_UBER_CENTS;
    expect(summary.expenseCents).toBe(expectedExpense);

    // --- Balance: income - expense. -------------------------------------
    expect(summary.balanceCents).toBe(SALARY_CENTS - expectedExpense);

    // --- Card pressure: direct card expenses + June installment. ----------
    expect(cardPressure.directCents).toBe(BOT_UBER_CENTS + BOT_BUTTON_UBER_CENTS);
    expect(cardPressure.installmentCents).toBe(40000); // first Geladeira parcel
    expect(cardPressure.totalCents).toBe(
      BOT_UBER_CENTS + BOT_BUTTON_UBER_CENTS + 40000,
    );

    // --- Upcoming installments start this month (June, July, August). ----
    expect(upcoming).toHaveLength(3);
    expect(upcoming.map((u) => u.dueMonth)).toEqual([
      "2026-06",
      "2026-07",
      "2026-08",
    ]);

    // --- Caixinhas: the three MVP buckets are present (count + names). ----
    expect(buckets).toHaveLength(3);
    expect(buckets.map((b) => b.slug).sort()).toEqual([
      "casa",
      "filhos",
      "independencia_financeira",
    ]);

    // --- Recent + pending review reflect the recorded data. --------------
    // 4 imported + typed bot + inline-button bot = 6 transactions recorded.
    expect(store.table("transactions")).toHaveLength(6);
    expect(recent.length).toBeGreaterThan(0);

    // After correcting Mercado, only Farmácia remains uncategorized (iFood was
    // categorized by rule, Uber by rule, salary is income but uncategorized).
    const pendingDescriptions = pendingReview.map((p) => p.description);
    expect(pendingDescriptions).toContain("Farmácia Saúde");
    expect(pendingDescriptions).not.toContain("Mercado do Bairro");

    // Final sanity: the numbers the dashboard cards would show are internally
    // consistent (balance = income - expense, total = direct + installments).
    expect(summary.balanceCents).toBe(
      summary.incomeCents - summary.expenseCents,
    );
    expect(cardPressure.totalCents).toBe(
      cardPressure.directCents + cardPressure.installmentCents,
    );
  });
});
