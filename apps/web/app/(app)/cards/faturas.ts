/**
 * Data for the "Faturas" section of /cards. Both views read the shared db
 * read models (`getCardFaturaPairs` / `getCardBillOverview`), the same ones
 * /resumo and the bot use, so the three never disagree.
 */

import {
  getCardBillOverview,
  getCardFaturaPairs,
  type AppSupabaseClient,
  type CardBillOverview,
  type CreditCardRow,
} from "@family-finance/db";

export type FaturasView = {
  /** null = default "Faturas de agora" view (fatura pair per card). */
  month: string | null;
  cards: Array<{ card: CreditCardRow; faturas: CardBillOverview[] }>;
};

/** `?fatura=YYYY-MM` → that month; anything else → null, the default view (C30). */
export function parseFaturaParam(
  value: string | string[] | undefined,
): string | null {
  return typeof value === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(value)
    ? value
    : null;
}

/**
 * Default view: per card the pending closed fatura (when any) above the open
 * one (P9). Month view: one fatura per card for that month.
 */
export async function loadFaturasView(
  client: AppSupabaseClient,
  householdId: string,
  month: string | null,
  todaySp: string,
): Promise<FaturasView> {
  if (month !== null) {
    const overviews = await getCardBillOverview(
      client,
      householdId,
      month,
      todaySp,
    );
    return {
      month,
      cards: overviews.map((overview) => ({
        card: overview.card,
        faturas: [overview],
      })),
    };
  }
  const pairs = await getCardFaturaPairs(client, householdId, todaySp);
  return {
    month: null,
    cards: pairs.map(({ card, pending, open }) => ({
      card,
      faturas: pending === null ? [open] : [pending, open],
    })),
  };
}
