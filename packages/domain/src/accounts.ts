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
 * Investment bucket (caixinha). MVP buckets: filhos, casa, and
 * independencia financeira/aposentadoria. The slug is stable for code;
 * the display name may be Portuguese.
 */
export type InvestmentBucketSlug =
  | "filhos"
  | "casa"
  | "independencia_financeira";

export const investmentBucketSlugSchema = z.enum([
  "filhos",
  "casa",
  "independencia_financeira",
]);

export type InvestmentBucket = {
  id: string;
  householdId: string;
  slug: InvestmentBucketSlug;
  name: string;
};

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
