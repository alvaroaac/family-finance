"use client";

import { useId, useRef, useState, useTransition } from "react";

import type { ObligationActionResult } from "./actions";

import { Button, Field, Input, useToast } from "../../../components/ui";

type ObligationPaymentDialogProps = {
  obligationId: string;
  month: string;
  description: string;
  projectedAmountCents: number;
  action: (formData: FormData) => Promise<ObligationActionResult>;
};

function amountInputValue(amountCents: number): string {
  return (amountCents / 100).toFixed(2).replace(".", ",");
}

export function ObligationPaymentDialog({
  obligationId,
  month,
  description,
  projectedAmountCents,
  action,
}: ObligationPaymentDialogProps): React.ReactElement {
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const amountRef = useRef<HTMLInputElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  function openDialog(): void {
    dialogRef.current?.showModal();
    requestAnimationFrame(() => amountRef.current?.select());
  }

  function closeDialog(): void {
    dialogRef.current?.close();
  }

  return (
    <>
      <Button onClick={openDialog}>Marcar como paga</Button>
      <dialog
        ref={dialogRef}
        className="ff-dialog"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        onClose={() => {
          formRef.current?.reset();
          setError(null);
        }}
        onClick={(event) => {
          if (event.target === event.currentTarget) closeDialog();
        }}
      >
        <form
          ref={formRef}
          onSubmit={(event) => {
            event.preventDefault();
            if (pending) return;
            const formData = new FormData(event.currentTarget);
            setError(null);
            startTransition(async () => {
              const result = await action(formData);
              if (!result.ok) {
                const message =
                  result.error ?? "Não foi possível salvar a obrigação.";
                setError(message);
                toast.error(message);
              } else {
                // onClose resets the form; the toast is the only feedback
                // left once the dialog is gone.
                toast.success("Pagamento registrado.");
                closeDialog();
              }
            });
          }}
          className="ff-dialog__surface"
        >
          <input type="hidden" name="obligationId" value={obligationId} />
          <input type="hidden" name="month" value={month} />

          <div className="ff-dialog__header">
            <div>
              <div className="ff-kicker">Registrar pagamento</div>
              <h2 id={titleId} className="ff-dialog__title ff-serif">
                {description}
              </h2>
            </div>
            <button
              type="button"
              className="ff-dialog__close"
              aria-label="Fechar"
              onClick={closeDialog}
            >
              ×
            </button>
          </div>

          <p id={descriptionId} className="ff-dialog__description">
            Confirme o valor realmente pago neste mês. A previsão dos próximos
            meses não será alterada.
          </p>

          <Field label="Valor pago (R$)">
            <Input
              ref={amountRef}
              type="text"
              name="amount"
              inputMode="decimal"
              defaultValue={amountInputValue(projectedAmountCents)}
              required
              aria-describedby={`${descriptionId}-amount`}
            />
          </Field>
          <div id={`${descriptionId}-amount`} className="ff-dialog__hint">
            Valor previsto preenchido automaticamente; ajuste se o valor real
            foi diferente.
          </div>

          {error !== null ? (
            <div role="alert" className="ff-alert ff-alert--negative">
              {error}
            </div>
          ) : null}
          <div className="ff-dialog__actions">
            <Button type="button" onClick={closeDialog}>
              Cancelar
            </Button>
            <Button variant="primary" type="submit" disabled={pending}>
              {pending ? "Registrando…" : "Confirmar pagamento"}
            </Button>
          </div>
        </form>
      </dialog>
    </>
  );
}
