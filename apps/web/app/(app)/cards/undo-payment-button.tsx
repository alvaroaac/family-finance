"use client";

import type { ReactElement } from "react";

import { Button } from "../../../components/ui";
import { undoCardBillPaymentAction } from "./actions";
import { CardBillActionError, useCardBillAction } from "./card-bill-action";

/** `Desfazer` on a registered fatura payment — deletes that payment row. */
export function UndoPaymentButton({
  transactionId,
  label,
}: {
  transactionId: string;
  /** The payment row's text, so screen readers know which one is undone. */
  label: string;
}): ReactElement {
  const { state, pending, onSubmit } = useCardBillAction(
    undoCardBillPaymentAction,
  );

  return (
    <form onSubmit={onSubmit} className="ff-fatura__undo">
      <input type="hidden" name="transactionId" value={transactionId} />
      <Button
        type="submit"
        variant="link"
        disabled={pending}
        ariaLabel={`Desfazer pagamento ${label}`}
      >
        {pending ? "Desfazendo…" : "Desfazer"}
      </Button>
      <CardBillActionError state={state} />
    </form>
  );
}
