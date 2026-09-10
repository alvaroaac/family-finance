/**
 * "Este mês" checklist — the page's main job: what still has to be paid.
 *
 * Server component. Unpaid entries come first, ordered by due day and washed
 * by their `dueStatus`; paid ones sink to the bottom, faded, each with an undo.
 */

import type { ReactElement } from "react";

import { Badge, Card } from "../../../components/ui";
import { formatBrlCents, monthLabelPtBr } from "../../../lib/format";
import type { ObligationActionResult } from "./actions";
import { ObligationPaymentDialog } from "./payment-dialog";
import type { ObligationsData } from "./queries";
import { UndoPaymentButton } from "./undo-payment-button";
import { dueBadgeLabel, dueStatus, monthAbbrPtBr } from "./view-model";

type ActionFn = (formData: FormData) => Promise<ObligationActionResult>;

const ROW_TONE: Record<string, string> = {
  overdue: " ff-checklist__row--overdue",
  today: " ff-checklist__row--warn",
  tomorrow: " ff-checklist__row--warn",
  soon: " ff-checklist__row--warn",
};

/** "2026-09-01" -> "1º de set" (pt-BR uses the ordinal only for day one). */
function paidOnLabel(paidOn: string): string {
  const day = Number(paidOn.slice(8, 10));
  const monthAbbr = monthAbbrPtBr(paidOn.slice(0, 7)).split("/")[0];
  return `${day === 1 ? "1º" : day} de ${monthAbbr}`;
}

export function ThisMonthCard({
  data,
  today,
  accountName,
  categoryName,
  markPaidAction,
  undoAction,
}: {
  data: ObligationsData;
  today: string;
  accountName: (id: string) => string;
  categoryName: (id: string | null) => string | null;
  markPaidAction: ActionFn;
  undoAction: ActionFn;
}): ReactElement {
  const byId = new Map(data.obligations.map((o) => [o.id, o]));
  const unpaid = [...data.thisMonth.unpaid].sort((a, b) => a.dueDay - b.dueDay);
  const dueCents = unpaid.reduce((sum, e) => sum + e.amountCents, 0);

  return (
    <Card className="ff-oblig-panel">
      <div className="ff-panel__head ff-oblig-panel__head">
        <h2 className="ff-h2">Este mês · {monthLabelPtBr(data.month)}</h2>
        {unpaid.length > 0 ? (
          <span className="ff-note">
            {unpaid.length === 1 ? "1 a pagar" : `${unpaid.length} a pagar`} ·{" "}
            <strong className="ff-num">{formatBrlCents(dueCents)}</strong>
          </span>
        ) : null}
      </div>

      {unpaid.length === 0 && data.thisMonth.paid.length === 0 ? (
        <p className="ff-muted ff-oblig-panel__note">Nada vence este mês.</p>
      ) : null}

      <div className="ff-checklist">
        {unpaid.map((entry) => {
          const status = dueStatus(data.month, entry.dueDay, today);
          const badge = dueBadgeLabel(status);
          const category = categoryName(
            byId.get(entry.obligationId)?.categoryId ?? null,
          );
          const account = accountName(entry.accountId);
          return (
            <div
              className={`ff-checklist__row${ROW_TONE[status.kind] ?? ""}`}
              key={entry.obligationId}
            >
              <span className="ff-checklist__day">
                <span className="ff-checklist__day-label">DIA</span>
                <span className="ff-checklist__day-number ff-num">
                  {String(entry.dueDay).padStart(2, "0")}
                </span>
              </span>
              <div className="ff-checklist__body">
                <div className="ff-name">{entry.description}</div>
                <div className="ff-name-sub">
                  {category === null ? account : `${category} · ${account}`}
                </div>
              </div>
              {badge === null ? (
                <span />
              ) : (
                <Badge tone={status.kind === "overdue" ? "negative" : "warn"}>
                  {badge}
                </Badge>
              )}
              <div className="ff-oblig-cell--amount ff-num">
                {formatBrlCents(entry.amountCents)}
              </div>
              <div className="ff-oblig-cell--action">
                <ObligationPaymentDialog
                  obligationId={entry.obligationId}
                  month={entry.month}
                  description={entry.description}
                  projectedAmountCents={entry.amountCents}
                  action={markPaidAction}
                />
              </div>
            </div>
          );
        })}

        {data.thisMonth.paid.map((payment) => {
          const account = accountName(
            byId.get(payment.obligationId)?.accountId ?? "",
          );
          return (
            <div
              className="ff-checklist__row ff-checklist__row--paid"
              key={payment.transactionId}
            >
              <span className="ff-checklist__day ff-checklist__day--paid">
                <svg
                  aria-hidden="true"
                  fill="none"
                  height="20"
                  stroke="currentColor"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth="2"
                  viewBox="0 0 24 24"
                  width="20"
                >
                  <path d="M5 12.5 L10 17 L19 7.5" />
                </svg>
              </span>
              <div className="ff-checklist__body">
                <div className="ff-name">{payment.description}</div>
                <div className="ff-name-sub">
                  {payment.paidOn === null
                    ? `Paga neste mês · ${account}`
                    : `Paga em ${paidOnLabel(payment.paidOn)} · ${account}`}
                </div>
              </div>
              <Badge tone="positive">paga</Badge>
              <div className="ff-oblig-cell--amount ff-num">
                {formatBrlCents(payment.amountCents)}
              </div>
              <div className="ff-oblig-cell--action">
                <UndoPaymentButton
                  transactionId={payment.transactionId}
                  description={payment.description}
                  action={undoAction}
                />
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}
