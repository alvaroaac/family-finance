"use client";

/**
 * "desfazer" on a paid checklist row — deletes the materialized transaction.
 *
 * A client wrapper exists because `undoObligationPaymentAction` returns
 * `{ ok, error? }` (so dialogs can show inline errors), which `<form action>`
 * does not accept. The shared runner handles the pending state and the
 * success/refusal toasts.
 */

import type { ReactElement } from "react";

import { Button } from "../../../components/ui";
import type { ObligationActionResult } from "./actions";
import { useObligationAction } from "./obligation-dialog-shell";

export function UndoPaymentButton({
  transactionId,
  description,
  action,
}: {
  transactionId: string;
  description: string;
  action: (formData: FormData) => Promise<ObligationActionResult>;
}): ReactElement {
  const runner = useObligationAction("Pagamento desfeito.");

  function undo(): void {
    const formData = new FormData();
    formData.set("transactionId", transactionId);
    runner.run(
      () => action(formData),
      () => undefined,
    );
  }

  return (
    <Button
      variant="link"
      onClick={undo}
      disabled={runner.pending}
      ariaLabel={`Desfazer pagamento de ${description}`}
    >
      {runner.pending ? "desfazendo…" : "desfazer"}
    </Button>
  );
}
