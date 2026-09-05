"use client";

import { useId, useRef, useState, useTransition } from "react";
import type { ReactElement, ReactNode, RefObject } from "react";

import { useToast } from "../../../components/ui";
import type { ObligationActionResult } from "./actions";

/**
 * The pieces "Nova obrigação" and "Editar obrigação" share: the native modal
 * `<dialog>` (open/close + backdrop click + labelled header), the pt-BR error
 * block, and the hook that runs one obligation server action with toasts.
 *
 * Lives under `app/` on purpose — it knows the obligations actions, so it would
 * break the `components/ui/` design firewall.
 */

/** One account or category offered by the obligation dialogs. */
export type OptionItem = { id: string; name: string };

const FALLBACK_ERROR = "Não foi possível salvar a obrigação.";

export type ObligationDialogHandle = {
  ref: RefObject<HTMLDialogElement | null>;
  titleId: string;
  descriptionId: string;
  open: () => void;
  close: () => void;
};

/** Imperative handle for the dialog element plus the ids that label it. */
export function useObligationDialog(
  initialFocusRef?: RefObject<HTMLInputElement | null>,
): ObligationDialogHandle {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  return {
    ref,
    titleId,
    descriptionId,
    open: () => {
      ref.current?.showModal();
      requestAnimationFrame(() => initialFocusRef?.current?.focus());
    },
    close: () => ref.current?.close(),
  };
}

/** The 720px modal shell; a click on the backdrop closes it. */
export function ObligationDialogShell({
  dialog,
  onClose,
  children,
}: {
  dialog: ObligationDialogHandle;
  onClose?: () => void;
  children: ReactNode;
}): ReactElement {
  return (
    <dialog
      ref={dialog.ref}
      className="ff-dialog ff-dialog--transaction"
      aria-labelledby={dialog.titleId}
      aria-describedby={dialog.descriptionId}
      onClose={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) dialog.close();
      }}
    >
      {children}
    </dialog>
  );
}

/**
 * Kicker + serif title + × close, as two siblings of the surface grid.
 * `description` renders the paragraph the dialog's `aria-describedby` points
 * at; dialogs that leave it out must put `dialog.descriptionId` on the text
 * that describes them instead.
 */
export function ObligationDialogHeader({
  dialog,
  kicker,
  title,
  description,
}: {
  dialog: ObligationDialogHandle;
  kicker: string;
  title: string;
  description?: string;
}): ReactElement {
  return (
    <>
      <div className="ff-dialog__header">
        <div>
          <div className="ff-kicker">{kicker}</div>
          <h2 id={dialog.titleId} className="ff-dialog__title ff-serif">
            {title}
          </h2>
        </div>
        <button
          type="button"
          className="ff-dialog__close"
          aria-label="Fechar"
          onClick={dialog.close}
        >
          ×
        </button>
      </div>
      {description === undefined ? null : (
        <p id={dialog.descriptionId} className="ff-dialog__description">
          {description}
        </p>
      )}
    </>
  );
}

/** The dialog's single pt-BR complaint, announced to screen readers. */
export function ObligationDialogError({
  message,
}: {
  message: string | null;
}): ReactElement | null {
  return message === null ? null : (
    <div role="alert" className="ff-alert ff-alert--negative">
      {message}
    </div>
  );
}

export type ObligationActionRunner = {
  pending: boolean;
  error: string | null;
  setError: (message: string | null) => void;
  run: (
    send: () => Promise<ObligationActionResult>,
    onSuccess: () => void,
  ) => void;
};

/**
 * Runs one obligation server action. A refusal keeps the dialog open with the
 * message in its alert block and in a toast; success toasts `successMessage`
 * and hands control back to the caller.
 */
export function useObligationAction(
  successMessage: string,
): ObligationActionRunner {
  const toast = useToast();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function run(
    send: () => Promise<ObligationActionResult>,
    onSuccess: () => void,
  ): void {
    if (pending) return;
    setError(null);
    startTransition(async () => {
      const result = await send();
      if (!result.ok) {
        const message = result.error ?? FALLBACK_ERROR;
        setError(message);
        toast.error(message);
        return;
      }
      toast.success(successMessage);
      onSuccess();
    });
  }

  return { pending, error, setError, run };
}

/** Strictly numeric text field -> number; "12abc" and "" are not numbers. */
export function toPositiveInt(value: string): number | null {
  if (!/^\d+$/.test(value.trim())) return null;
  const parsed = Number.parseInt(value, 10);
  return parsed < 1 ? null : parsed;
}

/** The first shared pt-BR field complaint, in submission order. */
export function obligationFieldComplaint({
  description,
  amountCents,
  dueDay,
  accountId,
}: {
  description: string;
  amountCents: number | null;
  dueDay: number | null;
  accountId: string;
}): string | null {
  if (amountCents === null || amountCents <= 0) {
    return 'Não entendi o valor — use algo como "710,44".';
  }
  if (description.trim() === "") {
    return "O nome não pode ficar vazio.";
  }
  if (dueDay === null || dueDay > 28) {
    return "Escolha o dia do vencimento, de 1 a 28.";
  }
  if (accountId === "") {
    return "Escolha a conta de onde a obrigação sai.";
  }
  return null;
}
