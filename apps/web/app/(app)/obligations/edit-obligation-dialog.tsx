"use client";

import { useId, useRef, useState } from "react";
import type { ReactElement, ReactNode } from "react";

import { addMonthsYm } from "@family-finance/domain";

import {
  Button,
  Field,
  IconPencil,
  Input,
  Select,
  Spinner,
} from "../../../components/ui";
import {
  formatBrlCents,
  monthNamePtBr,
  parseReaisToCents,
} from "../../../lib/format";
import type { ObligationActionResult } from "./actions";
import {
  ObligationDialogError,
  ObligationDialogHeader,
  ObligationDialogShell,
  obligationFieldComplaint,
  toPositiveInt,
  useObligationAction,
  useObligationDialog,
  type OptionItem,
} from "./obligation-dialog-shell";
import type { ObligationListItem } from "./queries";
import { monthAbbrPtBr, type TermProgress } from "./view-model";

/**
 * "Editar obrigação" — the pencil on an obligation row.
 *
 * Prazo and first month are deliberately NOT editable: changing them would
 * rewrite months the household already paid, so a changed contract means
 * encerrar this obligation and create another. What the term is doing shows up
 * read-only at the top, and the danger zone at the bottom is the way out.
 *
 * Client pre-checks only give instant pt-BR feedback; `updateObligationAction`
 * re-parses and re-validates everything server-side.
 */

/** 238000 -> "2.380,00" — the pt-BR shape the amount field parses back. */
function amountInputValue(amountCents: number): string {
  return (amountCents / 100).toLocaleString("pt-BR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/** Which installment the current month is: 11 already paid -> "Parcela 12". */
function installmentNumber(elapsed: number, total: number): number {
  return Math.min(elapsed + 1, total);
}

/** Paid share of the term, elapsed / total, in percent. */
function elapsedPercent(elapsed: number, total: number): number {
  if (total === 0) return 0;
  return Math.round((elapsed / total) * 1000) / 10;
}

/** The term in one sentence — the same words the row and the timeline use. */
function termSentence(
  item: ObligationListItem,
  progress: TermProgress,
): ReactNode {
  switch (progress.kind) {
    case "running":
      return (
        <>
          Parcela{" "}
          <strong className="ff-num">
            {`${installmentNumber(progress.elapsed, progress.total)} de ${progress.total}`}
          </strong>
          {` · começou em ${monthAbbrPtBr(item.startMonth)} · termina em ${monthAbbrPtBr(progress.endMonth)}`}
        </>
      );
    case "indefinite":
      return `Sem prazo · desde ${monthAbbrPtBr(item.startMonth)}`;
    case "future":
      return `Começa em ${monthAbbrPtBr(progress.startMonth)}`;
  }
}

/** Read-only term panel: nothing in here can be edited (spec). */
function TermPanel({
  item,
  progress,
  noteId,
}: {
  item: ObligationListItem;
  progress: TermProgress;
  noteId: string;
}): ReactElement {
  return (
    <div className="ff-oblig-progress">
      <div>{termSentence(item, progress)}</div>
      {progress.kind === "running" ? (
        <>
          <div className="ff-oblig-progress__remaining ff-num">
            faltam {formatBrlCents(progress.remainingCents)}
          </div>
          <div className="ff-track ff-oblig-progress__wide">
            <div
              className="ff-track__fill"
              style={{
                width: `${elapsedPercent(progress.elapsed, progress.total)}%`,
              }}
            />
          </div>
        </>
      ) : null}
      <div id={noteId} className="ff-note ff-oblig-progress__wide">
        Prazo e primeiro mês não mudam — pra isso, encerre esta e crie outra.
      </div>
    </div>
  );
}

/** What encerrar does, from the next month on, in the household's words. */
function cancelSentence(
  item: ObligationListItem,
  progress: TermProgress,
  currentMonth: string,
): ReactNode {
  const paid =
    progress.kind === "running"
      ? installmentNumber(progress.elapsed, progress.total)
      : 0;
  const kept =
    paid === 0
      ? "O que já foi pago continua nas transações."
      : paid === 1
        ? "A parcela paga continua nas transações."
        : `As ${paid} parcelas pagas continuam nas transações.`;
  return (
    <>
      Encerrar <strong>{item.description}</strong>
      {`? A partir de ${monthNamePtBr(addMonthsYm(currentMonth, 1))}, esta obrigação sai dos próximos meses. ${kept}`}
    </>
  );
}

export function EditObligationDialog({
  item,
  progress,
  currentMonth,
  accounts,
  categories,
  updateAction,
  cancelAction,
}: {
  item: ObligationListItem;
  progress: TermProgress;
  currentMonth: string;
  accounts: OptionItem[];
  categories: OptionItem[];
  updateAction: (formData: FormData) => Promise<ObligationActionResult>;
  cancelAction: (formData: FormData) => Promise<ObligationActionResult>;
}): ReactElement {
  const descriptionRef = useRef<HTMLInputElement>(null);
  const dialog = useObligationDialog(descriptionRef);
  const amountHintId = useId();
  const save = useObligationAction("Obrigação atualizada.");
  const cancel = useObligationAction("Obrigação encerrada.");

  const pending = save.pending || cancel.pending;

  const [description, setDescription] = useState(item.description);
  const [amount, setAmount] = useState(amountInputValue(item.amountCents));
  const [dueDay, setDueDay] = useState(String(item.dueDay));
  const [accountId, setAccountId] = useState(item.accountId);
  const [categoryId, setCategoryId] = useState(item.categoryId ?? "");
  const [confirming, setConfirming] = useState(false);

  /** Back to what the household has saved — the dialog's `onClose`. */
  function reset(): void {
    setDescription(item.description);
    setAmount(amountInputValue(item.amountCents));
    setDueDay(String(item.dueDay));
    setAccountId(item.accountId);
    setCategoryId(item.categoryId ?? "");
    setConfirming(false);
    save.setError(null);
    cancel.setError(null);
  }

  /** The first pt-BR complaint the household should see, if any. */
  function preCheck(): string | null {
    const amountCents = parseReaisToCents(amount);
    const complaint = obligationFieldComplaint({
      description,
      amountCents,
      dueDay: toPositiveInt(dueDay),
      accountId,
    });
    return complaint;
  }

  function handleSubmit(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (pending) return;
    const complaint = preCheck();
    if (complaint !== null) {
      save.setError(complaint);
      return;
    }
    const formData = new FormData(event.currentTarget);
    save.run(() => updateAction(formData), dialog.close);
  }

  /** Encerrar posts only the id — it is not part of the edit form. */
  function handleCancelObligation(): void {
    if (pending) return;
    const formData = new FormData();
    formData.set("obligationId", item.id);
    cancel.run(() => cancelAction(formData), dialog.close);
  }

  return (
    <>
      <button
        type="button"
        className="ff-iconbtn"
        title="editar"
        aria-label={`Editar ${item.description}`}
        onClick={() => {
          reset();
          dialog.open();
        }}
      >
        <IconPencil size={14} />
      </button>
      <ObligationDialogShell dialog={dialog} onClose={reset}>
        <form
          className="ff-dialog__surface ff-oblig-edit"
          noValidate
          onSubmit={handleSubmit}
        >
          <input type="hidden" name="obligationId" value={item.id} />

          <ObligationDialogHeader
            dialog={dialog}
            kicker="Editar obrigação"
            title={item.description}
          />

          <TermPanel
            item={item}
            progress={progress}
            noteId={dialog.descriptionId}
          />

          <div className="ff-form-grid">
            <Field label="Nome">
              <Input
                name="description"
                ref={descriptionRef}
                value={description}
                required
                onChange={(event) => setDescription(event.target.value)}
              />
            </Field>
            <Field label="Valor por mês (R$)">
              <Input
                className="ff-num"
                name="amount"
                value={amount}
                inputMode="decimal"
                required
                aria-describedby={amountHintId}
                onChange={(event) => setAmount(event.target.value)}
              />
              <div id={amountHintId} className="ff-note ff-oblig-edit__hint">
                Vale para os meses ainda não pagos.
              </div>
            </Field>
          </div>

          <div className="ff-form-grid">
            <Field label="Vence todo dia">
              <Input
                className="ff-num"
                type="number"
                name="dueDay"
                min={1}
                max={28}
                step={1}
                value={dueDay}
                required
                onChange={(event) => setDueDay(event.target.value)}
              />
            </Field>
            <Field label="Conta">
              <Select
                name="accountId"
                value={accountId}
                required
                onChange={(event) => setAccountId(event.target.value)}
              >
                <option value="">Escolha a conta</option>
                {accounts.map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Categoria">
              <Select
                name="categoryId"
                value={categoryId}
                onChange={(event) => setCategoryId(event.target.value)}
              >
                <option value="">Sem categoria</option>
                {categories.map((category) => (
                  <option key={category.id} value={category.id}>
                    {category.name}
                  </option>
                ))}
              </Select>
            </Field>
          </div>

          <ObligationDialogError message={save.error} />

          <div className="ff-dialog__actions">
            <Button variant="ghost" disabled={pending} onClick={dialog.close}>
              Cancelar
            </Button>
            <Button
              variant="primary"
              type="submit"
              disabled={pending}
              loading={save.pending}
              loadingText="Salvando…"
            >
              Salvar alterações
            </Button>
          </div>

          <div className="ff-danger-zone">
            <div className="ff-danger-zone__head">
              <div>
                <div className="ff-name">Encerrar obrigação</div>
                <p className="ff-name-sub">
                  Some dos próximos meses. O que já foi pago continua nas
                  transações.
                </p>
              </div>
              <button
                type="button"
                className="ff-btn ff-btn--danger"
                aria-expanded={confirming}
                disabled={pending}
                onClick={() => setConfirming(true)}
              >
                Encerrar…
              </button>
            </div>

            {confirming ? (
              <div className="ff-danger-zone__confirm">
                <span className="ff-row-confirm__text">
                  {cancelSentence(item, progress, currentMonth)}
                </span>
                <button
                  type="button"
                  className="ff-btn ff-btn--ghost-sm"
                  disabled={pending}
                  onClick={() => setConfirming(false)}
                >
                  Deixa pra lá
                </button>
                <button
                  type="button"
                  className="ff-btn ff-btn--danger-solid"
                  disabled={pending}
                  onClick={handleCancelObligation}
                >
                  {cancel.pending ? (
                    <span className="ff-btn__pending">
                      <Spinner /> Encerrando…
                    </span>
                  ) : (
                    "Sim, encerrar"
                  )}
                </button>
              </div>
            ) : null}

            <ObligationDialogError message={cancel.error} />
          </div>
        </form>
      </ObligationDialogShell>
    </>
  );
}
