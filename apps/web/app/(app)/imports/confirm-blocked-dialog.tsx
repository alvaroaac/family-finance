"use client";

import { useEffect, useId, useRef } from "react";
import type { ReactElement } from "react";

import { Button } from "../../../components/ui";
import { blockedDialogCopy, type Pendencia } from "./confirm-blockers";

/**
 * "Ainda não dá pra gravar": the native modal that explains why Gravar could
 * not go through. The button never disables; this dialog is where the page
 * says what is missing and offers one action per item.
 */
export function ConfirmBlockedDialog({
  open,
  pendencias,
  selectedCount,
  onClose,
  onAction,
  onConfirmAnyway,
}: {
  open: boolean;
  pendencias: Pendencia[];
  selectedCount: number;
  onClose: () => void;
  onAction: (pendencia: Pendencia) => void;
  onConfirmAnyway: () => void;
}): ReactElement {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const copy = blockedDialogCopy(pendencias, selectedCount);

  useEffect(() => {
    const dialog = ref.current;
    if (dialog === null) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      className="ff-dialog ff-dialog--blocked"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      onClose={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="ff-dialog__surface">
        <div className="ff-dialog__header">
          <div>
            <div className="ff-kicker" style={{ letterSpacing: "0.26em" }}>
              Antes de gravar
            </div>
            <h2 id={titleId} className="ff-dialog__title ff-serif">
              {copy.title}
            </h2>
          </div>
          <button
            type="button"
            className="ff-dialog__close"
            aria-label="Fechar"
            onClick={onClose}
          >
            ×
          </button>
        </div>
        <p id={descriptionId} className="ff-dialog__description">
          {copy.lead}
        </p>
        <p className="ff-dialog__hint">
          O botão fica sempre ativo. Quando falta algo, a gente te conta aqui em
          vez de travar em silêncio.
        </p>
        <ol className="ff-pendencias">
          {pendencias.map((pendencia) => (
            <li
              key={pendencia.id}
              className={`ff-pendencia${pendencia.hard ? "" : " ff-pendencia--soft"}`}
            >
              <span className="ff-pendencia__mark" aria-hidden="true">
                {pendencia.hard ? "!" : "?"}
              </span>
              <span className="ff-pendencia__text">
                <strong>{pendencia.title}</strong>
                <span className="ff-pendencia__detail">{pendencia.detail}</span>
              </span>
              <Button variant="ghost" onClick={() => onAction(pendencia)}>
                {pendencia.action}
              </Button>
            </li>
          ))}
        </ol>
        <div className="ff-dialog__actions">
          <Button variant="ghost" onClick={onClose}>
            Fechar
          </Button>
          {copy.primary === "resolve" ? (
            <Button
              variant="primary"
              onClick={() => {
                const first = pendencias[0];
                if (first !== undefined) onAction(first);
              }}
            >
              Resolver a primeira
            </Button>
          ) : (
            <Button variant="primary" onClick={onConfirmAnyway}>
              Gravar mesmo assim
            </Button>
          )}
        </div>
      </div>
    </dialog>
  );
}
