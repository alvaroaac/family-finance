/**
 * End-to-end webhook-level stories for the card installment + card-bill
 * payment flows (PR-2 / Task 8). Exercises `handleWebhook` with the REAL
 * repos (createInstallmentPurchase, settleCardBill, summarizeMonth) against
 * an extended fake Supabase client — not the lower-level conversation unit
 * tests already covering every branch in isolation.
 *
 * Fixtures (fakeQueryBuilder/fakeSupabase/resolveMemberFake/textUpdate/
 * callbackUpdate/fakeTelegram/callbackUpdate) are copied verbatim from
 * bot-callbacks.test.ts, which itself documents copying them from
 * bot.test.ts. The only addition here is `.rpc()` support, since the bot's
 * inline fake client has none — this file adds a minimal implementation of
 * `create_installment_purchase` and `settle_card_bill` mirroring
 * apps/web/integration/fake-supabase.ts's `createInstallmentPurchaseRpc` /
 * `settleCardBillRpc`.
 */

import { describe, it, expect, vi } from "vitest";

import { handleWebhook } from "./index.js";
import { createInMemoryConversationStore } from "./store.js";
import type { TelegramClient, InlineKeyboardMarkup } from "./telegram.js";
import type { AppSupabaseClient, BotMemberIdentity } from "@family-finance/db";
import { summarizeMonth } from "@family-finance/db";
import type { InterpretedIntent, MessageClassifier } from "./interpret.js";
import { CARD_TOKEN_PREFIX, TOKENS } from "./keyboards.js";

// ---------------------------------------------------------------------------
// Fixtures copied verbatim from bot-callbacks.test.ts (itself copied from
// bot.test.ts), extended with `.rpc()`.
// ---------------------------------------------------------------------------

type FakeRow = Record<string, unknown>;

function fakeQueryBuilder(rows: FakeRow[]) {
  let filtered = [...rows];
  let deleteMode = false;
  let patch: FakeRow | null = null;
  const finish = (): { data: FakeRow[]; error: null } => {
    if (deleteMode) {
      for (const row of filtered) {
        const index = rows.indexOf(row);
        if (index >= 0) {
          rows.splice(index, 1);
        }
      }
    }
    if (patch !== null) {
      for (const row of filtered) {
        Object.assign(row, patch);
      }
    }
    return { data: filtered, error: null };
  };
  const api = {
    select() {
      return api;
    },
    insert(payload: FakeRow) {
      const row = { id: `row-${rows.length + 1}`, ...payload };
      rows.push(row);
      filtered = [row];
      return api;
    },
    upsert(payload: FakeRow) {
      const index = rows.findIndex((r) => r.chat_id === payload.chat_id);
      if (index >= 0) {
        rows[index] = { ...rows[index], ...payload };
        filtered = [rows[index] as FakeRow];
      } else {
        rows.push(payload);
        filtered = [payload];
      }
      return api;
    },
    delete() {
      deleteMode = true;
      filtered = [...rows];
      return api;
    },
    update(payload: FakeRow) {
      patch = payload;
      return api;
    },
    eq(column: string, value: unknown) {
      filtered = filtered.filter((r) => r[column] === value);
      return api;
    },
    // getCardPressureForCard/fetchAllRows also filter with gte/lte/not before
    // paging with .range() — the real repos chain these on transactions and
    // installments reads.
    gte(column: string, value: unknown) {
      filtered = filtered.filter(
        (r) => (r[column] as string) >= (value as string),
      );
      return api;
    },
    lte(column: string, value: unknown) {
      filtered = filtered.filter(
        (r) => (r[column] as string) <= (value as string),
      );
      return api;
    },
    not(column: string, _operator: string, value: unknown) {
      filtered = filtered.filter((r) => r[column] !== value);
      return api;
    },
    range(from: number, to: number) {
      filtered = filtered.slice(from, to + 1);
      return api;
    },
    order() {
      return api;
    },
    limit(n: number) {
      filtered = filtered.slice(0, n);
      return api;
    },
    async single() {
      const result = finish();
      const first = result.data[0];
      return first !== undefined
        ? { data: first, error: null }
        : { data: null, error: { message: "no rows" } };
    },
    async maybeSingle() {
      const result = finish();
      return { data: result.data[0] ?? null, error: null };
    },
    then(
      onFulfilled: (value: { data: FakeRow[]; error: null }) => unknown,
      onRejected?: (reason: unknown) => unknown,
    ) {
      return Promise.resolve(finish()).then(onFulfilled, onRejected);
    },
  };
  return api;
}

/**
 * `create_installment_purchase`: materialize group + parcels into
 * `installment_groups`/`installments`, mirroring
 * apps/web/integration/fake-supabase.ts's `createInstallmentPurchaseRpc`.
 * No idempotency check — every call inserts a fresh group + parcels (matches
 * the web fake; the real SQL function is the one atomicity guarantee).
 */
function createInstallmentPurchaseRpc(
  tables: Record<string, FakeRow[]>,
  args: { group_payload: FakeRow; installments_payload: FakeRow[] },
): { data: { group: FakeRow; installments: FakeRow[] }; error: null } {
  const groups = tables.installment_groups ?? (tables.installment_groups = []);
  const installments = tables.installments ?? (tables.installments = []);

  const group: FakeRow = {
    id: `group-${groups.length + 1}`,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...args.group_payload,
  };
  groups.push(group);

  const rows = args.installments_payload.map((parcel, index) => {
    const row: FakeRow = {
      id: `installment-${installments.length + index + 1}`,
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
      ...parcel,
      household_id: group.household_id,
      installment_group_id: group.id,
    };
    return row;
  });
  installments.push(...rows);

  return { data: { group, installments: rows }, error: null };
}

/**
 * `settle_card_bill`: idempotent on (credit_card_id, bill_month, kind
 * transfer), mirroring `settleCardBillRpc` in
 * apps/web/integration/fake-supabase.ts (card lookup, description
 * `Fatura <name> — MM/YYYY`, both instruments, `already_paid`).
 */
function settleCardBillRpc(
  tables: Record<string, FakeRow[]>,
  args: {
    target_household_id: string;
    target_credit_card_id: string;
    target_account_id: string;
    target_bill_month: string;
    target_amount_cents: number;
    target_paid_on: string | null;
    target_created_by_user_id: string;
  },
): { data: FakeRow; error: { message: string } | null } {
  const cards = tables.credit_cards ?? [];
  const card = cards.find(
    (r) =>
      r.id === args.target_credit_card_id &&
      r.household_id === args.target_household_id,
  );
  if (card === undefined) {
    return {
      data: null as unknown as FakeRow,
      error: { message: `card ${args.target_credit_card_id} not found` },
    };
  }

  const transactions = tables.transactions ?? (tables.transactions = []);
  const existing = transactions.find(
    (r) =>
      r.kind === "transfer" &&
      r.credit_card_id === args.target_credit_card_id &&
      r.bill_month === args.target_bill_month,
  );
  if (existing !== undefined) {
    return {
      data: { transaction: existing, already_paid: true },
      error: null,
    };
  }

  const month = args.target_bill_month;
  const tx: FakeRow = {
    id: `txn-${transactions.length + 1}`,
    household_id: args.target_household_id,
    kind: "transfer",
    amount_cents: args.target_amount_cents,
    occurred_on: args.target_paid_on ?? `${month}-01`,
    description: `Fatura ${String(card.name)} — ${month.slice(5, 7)}/${month.slice(0, 4)}`,
    category_id: null,
    subcategory_id: null,
    account_id: args.target_account_id,
    credit_card_id: args.target_credit_card_id,
    installment_id: null,
    responsibility_scope: "household",
    responsible_user_id: null,
    created_by_user_id: args.target_created_by_user_id,
    import_batch_id: null,
    obligation_id: null,
    obligation_month: null,
    bill_month: month,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
  transactions.push(tx);

  return { data: { transaction: tx, already_paid: false }, error: null };
}

function fakeSupabase(seed: Record<string, FakeRow[]> = {}): {
  client: AppSupabaseClient;
  tables: Record<string, FakeRow[]>;
} {
  const tables: Record<string, FakeRow[]> = {
    categories: [
      {
        id: "cat-transport",
        household_id: "house-1",
        name: "Transporte",
        is_active: true,
      },
    ],
    subcategories: [],
    accounts: [
      {
        id: "acct-1",
        household_id: "house-1",
        kind: "checking",
        name: "Conta",
      },
    ],
    credit_cards: [],
    categorization_memory: [],
    household_members: [
      {
        id: "member-1",
        household_id: "house-1",
        user_id: "user-alvaro",
        display_name: "Alvaro",
        telegram_user_id: 777,
        is_active: true,
        role: "owner",
        created_at: "2026-01-01T00:00:00Z",
      },
      {
        id: "member-2",
        household_id: "house-1",
        user_id: "user-karol",
        display_name: "Karol",
        telegram_user_id: 888,
        is_active: true,
        role: "member",
        created_at: "2026-01-02T00:00:00Z",
      },
    ],
    transactions: [],
    bot_interactions: [],
    bot_conversations: [],
    installment_groups: [],
    installments: [],
    ...seed,
  };
  const client = {
    from(table: string) {
      return fakeQueryBuilder(tables[table] ?? (tables[table] = []));
    },
    rpc(name: string, args: Record<string, unknown>) {
      switch (name) {
        case "create_installment_purchase":
          return Promise.resolve(
            createInstallmentPurchaseRpc(
              tables,
              args as {
                group_payload: FakeRow;
                installments_payload: FakeRow[];
              },
            ),
          );
        case "settle_card_bill":
          return Promise.resolve(
            settleCardBillRpc(
              tables,
              args as {
                target_household_id: string;
                target_credit_card_id: string;
                target_account_id: string;
                target_bill_month: string;
                target_amount_cents: number;
                target_paid_on: string | null;
                target_created_by_user_id: string;
              },
            ),
          );
        default:
          throw new Error(`fake-supabase: unsupported .rpc(${name})`);
      }
    },
  } as unknown as AppSupabaseClient;
  return { client, tables };
}

const IDENTITIES: Record<string, BotMemberIdentity> = {
  "777": {
    householdId: "house-1",
    userId: "user-alvaro",
    displayName: "Alvaro",
  },
  "888": { householdId: "house-1", userId: "user-karol", displayName: "Karol" },
  "@karolzinha": {
    householdId: "house-1",
    userId: "user-karol",
    displayName: "Karol",
  },
};

const resolveMemberFake = async (sender: {
  telegramUserId: string;
  telegramUsername?: string;
}): Promise<BotMemberIdentity | null> =>
  IDENTITIES[sender.telegramUserId] ??
  (sender.telegramUsername !== undefined
    ? (IDENTITIES[`@${sender.telegramUsername.toLowerCase()}`] ?? null)
    : null);

function textUpdate(
  fromId: number,
  text: string,
  chatId = 555,
  fromUsername?: string,
): unknown {
  return {
    update_id: 1,
    message: {
      message_id: 1,
      chat: { id: chatId },
      from: { id: fromId, username: fromUsername },
      text,
    },
  };
}

const SECRET = "s3cr3t";

type SentMessage = {
  chatId: string;
  text: string;
  replyMarkup?: InlineKeyboardMarkup;
};

function fakeTelegram(): {
  telegram: TelegramClient;
  sent: SentMessage[];
  answered: { id: string; text?: string }[];
  stripped: { chatId: string; messageId: number }[];
} {
  const sent: SentMessage[] = [];
  const answered: { id: string; text?: string }[] = [];
  const stripped: { chatId: string; messageId: number }[] = [];
  return {
    sent,
    answered,
    stripped,
    telegram: {
      async sendMessage(chatId, text, options) {
        sent.push({ chatId, text, replyMarkup: options?.replyMarkup });
        return { messageId: 1000 + sent.length };
      },
      async answerCallbackQuery(id, text) {
        answered.push({ id, text });
      },
      async editMessageReplyMarkup(chatId, messageId) {
        stripped.push({ chatId, messageId });
      },
    },
  };
}

function callbackUpdate(
  fromId: number,
  data: string,
  chatId = 555,
  messageId = 1001,
): unknown {
  return {
    update_id: 2,
    callback_query: {
      id: `cbq-${data}`,
      from: { id: fromId },
      message: { message_id: messageId, chat: { id: chatId } },
      data,
    },
  };
}

// ---------------------------------------------------------------------------
// Classifier stubs (Task 4 intent payloads) — the real LLM is never called.
// ---------------------------------------------------------------------------

function classifierReturning(
  result: InterpretedIntent | null,
): MessageClassifier {
  return async () => result;
}

const CARD_SEED: FakeRow = {
  id: "card-1",
  household_id: "house-1",
  name: "Nubank",
  closing_day: 5,
  due_day: 12,
};

describe("bot card flows: end-to-end webhook integration (Task 8)", () => {
  it.each([
    ["returns null", null],
    [
      "incorrectly returns plain",
      {
        intent: "plain" as const,
        expense: { description: "Notebook 12x", amountCents: 30000 },
      },
    ],
  ])(
    "creates the canonical installment plan when the classifier %s",
    async (_label, classified) => {
      const { client, tables } = fakeSupabase({
        credit_cards: [{ ...CARD_SEED }],
      });
      const { telegram } = fakeTelegram();
      const store = createInMemoryConversationStore();
      const classifyMessage = classifierReturning(classified);

      for (const text of [
        "Notebook em 12x de 300 no credito nubank",
        "confirmar",
      ]) {
        await handleWebhook({
          rawBody: textUpdate(777, text),
          secretHeader: SECRET,
          configuredSecret: SECRET,
          client,
          telegram,
          resolveMember: resolveMemberFake,
          store,
          classifyMessage,
        });
      }

      expect(tables.installment_groups).toHaveLength(1);
      expect(tables.installments).toHaveLength(12);
      expect(tables.transactions ?? []).toHaveLength(0);
      expect(tables.installment_groups?.[0]?.description).toBe("Notebook");
      expect(
        tables.installments?.every((row) => row.description === "Notebook"),
      ).toBe(true);
    },
  );

  it("creates one flat card transaction for 1x even when AI says installment", async () => {
    const { client, tables } = fakeSupabase({
      credit_cards: [{ ...CARD_SEED }],
    });
    const { telegram } = fakeTelegram();
    const store = createInMemoryConversationStore();
    const classifyMessage = classifierReturning({
      intent: "card_installment",
      purchase: {
        description: "Notebook 12x",
        totalCents: 360000,
        installmentCount: 12,
      },
    });

    for (const text of ["Notebook 3600 em 1x no Nubank", "confirmar"]) {
      await handleWebhook({
        rawBody: textUpdate(777, text),
        secretHeader: SECRET,
        configuredSecret: SECRET,
        client,
        telegram,
        resolveMember: resolveMemberFake,
        store,
        classifyMessage,
      });
    }

    expect(tables.transactions).toHaveLength(1);
    expect(tables.installment_groups ?? []).toHaveLength(0);
    expect(tables.installments ?? []).toHaveLength(0);
  });

  it("defaults plain bot expenses to the Sao Paulo date near a UTC boundary", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-01T01:30:00Z"));
    try {
      const { client, tables } = fakeSupabase();
      const { telegram } = fakeTelegram();
      const store = createInMemoryConversationStore();

      await handleWebhook({
        rawBody: textUpdate(777, "mercado 10"),
        secretHeader: SECRET,
        configuredSecret: SECRET,
        client,
        telegram,
        resolveMember: resolveMemberFake,
        store,
      });

      await handleWebhook({
        rawBody: textUpdate(777, "confirmar"),
        secretHeader: SECRET,
        configuredSecret: SECRET,
        client,
        telegram,
        resolveMember: resolveMemberFake,
        store,
      });

      const transactions = tables.transactions ?? [];
      expect(transactions).toHaveLength(1);
      expect(transactions[0]?.occurred_on).toBe("2026-07-31");
    } finally {
      vi.useRealTimers();
    }
  });

  it("story 1: card installment purchase -> confirmar persists group + 12 parcels, closing_day respected", async () => {
    const { client, tables } = fakeSupabase({
      credit_cards: [{ ...CARD_SEED }],
    });
    const { telegram, sent } = fakeTelegram();
    const store = createInMemoryConversationStore();
    const classifyMessage = classifierReturning({
      intent: "card_installment",
      purchase: {
        description: "Notebook",
        totalCents: 360000,
        installmentCount: 12,
      },
    });

    await handleWebhook({
      rawBody: textUpdate(777, "notebook 3600 em 12x no nubank"),
      secretHeader: SECRET,
      configuredSecret: SECRET,
      client,
      telegram,
      resolveMember: resolveMemberFake,
      store,
      classifyMessage,
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]?.text).toContain("Nubank");
    expect(sent[0]?.text).toContain("12×");
    expect(tables.installment_groups).toHaveLength(0);

    await handleWebhook({
      rawBody: textUpdate(777, "confirmar"),
      secretHeader: SECRET,
      configuredSecret: SECRET,
      client,
      telegram,
      resolveMember: resolveMemberFake,
      store,
      classifyMessage,
    });

    expect(tables.installment_groups).toHaveLength(1);
    const group = (tables.installment_groups as FakeRow[])[0] as FakeRow;
    expect(group.total_amount_cents).toBe(360000);
    expect(group.installment_count).toBe(12);
    expect(group.credit_card_id).toBe("card-1");

    expect(tables.installments).toHaveLength(12);
    // Today (webhook uses the real current date) is AFTER closing_day 5, so
    // the first parcel's due_month must be the month AFTER the purchase
    // month — verified structurally rather than against a fixed date, since
    // handleWebhook always uses todayIso() (no injectable `today`).
    const todayIsoDate = new Date().toISOString().slice(0, 10);
    const purchaseMonth = todayIsoDate.slice(0, 7);
    const [py, pm] = purchaseMonth.split("-").map(Number) as [number, number];
    const purchaseDay = Number(todayIsoDate.slice(8, 10));
    const expectedFirstDue =
      purchaseDay > 5
        ? `${pm === 12 ? py + 1 : py}-${String(pm === 12 ? 1 : pm + 1).padStart(2, "0")}`
        : purchaseMonth;
    const firstParcel = (tables.installments as FakeRow[]).find(
      (row) => row.number === 1,
    );
    expect(firstParcel?.due_month).toBe(expectedFirstDue);
  });

  it("story 2 + 3: card-bill payment settles as ONE transfer row; summarizeMonth excludes it (no double count)", async () => {
    const todayIsoDate = new Date().toISOString().slice(0, 10);
    const month = todayIsoDate.slice(0, 7);
    const { client, tables } = fakeSupabase({
      credit_cards: [{ ...CARD_SEED }],
      // A direct card expense this month, feeding getCardPressureForCard's
      // "directCents" — this is the amount the bill confirmation should show.
      transactions: [
        {
          id: "txn-seed-1",
          household_id: "house-1",
          kind: "expense",
          amount_cents: 15000,
          occurred_on: `${month}-02`,
          description: "Mercado",
          category_id: null,
          subcategory_id: null,
          account_id: null,
          credit_card_id: "card-1",
          installment_id: null,
          responsibility_scope: "household",
          responsible_user_id: null,
          created_by_user_id: "user-alvaro",
          import_batch_id: null,
          obligation_id: null,
          obligation_month: null,
          bill_month: null,
        },
      ],
    });
    const { telegram, sent } = fakeTelegram();
    const store = createInMemoryConversationStore();
    const classifyMessage = classifierReturning({
      intent: "mark_paid",
      target: "card",
      keyword: "nubank",
    });

    // Before: the month's expense total from the direct card charge alone.
    const beforeSummary = summarizeMonth(
      month,
      tables.transactions as Array<{
        kind: string;
        amount_cents: number;
      }> as never,
    );
    expect(beforeSummary.expenseCents).toBe(15000);

    await handleWebhook({
      rawBody: textUpdate(777, "nubank pago"),
      secretHeader: SECRET,
      configuredSecret: SECRET,
      client,
      telegram,
      resolveMember: resolveMemberFake,
      store,
      classifyMessage,
    });

    expect(sent).toHaveLength(1);
    // The confirmation shows the computed pressure: the seeded direct expense
    // (150,00) since there are no parcels due this month.
    expect(sent[0]?.text).toContain("R$ 150,00");

    await handleWebhook({
      rawBody: textUpdate(777, "confirmar"),
      secretHeader: SECRET,
      configuredSecret: SECRET,
      client,
      telegram,
      resolveMember: resolveMemberFake,
      store,
      classifyMessage,
    });

    const transferRows = (tables.transactions as FakeRow[]).filter(
      (r) => r.kind === "transfer",
    );
    expect(transferRows).toHaveLength(1);
    const transfer = transferRows[0] as FakeRow;
    expect(transfer.account_id).toBe("acct-1");
    expect(transfer.credit_card_id).toBe("card-1");
    expect(transfer.bill_month).toBe(month);

    // Story 3: same expense total before and after — the transfer row is
    // excluded from summarizeMonth (no double count of the card spend).
    const afterSummary = summarizeMonth(
      month,
      tables.transactions as Array<{
        kind: string;
        amount_cents: number;
      }> as never,
    );
    expect(afterSummary.expenseCents).toBe(beforeSummary.expenseCents);
    expect(afterSummary.expenseCents).toBe(15000);
  });

  it("story 4: repeating 'nubank pago' + confirmar after settlement is an already-paid no-op (still one transfer row)", async () => {
    const todayIsoDate = new Date().toISOString().slice(0, 10);
    const month = todayIsoDate.slice(0, 7);
    const { client, tables } = fakeSupabase({
      credit_cards: [{ ...CARD_SEED }],
      // A direct card expense this month so the computed bill is nonzero —
      // a zero bill with no override is a terminal no-write no-op (never
      // reaches awaiting_card_bill_confirmation), which would make repeating
      // "nubank pago" meaningless for this story.
      transactions: [
        {
          id: "txn-seed-1",
          household_id: "house-1",
          kind: "expense",
          amount_cents: 15000,
          occurred_on: `${month}-02`,
          description: "Mercado",
          category_id: null,
          subcategory_id: null,
          account_id: null,
          credit_card_id: "card-1",
          installment_id: null,
          responsibility_scope: "household",
          responsible_user_id: null,
          created_by_user_id: "user-alvaro",
          import_batch_id: null,
          obligation_id: null,
          obligation_month: null,
          bill_month: null,
        },
      ],
    });
    const { telegram, sent } = fakeTelegram();
    const store = createInMemoryConversationStore();
    const classifyMessage = classifierReturning({
      intent: "mark_paid",
      target: "card",
      keyword: "nubank",
    });

    await handleWebhook({
      rawBody: textUpdate(777, "nubank pago"),
      secretHeader: SECRET,
      configuredSecret: SECRET,
      client,
      telegram,
      resolveMember: resolveMemberFake,
      store,
      classifyMessage,
    });
    await handleWebhook({
      rawBody: textUpdate(777, "confirmar"),
      secretHeader: SECRET,
      configuredSecret: SECRET,
      client,
      telegram,
      resolveMember: resolveMemberFake,
      store,
      classifyMessage,
    });
    expect(
      (tables.transactions as FakeRow[]).filter((r) => r.kind === "transfer"),
    ).toHaveLength(1);

    // Repeat the whole flow: a fresh "nubank pago" -> "confirmar".
    await handleWebhook({
      rawBody: textUpdate(777, "nubank pago"),
      secretHeader: SECRET,
      configuredSecret: SECRET,
      client,
      telegram,
      resolveMember: resolveMemberFake,
      store,
      classifyMessage,
    });
    await handleWebhook({
      rawBody: textUpdate(777, "confirmar"),
      secretHeader: SECRET,
      configuredSecret: SECRET,
      client,
      telegram,
      resolveMember: resolveMemberFake,
      store,
      classifyMessage,
    });

    const transferRows = (tables.transactions as FakeRow[]).filter(
      (r) => r.kind === "transfer",
    );
    expect(transferRows).toHaveLength(1);
    expect(transferRows[0]?.bill_month).toBe(month);
    // The already-paid no-op reply.
    const lastSent = sent[sent.length - 1];
    expect(lastSent?.text).toContain("já estava paga");
  });

  it("story 5: callback path parity — confirm installment via cf button; double-tap cf is a silent no-op with no second group", async () => {
    const { client, tables } = fakeSupabase({
      credit_cards: [{ ...CARD_SEED }],
    });
    const { telegram, answered } = fakeTelegram();
    const store = createInMemoryConversationStore();
    const classifyMessage = classifierReturning({
      intent: "card_installment",
      purchase: {
        description: "Notebook",
        totalCents: 360000,
        installmentCount: 12,
      },
    });

    await handleWebhook({
      rawBody: textUpdate(777, "notebook 3600 em 12x no nubank"),
      secretHeader: SECRET,
      configuredSecret: SECRET,
      client,
      telegram,
      resolveMember: resolveMemberFake,
      store,
      classifyMessage,
    });

    await handleWebhook({
      rawBody: callbackUpdate(777, TOKENS.confirm),
      secretHeader: SECRET,
      configuredSecret: SECRET,
      client,
      telegram,
      resolveMember: resolveMemberFake,
      store,
      classifyMessage,
    });

    expect(tables.installment_groups).toHaveLength(1);
    expect(tables.installments).toHaveLength(12);

    // Double-tap cf on the now-saved state.
    await handleWebhook({
      rawBody: callbackUpdate(777, TOKENS.confirm),
      secretHeader: SECRET,
      configuredSecret: SECRET,
      client,
      telegram,
      resolveMember: resolveMemberFake,
      store,
      classifyMessage,
    });

    expect(tables.installment_groups).toHaveLength(1);
    expect(tables.installments).toHaveLength(12);
    const lastAnswer = answered[answered.length - 1];
    expect(lastAnswer?.text).toBe("Já salvo ✅");
  });

  it("story 5 (card grid parity): cd:<card-1> tap resolves the card exactly like the keyword path", async () => {
    const { client, tables } = fakeSupabase({
      credit_cards: [
        { ...CARD_SEED },
        {
          id: "card-2",
          household_id: "house-1",
          name: "Inter",
          closing_day: 10,
          due_day: 20,
        },
      ],
    });
    const { telegram, sent } = fakeTelegram();
    const store = createInMemoryConversationStore();
    const classifyMessage = classifierReturning({
      intent: "card_installment",
      purchase: {
        description: "Notebook",
        totalCents: 360000,
        installmentCount: 12,
      },
    });

    await handleWebhook({
      rawBody: textUpdate(777, "notebook 3600 em 12x"),
      secretHeader: SECRET,
      configuredSecret: SECRET,
      client,
      telegram,
      resolveMember: resolveMemberFake,
      store,
      classifyMessage,
    });
    expect(sent[0]?.text).toContain("Qual cartão?");

    await handleWebhook({
      rawBody: callbackUpdate(777, `${CARD_TOKEN_PREFIX}card-1`),
      secretHeader: SECRET,
      configuredSecret: SECRET,
      client,
      telegram,
      resolveMember: resolveMemberFake,
      store,
      classifyMessage,
    });

    await handleWebhook({
      rawBody: callbackUpdate(777, TOKENS.confirm),
      secretHeader: SECRET,
      configuredSecret: SECRET,
      client,
      telegram,
      resolveMember: resolveMemberFake,
      store,
      classifyMessage,
    });

    expect(tables.installment_groups).toHaveLength(1);
    expect(
      ((tables.installment_groups as FakeRow[])[0] as FakeRow).credit_card_id,
    ).toBe("card-1");
  });
});
