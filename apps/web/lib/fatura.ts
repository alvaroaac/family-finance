/** Presentation helpers shared by the fatura blocks on /cards and /resumo. */

import type { CardBillStatus } from "@family-finance/domain";

import type { BadgeTone } from "../components/ui";

/** Paid reads positive, a closed fatura still owing reads warn, the rest neutral. */
export function faturaBadgeTone(status: CardBillStatus): BadgeTone {
  if (status === "paid") return "positive";
  if (status === "closed_unpaid" || status === "closed_partial") return "warn";
  return "neutral";
}

/** "2026-09" -> "09/2026". */
export function faturaMonthLabel(month: string): string {
  const [year, monthNumber] = month.split("-");
  return `${monthNumber}/${year}`;
}

/** "2026-09" -> "09" (Resumo's short "Fatura 09 · fechada"). */
export function faturaMonthNumber(month: string): string {
  return month.slice(5, 7);
}
