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
 * (default responsibility = the SENDER; "responsável casa" moves it back to the
 * house), persists it, records `createdByUserId` from the linked Telegram
 * identity, and logs the interaction for auditing.
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
  ValidationError,
} from "@family-finance/domain";
import type {
  CategorizationContext,
  CategorizationResult,
  CategoryCatalog,
} from "@family-finance/categorization";

import { parseExpenseText, stripEdgePunctuation } from "./parser.js";
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
  askCategoryNameMessage,
  cancelledMessage,
  cardBillDeferredMessage,
  cardInstallmentDeferredMessage,
  categoryCreatedMessage,
  categoryReusedMessage,
  chooseCategoryMessage,
  chooseResponsibleMessage,
  confirmationMessage,
  correctionAppliedMessage,
  formatBrl,
  invalidCategoryNameMessage,
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
  ALREADY_SAVED_TOAST,
  CATEGORY_NOT_FOUND_TOAST,
  SESSION_EXPIRED_TOAST,
  type ObligationSummaryView,
  type SummaryView,
} from "./replies.js";
import type { InlineKeyboardMarkup } from "./telegram.js";
import {
  TOKENS,
  CATEGORY_TOKEN_PREFIX,
  RESPONSIBLE_TOKEN_PREFIX,
  confirmationKeyboard,
  categoryGridKeyboard,
  responsibleGridKeyboard,
  cancelOnlyKeyboard,
} from "./keyboards.js";

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
  | "awaiting_mark_paid_choice"
  /** Waiting for the user to TYPE a new category's name (nc button / bare "nova categoria"). */
  | "awaiting_category_name";

/** The editable, in-progress draft built up across the conversation. */
export type DraftInProgress = {
  amountCents?: number;
  description: string;
  occurredOn: string;
  kind: TransactionKind;
  categoryId?: string;
  subcategoryId?: string;
  categoryExplanation?: string;
  /**
   * Display name for a category the loaded catalog does not carry (created or
   * reactivated mid-conversation). Labels fall back to this when the id is
   * not found in `deps.catalog`.
   */
  categoryNameFallback?: string;
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
  /** AI-proposed NEW category name (spec §3) — never placed in callback data. */
  proposedCategoryName?: string;
  /** message_id of the last keyboard-bearing prompt (to strip stale buttons). */
  promptMessageId?: number;
  /** True when awaiting_category_name was entered with NO expense draft. */
  standaloneCategoryCreation?: boolean;
};

export type ConversationOutcome = {
  state: ConversationState;
  /** The pt-BR reply to send back to the user. */
  reply: string;
  /** Set after a successful save, for auditing/follow-up. */
  transactionId?: string;
  /** Inline keyboard to attach to the reply (buttons are additive to the text hints). */
  keyboard?: InlineKeyboardMarkup;
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
  /**
   * Account used when the user did not specify card/account. `undefined` when
   * the household has no account at all — `persist` then refuses a non-card
   * lançamento with a clear message instead of an empty accountId.
   */
  defaultAccountId: string | undefined;
  /** Resolve a card id from a card hint (e.g. the household's single card). */
  resolveCardId: () => string | undefined;
  /** Resolve an account id from an account hint. */
  resolveAccountId: () => string | undefined;
  /** Map a free-text name to a responsible user id (or undefined = the house). */
  resolveResponsibleUserId: (name: string) => string | undefined;
  /** Map a member user id to their display name (for the summary). */
  memberDisplayName?: (userId: string) => string | undefined;
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
   * OPTIONAL LLM interpretation (spec §3.4): consulted on EVERY new entry in
   * `startConversation` for a clean description + category hint; the
   * deterministic parser stays the source of truth for amount/date (the LLM
   * only fills what the parser missed). Corrections stay deterministic. The
   * result still lands behind the confirmation step.
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
  /** ALL categories (active + archived) for create-dedupe (bot category creation). */
  listAllCategories?: () => Promise<
    Array<{ id: string; name: string; isActive: boolean }>
  >;
  /** Create an ACTIVE category (db createCategory); impl must also expose it in `catalog`. */
  createCategory?: (name: string) => Promise<{ id: string }>;
  /** Reactivate an archived category (db restoreCategory). */
  restoreCategory?: (categoryId: string, categoryName: string) => Promise<void>;
  /** Seed categorization_memory — ONLY the AI new-category accept path calls this. */
  seedCategorizationMemory?: (entry: {
    pattern: string;
    categoryId: string;
    confidence: number;
    explanation: string;
  }) => Promise<void>;
  /** Active members for the responsável grid. */
  listActiveMembers?: () => Array<{ userId: string; displayName: string }>;
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
  fallbackName?: string,
): string {
  if (categoryId === undefined) {
    return "Sem categoria (a definir)";
  }
  const category = catalog.categories.find((c) => c.id === categoryId);
  const macro = category?.name ?? fallbackName ?? "Categoria";
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

function responsibleLabel(
  draft: DraftInProgress,
  deps: ConversationDeps,
): string {
  if (draft.responsibleUserId === undefined) {
    return "Casa";
  }
  return deps.memberDisplayName?.(draft.responsibleUserId) ?? "Pessoa específica";
}

function summaryView(
  draft: DraftInProgress,
  deps: ConversationDeps,
  proposedNewCategory?: string,
): SummaryView {
  return {
    amountCents: draft.amountCents,
    description: draft.description,
    occurredOn: draft.occurredOn,
    categoryLabel: categoryLabel(
      deps.catalog,
      draft.categoryId,
      draft.subcategoryId,
      draft.categoryNameFallback,
    ),
    paymentLabel: paymentLabel(draft),
    responsibleLabel: responsibleLabel(draft, deps),
    categoryExplanation: draft.categoryExplanation,
    proposedNewCategory,
    needsAttention: draft.needsAttention,
  };
}

function statusForDraft(draft: DraftInProgress): ConversationStatus {
  return draft.amountCents === undefined
    ? "needs_amount"
    : "awaiting_confirmation";
}

function replyForState(state: ConversationState, deps: ConversationDeps): string {
  if (state.draft.amountCents === undefined) {
    return needsAmountMessage(state.draft.description);
  }
  return confirmationMessage(
    summaryView(state.draft, deps, state.proposedCategoryName),
  );
}

/** The keyboard each state's prompt carries (undefined = no buttons). */
function keyboardForState(
  state: ConversationState,
): InlineKeyboardMarkup | undefined {
  if (state.status === "awaiting_confirmation") {
    return confirmationKeyboard(state.proposedCategoryName);
  }
  if (state.status === "awaiting_category_name") {
    return cancelOnlyKeyboard();
  }
  return undefined;
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
  // An obligation is account-paid, so a household with no account at all
  // cannot hold one — refuse with a clear message (mirrors `persist`).
  const extracted = classified.obligation;
  if (deps.defaultAccountId === undefined) {
    return {
      state: { status: "cancelled", draft: ballast },
      reply:
        "A casa ainda não tem uma conta cadastrada — crie uma em Contas no painel antes de registrar obrigações.",
    };
  }
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

  // Manual category creation with NO active conversation (spec §4).
  const newCategoryMatch = NEW_CATEGORY_RE.exec(input.text);
  if (newCategoryMatch !== null) {
    const ballast = placeholderDraft(input, inputKind, options.today);
    const rawName = (newCategoryMatch[1] ?? "").trim();
    if (rawName.length === 0) {
      return {
        state: {
          status: "awaiting_category_name",
          draft: ballast,
          standaloneCategoryCreation: true,
        },
        reply: askCategoryNameMessage(),
        keyboard: cancelOnlyKeyboard(),
      };
    }
    const validated = validateCategoryName(rawName);
    if (!validated.ok) {
      return {
        state: { status: "cancelled", draft: ballast },
        reply: validated.error,
      };
    }
    const resolved = await createOrReuseCategory(validated.name, deps);
    if (resolved === null) {
      return {
        state: { status: "cancelled", draft: ballast },
        reply: notUnderstoodMessage(),
      };
    }
    await deps.logInteraction({
      fromUserId: input.fromUserId,
      inputKind,
      messageText: input.text,
    });
    return {
      state: { status: "cancelled", draft: ballast },
      reply: resolved.reused
        ? categoryReusedMessage(validated.name)
        : categoryCreatedMessage(validated.name),
    };
  }

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

  // LLM interpretation (spec §3.4): ALWAYS consulted when configured — its
  // clean description + category hint beat the parser's crude leftovers. The
  // classifier's plain-expense fields take that slot when present (ONE LLM
  // call, not two). It sees the ORIGINAL text; any failure (null/throw)
  // keeps the parser-only behavior. The result feeds the SAME draft +
  // confirmation path — never a direct save.
  let interpreted: InterpretedExpense | null = classifiedExpense;
  if (interpreted === null && deps.interpretText !== undefined) {
    interpreted = await deps
      .interpretText(input.text, { today: options.today })
      .catch(() => null);
  }

  const description = stripEdgePunctuation(
    interpreted?.description ?? parsed.description,
  );
  const dateUncertain = parsed.uncertainFields.includes("date");
  const draft: DraftInProgress = {
    // The deterministic parser owns amount and date; the LLM only fills what
    // the parser missed.
    amountCents: parsed.amountCents ?? interpreted?.amountCents,
    description,
    occurredOn: dateUncertain
      ? (interpreted?.occurredOn ?? parsed.occurredOn ?? options.today)
      : (parsed.occurredOn ?? options.today),
    kind: "expense",
    createdByUserId: input.fromUserId,
    // Responsibility defaults to the SENDER; "responsável casa" (or an
    // interpreted hint) moves it back to the house.
    responsibleUserId: input.fromUserId || undefined,
    inputKind,
    needsAttention:
      // Audio always merits a closer look (transcription can be imperfect),
      // and so do an uncertain amount or date. The interpreter running is
      // NOT a signal by itself — it runs on every message.
      inputKind === "audio" ||
      parsed.uncertainFields.includes("amount") ||
      dateUncertain,
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

  // AI new-category proposal (spec §3): the engine returns pending_new_category
  // with a proposed NAME; it lives in conversation state (never callback data)
  // until the user accepts, picks another, or drops it.
  let proposedCategoryName: string | undefined;
  if (
    result.status === "pending_new_category" &&
    result.pendingCategory !== undefined
  ) {
    proposedCategoryName = result.pendingCategory.categoryName;
    draft.categoryExplanation = result.pendingCategory.explanation;
    draft.needsAttention = true;
  }

  const state: ConversationState = {
    status: statusForDraft(draft),
    draft,
    proposedCategoryName,
  };
  return { state, reply: replyForState(state, deps), keyboard: keyboardForState(state) };
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

/**
 * True when the message is ONLY a confirmation word (optionally punctuated).
 * Stricter than CONFIRM_RE on purpose: a duplicate "sim" on an already-saved
 * draft is a no-op, but "ok, mercado 50 reais" is a NEW entry that must not
 * be swallowed.
 */
const BARE_CONFIRM_RE =
  /^\s*(confirmar|confirma|confirmo|sim|ok|salvar|salva)\s*[!.…]*\s*$/i;

export function isBareConfirmation(message: string): boolean {
  return BARE_CONFIRM_RE.test(message);
}

/** "nova categoria" [name] — manual category creation (spec §4). */
const NEW_CATEGORY_RE = /^\s*nova\s+categoria\b\s*(.*)$/i;

/** Trimmed, non-empty, ≤ 40 chars (spec §4 validation). */
function validateCategoryName(
  raw: string,
): { ok: true; name: string } | { ok: false; error: string } {
  const name = raw
    .replace(/[\p{Cc}\p{Cf}\u200B-\u200D\uFEFF]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (name.length === 0) {
    return { ok: false, error: invalidCategoryNameMessage("empty") };
  }
  if (name.length > 40) {
    return { ok: false, error: invalidCategoryNameMessage("too_long") };
  }
  return { ok: true, name };
}

/** Create/reuse `name`, assign it to the draft, and re-show the confirmation. */
async function createCategoryForDraft(
  state: ConversationState,
  name: string,
  deps: ConversationDeps,
): Promise<ConversationOutcome> {
  const resolved = await createOrReuseCategory(name, deps);
  if (resolved === null) {
    return { state, reply: notUnderstoodMessage() };
  }
  const draft: DraftInProgress = {
    ...state.draft,
    categoryId: resolved.categoryId,
    subcategoryId: undefined,
    categoryNameFallback: name,
    categoryExplanation: "Categoria criada pelo usuário.",
  };
  const next: ConversationState = {
    status: statusForDraft(draft),
    draft,
    proposedCategoryName: undefined,
    // This path always runs mid-draft (never standalone name-mode), so there
    // is no standalone-creation flag to carry forward — explicit for clarity.
    standaloneCategoryCreation: undefined,
  };
  const created = resolved.reused
    ? categoryReusedMessage(name)
    : categoryCreatedMessage(name);
  return {
    state: next,
    reply: `${created}\n\n${replyForState(next, deps)}`,
    keyboard: keyboardForState(next),
  };
}

/**
 * awaiting_category_name: NAME-MODE WINS — anything except "cancelar" is a
 * category name (so "confirmar" can be a category). Keeps the state machine
 * unambiguous (spec §5).
 */
async function applyCategoryName(
  state: ConversationState,
  message: string,
  deps: ConversationDeps,
): Promise<ConversationOutcome> {
  if (/^\s*(cancelar|cancela)\s*$/i.test(message)) {
    if (state.standaloneCategoryCreation === true) {
      return {
        state: { status: "cancelled", draft: state.draft },
        reply: cancelledMessage(),
      };
    }
    const back: ConversationState = {
      ...state,
      status: "awaiting_confirmation",
      standaloneCategoryCreation: undefined,
    };
    return {
      state: back,
      reply: replyForState(back, deps),
      keyboard: keyboardForState(back),
    };
  }

  const validated = validateCategoryName(message);
  if (!validated.ok) {
    return { state, reply: validated.error, keyboard: cancelOnlyKeyboard() };
  }

  if (state.standaloneCategoryCreation === true) {
    const resolved = await createOrReuseCategory(validated.name, deps);
    if (resolved === null) {
      return { state, reply: notUnderstoodMessage() };
    }
    // Terminal: the category exists; no transaction draft is open.
    return {
      state: { status: "cancelled", draft: state.draft },
      reply: resolved.reused
        ? categoryReusedMessage(validated.name)
        : categoryCreatedMessage(validated.name),
    };
  }
  return createCategoryForDraft(state, validated.name, deps);
}

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

/**
 * Turn a domain validation error into an intuitive pt-BR reason. The raw Zod
 * message (e.g. "String must contain at least 1 character") is meaningless to
 * the household, so name the offending FIELD in plain Portuguese instead.
 */
function describeValidationError(error: ValidationError | undefined): string {
  if (error === undefined) {
    return "dados inválidos";
  }
  switch (error.field) {
    case "payment":
    case "payment.accountId":
      return "conta não informada";
    case "payment.creditCardId":
      return "cartão não informado";
    case "amount.cents":
      return "valor inválido";
    case "occurredOn":
      return "data inválida";
    case "description":
      return "descrição vazia";
    case "createdByUserId":
      return "não consegui te identificar (fala com o Álvaro)";
    case "householdId":
      return "casa não encontrada";
    default:
      return `campo inválido (${error.field})`;
  }
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
    const next: ConversationState = { ...state, status: "needs_amount", draft };
    return { state: next, reply: needsAmountMessage(draft.description) };
  }

  // Resolve the payment instrument. A non-card lançamento needs a usable
  // account id; when the household has no account at all `defaultAccountId` is
  // undefined, so we stop here with a clear message instead of building a draft
  // with an empty accountId (which the domain would reject with an opaque
  // "String must contain at least 1 character").
  let payment:
    | { type: "card"; creditCardId: string }
    | { type: "account"; accountId: string };
  if (draft.cardId !== undefined) {
    payment = { type: "card", creditCardId: draft.cardId };
  } else {
    const accountId = draft.accountId ?? deps.defaultAccountId;
    if (accountId === undefined || accountId.length === 0) {
      const next: ConversationState = { ...state, status: statusForDraft(draft), draft };
      return {
        state: next,
        reply:
          "Não consegui salvar: você ainda não tem uma conta cadastrada pra " +
          "lançar por aqui. Cadastre uma conta no app, ou me diga o cartão " +
          '(ex.: "cartão Nubank").',
      };
    }
    payment = { type: "account", accountId };
  }

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
    // Surface the offending field in plain pt-BR — the raw Zod message is
    // opaque to the household. Keep the conversation open so they can correct.
    const next: ConversationState = {
      ...state,
      status: statusForDraft(draft),
      draft,
    };
    return {
      state: next,
      reply: `Não consegui salvar: ${describeValidationError(built.errors[0])}.`,
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
        draft.categoryNameFallback,
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

  if (state.status === "awaiting_category_name") {
    return applyCategoryName(state, message, deps);
  }
  if (state.status === "awaiting_mark_paid_choice") {
    return applyMarkPaidChoice(state, message, deps, today);
  }
  if (state.status === "awaiting_obligation_confirmation") {
    return applyObligationMessage(state, message, deps, today);
  }

  const newCategoryMatch = NEW_CATEGORY_RE.exec(message);
  if (newCategoryMatch !== null) {
    const rawName = (newCategoryMatch[1] ?? "").trim();
    if (rawName.length === 0) {
      const next: ConversationState = {
        ...state,
        status: "awaiting_category_name",
      };
      return {
        state: next,
        reply: askCategoryNameMessage(),
        keyboard: cancelOnlyKeyboard(),
      };
    }
    const validated = validateCategoryName(rawName);
    if (!validated.ok) {
      return { state, reply: validated.error };
    }
    return createCategoryForDraft(state, validated.name, deps);
  }

  if (CANCEL_RE.test(message)) {
    const next: ConversationState = {
      status: "cancelled",
      draft: state.draft,
    };
    return { state: next, reply: cancelledMessage() };
  }

  if (CONFIRM_RE.test(message)) {
    const outcome = await confirmDraft(state, deps, message, today);
    return { ...outcome, keyboard: keyboardForState(outcome.state) };
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
    ...state,
    status: statusForDraft(draft),
    draft,
    // A typed category correction replaces any pending AI proposal — mirrors
    // the ct: tapped path so the UI never lies about which category is set.
    ...(correction.field === "category" ? { proposedCategoryName: undefined } : {}),
  };
  const fieldLabel =
    correction.field === "amount"
      ? `o valor para R$ ${formatBrl(correction.cents)}`
      : correction.field === "date"
        ? "a data"
        : correction.field === "category"
          ? "a categoria"
          : "o responsável";
  const reply = `${correctionAppliedMessage(fieldLabel)}\n\n${replyForState(next, deps)}`;
  return { state: next, reply, keyboard: keyboardForState(next) };
}

/**
 * Dedupe-then-create (spec §3): case- and accent-insensitive match against ALL
 * categories. Active match → assign as-is; inactive match → reactivate; no
 * match → create (active immediately). Returns null when the category-creation
 * deps are not wired (flow degrades to "not understood").
 */
async function createOrReuseCategory(
  name: string,
  deps: ConversationDeps,
): Promise<{ categoryId: string; reused: boolean } | null> {
  if (deps.listAllCategories === undefined || deps.createCategory === undefined) {
    return null;
  }
  const wanted = normalizeText(name);
  const existing = await deps.listAllCategories();
  const match = existing.find((c) => normalizeText(c.name) === wanted);
  if (match !== undefined) {
    if (!match.isActive) {
      await deps.restoreCategory?.(match.id, match.name);
    }
    return { categoryId: match.id, reused: true };
  }
  const created = await deps.createCategory(name);
  return { categoryId: created.id, reused: false };
}

/**
 * Confirm the draft. With a pending AI category proposal and no category yet:
 * create/reuse the category, assign it, persist through the normal `persist`,
 * then seed categorization_memory (the ONLY path that seeds — spec §3).
 */
async function confirmDraft(
  state: ConversationState,
  deps: ConversationDeps,
  messageText: string,
  today: string,
): Promise<ConversationOutcome> {
  let working = state;
  if (
    state.proposedCategoryName !== undefined &&
    state.draft.categoryId === undefined &&
    state.draft.amountCents !== undefined
  ) {
    const resolved = await createOrReuseCategory(
      state.proposedCategoryName,
      deps,
    );
    if (resolved === null) {
      // Category creation is not wired here — keep the draft, explain.
      return { state, reply: notUnderstoodMessage() };
    }
    const draft: DraftInProgress = {
      ...state.draft,
      categoryId: resolved.categoryId,
      subcategoryId: undefined,
      categoryNameFallback: state.proposedCategoryName,
    };
    working = { ...state, draft, proposedCategoryName: undefined };

    const outcome = await persist(working, deps, messageText);
    // Seed only after the transaction is durable; seeding is an optimization
    // and must never make a saved lançamento look failed to the user.
    const pattern = normalizeText(draft.description);
    if (
      outcome.state.status === "saved" &&
      deps.seedCategorizationMemory !== undefined &&
      pattern.length > 0
    ) {
      try {
        await deps.seedCategorizationMemory({
          pattern,
          categoryId: resolved.categoryId,
          confidence: 0.95,
          explanation: `criada pelo usuário via bot em ${today}`,
        });
      } catch (error) {
        console.warn("[bot] seedCategorizationMemory failed:", error);
      }
    }
    return outcome;
  }
  return persist(working, deps, messageText);
}

/** ❌ while typing a category name — standalone mode cancels fully. */
function cancelCategoryName(
  state: ConversationState,
  deps: ConversationDeps,
): ApplyCallbackOutcome {
  if (state.standaloneCategoryCreation === true) {
    return {
      state: { status: "cancelled", draft: state.draft },
      reply: cancelledMessage(),
    };
  }
  const next: ConversationState = {
    ...state,
    status: "awaiting_confirmation",
    standaloneCategoryCreation: undefined,
  };
  return summaryOutcome(next, deps);
}

// ---------------------------------------------------------------------------
// Apply an inline-button tap: structured tokens through the SAME transitions
// as typed messages (approach B — no text-spoofing into the regex parser).
// ---------------------------------------------------------------------------

export type ApplyCallbackOutcome = ConversationOutcome & {
  /** answerCallbackQuery toast (shown even when no message is sent). */
  toast?: string;
  /** True when NO new message should be sent (reply is ""). */
  silent?: boolean;
};

function expiredOutcome(state: ConversationState): ApplyCallbackOutcome {
  return { state, reply: "", silent: true, toast: SESSION_EXPIRED_TOAST };
}

function summaryOutcome(
  state: ConversationState,
  deps: ConversationDeps,
  prefix?: string,
): ApplyCallbackOutcome {
  const body = replyForState(state, deps);
  return {
    state,
    reply: prefix !== undefined ? `${prefix}\n\n${body}` : body,
    keyboard: keyboardForState(state),
  };
}

type ConversationDepsInput = ConversationDeps | (() => Promise<ConversationDeps>);

function isDepsGetter(
  deps: ConversationDepsInput,
): deps is () => Promise<ConversationDeps> {
  return typeof deps === "function";
}

export async function applyCallback(
  state: ConversationState,
  token: string,
  deps: ConversationDepsInput,
  options: { today?: string } = {},
): Promise<ApplyCallbackOutcome> {
  const today = options.today ?? state.draft.occurredOn;
  let resolvedDeps: ConversationDeps | undefined;
  const getDeps = async (): Promise<ConversationDeps> => {
    if (resolvedDeps !== undefined) {
      return resolvedDeps;
    }
    resolvedDeps = isDepsGetter(deps) ? await deps() : deps;
    return resolvedDeps;
  };

  // Terminal states: a confirm double-tap is a friendly no-op; anything else
  // is a stale button. Never crash, never double-insert.
  if (state.status === "saved") {
    if (token === TOKENS.confirm || token === TOKENS.acceptProposal) {
      return { state, reply: "", silent: true, toast: ALREADY_SAVED_TOAST };
    }
    return expiredOutcome(state);
  }
  if (state.status === "cancelled") {
    return expiredOutcome(state);
  }

  // Obligation flows and mark-paid choices never get keyboards (out of scope),
  // so any token landing there is stale.
  if (
    state.status === "awaiting_obligation_confirmation" ||
    state.status === "awaiting_mark_paid_choice"
  ) {
    return expiredOutcome(state);
  }

  // awaiting_category_name: only ❌ (cx) is a valid tap; the category name
  // itself arrives as typed text through applyMessage, so other tokens are stale.
  if (state.status === "awaiting_category_name") {
    if (token === TOKENS.cancel) {
      return cancelCategoryName(state, await getDeps());
    }
    return expiredOutcome(state);
  }

  // awaiting_confirmation / needs_amount.
  if (token === TOKENS.confirm) {
    const depsValue = await getDeps();
    const outcome = await confirmDraft(state, depsValue, "confirmar (botão)", today);
    return { ...outcome, keyboard: keyboardForState(outcome.state) };
  }
  if (token === TOKENS.cancel) {
    return {
      state: { status: "cancelled", draft: state.draft },
      reply: cancelledMessage(),
    };
  }
  if (token === TOKENS.categories) {
    const depsValue = await getDeps();
    return {
      state,
      reply: chooseCategoryMessage(),
      keyboard: categoryGridKeyboard(depsValue.catalog.categories),
    };
  }
  if (token.startsWith(CATEGORY_TOKEN_PREFIX)) {
    const depsValue = await getDeps();
    const categoryId = token.slice(CATEGORY_TOKEN_PREFIX.length);
    const category = depsValue.catalog.categories.find((c) => c.id === categoryId);
    if (category === undefined) {
      return { state, reply: "", silent: true, toast: CATEGORY_NOT_FOUND_TOAST };
    }
    const draft: DraftInProgress = {
      ...state.draft,
      categoryId: category.id,
      subcategoryId: undefined,
      categoryNameFallback: category.name,
      categoryExplanation: "Categoria escolhida manualmente.",
    };
    const next: ConversationState = {
      ...state,
      status: statusForDraft(draft),
      draft,
      proposedCategoryName: undefined,
    };
    return summaryOutcome(next, depsValue, correctionAppliedMessage("a categoria"));
  }
  if (token === TOKENS.responsible) {
    const depsValue = await getDeps();
    return {
      state,
      reply: chooseResponsibleMessage(),
      keyboard: responsibleGridKeyboard(depsValue.listActiveMembers?.() ?? []),
    };
  }
  if (token === TOKENS.responsibleHouse) {
    const depsValue = await getDeps();
    const draft: DraftInProgress = { ...state.draft, responsibleUserId: undefined };
    const next: ConversationState = { ...state, status: statusForDraft(draft), draft };
    return summaryOutcome(next, depsValue, correctionAppliedMessage("o responsável"));
  }
  if (token.startsWith(RESPONSIBLE_TOKEN_PREFIX)) {
    const depsValue = await getDeps();
    const userId = token.slice(RESPONSIBLE_TOKEN_PREFIX.length);
    const member = depsValue.listActiveMembers?.().find((m) => m.userId === userId);
    if (member === undefined) {
      return expiredOutcome(state);
    }
    const draft: DraftInProgress = { ...state.draft, responsibleUserId: userId };
    const next: ConversationState = { ...state, status: statusForDraft(draft), draft };
    return summaryOutcome(next, depsValue, correctionAppliedMessage("o responsável"));
  }

  if (token === TOKENS.acceptProposal) {
    if (state.proposedCategoryName === undefined) {
      return expiredOutcome(state);
    }
    const depsValue = await getDeps();
    const outcome = await confirmDraft(
      state,
      depsValue,
      `confirmar (botão, nova categoria "${state.proposedCategoryName}")`,
      today,
    );
    return { ...outcome, keyboard: keyboardForState(outcome.state) };
  }
  if (token === TOKENS.dropProposal) {
    if (state.proposedCategoryName === undefined) {
      return expiredOutcome(state);
    }
    const depsValue = await getDeps();
    const next: ConversationState = { ...state, proposedCategoryName: undefined };
    return summaryOutcome(next, depsValue);
  }

  if (token === TOKENS.newCategory) {
    const next: ConversationState = { ...state, status: "awaiting_category_name" };
    return {
      state: next,
      reply: askCategoryNameMessage(),
      keyboard: cancelOnlyKeyboard(),
    };
  }

  // Any future/unknown token — answer-and-ignore.
  return expiredOutcome(state);
}
