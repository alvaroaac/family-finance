import type { InstallmentPlan } from "./installments.js";
import { addMonthsYm } from "./obligations.js";

/**
 * Fatura (card bill) rules. A fatura is named by the month it closes in
 * (`YYYY-MM`). Closed/open, totals, status and badge copy live here so web,
 * bot and db read models never disagree.
 */

/** Manual per-card+month override stored in `card_bill_closures`. */
export type CardBillOverrideState = "closed" | "open";

export type CardBillStatus =
  | "open"
  | "open_partial"
  | "open_covered"
  | "nothing_due"
  | "closed_unpaid"
  | "closed_partial"
  | "paid";

/** Longest run of consecutive closed faturas a new charge may skip. */
const MAX_CLOSED_MONTHS = 24;

function lastDayOfMonth(month: string): number {
  const [year, month1Based] = month.split("-").map(Number);
  return new Date(Date.UTC(year as number, month1Based as number, 0)).getUTCDate();
}

/** Closing date (`YYYY-MM-DD`) of a fatura; days 29–31 clamp to the month's last day. */
export function cardBillClosingDate(closingDay: number, month: string): string {
  const day = Math.min(closingDay, lastDayOfMonth(month));
  return `${month}-${String(day).padStart(2, "0")}`;
}

/**
 * A manual override wins; otherwise a fatura auto-closes once today is past
 * its closing date. A charge on the closing day itself still belongs to it,
 * and cards without a closing day never auto-close.
 */
export function isCardBillClosed(input: {
  closingDay: number | null;
  month: string;
  todaySp: string;
  override: CardBillOverrideState | null;
}): boolean {
  if (input.override !== null) {
    return input.override === "closed";
  }
  if (input.closingDay === null) {
    return false;
  }
  return input.todaySp > cardBillClosingDate(input.closingDay, input.month);
}

export type CardBillSummary = {
  closed: boolean;
  chargesCents: number;
  totalCents: number;
  totalOverrideCents: number | null;
  paidCents: number;
  remainingCents: number;
  overpaidCents: number;
  status: CardBillStatus;
};

function cardBillStatus(
  closed: boolean,
  totalCents: number,
  paidCents: number,
): CardBillStatus {
  if (closed) {
    if (paidCents === 0) {
      return totalCents === 0 ? "nothing_due" : "closed_unpaid";
    }
    return paidCents < totalCents ? "closed_partial" : "paid";
  }
  if (paidCents === 0) {
    return "open";
  }
  return paidCents < totalCents ? "open_partial" : "open_covered";
}

/**
 * The corrected total only applies once the fatura is closed; while open the
 * total is the live sum of charges. Paid is the sum of payment rows.
 */
export function summarizeCardBill(input: {
  closed: boolean;
  chargesCents: number;
  totalOverrideCents: number | null;
  paymentCents: number[];
}): CardBillSummary {
  const totalCents =
    input.closed && input.totalOverrideCents !== null
      ? input.totalOverrideCents
      : input.chargesCents;
  const paidCents = input.paymentCents.reduce((sum, cents) => sum + cents, 0);
  return {
    closed: input.closed,
    chargesCents: input.chargesCents,
    totalCents,
    totalOverrideCents: input.totalOverrideCents,
    paidCents,
    remainingCents: Math.max(0, totalCents - paidCents),
    overpaidCents: Math.max(0, paidCents - totalCents),
    status: cardBillStatus(input.closed, totalCents, paidCents),
  };
}

/** `R$ 1.234,56` with a regular space (the pt-BR formatter emits a no-break one). */
function formatBrl(cents: number): string {
  return (cents / 100)
    .toLocaleString("pt-BR", { style: "currency", currency: "BRL" })
    .replace(/\u00a0/g, " ");
}

/** Status badge copy, identical on /cards, /resumo and in the bot. */
export function cardBillBadge(summary: CardBillSummary): string {
  switch (summary.status) {
    case "open":
      return "aberta";
    case "open_partial":
      return `aberta · ${formatBrl(summary.paidCents)} pago`;
    case "open_covered":
      return "aberta · paga até agora";
    case "nothing_due":
      return "nada a pagar";
    case "closed_unpaid":
      return `fechada · a pagar ${formatBrl(summary.remainingCents)}`;
    case "closed_partial":
      return `fechada · parcial, falta ${formatBrl(summary.remainingCents)}`;
    case "paid":
      return summary.overpaidCents > 0
        ? `paga ✅ · ${formatBrl(summary.overpaidCents)} a mais`
        : "paga ✅";
  }
}

/** First fatura at or after `startMonth` that is not closed. Throws after 24 closed months. */
export function firstOpenInvoiceMonth(
  startMonth: string,
  isClosed: (month: string) => boolean,
): string {
  for (let offset = 0; offset < MAX_CLOSED_MONTHS; offset += 1) {
    const month = addMonthsYm(startMonth, offset);
    if (!isClosed(month)) {
      return month;
    }
  }
  throw new Error(
    `No open fatura within ${MAX_CLOSED_MONTHS} months of ${startMonth}`,
  );
}

/**
 * What "now" shows per card: the open fatura plus the previous one, only while
 * that one is closed and still has something to pay.
 */
export function cardFaturaPair<T extends { summary: CardBillSummary }>(input: {
  open: T;
  previous: T | null;
}): { pending: T | null; open: T } {
  const { previous } = input;
  const pending =
    previous !== null &&
    previous.summary.closed &&
    (previous.summary.status === "closed_unpaid" ||
      previous.summary.status === "closed_partial")
      ? previous
      : null;
  return { pending, open: input.open };
}

/** Move every parcel `months` faturas forward (first parcel was in a closed fatura). */
export function shiftInstallmentPlan(
  plan: InstallmentPlan,
  months: number,
): InstallmentPlan {
  return {
    group: plan.group,
    installments: plan.installments.map((installment) => ({
      ...installment,
      dueMonth: addMonthsYm(installment.dueMonth, months),
    })),
  };
}
