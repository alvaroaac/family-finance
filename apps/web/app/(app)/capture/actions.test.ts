import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const HOUSEHOLD_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_USER_ID = "33333333-3333-4333-8333-333333333333";
const CATEGORY_ID = "44444444-4444-4444-8444-444444444444";
const ACCOUNT_ID = "55555555-5555-4555-8555-555555555555";
const CARD_ID = "66666666-6666-4666-8666-666666666666";
const TODAY = "2026-10-20";

const mocks = vi.hoisted(() => ({
  postToBot: vi.fn(),
  findHouseholdIdForCurrentUser: vi.fn(),
  getUser: vi.fn(),
  listAccounts: vi.fn(),
  listCreditCards: vi.fn(),
  listAllCategories: vi.fn(),
  listAllSubcategories: vi.fn(),
  listHouseholdMembers: vi.fn(),
}));

vi.mock("../../../lib/bot-client", () => ({ postToBot: mocks.postToBot }));
vi.mock("../../../lib/supabase", () => ({
  createServerSupabaseClient: async () => ({
    auth: { getUser: mocks.getUser },
  }),
}));
vi.mock("@family-finance/db", () => ({
  findHouseholdIdForCurrentUser: mocks.findHouseholdIdForCurrentUser,
  listAccounts: mocks.listAccounts,
  listCreditCards: mocks.listCreditCards,
  listAllCategories: mocks.listAllCategories,
  listAllSubcategories: mocks.listAllSubcategories,
  listHouseholdMembers: mocks.listHouseholdMembers,
}));
vi.mock("@family-finance/domain", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@family-finance/domain")>()),
  currentHouseholdDate: () => TODAY,
}));

const {
  suggestCaptureDraftAction,
  transcribeCaptureAudioAction,
  loadCaptureOptionsAction,
} = await import("./actions");
const { captureMessage } = await import("../../../lib/capture-copy");

const UNAVAILABLE = {
  ok: false,
  message: {
    text: "IA indisponível — preencha manualmente",
    tone: "muted",
  },
};
const TRANSCRIBE_FAILED = {
  ok: false,
  message: {
    text: "Não consegui transcrever — tente de novo ou digite",
    tone: "neg",
  },
};

const validDraft = {
  description: "mercado",
  amountCents: 8500,
  date: TODAY,
  kind: "expense",
  categoryId: CATEGORY_ID,
  accountId: ACCOUNT_ID,
  installmentCount: 1,
  candidates: [
    { categoryId: CATEGORY_ID, explanation: "Você já lançou assim antes" },
  ],
  explanation: "Você já lançou assim antes",
  needsReview: false,
};

function botReturns(status: number, json: unknown) {
  mocks.postToBot.mockResolvedValue({ ok: true, status, json });
}

beforeEach(() => {
  mocks.findHouseholdIdForCurrentUser.mockResolvedValue(HOUSEHOLD_ID);
  mocks.getUser.mockResolvedValue({ data: { user: { id: USER_ID } } });
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

describe("captureMessage", () => {
  it("carries the contractual copy and tone for every code", () => {
    expect(captureMessage("unavailable")).toEqual({
      text: "IA indisponível — preencha manualmente",
      tone: "muted",
    });
    expect(captureMessage("rate_limited")).toEqual({
      text: "Muitas tentativas — aguarde um minuto",
      tone: "warn",
    });
    expect(captureMessage("non_financial")).toEqual({
      text: "Não entendi como lançamento",
      tone: "warn",
    });
    expect(captureMessage("unsupported_intent")).toEqual({
      text: "Isso parece uma obrigação — use Obrigações",
      tone: "accent",
      href: "/obligations",
    });
    expect(captureMessage("transcribe_failed")).toEqual({
      text: "Não consegui transcrever — tente de novo ou digite",
      tone: "neg",
    });
    expect(captureMessage("mic_denied")).toEqual({
      text: "Permita o microfone nas configurações",
      tone: "warn",
    });
  });
});

describe("suggestCaptureDraftAction", () => {
  it("is unavailable without a bot call when the user has no active household", async () => {
    mocks.findHouseholdIdForCurrentUser.mockResolvedValue(null);

    await expect(suggestCaptureDraftAction("85 no mercado")).resolves.toEqual(
      UNAVAILABLE,
    );
    expect(mocks.postToBot).not.toHaveBeenCalled();
  });

  it("is unavailable without a bot call when there is no signed-in user", async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null } });

    await expect(suggestCaptureDraftAction("85 no mercado")).resolves.toEqual(
      UNAVAILABLE,
    );
    expect(mocks.postToBot).not.toHaveBeenCalled();
  });

  it.each([
    ["a non-string value", 42],
    ["an empty string", ""],
    ["whitespace only", "   \n\t "],
    ["more than 500 characters", "a".repeat(501)],
  ])("rejects %s as non-financial without a bot call", async (_name, text) => {
    await expect(suggestCaptureDraftAction(text as string)).resolves.toEqual({
      ok: false,
      message: captureMessage("non_financial"),
    });
    expect(mocks.postToBot).not.toHaveBeenCalled();
    expect(mocks.findHouseholdIdForCurrentUser).not.toHaveBeenCalled();
  });

  it("sends text of exactly 500 characters to the bot", async () => {
    botReturns(200, { ok: true, intent: "plain", draft: validDraft });

    await suggestCaptureDraftAction("a".repeat(500));

    expect(mocks.postToBot).toHaveBeenCalledTimes(1);
  });

  it("sends the trimmed text to the bot", async () => {
    botReturns(200, { ok: true, intent: "plain", draft: validDraft });

    await suggestCaptureDraftAction("  85 no mercado \n");

    expect(mocks.postToBot.mock.calls[0]?.[1].text).toBe("85 no mercado");
  });

  it("posts the household, actor, today and a fresh requestId to capture-draft", async () => {
    botReturns(200, { ok: true, intent: "plain", draft: validDraft });

    await suggestCaptureDraftAction("85 no mercado");
    await suggestCaptureDraftAction("85 no mercado");

    const [first, second] = mocks.postToBot.mock.calls;
    expect(first?.[0]).toBe("/internal/v1/capture-draft");
    expect(first?.[1]).toEqual({
      version: 1,
      requestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      scopeKey: HOUSEHOLD_ID,
      actorUserId: USER_ID,
      today: TODAY,
      text: "85 no mercado",
    });
    expect(second?.[1].requestId).not.toBe(first?.[1].requestId);
  });

  it.each(["plain", "card_installment"] as const)(
    "returns the %s intent with the validated draft",
    async (intent) => {
      botReturns(200, { ok: true, intent, draft: validDraft });

      await expect(suggestCaptureDraftAction("85 no mercado")).resolves.toEqual(
        { ok: true, intent, draft: validDraft },
      );
    },
  );

  it.each([
    ["rate_limited", 429, "rate_limited"],
    ["non_financial", 422, "non_financial"],
    ["unsupported_intent", 422, "unsupported_intent"],
    ["unavailable", 503, "unavailable"],
    ["invalid_request", 400, "unavailable"],
  ] as const)(
    "maps the bot error %s (%i) to the %s copy",
    async (error, status, copy) => {
      botReturns(status, { ok: false, error });

      await expect(suggestCaptureDraftAction("x")).resolves.toEqual({
        ok: false,
        message: captureMessage(copy),
      });
    },
  );

  it.each(["not_configured", "unreachable", "timeout"] as const)(
    "is unavailable when the bot is %s",
    async (reason) => {
      mocks.postToBot.mockResolvedValue({ ok: false, reason });

      await expect(suggestCaptureDraftAction("x")).resolves.toEqual(
        UNAVAILABLE,
      );
    },
  );

  it.each([
    [
      "a 5xx with a known error code",
      500,
      { ok: false, error: "rate_limited" },
    ],
    ["a 5xx with an unknown body", 502, "<html>bad gateway</html>"],
    ["a null body", 200, null],
    ["an unknown error code", 422, { ok: false, error: "teapot" }],
    ["an unknown intent", 200, { ok: true, intent: "bill", draft: validDraft }],
  ])("is unavailable for %s", async (_name, status, json) => {
    botReturns(status, json);

    await expect(suggestCaptureDraftAction("x")).resolves.toEqual(UNAVAILABLE);
  });

  it.each([
    ["a non-positive amount", { amountCents: 0 }],
    ["a malformed date", { date: "20/10/2026" }],
    ["an unknown kind", { kind: "transfer" }],
    ["a non-uuid category id", { categoryId: "not-a-uuid" }],
    ["a fractional installment count", { installmentCount: 1.5 }],
    [
      "more than three candidates",
      { candidates: Array(4).fill(validDraft.candidates[0]) },
    ],
    ["a missing description", { description: undefined }],
  ])("re-validates the draft: %s is unavailable", async (_name, patch) => {
    botReturns(200, {
      ok: true,
      intent: "plain",
      draft: { ...validDraft, ...patch },
    });

    await expect(suggestCaptureDraftAction("x")).resolves.toEqual(UNAVAILABLE);
  });

  it("logs raw bot errors server-side and never returns them", async () => {
    botReturns(500, { ok: false, error: "relation secret_table missing" });

    const result = await suggestCaptureDraftAction("x");

    expect(JSON.stringify(result)).not.toContain("secret_table");
    expect(console.error).toHaveBeenCalled();
  });
});

describe("transcribeCaptureAudioAction", () => {
  function audioForm(
    mimeType: string | null,
    bytes: number | Uint8Array<ArrayBuffer> = 3,
    type = "audio/webm",
  ): FormData {
    const data = typeof bytes === "number" ? new Uint8Array(bytes) : bytes;
    const form = new FormData();
    form.set("audio", new Blob([data], { type }), "voice.webm");
    if (mimeType !== null) form.set("mimeType", mimeType);
    return form;
  }

  it("is unavailable without a bot call when the user has no active household", async () => {
    mocks.findHouseholdIdForCurrentUser.mockResolvedValue(null);

    await expect(
      transcribeCaptureAudioAction(audioForm("audio/webm")),
    ).resolves.toEqual(UNAVAILABLE);
    expect(mocks.postToBot).not.toHaveBeenCalled();
  });

  it("posts the base64 audio to capture-transcribe and returns the text", async () => {
    botReturns(200, { ok: true, text: "85 no mercado" });

    const result = await transcribeCaptureAudioAction(
      audioForm("audio/webm", new Uint8Array([1, 2, 3])),
    );

    expect(result).toEqual({ ok: true, text: "85 no mercado" });
    const [path, body] = mocks.postToBot.mock.calls[0] ?? [];
    expect(path).toBe("/internal/v1/capture-transcribe");
    expect(body).toEqual({
      version: 1,
      requestId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      scopeKey: HOUSEHOLD_ID,
      actorUserId: USER_ID,
      mimeType: "audio/webm",
      audioBase64: "AQID",
    });
  });

  it.each([
    ["audio/webm;codecs=opus", "audio/webm"],
    ["audio/mp4; codecs=mp4a.40.2", "audio/mp4"],
    ["Audio/MPEG", "audio/mpeg"],
    ["audio/ogg;codecs=opus", "audio/ogg"],
  ])("sends %s to the bot as %s", async (mimeType, expected) => {
    botReturns(200, { ok: true, text: "oi" });

    await transcribeCaptureAudioAction(audioForm(mimeType));

    expect(mocks.postToBot.mock.calls[0]?.[1].mimeType).toBe(expected);
  });

  it("accepts audio of exactly 1 MB", async () => {
    botReturns(200, { ok: true, text: "oi" });

    await expect(
      transcribeCaptureAudioAction(audioForm("audio/webm", 1_048_576)),
    ).resolves.toEqual({ ok: true, text: "oi" });
  });

  it.each([
    ["audio over 1 MB", audioForm("audio/webm", 1_048_577)],
    ["a mime type outside the allowed four", audioForm("audio/wav")],
    ["a non-audio mime type", audioForm("video/webm")],
    ["a missing mime type", audioForm(null)],
    [
      "a missing audio file",
      (() => {
        const form = new FormData();
        form.set("mimeType", "audio/webm");
        return form;
      })(),
    ],
    [
      "audio sent as a plain string",
      (() => {
        const form = new FormData();
        form.set("audio", "not a blob");
        form.set("mimeType", "audio/webm");
        return form;
      })(),
    ],
  ])("rejects %s without a bot call", async (_name, form) => {
    await expect(transcribeCaptureAudioAction(form)).resolves.toEqual(
      TRANSCRIBE_FAILED,
    );
    expect(mocks.postToBot).not.toHaveBeenCalled();
  });

  it.each([
    ["invalid_request", 400, TRANSCRIBE_FAILED.message],
    ["non_financial", 422, TRANSCRIBE_FAILED.message],
    ["rate_limited", 429, captureMessage("rate_limited")],
    ["unavailable", 503, captureMessage("unavailable")],
  ])(
    "maps the bot error %s (%i) to its copy",
    async (error, status, message) => {
      botReturns(status, { ok: false, error });

      await expect(
        transcribeCaptureAudioAction(audioForm("audio/webm")),
      ).resolves.toEqual({ ok: false, message });
    },
  );

  it.each([
    ["an unreachable bot", { ok: false, reason: "unreachable" }],
    ["a 5xx with an unknown body", { ok: true, status: 502, json: "bad" }],
    ["a malformed success body", { ok: true, status: 200, json: { ok: true } }],
  ])("is unavailable for %s", async (_name, response) => {
    mocks.postToBot.mockResolvedValue(response);

    await expect(
      transcribeCaptureAudioAction(audioForm("audio/webm")),
    ).resolves.toEqual(UNAVAILABLE);
  });

  it("logs raw bot errors server-side and never returns them", async () => {
    botReturns(500, { ok: false, error: "whisper key sk-secret rejected" });

    const result = await transcribeCaptureAudioAction(audioForm("audio/webm"));

    expect(JSON.stringify(result)).not.toContain("sk-secret");
    expect(console.error).toHaveBeenCalled();
  });
});

describe("loadCaptureOptionsAction", () => {
  beforeEach(() => {
    mocks.listAccounts.mockResolvedValue([
      { id: ACCOUNT_ID, name: "Nubank", kind: "checking" },
    ]);
    mocks.listCreditCards.mockResolvedValue([{ id: CARD_ID, name: "Visa" }]);
    mocks.listAllCategories.mockResolvedValue([
      { id: CATEGORY_ID, name: "Mercado", kind: "expense", extra: 1 },
    ]);
    mocks.listAllSubcategories.mockResolvedValue([
      { id: "sub-1", category_id: CATEGORY_ID, name: "Feira" },
    ]);
    mocks.listHouseholdMembers.mockResolvedValue([
      { userId: OTHER_USER_ID, displayName: "Outra pessoa" },
      { userId: USER_ID, displayName: null },
    ]);
  });

  it("returns the same form options /transactions builds, plus today", async () => {
    await expect(loadCaptureOptionsAction()).resolves.toEqual({
      options: {
        accounts: [{ id: ACCOUNT_ID, name: "Nubank" }],
        cards: [{ id: CARD_ID, name: "Visa" }],
        categories: [{ id: CATEGORY_ID, name: "Mercado", kind: "expense" }],
        subcategories: [
          { id: "sub-1", categoryId: CATEGORY_ID, name: "Feira" },
        ],
        responsibles: [
          { value: "household", label: "Casa" },
          { value: OTHER_USER_ID, label: "Outra pessoa" },
          { value: USER_ID, label: "Membro" },
        ],
      },
      today: TODAY,
      defaultResponsible: "household",
    });
    expect(mocks.listAccounts).toHaveBeenCalledWith(
      expect.anything(),
      HOUSEHOLD_ID,
    );
  });

  it("throws when the user has no active household", async () => {
    mocks.findHouseholdIdForCurrentUser.mockResolvedValue(null);

    await expect(loadCaptureOptionsAction()).rejects.toThrow(
      "Nenhuma casa ativa para o usuário atual.",
    );
  });
});
