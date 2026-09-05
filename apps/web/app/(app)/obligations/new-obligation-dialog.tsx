"use client";

import { useId, useRef, useState, useTransition } from "react";
import type { ReactElement, ReactNode } from "react";

import { addMonthsYm, obligationEndMonth } from "@family-finance/domain";

import {
  Badge,
  Button,
  Card,
  Field,
  IconDoc,
  Input,
  Segmented,
  Select,
  useToast,
} from "../../../components/ui";
import {
  formatBrlCents,
  monthLabelPtBr,
  parseReaisToCents,
} from "../../../lib/format";
import type { ObligationActionResult } from "./actions";
import { monthAbbrPtBr } from "./view-model";

/**
 * Guided "Nova obrigação" dialog — four numbered steps (o que é / quando / por
 * quanto tempo / sai de onde) plus a live plain-Portuguese summary, so a
 * couple can see what they are about to commit to before saving.
 *
 * Client pre-checks only give instant pt-BR feedback; `createObligationAction`
 * re-parses and re-validates everything through the domain draft.
 */

export type OptionItem = { id: string; name: string };

type TermMode = "indefinite" | "installments";

const TERM_OPTIONS: Array<{ value: TermMode; label: string }> = [
  { value: "indefinite", label: "Sem prazo" },
  { value: "installments", label: "Parcelado" },
];

/** Months offered as "Primeira parcela": three back, twelve ahead. */
const FIRST_MONTH_OFFSET = -3;
const LAST_MONTH_OFFSET = 12;
const DEFAULT_TERM_MONTHS = "12";

export type SummarizeState = {
  description: string;
  amountCents: number | null;
  startMonth: string;
  dueDay: number | null;
  termMode: TermMode;
  termMonths: number | null;
  accountName: string | null;
};

/**
 * The sentence(s) under the form, in the same words the bot confirms with.
 * `main` is null while the essentials (name, amount, and the number of
 * parcelas when parcelado) are still missing — there is nothing to promise
 * yet. Pure.
 */
export function summarize(
  state: SummarizeState,
  monthTotals: Record<string, number>,
): { main: string | null; impact: string | null } {
  const {
    description,
    amountCents,
    startMonth,
    dueDay,
    termMode,
    termMonths,
    accountName,
  } = state;
  const name = description.trim();
  const installments = termMode === "installments";
  if (
    name === "" ||
    amountCents === null ||
    amountCents <= 0 ||
    (installments && (termMonths === null || termMonths < 1))
  ) {
    return { main: null, impact: null };
  }

  const endMonth = installments
    ? obligationEndMonth(startMonth, termMonths)
    : null;
  const term =
    endMonth === null
      ? `todo mês a partir de ${monthAbbrPtBr(startMonth)}`
      : `${termMonths as number} vezes, de ${monthAbbrPtBr(startMonth)} a ${monthAbbrPtBr(endMonth)}`;

  const where =
    dueDay !== null && accountName !== null
      ? ` Vence dia ${dueDay}, sai da ${accountName}.`
      : dueDay !== null
        ? ` Vence dia ${dueDay}.`
        : accountName !== null
          ? ` Sai da ${accountName}.`
          : "";

  const monthTotalCents = monthTotals[startMonth];
  return {
    main: `${name} — ${formatBrlCents(amountCents)} por mês, ${term}.${where}`,
    impact:
      monthTotalCents === undefined
        ? null
        : `A partir de ${monthLabelPtBr(startMonth)}, o mês da casa passa a ${formatBrlCents(monthTotalCents + amountCents)}.`,
  };
}

/** "até set/2032 · total R$ 51.151,68" — the total waits for a valid amount. */
function termBadgeLabel(
  startMonth: string,
  termMonths: number | null,
  amountCents: number | null,
): string | null {
  if (termMonths === null || termMonths < 1) return null;
  const endMonth = obligationEndMonth(startMonth, termMonths);
  if (endMonth === null) return null;
  const until = `até ${monthAbbrPtBr(endMonth)}`;
  return amountCents === null || amountCents <= 0
    ? until
    : `${until} · total ${formatBrlCents(termMonths * amountCents)}`;
}

function monthOptions(currentMonth: string): string[] {
  const months: string[] = [];
  for (
    let offset = FIRST_MONTH_OFFSET;
    offset <= LAST_MONTH_OFFSET;
    offset += 1
  ) {
    months.push(addMonthsYm(currentMonth, offset));
  }
  return months;
}

/** Strictly numeric text field -> number; "12abc" and "" are not numbers. */
function toPositiveInt(value: string): number | null {
  return /^\d+$/.test(value.trim()) ? Number.parseInt(value, 10) : null;
}

function Step({
  number,
  title,
  children,
}: {
  number: number;
  title: string;
  children: ReactNode;
}): ReactElement {
  return (
    <div className="ff-oblig-step">
      <div className="ff-oblig-step__head">
        <span className="ff-oblig-step__num">{number}</span>
        <span className="ff-oblig-step__title">{title}</span>
      </div>
      {children}
    </div>
  );
}

export function NewObligationDialog({
  accounts,
  categories,
  currentMonth,
  monthTotals,
  action,
  trigger = "header",
}: {
  accounts: OptionItem[];
  categories: OptionItem[];
  currentMonth: string;
  monthTotals: Record<string, number>;
  action: (formData: FormData) => Promise<ObligationActionResult>;
  trigger?: "header" | "sticky";
}): ReactElement {
  const toast = useToast();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const startHintId = useId();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const defaultAccountId = accounts[0]?.id ?? "";
  const [description, setDescription] = useState("");
  const [amount, setAmount] = useState("");
  const [startMonth, setStartMonth] = useState(currentMonth);
  const [dueDay, setDueDay] = useState("");
  const [termMode, setTermMode] = useState<TermMode>("indefinite");
  const [termMonths, setTermMonths] = useState(DEFAULT_TERM_MONTHS);
  const [accountId, setAccountId] = useState(defaultAccountId);
  const [categoryId, setCategoryId] = useState("");

  const amountCents = parseReaisToCents(amount);
  const termCount =
    termMode === "installments" ? toPositiveInt(termMonths) : null;
  const badge = termBadgeLabel(startMonth, termCount, amountCents);
  const summary = summarize(
    {
      description,
      amountCents,
      startMonth,
      dueDay: toPositiveInt(dueDay),
      termMode,
      termMonths: termCount,
      accountName: accounts.find((a) => a.id === accountId)?.name ?? null,
    },
    monthTotals,
  );

  function reset(): void {
    setDescription("");
    setAmount("");
    setStartMonth(currentMonth);
    setDueDay("");
    setTermMode("indefinite");
    setTermMonths(DEFAULT_TERM_MONTHS);
    setAccountId(defaultAccountId);
    setCategoryId("");
    setError(null);
  }

  function openDialog(): void {
    dialogRef.current?.showModal();
  }

  function closeDialog(): void {
    dialogRef.current?.close();
  }

  /** The first pt-BR complaint the household should see, if any. */
  function preCheck(): string | null {
    if (amountCents === null || amountCents <= 0) {
      return 'Não entendi o valor — use algo como "710,44".';
    }
    if (description.trim() === "") {
      return "O nome não pode ficar vazio.";
    }
    const day = toPositiveInt(dueDay);
    if (day === null || day > 28) {
      return "Escolha o dia do vencimento, de 1 a 28.";
    }
    if (accountId === "") {
      return "Escolha a conta de onde a obrigação sai.";
    }
    if (termMode === "installments" && termCount === null) {
      return "Informe pelo menos 1 parcela.";
    }
    return null;
  }

  function handleSubmit(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (pending) return;
    const complaint = preCheck();
    if (complaint !== null) {
      setError(complaint);
      return;
    }
    const formData = new FormData(event.currentTarget);
    setError(null);
    startTransition(async () => {
      const result = await action(formData);
      if (!result.ok) {
        const message = result.error ?? "Não foi possível salvar a obrigação.";
        setError(message);
        toast.error(message);
        return;
      }
      toast.success("Obrigação criada.");
      reset();
      closeDialog();
    });
  }

  const openButton = (
    <Button variant="primary" onClick={openDialog}>
      + Nova obrigação
    </Button>
  );

  return (
    <>
      {trigger === "sticky" ? (
        <div className="ff-sticky-cta">{openButton}</div>
      ) : (
        openButton
      )}
      <dialog
        ref={dialogRef}
        className="ff-dialog ff-dialog--transaction"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        onClose={reset}
        onClick={(event) => {
          if (event.target === event.currentTarget) closeDialog();
        }}
      >
        <form className="ff-dialog__surface" onSubmit={handleSubmit}>
          <input type="hidden" name="termMode" value={termMode} />

          <div className="ff-dialog__header">
            <div>
              <div className="ff-kicker">Obrigações fixas</div>
              <h2 id={titleId} className="ff-dialog__title ff-serif">
                Nova obrigação
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
            Um financiamento, uma parcela ou uma conta que chega todo mês. A
            gente projeta os próximos meses e você só marca quando pagar.
          </p>

          <Step number={1} title="O que é">
            <div className="ff-form-grid">
              <Field label="Nome">
                <Input
                  name="description"
                  value={description}
                  placeholder="Placas solares"
                  required
                  onChange={(event) => setDescription(event.target.value)}
                />
              </Field>
              <Field label="Valor por mês (R$)">
                <Input
                  className="ff-num"
                  name="amount"
                  value={amount}
                  placeholder="710,44"
                  inputMode="decimal"
                  required
                  onChange={(event) => setAmount(event.target.value)}
                />
              </Field>
            </div>
          </Step>

          <Step number={2} title="Quando">
            <div className="ff-form-grid">
              <Field label="Primeira parcela">
                <Select
                  name="startMonth"
                  value={startMonth}
                  aria-describedby={startHintId}
                  onChange={(event) => setStartMonth(event.target.value)}
                >
                  {monthOptions(currentMonth).map((month) => (
                    <option key={month} value={month}>
                      {monthLabelPtBr(month)}
                    </option>
                  ))}
                </Select>
                <div id={startHintId} className="ff-note ff-oblig-step__hint">
                  Já pagou alguma? Escolha o mês da primeira parcela — as
                  passadas você marca depois.
                </div>
              </Field>
              <Field label="Vence todo dia">
                <Input
                  className="ff-num"
                  type="number"
                  name="dueDay"
                  min={1}
                  max={28}
                  step={1}
                  value={dueDay}
                  placeholder="5"
                  required
                  onChange={(event) => setDueDay(event.target.value)}
                />
              </Field>
            </div>
          </Step>

          <Step number={3} title="Por quanto tempo">
            <div className="ff-oblig-term">
              <Segmented
                ariaLabel="Por quanto tempo"
                value={termMode}
                options={TERM_OPTIONS}
                onChange={setTermMode}
              />
              {termMode === "installments" ? (
                <>
                  <span className="ff-oblig-term__count">
                    <Input
                      className="ff-num ff-oblig-term__input"
                      type="number"
                      name="termMonths"
                      min={1}
                      step={1}
                      value={termMonths}
                      aria-label="Quantas parcelas"
                      onChange={(event) => setTermMonths(event.target.value)}
                    />
                    <span className="ff-note">parcelas</span>
                  </span>
                  {badge !== null ? <Badge tone="accent">{badge}</Badge> : null}
                </>
              ) : null}
            </div>
            <div className="ff-note">
              Sem prazo = todo mês até você encerrar (aluguel, plano de saúde).
              Parcelado = acaba sozinho na última parcela (financiamento,
              carnê).
            </div>
          </Step>

          <Step number={4} title="Sai de onde">
            <div className="ff-form-grid">
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
              <Field label="Categoria (opcional)">
                <Select
                  name="categoryId"
                  value={categoryId}
                  onChange={(event) => setCategoryId(event.target.value)}
                >
                  <option value="">Sem categoria (a definir)</option>
                  {categories.map((category) => (
                    <option key={category.id} value={category.id}>
                      {category.name}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
          </Step>

          {summary.main !== null ? (
            <Card soft accentEdge className="ff-oblig-summary">
              <span className="ff-bubble">
                <IconDoc />
              </span>
              <div>
                {summary.main}
                {summary.impact !== null ? (
                  <div className="ff-note">{summary.impact}</div>
                ) : null}
              </div>
            </Card>
          ) : null}

          {error !== null ? (
            <div role="alert" className="ff-alert ff-alert--negative">
              {error}
            </div>
          ) : null}

          <div className="ff-dialog__actions">
            <Button variant="ghost" disabled={pending} onClick={closeDialog}>
              Cancelar
            </Button>
            <Button
              variant="primary"
              type="submit"
              loading={pending}
              loadingText="Criando…"
            >
              Criar obrigação
            </Button>
          </div>
        </form>
      </dialog>
    </>
  );
}
