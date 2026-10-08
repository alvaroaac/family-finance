"use client";

import { useState, type ReactElement } from "react";

import { Button, Field, Input, Select } from "../../../components/ui";
import { centsToInputValue } from "../../../lib/format";
import { payCardBillAction } from "./actions";
import { CardBillActionError, useCardBillAction } from "./card-bill-action";

/**
 * "Pagar fatura" for one card + fatura month. The parent keys this component
 * by `idempotencyKey` (a server `randomUUID()` per render): a double submit
 * replays the same key, and the revalidated page after a success remounts the
 * form with a fresh key and the new remaining amount.
 */
export function BillPaymentForm({
  creditCardId,
  billMonth,
  remainingCents,
  accounts,
  todaySp,
  idempotencyKey,
  initiallyOpen,
}: {
  creditCardId: string;
  billMonth: string;
  remainingCents: number;
  accounts: Array<{ id: string; name: string }>;
  todaySp: string;
  idempotencyKey: string;
  /** Show the form right away (a closed fatura still owing) instead of the button. */
  initiallyOpen: boolean;
}): ReactElement {
  const [open, setOpen] = useState(initiallyOpen);
  const { state, pending, onSubmit } = useCardBillAction(payCardBillAction);

  if (!open) {
    return <Button onClick={() => setOpen(true)}>Pagar fatura</Button>;
  }

  return (
    <form onSubmit={onSubmit} className="ff-fatura__form">
      <input type="hidden" name="creditCardId" value={creditCardId} />
      <input type="hidden" name="billMonth" value={billMonth} />
      <input type="hidden" name="idempotencyKey" value={idempotencyKey} />
      <div className="ff-form-grid">
        <Field label="Valor">
          <Input
            type="text"
            name="amount"
            inputMode="decimal"
            aria-label="Valor"
            defaultValue={
              remainingCents > 0 ? centsToInputValue(remainingCents) : ""
            }
            required
          />
        </Field>
        <Field label="Data do pagamento">
          <Input
            type="date"
            name="paidOn"
            aria-label="Data do pagamento"
            defaultValue={todaySp}
            max={todaySp}
            required
          />
        </Field>
        <Field label="Conta">
          <Select
            name="accountId"
            aria-label="Conta"
            defaultValue={accounts.length === 1 ? accounts[0]?.id : ""}
            required
          >
            {accounts.length === 1 ? null : <option value="">—</option>}
            {accounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.name}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <CardBillActionError state={state} />
      <div className="ff-fatura__buttons">
        <Button
          type="submit"
          variant="primary"
          loading={pending}
          loadingText="Registrando…"
        >
          Registrar pagamento
        </Button>
        {initiallyOpen ? null : (
          <Button variant="link" onClick={() => setOpen(false)}>
            Cancelar
          </Button>
        )}
      </div>
    </form>
  );
}
