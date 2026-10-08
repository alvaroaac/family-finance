import { randomUUID } from "node:crypto";

import Link from "next/link";
import type { ReactElement } from "react";

import type { CardBillOverview } from "@family-finance/db";
import { cardBillBadge } from "@family-finance/domain";

import { Badge, Button, Card, Input } from "../../../components/ui";
import { faturaBadgeTone, faturaMonthLabel } from "../../../lib/fatura";
import { formatBrlCents } from "../../../lib/format";
import { BillCloseForm } from "./bill-close-form";
import { BillPaymentForm } from "./bill-payment-form";
import type { FaturasView } from "./faturas";
import { UndoPaymentButton } from "./undo-payment-button";

type AccountOption = { id: string; name: string };

/** "2026-10-28" -> "28/10". */
function dayMonth(isoDate: string): string {
  const [, month, day] = isoDate.split("-");
  return `${day}/${month}`;
}

/** "2026-10-06" -> "06/10/2026". */
function fullDate(isoDate: string): string {
  const [year, month, day] = isoDate.split("-");
  return `${day}/${month}/${year}`;
}

function Figure({
  label,
  cents,
}: {
  label: string;
  cents: number;
}): ReactElement {
  return (
    <div className="ff-fatura__figure">
      <dt>{label}</dt>
      <dd className="ff-num">{formatBrlCents(cents)}</dd>
    </div>
  );
}

function FaturaBlock({
  fatura,
  accounts,
  todaySp,
}: {
  fatura: CardBillOverview;
  accounts: AccountOption[];
  todaySp: string;
}): ReactElement {
  const { card, month, closingDate, summary, payments } = fatura;
  const accountNames = new Map(accounts.map((a) => [a.id, a.name]));
  const totalAdjusted = summary.closed && summary.totalOverrideCents !== null;

  return (
    <div className="ff-fatura">
      <div className="ff-fatura__head">
        <div>
          <h3 className="ff-fatura__title">Fatura {faturaMonthLabel(month)}</h3>
          <div className="ff-name-sub">
            {closingDate === null
              ? "sem dia de fechamento"
              : `fecha ${dayMonth(closingDate)}`}
          </div>
        </div>
        <Badge tone={faturaBadgeTone(summary.status)}>
          {cardBillBadge(summary)}
        </Badge>
      </div>

      <dl className="ff-fatura__figures">
        <Figure label="Total" cents={summary.totalCents} />
        <Figure label="Pago" cents={summary.paidCents} />
        <Figure label="Falta" cents={summary.remainingCents} />
      </dl>
      {totalAdjusted ? (
        <p className="ff-note ff-num">
          total ajustado (soma dos lançamentos:{" "}
          {formatBrlCents(summary.chargesCents)})
        </p>
      ) : null}

      {payments.length > 0 ? (
        <ul className="ff-fatura__payments">
          {payments.map((payment) => {
            const label = `${fullDate(payment.paidOn)} · ${
              accountNames.get(payment.accountId) ?? "conta"
            } · ${formatBrlCents(payment.amountCents)}`;
            return (
              <li key={payment.id} className="ff-fatura__payment">
                <span className="ff-num">{label}</span>
                <UndoPaymentButton transactionId={payment.id} label={label} />
              </li>
            );
          })}
        </ul>
      ) : null}

      <div className="ff-fatura__actions">
        {accounts.length === 0 ? (
          <p className="ff-note ff-fatura__hint">
            <Link href="/accounts" className="ff-link">
              Cadastre uma conta
            </Link>{" "}
            para registrar pagamentos.
          </p>
        ) : (
          <FaturaPaymentForm
            fatura={fatura}
            accounts={accounts}
            todaySp={todaySp}
          />
        )}
        <BillCloseForm
          creditCardId={card.id}
          billMonth={month}
          closed={summary.closed}
          totalCents={summary.totalCents}
        />
      </div>
    </div>
  );
}

/** A fresh idempotency key per server render; keying remounts the form on it. */
function FaturaPaymentForm({
  fatura,
  accounts,
  todaySp,
}: {
  fatura: CardBillOverview;
  accounts: AccountOption[];
  todaySp: string;
}): ReactElement {
  const idempotencyKey = randomUUID();
  const { summary } = fatura;
  return (
    <BillPaymentForm
      key={idempotencyKey}
      creditCardId={fatura.card.id}
      billMonth={fatura.month}
      remainingCents={summary.remainingCents}
      accounts={accounts}
      todaySp={todaySp}
      idempotencyKey={idempotencyKey}
      initiallyOpen={summary.closed && summary.remainingCents > 0}
    />
  );
}

/**
 * "Faturas" on /cards. Default view: per card the pending closed fatura (if
 * any) above the open one. `?fatura=YYYY-MM`: that month for every card.
 */
export function FaturasSection({
  view,
  accounts,
  todaySp,
}: {
  view: FaturasView;
  accounts: AccountOption[];
  todaySp: string;
}): ReactElement {
  return (
    <section className="ff-faturas" aria-labelledby="faturas-title">
      <div className="ff-faturas__head">
        <h2 id="faturas-title" className="ff-h2">
          {view.month === null
            ? "Faturas de agora"
            : `Faturas de ${faturaMonthLabel(view.month)}`}
        </h2>
        <form method="get" className="ff-faturas__picker">
          <Input
            type="month"
            name="fatura"
            aria-label="Mês da fatura"
            defaultValue={view.month ?? todaySp.slice(0, 7)}
            className="ff-input--compact"
            required
          />
          <Button type="submit">Ver</Button>
          {view.month === null ? null : (
            <Link href="/cards" className="ff-link">
              Voltar para agora
            </Link>
          )}
        </form>
      </div>

      <div className="ff-cards-grid">
        {view.cards.map(({ card, faturas }) => (
          <Card key={card.id}>
            <div className="ff-name ff-name--lg">{card.name}</div>
            {faturas.map((fatura) => (
              <FaturaBlock
                key={fatura.month}
                fatura={fatura}
                accounts={accounts}
                todaySp={todaySp}
              />
            ))}
          </Card>
        ))}
      </div>
    </section>
  );
}
