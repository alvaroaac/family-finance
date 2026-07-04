/**
 * Confirmation state machine for Telegram expense entry.
 *
 * Confirmation is ON by default (spec: "pede confirmação"): a text message is
 * parsed into an in-progress draft, the bot replies with an editable summary,
 * and the transaction is ONLY persisted after an explicit confirm. Corrections
 * for value, date, category, and responsible person update the draft in place.
 *
 * Domain rules live in @family-finance/domain and persistence in
 * @family-finance/db — this module wires them through injected dependencies
 * (`ConversationDeps`) so the bot NEVER re-implements transaction/categorization
 * logic and so unit tests can mock the database, categorization, and Telegram
 * without any network. On confirm it builds the draft via `createTransactionDraft`
 * (default responsibility = the house), persists it, records `createdByUserId`
 * from the linked Telegram identity, and logs the interaction for auditing.
 */

import {
  createObligationDraft,
  createTransactionDraft,
  obligationEndMonth,
} from "@family-finance/domain";
import type {
  ObligationDraft,
  TransactionDraft,
  TransactionKind,
} from "@family-finance/domain";
import type {
  CategorizationContext,
  CategorizationResult,
  CategoryCatalog,
} from "@family-finance/categorization";

import { parseExpenseText } from "./parser.js";
import type {
  InterpretedExpense,
  InterpretedIntent,
  MessageClassifier,
  TextInterpreter,
} from "./interpret.js";
import {
  transcribeVoiceMessage,
  type TranscribeDeps,
  type VoiceMessageRef,
} from "./audio.js";
import {
  cancelledMessage,
  cardBillDeferredMessage,
  cardInstallmentDeferredMessage,
  confirmationMessage,
  correctionAppliedMessage,
  formatBrl,
  needsAmountMessage,
  notUnderstoodMessage,
  obligationAlreadyPaidMessage,
  obligationAmbiguousMessage,
  obligationConfirmationMessage,
  obligationNotFoundMessage,
  obligationNotUnderstoodMessage,
  obligationPaidMessage,
  obligationSavedMessage,
  obligationSettleFailedMessage,
  obligationUnavailableMessage,
  savedMessage,
  type ObligationSummaryView,
  type SummaryView,
} from "./replies.js";

// ---------------------------------------------------------------------------
// State.
// ---------------------------------------------------------------------------

export type ConversationStatus =
  | "awaiting_confirmation"
  | "needs_amount"
  | "saved"
  | "cancelled"
  /** An obligation template draft awaits its "confirmar" (PR-1). */
  | "awaiting_obligation_confirmation"
  /** A mark-paid keyword matched 2+ obligations; the user must pick one. */
  | "awaiting_mark_paid_choice";

/** The editable, in-progress draft built up across the conversation. */
export type DraftInProgress = {
  amountCents?: number;
  description: string;
  occurredOn: string;
  kind: TransactionKind;
  categoryId?: string;
  subcategoryId?: string;
  categoryExplanation?: string;
  /** Set only when an explicit responsible person was chosen (not the house). */
  responsibleUserId?: string;
  cardId?: string;
  accountId?: string;
  /** The linked Telegram identity that launched the entry (lançado por). */
  createdByUserId: string;
  /** Whether this entry originated from a typed message or a voice note. */
  inputKind: BotInputKind;
  /** True when something needs the user's attention (low confidence/missing). */
  needsAttention: boolean;
};

/** The editable, in-progress OBLIGATION template built by the bot flow. */
export type ObligationDraftInProgress = {
  description: string;
  /** Monthly amount in cents; undefined until "valor X" fills it. */
  monthlyAmountCents?: number;
  termMonths: number | null;
  /** `YYYY-MM`, resolved (default: the message's current month). */
  startMonth: string;
  /** 1–28, resolved (default 1 when the message names no day). */
  dueDay: number;
  /** Payment source; defaults to the household checking account. */
  accountId: string;
  categoryId?: string;
  subcategoryId?: string;
  categoryExplanation?: string;
  responsibleUserId?: string;
  createdByUserId: string;
};

/** One obligation candidate stored while a mark-paid keyword is ambiguous. */
export type MarkPaidCandidate = {
  id: string;
  description: string;
  amountCents: number;
};

export type ConversationState = {
  status: ConversationStatus;
  draft: DraftInProgress;
  /** Set while status = awaiting_obligation_confirmation. */
  obligationDraft?: ObligationDraftInProgress;
  /** Set while status = awaiting_mark_paid_choice. */
  markPaidCandidates?: MarkPaidCandidate[];
};

export type ConversationOutcome = {
  state: ConversationState;
  /** The pt-BR reply to send back to the user. */
  reply: string;
  /** Set after a successful save, for auditing/follow-up. */
  transactionId?: string;
};

// ---------------------------------------------------------------------------
// Dependencies (injected so the bot reuses shared services and tests mock I/O).
// ---------------------------------------------------------------------------

/** Whether an entry came from a typed message or a transcribed voice note. */
export type BotInputKind = "text" | "audio";

/** What we persist when logging a bot interaction for auditing. */
export type BotInteractionLog = {
  fromUserId: string;
  inputKind: BotInputKind;
  messageText: string;
  confidence?: number;
  explanation?: string;
  transactionId?: string;
};

export type ConversationDeps = {
  householdId: string;
  catalog: CategoryCatalog;
  /** Account used when the user did not specify card/account. */
  defaultAccountId: string;
  /** Resolve a card id from a card hint (e.g. the household's single card). */
  resolveCardId: () => string | undefined;
  /** Resolve an account id from an account hint. */
  resolveAccountId: () => string | undefined;
  /** Map a free-text name to a responsible user id (or undefined = the house). */
  resolveResponsibleUserId: (name: string) => string | undefined;
  /** Categorization engine call (wired to @family-finance/categorization). */
  suggestCategory: (
    context: CategorizationContext,
  ) => Promise<CategorizationResult>;
  /**
   * Persist a validated draft (wired to @family-finance/db createTransaction).
   * Returns at least the new id.
   */
  createTransaction: (draft: TransactionDraft) => Promise<{ id: string }>;
  /** Record the interaction for auditing (wired to bot_interactions). */
  logInteraction: (entry: BotInteractionLog) => Promise<void>;
  /**
   * OPTIONAL LLM fallback (spec §3.4): consulted in `startConversation` ONLY
   * when the deterministic parser finds no amount. Corrections stay
   * deterministic. The result still lands behind the confirmation step.
   */
  interpretText?: TextInterpreter;
  /**
   * OPTIONAL unified intent classifier (recurring-obligations design). When
   * configured, every NEW conversation message is classified first; a null
   * result (or plain intent) falls back to the deterministic parser path.
   */
  classifyMessage?: MessageClassifier;
  /** Active obligations for mark-paid keyword matching. */
  listActiveObligations?: () => Promise<
    Array<{ id: string; description: string; amountCents: number }>
  >;
  /** Persist a validated obligation template (db createObligation). */
  createObligation?: (draft: ObligationDraft) => Promise<{ id: string }>;
  /**
   * Materialize one obligation month (db materializeObligationPayment).
   * `paidOn` is the message send date; idempotent per (obligation, month).
   */
  materializeObligationPayment?: (args: {
    obligationId: string;
    month: string;
    paidOn: string;
  }) => Promise<{ alreadyPaid: boolean }>;
  /** Map a spoken account name ("conta Nubank") to an account id. */
  resolveAccountIdByName?: (name: string) => string | undefined;
  /** Display name of an account id, for the confirmation summary. */
  accountNameById?: (accountId: string) => string | undefined;
};

export type StartInput = {
  text: string;
  /** The linked Telegram identity (createdByUserId / lançado por). */
  fromUserId: string;
  /** Origin of the message; defaults to "text". Audio passes "audio". */
  inputKind?: BotInputKind;
};

export type StartOptions = {
  /** ISO date (YYYY-MM-DD) used for date hint resolution. */
  today: string;
};

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

function categoryLabel(
  catalog: CategoryCatalog,
  categoryId: string | undefined,
  subcategoryId: string | undefined,
): string {
  if (categoryId === undefined) {
    return "Sem categoria (a definir)";
  }
  const category = catalog.categories.find((c) => c.id === categoryId);
  const macro = category?.name ?? "Categoria";
  if (subcategoryId !== undefined) {
    const sub = catalog.subcategories.find((s) => s.id === subcategoryId);
    if (sub !== undefined) {
      return `${macro} > ${sub.name}`;
    }
  }
  return macro;
}

function paymentLabel(draft: DraftInProgress): string {
  if (draft.cardId !== undefined) {
    return "Cartão de crédito";
  }
  return "Conta";
}

function responsibleLabel(draft: DraftInProgress): string {
  return draft.responsibleUserId !== undefined ? "Pessoa específica" : "Casa";
}

function summaryView(
  draft: DraftInProgress,
  catalog: CategoryCatalog,
): SummaryView {
  return {
    amountCents: draft.amountCents,
    description: draft.description,
    occurredOn: draft.occurredOn,
    categoryLabel: categoryLabel(catalog, draft.categoryId, draft.subcategoryId),
    paymentLabel: paymentLabel(draft),
    responsibleLabel: responsibleLabel(draft),
    categoryExplanation: draft.categoryExplanation,
    needsAttention: draft.needsAttention,
  };
}

function statusForDraft(draft: DraftInProgress): ConversationStatus {
  return draft.amountCents === undefined
    ? "needs_amount"
    : "awaiting_confirmation";
}

function replyForDraft(
  draft: DraftInProgress,
  catalog: CategoryCatalog,
): string {
  if (draft.amountCents === undefined) {
    return needsAmountMessage(draft.description);
  }
  return confirmationMessage(summaryView(draft, catalog));
}

// ---------------------------------------------------------------------------
// Start: classify + parse + categorize + ask for confirmation (never persists).
// ---------------------------------------------------------------------------

/** Case- and accent-insensitive normalization for keyword matching. */
function normalizeText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .trim()
    .toLowerCase();
}

/** Meaningful tokens of a keyword/description (normalized, short words out). */
function matchTokens(value: string): string[] {
  return normalizeText(value)
    .split(/\s+/)
    .filter((token) => token.length >= 3);
}

/**
 * Keyword ↔ description match on TOKEN overlap, not whole-string containment:
 * the classifier extracts the keyword verbatim from the message ("placa
 * solar"), while the stored description may differ ("Parcela solar") — a
 * shared token like "solar" is what actually links them.
 */
function obligationKeywordMatch(keyword: string, description: string): boolean {
  const keywordTokens = matchTokens(keyword);
  const descriptionTokens = matchTokens(description);
  if (keywordTokens.length === 0 || descriptionTokens.length === 0) {
    return false;
  }
  return keywordTokens.some((token) => descriptionTokens.includes(token));
}

/** Minimal expense draft used as state ballast by non-expense flows. */
function placeholderDraft(
  input: StartInput,
  inputKind: BotInputKind,
  today: string,
): DraftInProgress {
  return {
    description: input.text,
    occurredOn: today,
    kind: "expense",
    createdByUserId: input.fromUserId,
    inputKind,
    needsAttention: false,
  };
}

function obligationSummaryView(
  draft: ObligationDraftInProgress,
  deps: ConversationDeps,
): ObligationSummaryView {
  return {
    description: draft.description,
    monthlyAmountCents: draft.monthlyAmountCents,
    termMonths: draft.termMonths,
    startMonth: draft.startMonth,
    endMonth: obligationEndMonth(draft.startMonth, draft.termMonths),
    dueDay: draft.dueDay,
    accountLabel: deps.accountNameById?.(draft.accountId) ?? "Conta",
    categoryLabel: categoryLabel(
      deps.catalog,
      draft.categoryId,
      draft.subcategoryId,
    ),
    categoryExplanation: draft.categoryExplanation,
  };
}

/**
 * Settle ONE matched obligation for the message's current month, with the
 * message send date as `paidOn`. Idempotent: an already-paid month is a
 * friendly no-op. Terminal either way.
 */
async function settleObligation(
  candidate: MarkPaidCandidate,
  ballast: DraftInProgress,
  messageText: string,
  deps: ConversationDeps,
  today: string,
): Promise<ConversationOutcome> {
  if (deps.materializeObligationPayment === undefined) {
    // The obligation WAS found — the settle capability just is not wired.
    return {
      state: { status: "cancelled", draft: ballast },
      reply: obligationUnavailableMessage(),
    };
  }
  const month = today.slice(0, 7);
  let alreadyPaid: boolean;
  try {
    ({ alreadyPaid } = await deps.materializeObligationPayment({
      obligationId: candidate.id,
      month,
      paidOn: today,
    }));
  } catch (error) {
    // The RPC rejects months outside [start_month, term end] and non-active
    // templates (a future-start obligation is still listed as active). A
    // silent webhook crash would mean NO reply — degrade to a friendly
    // explanation instead.
    console.warn(
      `[bot] materializeObligationPayment failed for ${candidate.id}/${month}:`,
      error,
    );
    return {
      state: { status: "cancelled", draft: ballast },
      reply: obligationSettleFailedMessage(candidate.description),
    };
  }
  await deps.logInteraction({
    fromUserId: ballast.createdByUserId,
    inputKind: ballast.inputKind,
    messageText,
  });
  return {
    state: { status: "saved", draft: ballast },
    reply: alreadyPaid
      ? obligationAlreadyPaidMessage({
          description: candidate.description,
          month,
        })
      : obligationPaidMessage({
          description: candidate.description,
          amountCents: candidate.amountCents,
          month,
        }),
  };
}

/** Route a classified non-plain intent to its flow. */
async function startClassifiedIntent(
  classified: Exclude<InterpretedIntent, { intent: "plain" }>,
  input: StartInput,
  deps: ConversationDeps,
  options: StartOptions,
  inputKind: BotInputKind,
): Promise<ConversationOutcome> {
  const ballast = placeholderDraft(input, inputKind, options.today);

  // PR-2 deferred card paths: recognized, answered "em breve", terminal.
  if (classified.intent === "card_installment") {
    return {
      state: { status: "cancelled", draft: ballast },
      reply: cardInstallmentDeferredMessage(),
    };
  }
  if (classified.intent === "mark_paid" && classified.target === "card") {
    return {
      state: { status: "cancelled", draft: ballast },
      reply: cardBillDeferredMessage(),
    };
  }

  if (classified.intent === "mark_paid") {
    const obligations =
      deps.listActiveObligations !== undefined
        ? await deps.listActiveObligations()
        : [];
    const matches = obligations.filter((o) =>
      obligationKeywordMatch(classified.keyword, o.description),
    );

    if (matches.length === 0) {
      return {
        state: { status: "cancelled", draft: ballast },
        reply: obligationNotFoundMessage(classified.keyword),
      };
    }
    if (matches.length === 1) {
      return settleObligation(
        matches[0] as MarkPaidCandidate,
        ballast,
        input.text,
        deps,
        options.today,
      );
    }
    return {
      state: {
        status: "awaiting_mark_paid_choice",
        draft: ballast,
        markPaidCandidates: matches,
      },
      reply: obligationAmbiguousMessage(matches.map((m) => m.description)),
    };
  }

  // Obligation create: build the template draft, then ask for confirmation.
  const extracted = classified.obligation;
  const obligationDraft: ObligationDraftInProgress = {
    description: extracted.description,
    monthlyAmountCents: extracted.monthlyAmountCents,
    termMonths: extracted.termMonths ?? null,
    startMonth: extracted.startMonth ?? options.today.slice(0, 7),
    dueDay:
      extracted.dueDay !== undefined
        ? Math.min(28, Math.max(1, extracted.dueDay))
        : 1,
    accountId: deps.defaultAccountId,
    createdByUserId: input.fromUserId,
  };
  if (extracted.responsibleHint !== undefined) {
    obligationDraft.responsibleUserId = deps.resolveResponsibleUserId(
      extracted.responsibleHint,
    );
  }

  // Same shared categorization engine as expenses; the hint is free TEXT.
  const result = await deps.suggestCategory({
    householdId: deps.householdId,
    description:
      extracted.categoryHint !== undefined
        ? `${extracted.description} (${extracted.categoryHint})`
        : extracted.description,
    amountCents: obligationDraft.monthlyAmountCents,
    occurredOn: options.today,
  });
  if (result.suggestion?.macroCategoryId !== undefined) {
    obligationDraft.categoryId = result.suggestion.macroCategoryId;
    obligationDraft.subcategoryId = result.suggestion.subcategoryId;
    obligationDraft.categoryExplanation = result.suggestion.explanation;
  }

  return {
    state: {
      status: "awaiting_obligation_confirmation",
      draft: ballast,
      obligationDraft,
    },
    reply: obligationConfirmationMessage(
      obligationSummaryView(obligationDraft, deps),
    ),
  };
}

export async function startConversation(
  input: StartInput,
  deps: ConversationDeps,
  options: StartOptions,
): Promise<ConversationOutcome> {
  const inputKind: BotInputKind = input.inputKind ?? "text";

  // Unified intent classification (recurring-obligations design): when
  // configured it sees every NEW message first. A null result — or a plain
  // expense — falls through to the deterministic parser path below, so the
  // legacy behavior is untouched when the classifier is absent or fails.
  let classifiedExpense: InterpretedExpense | null = null;
  if (deps.classifyMessage !== undefined) {
    const classified = await deps
      .classifyMessage(input.text, { today: options.today })
      .catch(() => null);
    if (classified !== null && classified.intent !== "plain") {
      return startClassifiedIntent(classified, input, deps, options, inputKind);
    }
    if (classified !== null) {
      classifiedExpense = classified.expense;
    }
  }

  const parsed = parseExpenseText(input.text, { today: options.today });

  // LLM fallback (spec §3.4): ONLY when the deterministic parser found no
  // amount and an interpreter is configured. The classifier's plain-expense
  // fields take that slot when present (one LLM call, not two). Any failure
  // (null/throw) keeps today's "rephrase" behavior unchanged. The result
  // feeds the SAME draft + confirmation path — never a direct save.
  let interpreted: InterpretedExpense | null = classifiedExpense;
  if (
    interpreted === null &&
    parsed.amountCents === undefined &&
    deps.interpretText !== undefined
  ) {
    interpreted = await deps
      .interpretText(input.text, { today: options.today })
      .catch(() => null);
  }
  const description =
    interpreted !== null ? interpreted.description : parsed.description;
  const draft: DraftInProgress = {
    amountCents: interpreted?.amountCents ?? parsed.amountCents,
    description,
    occurredOn:
      interpreted?.occurredOn ?? parsed.occurredOn ?? options.today,
    kind: "expense",
    createdByUserId: input.fromUserId,
    inputKind,
    needsAttention:
      // Audio always merits a closer look (transcription can be imperfect),
      // and so does anything the LLM interpreted instead of the parser.
      inputKind === "audio" ||
      interpreted !== null ||
      parsed.uncertainFields.includes("amount") ||
      parsed.uncertainFields.includes("date"),
  };

  // A responsible-person hint is a free-text NAME: it goes through the same
  // resolver corrections use (no match/ambiguous -> stays with the house).
  if (interpreted?.responsibleHint !== undefined) {
    draft.responsibleUserId = deps.resolveResponsibleUserId(
      interpreted.responsibleHint,
    );
  }

  // Resolve payment instrument from hints (default account otherwise).
  if (parsed.cardHint) {
    draft.cardId = deps.resolveCardId() ?? undefined;
  }
  if (draft.cardId === undefined) {
    draft.accountId =
      (parsed.accountHint ? deps.resolveAccountId() : undefined) ??
      deps.defaultAccountId;
  }

  // Ask the categorization engine for a suggestion (shared engine, both
  // channels). A category hint from the interpreter is free TEXT appended to
  // the context description — never trusted as a category id.
  const result = await deps.suggestCategory({
    householdId: deps.householdId,
    description:
      interpreted?.categoryHint !== undefined
        ? `${description} (${interpreted.categoryHint})`
        : description,
    amountCents: draft.amountCents,
    occurredOn: draft.occurredOn,
  });
  if (result.suggestion?.macroCategoryId !== undefined) {
    draft.categoryId = result.suggestion.macroCategoryId;
    draft.subcategoryId = result.suggestion.subcategoryId;
    draft.categoryExplanation = result.suggestion.explanation;
  }
  if (result.requiresConfirmation) {
    draft.needsAttention = true;
  }

  const state: ConversationState = {
    status: statusForDraft(draft),
    draft,
  };
  return { state, reply: replyForDraft(draft, deps.catalog) };
}

// ---------------------------------------------------------------------------
// Audio entry: transcribe -> SAME confirmation flow (never a separate write path).
// ---------------------------------------------------------------------------

export type StartFromAudioInput = {
  /** The Telegram voice/audio attachment to transcribe. */
  voice: VoiceMessageRef;
  /** The linked Telegram identity (createdByUserId / lançado por). */
  fromUserId: string;
};

/**
 * Handle a voice note: download + transcribe it (raw audio is deleted in
 * `transcribeVoiceMessage`'s `finally`), then run the transcription through the
 * EXACT same `startConversation` flow as a typed message. Audio therefore always
 * produces an editable confirmation summary and NEVER bypasses confirmation.
 *
 * Transcription dependencies are injected (downloader + provider), so the bot
 * reuses one transcription provider and unit tests mock it with no network.
 */
export async function startConversationFromAudio(
  input: StartFromAudioInput,
  deps: ConversationDeps,
  transcribeDeps: TranscribeDeps,
  options: StartOptions,
): Promise<ConversationOutcome> {
  const text = await transcribeVoiceMessage(input.voice, transcribeDeps);
  return startConversation(
    { text, fromUserId: input.fromUserId, inputKind: "audio" },
    deps,
    options,
  );
}

// ---------------------------------------------------------------------------
// Apply a follow-up message: confirm, cancel, or a correction.
// ---------------------------------------------------------------------------

const CONFIRM_RE = /^\s*(confirmar|confirma|confirmo|sim|ok|salvar|salva)\b/i;
const CANCEL_RE = /^\s*(cancelar|cancela|nao|não|descartar|apagar)\b/i;

type Correction =
  | { field: "amount"; cents: number }
  | { field: "date"; iso: string }
  | { field: "category"; categoryId: string; subcategoryId?: string }
  | { field: "responsible"; userId: string | undefined; raw: string }
  | { field: "unknown" };

function parseCorrection(
  message: string,
  deps: ConversationDeps,
  today: string,
): Correction {
  const text = message.trim();

  // valor / preço — reuse the parser's amount extraction.
  const valueMatch = /^(valor|preço|preco)\b\s*(.+)$/i.exec(text);
  if (valueMatch !== null) {
    const parsed = parseExpenseText(valueMatch[2] as string, { today });
    if (parsed.amountCents !== undefined) {
      return { field: "amount", cents: parsed.amountCents };
    }
    return { field: "unknown" };
  }

  // data — reuse the parser's date extraction.
  const dateMatch = /^(data|dia)\b\s*(.+)$/i.exec(text);
  if (dateMatch !== null) {
    const parsed = parseExpenseText(dateMatch[2] as string, { today });
    if (parsed.occurredOn !== undefined && !parsed.uncertainFields.includes("date")) {
      return { field: "date", iso: parsed.occurredOn };
    }
    return { field: "unknown" };
  }

  // categoria — match the named category against the catalog.
  const catMatch = /^(categoria|cat)\b\s*(.+)$/i.exec(text);
  if (catMatch !== null) {
    const name = (catMatch[2] as string).trim().toLowerCase();
    const category = deps.catalog.categories.find(
      (c) => c.name.trim().toLowerCase() === name,
    );
    if (category !== undefined) {
      return { field: "category", categoryId: category.id };
    }
    return { field: "unknown" };
  }

  // responsável — map a name to a user id (undefined keeps it as the house).
  const respMatch = /^(responsável|responsavel|resp)\b\s*(.+)$/i.exec(text);
  if (respMatch !== null) {
    const raw = (respMatch[2] as string).trim();
    return {
      field: "responsible",
      userId: deps.resolveResponsibleUserId(raw),
      raw,
    };
  }

  return { field: "unknown" };
}

/** Map an in-progress draft to a domain transaction draft and persist it. */
async function persist(
  state: ConversationState,
  deps: ConversationDeps,
  messageText: string,
): Promise<ConversationOutcome> {
  const draft = state.draft;

  // Cannot save without a value — fall back to asking for it.
  if (draft.amountCents === undefined) {
    const next: ConversationState = { status: "needs_amount", draft };
    return { state: next, reply: needsAmountMessage(draft.description) };
  }

  const payment =
    draft.cardId !== undefined
      ? ({ type: "card", creditCardId: draft.cardId } as const)
      : ({
          type: "account",
          accountId: draft.accountId ?? deps.defaultAccountId,
        } as const);

  const built = createTransactionDraft({
    householdId: deps.householdId,
    kind: draft.kind,
    amount: { currency: "BRL", cents: draft.amountCents },
    occurredOn: draft.occurredOn,
    description: draft.description || "Lançamento via Telegram",
    createdByUserId: draft.createdByUserId,
    payment,
    responsibleUserId: draft.responsibleUserId,
    category:
      draft.categoryId !== undefined
        ? {
            categoryId: draft.categoryId,
            subcategoryId: draft.subcategoryId,
          }
        : undefined,
  });

  if (!built.ok) {
    // Surface the first validation error; keep the conversation open.
    const first = built.errors[0];
    const next: ConversationState = {
      status: statusForDraft(draft),
      draft,
    };
    return {
      state: next,
      reply: `Não consegui salvar: ${first?.message ?? "dados inválidos"}.`,
    };
  }

  const persisted = await deps.createTransaction(built.value);

  await deps.logInteraction({
    fromUserId: draft.createdByUserId,
    inputKind: draft.inputKind,
    messageText,
    explanation: draft.categoryExplanation,
    transactionId: persisted.id,
  });

  const next: ConversationState = {
    status: "saved",
    draft,
  };
  return {
    state: next,
    transactionId: persisted.id,
    reply: savedMessage({
      amountCents: draft.amountCents,
      description: draft.description || "Lançamento via Telegram",
      occurredOn: draft.occurredOn,
      categoryLabel: categoryLabel(
        deps.catalog,
        draft.categoryId,
        draft.subcategoryId,
      ),
    }),
  };
}

/**
 * Resolve an ambiguous mark-paid: match the reply against the stored
 * candidates; exactly one match settles that obligation, otherwise re-ask.
 */
async function applyMarkPaidChoice(
  state: ConversationState,
  message: string,
  deps: ConversationDeps,
  today: string,
): Promise<ConversationOutcome> {
  if (CANCEL_RE.test(message)) {
    return {
      state: { status: "cancelled", draft: state.draft },
      reply: cancelledMessage(),
    };
  }
  const candidates = state.markPaidCandidates ?? [];
  const matches = candidates.filter((c) =>
    obligationKeywordMatch(message, c.description),
  );
  if (matches.length !== 1) {
    return {
      state,
      reply: obligationAmbiguousMessage(candidates.map((c) => c.description)),
    };
  }
  return settleObligation(
    matches[0] as MarkPaidCandidate,
    state.draft,
    message,
    deps,
    today,
  );
}

/**
 * Advance an obligation confirmation: confirm persists the template (via the
 * pure domain validation), cancel discards, and valor/dia/conta corrections
 * update the draft in place. Anything else gets the obligation help text.
 */
async function applyObligationMessage(
  state: ConversationState,
  message: string,
  deps: ConversationDeps,
  today: string,
): Promise<ConversationOutcome> {
  const draft = state.obligationDraft;
  if (draft === undefined) {
    return {
      state: { status: "cancelled", draft: state.draft },
      reply: notUnderstoodMessage(),
    };
  }

  if (CANCEL_RE.test(message)) {
    return {
      state: { status: "cancelled", draft: state.draft },
      reply: cancelledMessage(),
    };
  }

  if (CONFIRM_RE.test(message)) {
    if (draft.monthlyAmountCents === undefined) {
      return {
        state,
        reply: [
          "Ainda falta o valor mensal.",
          'Informe com, por exemplo: "valor 710,44".',
        ].join("\n"),
      };
    }
    if (deps.createObligation === undefined) {
      return { state, reply: obligationNotUnderstoodMessage() };
    }
    const built = createObligationDraft({
      householdId: deps.householdId,
      description: draft.description,
      amountCents: draft.monthlyAmountCents,
      startMonth: draft.startMonth,
      termMonths: draft.termMonths,
      dueDay: draft.dueDay,
      accountId: draft.accountId,
      createdByUserId: draft.createdByUserId,
      responsibleUserId: draft.responsibleUserId,
      category:
        draft.categoryId !== undefined
          ? {
              categoryId: draft.categoryId,
              subcategoryId: draft.subcategoryId,
            }
          : undefined,
    });
    if (!built.ok) {
      const first = built.errors[0];
      return {
        state,
        reply: `Não consegui salvar: ${first?.message ?? "dados inválidos"}.`,
      };
    }
    await deps.createObligation(built.value);
    await deps.logInteraction({
      fromUserId: draft.createdByUserId,
      inputKind: state.draft.inputKind,
      messageText: message,
      explanation: draft.categoryExplanation,
    });
    return {
      state: { status: "saved", draft: state.draft },
      reply: obligationSavedMessage({
        description: draft.description,
        monthlyAmountCents: draft.monthlyAmountCents,
        termMonths: draft.termMonths,
      }),
    };
  }

  // Corrections: valor / dia / conta.
  const next: ObligationDraftInProgress = { ...draft };
  let fieldLabel: string | null = null;

  const valueMatch = /^(valor|preço|preco)\b\s*(.+)$/i.exec(message.trim());
  if (valueMatch !== null) {
    const parsed = parseExpenseText(valueMatch[2] as string, { today });
    if (parsed.amountCents === undefined) {
      return { state, reply: obligationNotUnderstoodMessage() };
    }
    next.monthlyAmountCents = parsed.amountCents;
    fieldLabel = `o valor para R$ ${formatBrl(parsed.amountCents)}/mês`;
  }

  const dayMatch = /^dia\b\s*(\d{1,2})\s*$/i.exec(message.trim());
  if (fieldLabel === null && dayMatch !== null) {
    const day = Number.parseInt(dayMatch[1] as string, 10);
    if (day < 1 || day > 28) {
      return {
        state,
        reply: "O dia de vencimento precisa estar entre 1 e 28.",
      };
    }
    next.dueDay = day;
    fieldLabel = "o dia de vencimento";
  }

  const accountMatch = /^conta\b\s*(.+)$/i.exec(message.trim());
  if (fieldLabel === null && accountMatch !== null) {
    const accountId = deps.resolveAccountIdByName?.(
      accountMatch[1] as string,
    );
    if (accountId === undefined) {
      return {
        state,
        reply: `Não encontrei a conta "${(accountMatch[1] as string).trim()}".`,
      };
    }
    next.accountId = accountId;
    fieldLabel = "a conta de pagamento";
  }

  if (fieldLabel === null) {
    return { state, reply: obligationNotUnderstoodMessage() };
  }

  const nextState: ConversationState = {
    status: "awaiting_obligation_confirmation",
    draft: state.draft,
    obligationDraft: next,
  };
  return {
    state: nextState,
    reply: `${correctionAppliedMessage(fieldLabel)}\n\n${obligationConfirmationMessage(obligationSummaryView(next, deps))}`,
  };
}

export async function applyMessage(
  state: ConversationState,
  message: string,
  deps: ConversationDeps,
  options: { today?: string } = {},
): Promise<ConversationOutcome> {
  // Already terminal — nothing to do.
  if (state.status === "saved" || state.status === "cancelled") {
    return { state, reply: notUnderstoodMessage() };
  }

  const today = options.today ?? state.draft.occurredOn;

  if (state.status === "awaiting_mark_paid_choice") {
    return applyMarkPaidChoice(state, message, deps, today);
  }
  if (state.status === "awaiting_obligation_confirmation") {
    return applyObligationMessage(state, message, deps, today);
  }

  if (CANCEL_RE.test(message)) {
    const next: ConversationState = {
      status: "cancelled",
      draft: state.draft,
    };
    return { state: next, reply: cancelledMessage() };
  }

  if (CONFIRM_RE.test(message)) {
    return persist(state, deps, message);
  }

  // Otherwise treat it as a correction.
  const correction = parseCorrection(message, deps, today);
  const draft = { ...state.draft };

  switch (correction.field) {
    case "amount": {
      draft.amountCents = correction.cents;
      break;
    }
    case "date": {
      draft.occurredOn = correction.iso;
      break;
    }
    case "category": {
      draft.categoryId = correction.categoryId;
      draft.subcategoryId = correction.subcategoryId;
      draft.categoryExplanation = "Categoria escolhida manualmente.";
      break;
    }
    case "responsible": {
      draft.responsibleUserId = correction.userId;
      break;
    }
    case "unknown":
    default: {
      return { state, reply: notUnderstoodMessage() };
    }
  }

  const next: ConversationState = {
    status: statusForDraft(draft),
    draft,
  };
  const fieldLabel =
    correction.field === "amount"
      ? `o valor para R$ ${formatBrl(correction.cents)}`
      : correction.field === "date"
        ? "a data"
        : correction.field === "category"
          ? "a categoria"
          : "o responsável";
  const reply = `${correctionAppliedMessage(fieldLabel)}\n\n${replyForDraft(draft, deps.catalog)}`;
  return { state: next, reply };
}
