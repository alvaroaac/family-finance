import { afterEach, describe, expect, it, vi } from "vitest";
import * as conversation from "./conversation.js";
import type { ConversationDeps, ConversationState } from "./conversation.js";
import {
  createCaptureDraftHandler,
  createCaptureRateLimiter,
  toCaptureDraft,
} from "./capture.js";

const today = "2026-10-20";
const actor = {
  userId: "10000000-0000-4000-8000-000000000001",
  householdId: "20000000-0000-4000-8000-000000000001",
};
const request = {
  version: 1,
  requestId: "30000000-0000-4000-8000-000000000001",
  scopeKey: actor.householdId,
  actorUserId: actor.userId,
  today,
  text: "85 no mercado",
};
const writeNames = [
  "materializeObligationPayment",
  "createCategory",
  "restoreCategory",
  "createSubcategory",
  "restoreSubcategory",
  "seedCategorizationMemory",
  "createObligation",
  "createInstallmentPurchase",
  "settleCardBill",
  "reconcileLegacyCardBillPayment",
] as const;

function fixture(overrides: Partial<ConversationDeps> = {}) {
  const writes = Object.fromEntries(
    [...writeNames, "createTransaction", "logInteraction"].map((name) => [
      name,
      vi.fn(async (): Promise<never> => {
        throw new Error(`write: ${name}`);
      }),
    ]),
  );
  const deps: ConversationDeps = {
    ...writes,
    householdId: actor.householdId,
    catalog: {
      householdId: actor.householdId,
      categories: [{ id: "cat-food", name: "Alimentação" }],
      subcategories: [
        { id: "sub-market", categoryId: "cat-food", name: "Mercado" },
      ],
    },
    defaultAccountId: "account",
    resolveCardId: () => "card",
    resolveAccountId: () => "account",
    resolveResponsibleUserId: () => actor.userId,
    suggestCategory: vi.fn(async () => ({
      status: "uncategorized" as const,
      suggestion: null,
      requiresConfirmation: false,
    })),
    createTransaction: writes.createTransaction!,
    logInteraction: writes.logInteraction!,
    listActiveAccounts: () => [{ id: "account", name: "Conta" }],
    listActiveCards: () => [{ id: "card", name: "Nubank", closingDay: 10 }],
    listActiveMembers: () => [{ userId: actor.userId, displayName: "Membro" }],
    listActiveObligations: async () => [
      { id: "rent", description: "Aluguel", amountCents: 120000 },
    ],
    getCardBillAmount: async () => ({
      remainingCents: 10000,
      paidCents: 0,
      closed: true,
    }),
    ...overrides,
  };
  const buildCaptureDeps = vi.fn(async () => deps);
  const log = vi.fn();
  const handle = createCaptureDraftHandler({
    buildCaptureDeps,
    limiter: createCaptureRateLimiter(),
    log,
  });
  return { deps, writes, buildCaptureDeps, log, handle };
}

function state(overrides: Partial<ConversationState> = {}): ConversationState {
  return {
    status: "awaiting_confirmation",
    draft: {
      description: "Mercado",
      amountCents: 8500,
      occurredOn: today,
      kind: "expense",
      categoryId: "cat-food",
      subcategoryId: "sub-market",
      categoryExplanation: "Memória",
      accountId: "account",
      responsibleUserId: actor.userId,
      createdByUserId: actor.userId,
      inputKind: "text",
      needsAttention: true,
    },
    ...overrides,
  };
}

afterEach(() => vi.restoreAllMocks());

describe("capture read-only conversation pipeline", () => {
  it.each([
    "85 no mercado",
    "paguei aluguel",
    "nova categoria Pets",
    "paguei a fatura Nubank",
  ])("never calls any write dependency for %s", async (text) => {
    const { handle, writes } = fixture();
    const result = await handle({ ...request, text }, actor);
    expect([200, 422]).toContain(result.status);
    for (const write of Object.values(writes))
      expect(write).not.toHaveBeenCalled();
  });

  it("passes trimmed text, authenticated member, today, and read-only deps to startConversation", async () => {
    const start = vi
      .spyOn(conversation, "startConversation")
      .mockResolvedValue({ state: state(), reply: "" });
    const { handle, buildCaptureDeps, deps, writes } = fixture();
    expect(
      (await handle({ ...request, text: "  85 no mercado  " }, actor)).status,
    ).toBe(200);
    expect(buildCaptureDeps).toHaveBeenCalledWith(actor);
    expect(start).toHaveBeenCalledWith(
      { text: request.text, fromUserId: actor.userId, inputKind: "text" },
      expect.any(Object),
      { today },
    );
    const passed = start.mock.calls[0]![1];
    expect(passed.suggestCategory).toBe(deps.suggestCategory);
    for (const name of writeNames.filter(
      (n) => n !== "materializeObligationPayment",
    ))
      expect(passed).not.toHaveProperty(name);
    await expect(
      passed.materializeObligationPayment!({} as never),
    ).rejects.toThrow();
    await expect(passed.createTransaction({} as never)).rejects.toThrow();
    await passed.logInteraction({} as never);
    for (const write of Object.values(writes))
      expect(write).not.toHaveBeenCalled();
  });

  it.each([
    { version: 2 },
    { requestId: "bad" },
    { actorUserId: "bad" },
    { scopeKey: "bad" },
    { today: "20/10/2026" },
    { today: "2026-13-45" },
    { today: "2026-02-30" },
    { text: " " },
    { text: "a".repeat(501) },
    { text: 3 },
    { extra: true },
    { actorUserId: "40000000-0000-4000-8000-000000000001" },
    { scopeKey: "40000000-0000-4000-8000-000000000001" },
  ])("rejects invalid strict requests: %j", async (patch) => {
    const { handle, buildCaptureDeps } = fixture();
    expect(await handle({ ...request, ...patch }, actor)).toEqual({
      status: 400,
      body: { ok: false, error: "invalid_request" },
    });
    expect(buildCaptureDeps).not.toHaveBeenCalled();
  });

  it("accepts a valid leap day", async () => {
    vi.spyOn(conversation, "startConversation").mockResolvedValue({
      state: state(),
      reply: "",
    });
    const { handle } = fixture();
    expect(
      (await handle({ ...request, today: "2028-02-29" }, actor)).status,
    ).toBe(200);
  });

  it("answers unsupported_intent when an obligation payment is attempted, without writing", async () => {
    const { handle, writes } = fixture();
    expect(await handle({ ...request, text: "paguei aluguel" }, actor)).toEqual(
      {
        status: 422,
        body: { ok: false, error: "unsupported_intent" },
      },
    );
    for (const write of Object.values(writes))
      expect(write).not.toHaveBeenCalled();
  });

  it("answers unsupported_intent when the obligation attempt surfaces as a thrown error", async () => {
    vi.spyOn(conversation, "startConversation").mockImplementation(
      async (_input, deps) => {
        await deps.materializeObligationPayment!({} as never).catch(() => {});
        throw new Error("boom");
      },
    );
    const { handle } = fixture();
    expect(await handle(request, actor)).toEqual({
      status: 422,
      body: { ok: false, error: "unsupported_intent" },
    });
  });

  it.each([1, 500])("accepts %i characters after trimming", async (length) => {
    vi.spyOn(conversation, "startConversation").mockResolvedValue({
      state: state(),
      reply: "",
    });
    const { handle } = fixture();
    expect(
      (await handle({ ...request, text: ` ${"x".repeat(length)} ` }, actor))
        .status,
    ).toBe(200);
  });

  it.each(["buildCaptureDeps", "startConversation"])(
    "sanitizes and logs %s failures and releases the slot",
    async (source) => {
      const error = new Error("private provider details");
      const { handle, log, buildCaptureDeps } = fixture();
      if (source === "buildCaptureDeps")
        buildCaptureDeps.mockRejectedValueOnce(error);
      else
        vi.spyOn(conversation, "startConversation").mockRejectedValueOnce(
          error,
        );
      expect(await handle(request, actor)).toEqual({
        status: 503,
        body: { ok: false, error: "unavailable" },
      });
      expect(log).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ requestId: request.requestId, error }),
      );
      expect((await handle(request, actor)).status).toBe(200);
    },
  );

  it.each(["memory", "gpt-fallback"])(
    "uses the injected categorizer's %s result unchanged",
    async (source) => {
      const jev = vi.fn(async () => null);
      const gpt = vi.fn(async () => "GPT fallback");
      const suggestCategory = vi.fn(async () => {
        const explanation =
          source === "memory"
            ? "Memória confirmada"
            : ((await jev()) ?? (await gpt()));
        return {
          status: "matched" as const,
          requiresConfirmation: true,
          suggestion: {
            macroCategoryId: "cat-food",
            subcategoryId: "sub-market",
            confidence: 0.95,
            explanation,
            source: source === "memory" ? ("memory" as const) : ("ai" as const),
          },
        };
      });
      const { handle } = fixture({ suggestCategory });
      const result = await handle(request, actor);
      expect(result).toMatchObject({
        status: 200,
        body: {
          draft: {
            categoryId: "cat-food",
            explanation:
              source === "memory" ? "Memória confirmada" : "GPT fallback",
          },
        },
      });
      expect(suggestCategory).toHaveBeenCalledOnce();
    },
  );

  it.each([
    "categoryId",
    "subcategoryId",
    "accountId",
    "cardId",
    "responsibleUserId",
  ] as const)("drops an unknown %s", async (key) => {
    const mapped = state();
    mapped.draft[key] = "foreign";
    vi.spyOn(conversation, "startConversation").mockResolvedValue({
      state: mapped,
      reply: "",
    });
    const { handle } = fixture();
    const result = await handle(request, actor);
    expect(result.status).toBe(200);
    expect((result.body as { draft: object }).draft).not.toHaveProperty(
      key === "cardId" ? "creditCardId" : key,
    );
  });

  it("filters candidate ids, requires subcategory parent membership, and keeps only three valid candidates", async () => {
    const mapped = state();
    mapped.categoryCandidates = [
      "foreign",
      "cat-food",
      "cat-food",
      "cat-food",
      "cat-food",
    ].map((categoryId) => ({
      categoryId,
      categoryName: "Alimentação",
      subcategoryId: "foreign",
      confidence: 1,
      explanation: "Sugestão",
    }));
    vi.spyOn(conversation, "startConversation").mockResolvedValue({
      state: mapped,
      reply: "",
    });
    const { handle, deps } = fixture();
    deps.catalog.subcategories = [
      { id: "sub-market", categoryId: "other", name: "Outra" },
    ];
    const result = await handle(request, actor);
    expect(result).toMatchObject({
      status: 200,
      body: {
        draft: {
          candidates: Array.from({ length: 3 }, () => ({
            categoryId: "cat-food",
            explanation: "Sugestão",
          })),
        },
      },
    });
    expect((result.body as { draft: object }).draft).not.toHaveProperty(
      "subcategoryId",
    );
  });

  it("keeps known ids for both plain and installment drafts", async () => {
    const start = vi
      .spyOn(conversation, "startConversation")
      .mockResolvedValue({ state: state(), reply: "" });
    const { handle } = fixture();
    expect(await handle(request, actor)).toMatchObject({
      body: {
        draft: {
          categoryId: "cat-food",
          subcategoryId: "sub-market",
          accountId: "account",
          responsibleUserId: actor.userId,
        },
      },
    });
    start.mockResolvedValue({ state: installmentState(), reply: "" });
    expect(await handle(request, actor)).toMatchObject({
      body: {
        draft: {
          creditCardId: "card",
          categoryId: "cat-food",
          responsibleUserId: actor.userId,
        },
      },
    });
  });

  it("drops unknown installment ids and their fallback candidate", async () => {
    const mapped = installmentState();
    Object.assign(mapped.installmentDraft!, {
      cardId: "foreign",
      categoryId: "foreign",
      subcategoryId: "foreign",
      responsibleUserId: "foreign",
    });
    vi.spyOn(conversation, "startConversation").mockResolvedValue({
      state: mapped,
      reply: "",
    });
    const { handle } = fixture();
    const result = await handle(request, actor);
    expect(result).toMatchObject({ body: { draft: { candidates: [] } } });
    for (const id of [
      "creditCardId",
      "categoryId",
      "subcategoryId",
      "responsibleUserId",
    ])
      expect((result.body as { draft: object }).draft).not.toHaveProperty(id);
  });
});

function installmentState(): ConversationState {
  return state({
    status: "awaiting_installment_confirmation",
    installmentDraft: {
      idempotencyKey: "internal-only",
      description: "Notebook",
      totalCents: 120000,
      installmentCount: 12,
      purchasedOn: "2026-10-19",
      cardId: "card",
      categoryId: "cat-food",
      categoryExplanation: "Compra",
      responsibleUserId: actor.userId,
      createdByUserId: actor.userId,
    },
  });
}

describe("toCaptureDraft", () => {
  it("maps installment totals, count, card, date, category and explanation", () => {
    expect(toCaptureDraft(installmentState(), today)).toEqual({
      ok: true,
      intent: "card_installment",
      draft: {
        description: "Notebook",
        amountCents: 120000,
        installmentCount: 12,
        date: "2026-10-19",
        kind: "expense",
        creditCardId: "card",
        categoryId: "cat-food",
        responsibleUserId: actor.userId,
        candidates: [{ categoryId: "cat-food", explanation: "Compra" }],
        explanation: "Compra",
        needsReview: false,
      },
    });
  });

  it.each([
    "awaiting_confirmation",
    "needs_amount",
    "awaiting_payment_choice",
  ] as const)("maps %s to plain with one installment", (status) => {
    const mapped = state({ status });
    if (status === "needs_amount") delete mapped.draft.amountCents;
    mapped.draft.cardId = "card";
    const result = toCaptureDraft(mapped, today);
    expect(result).toMatchObject({
      ok: true,
      intent: "plain",
      draft: { installmentCount: 1, date: today, needsReview: false },
    });
    if (!result.ok) throw new Error("expected draft");
    if (status === "awaiting_payment_choice") {
      expect(result.draft).not.toHaveProperty("accountId");
      expect(result.draft).not.toHaveProperty("creditCardId");
    }
    if (status === "needs_amount")
      expect(result.draft).not.toHaveProperty("amountCents");
  });

  it.each([
    "saved",
    "awaiting_obligation_confirmation",
    "awaiting_installment_confirmation",
    "installment_submission_started",
    "installment_outcome_uncertain",
    "installment_recovery_required",
    "awaiting_card_bill_confirmation",
    "card_bill_submission_started",
    "awaiting_mark_paid_choice",
    "awaiting_category_name",
  ] as const)("rejects unsupported status %s", (status) => {
    expect(toCaptureDraft(state({ status }), today)).toEqual({
      ok: false,
      error: "unsupported_intent",
    });
  });

  it.each([
    "obligationDraft",
    "cardBillDraft",
    "markPaidCandidates",
    "markPaidAmountCents",
    "markPaidAccountId",
    "markPaidPaidOn",
  ] as const)("rejects plain states carrying %s", (key) => {
    const mapped = {
      ...state(),
      [key]: key.endsWith("Draft") ? {} : key === "markPaidCandidates" ? [] : 1,
    } as ConversationState;
    expect(toCaptureDraft(mapped, today)).toEqual({
      ok: false,
      error: "unsupported_intent",
    });
  });

  it("maps cancelled to non_financial", () => {
    expect(toCaptureDraft(state({ status: "cancelled" }), today)).toEqual({
      ok: false,
      error: "non_financial",
    });
  });

  it("takes the top three category candidates without exposing internal fields", () => {
    const mapped = state({
      categoryCandidates: Array.from({ length: 4 }, (_, i) => ({
        categoryId: `cat-${i}`,
        subcategoryId: `sub-${i}`,
        categoryName: "Categoria",
        confidence: 0.8,
        explanation: `Escolha ${i}`,
      })),
    });
    expect(toCaptureDraft(mapped, today)).toMatchObject({
      draft: {
        candidates: [0, 1, 2].map((i) => ({
          categoryId: `cat-${i}`,
          subcategoryId: `sub-${i}`,
          explanation: `Escolha ${i}`,
        })),
      },
    });
  });

  it("uses the suggested category only when candidates are absent and defaults explanation to empty", () => {
    const mapped = state();
    delete mapped.draft.categoryExplanation;
    expect(toCaptureDraft(mapped, today)).toMatchObject({
      draft: {
        explanation: "",
        candidates: [
          {
            categoryId: "cat-food",
            subcategoryId: "sub-market",
            explanation: "",
          },
        ],
      },
    });
    expect(
      toCaptureDraft({ ...mapped, categoryCandidates: [] }, today),
    ).toMatchObject({ draft: { candidates: [] } });
  });

  it("never exposes expense categories or candidates on income", () => {
    const mapped = state();
    mapped.draft.kind = "income";
    const result = toCaptureDraft(mapped, today);
    expect(result).toMatchObject({ draft: { kind: "income", candidates: [] } });
    if (!result.ok) throw new Error("expected draft");
    expect(result.draft).not.toHaveProperty("categoryId");
    expect(result.draft).not.toHaveProperty("subcategoryId");
  });

  it("rejects transfer drafts outside the closed capture contract", () => {
    const mapped = state();
    mapped.draft.kind = "transfer";
    expect(toCaptureDraft(mapped, today)).toEqual({
      ok: false,
      error: "unsupported_intent",
    });
  });
});

describe("capture rate limits", () => {
  it("returns 429 on the 21st request in 60 seconds, then resets; households are independent", async () => {
    let now = 0;
    const limiter = createCaptureRateLimiter({ now: () => now });
    const { deps } = fixture();
    const handle = createCaptureDraftHandler({
      buildCaptureDeps: async () => deps,
      limiter,
      log: vi.fn(),
    });
    for (let i = 0; i < 20; i++)
      expect((await handle(request, actor)).status).toBe(200);
    now = 59999;
    expect(await handle(request, actor)).toEqual({
      status: 429,
      body: { ok: false, error: "rate_limited" },
    });
    const other = {
      ...actor,
      householdId: "40000000-0000-4000-8000-000000000001",
    };
    expect(
      (await handle({ ...request, scopeKey: other.householdId }, other)).status,
    ).toBe(200);
    now = 60000;
    expect((await handle(request, actor)).status).toBe(200);
  });

  it("rejects the third concurrent request and releases on completion or failure", async () => {
    const { deps } = fixture();
    const pending: Array<{
      resolve: (deps: ConversationDeps) => void;
      reject: (error: Error) => void;
    }> = [];
    const buildCaptureDeps = vi.fn(
      () =>
        new Promise<ConversationDeps>((resolve, reject) =>
          pending.push({ resolve, reject }),
        ),
    );
    const handle = createCaptureDraftHandler({
      buildCaptureDeps,
      limiter: createCaptureRateLimiter(),
      log: vi.fn(),
    });
    const first = handle(request, actor);
    const second = handle(request, actor);
    expect((await handle(request, actor)).status).toBe(429);
    pending[0]!.resolve(deps);
    expect((await first).status).toBe(200);
    pending[1]!.reject(new Error("private"));
    expect((await second).status).toBe(503);
    const third = handle(request, actor);
    const fourth = handle(request, actor);
    expect((await handle(request, actor)).status).toBe(429);
    pending[2]!.resolve(deps);
    pending[3]!.resolve(deps);
    expect((await third).status).toBe(200);
    expect((await fourth).status).toBe(200);
  });

  it("supports configured limits and idempotent release", () => {
    const limiter = createCaptureRateLimiter({ perMinute: 3, concurrent: 1 });
    const release = limiter.acquire("house")!;
    expect(limiter.acquire("house")).toBeNull();
    release();
    release();
    const next = limiter.acquire("house")!;
    expect(limiter.acquire("house")).toBeNull();
    next();
  });
});
