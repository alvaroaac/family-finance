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
  createCardBillSettlement,
  createInstallmentPlan,
  createObligationDraft,
  createTransactionDraft,
  obligationEndMonth,
} from "@family-finance/domain";
import type {
  CardBillSettlementDraft,
  InstallmentPlan,
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
  InterpretedCardPurchase,
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
  cardBillAlreadyPaidMessage,
  cardBillConfirmationMessage,
  cardBillNoMatchMessage,
  cardBillPaidMessage,
  cardBillSettleFailedMessage,
  cardBillZeroMessage,
  categoryCreatedMessage,
  categoryReusedMessage,
  chooseCardBillMessage,
  chooseCategoryMessage,
  chooseResponsibleMessage,
  confirmationMessage,
  correctionAppliedMessage,
  formatBrl,
  installmentConfirmationMessage,
  installmentSavedMessage,
  installmentSaveFailedMessage,
  invalidCategoryNameMessage,
  needsAmountMessage,
  noActiveCardMessage,
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
  type InstallmentSummaryView,
  type ObligationSummaryView,
  type SummaryView,
} from "./replies.js";
import type { InlineKeyboardMarkup } from "./telegram.js";
import {
  TOKENS,
  CATEGORY_TOKEN_PREFIX,
  CATEGORY_SUGGESTION_TOKEN_PREFIX,
  CARD_TOKEN_PREFIX,
  RESPONSIBLE_TOKEN_PREFIX,
  confirmationKeyboard,
  installmentConfirmationKeyboard,
  categoryGridKeyboard,
  cardGridKeyboard,
  responsibleGridKeyboard,
  cancelOnlyKeyboard,
  obligationConfirmationKeyboard,
  confirmCancelKeyboard,
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
  /** A card-installment purchase draft awaits its "confirmar" (PR-2). */
  | "awaiting_installment_confirmation"
  /** A card-bill payment draft awaits its "confirmar" (PR-2, "nubank pago"). */
  | "awaiting_card_bill_confirmation"
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

/** The editable, in-progress CARD INSTALLMENT purchase draft (PR-2). */
export type InstallmentDraftInProgress = {
  description: string;
  /** Total purchase amount in cents; undefined until "valor X" fills it. */
  totalCents?: number;
  installmentCount?: number;
  /** ISO date (YYYY-MM-DD) of the original purchase. */
  purchasedOn: string;
  cardId?: string;
  categoryId?: string;
  subcategoryId?: string;
  categoryExplanation?: string;
  responsibleUserId?: string;
  createdByUserId: string;
};

/** The editable, in-progress CARD-BILL payment draft ("nubank pago", PR-2). */
export type CardBillDraftInProgress = {
  cardId?: string; // undefined while the picker is open
  overrideAmountCents?: number; // classifier trailing amount or `valor` correction
  amountCents?: number; // resolved (override ?? computed) once the card is known
  accountId: string;
  month: string; // YYYY-MM, calendar month of the message
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
  /** Set while status = awaiting_installment_confirmation. */
  installmentDraft?: InstallmentDraftInProgress;
  /** Set while status = awaiting_card_bill_confirmation. */
  cardBillDraft?: CardBillDraftInProgress;
  /** Set while status = awaiting_mark_paid_choice. */
  markPaidCandidates?: MarkPaidCandidate[];
  /** AI-proposed NEW category name (spec §3) — never placed in callback data. */
  proposedCategoryName?: string;
  /** Ranked existing categories returned by the unified interpreter. */
  categoryCandidates?: Array<{
    categoryId: string;
    categoryName: string;
    subcategoryId?: string;
    subcategoryName?: string;
    confidence: number;
    explanation: string;
  }>;
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
  merchantAliases?: Record<string, readonly string[]>;
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
  /** Active credit cards for the card-installment flow (PR-2). */
  listActiveCards?: () => Array<{
    id: string;
    name: string;
    closingDay?: number;
  }>;
  /** Persist a validated installment plan (db createInstallmentPurchase). */
  createInstallmentPurchase?: (
    plan: InstallmentPlan,
  ) => Promise<{ groupId: string }>;
  /** Computed bill amount (cents) for one card/month (card-bill flow, PR-2). */
  getCardBillAmount?: (creditCardId: string, month: string) => Promise<number>;
  /** Persist a validated card-bill settlement (db settleCardBill). */
  settleCardBill?: (
    draft: CardBillSettlementDraft,
  ) => Promise<{ alreadyPaid: boolean }>;
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
  responsibleUserId: string | undefined,
  deps: ConversationDeps,
): string {
  if (responsibleUserId === undefined) {
    return "Casa";
  }
  return deps.memberDisplayName?.(responsibleUserId) ?? "Pessoa específica";
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
    responsibleLabel: responsibleLabel(draft.responsibleUserId, deps),
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

function replyForState(
  state: ConversationState,
  deps: ConversationDeps,
): string {
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
    return confirmationKeyboard(
      state.proposedCategoryName,
      state.categoryCandidates ?? [],
    );
  }
  if (state.status === "awaiting_category_name") {
    return cancelOnlyKeyboard();
  }
  if (state.status === "awaiting_obligation_confirmation") {
    return obligationConfirmationKeyboard();
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Start: classify + parse + categorize + ask for confirmation (never persists).
// ---------------------------------------------------------------------------

/** Case- and accent-insensitive normalization for keyword matching. */
function normalizeText(value: string): string {
  return value.normalize("NFD").replace(/\p{M}/gu, "").trim().toLowerCase();
}

function resolveCategoryCandidates(
  candidates: NonNullable<InterpretedExpense["categoryCandidates"]>,
  catalog: CategoryCatalog,
): NonNullable<ConversationState["categoryCandidates"]> {
  return candidates
    .flatMap((candidate) => {
      const category = catalog.categories.find(
        (item) =>
          normalizeText(item.name) === normalizeText(candidate.categoryName),
      );
      if (!category) return [];
      const subcategory = candidate.subcategoryName
        ? catalog.subcategories.find(
            (item) =>
              item.categoryId === category.id &&
              normalizeText(item.name) ===
                normalizeText(candidate.subcategoryName as string),
          )
        : undefined;
      if (candidate.subcategoryName && !subcategory) return [];
      return [
        {
          categoryId: category.id,
          categoryName: category.name,
          subcategoryId: subcategory?.id,
          subcategoryName: subcategory?.name,
          confidence: candidate.confidence,
          explanation: candidate.explanation,
        },
      ];
    })
    .slice(0, 3);
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
 * shared token like "solar" is what actually links them. Shared by obligation
 * mark-paid matching and card-name resolution (PR-2).
 */
function keywordMatch(keyword: string, name: string): boolean {
  const keywordTokens = matchTokens(keyword);
  const nameTokens = matchTokens(name);
  if (keywordTokens.length === 0 || nameTokens.length === 0) {
    return false;
  }
  return keywordTokens.some((token) => nameTokens.includes(token));
}

/**
 * Card-name match: token overlap like `keywordMatch`, but with a whole-string
 * fallback for short names ("C6", "XP") that `matchTokens` filters out (< 3
 * chars). When either side yields no tokens, fall back to normalized
 * equality/containment instead of failing outright. Used at all card-
 * matching sites; obligation matching keeps the plain `keywordMatch` (3-char
 * filter, no fallback) since obligation descriptions are free text.
 */
function cardKeywordMatch(keyword: string, name: string): boolean {
  const keywordTokens = matchTokens(keyword);
  const nameTokens = matchTokens(name);
  if (keywordTokens.length > 0 && nameTokens.length > 0) {
    return keywordTokens.some((token) => nameTokens.includes(token));
  }
  const normalizedKeyword = normalizeText(keyword);
  const normalizedName = normalizeText(name);
  if (normalizedKeyword.length === 0 || normalizedName.length === 0) {
    return false;
  }
  return (
    normalizedKeyword.includes(normalizedName) ||
    normalizedName.includes(normalizedKeyword)
  );
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

/** Find an active card by id (installment flow — card resolution/corrections). */
function findActiveCard(
  deps: ConversationDeps,
  cardId: string | undefined,
): { id: string; name: string; closingDay?: number } | undefined {
  if (cardId === undefined) {
    return undefined;
  }
  return deps.listActiveCards?.().find((c) => c.id === cardId);
}

/**
 * Resolve the first parcel's due month via the pure domain generator — only
 * when the draft is complete enough (total, count, purchase date, card). A
 * validation failure (e.g. an amount of 0 mid-correction) simply omits the
 * parenthetical rather than surfacing a domain error in the summary.
 */
function firstDueMonthFor(
  draft: InstallmentDraftInProgress,
  deps: ConversationDeps,
): string | undefined {
  if (
    draft.totalCents === undefined ||
    draft.installmentCount === undefined ||
    draft.cardId === undefined
  ) {
    return undefined;
  }
  const card = findActiveCard(deps, draft.cardId);
  const built = createInstallmentPlan({
    householdId: deps.householdId,
    creditCardId: draft.cardId,
    description: draft.description,
    totalAmount: { currency: "BRL", cents: draft.totalCents },
    installmentCount: draft.installmentCount,
    purchasedOn: draft.purchasedOn,
    createdByUserId: draft.createdByUserId,
    responsibleUserId: draft.responsibleUserId,
    category:
      draft.categoryId !== undefined
        ? { categoryId: draft.categoryId, subcategoryId: draft.subcategoryId }
        : undefined,
    closingDay: card?.closingDay,
  });
  return built.ok ? built.value.installments[0]?.dueMonth : undefined;
}

function installmentSummaryView(
  draft: InstallmentDraftInProgress,
  deps: ConversationDeps,
  proposedNewCategory?: string,
): InstallmentSummaryView {
  const card = findActiveCard(deps, draft.cardId);
  return {
    description: draft.description,
    totalCents: draft.totalCents,
    installmentCount: draft.installmentCount,
    cardName: card?.name,
    firstDueMonth: firstDueMonthFor(draft, deps),
    categoryLabel: categoryLabel(
      deps.catalog,
      draft.categoryId,
      draft.subcategoryId,
    ),
    categoryExplanation: draft.categoryExplanation,
    proposedNewCategory,
    responsibleLabel: responsibleLabel(draft.responsibleUserId, deps),
    needsCard: draft.cardId === undefined,
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

/**
 * Resolve the card for a new card-installment draft (flow requirement 1):
 * a `cardKeyword` token-matched against exactly one active card wins; absent
 * a keyword, exactly one active card auto-selects; anything else (0 or 2+
 * candidates) leaves `cardId` unset so the confirmation asks "Qual cartão?".
 */
function resolveInstallmentCardId(
  purchase: InterpretedCardPurchase,
  cards: Array<{ id: string; name: string; closingDay?: number }>,
): string | undefined {
  if (purchase.cardKeyword !== undefined) {
    const matches = cards.filter((c) =>
      cardKeywordMatch(purchase.cardKeyword as string, c.name),
    );
    return matches.length === 1 ? matches[0]?.id : undefined;
  }
  return cards.length === 1 ? cards[0]?.id : undefined;
}

/**
 * Build the initial installment draft + confirmation outcome for a
 * `card_installment` classified intent (flow requirements 1–2).
 */
async function startInstallmentIntent(
  purchase: InterpretedCardPurchase,
  input: StartInput,
  deps: ConversationDeps,
  options: StartOptions,
  ballast: DraftInProgress,
): Promise<ConversationOutcome> {
  const cards = deps.listActiveCards?.() ?? [];
  if (cards.length === 0) {
    return {
      state: { status: "cancelled", draft: ballast },
      reply: noActiveCardMessage(),
    };
  }

  const totalCents =
    purchase.totalCents ??
    (purchase.perInstallmentCents !== undefined &&
    purchase.installmentCount !== undefined
      ? purchase.perInstallmentCents * purchase.installmentCount
      : undefined);

  const installmentDraft: InstallmentDraftInProgress = {
    description: stripEdgePunctuation(purchase.description),
    totalCents,
    installmentCount: purchase.installmentCount,
    purchasedOn: purchase.purchasedOn ?? options.today,
    cardId: resolveInstallmentCardId(purchase, cards),
    createdByUserId: input.fromUserId,
    responsibleUserId: input.fromUserId || undefined,
  };

  // Same shared categorization engine as expenses/obligations; the hint is
  // free TEXT appended to the context description — never trusted as an id.
  let proposedCategoryName = purchase.proposedCategoryName;
  let categoryCandidates: ConversationState["categoryCandidates"];
  if (purchase.unifiedPrimary === true) {
    categoryCandidates = resolveCategoryCandidates(
      purchase.categoryCandidates ?? [],
      deps.catalog,
    );
    if (purchase.proposedSubcategory) {
      installmentDraft.categoryExplanation = `Subcategoria sugerida (pendente): ${purchase.proposedSubcategory.categoryName} > ${purchase.proposedSubcategory.subcategoryName}.`;
    }
  } else {
    const result = await deps.suggestCategory({
      householdId: deps.householdId,
      description:
        purchase.categoryHint !== undefined
          ? `${installmentDraft.description} (${purchase.categoryHint})`
          : installmentDraft.description,
      amountCents: installmentDraft.totalCents,
      occurredOn: installmentDraft.purchasedOn,
    });
    if (result.suggestion?.macroCategoryId !== undefined) {
      installmentDraft.categoryId = result.suggestion.macroCategoryId;
      installmentDraft.subcategoryId = result.suggestion.subcategoryId;
      installmentDraft.categoryExplanation = result.suggestion.explanation;
    }
    if (
      result.status === "pending_new_category" &&
      result.pendingCategory !== undefined
    ) {
      proposedCategoryName = result.pendingCategory.categoryName;
      installmentDraft.categoryExplanation = result.pendingCategory.explanation;
    }
  }

  const state: ConversationState = {
    status: "awaiting_installment_confirmation",
    draft: ballast,
    installmentDraft,
    proposedCategoryName,
    categoryCandidates,
  };
  const view = installmentSummaryView(
    installmentDraft,
    deps,
    proposedCategoryName,
  );
  const reply =
    installmentDraft.cardId === undefined
      ? `${installmentConfirmationMessage(view)}\n\nQual cartão?`
      : installmentConfirmationMessage(view);
  const keyboard =
    installmentDraft.cardId === undefined
      ? cardGridKeyboard(cards)
      : proposedCategoryName !== undefined
        ? installmentConfirmationKeyboard(proposedCategoryName)
        : installmentConfirmationKeyboard(undefined, categoryCandidates);
  return { state, reply, keyboard };
}

/**
 * Build the confirmation outcome for a card-bill draft whose card AND amount
 * are both resolved (flow requirement 2). `amount` is `overrideAmountCents
 * ?? computed`; a resolved zero (no override) is terminal — nothing gets
 * written.
 */
function cardBillConfirmationOutcome(
  draft: CardBillDraftInProgress,
  amount: number,
  cardName: string,
  ballast: DraftInProgress,
  deps: ConversationDeps,
): ConversationOutcome {
  const next: CardBillDraftInProgress = { ...draft, amountCents: amount };
  const state: ConversationState = {
    status: "awaiting_card_bill_confirmation",
    draft: ballast,
    cardBillDraft: next,
  };
  return {
    state,
    reply: cardBillConfirmationMessage({
      cardName,
      month: next.month,
      amountCents: amount,
      accountLabel: deps.accountNameById?.(next.accountId) ?? "Conta",
    }),
    keyboard: confirmCancelKeyboard(),
  };
}

/**
 * Resolve the card for an in-progress card-bill draft (flow requirement 2):
 * shared by the 1-match start path, the `cd:` tap, and a typed card-name
 * reply while the picker is open. Computes the bill amount, applies any
 * override, and either shows the confirmation or the terminal zero-bill
 * message (nothing written either way until "confirmar").
 */
async function resolveBillCard(
  cardId: string,
  draft: CardBillDraftInProgress,
  ballast: DraftInProgress,
  deps: ConversationDeps,
): Promise<ConversationOutcome> {
  const card = findActiveCard(deps, cardId);
  if (deps.getCardBillAmount === undefined) {
    return {
      state: { status: "cancelled", draft: ballast },
      reply: obligationUnavailableMessage(),
    };
  }
  const computed = await deps.getCardBillAmount(cardId, draft.month);
  const amount = draft.overrideAmountCents ?? computed;
  const next: CardBillDraftInProgress = { ...draft, cardId };
  if (amount === undefined || amount <= 0) {
    return {
      state: { status: "cancelled", draft: ballast },
      reply: cardBillZeroMessage(card?.name ?? "cartão"),
    };
  }
  return cardBillConfirmationOutcome(
    next,
    amount,
    card?.name ?? "cartão",
    ballast,
    deps,
  );
}

/**
 * Build the initial card-bill draft + outcome for a `mark_paid{card}`
 * classified intent (flow requirement 1). No cards at all, or no default
 * account -> terminal refusal. Otherwise the keyword is matched against the
 * household's cards: exactly 1 match -> resolveBillCard; 0 or 2+ matches ->
 * the picker grid (0 matches also shows the not-found message as context
 * above the grid, so the user can just tap instead of retyping the name).
 */
async function startCardBillIntent(
  keyword: string,
  overrideAmountCents: number | undefined,
  input: StartInput,
  deps: ConversationDeps,
  options: StartOptions,
  ballast: DraftInProgress,
): Promise<ConversationOutcome> {
  const cards = deps.listActiveCards?.() ?? [];
  if (cards.length === 0) {
    return {
      state: { status: "cancelled", draft: ballast },
      reply: "A casa ainda não tem cartão cadastrado.",
    };
  }
  if (deps.defaultAccountId === undefined) {
    return {
      state: { status: "cancelled", draft: ballast },
      reply:
        "A casa ainda não tem uma conta cadastrada — crie uma em Contas no painel antes de pagar faturas.",
    };
  }

  const month = options.today.slice(0, 7);
  const draft: CardBillDraftInProgress = {
    overrideAmountCents,
    accountId: deps.defaultAccountId,
    month,
    createdByUserId: input.fromUserId,
  };

  const matches = cards.filter((c) => cardKeywordMatch(keyword, c.name));
  if (matches.length === 0) {
    return {
      state: {
        status: "awaiting_card_bill_confirmation",
        draft: ballast,
        cardBillDraft: draft,
      },
      reply: cardBillNoMatchMessage(
        keyword,
        cards.map((c) => c.name),
      ),
      keyboard: cardGridKeyboard(cards),
    };
  }

  if (matches.length === 1) {
    return resolveBillCard(matches[0]?.id as string, draft, ballast, deps);
  }

  return {
    state: {
      status: "awaiting_card_bill_confirmation",
      draft: ballast,
      cardBillDraft: draft,
    },
    reply: chooseCardBillMessage(),
    keyboard: cardGridKeyboard(matches),
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

  if (classified.intent === "card_installment") {
    return startInstallmentIntent(
      classified.purchase,
      input,
      deps,
      options,
      ballast,
    );
  }

  // Card-bill payment (mark_paid{card}, "nubank pago" — PR-2 / Task 6).
  if (classified.intent === "mark_paid" && classified.target === "card") {
    return startCardBillIntent(
      classified.keyword,
      classified.amountCents,
      input,
      deps,
      options,
      ballast,
    );
  }

  if (classified.intent === "mark_paid") {
    const obligations =
      deps.listActiveObligations !== undefined
        ? await deps.listActiveObligations()
        : [];
    const matches = obligations.filter((o) =>
      keywordMatch(classified.keyword, o.description),
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
  const result =
    extracted.unifiedPrimary === true
      ? null
      : await deps.suggestCategory({
          householdId: deps.householdId,
          description:
            extracted.categoryHint !== undefined
              ? `${extracted.description} (${extracted.categoryHint})`
              : extracted.description,
          amountCents: obligationDraft.monthlyAmountCents,
          occurredOn: options.today,
        });
  if (result?.suggestion?.macroCategoryId !== undefined) {
    obligationDraft.categoryId = result.suggestion.macroCategoryId;
    obligationDraft.subcategoryId = result.suggestion.subcategoryId;
    obligationDraft.categoryExplanation = result.suggestion.explanation;
  }

  return {
    state: {
      status: "awaiting_obligation_confirmation",
      draft: ballast,
      obligationDraft,
      proposedCategoryName: extracted.proposedCategoryName,
      categoryCandidates: resolveCategoryCandidates(
        extracted.categoryCandidates ?? [],
        deps.catalog,
      ),
    },
    reply: obligationConfirmationMessage(
      obligationSummaryView(obligationDraft, deps),
    ),
    keyboard: obligationConfirmationKeyboard(),
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

  // Deterministic parsing runs first. Rich interpreters receive these hints,
  // but parser-owned amount/date fields still win in the plain-expense path.
  const parsed = parseExpenseText(input.text, { today: options.today });

  // Unified intent classification (recurring-obligations design): when
  // configured it sees every NEW message first. A null result — or a plain
  // expense — falls through to the deterministic parser path below, so the
  // legacy behavior is untouched when the classifier is absent or fails.
  let classifiedExpense: InterpretedExpense | null = null;
  if (deps.classifyMessage !== undefined) {
    const classified = await deps
      .classifyMessage(input.text, {
        today: options.today,
        parserHints: parsed,
        knownCards: (deps.listActiveCards?.() ?? []).map(({ id, name }) => ({
          id,
          name,
        })),
        catalog: deps.catalog,
        merchantAliases: deps.merchantAliases,
      })
      .catch(() => null);
    if (classified !== null && classified.intent !== "plain") {
      return startClassifiedIntent(classified, input, deps, options, inputKind);
    }
    if (classified !== null) {
      classifiedExpense = classified.expense;
    }
  }

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
  if (interpreted?.cardKeyword !== undefined) {
    const matches = (deps.listActiveCards?.() ?? []).filter(
      (card) =>
        normalizeText(card.name) ===
        normalizeText(interpreted.cardKeyword as string),
    );
    if (matches.length === 1) draft.cardId = matches[0]?.id;
  }
  if (draft.cardId === undefined) {
    draft.accountId =
      (parsed.accountHint ? deps.resolveAccountId() : undefined) ??
      deps.defaultAccountId;
  }

  // Ask the categorization engine for a suggestion (shared engine, both
  // channels). A category hint from the interpreter is free TEXT appended to
  // the context description — never trusted as a category id.
  let proposedCategoryName = interpreted?.proposedCategoryName;
  let categoryCandidates: ConversationState["categoryCandidates"];
  if (interpreted?.unifiedPrimary === true) {
    // A successful unified primary already categorized this message. Do not
    // make a second model call through suggestCategory. Resolve only real ids.
    categoryCandidates = resolveCategoryCandidates(
      interpreted.categoryCandidates ?? [],
      deps.catalog,
    );
    draft.needsAttention = true;
    if (interpreted.proposedSubcategory !== undefined) {
      draft.categoryExplanation = `Subcategoria sugerida (pendente): ${interpreted.proposedSubcategory.categoryName} > ${interpreted.proposedSubcategory.subcategoryName}.`;
    }
  } else {
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
    if (result.requiresConfirmation) draft.needsAttention = true;
    if (
      result.status === "pending_new_category" &&
      result.pendingCategory !== undefined
    ) {
      proposedCategoryName = result.pendingCategory.categoryName;
      draft.categoryExplanation = result.pendingCategory.explanation;
      draft.needsAttention = true;
    }
  }

  const state: ConversationState = {
    status: statusForDraft(draft),
    draft,
    proposedCategoryName,
    categoryCandidates,
  };
  return {
    state,
    reply: replyForState(state, deps),
    keyboard: keyboardForState(state),
  };
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
    if (
      parsed.occurredOn !== undefined &&
      !parsed.uncertainFields.includes("date")
    ) {
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
    case "amountCents":
    case "totalAmount.cents":
    case "totalAmount":
      return "valor inválido";
    case "occurredOn":
      return "data inválida";
    case "installmentCount":
      return "número de parcelas inválido";
    case "billMonth":
      return "mês inválido";
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
      const next: ConversationState = {
        ...state,
        status: statusForDraft(draft),
        draft,
      };
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
    keywordMatch(message, c.description),
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
    const accountId = deps.resolveAccountIdByName?.(accountMatch[1] as string);
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

/**
 * Confirm a card-installment draft: build the plan via the pure domain
 * generator and persist it. Shared by BOTH the typed "confirmar" and the
 * `cf` callback (flow requirement 4) — no separate save path exists.
 */
async function confirmInstallment(
  state: ConversationState,
  deps: ConversationDeps,
  today: string,
  messageText: string,
): Promise<ConversationOutcome> {
  const draft = state.installmentDraft;
  if (
    draft === undefined ||
    draft.totalCents === undefined ||
    draft.installmentCount === undefined ||
    draft.cardId === undefined
  ) {
    // Defensive: the CONFIRM_RE branch in applyInstallmentMessage already
    // guards each missing field individually before reaching here.
    return { state, reply: notUnderstoodMessage() };
  }
  if (deps.createInstallmentPurchase === undefined) {
    return { state, reply: obligationUnavailableMessage() };
  }

  const card = findActiveCard(deps, draft.cardId);
  const built = createInstallmentPlan({
    householdId: deps.householdId,
    creditCardId: draft.cardId,
    description: draft.description,
    totalAmount: { currency: "BRL", cents: draft.totalCents },
    installmentCount: draft.installmentCount,
    purchasedOn: draft.purchasedOn,
    createdByUserId: draft.createdByUserId,
    responsibleUserId: draft.responsibleUserId,
    category:
      draft.categoryId !== undefined
        ? { categoryId: draft.categoryId, subcategoryId: draft.subcategoryId }
        : undefined,
    closingDay: card?.closingDay,
  });
  if (!built.ok) {
    return {
      state,
      reply: `Não consegui salvar: ${describeValidationError(built.errors[0])}.`,
    };
  }

  // The RPC is atomic (nothing persists on a throw), but there is no DB-level
  // idempotency for installment groups — cancel on failure so a blind retry
  // can't double-insert; the user re-sends the purchase.
  try {
    await deps.createInstallmentPurchase(built.value);
  } catch (error) {
    console.warn(
      `[bot] createInstallmentPurchase failed for ${draft.description}:`,
      error,
    );
    return {
      state: { status: "cancelled", draft: state.draft },
      reply: installmentSaveFailedMessage(draft.description),
    };
  }
  await deps.logInteraction({
    fromUserId: draft.createdByUserId,
    inputKind: state.draft.inputKind,
    messageText,
    explanation: draft.categoryExplanation,
  });

  const firstDueMonth =
    built.value.installments[0]?.dueMonth ?? draft.purchasedOn.slice(0, 7);
  return {
    state: { status: "saved", draft: state.draft },
    reply: installmentSavedMessage({
      description: draft.description,
      totalCents: draft.totalCents,
      installmentCount: draft.installmentCount,
      cardName: card?.name ?? "cartão",
      firstDueMonth,
    }),
  };
}

/**
 * Advance an installment confirmation: confirm persists the plan (guarding
 * each missing field with a specific prompt), cancel discards, and
 * valor/parcelas/cartão/categoria/data corrections update the draft in
 * place. Anything else re-shows the summary as help (flow requirement 3).
 */
async function applyInstallmentMessage(
  state: ConversationState,
  message: string,
  deps: ConversationDeps,
  today: string,
): Promise<ConversationOutcome> {
  const draft = state.installmentDraft;
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
    if (draft.totalCents === undefined) {
      return {
        state,
        reply: 'Ainda falta o valor. Informe com "valor 3.600".',
      };
    }
    if (draft.installmentCount === undefined) {
      return {
        state,
        reply: 'Em quantas parcelas? Responda com "parcelas 12".',
      };
    }
    if (draft.cardId === undefined) {
      const cards = deps.listActiveCards?.() ?? [];
      return {
        state,
        reply: "Qual cartão?",
        keyboard: cardGridKeyboard(cards),
      };
    }
    return confirmInstallment(state, deps, today, message);
  }

  const trimmed = message.trim();
  const next: InstallmentDraftInProgress = { ...draft };
  let fieldLabel: string | null = null;

  const valueMatch = /^(valor|preço|preco)\b\s*(.+)$/i.exec(trimmed);
  if (valueMatch !== null) {
    const parsed = parseExpenseText(valueMatch[2] as string, { today });
    if (parsed.amountCents === undefined) {
      return { state, reply: notUnderstoodMessage() };
    }
    next.totalCents = parsed.amountCents;
    fieldLabel = `o valor para R$ ${formatBrl(parsed.amountCents)}`;
  }

  const installmentMatch =
    fieldLabel === null ? /^parcelas?\b\s*(\d{1,3})\s*$/i.exec(trimmed) : null;
  if (installmentMatch !== null) {
    const count = Number.parseInt(installmentMatch[1] as string, 10);
    if (count < 2) {
      return {
        state,
        reply: "O parcelamento precisa de pelo menos 2 parcelas.",
      };
    }
    next.installmentCount = count;
    fieldLabel = `o número de parcelas para ${count}`;
  }

  const cardMatch =
    fieldLabel === null ? /^cart[aã]o\b\s*(.+)$/i.exec(trimmed) : null;
  if (cardMatch !== null) {
    const keyword = (cardMatch[1] as string).trim();
    const cards = deps.listActiveCards?.() ?? [];
    const matches = cards.filter((c) => cardKeywordMatch(keyword, c.name));
    if (matches.length !== 1) {
      return { state, reply: `Não encontrei o cartão "${keyword}".` };
    }
    next.cardId = matches[0]?.id;
    fieldLabel = "o cartão";
  }

  const catMatch =
    fieldLabel === null ? /^(categoria|cat)\b\s*(.+)$/i.exec(trimmed) : null;
  if (catMatch !== null) {
    const name = (catMatch[2] as string).trim().toLowerCase();
    const category = deps.catalog.categories.find(
      (c) => c.name.trim().toLowerCase() === name,
    );
    if (category === undefined) {
      return { state, reply: notUnderstoodMessage() };
    }
    next.categoryId = category.id;
    next.subcategoryId = undefined;
    next.categoryExplanation = "Categoria escolhida manualmente.";
    fieldLabel = "a categoria";
  }

  const dateMatch =
    fieldLabel === null ? /^(data|dia)\b\s*(.+)$/i.exec(trimmed) : null;
  if (dateMatch !== null) {
    const parsed = parseExpenseText(dateMatch[2] as string, { today });
    if (
      parsed.occurredOn === undefined ||
      parsed.uncertainFields.includes("date")
    ) {
      return { state, reply: notUnderstoodMessage() };
    }
    next.purchasedOn = parsed.occurredOn;
    fieldLabel = "a data";
  }

  if (fieldLabel === null) {
    return {
      state,
      reply: installmentConfirmationMessage(
        installmentSummaryView(draft, deps, state.proposedCategoryName),
      ),
    };
  }

  const nextState: ConversationState = {
    status: "awaiting_installment_confirmation",
    draft: state.draft,
    installmentDraft: next,
    proposedCategoryName:
      catMatch !== null ? undefined : state.proposedCategoryName,
  };
  return {
    state: nextState,
    reply: `${correctionAppliedMessage(fieldLabel)}\n\n${installmentConfirmationMessage(installmentSummaryView(next, deps, nextState.proposedCategoryName))}`,
  };
}

/**
 * Confirm a card-bill draft: build the settlement via the pure domain
 * validator and settle it. Shared by BOTH the typed "confirmar" and the `cf`
 * callback (flow requirement 4) — no separate save path exists. Idempotent:
 * an already-paid month is a friendly no-op.
 */
async function confirmCardBill(
  state: ConversationState,
  deps: ConversationDeps,
  today: string,
): Promise<ConversationOutcome> {
  const draft = state.cardBillDraft;
  if (
    draft === undefined ||
    draft.cardId === undefined ||
    draft.amountCents === undefined
  ) {
    // Defensive: the CONFIRM_RE branch in applyCardBillMessage already guards
    // both fields before reaching here (the picker stays open otherwise).
    return { state, reply: notUnderstoodMessage() };
  }
  const card = findActiveCard(deps, draft.cardId);
  const cardName = card?.name ?? "cartão";

  const built = createCardBillSettlement({
    householdId: deps.householdId,
    creditCardId: draft.cardId,
    accountId: draft.accountId,
    billMonth: draft.month,
    amountCents: draft.amountCents,
    paidOn: today,
    createdByUserId: draft.createdByUserId,
  });
  if (!built.ok) {
    return {
      state,
      reply: `Não consegui salvar: ${describeValidationError(built.errors[0])}.`,
    };
  }

  if (deps.settleCardBill === undefined) {
    return {
      state: { status: "cancelled", draft: state.draft },
      reply: obligationUnavailableMessage(),
    };
  }

  let alreadyPaid: boolean;
  try {
    ({ alreadyPaid } = await deps.settleCardBill(built.value));
  } catch (error) {
    console.warn(
      `[bot] settleCardBill failed for ${draft.cardId}/${draft.month}:`,
      error,
    );
    return {
      state: { status: "cancelled", draft: state.draft },
      reply: cardBillSettleFailedMessage(cardName),
    };
  }

  if (alreadyPaid) {
    return {
      state: { status: "saved", draft: state.draft },
      reply: cardBillAlreadyPaidMessage({ cardName, month: draft.month }),
    };
  }

  await deps.logInteraction({
    fromUserId: draft.createdByUserId,
    inputKind: state.draft.inputKind,
    messageText: "confirmar (fatura)",
  });
  return {
    state: { status: "saved", draft: state.draft },
    reply: cardBillPaidMessage({
      cardName,
      amountCents: draft.amountCents,
      month: draft.month,
    }),
  };
}

/**
 * Advance a card-bill confirmation: confirm settles (guarding a still-open
 * picker), cancel discards, valor/conta corrections update the draft in
 * place, and — while the picker is open — a message matching exactly one
 * active card name resolves it (flow requirement 3).
 */
async function applyCardBillMessage(
  state: ConversationState,
  message: string,
  deps: ConversationDeps,
  today: string,
): Promise<ConversationOutcome> {
  const draft = state.cardBillDraft;
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

  // Picker open: try a card-name match before anything else (a bare card
  // name might otherwise look like an unrecognized correction).
  if (draft.cardId === undefined) {
    const cards = deps.listActiveCards?.() ?? [];
    const matches = cards.filter((c) => cardKeywordMatch(message, c.name));
    if (matches.length === 1) {
      return resolveBillCard(
        matches[0]?.id as string,
        draft,
        state.draft,
        deps,
      );
    }
    return {
      state,
      reply: chooseCardBillMessage(),
      keyboard: cardGridKeyboard(cards),
    };
  }

  if (CONFIRM_RE.test(message)) {
    return confirmCardBill(state, deps, today);
  }

  const trimmed = message.trim();
  const card = findActiveCard(deps, draft.cardId);
  const cardName = card?.name ?? "cartão";

  const valueMatch = /^(valor|preço|preco)\b\s*(.+)$/i.exec(trimmed);
  if (valueMatch !== null) {
    const parsed = parseExpenseText(valueMatch[2] as string, { today });
    if (parsed.amountCents === undefined) {
      return { state, reply: notUnderstoodMessage() };
    }
    const next: CardBillDraftInProgress = {
      ...draft,
      overrideAmountCents: parsed.amountCents,
      amountCents: parsed.amountCents,
    };
    return cardBillConfirmationOutcome(
      next,
      parsed.amountCents,
      cardName,
      state.draft,
      deps,
    );
  }

  const accountMatch = /^conta\b\s*(.+)$/i.exec(trimmed);
  if (accountMatch !== null) {
    const accountId = deps.resolveAccountIdByName?.(accountMatch[1] as string);
    if (accountId === undefined) {
      return {
        state,
        reply: `Não encontrei a conta "${(accountMatch[1] as string).trim()}".`,
      };
    }
    const next: CardBillDraftInProgress = { ...draft, accountId };
    return cardBillConfirmationOutcome(
      next,
      draft.amountCents as number,
      cardName,
      state.draft,
      deps,
    );
  }

  return {
    state,
    reply: cardBillConfirmationMessage({
      cardName,
      month: draft.month,
      amountCents: draft.amountCents as number,
      accountLabel: deps.accountNameById?.(draft.accountId) ?? "Conta",
    }),
    keyboard: confirmCancelKeyboard(),
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
  if (state.status === "awaiting_installment_confirmation") {
    return applyInstallmentMessage(state, message, deps, today);
  }
  if (state.status === "awaiting_card_bill_confirmation") {
    return applyCardBillMessage(state, message, deps, today);
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
    ...(correction.field === "category"
      ? { proposedCategoryName: undefined }
      : {}),
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
  if (
    deps.listAllCategories === undefined ||
    deps.createCategory === undefined
  ) {
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

type ConversationDepsInput =
  | ConversationDeps
  | (() => Promise<ConversationDeps>);

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

  // Card-installment confirmation: cf/cx parity with typed confirm/cancel,
  // cd:<uuid> picks the card, cats/ct:/nca/nocat mirror the plain-expense
  // category flow but return to THIS summary (never persisting on their own).
  if (state.status === "awaiting_installment_confirmation") {
    const draft = state.installmentDraft;
    if (draft === undefined) {
      return expiredOutcome(state);
    }
    if (token === TOKENS.confirm) {
      const depsValue = await getDeps();
      const outcome = await confirmInstallment(
        state,
        depsValue,
        today,
        "confirmar (botão)",
      );
      return outcome;
    }
    if (token === TOKENS.cancel) {
      return {
        state: { status: "cancelled", draft: state.draft },
        reply: cancelledMessage(),
      };
    }
    if (token.startsWith(CARD_TOKEN_PREFIX)) {
      const depsValue = await getDeps();
      const cardId = token.slice(CARD_TOKEN_PREFIX.length);
      const card = findActiveCard(depsValue, cardId);
      if (card === undefined) {
        return expiredOutcome(state);
      }
      const next: InstallmentDraftInProgress = { ...draft, cardId };
      const nextState: ConversationState = { ...state, installmentDraft: next };
      return {
        state: nextState,
        reply: installmentConfirmationMessage(
          installmentSummaryView(next, depsValue, state.proposedCategoryName),
        ),
        keyboard:
          state.proposedCategoryName !== undefined
            ? installmentConfirmationKeyboard(state.proposedCategoryName)
            : installmentConfirmationKeyboard(),
      };
    }
    if (token === TOKENS.categories) {
      const depsValue = await getDeps();
      return {
        state,
        reply: chooseCategoryMessage(),
        keyboard: categoryGridKeyboard(depsValue.catalog.categories, false),
      };
    }
    if (token.startsWith(CATEGORY_SUGGESTION_TOKEN_PREFIX)) {
      const depsValue = await getDeps();
      const index = Number(
        token.slice(CATEGORY_SUGGESTION_TOKEN_PREFIX.length),
      );
      const candidate = state.categoryCandidates?.[index];
      if (!candidate) return expiredOutcome(state);
      const validParent = depsValue.catalog.subcategories.find(
        (subcategory) =>
          subcategory.id === candidate.subcategoryId &&
          subcategory.categoryId === candidate.categoryId,
      );
      if (candidate.subcategoryId && !validParent) return expiredOutcome(state);
      const next = {
        ...draft,
        categoryId: candidate.categoryId,
        subcategoryId: candidate.subcategoryId,
        categoryExplanation: candidate.explanation,
      };
      const nextState = {
        ...state,
        installmentDraft: next,
        categoryCandidates: undefined,
        proposedCategoryName: undefined,
      };
      return {
        state: nextState,
        reply: installmentConfirmationMessage(
          installmentSummaryView(next, depsValue),
        ),
        keyboard: installmentConfirmationKeyboard(),
      };
    }
    if (token.startsWith(CATEGORY_TOKEN_PREFIX)) {
      const depsValue = await getDeps();
      const categoryId = token.slice(CATEGORY_TOKEN_PREFIX.length);
      const category = depsValue.catalog.categories.find(
        (c) => c.id === categoryId,
      );
      if (category === undefined) {
        return {
          state,
          reply: "",
          silent: true,
          toast: CATEGORY_NOT_FOUND_TOAST,
        };
      }
      const next: InstallmentDraftInProgress = {
        ...draft,
        categoryId: category.id,
        subcategoryId: undefined,
        categoryExplanation: "Categoria escolhida manualmente.",
      };
      const nextState: ConversationState = {
        ...state,
        installmentDraft: next,
        proposedCategoryName: undefined,
      };
      return {
        state: nextState,
        reply: `${correctionAppliedMessage("a categoria")}\n\n${installmentConfirmationMessage(installmentSummaryView(next, depsValue))}`,
        keyboard: installmentConfirmationKeyboard(),
      };
    }
    if (token === TOKENS.acceptProposal) {
      if (state.proposedCategoryName === undefined) {
        return expiredOutcome(state);
      }
      const depsValue = await getDeps();
      const resolved = await createOrReuseCategory(
        state.proposedCategoryName,
        depsValue,
      );
      if (resolved === null) {
        return { state, reply: notUnderstoodMessage() };
      }
      const next: InstallmentDraftInProgress = {
        ...draft,
        categoryId: resolved.categoryId,
        subcategoryId: undefined,
        categoryExplanation: "Categoria criada pelo usuário.",
      };
      const nextState: ConversationState = {
        ...state,
        installmentDraft: next,
        proposedCategoryName: undefined,
      };
      return {
        state: nextState,
        reply: installmentConfirmationMessage(
          installmentSummaryView(next, depsValue),
        ),
        keyboard: installmentConfirmationKeyboard(),
      };
    }
    if (token === TOKENS.dropProposal) {
      if (state.proposedCategoryName === undefined) {
        return expiredOutcome(state);
      }
      const depsValue = await getDeps();
      const nextState: ConversationState = {
        ...state,
        proposedCategoryName: undefined,
      };
      return {
        state: nextState,
        reply: installmentConfirmationMessage(
          installmentSummaryView(draft, depsValue),
        ),
        keyboard: installmentConfirmationKeyboard(),
      };
    }
    return expiredOutcome(state);
  }

  // Card-bill confirmation: cf/cx parity with typed confirmar/cancelar,
  // cd:<uuid> resolves the card while the picker is open (flow requirement 4).
  if (state.status === "awaiting_card_bill_confirmation") {
    const draft = state.cardBillDraft;
    if (draft === undefined) {
      return expiredOutcome(state);
    }
    if (token === TOKENS.confirm) {
      const depsValue = await getDeps();
      return confirmCardBill(state, depsValue, today);
    }
    if (token === TOKENS.cancel) {
      return {
        state: { status: "cancelled", draft: state.draft },
        reply: cancelledMessage(),
      };
    }
    if (draft.cardId === undefined && token.startsWith(CARD_TOKEN_PREFIX)) {
      const depsValue = await getDeps();
      const cardId = token.slice(CARD_TOKEN_PREFIX.length);
      const card = findActiveCard(depsValue, cardId);
      if (card === undefined) {
        return expiredOutcome(state);
      }
      return resolveBillCard(cardId, draft, state.draft, depsValue);
    }
    return expiredOutcome(state);
  }

  // Obligation confirmation carries a Confirmar/Cancelar keyboard: route the tap
  // through the same text handler so a button does exactly what typing the word
  // does (validate + createObligation, or cancel). Corrections stay typed-only.
  if (state.status === "awaiting_obligation_confirmation") {
    if (token === TOKENS.confirm || token === TOKENS.cancel) {
      const word =
        token === TOKENS.confirm ? "confirmar (botão)" : "cancelar (botão)";
      const outcome = await applyObligationMessage(
        state,
        word,
        await getDeps(),
        today,
      );
      return { ...outcome, keyboard: keyboardForState(outcome.state) };
    }
    return expiredOutcome(state);
  }

  // Mark-paid choice is a candidate list, not a confirm — no keyboard yet, so
  // any token landing there is stale.
  if (state.status === "awaiting_mark_paid_choice") {
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
    const outcome = await confirmDraft(
      state,
      depsValue,
      "confirmar (botão)",
      today,
    );
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
  if (token.startsWith(CATEGORY_SUGGESTION_TOKEN_PREFIX)) {
    const depsValue = await getDeps();
    const index = Number(token.slice(CATEGORY_SUGGESTION_TOKEN_PREFIX.length));
    const candidate = state.categoryCandidates?.[index];
    if (!candidate) return expiredOutcome(state);
    const category = depsValue.catalog.categories.find(
      (item) => item.id === candidate.categoryId,
    );
    const subcategory = candidate.subcategoryId
      ? depsValue.catalog.subcategories.find(
          (item) =>
            item.id === candidate.subcategoryId &&
            item.categoryId === candidate.categoryId,
        )
      : undefined;
    if (!category || (candidate.subcategoryId && !subcategory)) {
      return expiredOutcome(state);
    }
    const draft = {
      ...state.draft,
      categoryId: candidate.categoryId,
      subcategoryId: candidate.subcategoryId,
      categoryNameFallback: candidate.categoryName,
      categoryExplanation: candidate.explanation,
    };
    return summaryOutcome(
      {
        ...state,
        status: statusForDraft(draft),
        draft,
        categoryCandidates: undefined,
        proposedCategoryName: undefined,
      },
      depsValue,
      correctionAppliedMessage("a categoria"),
    );
  }
  if (token.startsWith(CATEGORY_TOKEN_PREFIX)) {
    const depsValue = await getDeps();
    const categoryId = token.slice(CATEGORY_TOKEN_PREFIX.length);
    const category = depsValue.catalog.categories.find(
      (c) => c.id === categoryId,
    );
    if (category === undefined) {
      return {
        state,
        reply: "",
        silent: true,
        toast: CATEGORY_NOT_FOUND_TOAST,
      };
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
      categoryCandidates: undefined,
    };
    return summaryOutcome(
      next,
      depsValue,
      correctionAppliedMessage("a categoria"),
    );
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
    const draft: DraftInProgress = {
      ...state.draft,
      responsibleUserId: undefined,
    };
    const next: ConversationState = {
      ...state,
      status: statusForDraft(draft),
      draft,
    };
    return summaryOutcome(
      next,
      depsValue,
      correctionAppliedMessage("o responsável"),
    );
  }
  if (token.startsWith(RESPONSIBLE_TOKEN_PREFIX)) {
    const depsValue = await getDeps();
    const userId = token.slice(RESPONSIBLE_TOKEN_PREFIX.length);
    const member = depsValue
      .listActiveMembers?.()
      .find((m) => m.userId === userId);
    if (member === undefined) {
      return expiredOutcome(state);
    }
    const draft: DraftInProgress = {
      ...state.draft,
      responsibleUserId: userId,
    };
    const next: ConversationState = {
      ...state,
      status: statusForDraft(draft),
      draft,
    };
    return summaryOutcome(
      next,
      depsValue,
      correctionAppliedMessage("o responsável"),
    );
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
    const next: ConversationState = {
      ...state,
      proposedCategoryName: undefined,
    };
    return summaryOutcome(next, depsValue);
  }

  if (token === TOKENS.newCategory) {
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

  // Any future/unknown token — answer-and-ignore.
  return expiredOutcome(state);
}
