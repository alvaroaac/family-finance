import { z } from "zod";

/**
 * Financial instruments for the MVP. Kept deliberately simple: one checking
 * concept, one investment concept, investment buckets (caixinhas), and credit
 * cards that can carry installments.
 */

/** Account kinds: conta corrente and conta investimento. */
export type AccountKind = "checking" | "investment";

export const accountKindSchema = z.enum(["checking", "investment"]);

export type Account = {
  id: string;
  householdId: string;
  kind: AccountKind;
  name: string;
};

/**
 * Investment bucket (caixinha). Buckets are free-form per household: the
 * household names each one after its goal, and the slug derived from that
 * name identifies it within the household.
 */
export type InvestmentBucket = {
  id: string;
  householdId: string;
  slug: string;
  name: string;
};

/**
 * Derive a bucket slug from its name: lowercase, accents removed, runs of
 * non-alphanumeric characters become `_`, and leading/trailing `_` trimmed.
 * "Independência Financeira" -> "independencia_financeira". A name without
 * letters or digits yields "".
 */
export function slugifyBucketName(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/** Credit card used for expenses and installment purchases. */
export type CreditCard = {
  id: string;
  householdId: string;
  name: string;
  /** Day of month the invoice closes (1-31), optional in the MVP. */
  closingDay?: number;
  /** Day of month the invoice is due (1-31), optional in the MVP. */
  dueDay?: number;
};

export const creditCardSchema = z.object({
  id: z.string().min(1),
  householdId: z.string().min(1),
  name: z.string().min(1),
  closingDay: z.number().int().min(1).max(31).optional(),
  dueDay: z.number().int().min(1).max(31).optional(),
});
