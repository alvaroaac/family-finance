import { z } from "zod";
import type { MoneyAmount } from "./money.js";
import { moneyAmountSchema } from "./money.js";
import type { CategoryRef } from "./categories.js";

/**
 * TransactionKind:
 * - `expense` (despesa) and `income` (receita) are the MVP kinds.
 * - `transfer` is reserved for future reserve/caixinha movements; the domain
 *   accepts the type but the MVP write paths focus on expense and income.
 */
export type TransactionKind = "expense" | "income" | "transfer";

export const transactionKindSchema = z.enum(["expense", "income", "transfer"]);

/**
 * How the transaction was paid. Cash/account money vs a credit card. A card
 * payment may be à vista (single) or parcelado (installments); that detail is
 * carried on the input, not on the stored draft kind.
 */
export type PaymentInstrument =
  | { type: "account"; accountId: string }
  | { type: "card"; creditCardId: string };

/**
 * Responsibility for a transaction.
 * - Defaults to the household (Casa) when no `responsibleUserId` is given.
 * - `user` carries the responsible person when an expense should not be
 *   treated purely as a shared house expense.
 */
export type Responsibility =
  | { scope: "household" }
  | { scope: "user"; userId: string };

export const HOUSEHOLD_RESPONSIBILITY: Responsibility = { scope: "household" };

/**
 * A validated, ready-to-persist transaction draft. This is the single shape
 * both the web app and the bot create transactions through. It does not carry
 * an `id` or timestamps — persistence assigns those.
 */
export type TransactionDraft = {
  householdId: string;
  kind: TransactionKind;
  amount: MoneyAmount;
  /** ISO date (YYYY-MM-DD) on which the transaction occurred. */
  occurredOn: string;
  description: string;
  category: CategoryRef;
  payment: PaymentInstrument;
  responsibility: Responsibility;
  /** User who launched the transaction (lançado por). Always recorded. */
  createdByUserId: string;
};

/** Input to create a transaction draft. Mirrors what UI/bot collect. */
export type CreateTransactionInput = {
  householdId: string;
  kind: TransactionKind;
  amount: MoneyAmount;
  occurredOn: string;
  description: string;
  createdByUserId: string;
  payment: PaymentInstrument;
  /** Optional. When omitted, responsibility defaults to the household. */
  responsibleUserId?: string;
  category?: CategoryRef;
};

/** One structured validation error. Field-addressable for UI/bot replies. */
export type ValidationError = {
  field: string;
  code: string;
  message: string;
};

/**
 * Result wrapper used by domain services. Expected user mistakes are returned
 * as `ok: false` with structured errors instead of thrown exceptions, so the
 * web app and bot can render field-level feedback the same way.
 */
export type DomainResult<T> =
  | { ok: true; value: T }
  | { ok: false; errors: ValidationError[] };

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isRealIsoDate(value: string): boolean {
  if (!ISO_DATE.test(value)) {
    return false;
  }
  const [y, m, d] = value.split("-").map((part) => Number.parseInt(part, 10));
  if (y === undefined || m === undefined || d === undefined) {
    return false;
  }
  const date = new Date(Date.UTC(y, m - 1, d));
  return (
    date.getUTCFullYear() === y &&
    date.getUTCMonth() === m - 1 &&
    date.getUTCDate() === d
  );
}

const paymentSchema = z.union([
  z.object({ type: z.literal("account"), accountId: z.string().min(1) }),
  z.object({ type: z.literal("card"), creditCardId: z.string().min(1) }),
]);

const createTransactionInputSchema = z.object({
  householdId: z.string().min(1),
  kind: transactionKindSchema,
  amount: moneyAmountSchema,
  occurredOn: z.string(),
  description: z.string(),
  createdByUserId: z.string().min(1),
  payment: paymentSchema,
  responsibleUserId: z.string().min(1).optional(),
  category: z
    .object({
      categoryId: z.string().min(1).optional(),
      subcategoryId: z.string().min(1).optional(),
    })
    .optional(),
});

function zodToValidationErrors(error: z.ZodError): ValidationError[] {
  return error.issues.map((issue) => ({
    field: issue.path.join(".") || "root",
    code: issue.code,
    message: issue.message,
  }));
}

/**
 * Pure creation helper for a transaction draft.
 *
 * Returns a structured `DomainResult` rather than throwing for expected user
 * mistakes (missing fields, non-positive amount, bad date, etc). Both the web
 * app and the bot call this so transaction rules live in exactly one place.
 *
 * Rules enforced:
 * - Amount must be a positive integer number of cents (money is BRL cents).
 * - `occurredOn` must be a real ISO date (YYYY-MM-DD).
 * - `description` must be non-empty.
 * - Responsibility defaults to the household unless `responsibleUserId` is set.
 * - `createdByUserId` is required and recorded.
 */
export function createTransactionDraft(
  input: CreateTransactionInput,
): DomainResult<TransactionDraft> {
  const parsed = createTransactionInputSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, errors: zodToValidationErrors(parsed.error) };
  }

  const errors: ValidationError[] = [];
  const data = parsed.data;

  if (!Number.isInteger(data.amount.cents) || data.amount.cents <= 0) {
    errors.push({
      field: "amount.cents",
      code: "amount_not_positive",
      message: "Amount must be a positive integer number of cents.",
    });
  }

  if (!isRealIsoDate(data.occurredOn)) {
    errors.push({
      field: "occurredOn",
      code: "invalid_date",
      message: "occurredOn must be a valid ISO date (YYYY-MM-DD).",
    });
  }

  if (data.description.trim().length === 0) {
    errors.push({
      field: "description",
      code: "description_required",
      message: "Description is required.",
    });
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const responsibility: Responsibility =
    data.responsibleUserId === undefined
      ? { scope: "household" }
      : { scope: "user", userId: data.responsibleUserId };

  const draft: TransactionDraft = {
    householdId: data.householdId,
    kind: data.kind,
    amount: { currency: "BRL", cents: data.amount.cents },
    occurredOn: data.occurredOn,
    description: data.description.trim(),
    category: {
      categoryId: data.category?.categoryId,
      subcategoryId: data.category?.subcategoryId,
    },
    payment: data.payment,
    responsibility,
    createdByUserId: data.createdByUserId,
  };

  return { ok: true, value: draft };
}

/** True when a draft is paid with a credit card. */
export function isCardPayment(draft: TransactionDraft): boolean {
  return draft.payment.type === "card";
}

const cardBillSettlementSchema = z.object({
  householdId: z.string().min(1),
  creditCardId: z.string().min(1),
  accountId: z.string().min(1),
  billMonth: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
  amountCents: z.number().int().positive(),
  paidOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  createdByUserId: z.string().min(1),
});

export type CardBillSettlementInput = z.input<typeof cardBillSettlementSchema>;

/**
 * A validated card-bill settlement: ONE kind='transfer' row with BOTH
 * instruments (account = source, card = destination) + bill_month as the
 * settled marker. The settle_card_bill RPC derives the row's description
 * from the card name — the draft intentionally has none.
 */
export type CardBillSettlementDraft = z.output<typeof cardBillSettlementSchema>;

export function createCardBillSettlement(
  input: CardBillSettlementInput,
): DomainResult<CardBillSettlementDraft> {
  const parsed = cardBillSettlementSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, errors: zodToValidationErrors(parsed.error) };
  }
  return { ok: true, value: parsed.data };
}
