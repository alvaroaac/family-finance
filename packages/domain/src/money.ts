import { z } from "zod";

/**
 * Money is stored as integer BRL cents only. The MVP is single-currency (BRL),
 * so the currency tag is fixed but kept explicit for clarity and future-proofing.
 *
 * Never store money as a floating-point number of reais. All arithmetic must
 * happen on the integer `cents` field to avoid rounding drift.
 */
export type Currency = "BRL";

export type MoneyAmount = {
  currency: Currency;
  cents: number;
};

export const moneyAmountSchema = z.object({
  currency: z.literal("BRL"),
  cents: z.number().int(),
});

/** Build a BRL money amount from an integer number of cents. */
export function brl(cents: number): MoneyAmount {
  return { currency: "BRL", cents };
}

/** Zero BRL. */
export const ZERO_BRL: MoneyAmount = brl(0);

/** True when the amount is a valid, finite integer number of cents. */
export function isValidMoney(amount: MoneyAmount): boolean {
  return Number.isInteger(amount.cents) && Number.isFinite(amount.cents);
}

/** Add two BRL amounts. */
export function addMoney(a: MoneyAmount, b: MoneyAmount): MoneyAmount {
  return brl(a.cents + b.cents);
}

/** Subtract `b` from `a` (BRL). */
export function subtractMoney(a: MoneyAmount, b: MoneyAmount): MoneyAmount {
  return brl(a.cents - b.cents);
}

/**
 * Split an amount of cents into `parts` integer parts that always sum back to
 * the original total. Earlier parts absorb the remainder cent-by-cent so the
 * sum is exact (e.g. 100 cents / 3 -> [34, 33, 33]).
 */
export function splitCents(totalCents: number, parts: number): number[] {
  if (!Number.isInteger(totalCents)) {
    throw new Error("splitCents requires an integer cents total");
  }
  if (!Number.isInteger(parts) || parts <= 0) {
    throw new Error("splitCents requires a positive integer number of parts");
  }

  const sign = totalCents < 0 ? -1 : 1;
  const abs = Math.abs(totalCents);
  const base = Math.floor(abs / parts);
  const remainder = abs - base * parts;

  const result: number[] = [];
  for (let i = 0; i < parts; i += 1) {
    const extra = i < remainder ? 1 : 0;
    result.push(sign * (base + extra));
  }
  return result;
}
