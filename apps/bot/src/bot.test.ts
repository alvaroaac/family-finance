import { describe, it, expect, vi, beforeEach } from "vitest";

import { parseExpenseText } from "./parser.js";
import {
  verifyWebhookSecret,
  parseTelegramUpdate,
  type TelegramClient,
} from "./telegram.js";
import {
  startConversation,
  applyMessage,
  type ConversationDeps,
  type ConversationState,
} from "./conversation.js";

/** Read the first argument of the first call to a vitest mock (typed). */
function firstCallArg(mock: ReturnType<typeof vi.fn>): unknown {
  const calls = mock.mock.calls;
  const first = calls[0];
  return first ? first[0] : undefined;
}

// ---------------------------------------------------------------------------
// Fixtures (synthetic — no real personal financial data).
// ---------------------------------------------------------------------------

const CATALOG = {
  householdId: "house-1",
  categories: [
    { id: "cat-transport", name: "Transporte" },
    { id: "cat-food", name: "Alimentação" },
  ],
  subcategories: [
    { id: "sub-app", categoryId: "cat-transport", name: "Aplicativo" },
  ],
};

const TODAY = "2026-06-22";

// ---------------------------------------------------------------------------
// parser.ts
// ---------------------------------------------------------------------------

describe("parseExpenseText", () => {
  it("extracts a plain integer value in reais", () => {
    const parsed = parseExpenseText("Uber 32 reais ontem", { today: TODAY });
    expect(parsed.amountCents).toBe(3200);
    expect(parsed.description.toLowerCase()).toContain("uber");
    expect(parsed.occurredOn).toBe("2026-06-21");
  });

  it("extracts a decimal value written as R$ 32,50", () => {
    const parsed = parseExpenseText("Mercado R$ 32,50 hoje", { today: TODAY });
    expect(parsed.amountCents).toBe(3250);
    expect(parsed.occurredOn).toBe("2026-06-22");
  });

  it("parses an explicit DD/MM date hint", () => {
    const parsed = parseExpenseText("Padaria 10 reais 12/03", { today: TODAY });
    expect(parsed.amountCents).toBe(1000);
    expect(parsed.occurredOn).toBe("2026-03-12");
  });

  it("detects a card hint and an account hint", () => {
    const card = parseExpenseText("Almoço 40 reais no cartão", { today: TODAY });
    expect(card.cardHint).toBe(true);
    const acct = parseExpenseText("Almoço 40 reais no débito", { today: TODAY });
    expect(acct.accountHint).toBe(true);
  });

  it("marks value as uncertain when no number is present", () => {
    const parsed = parseExpenseText("Uber ontem", { today: TODAY });
    expect(parsed.amountCents).toBeUndefined();
    expect(parsed.uncertainFields).toContain("amount");
  });

  it("marks date as uncertain (defaults to today) when no date hint is present", () => {
    const parsed = parseExpenseText("Uber 32 reais", { today: TODAY });
    expect(parsed.occurredOn).toBe(TODAY);
    expect(parsed.uncertainFields).toContain("date");
  });
});

// ---------------------------------------------------------------------------
// telegram.ts
// ---------------------------------------------------------------------------

describe("verifyWebhookSecret", () => {
  it("accepts a matching secret token header", () => {
    expect(verifyWebhookSecret("s3cr3t", "s3cr3t")).toBe(true);
  });

  it("rejects a missing or mismatched secret token", () => {
    expect(verifyWebhookSecret(undefined, "s3cr3t")).toBe(false);
    expect(verifyWebhookSecret("nope", "s3cr3t")).toBe(false);
  });

  it("rejects everything when no secret is configured (fail closed)", () => {
    expect(verifyWebhookSecret("anything", undefined)).toBe(false);
  });
});

describe("parseTelegramUpdate", () => {
  it("extracts a text message into a normalized shape", () => {
    const update = {
      update_id: 1,
      message: {
        message_id: 10,
        chat: { id: 555 },
        from: { id: 777, is_bot: false },
        text: "Uber 32 reais ontem",
      },
    };
    const parsed = parseTelegramUpdate(update);
    expect(parsed).not.toBeNull();
    expect(parsed?.chatId).toBe("555");
    expect(parsed?.fromId).toBe("777");
    expect(parsed?.text).toBe("Uber 32 reais ontem");
  });

  it("returns null for an update without a text message", () => {
    expect(parseTelegramUpdate({ update_id: 2 })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// conversation.ts — confirmation state machine + persistence
// ---------------------------------------------------------------------------

function buildDeps(overrides: Partial<ConversationDeps> = {}): {
  deps: ConversationDeps;
  createTransaction: ReturnType<typeof vi.fn>;
  logInteraction: ReturnType<typeof vi.fn>;
} {
  const createTransaction = vi.fn(async (draft: unknown) => ({
    id: "txn-1",
    draft,
  }));
  const logInteraction = vi.fn(async () => undefined);

  const deps: ConversationDeps = {
    householdId: "house-1",
    catalog: CATALOG,
    // Default account used when no card/account is resolved.
    defaultAccountId: "acct-1",
    resolveCardId: () => "card-1",
    resolveAccountId: () => "acct-1",
    resolveResponsibleUserId: () => undefined,
    suggestCategory: async () => ({
      status: "matched" as const,
      suggestion: {
        macroCategoryId: "cat-transport",
        subcategoryId: "sub-app",
        confidence: 0.9,
        explanation: 'descrição contém "uber" -> Transporte > Aplicativo',
        source: "rule" as const,
      },
      requiresConfirmation: false,
    }),
    createTransaction,
    logInteraction,
    ...overrides,
  };
  return { deps, createTransaction, logInteraction };
}

describe("conversation: text -> confirmed transaction", () => {
  let deps: ConversationDeps;
  let createTransaction: ReturnType<typeof vi.fn>;
  let logInteraction: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    ({ deps, createTransaction, logInteraction } = buildDeps());
  });

  it("asks for confirmation before saving (does NOT persist on first message)", async () => {
    const { state, reply } = await startConversation(
      { text: "Uber 32 reais ontem", fromUserId: "user-alvaro" },
      deps,
      { today: TODAY },
    );

    expect(state.status).toBe("awaiting_confirmation");
    expect(createTransaction).not.toHaveBeenCalled();
    // The reply is an editable confirmation summary.
    expect(reply).toMatch(/confirm/i);
    expect(reply).toContain("32,00");
  });

  it("persists the transaction only after an explicit confirm", async () => {
    const started = await startConversation(
      { text: "Uber 32 reais ontem", fromUserId: "user-alvaro" },
      deps,
      { today: TODAY },
    );

    const confirmed = await applyMessage(started.state, "confirmar", deps);

    expect(confirmed.state.status).toBe("saved");
    expect(createTransaction).toHaveBeenCalledTimes(1);

    const savedDraft = firstCallArg(createTransaction) as {
      createdByUserId: string;
      responsibility: { scope: string };
      amount: { cents: number };
      category: { categoryId?: string };
      payment: { type: string };
    };
    // createdByUserId is the linked Telegram identity.
    expect(savedDraft.createdByUserId).toBe("user-alvaro");
    // Responsibility defaults to the house.
    expect(savedDraft.responsibility.scope).toBe("household");
    expect(savedDraft.amount.cents).toBe(3200);
    expect(savedDraft.category.categoryId).toBe("cat-transport");
    // Success reply confirms the save.
    expect(confirmed.reply).toMatch(/salv|registrad/i);
    // The interaction is logged for auditing.
    expect(logInteraction).toHaveBeenCalled();
  });

  it("applies a value correction before saving", async () => {
    const started = await startConversation(
      { text: "Uber 32 reais ontem", fromUserId: "user-alvaro" },
      deps,
      { today: TODAY },
    );

    const corrected = await applyMessage(
      started.state,
      "valor 45,90",
      deps,
    );
    expect(corrected.state.status).toBe("awaiting_confirmation");
    expect(corrected.state.draft.amountCents).toBe(4590);
    expect(createTransaction).not.toHaveBeenCalled();

    await applyMessage(corrected.state, "sim", deps);
    const savedDraft = firstCallArg(createTransaction) as {
      amount: { cents: number };
    };
    expect(savedDraft.amount.cents).toBe(4590);
  });

  it("applies a date correction before saving", async () => {
    const started = await startConversation(
      { text: "Uber 32 reais", fromUserId: "user-alvaro" },
      deps,
      { today: TODAY },
    );
    const corrected = await applyMessage(started.state, "data 15/01", deps);
    expect(corrected.state.draft.occurredOn).toBe("2026-01-15");
  });

  it("applies a responsible-person correction before saving", async () => {
    const resolveResponsibleUserId = vi.fn((name: string) =>
      name.toLowerCase().includes("karol") ? "user-karol" : undefined,
    );
    ({ deps, createTransaction } = buildDeps({ resolveResponsibleUserId }));

    const started = await startConversation(
      { text: "Uber 32 reais", fromUserId: "user-alvaro" },
      deps,
      { today: TODAY },
    );
    const corrected = await applyMessage(
      started.state,
      "responsável Karol",
      deps,
    );
    expect(corrected.state.draft.responsibleUserId).toBe("user-karol");

    await applyMessage(corrected.state, "confirmar", deps);
    const savedDraft = firstCallArg(createTransaction) as {
      responsibility: { scope: string; userId?: string };
    };
    expect(savedDraft.responsibility.scope).toBe("user");
    expect(savedDraft.responsibility.userId).toBe("user-karol");
  });

  it("supports a category correction before saving", async () => {
    const started = await startConversation(
      { text: "Almoço 40 reais", fromUserId: "user-alvaro" },
      deps,
      { today: TODAY },
    );
    const corrected = await applyMessage(
      started.state,
      "categoria Alimentação",
      deps,
    );
    expect(corrected.state.draft.categoryId).toBe("cat-food");
  });

  it("cancels without persisting", async () => {
    const started = await startConversation(
      { text: "Uber 32 reais", fromUserId: "user-alvaro" },
      deps,
      { today: TODAY },
    );
    const cancelled = await applyMessage(started.state, "cancelar", deps);
    expect(cancelled.state.status).toBe("cancelled");
    expect(createTransaction).not.toHaveBeenCalled();
  });

  it("does not save when the amount is missing; asks for the value", async () => {
    const started = await startConversation(
      { text: "Uber ontem", fromUserId: "user-alvaro" },
      deps,
      { today: TODAY },
    );
    expect(started.state.status).toBe("needs_amount");
    const confirmAttempt = await applyMessage(
      started.state,
      "confirmar",
      deps,
    );
    // Still cannot save without a value.
    expect(createTransaction).not.toHaveBeenCalled();
    expect(confirmAttempt.reply).toMatch(/valor/i);
  });
});
