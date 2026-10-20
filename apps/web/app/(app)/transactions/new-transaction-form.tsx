"use client";

import { useEffect, useId, useRef, useState, useTransition } from "react";
import { currentHouseholdDate } from "@family-finance/domain";

import {
  TransactionFields,
  emptyTransactionFieldValues,
  toTransactionFormData,
  validateTransactionFields,
  type CategoryOption,
  type PaymentOption,
  type ResponsibleOption,
  type SubcategoryOption,
  type TransactionFieldKey,
  type TransactionFieldValues,
} from "../../../components/transaction-fields";
import { Button, useToast } from "../../../components/ui";
import { createManualTransactionAction } from "./actions";

/**
 * Focused "Novo lançamento" modal for /transactions. Client-side pre-checks
 * give instant pt-BR feedback, but the server action re-validates everything
 * through the domain draft/card-purchase flow.
 */

export function NewTransactionForm({
  accounts,
  cards,
  categories,
  subcategories,
  responsibles,
  initiallyOpen,
}: {
  accounts: PaymentOption[];
  cards: PaymentOption[];
  categories: CategoryOption[];
  subcategories: SubcategoryOption[];
  responsibles: ResponsibleOption[];
  initiallyOpen: boolean;
}) {
  const toast = useToast();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const [open, setOpen] = useState(initiallyOpen);
  const [isSaving, startTransition] = useTransition();
  const options = { accounts, cards, categories, subcategories, responsibles };
  const [values, setValues] = useState(() =>
    emptyTransactionFieldValues(options, currentHouseholdDate()),
  );
  const [fieldError, setFieldError] = useState<string | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!open || dialog === null || dialog.open) {
      return;
    }
    dialog.showModal();
  }, [open]);

  function changeField<K extends TransactionFieldKey>(
    key: K,
    value: TransactionFieldValues[K],
  ) {
    setValues((current) => ({ ...current, [key]: value }));
  }

  function reset() {
    setValues(emptyTransactionFieldValues(options, currentHouseholdDate()));
    setFieldError(null);
  }

  function openDialog() {
    setOpen(true);
  }

  function closeDialog() {
    dialogRef.current?.close();
    setOpen(false);
    setFieldError(null);
  }

  function save() {
    const invalid = validateTransactionFields(values);
    if (invalid !== null) {
      setFieldError(invalid);
      return;
    }
    setFieldError(null);
    startTransition(async () => {
      const formData = toTransactionFormData(values);
      const result = await createManualTransactionAction(formData);
      if (!result.ok) {
        const message = result.error ?? "Não foi possível salvar o lançamento.";
        setFieldError(message);
        toast.error(message);
      } else {
        toast.success(
          formData.get("purchaseMode") === "parcelado"
            ? "Compra parcelada salva."
            : "Lançamento salvo.",
        );
        reset();
        closeDialog();
      }
    });
  }

  if (!open) {
    return (
      <div style={{ marginTop: 16 }}>
        <Button variant="primary" type="button" onClick={openDialog}>
          + Lançamento
        </Button>
      </div>
    );
  }

  return (
    <div style={{ marginTop: 16 }}>
      <dialog
        ref={dialogRef}
        className="ff-dialog ff-dialog--transaction"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        onClose={() => setOpen(false)}
        onClick={(event) => {
          if (event.target === event.currentTarget) closeDialog();
        }}
      >
        <div className="ff-dialog__surface">
          <div className="ff-dialog__header">
            <div>
              <div className="ff-kicker">Novo lançamento</div>
              <h2 id={titleId} className="ff-dialog__title ff-serif">
                Registrar despesa ou entrada
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
            Preencha os dados do lançamento. Se escolher um cartão, selecione se
            a compra foi à vista ou parcelada.
          </p>

          <TransactionFields
            values={values}
            onChange={changeField}
            options={options}
          />

          {fieldError !== null ? (
            <div role="alert" className="ff-alert ff-alert--negative">
              {fieldError}
            </div>
          ) : null}

          <div className="ff-dialog__actions">
            <Button
              variant="ghost"
              type="button"
              disabled={isSaving}
              onClick={closeDialog}
            >
              Cancelar
            </Button>
            <Button
              variant="primary"
              type="button"
              loading={isSaving}
              loadingText="Salvando…"
              onClick={save}
            >
              Salvar lançamento
            </Button>
          </div>
        </div>
      </dialog>
    </div>
  );
}
