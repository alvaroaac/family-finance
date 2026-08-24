import { z } from "zod";
import type { MoneyAmount } from "./money.js";
import { brl, moneyAmountSchema, splitCents } from "./money.js";
import type { CategoryRef } from "./categories.js";
import type { Responsibility } from "./transactions.js";
import type { DomainResult, ValidationError } from "./transactions.js";

/**
 * Installments support dashboard projections without a full invoice system.
 * A card purchase that is parcelado creates one `InstallmentGroup` (the
 * compra-mãe / parent purchase) plus N monthly `Installment` records. Each
 * installment carries the month it lands in so the dashboard can sum
 * "this month's installments" by `dueMonth` alone.
 */

export type InstallmentGroupDraft = {
  householdId: string;
  creditCardId: string;
  description: string;
  /** Total purchase amount (sum of all installments). */
  totalAmount: MoneyAmount;
  installmentCount: number;
  /** ISO date (YYYY-MM-DD) of the original purchase. */
  purchasedOn: string;
  category: CategoryRef;
  responsibility: Responsibility;
  createdByUserId: string;
};

export type InstallmentDraft = {
  householdId: string;
  creditCardId: string;
  /** 1-based position of this installment within the group. */
  number: number;
  installmentCount: number;
  amount: MoneyAmount;
  /** Year-month the installment is attributed to, as `YYYY-MM`. */
  dueMonth: string;
  description: string;
  category: CategoryRef;
  responsibility: Responsibility;
  createdByUserId: string;
};

/** A parent group together with its generated monthly installments. */
export type InstallmentPlan = {
  group: InstallmentGroupDraft;
  installments: InstallmentDraft[];
};

export type CreateInstallmentPlanInput = {
  householdId: string;
  creditCardId: string;
  description: string;
  totalAmount: MoneyAmount;
  installmentCount: number;
  purchasedOn: string;
  createdByUserId: string;
  responsibleUserId?: string;
  category?: CategoryRef;
  /**
   * Card statement closing day (1–31). When set, a purchase made AFTER this
   * day lands on the next month's invoice, so the first `dueMonth` shifts by
   * one month (spec §2.6). In shorter months, days 29–31 mean the month's last
   * calendar day. Omitted → first dueMonth is the purchase month.
   */
  closingDay?: number;
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const createInstallmentPlanInputSchema = z.object({
  householdId: z.string().min(1),
  creditCardId: z.string().min(1),
  description: z.string(),
  totalAmount: moneyAmountSchema,
  installmentCount: z.number(),
  purchasedOn: z.string(),
  createdByUserId: z.string().min(1),
  responsibleUserId: z.string().min(1).optional(),
  category: z
    .object({
      categoryId: z.string().min(1).optional(),
      subcategoryId: z.string().min(1).optional(),
    })
    .optional(),
  closingDay: z.number().int().min(1).max(31).optional(),
});

function parseIsoDateParts(
  value: string,
): { year: number; month: number; day: number } | null {
  if (!ISO_DATE.test(value)) {
    return null;
  }
  const [year, month, day] = value
    .split("-")
    .map((part) => Number.parseInt(part, 10));
  if (year === undefined || month === undefined || day === undefined) {
    return null;
  }
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return { year, month, day };
}

/**
 * Add `offset` whole months to a year/month, returning a stable `YYYY-MM`
 * string. Day-of-month is intentionally dropped: installments are attributed
 * to a month, not a day, which keeps generation stable across month lengths
 * (no Jan-31 -> Mar-3 drift) and lets the dashboard group by month directly.
 */
function addMonths(year: number, month1Based: number, offset: number): string {
  const zeroBasedTotal = month1Based - 1 + offset;
  const newYear = year + Math.floor(zeroBasedTotal / 12);
  const newMonth0 = ((zeroBasedTotal % 12) + 12) % 12;
  const mm = String(newMonth0 + 1).padStart(2, "0");
  return `${newYear}-${mm}`;
}

/** Resolve configured days 29–31 safely in months that end earlier. */
function closingDayInMonth(
  year: number,
  month1Based: number,
  closingDay: number,
): number {
  const lastDayOfMonth = new Date(Date.UTC(year, month1Based, 0)).getUTCDate();
  return Math.min(closingDay, lastDayOfMonth);
}

/**
 * Pure generator for a parcelado card purchase.
 *
 * Returns a structured `DomainResult`. The number of installments must be a
 * positive integer; a count of 1 is à vista (single installment in the
 * purchase month). The total is split into integer cents so the installments
 * always sum back exactly to the total (earlier parcels absorb the remainder).
 *
 * Due months are stable and contiguous starting at the purchase month:
 * purchaseMonth, +1, +2, ... so the dashboard can project upcoming card
 * pressure by month without modeling invoices.
 */
export function createInstallmentPlan(
  input: CreateInstallmentPlanInput,
): DomainResult<InstallmentPlan> {
  const parsed = createInstallmentPlanInputSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((issue) => ({
        field: issue.path.join(".") || "root",
        code: issue.code,
        message: issue.message,
      })),
    };
  }

  const data = parsed.data;
  const errors: ValidationError[] = [];

  if (!Number.isInteger(data.installmentCount) || data.installmentCount < 1) {
    errors.push({
      field: "installmentCount",
      code: "invalid_installment_count",
      message: "installmentCount must be a positive integer (1 = à vista).",
    });
  }

  if (
    !Number.isInteger(data.totalAmount.cents) ||
    data.totalAmount.cents <= 0
  ) {
    errors.push({
      field: "totalAmount.cents",
      code: "amount_not_positive",
      message: "totalAmount must be a positive integer number of cents.",
    });
  }

  if (data.description.trim().length === 0) {
    errors.push({
      field: "description",
      code: "description_required",
      message: "Description is required.",
    });
  }

  const dateParts = parseIsoDateParts(data.purchasedOn);
  if (dateParts === null) {
    errors.push({
      field: "purchasedOn",
      code: "invalid_date",
      message: "purchasedOn must be a valid ISO date (YYYY-MM-DD).",
    });
  }

  if (errors.length > 0 || dateParts === null) {
    return { ok: false, errors };
  }

  const responsibility: Responsibility =
    data.responsibleUserId === undefined
      ? { scope: "household" }
      : { scope: "user", userId: data.responsibleUserId };

  const category: CategoryRef = {
    categoryId: data.category?.categoryId,
    subcategoryId: data.category?.subcategoryId,
  };

  const description = data.description.trim();

  const group: InstallmentGroupDraft = {
    householdId: data.householdId,
    creditCardId: data.creditCardId,
    description,
    totalAmount: { currency: "BRL", cents: data.totalAmount.cents },
    installmentCount: data.installmentCount,
    purchasedOn: data.purchasedOn,
    category,
    responsibility,
    createdByUserId: data.createdByUserId,
  };

  const perInstallmentCents = splitCents(
    data.totalAmount.cents,
    data.installmentCount,
  );

  // Invoice timing (spec §2.6): buying after the card's closing day pushes the
  // purchase onto the NEXT invoice, so every dueMonth shifts by one month.
  // A purchase on the effective closing day still belongs to the current one.
  const effectiveClosingDay =
    data.closingDay === undefined
      ? undefined
      : closingDayInMonth(dateParts.year, dateParts.month, data.closingDay);
  const offsetBase =
    effectiveClosingDay !== undefined && dateParts.day > effectiveClosingDay
      ? 1
      : 0;

  const installments: InstallmentDraft[] = perInstallmentCents.map(
    (cents, index) => ({
      householdId: data.householdId,
      creditCardId: data.creditCardId,
      number: index + 1,
      installmentCount: data.installmentCount,
      amount: brl(cents),
      dueMonth: addMonths(dateParts.year, dateParts.month, offsetBase + index),
      description,
      category,
      responsibility,
      createdByUserId: data.createdByUserId,
    }),
  );

  return { ok: true, value: { group, installments } };
}
