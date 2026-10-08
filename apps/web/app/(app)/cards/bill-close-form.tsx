"use client";

import { useState, type ReactElement } from "react";

import { Button, Field, Input } from "../../../components/ui";
import { centsToInputValue } from "../../../lib/format";
import {
  closeCardBillAction,
  reopenCardBillAction,
  setCardBillTotalAction,
} from "./actions";
import { CardBillActionError, useCardBillAction } from "./card-bill-action";

type BillRef = { creditCardId: string; billMonth: string };

function BillRefFields({ creditCardId, billMonth }: BillRef): ReactElement {
  return (
    <>
      <input type="hidden" name="creditCardId" value={creditCardId} />
      <input type="hidden" name="billMonth" value={billMonth} />
    </>
  );
}

/**
 * Close / reopen / adjust total for one fatura. Open → `Fechar fatura`
 * reveals the total form prefilled with the live sum (an unchanged value
 * stores no override). Closed → `Reabrir` and `Ajustar total` (same form;
 * clearing the field returns to the live sum).
 */
export function BillCloseForm({
  creditCardId,
  billMonth,
  closed,
  totalCents,
}: BillRef & {
  closed: boolean;
  /** Open: the live sum. Closed: the corrected total when set, else the live sum. */
  totalCents: number;
}): ReactElement {
  const [editing, setEditing] = useState(false);
  const total = useCardBillAction(
    closed ? setCardBillTotalAction : closeCardBillAction,
    () => setEditing(false),
  );
  const reopen = useCardBillAction(reopenCardBillAction);

  return (
    <>
      {closed ? (
        <form onSubmit={reopen.onSubmit}>
          <BillRefFields creditCardId={creditCardId} billMonth={billMonth} />
          <Button type="submit" loading={reopen.pending}>
            Reabrir
          </Button>
        </form>
      ) : null}
      {editing ? null : (
        <Button onClick={() => setEditing(true)}>
          {closed ? "Ajustar total" : "Fechar fatura"}
        </Button>
      )}
      <CardBillActionError state={reopen.state} />
      {editing ? (
        <form onSubmit={total.onSubmit} className="ff-fatura__form">
          <BillRefFields creditCardId={creditCardId} billMonth={billMonth} />
          <div className="ff-form-grid">
            <Field label="Total da fatura">
              <Input
                type="text"
                name="total"
                inputMode="decimal"
                aria-label="Total da fatura"
                defaultValue={centsToInputValue(totalCents)}
              />
            </Field>
          </div>
          <CardBillActionError state={total.state} />
          <div className="ff-fatura__buttons">
            <Button
              type="submit"
              variant="primary"
              loading={total.pending}
              loadingText={closed ? "Salvando…" : "Fechando…"}
            >
              {closed ? "Salvar total" : "Confirmar fechamento"}
            </Button>
            <Button variant="link" onClick={() => setEditing(false)}>
              Cancelar
            </Button>
          </div>
        </form>
      ) : null}
    </>
  );
}
