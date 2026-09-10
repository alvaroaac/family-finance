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
import { randomUUID } from "node:crypto";

import { parseExpenseText, stripEdgePunctuation } from "./parser.js";
import {
  applyDeterministicPrecedence,
  detectFinancialRoute,
  isCompleteAuthoritativeInstrumentMetadataTail,
  registeredNormalFaturaTargetMatch,
  splitAuthoritativeInstrumentNameAndMetadata,
} from "./financial-routing.js";
import type { RoutedInterpretedIntent } from "./financial-routing.js";
import type {
  InterpretedExpense,
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
  AI_UNAVAILABLE_NOTICE,
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
  PAYMENT_ACCOUNT_TOKEN_PREFIX,
  PAYMENT_CARD_TOKEN_PREFIX,
  RESPONSIBLE_TOKEN_PREFIX,
  confirmationKeyboard,
  installmentConfirmationKeyboard,
  installmentReconciliationKeyboard,
  categoryGridKeyboard,
  cardGridKeyboard,
  paymentInstrumentKeyboard,
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
  /** Confirmation started durably; edits/cancel are no longer safe. */
  | "installment_submission_started"
  /** A prior write may have committed; only same-key reconciliation is safe. */
  | "installment_outcome_uncertain"
  /** Legacy pending installment without a durable identity; never writable. */
  | "installment_recovery_required"
  /** A card-bill payment draft awaits its "confirmar" (PR-2, "nubank pago"). */
  | "awaiting_card_bill_confirmation"
  /** A mark-paid keyword matched 2+ obligations; the user must pick one. */
  | "awaiting_mark_paid_choice"
  /** A provider name matched both an account and a card. */
  | "awaiting_payment_choice"
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
  /** Stable across confirmation retries; enforced by the database write. */
  idempotencyKey: string;
  description: string;
  /** Total purchase amount in cents; undefined until "valor X" fills it. */
  totalCents?: number;
  installmentCount?: number;
  /** ISO date (YYYY-MM-DD) of the original purchase. */
  purchasedOn: string;
  cardId?: string;
  /** Closing-day snapshot used to rebuild the same plan on every retry. */
  cardClosingDay?: number;
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
  /** Explicit payment occurrence date; defaults to confirmation day. */
  paidOn?: string;
  createdByUserId: string;
};

/** One obligation candidate stored while a mark-paid keyword is ambiguous. */
export type MarkPaidCandidate = {
  id: string;
  description: string;
  amountCents: number;
};

export type PaymentInstrumentCandidate = {
  type: "account" | "card";
  id: string;
  name: string;
};

export type PendingSubcategoryProposal = {
  categoryId: string;
  categoryName: string;
  subcategoryName: string;
  explanation: string;
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
  /** Actual amount supplied with an ambiguous obligation payment. */
  markPaidAmountCents?: number;
  /** Explicit settlement account resolved before an ambiguous obligation choice. */
  markPaidAccountId?: string;
  /** Explicit payment occurrence date carried through an obligation picker. */
  markPaidPaidOn?: string;
  /** Valid callback choices while status = awaiting_payment_choice. */
  paymentCandidates?: PaymentInstrumentCandidate[];
  /** AI-proposed NEW category name (spec §3) — never placed in callback data. */
  proposedCategoryName?: string;
  /** AI-proposed NEW subcategory under an existing macro category. */
  proposedSubcategory?: PendingSubcategoryProposal;
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
   * `paidOn` is the explicit occurrence date, or the message date by default;
   * idempotent per (obligation, month).
   */
  materializeObligationPayment?: (args: {
    obligationId: string;
    month: string;
    paidOn: string;
    amountCents?: number;
    accountId?: string;
  }) => Promise<{ alreadyPaid: boolean }>;
  /** Map a spoken account name ("conta Nubank") to an account id. */
  resolveAccountIdByName?: (name: string) => string | undefined;
  /** Display name of an account id, for the confirmation summary. */
  accountNameById?: (accountId: string) => string | undefined;
  /** Active accounts available to resolve provider names in plain expenses. */
  listActiveAccounts?: () => Array<{ id: string; name: string }>;
  /** Display name of a card id, for the confirmation summary. */
  cardNameById?: (cardId: string) => string | undefined;
  /** ALL categories (active + archived) for create-dedupe (bot category creation). */
  listAllCategories?: () => Promise<
    Array<{ id: string; name: string; isActive: boolean }>
  >;
  /** Create an ACTIVE category (db createCategory); impl must also expose it in `catalog`. */
  createCategory?: (name: string) => Promise<{ id: string }>;
  /** Reactivate an archived category (db restoreCategory). */
  restoreCategory?: (categoryId: string, categoryName: string) => Promise<void>;
  /** ALL subcategories (active + archived) for subcategory proposal dedupe. */
  listAllSubcategories?: () => Promise<
    Array<{
      id: string;
      categoryId: string;
      name: string;
      isActive: boolean;
    }>
  >;
  /** Create an ACTIVE subcategory under a macro category. */
  createSubcategory?: (
    categoryId: string,
    name: string,
  ) => Promise<{ id: string }>;
  /** Reactivate an archived subcategory. */
  restoreSubcategory?: (
    subcategoryId: string,
    categoryId: string,
    subcategoryName: string,
  ) => Promise<void>;
  /** Seed categorization_memory — ONLY the AI new-category accept path calls this. */
  seedCategorizationMemory?: (entry: {
    pattern: string;
    categoryId: string;
    subcategoryId?: string;
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
    idempotencyKey: string,
  ) => Promise<{
    groupId: string;
    creditCardId: string;
    description: string;
    totalCents: number;
    installmentCount: number;
    firstDueMonth: string;
  }>;
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

function taxonomyProposalLabel(
  state: Pick<
    ConversationState,
    "proposedCategoryName" | "proposedSubcategory"
  >,
): string | undefined {
  if (state.proposedCategoryName !== undefined) {
    return state.proposedCategoryName;
  }
  if (state.proposedSubcategory !== undefined) {
    return `${state.proposedSubcategory.categoryName} > ${state.proposedSubcategory.subcategoryName}`;
  }
  return undefined;
}

function pendingSubcategoryFromNames(
  catalog: CategoryCatalog,
  categoryName: string | undefined,
  subcategoryName: string | null | undefined,
  explanation: string,
  categoryId?: string,
): PendingSubcategoryProposal | undefined {
  if (categoryName === undefined || subcategoryName == null) {
    return undefined;
  }
  const category =
    categoryId !== undefined
      ? catalog.categories.find((item) => item.id === categoryId)
      : catalog.categories.find(
          (item) => normalizeText(item.name) === normalizeText(categoryName),
        );
  if (category === undefined) {
    return undefined;
  }
  return {
    categoryId: category.id,
    categoryName: category.name,
    subcategoryName,
    explanation,
  };
}

function paymentLabel(draft: DraftInProgress, deps: ConversationDeps): string {
  if (draft.cardId !== undefined) {
    return `Crédito ${deps.cardNameById?.(draft.cardId) ?? "Cartão"}`;
  }
  return `Conta ${deps.accountNameById?.(draft.accountId ?? "") ?? ""}`.trim();
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
    paymentLabel: paymentLabel(draft, deps),
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
    summaryView(state.draft, deps, taxonomyProposalLabel(state)),
  );
}

/** The keyboard each state's prompt carries (undefined = no buttons). */
function keyboardForState(
  state: ConversationState,
): InlineKeyboardMarkup | undefined {
  if (state.status === "awaiting_confirmation") {
    return confirmationKeyboard(
      taxonomyProposalLabel(state),
      state.categoryCandidates ?? [],
    );
  }
  if (state.status === "awaiting_category_name") {
    return cancelOnlyKeyboard();
  }
  if (state.status === "awaiting_payment_choice") {
    return paymentInstrumentKeyboard(state.paymentCandidates ?? []);
  }
  if (state.status === "awaiting_obligation_confirmation") {
    return obligationConfirmationKeyboard(
      taxonomyProposalLabel(state),
      state.categoryCandidates ?? [],
    );
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

function trimAuthoritativeInstrumentName(value: string): string {
  return value
    .trim()
    .replace(/[.,;:!?]+$/u, "")
    .trim();
}

function textNamesInstrument(text: string, name: string): boolean {
  const haystack = ` ${normalizeText(text).replace(/[^a-z0-9]+/g, " ")} `;
  const needle = ` ${normalizeText(name).replace(/[^a-z0-9]+/g, " ")} `;
  return needle.trim().length > 0 && haystack.includes(needle);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripSelectedInstrumentFromDescription(
  description: string,
  instrumentName: string | undefined,
): string {
  const name = instrumentName?.trim();
  if (name === undefined || name.length === 0) {
    return description;
  }
  const stripped = stripEdgePunctuation(
    description
      .replace(new RegExp(`(^|\\s)${escapeRegExp(name)}(?=\\s|$)`, "i"), " ")
      .replace(/\s+/g, " ")
      .trim(),
  );
  return stripped.length > 0 ? stripped : description;
}

function isTemporalInstrumentCandidate(
  text: string,
  instrumentName: string,
  type: "account" | "card",
): boolean {
  const normalizedName = normalizeText(instrumentName);
  if (!/^(?:hoje|ontem|anteontem|dia)$/.test(normalizedName)) return false;
  const normalized = normalizeText(text);
  const escapedName = escapeRegExp(normalizedName);
  const explicitEscape =
    type === "card"
      ? new RegExp(
          `\\bcartao(?:\\s+de\\s+credito)?\\s+(?:chamado|de\\s+nome)\\s+${escapedName}(?=$|[^a-z0-9])`,
        ).test(normalized)
      : new RegExp(
          `\\b(?:conta|(?:pela?|com(?:\\s+a)?|usando(?:\\s+a)?|na|da|de)\\s+(?:a\\s+)?conta)\\s+(?:chamada?|de\\s+nome)\\s+${escapedName}(?=$|[^a-z0-9])`,
        ).test(normalized);
  if (explicitEscape) return false;
  if (
    normalizedName !== "dia" &&
    new RegExp(`^\\s*${escapeRegExp(normalizedName)}(?=$|[\\s,.;:!?-])`).test(
      normalized,
    )
  ) {
    return true;
  }
  const instrument =
    type === "card"
      ? String.raw`(?:cartao(?:\s+de\s+credito)?|credito)`
      : String.raw`(?:conta|debito|dinheiro|pix|boleto)`;
  const tail =
    normalizedName === "dia"
      ? String.raw`\s+\d{1,2}(?:\/\d{1,2}(?:\/\d{2,4})?)?`
      : String.raw`(?=$|[\s,.;:!?-])`;
  return new RegExp(
    String.raw`\b${instrument}\s+${escapeRegExp(normalizedName)}${tail}`,
  ).test(normalized);
}

function isStructuralCardCandidate(text: string, cardName: string): boolean {
  const normalizedName = normalizeText(cardName);
  const normalized = normalizeText(text);
  const escapedName = escapeRegExp(normalizedName);
  const explicitlyNamed = new RegExp(
    `\\bcartao(?:\\s+de\\s+credito)?\\s+(?:chamado|de\\s+nome)\\s+${escapedName}(?=$|[^a-z0-9])`,
  ).test(normalized);
  if (explicitlyNamed) return false;
  if (/^(?:cartao|credito)$/.test(normalizedName)) return true;
  if (
    /^(?:uma|um|duas|dois|tres|quatro|cinco|seis|sete|oito|nove|dez|onze|doze)$/.test(
      normalizedName,
    ) &&
    new RegExp(
      `\\b(?:cartao(?:\\s+de\\s+credito)?|credito)\\s+${escapedName}(?=$|[^a-z0-9])`,
    ).test(normalized)
  ) {
    return true;
  }
  if (
    /^(?:parcelado|parcelada|parcelei|parcelas?|prestacoes?)$/.test(
      normalizedName,
    )
  ) {
    return true;
  }
  if (normalizedName === "juros")
    return /\b(?:com|sem)\s+juros\b/.test(normalized);
  if (normalizedName === "unica") {
    return /\b(?:parcela|prestacao)\s+unica\b/.test(normalized);
  }
  if (normalizedName === "vez") return /\buma\s+vez\b/.test(normalized);
  return false;
}

function paymentCandidatesForText(
  text: string,
  deps: ConversationDeps,
): PaymentInstrumentCandidate[] {
  const accounts = (deps.listActiveAccounts?.() ?? []).map((item) => ({
    type: "account" as const,
    ...item,
  }));
  const cards = (deps.listActiveCards?.() ?? []).map((item) => ({
    type: "card" as const,
    id: item.id,
    name: item.name,
  }));
  const authoritativeAccountName = explicitAuthoritativeInstrumentFromText(
    text,
    "account",
    accounts,
  );
  const authoritativeCardName = explicitAuthoritativeInstrumentFromText(
    text,
    "card",
    cards,
  );
  if (
    authoritativeAccountName !== undefined ||
    authoritativeCardName !== undefined
  ) {
    return [...accounts, ...cards].filter((item) => {
      const authoritativeName =
        item.type === "account"
          ? authoritativeAccountName
          : authoritativeCardName;
      return (
        authoritativeName !== undefined &&
        normalizeText(item.name) === normalizeText(authoritativeName)
      );
    });
  }
  const normalized = normalizeText(text);
  const explicitlyEscaped = [...accounts, ...cards].filter((item) => {
    const name = escapeRegExp(normalizeText(item.name));
    const introducer =
      item.type === "card"
        ? String.raw`cartao(?:\s+de\s+credito)?`
        : String.raw`(?:conta|(?:pela?|com(?:\s+a)?|usando(?:\s+a)?|na|da|de)\s+(?:a\s+)?conta)`;
    return new RegExp(
      String.raw`\b${introducer}\s+(?:chamad[ao]|de\s+nome)\s+${name}(?=$|[^a-z0-9])`,
    ).test(normalized);
  });
  if (explicitlyEscaped.length > 0) {
    const longestLength = Math.max(
      ...explicitlyEscaped.map((item) => normalizeText(item.name).length),
    );
    return explicitlyEscaped.filter(
      (item) => normalizeText(item.name).length === longestLength,
    );
  }
  const pixIsExplicitAccount = /\bconta\s+pix\b/.test(normalized);
  const pixIsPaymentMethod =
    /\b(?:via|no|pelo|pela|com|usando|por)\s+(?:o\s+|a\s+)?pix\b/.test(
      normalized,
    );
  const explicitlyNamedSourceAccounts = accounts.filter((account) => {
    if (isTemporalInstrumentCandidate(text, account.name, "account")) {
      return false;
    }
    const escaped = normalizeText(account.name)
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length > 0)
      .map(escapeRegExp)
      .join("\\s+");
    if (escaped.length === 0) return false;
    return new RegExp(
      `\\b(?:pela?|com(?:\\s+a)?|usando(?:\\s+a)?|na|da|de)\\s+conta\\s+(?:(?:chamada?|de\\s+nome)\\s+)?${escaped}(?=$|[^a-z0-9])`,
    ).test(normalized);
  });
  if (pixIsPaymentMethod && !pixIsExplicitAccount) {
    return explicitlyNamedSourceAccounts;
  }
  const named = [...accounts, ...cards].filter((item) => {
    if (isTemporalInstrumentCandidate(text, item.name, item.type)) return false;
    if (item.type === "card" && isStructuralCardCandidate(text, item.name)) {
      return false;
    }
    if (!textNamesInstrument(text, item.name)) return false;
    return !(
      item.type === "account" &&
      normalizeText(item.name) === "pix" &&
      pixIsPaymentMethod &&
      !pixIsExplicitAccount
    );
  });
  const explicitlyCard = /\b(cartao|credito|fatura)\b/.test(normalized);
  const explicitlyAccount =
    /\b(conta|debito|pix|dinheiro|corrente|boleto)\b/.test(normalized);
  if (explicitlyCard && !explicitlyAccount)
    return named.filter((item) => item.type === "card");
  if (explicitlyAccount && !explicitlyCard)
    return named.filter((item) => item.type === "account");
  return named;
}

type AuthoritativeInstrumentMatch = {
  keyword: string;
  index: number;
  length: number;
  registered: boolean;
};

function matchingRawPrefixLength(
  value: string,
  normalizedPrefix: string,
): number | undefined {
  for (let length = 1; length <= value.length; length += 1) {
    if (normalizeText(value.slice(0, length)) === normalizedPrefix) {
      return length;
    }
  }
  return undefined;
}

function explicitAuthoritativeInstrumentMatchFromText(
  text: string,
  type: "account" | "card",
  instruments?: ReadonlyArray<{ name: string }>,
): AuthoritativeInstrumentMatch | undefined {
  const escapedIntroducer =
    type === "account"
      ? String.raw`(?:conta|(?:pela?|com|usando|na|da|de)\s+(?:a\s+)?conta)`
      : String.raw`(?:no|na|pelo|pela|com|usando)?\s*(?:o\s+|a\s+)?cart[aã]o(?:\s+de\s+cr[eé]dito)?`;
  const broadMatch = new RegExp(
    String.raw`\b${escapedIntroducer}\s+(?:chamad[ao]|de\s+nome)\s+(.+)$`,
    "iu",
  ).exec(text);
  if (broadMatch !== null) {
    const broadCaptured = broadMatch[1] as string;
    const registeredPrefixes = (instruments ?? [])
      .map((instrument) => {
        const length = matchingRawPrefixLength(
          broadCaptured,
          normalizeText(instrument.name),
        );
        if (length === undefined) return undefined;
        const remainder = broadCaptured.slice(length);
        if (!isCompleteAuthoritativeInstrumentMetadataTail(remainder))
          return undefined;
        return { instrument, length };
      })
      .filter(
        (
          candidate,
        ): candidate is { instrument: { name: string }; length: number } =>
          candidate !== undefined,
      )
      .sort((left, right) => right.length - left.length);
    const registeredPrefix = registeredPrefixes[0];
    if (registeredPrefix !== undefined) {
      const rawCaptureOffset = broadMatch[0].indexOf(broadCaptured);
      return {
        keyword: broadCaptured.slice(0, registeredPrefix.length),
        index: broadMatch.index + Math.max(0, rawCaptureOffset),
        length: registeredPrefix.length,
        registered: true,
      };
    }
  }
  const escapedMatch = new RegExp(
    String.raw`\b${escapedIntroducer}\s+(?:chamad[ao]|de\s+nome)\s+(.+)$`,
    "iu",
  ).exec(text);
  const rawCaptured = escapedMatch?.[1];
  const captured =
    rawCaptured === undefined
      ? undefined
      : splitAuthoritativeInstrumentNameAndMetadata(rawCaptured).name;
  const exactRegisteredName = (instruments ?? []).some(
    (instrument) =>
      normalizeText(instrument.name) === normalizeText(captured ?? ""),
  );
  const escapedKeyword =
    captured === undefined
      ? undefined
      : exactRegisteredName
        ? captured
        : trimAuthoritativeInstrumentName(captured);
  if (escapedKeyword !== undefined && escapedKeyword.length > 0) {
    const rawCaptureOffset = escapedMatch?.[0].indexOf(rawCaptured ?? "") ?? -1;
    const leadingWhitespace = rawCaptured?.indexOf(captured ?? "") ?? -1;
    return {
      keyword: escapedKeyword,
      index:
        (escapedMatch?.index ?? 0) +
        Math.max(0, rawCaptureOffset) +
        Math.max(0, leadingWhitespace),
      length: captured?.length ?? escapedKeyword.length,
      registered: exactRegisteredName,
    };
  }
  return undefined;
}

function explicitAuthoritativeInstrumentFromText(
  text: string,
  type: "account" | "card",
  instruments?: ReadonlyArray<{ name: string }>,
): string | undefined {
  return explicitAuthoritativeInstrumentMatchFromText(text, type, instruments)
    ?.keyword;
}

/**
 * Keep registered instrument metadata out of the payment-date grammar. Only
 * the authoritative capture is blanked, rather than every matching word, so
 * `conta chamada Ontem ontem` still exposes the second `ontem` as the actual
 * occurrence date.
 */
function maskAuthoritativeRegisteredInstrumentNames(
  text: string,
  deps: ConversationDeps,
): string {
  const normalFaturaCardMatch = registeredNormalFaturaTargetMatch(
    text,
    deps.listActiveCards?.() ?? [],
  );
  const matches = [
    explicitAuthoritativeInstrumentMatchFromText(
      text,
      "account",
      deps.listActiveAccounts?.() ?? [],
    ),
    explicitAuthoritativeInstrumentMatchFromText(
      text,
      "card",
      deps.listActiveCards?.() ?? [],
    ),
    normalFaturaCardMatch === undefined
      ? undefined
      : { ...normalFaturaCardMatch, registered: true },
  ]
    .filter(
      (match): match is AuthoritativeInstrumentMatch =>
        match !== undefined && match.registered,
    )
    .sort((left, right) => right.index - left.index);

  let masked = text;
  for (const match of matches) {
    masked = `${masked.slice(0, match.index)}${" ".repeat(match.length)}${masked.slice(match.index + match.length)}`;
  }
  return masked;
}

function explicitNamedInstrumentFromText(
  text: string,
  type: "account" | "card",
  instruments?: ReadonlyArray<{ name: string }>,
): string | undefined {
  const authoritativeKeyword = explicitAuthoritativeInstrumentFromText(
    text,
    type,
    instruments,
  );
  if (authoritativeKeyword !== undefined) return authoritativeKeyword;
  const introducer =
    type === "account"
      ? String.raw`(?:pela?|com|usando|na|da|de)\s+(?:a\s+)?conta`
      : String.raw`(?:no|na|pelo|pela|com|usando)\s+(?:o\s+|a\s+)?cart[aã]o`;
  const match = new RegExp(
    String.raw`\b${introducer}\s+(.+?)(?=\s+(?:(?:por|no\s+valor\s+de|valor\s+de)\s+)?(?:r\$\s*)?\d|\s+(?:hoje|ontem|anteontem)\b|[.,;!?]|$)`,
    "iu",
  ).exec(text);
  const keyword = match?.[1]?.trim();
  if (keyword === undefined || keyword.length === 0) return undefined;
  const normalized = normalizeText(keyword);
  if (
    type === "card" &&
    (normalized === "credito" || normalized === "de credito")
  ) {
    return undefined;
  }
  return keyword;
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

function applyTopCategoryCandidate(
  draft: {
    categoryId?: string;
    subcategoryId?: string;
    categoryExplanation?: string;
  },
  candidates: ConversationState["categoryCandidates"],
): void {
  const top = candidates?.[0];
  if (top === undefined) {
    return;
  }
  draft.categoryId = top.categoryId;
  draft.subcategoryId = top.subcategoryId;
  draft.categoryExplanation = top.explanation;
}

function pendingSubcategoryFromInterpreter(
  catalog: CategoryCatalog,
  proposal: InterpretedExpense["proposedSubcategory"],
  explanation: string,
): PendingSubcategoryProposal | undefined {
  return pendingSubcategoryFromNames(
    catalog,
    proposal?.categoryName,
    proposal?.subcategoryName,
    explanation,
  );
}

/** Searchable tokens of a keyword/description (normalized, short words out). */
function matchTokens(value: string): string[] {
  return normalizeText(value)
    .split(/\s+/)
    .filter((token) => token.length >= 3);
}

const GENERIC_OBLIGATION_MATCH_TOKENS = new Set([
  "a",
  "ao",
  "aos",
  "as",
  "aquela",
  "aquele",
  "aquelas",
  "aqueles",
  "com",
  "conta",
  "contas",
  "consorcio",
  "consorcios",
  "das",
  "da",
  "de",
  "do",
  "dos",
  "em",
  "emprestimo",
  "emprestimos",
  "essa",
  "essas",
  "esse",
  "esses",
  "esta",
  "estas",
  "este",
  "estes",
  "financiamento",
  "financiamentos",
  "meu",
  "meus",
  "minha",
  "minhas",
  "na",
  "nas",
  "no",
  "nos",
  "nossa",
  "nossas",
  "nosso",
  "nossos",
  "obrigacao",
  "obrigacoes",
  "o",
  "os",
  "pagamento",
  "pagamentos",
  "paga",
  "pago",
  "paguei",
  "parcela",
  "parcelas",
  "para",
  "pela",
  "pelas",
  "pelo",
  "pelos",
  "por",
  "prestacao",
  "prestacoes",
  "quitada",
  "quitado",
  "sem",
  "seu",
  "seus",
  "sua",
  "suas",
  "uma",
  "umas",
  "uns",
]);

function obligationMatchTokens(value: string): string[] {
  return matchTokens(value).filter(
    (token) => !GENERIC_OBLIGATION_MATCH_TOKENS.has(token),
  );
}

type ObligationTargetType =
  | "financing"
  | "insurance"
  | "rent"
  | "loan"
  | "consortium"
  | "solar_installment";

function explicitObligationTargetType(
  value: string,
): ObligationTargetType | undefined {
  const normalized = normalizeText(value);
  if (/\bparcela\s+solar\b/.test(normalized)) return "solar_installment";
  const tokens = new Set(matchTokens(value));
  if (tokens.has("financiamento") || tokens.has("financiamentos"))
    return "financing";
  if (tokens.has("seguro") || tokens.has("seguros")) return "insurance";
  if (tokens.has("aluguel") || tokens.has("alugueis")) return "rent";
  if (tokens.has("emprestimo") || tokens.has("emprestimos")) return "loan";
  if (tokens.has("consorcio") || tokens.has("consorcios")) return "consortium";
  return undefined;
}

function hasCompatibleObligationType(keyword: string, name: string): boolean {
  const keywordType = explicitObligationTargetType(keyword);
  if (keywordType === undefined) return true;
  if (normalizeText(keyword) === normalizeText(name)) return true;
  return explicitObligationTargetType(name) === keywordType;
}

/**
 * Obligation matching requires every discriminating query token to be covered by
 * the stored target. Generic
 * finance words cannot authorize a payment by themselves: "financiamento do
 * carro" must not settle the only stored "Financiamento da casa" merely because
 * both contain "financiamento". Wording variants such as "placa solar" and
 * "Parcela solar" still meet on the meaningful token "solar".
 */
function keywordMatch(keyword: string, name: string): boolean {
  if (!hasCompatibleObligationType(keyword, name)) return false;
  const keywordTokens = obligationMatchTokens(keyword);
  const nameTokens = obligationMatchTokens(name);
  if (keywordTokens.length === 0 || nameTokens.length === 0) {
    return false;
  }
  // Historical wording calls the solar obligation both "placa solar" and
  // "Parcela solar". Once "solar" is present, "placa" is not an independent
  // qualifier; unlike "seguro" in "seguro do carro", it may be omitted safely.
  const requiredKeywordTokens = keywordTokens.filter(
    (token) => !(token === "placa" && keywordTokens.includes("solar")),
  );
  return requiredKeywordTokens.every((token) => nameTokens.includes(token));
}

/** Typed picker abbreviations supported as explicit, stable identifiers. */
const MARK_PAID_CHOICE_SHORT_IDENTIFIERS = new Set(["sp", "rj"]);

/**
 * Resolve a typed reply against an already-presented obligation choice.
 * Full displayed descriptions are explicit selections. The only supported
 * partial replies are the stable regional identifiers SP and RJ.
 */

function markPaidChoiceMatch(reply: string, description: string): boolean {
  const normalizedReply = normalizeText(reply);
  if (normalizedReply.length < 2) return false;

  const normalizedDescription = normalizeText(description);
  // A verbatim displayed option is explicit, including a one-word candidate.
  if (normalizedReply === normalizedDescription) return true;

  if (!MARK_PAID_CHOICE_SHORT_IDENTIFIERS.has(normalizedReply)) {
    return false;
  }

  const descriptionTokens =
    normalizedDescription.match(/[a-z0-9]+(?:[-_][a-z0-9]+)*/gu) ?? [];
  return descriptionTokens.some((token) => token === normalizedReply);
}

type ExplicitPaymentDate =
  | { kind: "absent" }
  | { kind: "valid"; iso: string }
  | { kind: "invalid"; raw: string };

type ExplicitObligationStartDate =
  | { kind: "absent" }
  | {
      kind: "valid";
      raw: string;
      day: number;
      month: number;
      resolvedStartMonth: string;
      hasExplicitYear: boolean;
    }
  | { kind: "invalid"; raw: string };

function isRealCalendarDate(year: number, month: number, day: number): boolean {
  const calendar = new Date(Date.UTC(2000, 0, 1));
  calendar.setUTCFullYear(year, month - 1, day);
  return (
    calendar.getUTCFullYear() === year &&
    calendar.getUTCMonth() + 1 === month &&
    calendar.getUTCDate() === day
  );
}

function isRealIsoCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) return false;
  return isRealCalendarDate(
    Number.parseInt(match[1] as string, 10),
    Number.parseInt(match[2] as string, 10),
    Number.parseInt(match[3] as string, 10),
  );
}

/**
 * Validate the explicit start date before classification can turn it into an
 * obligation draft. Yearless dates resolve by obligation-month chronology;
 * 29 February advances to the next leap year instead of being rejected.
 */
function explicitObligationStartDate(
  text: string,
  today: string,
): ExplicitObligationStartDate {
  const match =
    /\ba\s+partir\s+de\s*(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/i.exec(text);
  if (match === null) return { kind: "absent" };

  const raw = match[0];
  const day = Number.parseInt(match[1] as string, 10);
  const month = Number.parseInt(match[2] as string, 10);
  const rawYear = match[3];
  const hasExplicitYear = rawYear !== undefined;

  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return { kind: "invalid", raw };
  }

  if (hasExplicitYear) {
    const parsedYear = Number.parseInt(rawYear, 10);
    const year = parsedYear < 100 ? 2000 + parsedYear : parsedYear;
    if (!isRealCalendarDate(year, month, day)) {
      return { kind: "invalid", raw };
    }
    return {
      kind: "valid",
      raw,
      day,
      month,
      resolvedStartMonth: `${year}-${String(month).padStart(2, "0")}`,
      hasExplicitYear,
    };
  }

  const todayYear = Number.parseInt(today.slice(0, 4), 10);
  const todayMonth = Number.parseInt(today.slice(5, 7), 10);
  let year = month < todayMonth ? todayYear + 1 : todayYear;
  while (!isRealCalendarDate(year, month, day) && year <= todayYear + 8) {
    year += 1;
  }
  if (!isRealCalendarDate(year, month, day)) {
    return { kind: "invalid", raw };
  }
  return {
    kind: "valid",
    raw,
    day,
    month,
    resolvedStartMonth: `${year}-${String(month).padStart(2, "0")}`,
    hasExplicitYear,
  };
}

function isBareFinancingInstallmentPosition(
  text: string,
  candidate: RegExpMatchArray,
): boolean {
  if (candidate[3] !== undefined) return false;

  const current = Number.parseInt(candidate[1] as string, 10);
  const total = Number.parseInt(candidate[2] as string, 10);
  if (current < 1 || total < 1 || current > total) return false;

  const prefix = text.slice(0, candidate.index);
  return (
    /\b(?:financiamento|empr[eé]stimo|cons[oó]rcio)\b/i.test(prefix) &&
    !/\b(?:em|dia|data|no\s+dia|na\s+data)\s*$/i.test(prefix)
  );
}

function hasBareFinancingInstallmentPosition(text: string): boolean {
  return [...text.matchAll(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/g)].some(
    (candidate) => isBareFinancingInstallmentPosition(text, candidate),
  );
}

/**
 * Read an explicit relative or DD/MM[/YYYY] payment occurrence date using the
 * shared parser's resolved value. MM/YYYY bill selectors are deliberately
 * excluded.
 */
function explicitPaymentDate(
  text: string,
  today: string,
  billMonth?: string,
): ExplicitPaymentDate {
  // A standalone settlement day is metadata, not a complete occurrence date:
  // valid values keep the normal `today` fallback. Reject impossible values
  // here so they cannot leak into an amount/target or be rescued by AI.
  const bareDayMatch = /\b(?:no\s+)?dia\s*(\d+)\b(?!\/)/i.exec(text);
  if (bareDayMatch !== null) {
    const day = Number.parseInt(bareDayMatch[1] as string, 10);
    if (day < 1 || day > 31) {
      return { kind: "invalid", raw: bareDayMatch[0] };
    }
  }
  const matches = [
    ...text.matchAll(
      /\b(?:(?:em|(?:no\s+)?dia|(?:na\s+)?data)\s*)?(\d{1,2})\/(\d{1,2})(?:(?:\/|\s+(?:(?:do\s+)?ano\s+de|de)\s*)(\d{2,4})(?!\s*\/\d))?\b/gi,
    ),
  ].filter((candidate) => {
    const prefix = text.slice(0, candidate.index);
    const hasTemporalIntroducer = /^(?:em|(?:no\s+)?dia|(?:na\s+)?data)/i.test(
      candidate[0],
    );
    // `parcela 10/12` is an installment position, not 10 December. Keep it
    // out of the occurrence-date parser even when the surrounding sentence
    // says that the installment was paid.
    if (
      !hasTemporalIntroducer &&
      /\b(?:parcela|presta[cç][aã]o)\s+(?:(?:n(?:[uú]mero)?|n[º°])\.?\s*)?$/i.test(
        prefix,
      )
    ) {
      return false;
    }

    // A bare fraction following financing language normally identifies the
    // installment position (`financiamento do carro 10/12`), not a payment
    // date. An explicit temporal introducer still wins, including when it
    // appears after an earlier structural fraction (`10/12 em 05/08`).
    if (
      !hasTemporalIntroducer &&
      isBareFinancingInstallmentPosition(text, candidate)
    ) {
      return false;
    }

    // Compact fractions such as `24/7` commonly describe availability. An
    // unpadded month is accepted only when date language makes the temporal
    // meaning explicit (`em 24/7`, `dia 24/7`, ...). Padded bare dates such
    // as `fatura ... 10/08` remain supported.
    const isCompactTwoPartFraction =
      candidate[3] === undefined && (candidate[2] as string).length === 1;
    if (
      isCompactTwoPartFraction &&
      !hasTemporalIntroducer &&
      !/\b(?:em|dia|data|no\s+dia|na\s+data)\s*$/i.test(prefix)
    ) {
      return false;
    }
    return true;
  });
  // Rank dates by how clearly the user presented them as the occurrence date.
  // Strong introducers (`data`, `na data`, `dia`, `no dia`) and spoken full
  // dates win over relative words. Relative words win over the weaker `em`
  // form, which is also commonly used for installment structure
  // (`parcela em 10/12/2025`). Incidental bare dates remain a last resort.
  const eligibleYearlessMatches = matches.filter((candidate) => {
    if (Number.parseInt(candidate[2] as string, 10) > 12) return false;
    if (billMonth === undefined) return true;

    const rawMonth = Number.parseInt(candidate[1] as string, 10);
    const rawYear = Number.parseInt(candidate[2] as string, 10);
    const selectorYear = rawYear < 100 ? 2000 + rawYear : rawYear;
    const selector = `${selectorYear}-${String(rawMonth).padStart(2, "0")}`;
    return selector !== billMonth;
  });
  const eligibleMatches = matches.filter(
    (candidate) =>
      candidate[3] !== undefined || eligibleYearlessMatches.includes(candidate),
  );
  const relativeMatches = [...text.matchAll(/\b(anteontem|ontem|hoje)\b/gi)];
  const rankedCandidates = [
    ...eligibleMatches.map((candidate) => ({
      kind: "numeric" as const,
      candidate,
      intentTier:
        /^(?:(?:no\s+)?dia|(?:na\s+)?data)/i.test(candidate[0]) ||
        /\d{1,2}\s+(?:(?:do\s+)?ano\s+de|de)\s*\d{2,4}\b/i.test(candidate[0])
          ? 3
          : /^em/i.test(candidate[0])
            ? 1
            : 0,
      explicitYear: candidate[3] === undefined ? 0 : 1,
      index: candidate.index ?? 0,
    })),
    ...relativeMatches.map((candidate) => ({
      kind: "relative" as const,
      candidate,
      intentTier: 2,
      explicitYear: 0,
      index: candidate.index ?? 0,
    })),
  ].sort(
    (left, right) =>
      right.intentTier - left.intentTier ||
      right.explicitYear - left.explicitYear ||
      left.index - right.index,
  );
  const selected = rankedCandidates[0];
  if (selected === undefined) return { kind: "absent" };

  // Two different dates in the strongest active syntax tier are both
  // authoritative. This includes relative wording (`ontem ou anteontem`):
  // never silently choose the first one. Repeated references to the same date
  // remain harmless.
  const strongestIntentTier = rankedCandidates[0]?.intentTier;
  const strongestCandidates = rankedCandidates.filter(
    (candidate) => candidate.intentTier === strongestIntentTier,
  );
  if (strongestCandidates.length > 1) {
    const distinctDates = new Set(
      strongestCandidates.map(({ kind, candidate }) => {
        if (kind === "relative") {
          return (
            parseExpenseText(candidate[0], { today }).occurredOn ??
            candidate[0].trim().toLowerCase()
          );
        }
        const canonical = `${candidate[1]}/${candidate[2]}${candidate[3] === undefined ? "" : `/${candidate[3]}`}`;
        const parsed = parseExpenseText(canonical, { today }).occurredOn;
        if (parsed === undefined) return canonical;
        return candidate[3] === undefined && parsed > today
          ? `${Number.parseInt(parsed.slice(0, 4), 10) - 1}${parsed.slice(4)}`
          : parsed;
      }),
    );
    if (distinctDates.size > 1) {
      return {
        kind: "invalid",
        raw: strongestCandidates
          .map(({ candidate }) => candidate[0].trim())
          .join(" / "),
      };
    }
  }
  if (selected.kind === "relative") {
    const parsed = parseExpenseText(selected.candidate[0], { today });
    if (
      parsed.occurredOn === undefined ||
      parsed.uncertainFields.includes("date") ||
      !/^\d{4}-\d{2}-\d{2}$/.test(parsed.occurredOn)
    ) {
      return { kind: "invalid", raw: selected.candidate[0] };
    }
    return { kind: "valid", iso: parsed.occurredOn };
  }
  const match = selected.candidate;

  const canonicalDate = `${match[1]}/${match[2]}${match[3] === undefined ? "" : `/${match[3]}`}`;
  const parsed = parseExpenseText(canonicalDate, { today });
  const iso = parsed.occurredOn;
  if (
    iso === undefined ||
    parsed.uncertainFields.includes("date") ||
    !/^\d{4}-\d{2}-\d{2}$/.test(iso)
  ) {
    return { kind: "invalid", raw: match[0] };
  }
  const [yearPart, monthPart, dayPart] = iso.split("-");
  const year = Number(yearPart);
  const resolvedMonth = Number(monthPart);
  const day = Number(dayPart);
  const calendar = new Date(Date.UTC(year, resolvedMonth - 1, day));
  if (
    calendar.getUTCFullYear() !== year ||
    calendar.getUTCMonth() + 1 !== resolvedMonth ||
    calendar.getUTCDate() !== day
  ) {
    return { kind: "invalid", raw: match[0] };
  }
  const hasExplicitYear = match[3] !== undefined;
  const mostRecentIso =
    !hasExplicitYear && iso > today ? `${year - 1}${iso.slice(4)}` : iso;
  return { kind: "valid", iso: mostRecentIso };
}

function genericKeywordMatch(keyword: string, name: string): boolean {
  const keywordTokens = matchTokens(keyword);
  const nameTokens = matchTokens(name);
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
  // Short card names are common (XP, C6). A containment fallback made a
  // one-character reply such as "x" select XP. Exact normalized equality is
  // the only safe fallback when either side has no meaningful (3+ char) token.
  return normalizedKeyword === normalizedName;
}

function authoritativeCardNameMatch(keyword: string, name: string): boolean {
  return normalizeText(keyword) === normalizeText(name);
}

function valuesDisagree<T>(left: T | undefined, right: T | undefined): boolean {
  return left !== undefined && right !== undefined && left !== right;
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
    purchasedOn: draft.purchasedOn,
    firstDueMonth: firstDueMonthFor(draft, deps),
    categoryLabel: categoryLabel(
      deps.catalog,
      draft.categoryId,
      draft.subcategoryId,
    ),
    categoryExplanation: draft.categoryExplanation,
    proposedNewCategory,
    responsibleLabel: responsibleLabel(draft.responsibleUserId, deps),
  };
}

/**
 * Settle ONE matched obligation for the message's current month, with the
 * explicit occurrence date as `paidOn` (or message date by default).
 * Idempotent: an already-paid month is a friendly no-op. Terminal either way.
 */
async function settleObligation(
  candidate: MarkPaidCandidate,
  ballast: DraftInProgress,
  messageText: string,
  deps: ConversationDeps,
  today: string,
  amountCents?: number,
  accountId?: string,
  paidOn: string = today,
): Promise<ConversationOutcome> {
  if (deps.materializeObligationPayment === undefined) {
    // The obligation WAS found — the settle capability just is not wired.
    return {
      state: { status: "cancelled", draft: ballast },
      reply: obligationUnavailableMessage(),
    };
  }
  const month = paidOn.slice(0, 7);
  let alreadyPaid: boolean;
  try {
    ({ alreadyPaid } = await deps.materializeObligationPayment({
      obligationId: candidate.id,
      month,
      paidOn,
      ...(amountCents === undefined ? {} : { amountCents }),
      ...(accountId === undefined ? {} : { accountId }),
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
          amountCents: amountCents ?? candidate.amountCents,
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
  purchase: Extract<
    RoutedInterpretedIntent,
    { intent: "card_installment" }
  >["purchase"],
  cards: Array<{ id: string; name: string; closingDay?: number }>,
): string | undefined {
  if (purchase.cardKeyword !== undefined) {
    const matches = cards.filter((c) =>
      purchase.authoritativeCardName === undefined
        ? cardKeywordMatch(purchase.cardKeyword as string, c.name)
        : authoritativeCardNameMatch(purchase.authoritativeCardName, c.name),
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
  purchase: Extract<
    RoutedInterpretedIntent,
    { intent: "card_installment" }
  >["purchase"],
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
  if (
    purchase.cardKeyword !== undefined &&
    !cards.some((card) =>
      purchase.authoritativeCardName === undefined
        ? cardKeywordMatch(purchase.cardKeyword as string, card.name)
        : authoritativeCardNameMatch(purchase.authoritativeCardName, card.name),
    )
  ) {
    const availableCardNames = cards.map((card) => card.name).join(", ");
    return {
      state: { status: "cancelled", draft: ballast },
      reply: `Não encontrei o cartão “${purchase.cardKeyword}”. Cartões cadastrados: ${availableCardNames}.`,
    };
  }

  const totalCents =
    purchase.totalCents ??
    (purchase.perInstallmentCents !== undefined &&
    purchase.installmentCount !== undefined
      ? purchase.perInstallmentCents * purchase.installmentCount
      : undefined);

  const resolvedCardId = resolveInstallmentCardId(purchase, cards);
  const installmentDraft: InstallmentDraftInProgress = {
    idempotencyKey: randomUUID(),
    description: stripEdgePunctuation(purchase.description),
    totalCents,
    installmentCount: purchase.installmentCount,
    purchasedOn: purchase.purchasedOn ?? options.today,
    cardId: resolvedCardId,
    cardClosingDay: cards.find((card) => card.id === resolvedCardId)
      ?.closingDay,
    createdByUserId: input.fromUserId,
    responsibleUserId: input.fromUserId || undefined,
  };
  installmentDraft.description = stripSelectedInstrumentFromDescription(
    installmentDraft.description,
    cards.find((card) => card.id === installmentDraft.cardId)?.name,
  );

  // Same shared categorization engine as expenses/obligations; the hint is
  // free TEXT appended to the context description — never trusted as an id.
  let proposedCategoryName = purchase.proposedCategoryName;
  let proposedSubcategory: PendingSubcategoryProposal | undefined;
  let categoryCandidates: ConversationState["categoryCandidates"];
  if (purchase.unifiedPrimary === true) {
    categoryCandidates = resolveCategoryCandidates(
      purchase.categoryCandidates ?? [],
      deps.catalog,
    );
    if (
      purchase.proposedCategoryName === undefined &&
      purchase.proposedSubcategory === undefined
    ) {
      applyTopCategoryCandidate(installmentDraft, categoryCandidates);
    }
    proposedSubcategory = pendingSubcategoryFromInterpreter(
      deps.catalog,
      purchase.proposedSubcategory,
      "Subcategoria sugerida pela leitura inteligente.",
    );
    if (proposedSubcategory !== undefined) {
      installmentDraft.categoryId = proposedSubcategory.categoryId;
      installmentDraft.subcategoryId = undefined;
      installmentDraft.categoryExplanation = proposedSubcategory.explanation;
    }
  }

  const needsCategoryFallback =
    installmentDraft.categoryId === undefined &&
    proposedCategoryName === undefined &&
    proposedSubcategory === undefined;
  if (needsCategoryFallback) {
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
    if (
      result.status === "pending_new_subcategory" &&
      result.pendingCategory !== undefined &&
      result.suggestion?.macroCategoryId !== undefined
    ) {
      proposedSubcategory = pendingSubcategoryFromNames(
        deps.catalog,
        result.pendingCategory.categoryName,
        result.pendingCategory.subcategoryName,
        result.pendingCategory.explanation,
        result.suggestion.macroCategoryId,
      );
      if (proposedSubcategory !== undefined) {
        installmentDraft.categoryId = proposedSubcategory.categoryId;
        installmentDraft.subcategoryId = undefined;
        installmentDraft.categoryExplanation = proposedSubcategory.explanation;
      }
    }
  }

  const state: ConversationState = {
    status: "awaiting_installment_confirmation",
    draft: ballast,
    installmentDraft,
    proposedCategoryName,
    proposedSubcategory,
    categoryCandidates,
  };
  const view = installmentSummaryView(
    installmentDraft,
    deps,
    taxonomyProposalLabel(state),
  );
  const reply =
    installmentDraft.cardId === undefined
      ? `${installmentConfirmationMessage(view)}\n\nQual cartão?`
      : installmentConfirmationMessage(view);
  const keyboard =
    installmentDraft.cardId === undefined
      ? cardGridKeyboard(cards)
      : taxonomyProposalLabel(state) !== undefined
        ? installmentConfirmationKeyboard(taxonomyProposalLabel(state))
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
      paidOn: next.paidOn ?? ballast.occurredOn,
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
  authoritativeCardName: string | undefined,
  overrideAmountCents: number | undefined,
  billMonth: string | undefined,
  paidOn: string | undefined,
  settlementAccountKeyword: string | undefined,
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
  const settlementAccountId =
    settlementAccountKeyword === undefined
      ? deps.defaultAccountId
      : deps.resolveAccountIdByName?.(settlementAccountKeyword);
  if (
    settlementAccountKeyword !== undefined &&
    settlementAccountId === undefined
  ) {
    return {
      state: { status: "cancelled", draft: ballast },
      reply: `Não encontrei a conta “${settlementAccountKeyword}” para pagar a fatura. Diga o nome de uma conta cadastrada.`,
    };
  }
  if (settlementAccountId === undefined) {
    return {
      state: { status: "cancelled", draft: ballast },
      reply:
        "A casa ainda não tem uma conta cadastrada — crie uma em Contas no painel antes de pagar faturas.",
    };
  }

  const month = billMonth ?? options.today.slice(0, 7);
  const draft: CardBillDraftInProgress = {
    overrideAmountCents,
    accountId: settlementAccountId,
    month,
    paidOn: paidOn ?? options.today,
    createdByUserId: input.fromUserId,
  };

  const genericCardKeyword = /^(?:cartao|fatura)$/u.test(
    normalizeText(keyword),
  );
  const matches = genericCardKeyword
    ? cards
    : cards.filter((c) =>
        authoritativeCardName === undefined
          ? cardKeywordMatch(keyword, c.name)
          : authoritativeCardNameMatch(authoritativeCardName, c.name),
      );
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
  classified: Exclude<
    RoutedInterpretedIntent,
    { intent: "plain" } | { intent: "non_financial" }
  >,
  input: StartInput,
  deps: ConversationDeps,
  options: StartOptions,
  inputKind: BotInputKind,
  paidOn?: string,
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
      classified.authoritativeCardName,
      classified.amountCents,
      classified.billMonth,
      paidOn,
      classified.settlementAccountKeyword,
      input,
      deps,
      options,
      ballast,
    );
  }

  if (classified.intent === "mark_paid") {
    const settlementAccountId =
      classified.settlementAccountKeyword === undefined
        ? undefined
        : deps.resolveAccountIdByName?.(classified.settlementAccountKeyword);
    if (
      classified.settlementAccountKeyword !== undefined &&
      settlementAccountId === undefined
    ) {
      return {
        state: { status: "cancelled", draft: ballast },
        reply: `Não encontrei a conta “${classified.settlementAccountKeyword}” para registrar o pagamento. Diga o nome de uma conta cadastrada.`,
      };
    }
    const obligations =
      deps.listActiveObligations !== undefined
        ? await deps.listActiveObligations()
        : [];
    const hasDiscriminatingTarget =
      obligationMatchTokens(classified.keyword).length > 0;
    const matches = obligations.filter((o) =>
      hasDiscriminatingTarget
        ? keywordMatch(classified.keyword, o.description)
        : genericKeywordMatch(classified.keyword, o.description),
    );

    if (matches.length === 0) {
      return {
        state: { status: "cancelled", draft: ballast },
        reply: obligationNotFoundMessage(classified.keyword),
      };
    }
    if (matches.length === 1 && hasDiscriminatingTarget) {
      return settleObligation(
        matches[0] as MarkPaidCandidate,
        ballast,
        input.text,
        deps,
        options.today,
        classified.amountCents,
        settlementAccountId,
        paidOn,
      );
    }
    return {
      state: {
        status: "awaiting_mark_paid_choice",
        draft: ballast,
        markPaidCandidates: matches,
        ...(classified.amountCents === undefined
          ? {}
          : { markPaidAmountCents: classified.amountCents }),
        ...(settlementAccountId === undefined
          ? {}
          : { markPaidAccountId: settlementAccountId }),
        ...(paidOn === undefined ? {} : { markPaidPaidOn: paidOn }),
      },
      reply: obligationAmbiguousMessage(matches.map((m) => m.description)),
    };
  }

  // Obligation create: build the template draft, then ask for confirmation.
  // An obligation is account-paid, so a household with no account at all
  // cannot hold one — refuse with a clear message (mirrors `persist`).
  const extracted = classified.obligation;
  const obligationAccountId =
    extracted.accountKeyword === undefined
      ? deps.defaultAccountId
      : deps.resolveAccountIdByName?.(extracted.accountKeyword);
  if (
    extracted.accountKeyword !== undefined &&
    obligationAccountId === undefined
  ) {
    return {
      state: { status: "cancelled", draft: ballast },
      reply: `Não encontrei a conta “${extracted.accountKeyword}” para registrar a obrigação. Diga o nome de uma conta cadastrada.`,
    };
  }
  if (obligationAccountId === undefined) {
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
    accountId: obligationAccountId,
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
  const unifiedCandidates = resolveCategoryCandidates(
    extracted.categoryCandidates ?? [],
    deps.catalog,
  );
  if (extracted.unifiedPrimary === true) {
    if (
      extracted.proposedCategoryName === undefined &&
      extracted.proposedSubcategory === undefined
    ) {
      applyTopCategoryCandidate(obligationDraft, unifiedCandidates);
    }
  }
  const proposedSubcategory =
    extracted.unifiedPrimary === true
      ? pendingSubcategoryFromInterpreter(
          deps.catalog,
          extracted.proposedSubcategory,
          "Subcategoria sugerida pela leitura inteligente.",
        )
      : result?.status === "pending_new_subcategory" &&
          result.pendingCategory !== undefined &&
          result.suggestion?.macroCategoryId !== undefined
        ? pendingSubcategoryFromNames(
            deps.catalog,
            result.pendingCategory.categoryName,
            result.pendingCategory.subcategoryName,
            result.pendingCategory.explanation,
            result.suggestion.macroCategoryId,
          )
        : undefined;
  if (proposedSubcategory !== undefined) {
    obligationDraft.categoryId = proposedSubcategory.categoryId;
    obligationDraft.subcategoryId = undefined;
    obligationDraft.categoryExplanation = proposedSubcategory.explanation;
  }
  const proposedCategoryName =
    result?.status === "pending_new_category" && result.pendingCategory
      ? result.pendingCategory.categoryName
      : extracted.proposedCategoryName;
  if (proposedCategoryName !== undefined) {
    obligationDraft.categoryExplanation =
      result?.status === "pending_new_category" && result.pendingCategory
        ? result.pendingCategory.explanation
        : `Nova categoria sugerida (pendente; não será criada automaticamente): ${proposedCategoryName}.`;
  }

  const state: ConversationState = {
    status: "awaiting_obligation_confirmation",
    draft: ballast,
    obligationDraft,
    proposedCategoryName,
    proposedSubcategory,
    categoryCandidates: unifiedCandidates,
  };

  return {
    state,
    reply: `${
      extracted.requestedDueDay !== undefined
        ? `Ajustei o vencimento solicitado (dia ${extracted.requestedDueDay}) para o dia 28, que é o último dia aceito para obrigações.\n\n`
        : ""
    }${obligationConfirmationMessage(obligationSummaryView(obligationDraft, deps))}`,
    keyboard: obligationConfirmationKeyboard(
      taxonomyProposalLabel(state),
      unifiedCandidates,
    ),
  };
}

/**
 * An unresolved deterministic payment route is never safe to materialize from
 * the classifier alone. The classifier may put its preferred obligation first,
 * but the user must still choose one of every obligation matching the broader
 * deterministic target before any write occurs.
 */
async function startUnresolvedExistingPaymentChoice(
  classified: Extract<RoutedInterpretedIntent, { intent: "mark_paid" }>,
  deterministicKeyword: string | undefined,
  input: StartInput,
  deps: ConversationDeps,
  options: StartOptions,
  inputKind: BotInputKind,
  paidOn?: string,
): Promise<ConversationOutcome> {
  const ballast = placeholderDraft(input, inputKind, options.today);
  const settlementAccountId =
    classified.settlementAccountKeyword === undefined
      ? undefined
      : deps.resolveAccountIdByName?.(classified.settlementAccountKeyword);
  if (
    classified.settlementAccountKeyword !== undefined &&
    settlementAccountId === undefined
  ) {
    return {
      state: { status: "cancelled", draft: ballast },
      reply: `Não encontrei a conta “${classified.settlementAccountKeyword}” para registrar o pagamento. Diga o nome de uma conta cadastrada.`,
    };
  }

  const obligations =
    deps.listActiveObligations !== undefined
      ? await deps.listActiveObligations()
      : [];
  const broadKeyword = deterministicKeyword ?? classified.keyword;
  const hasDiscriminatingTarget =
    obligationMatchTokens(broadKeyword).length > 0;
  const broadMatches = obligations.filter((obligation) =>
    hasDiscriminatingTarget
      ? keywordMatch(broadKeyword, obligation.description)
      : genericKeywordMatch(broadKeyword, obligation.description),
  );
  if (broadMatches.length === 0) {
    return {
      state: { status: "cancelled", draft: ballast },
      reply: obligationNotFoundMessage(broadKeyword),
    };
  }

  const preferredIds = new Set(
    broadMatches
      .filter((obligation) =>
        keywordMatch(classified.keyword, obligation.description),
      )
      .map((obligation) => obligation.id),
  );
  const candidates = [
    ...broadMatches.filter((obligation) => preferredIds.has(obligation.id)),
    ...broadMatches.filter((obligation) => !preferredIds.has(obligation.id)),
  ];

  return {
    state: {
      status: "awaiting_mark_paid_choice",
      draft: ballast,
      markPaidCandidates: candidates,
      ...(classified.amountCents === undefined
        ? {}
        : { markPaidAmountCents: classified.amountCents }),
      ...(settlementAccountId === undefined
        ? {}
        : { markPaidAccountId: settlementAccountId }),
      ...(paidOn === undefined ? {} : { markPaidPaidOn: paidOn }),
    },
    reply: obligationAmbiguousMessage(
      candidates.map((candidate) => candidate.description),
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

  // Deterministic parsing runs first only to provide hints and a final fallback.
  // A successful unified interpreter owns the structured plain-expense fields.
  const textWithAuthoritativeInstrumentNamesMasked =
    maskAuthoritativeRegisteredInstrumentNames(input.text, deps);
  const parsed = parseExpenseText(textWithAuthoritativeInstrumentNamesMasked, {
    today: options.today,
  });
  const deterministic = detectFinancialRoute(input.text, {
    knownCards: deps.listActiveCards?.() ?? [],
    knownAccounts: deps.listActiveAccounts?.() ?? [],
    merchantAliases: deps.merchantAliases,
  });
  const obligationStartDate = explicitObligationStartDate(
    input.text,
    options.today,
  );
  if (obligationStartDate.kind === "invalid") {
    const ballast = placeholderDraft(input, inputKind, options.today);
    return {
      state: { status: "cancelled", draft: ballast },
      reply: `A data de início “${obligationStartDate.raw}” é inválida. Envie uma data real no formato DD/MM ou DD/MM/AAAA.`,
    };
  }
  const paymentDate = explicitPaymentDate(
    textWithAuthoritativeInstrumentNamesMasked,
    options.today,
    deterministic.billMonth,
  );
  const invalidPaymentDate = (raw: string): ConversationOutcome => {
    const ballast = placeholderDraft(input, inputKind, options.today);
    return {
      state: { status: "cancelled", draft: ballast },
      reply: `A data de pagamento “${raw}” é inválida. Envie no formato DD/MM ou DD/MM/AAAA.`,
    };
  };
  const invalidInstallmentPurchaseDate = (raw: string): ConversationOutcome => {
    const ballast = placeholderDraft(input, inputKind, options.today);
    return {
      state: { status: "cancelled", draft: ballast },
      reply: `A data da compra “${raw}” é inválida. Envie uma data real no formato DD/MM ou DD/MM/AAAA.`,
    };
  };
  const paymentPaidOn =
    paymentDate.kind === "valid" ? paymentDate.iso : undefined;
  const financingInstallmentPosition = hasBareFinancingInstallmentPosition(
    input.text,
  );
  const authoritativeCardNameFromText =
    explicitAuthoritativeInstrumentFromText(
      input.text,
      "card",
      deps.listActiveCards?.() ?? [],
    ) ??
    registeredNormalFaturaTargetMatch(
      input.text,
      deps.listActiveCards?.() ?? [],
    )?.keyword;

  const withParsedFinancialDates = (
    classified: RoutedInterpretedIntent | null,
  ): RoutedInterpretedIntent | null => {
    if (
      classified?.intent === "mark_paid" &&
      classified.target === "card" &&
      authoritativeCardNameFromText !== undefined
    ) {
      classified = {
        ...classified,
        keyword: authoritativeCardNameFromText,
        authoritativeCardName: authoritativeCardNameFromText,
      };
    } else if (
      classified?.intent === "card_installment" &&
      authoritativeCardNameFromText !== undefined
    ) {
      classified = {
        ...classified,
        purchase: {
          ...classified.purchase,
          cardKeyword: authoritativeCardNameFromText,
          authoritativeCardName: authoritativeCardNameFromText,
        },
      };
    }
    if (
      classified?.intent === "mark_paid" &&
      (paymentPaidOn !== undefined || financingInstallmentPosition)
    ) {
      const keyword =
        classified.target === "card" &&
        authoritativeCardNameFromText !== undefined
          ? authoritativeCardNameFromText
          : classified.keyword
              .replace(/\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/g, " ")
              .replace(/\b(?:hoje|ontem|anteontem)\b/gi, " ")
              .replace(/\b(?:em|no\s+dia)\s*$/i, "")
              .replace(/\s+/g, " ")
              .trim();
      return { ...classified, keyword };
    }
    if (
      classified?.intent === "card_installment" &&
      paymentDate.kind === "valid"
    ) {
      return {
        ...classified,
        purchase: {
          ...classified.purchase,
          purchasedOn: paymentDate.iso,
        },
      };
    }
    if (
      classified?.intent === "card_installment" &&
      (classified.purchase.purchasedOn === undefined ||
        !isRealIsoCalendarDate(classified.purchase.purchasedOn)) &&
      parsed.occurredOn !== undefined &&
      !parsed.uncertainFields.includes("date")
    ) {
      const hasExplicitPurchaseYear = /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/.test(
        input.text,
      );
      let purchasedOn = parsed.occurredOn;
      if (!hasExplicitPurchaseYear && purchasedOn > options.today) {
        purchasedOn = `${Number(purchasedOn.slice(0, 4)) - 1}${purchasedOn.slice(4)}`;
      }
      return {
        ...classified,
        purchase: { ...classified.purchase, purchasedOn },
      };
    }
    if (
      classified?.intent === "obligation" &&
      obligationStartDate.kind === "valid"
    ) {
      const hasIndependentExplicitDueDay = deterministic.dueDay !== undefined;
      const classifiedStartMonth = classified.obligation.startMonth;
      const validClassifiedStartMonth =
        classifiedStartMonth !== undefined &&
        /^\d{4}-(0[1-9]|1[0-2])$/.test(classifiedStartMonth);
      return {
        ...classified,
        obligation: {
          ...classified.obligation,
          startMonth:
            !obligationStartDate.hasExplicitYear && validClassifiedStartMonth
              ? classifiedStartMonth
              : obligationStartDate.resolvedStartMonth,
          dueDay: hasIndependentExplicitDueDay
            ? deterministic.dueDay
            : obligationStartDate.day,
          requestedDueDay: hasIndependentExplicitDueDay
            ? deterministic.requestedDueDay
            : obligationStartDate.day > 28
              ? obligationStartDate.day
              : undefined,
        },
      };
    }
    return classified;
  };

  const unresolvedAmbiguity = (): ConversationOutcome => {
    const ballast = placeholderDraft(input, inputKind, options.today);
    const reply =
      deterministic.reason === "invalid_bill_month" &&
      deterministic.invalidBillMonth !== undefined
        ? `O mês da fatura “${deterministic.invalidBillMonth}” é inválido. Envie no formato MM/AAAA, com mês entre 01 e 12.`
        : deterministic.reason === "invalid_installment_ordinal"
          ? "O número da parcela precisa ser maior ou igual a 1. Informe uma posição válida para registrar o pagamento."
          : deterministic.reason === "invalid_payment_amount"
            ? "O valor pago precisa ser maior que R$ 0. Informe um valor positivo para registrar o pagamento."
            : deterministic.reason === "invalid_due_day"
              ? "O dia de vencimento é inválido. Informe um dia entre 1 e 31; vencimentos após o dia 28 são ajustados para 28."
              : deterministic.reason === "ambiguous_payment_number_semantics" &&
                  deterministic.ambiguousPaymentNumber !== undefined
                ? `Não ficou claro se ${deterministic.ambiguousPaymentNumber} é o valor pago ou o número da parcela. Envie “R$ ${deterministic.ambiguousPaymentNumber}” para informar o valor ou “parcela número ${deterministic.ambiguousPaymentNumber}” para informar a posição.`
                : deterministic.reason === "unresolved_existing_payment"
                  ? "Não consegui identificar com segurança qual obrigação foi paga. Diga o nome exato da obrigação e o valor pago."
                  : "Não consegui separar com segurança uma compra parcelada de uma obrigação. Diga se foi uma compra no cartão e informe o número de parcelas.";
    return {
      state: { status: "cancelled", draft: ballast },
      reply,
    };
  };

  // Unified intent classification: when configured it sees every NEW message
  // with parser/DB context. A null result falls back to the parser path below.
  let classifiedExpense: InterpretedExpense | null = null;
  // True when the classifier was configured but every tier failed or timed out.
  // The draft still gets built from the parser — the reply just says so.
  let aiUnavailable = false;
  if (deps.classifyMessage !== undefined) {
    const aiClassified = await deps
      .classifyMessage(input.text, {
        today: options.today,
        parserHints: parsed,
        knownCards: (deps.listActiveCards?.() ?? []).map(({ id, name }) => ({
          id,
          name,
        })),
        knownAccounts: (deps.listActiveAccounts?.() ?? []).map(
          ({ id, name }) => ({
            id,
            name,
          }),
        ),
        catalog: deps.catalog,
        merchantAliases: deps.merchantAliases,
      })
      .catch(() => null);
    const resolvedFinancingInstallmentPayment =
      deterministic.route === "ambiguous" &&
      deterministic.reason === "ambiguous_payment_number_semantics" &&
      aiClassified?.intent === "mark_paid" &&
      aiClassified.target === "obligation" &&
      financingInstallmentPosition;
    const classified = withParsedFinancialDates(
      resolvedFinancingInstallmentPayment
        ? aiClassified
        : applyDeterministicPrecedence(deterministic, aiClassified),
    );
    aiUnavailable = aiClassified === null;
    if (classified?.intent === "card_installment") {
      if (paymentDate.kind === "invalid") {
        return invalidInstallmentPurchaseDate(paymentDate.raw);
      }
      if (
        classified.purchase.purchasedOn !== undefined &&
        !isRealIsoCalendarDate(classified.purchase.purchasedOn)
      ) {
        return invalidInstallmentPurchaseDate(classified.purchase.purchasedOn);
      }
    }
    if (classified?.intent === "mark_paid" && paymentDate.kind === "invalid") {
      return invalidPaymentDate(paymentDate.raw);
    }
    if (
      deterministic.route === "ambiguous" &&
      !resolvedFinancingInstallmentPayment
    ) {
      const unresolvedExistingPayment =
        deterministic.reason === "unresolved_existing_payment" &&
        classified?.intent === "mark_paid" &&
        classified.target === "obligation";
      if (unresolvedExistingPayment) {
        return startUnresolvedExistingPaymentChoice(
          classified,
          deterministic.description,
          input,
          deps,
          options,
          inputKind,
          paymentPaidOn,
        );
      }
      return unresolvedAmbiguity();
    }
    if (classified?.intent === "non_financial") {
      // Successful unified abstention: do not call Anthropic interpretation or
      // categorization. The deterministic parser still owns the safe fallback
      // draft/reply behavior.
      classifiedExpense = {
        description: parsed.description,
        unifiedPrimary: true,
        categoryCandidates: [],
      };
    }
    if (classified !== null && classified.intent !== "plain") {
      if (classified.intent !== "non_financial") {
        return startClassifiedIntent(
          classified,
          input,
          deps,
          options,
          inputKind,
          paymentPaidOn,
        );
      }
    }
    if (classified?.intent === "plain") {
      classifiedExpense = classified.expense;
    }
  } else {
    const classified = withParsedFinancialDates(
      applyDeterministicPrecedence(deterministic, null),
    );
    if (classified?.intent === "card_installment") {
      if (paymentDate.kind === "invalid") {
        return invalidInstallmentPurchaseDate(paymentDate.raw);
      }
      if (
        classified.purchase.purchasedOn !== undefined &&
        !isRealIsoCalendarDate(classified.purchase.purchasedOn)
      ) {
        return invalidInstallmentPurchaseDate(classified.purchase.purchasedOn);
      }
    }
    if (classified?.intent === "mark_paid" && paymentDate.kind === "invalid") {
      return invalidPaymentDate(paymentDate.raw);
    }
    if (deterministic.route === "ambiguous") {
      return unresolvedAmbiguity();
    }
    if (
      classified !== null &&
      classified.intent !== "plain" &&
      classified.intent !== "non_financial"
    ) {
      return startClassifiedIntent(
        classified,
        input,
        deps,
        options,
        inputKind,
        paymentPaidOn,
      );
    }
    if (classified?.intent === "plain") classifiedExpense = classified.expense;
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
    interpreted?.description ??
      ((deterministic.route === "single_credit" ||
        deterministic.route === "plain_account") &&
      (deterministic.explicitCardInstrumentLanguage ||
        deterministic.explicitAccountEvidence)
        ? deterministic.description
        : undefined) ??
      parsed.description,
  );
  const dateUncertain = parsed.uncertainFields.includes("date");
  const amountDisagreement = valuesDisagree(
    parsed.amountCents,
    interpreted?.amountCents,
  );
  const dateDisagreement =
    !dateUncertain &&
    valuesDisagree(parsed.occurredOn, interpreted?.occurredOn);
  const draft: DraftInProgress = {
    // The unified LLM path owns structured interpretation; the parser is a
    // validator/hint source and final fallback.
    amountCents:
      deterministic.explicitMetadataYearEvidence &&
      deterministic.amountCents === undefined
        ? undefined
        : (interpreted?.amountCents ?? parsed.amountCents),
    description,
    occurredOn: dateUncertain
      ? (interpreted?.occurredOn ?? parsed.occurredOn ?? options.today)
      : (interpreted?.occurredOn ?? parsed.occurredOn ?? options.today),
    kind: "expense",
    createdByUserId: input.fromUserId,
    // Responsibility defaults to the SENDER; "responsável casa" (or an
    // interpreted hint) moves it back to the house.
    responsibleUserId: input.fromUserId || undefined,
    inputKind,
    needsAttention:
      // Audio always merits a closer look (transcription can be imperfect),
      // and so do an uncertain amount or date, or a parser-only draft after
      // every AI tier failed. The interpreter running is NOT a signal by
      // itself — it runs on every message.
      inputKind === "audio" ||
      aiUnavailable ||
      amountDisagreement ||
      dateDisagreement ||
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

  // Resolve a named instrument before applying any household default. Bare
  // provider names ("no Nubank") are safe only when they identify one real
  // instrument; account+card collisions become an explicit button choice.
  let paymentCandidates = paymentCandidatesForText(input.text, deps);
  if (
    deterministic.explicitCardInstrumentLanguage &&
    deterministic.cardKeyword === undefined
  ) {
    paymentCandidates = [];
  }
  let selectedPaymentInstrumentName: string | undefined;
  if (
    paymentCandidates.length === 0 &&
    interpreted?.cardKeyword !== undefined &&
    !deterministic.explicitCardInstrumentLanguage &&
    !deterministic.explicitDefaultSettlementAccount
  ) {
    paymentCandidates = (deps.listActiveCards?.() ?? [])
      .filter(
        (card) =>
          normalizeText(card.name) ===
          normalizeText(interpreted.cardKeyword as string),
      )
      .map((card) => ({ type: "card" as const, id: card.id, name: card.name }));
  }
  if (
    paymentCandidates.length === 0 &&
    interpreted?.accountKeyword !== undefined &&
    !deterministic.explicitDefaultSettlementAccount
  ) {
    paymentCandidates = (deps.listActiveAccounts?.() ?? [])
      .filter(
        (account) =>
          normalizeText(account.name) ===
          normalizeText(interpreted.accountKeyword as string),
      )
      .map((account) => ({
        type: "account" as const,
        id: account.id,
        name: account.name,
      }));
  }
  const authoritativeCardKeyword = explicitAuthoritativeInstrumentFromText(
    input.text,
    "card",
    deps.listActiveCards?.() ?? [],
  );
  const authoritativeAccountKeyword = explicitAuthoritativeInstrumentFromText(
    input.text,
    "account",
    deps.listActiveAccounts?.() ?? [],
  );
  const explicitCardKeyword =
    authoritativeCardKeyword ??
    (deterministic.explicitCardInstrumentLanguage
      ? deterministic.cardKeyword
      : (deterministic.cardKeyword ??
        explicitNamedInstrumentFromText(
          input.text,
          "card",
          deps.listActiveCards?.() ?? [],
        )));
  const explicitAccountKeyword =
    authoritativeAccountKeyword ??
    deterministic.accountKeyword ??
    explicitNamedInstrumentFromText(
      input.text,
      "account",
      deps.listActiveAccounts?.() ?? [],
    );
  if (
    explicitCardKeyword !== undefined &&
    !(deps.listActiveCards?.() ?? []).some((card) =>
      authoritativeCardKeyword === undefined
        ? cardKeywordMatch(explicitCardKeyword, card.name)
        : normalizeText(card.name) === normalizeText(authoritativeCardKeyword),
    )
  ) {
    return {
      state: { status: "cancelled", draft },
      reply: `Não encontrei o cartão “${explicitCardKeyword}”. Diga o nome de um cartão cadastrado.`,
    };
  }
  if (
    explicitAccountKeyword !== undefined &&
    (authoritativeAccountKeyword !== undefined
      ? !(deps.listActiveAccounts?.() ?? []).some(
          (account) =>
            normalizeText(account.name) ===
            normalizeText(authoritativeAccountKeyword),
        )
      : deps.resolveAccountIdByName?.(explicitAccountKeyword) === undefined &&
        !(deps.listActiveAccounts?.() ?? []).some(
          (account) =>
            normalizeText(account.name) ===
            normalizeText(explicitAccountKeyword),
        ))
  ) {
    return {
      state: { status: "cancelled", draft },
      reply: `Não encontrei a conta “${explicitAccountKeyword}”. Diga o nome de uma conta cadastrada.`,
    };
  }
  if (paymentCandidates.length === 1) {
    const selected = paymentCandidates[0];
    selectedPaymentInstrumentName = selected?.name;
    if (selected?.type === "card") draft.cardId = selected.id;
    if (selected?.type === "account") draft.accountId = selected.id;
  } else if (paymentCandidates.length === 0) {
    if (
      parsed.cardHint ||
      (deterministic.route === "single_credit" &&
        deterministic.explicitCardInstrumentLanguage)
    ) {
      const cards = deps.listActiveCards?.();
      if (cards === undefined) {
        draft.cardId = deps.resolveCardId() ?? undefined;
      } else if (cards.length === 1) {
        draft.cardId = cards[0]?.id;
        selectedPaymentInstrumentName = cards[0]?.name;
      } else if (cards.length > 1) {
        paymentCandidates = cards.map((card) => ({
          type: "card" as const,
          id: card.id,
          name: card.name,
        }));
      }
    }
    if (draft.cardId === undefined && paymentCandidates.length === 0) {
      draft.accountId =
        (parsed.accountHint ? deps.resolveAccountId() : undefined) ??
        deps.defaultAccountId;
    }
  }
  draft.description = stripSelectedInstrumentFromDescription(
    draft.description,
    selectedPaymentInstrumentName,
  );

  // Ask the categorization engine for a suggestion (shared engine, both
  // channels). A category hint from the interpreter is free TEXT appended to
  // the context description — never trusted as a category id.
  let proposedCategoryName = interpreted?.proposedCategoryName;
  let proposedSubcategory: PendingSubcategoryProposal | undefined;
  let categoryCandidates: ConversationState["categoryCandidates"];
  if (interpreted?.unifiedPrimary === true) {
    // A successful unified primary already categorized this message. Do not
    // make a second model call through suggestCategory. Resolve only real ids.
    categoryCandidates = resolveCategoryCandidates(
      interpreted.categoryCandidates ?? [],
      deps.catalog,
    );
    if (
      interpreted.proposedCategoryName === undefined &&
      interpreted.proposedSubcategory === undefined
    ) {
      applyTopCategoryCandidate(draft, categoryCandidates);
    }
    proposedSubcategory = pendingSubcategoryFromInterpreter(
      deps.catalog,
      interpreted.proposedSubcategory,
      "Subcategoria sugerida pela leitura inteligente.",
    );
    if (proposedSubcategory !== undefined) {
      draft.categoryId = proposedSubcategory.categoryId;
      draft.subcategoryId = undefined;
      draft.categoryExplanation = proposedSubcategory.explanation;
      draft.needsAttention = true;
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
    if (
      result.status === "pending_new_subcategory" &&
      result.pendingCategory !== undefined &&
      result.suggestion?.macroCategoryId !== undefined
    ) {
      proposedSubcategory = pendingSubcategoryFromNames(
        deps.catalog,
        result.pendingCategory.categoryName,
        result.pendingCategory.subcategoryName,
        result.pendingCategory.explanation,
        result.suggestion.macroCategoryId,
      );
      if (proposedSubcategory !== undefined) {
        draft.categoryId = proposedSubcategory.categoryId;
        draft.subcategoryId = undefined;
        draft.categoryExplanation = proposedSubcategory.explanation;
        draft.needsAttention = true;
      }
    }
  }

  const state: ConversationState = {
    status:
      paymentCandidates.length > 1
        ? "awaiting_payment_choice"
        : statusForDraft(draft),
    draft,
    proposedCategoryName,
    proposedSubcategory,
    categoryCandidates,
    paymentCandidates:
      paymentCandidates.length > 1 ? paymentCandidates : undefined,
  };
  const reply =
    state.status === "awaiting_payment_choice"
      ? "Qual forma de pagamento você quis dizer?"
      : replyForState(state, deps);
  return {
    state,
    reply: aiUnavailable ? `${AI_UNAVAILABLE_NOTICE}\n\n${reply}` : reply,
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
const MARK_PAID_CHOICE_CANCEL_RE =
  /^\s*(cancelar|cancela|descartar|apagar)\s*[!.…]*\s*$/i;

/** True for every typed command that enters a confirmation save path. */
export function isConfirmationCommand(message: string): boolean {
  return CONFIRM_RE.test(message);
}

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
    proposedSubcategory: undefined,
    categoryCandidates: undefined,
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
  const candidates = state.markPaidCandidates ?? [];
  const matches = candidates.filter((c) =>
    markPaidChoiceMatch(message, c.description),
  );
  // A complete displayed description is always an explicit selection, even
  // when it begins with conversational vocabulary such as "Não". Within the
  // picker, only an unambiguous standalone cancellation command cancels;
  // "não" is an ordinary non-identifying reply and keeps the choice open.
  if (matches.length !== 1 && MARK_PAID_CHOICE_CANCEL_RE.test(message)) {
    return {
      state: { status: "cancelled", draft: state.draft },
      reply: cancelledMessage(),
    };
  }
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
    state.markPaidAmountCents,
    state.markPaidAccountId,
    state.markPaidPaidOn,
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
    let workingState = state;
    let workingDraft = draft;
    if (taxonomyProposalLabel(state) !== undefined) {
      const resolved = await applyPendingTaxonomyToObligation(state, deps);
      if (resolved === null) {
        return { state, reply: notUnderstoodMessage() };
      }
      workingState = resolved.state;
      workingDraft = resolved.draft;
    }
    const monthlyAmountCents = workingDraft.monthlyAmountCents;
    if (monthlyAmountCents === undefined) {
      return { state, reply: obligationNotUnderstoodMessage() };
    }
    const built = createObligationDraft({
      householdId: deps.householdId,
      description: workingDraft.description,
      amountCents: monthlyAmountCents,
      startMonth: workingDraft.startMonth,
      termMonths: workingDraft.termMonths,
      dueDay: workingDraft.dueDay,
      accountId: workingDraft.accountId,
      createdByUserId: workingDraft.createdByUserId,
      responsibleUserId: workingDraft.responsibleUserId,
      category:
        workingDraft.categoryId !== undefined
          ? {
              categoryId: workingDraft.categoryId,
              subcategoryId: workingDraft.subcategoryId,
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
      fromUserId: workingDraft.createdByUserId,
      inputKind: state.draft.inputKind,
      messageText: message,
      explanation: workingDraft.categoryExplanation,
    });
    return {
      state: { status: "saved", draft: workingState.draft },
      reply: obligationSavedMessage({
        description: workingDraft.description,
        monthlyAmountCents,
        termMonths: workingDraft.termMonths,
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

  const dayMatch = /^dia\b\s*(\d+)\s*$/i.exec(message.trim());
  if (fieldLabel === null && dayMatch !== null) {
    const day = Number.parseInt(dayMatch[1] as string, 10);
    if (day < 1 || day > 31) {
      return {
        state,
        reply: "O dia de vencimento precisa estar entre 1 e 31.",
      };
    }
    next.dueDay = Math.min(28, day);
    fieldLabel =
      day > 28
        ? `o vencimento solicitado (dia ${day}) para o dia 28, que é o último dia aceito para obrigações`
        : "o dia de vencimento";
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
  let workingState = state;
  let draft = state.installmentDraft;
  if (draft === undefined) {
    return { state, reply: notUnderstoodMessage() };
  }
  // Keep typed and button confirmation on the same validation path. Incomplete
  // drafts deliberately retain their correction UI, so a premature tap must
  // explain the first missing field instead of falling through to a generic
  // error.
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
  if (taxonomyProposalLabel(state) !== undefined) {
    const resolved = await applyPendingTaxonomyToInstallment(state, deps);
    if (resolved === null) {
      return { state, reply: notUnderstoodMessage() };
    }
    workingState = resolved.state;
    draft = resolved.draft;
  }
  const cardId = draft.cardId;
  const totalCents = draft.totalCents;
  const installmentCount = draft.installmentCount;
  if (
    cardId === undefined ||
    totalCents === undefined ||
    installmentCount === undefined
  ) {
    return { state, reply: notUnderstoodMessage() };
  }
  if (deps.createInstallmentPurchase === undefined) {
    return { state, reply: obligationUnavailableMessage() };
  }

  const card = findActiveCard(deps, cardId);
  const built = createInstallmentPlan({
    householdId: deps.householdId,
    creditCardId: cardId,
    description: draft.description,
    totalAmount: { currency: "BRL", cents: totalCents },
    installmentCount,
    purchasedOn: draft.purchasedOn,
    createdByUserId: draft.createdByUserId,
    responsibleUserId: draft.responsibleUserId,
    category:
      draft.categoryId !== undefined
        ? { categoryId: draft.categoryId, subcategoryId: draft.subcategoryId }
        : undefined,
    closingDay: draft.cardClosingDay,
  });
  if (!built.ok) {
    return {
      state,
      reply: `Não consegui salvar: ${describeValidationError(built.errors[0])}.`,
    };
  }

  // The RPC is atomic and the pending draft's stable key makes a replay after
  // any later failure (interaction log, conversation save, Telegram) return the
  // original group instead of inserting a second purchase.
  try {
    const persisted = await deps.createInstallmentPurchase(
      built.value,
      draft.idempotencyKey,
    );
    await deps.logInteraction({
      fromUserId: draft.createdByUserId,
      inputKind: state.draft.inputKind,
      messageText,
      explanation: draft.categoryExplanation,
    });

    return {
      state: { status: "saved", draft: workingState.draft },
      reply: installmentSavedMessage({
        description: persisted.description,
        totalCents: persisted.totalCents,
        installmentCount: persisted.installmentCount,
        cardName:
          findActiveCard(deps, persisted.creditCardId)?.name ??
          card?.name ??
          "cartão",
        firstDueMonth: persisted.firstDueMonth,
      }),
    };
  } catch (error) {
    console.warn(
      `[bot] installment confirmation outcome uncertain for ${draft.description}:`,
      error,
    );
    return {
      // The request may have committed before its response was lost. Keep the
      // exact draft/key retryable; the database will replay or reconcile it.
      state: { ...workingState, status: "installment_outcome_uncertain" },
      reply: installmentSaveFailedMessage(draft.description),
      keyboard: installmentReconciliationKeyboard(),
    };
  }
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
    const authoritativeName = explicitAuthoritativeInstrumentFromText(
      trimmed,
      "card",
      deps.listActiveCards?.() ?? [],
    );
    const keyword = authoritativeName ?? (cardMatch[1] as string).trim();
    const cards = deps.listActiveCards?.() ?? [];
    const matches = cards.filter((c) =>
      authoritativeName === undefined
        ? cardKeywordMatch(keyword, c.name)
        : authoritativeCardNameMatch(authoritativeName, c.name),
    );
    if (matches.length !== 1) {
      return { state, reply: `Não encontrei o cartão "${keyword}".` };
    }
    const card = matches[0];
    next.cardId = card?.id;
    next.cardClosingDay = card?.closingDay;
    next.description = stripSelectedInstrumentFromDescription(
      next.description,
      card?.name,
    );
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
    const validatedPurchaseDate = explicitPaymentDate(trimmed, today);
    if (validatedPurchaseDate.kind !== "valid") {
      const raw =
        validatedPurchaseDate.kind === "invalid"
          ? validatedPurchaseDate.raw
          : (dateMatch[2] as string).trim();
      return {
        state,
        reply: `A data da compra “${raw}” é inválida. Envie uma data real no formato DD/MM ou DD/MM/AAAA.`,
      };
    }
    next.purchasedOn = validatedPurchaseDate.iso;
    fieldLabel = "a data";
  }

  if (fieldLabel === null) {
    return {
      state,
      reply: installmentConfirmationMessage(
        installmentSummaryView(draft, deps, taxonomyProposalLabel(state)),
      ),
    };
  }

  const nextState: ConversationState = {
    status: "awaiting_installment_confirmation",
    draft: state.draft,
    installmentDraft: next,
    proposedCategoryName:
      catMatch !== null ? undefined : state.proposedCategoryName,
    proposedSubcategory:
      catMatch !== null ? undefined : state.proposedSubcategory,
    categoryCandidates:
      catMatch !== null ? undefined : state.categoryCandidates,
  };
  return {
    state: nextState,
    reply: `${correctionAppliedMessage(fieldLabel)}\n\n${installmentConfirmationMessage(installmentSummaryView(next, deps, taxonomyProposalLabel(nextState)))}`,
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
    paidOn: draft.paidOn ?? today,
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
    const authoritativeName = explicitAuthoritativeInstrumentFromText(
      message,
      "card",
      deps.listActiveCards?.() ?? [],
    );
    const matches = cards.filter((c) =>
      authoritativeName === undefined
        ? cardKeywordMatch(message, c.name)
        : authoritativeCardNameMatch(authoritativeName, c.name),
    );
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
      reply:
        authoritativeName === undefined
          ? chooseCardBillMessage()
          : cardBillNoMatchMessage(
              authoritativeName,
              cards.map((card) => card.name),
            ),
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

  const dateMatch = /^data\b\s*(.+)$/i.exec(trimmed);
  if (dateMatch !== null) {
    const parsedDate = explicitPaymentDate(dateMatch[1] as string, today);
    if (parsedDate.kind !== "valid") {
      const raw =
        parsedDate.kind === "invalid"
          ? parsedDate.raw
          : (dateMatch[1] as string).trim();
      return {
        state,
        reply: `A data de pagamento “${raw}” é inválida. Envie no formato DD/MM ou DD/MM/AAAA.`,
      };
    }
    const next: CardBillDraftInProgress = {
      ...draft,
      paidOn: parsedDate.iso,
    };
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
      paidOn: draft.paidOn ?? today,
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

  if (state.status === "installment_recovery_required") {
    return {
      state: { status: "cancelled", draft: state.draft },
      reply:
        "Não consigo confirmar este parcelamento antigo com segurança porque ele pode já ter sido salvo. Verifique suas compras parceladas; se ele não estiver lá, envie o lançamento novamente.",
    };
  }

  if (
    state.status === "installment_submission_started" ||
    state.status === "installment_outcome_uncertain"
  ) {
    if (CONFIRM_RE.test(message)) {
      return confirmInstallment(
        state,
        deps,
        options.today ?? state.draft.occurredOn,
        message,
      );
    }
    return {
      state,
      reply:
        "Ainda estou verificando se essa compra já foi salva. Não posso editar nem cancelar agora; confirme novamente para concluir sem duplicar.",
      keyboard: installmentReconciliationKeyboard(),
    };
  }

  const today = options.today ?? state.draft.occurredOn;

  if (state.status === "awaiting_category_name") {
    return applyCategoryName(state, message, deps);
  }
  if (state.status === "awaiting_mark_paid_choice") {
    return applyMarkPaidChoice(state, message, deps, today);
  }
  if (state.status === "awaiting_payment_choice") {
    const normalized = normalizeText(message);
    const candidate = state.paymentCandidates?.find((item) => {
      const prefix = item.type === "account" ? "conta" : "credito";
      return normalized === normalizeText(`${prefix} ${item.name}`);
    });
    const stillActive =
      candidate?.type === "account"
        ? deps.listActiveAccounts?.().some((item) => item.id === candidate.id)
        : candidate?.type === "card"
          ? deps.listActiveCards?.().some((item) => item.id === candidate.id)
          : false;
    if (candidate === undefined || !stillActive) {
      return {
        state,
        reply: "Escolha uma das opções de pagamento abaixo.",
        keyboard: keyboardForState(state),
      };
    }
    const draft = { ...state.draft };
    if (candidate.type === "card") {
      draft.cardId = candidate.id;
      draft.accountId = undefined;
    } else {
      draft.accountId = candidate.id;
      draft.cardId = undefined;
    }
    draft.description = stripSelectedInstrumentFromDescription(
      draft.description,
      candidate.name,
    );
    const next: ConversationState = {
      ...state,
      status: statusForDraft(draft),
      draft,
      paymentCandidates: undefined,
    };
    return {
      state: next,
      reply: replyForState(next, deps),
      keyboard: keyboardForState(next),
    };
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
      ? {
          proposedCategoryName: undefined,
          proposedSubcategory: undefined,
          categoryCandidates: undefined,
        }
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

async function createOrReuseSubcategory(
  proposal: PendingSubcategoryProposal,
  deps: ConversationDeps,
): Promise<{
  categoryId: string;
  subcategoryId: string;
  reused: boolean;
} | null> {
  if (
    deps.listAllSubcategories === undefined ||
    deps.createSubcategory === undefined
  ) {
    return null;
  }
  const wanted = normalizeText(proposal.subcategoryName);
  const existing = await deps.listAllSubcategories();
  const match = existing.find(
    (subcategory) =>
      subcategory.categoryId === proposal.categoryId &&
      normalizeText(subcategory.name) === wanted,
  );
  if (match !== undefined) {
    if (!match.isActive) {
      await deps.restoreSubcategory?.(
        match.id,
        proposal.categoryId,
        match.name,
      );
    }
    return {
      categoryId: proposal.categoryId,
      subcategoryId: match.id,
      reused: true,
    };
  }
  const created = await deps.createSubcategory(
    proposal.categoryId,
    proposal.subcategoryName,
  );
  return {
    categoryId: proposal.categoryId,
    subcategoryId: created.id,
    reused: false,
  };
}

async function applyPendingTaxonomyToDraft(
  state: ConversationState,
  deps: ConversationDeps,
): Promise<{
  state: ConversationState;
  draft: DraftInProgress;
  categoryId: string;
  subcategoryId?: string;
} | null> {
  if (
    state.proposedCategoryName !== undefined &&
    state.draft.categoryId === undefined
  ) {
    const resolved = await createOrReuseCategory(
      state.proposedCategoryName,
      deps,
    );
    if (resolved === null) {
      return null;
    }
    const draft: DraftInProgress = {
      ...state.draft,
      categoryId: resolved.categoryId,
      subcategoryId: undefined,
      categoryNameFallback: state.proposedCategoryName,
    };
    return {
      state: {
        ...state,
        draft,
        proposedCategoryName: undefined,
        proposedSubcategory: undefined,
        categoryCandidates: undefined,
      },
      draft,
      categoryId: resolved.categoryId,
    };
  }

  if (state.proposedSubcategory !== undefined) {
    const resolved = await createOrReuseSubcategory(
      state.proposedSubcategory,
      deps,
    );
    if (resolved === null) {
      return null;
    }
    const draft: DraftInProgress = {
      ...state.draft,
      categoryId: resolved.categoryId,
      subcategoryId: resolved.subcategoryId,
      categoryNameFallback: state.proposedSubcategory.categoryName,
      categoryExplanation: "Subcategoria criada pelo usuário.",
    };
    return {
      state: {
        ...state,
        draft,
        proposedCategoryName: undefined,
        proposedSubcategory: undefined,
        categoryCandidates: undefined,
      },
      draft,
      categoryId: resolved.categoryId,
      subcategoryId: resolved.subcategoryId,
    };
  }

  return null;
}

async function resolvePendingTaxonomy(
  state: ConversationState,
  deps: ConversationDeps,
): Promise<{
  categoryId: string;
  subcategoryId?: string;
  categoryNameFallback?: string;
  explanation: string;
} | null> {
  if (state.proposedCategoryName !== undefined) {
    const resolved = await createOrReuseCategory(
      state.proposedCategoryName,
      deps,
    );
    if (resolved === null) {
      return null;
    }
    return {
      categoryId: resolved.categoryId,
      categoryNameFallback: state.proposedCategoryName,
      explanation: "Categoria criada pelo usuário.",
    };
  }
  if (state.proposedSubcategory !== undefined) {
    const resolved = await createOrReuseSubcategory(
      state.proposedSubcategory,
      deps,
    );
    if (resolved === null) {
      return null;
    }
    return {
      categoryId: resolved.categoryId,
      subcategoryId: resolved.subcategoryId,
      categoryNameFallback: state.proposedSubcategory.categoryName,
      explanation: "Subcategoria criada pelo usuário.",
    };
  }
  return null;
}

async function applyPendingTaxonomyToObligation(
  state: ConversationState,
  deps: ConversationDeps,
): Promise<{
  state: ConversationState;
  draft: ObligationDraftInProgress;
} | null> {
  const draft = state.obligationDraft;
  if (draft === undefined || taxonomyProposalLabel(state) === undefined) {
    return null;
  }
  const resolved = await resolvePendingTaxonomy(state, deps);
  if (resolved === null) {
    return null;
  }
  const nextDraft: ObligationDraftInProgress = {
    ...draft,
    categoryId: resolved.categoryId,
    subcategoryId: resolved.subcategoryId,
    categoryExplanation: resolved.explanation,
  };
  return {
    state: {
      ...state,
      obligationDraft: nextDraft,
      proposedCategoryName: undefined,
      proposedSubcategory: undefined,
      categoryCandidates: undefined,
    },
    draft: nextDraft,
  };
}

async function applyPendingTaxonomyToInstallment(
  state: ConversationState,
  deps: ConversationDeps,
): Promise<{
  state: ConversationState;
  draft: InstallmentDraftInProgress;
} | null> {
  const draft = state.installmentDraft;
  if (draft === undefined || taxonomyProposalLabel(state) === undefined) {
    return null;
  }
  const resolved = await resolvePendingTaxonomy(state, deps);
  if (resolved === null) {
    return null;
  }
  const nextDraft: InstallmentDraftInProgress = {
    ...draft,
    categoryId: resolved.categoryId,
    subcategoryId: resolved.subcategoryId,
    categoryExplanation: resolved.explanation,
  };
  return {
    state: {
      ...state,
      installmentDraft: nextDraft,
      proposedCategoryName: undefined,
      proposedSubcategory: undefined,
      categoryCandidates: undefined,
    },
    draft: nextDraft,
  };
}

/**
 * Confirm the draft. With a pending AI taxonomy proposal and enough data to
 * save: create/reuse it, assign it, persist through the normal `persist`, then
 * seed categorization_memory (the ONLY path that seeds — spec §3).
 */
async function confirmDraft(
  state: ConversationState,
  deps: ConversationDeps,
  messageText: string,
  today: string,
): Promise<ConversationOutcome> {
  let working = state;
  if (
    taxonomyProposalLabel(state) !== undefined &&
    state.draft.amountCents !== undefined
  ) {
    const resolved = await applyPendingTaxonomyToDraft(state, deps);
    if (resolved === null) {
      // Taxonomy creation is not wired here — keep the draft, explain.
      return { state, reply: notUnderstoodMessage() };
    }
    working = resolved.state;

    const outcome = await persist(working, deps, messageText);
    // Seed only after the transaction is durable; seeding is an optimization
    // and must never make a saved lançamento look failed to the user.
    const pattern = normalizeText(resolved.draft.description);
    if (
      outcome.state.status === "saved" &&
      deps.seedCategorizationMemory !== undefined &&
      pattern.length > 0
    ) {
      try {
        await deps.seedCategorizationMemory({
          pattern,
          categoryId: resolved.categoryId,
          ...(resolved.subcategoryId === undefined
            ? {}
            : { subcategoryId: resolved.subcategoryId }),
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
  if (state.status === "installment_recovery_required") {
    return {
      state: { status: "cancelled", draft: state.draft },
      reply:
        "Não consigo confirmar este parcelamento antigo com segurança porque ele pode já ter sido salvo. Verifique suas compras parceladas; se ele não estiver lá, envie o lançamento novamente.",
    };
  }
  if (
    state.status === "installment_submission_started" ||
    state.status === "installment_outcome_uncertain"
  ) {
    if (token === TOKENS.confirm) {
      const depsValue = await getDeps();
      return confirmInstallment(
        state,
        depsValue,
        today,
        "confirmar reconciliação (botão)",
      );
    }
    return {
      state,
      reply:
        "Ainda estou verificando se essa compra já foi salva. Não posso editar nem cancelar agora; toque em verificar para concluir sem duplicar.",
      keyboard: installmentReconciliationKeyboard(),
      toast: "Confirmação pendente — verifique para concluir.",
    };
  }

  if (state.status === "awaiting_payment_choice") {
    const candidates = state.paymentCandidates ?? [];
    const requestedType = token.startsWith(PAYMENT_ACCOUNT_TOKEN_PREFIX)
      ? "account"
      : token.startsWith(PAYMENT_CARD_TOKEN_PREFIX)
        ? "card"
        : undefined;
    if (requestedType === undefined) return expiredOutcome(state);
    const prefix =
      requestedType === "account"
        ? PAYMENT_ACCOUNT_TOKEN_PREFIX
        : PAYMENT_CARD_TOKEN_PREFIX;
    const id = token.slice(prefix.length);
    const candidate = candidates.find(
      (item) => item.type === requestedType && item.id === id,
    );
    if (candidate === undefined) return expiredOutcome(state);
    const depsValue = await getDeps();
    const stillActive =
      candidate.type === "account"
        ? depsValue.listActiveAccounts?.().some((item) => item.id === id)
        : depsValue.listActiveCards?.().some((item) => item.id === id);
    if (!stillActive) return expiredOutcome(state);
    const draft = { ...state.draft };
    if (candidate.type === "card") {
      draft.cardId = id;
      draft.accountId = undefined;
    } else {
      draft.accountId = id;
      draft.cardId = undefined;
    }
    draft.description = stripSelectedInstrumentFromDescription(
      draft.description,
      candidate.name,
    );
    const next: ConversationState = {
      ...state,
      status: statusForDraft(draft),
      draft,
      paymentCandidates: undefined,
    };
    return {
      state: next,
      reply: replyForState(next, depsValue),
      keyboard: keyboardForState(next),
    };
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
      const next: InstallmentDraftInProgress = {
        ...draft,
        cardId,
        cardClosingDay: card.closingDay,
        description: stripSelectedInstrumentFromDescription(
          draft.description,
          card.name,
        ),
      };
      const nextState: ConversationState = { ...state, installmentDraft: next };
      return {
        state: nextState,
        reply: installmentConfirmationMessage(
          installmentSummaryView(next, depsValue, taxonomyProposalLabel(state)),
        ),
        keyboard:
          taxonomyProposalLabel(state) !== undefined
            ? installmentConfirmationKeyboard(taxonomyProposalLabel(state))
            : installmentConfirmationKeyboard(
                undefined,
                state.categoryCandidates,
              ),
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
        proposedSubcategory: undefined,
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
        proposedSubcategory: undefined,
        categoryCandidates: undefined,
      };
      return {
        state: nextState,
        reply: `${correctionAppliedMessage("a categoria")}\n\n${installmentConfirmationMessage(installmentSummaryView(next, depsValue))}`,
        keyboard: installmentConfirmationKeyboard(),
      };
    }
    if (token === TOKENS.acceptProposal) {
      if (taxonomyProposalLabel(state) === undefined) {
        return expiredOutcome(state);
      }
      const depsValue = await getDeps();
      const resolved = await applyPendingTaxonomyToInstallment(
        state,
        depsValue,
      );
      if (resolved === null) {
        return { state, reply: notUnderstoodMessage() };
      }
      return {
        state: resolved.state,
        reply: installmentConfirmationMessage(
          installmentSummaryView(resolved.draft, depsValue),
        ),
        keyboard: installmentConfirmationKeyboard(),
      };
    }
    if (token === TOKENS.dropProposal) {
      if (taxonomyProposalLabel(state) === undefined) {
        return expiredOutcome(state);
      }
      const depsValue = await getDeps();
      const nextState: ConversationState = {
        ...state,
        proposedCategoryName: undefined,
        proposedSubcategory: undefined,
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
  // does (validate + createObligation, or cancel). Category choices update the
  // obligation draft without persisting it.
  if (state.status === "awaiting_obligation_confirmation") {
    const obligationDraft = state.obligationDraft;
    if (obligationDraft === undefined) return expiredOutcome(state);
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
      const index = Number(
        token.slice(CATEGORY_SUGGESTION_TOKEN_PREFIX.length),
      );
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
      const nextDraft = {
        ...obligationDraft,
        categoryId: candidate.categoryId,
        subcategoryId: candidate.subcategoryId,
        categoryExplanation: candidate.explanation,
      };
      const nextState: ConversationState = {
        ...state,
        obligationDraft: nextDraft,
        categoryCandidates: undefined,
        proposedCategoryName: undefined,
        proposedSubcategory: undefined,
      };
      return {
        state: nextState,
        reply: `${correctionAppliedMessage("a categoria")}\n\n${obligationConfirmationMessage(obligationSummaryView(nextDraft, depsValue))}`,
        keyboard: obligationConfirmationKeyboard(),
      };
    }
    if (token.startsWith(CATEGORY_TOKEN_PREFIX)) {
      const depsValue = await getDeps();
      const categoryId = token.slice(CATEGORY_TOKEN_PREFIX.length);
      const category = depsValue.catalog.categories.find(
        (item) => item.id === categoryId,
      );
      if (!category) return expiredOutcome(state);
      const nextDraft = {
        ...obligationDraft,
        categoryId: category.id,
        subcategoryId: undefined,
        categoryExplanation: "Categoria escolhida manualmente.",
      };
      const nextState: ConversationState = {
        ...state,
        obligationDraft: nextDraft,
        categoryCandidates: undefined,
        proposedCategoryName: undefined,
        proposedSubcategory: undefined,
      };
      return {
        state: nextState,
        reply: `${correctionAppliedMessage("a categoria")}\n\n${obligationConfirmationMessage(obligationSummaryView(nextDraft, depsValue))}`,
        keyboard: obligationConfirmationKeyboard(),
      };
    }
    if (token === TOKENS.acceptProposal) {
      if (taxonomyProposalLabel(state) === undefined) {
        return expiredOutcome(state);
      }
      const depsValue = await getDeps();
      const resolved = await applyPendingTaxonomyToObligation(state, depsValue);
      if (!resolved) return { state, reply: notUnderstoodMessage() };
      return {
        state: resolved.state,
        reply: obligationConfirmationMessage(
          obligationSummaryView(resolved.draft, depsValue),
        ),
        keyboard: obligationConfirmationKeyboard(),
      };
    }
    if (token === TOKENS.dropProposal) {
      if (taxonomyProposalLabel(state) === undefined) {
        return expiredOutcome(state);
      }
      const nextState: ConversationState = {
        ...state,
        proposedCategoryName: undefined,
        proposedSubcategory: undefined,
      };
      return {
        state: nextState,
        reply: obligationConfirmationMessage(
          obligationSummaryView(obligationDraft, await getDeps()),
        ),
        keyboard: obligationConfirmationKeyboard(
          undefined,
          state.categoryCandidates,
        ),
      };
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
        proposedSubcategory: undefined,
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
      proposedSubcategory: undefined,
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
    if (taxonomyProposalLabel(state) === undefined) {
      return expiredOutcome(state);
    }
    const depsValue = await getDeps();
    const outcome = await confirmDraft(
      state,
      depsValue,
      `confirmar (botão, nova taxonomia "${taxonomyProposalLabel(state)}")`,
      today,
    );
    return { ...outcome, keyboard: keyboardForState(outcome.state) };
  }
  if (token === TOKENS.dropProposal) {
    if (taxonomyProposalLabel(state) === undefined) {
      return expiredOutcome(state);
    }
    const depsValue = await getDeps();
    const next: ConversationState = {
      ...state,
      proposedCategoryName: undefined,
      proposedSubcategory: undefined,
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
