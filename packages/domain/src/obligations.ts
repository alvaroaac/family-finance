import { z } from "zod";
import type { CategoryRef } from "./categories.js";
import type { Responsibility } from "./transactions.js";
import type { DomainResult, ValidationError } from "./transactions.js";

/**
 * Recurring fixed obligations (financings, mortgage, bills).
 *
 * An obligation is a TEMPLATE, not a set of rows: one record holds the monthly
 * amount, start month, term (fixed count or indefinite) and due day. The
 * dashboard PROJECTS which months it hits (computed — no materialized rows),
 * and marking a month paid materializes exactly one real transaction linked
 * back to the obligation. This handles a 72× solar financing and an
 * open-ended bill uniformly without writing hundreds of rows up front.
 *
 * The projection engine (`projectObligations`) is DB-unaware and generic over
 * a month window so future projection sources (scheduled income, recurring
 * charges) can reuse the same month-range core.
 */

export type ObligationStatus = "active" | "ended" | "canceled";

export type ObligationDraft = {
  householdId: string;
  description: string;
  /** Monthly amount in integer BRL cents (> 0). */
  amountCents: number;
  /** First month due, as `YYYY-MM`. */
  startMonth: string;
  /** Fixed term in months (e.g. 72), or null = indefinite. */
  termMonths: number | null;
  /** Day of month the payment is due (1–28, consistent with closingDay). */
  dueDay: number;
  category: CategoryRef;
  responsibility: Responsibility;
  /** Payment source account — needed to materialize a payment. */
  accountId: string;
  createdByUserId: string;
};

export type CreateObligationInput = {
  householdId: string;
  description: string;
  amountCents: number;
  startMonth: string;
  termMonths?: number | null;
  dueDay: number;
  accountId: string;
  createdByUserId: string;
  responsibleUserId?: string;
  category?: CategoryRef;
};

const YEAR_MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

const createObligationInputSchema = z.object({
  householdId: z.string().min(1),
  description: z.string(),
  amountCents: z.number(),
  startMonth: z.string(),
  termMonths: z.number().nullish(),
  dueDay: z.number(),
  accountId: z.string().min(1),
  createdByUserId: z.string().min(1),
  responsibleUserId: z.string().min(1).optional(),
  category: z
    .object({
      categoryId: z.string().min(1).optional(),
      subcategoryId: z.string().min(1).optional(),
    })
    .optional(),
});

function parseYearMonth(value: string): { year: number; month: number } {
  const match = YEAR_MONTH.exec(value);
  if (match === null) {
    throw new Error(`Invalid month "${value}", expected YYYY-MM`);
  }
  const [year, month] = value
    .split("-")
    .map((part) => Number.parseInt(part, 10)) as [number, number];
  return { year, month };
}

/**
 * Add `offset` whole months to a `YYYY-MM` string, DST-free. Same integer
 * month math as `addMonths` in installments.ts: attribution is to a month,
 * not a day, so generation is stable across month lengths.
 */
export function addMonthsYm(month: string, offset: number): string {
  const { year, month: month1Based } = parseYearMonth(month);
  const zeroBasedTotal = month1Based - 1 + offset;
  const newYear = year + Math.floor(zeroBasedTotal / 12);
  const newMonth0 = ((zeroBasedTotal % 12) + 12) % 12;
  return `${newYear}-${String(newMonth0 + 1).padStart(2, "0")}`;
}

/**
 * Last month an obligation is due: `startMonth + termMonths - 1`, or null for
 * an indefinite obligation.
 */
export function obligationEndMonth(
  startMonth: string,
  termMonths: number | null,
): string | null {
  if (termMonths === null) {
    return null;
  }
  return addMonthsYm(startMonth, termMonths - 1);
}

/**
 * Validate the free-form input into an `ObligationDraft`. Returns a structured
 * `DomainResult` (never throws for expected user errors), mirroring
 * `createInstallmentPlan`.
 */
export function createObligationDraft(
  input: CreateObligationInput,
): DomainResult<ObligationDraft> {
  const parsed = createObligationInputSchema.safeParse(input);
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

  if (!Number.isInteger(data.amountCents) || data.amountCents <= 0) {
    errors.push({
      field: "amountCents",
      code: "amount_not_positive",
      message: "amountCents must be a positive integer number of cents.",
    });
  }

  if (!YEAR_MONTH.test(data.startMonth)) {
    errors.push({
      field: "startMonth",
      code: "invalid_month",
      message: "startMonth must be a valid YYYY-MM month.",
    });
  }

  if (
    data.termMonths !== null &&
    data.termMonths !== undefined &&
    (!Number.isInteger(data.termMonths) || data.termMonths < 1)
  ) {
    errors.push({
      field: "termMonths",
      code: "invalid_term",
      message: "termMonths must be a positive integer or null (indefinite).",
    });
  }

  if (!Number.isInteger(data.dueDay) || data.dueDay < 1 || data.dueDay > 28) {
    errors.push({
      field: "dueDay",
      code: "invalid_due_day",
      message: "dueDay must be an integer between 1 and 28.",
    });
  }

  const description = data.description.trim();
  if (description.length === 0) {
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

  const category: CategoryRef = {
    categoryId: data.category?.categoryId,
    subcategoryId: data.category?.subcategoryId,
  };

  return {
    ok: true,
    value: {
      householdId: data.householdId,
      description,
      amountCents: data.amountCents,
      startMonth: data.startMonth,
      termMonths: data.termMonths ?? null,
      dueDay: data.dueDay,
      category,
      responsibility,
      accountId: data.accountId,
      createdByUserId: data.createdByUserId,
    },
  };
}

/** The minimal obligation shape the projector needs (DB row or draft alike). */
export type ProjectableObligation = {
  id: string;
  description: string;
  amountCents: number;
  startMonth: string;
  termMonths: number | null;
  dueDay: number;
  accountId: string;
  status: ObligationStatus;
};

/** One computed (not persisted) obligation hit in a month. */
export type ProjectedEntry = {
  obligationId: string;
  /** `YYYY-MM` the entry is attributed to. */
  month: string;
  amountCents: number;
  description: string;
  dueDay: number;
  accountId: string;
};

/** Stable key for a settled `(obligationId, month)` pair. */
export function paidKey(obligationId: string, month: string): string {
  return `${obligationId}:${month}`;
}

/** Whole months between two `YYYY-MM` values (b - a). */
function monthDiff(a: string, b: string): number {
  const pa = parseYearMonth(a);
  const pb = parseYearMonth(b);
  return (pb.year - pa.year) * 12 + (pb.month - pa.month);
}

/**
 * DB-unaware projection over a month window.
 *
 * For each ACTIVE obligation, emits one `ProjectedEntry` per month in
 * `[fromMonth, toMonth]` intersected with the obligation's own
 * `[startMonth, endMonth]` window, skipping `(obligationId, month)` pairs the
 * caller marks as already paid (see `paidKey`) — that is the anti-double-count
 * rule: a materialized month shows the actual, never the projection too.
 * Output is sorted by month, then description.
 */
export function projectObligations(
  obligations: ProjectableObligation[],
  options: {
    fromMonth: string;
    toMonth: string;
    paid?: ReadonlySet<string>;
  },
): ProjectedEntry[] {
  const windowLength = monthDiff(options.fromMonth, options.toMonth) + 1;
  if (windowLength <= 0) {
    return [];
  }
  const paid = options.paid ?? new Set<string>();

  const entries: ProjectedEntry[] = [];
  for (const obligation of obligations) {
    if (obligation.status !== "active") {
      continue;
    }
    const endMonth = obligationEndMonth(
      obligation.startMonth,
      obligation.termMonths,
    );
    for (let offset = 0; offset < windowLength; offset += 1) {
      const month = addMonthsYm(options.fromMonth, offset);
      if (monthDiff(obligation.startMonth, month) < 0) {
        continue; // Before the obligation starts.
      }
      if (endMonth !== null && monthDiff(month, endMonth) < 0) {
        continue; // After the fixed term ends.
      }
      if (paid.has(paidKey(obligation.id, month))) {
        continue; // Already materialized — the actual owns this month.
      }
      entries.push({
        obligationId: obligation.id,
        month,
        amountCents: obligation.amountCents,
        description: obligation.description,
        dueDay: obligation.dueDay,
        accountId: obligation.accountId,
      });
    }
  }

  entries.sort((a, b) =>
    a.month === b.month
      ? a.description.localeCompare(b.description)
      : a.month.localeCompare(b.month),
  );
  return entries;
}
