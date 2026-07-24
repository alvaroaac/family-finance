"use client";

import { useState, useTransition, type ReactNode } from "react";

import type { TransactionListItem } from "@family-finance/db";

import {
  Badge,
  Card,
  IconPencil,
  IconTrash,
  Input,
  RowCardList,
  Select,
  Spinner,
  Table,
  TableRow,
  useToast,
} from "../../../components/ui";
import { updateTransactionAction, deleteTransactionAction } from "./actions";

/**
 * Client table for the "Transações" screen: inline edit of descrição, valor,
 * meio de pagamento (conta/cartão), categoria/subcategoria, responsável, plus
 * the guarded excluir. Every change posts ONE edited field to a server action
 * (the household is re-resolved from the session there); the action
 * revalidates the page, so the fresh rows come back through the server
 * component. `kind` stays read-only here; parcela rows (installmentId set)
 * keep both valor and meio de pagamento read-only too — those are managed via
 * the installment group, and the server repo refuses the edit anyway.
 *
 * Re-skin (Transacoes.dc.html): desktop grid table with pending stripes and
 * an inline delete-confirm row ("Isso não dá pra desfazer." / "Deixa pra lá"
 * replaces window.confirm — same action wiring); mobile row cards with
 * "Categorizar/depois" on pending entries. Logic/state untouched.
 */

export type CategoryOption = { id: string; name: string };
export type SubcategoryOption = { id: string; categoryId: string; name: string };
export type ResponsibleOption = { value: string; label: string };
export type PaymentOption = { id: string; name: string };

type Props = {
  rows: TransactionListItem[];
  categories: CategoryOption[];
  subcategories: SubcategoryOption[];
  /** "household" (Casa) + one entry per member (display name or "Membro"). */
  responsibles: ResponsibleOption[];
  /** Already loaded by the page for the filter selects — reused for display. */
  accounts?: PaymentOption[];
  cards?: PaymentOption[];
  /** Server-rendered "N lançamentos em <mês>" + pagination (desktop foot). */
  footer?: ReactNode;
};

const COLUMNS = [
  { key: "dia", label: "Dia" },
  { key: "descricao", label: "Descrição" },
  { key: "conta", label: "Conta / Cartão" },
  { key: "categoria", label: "Categoria" },
  { key: "subcategoria", label: "Subcategoria" },
  { key: "quem", label: "Quem" },
  { key: "valor", label: "Valor", align: "right" as const },
  { key: "acoes", label: "" },
];

const GRID = "52px minmax(160px, 1fr) 110px 140px 140px 110px 110px 64px";

function formatBrl(cents: number): string {
  return (cents / 100).toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
  });
}

/** "2026-06-05" -> "05/06/2026". */
function formatDate(iso: string): string {
  const [year, month, day] = iso.split("-");
  return `${day}/${month}/${year}`;
}

/** "2026-06-05" -> "05/06". */
function formatDayMonth(iso: string): string {
  const [, month, day] = iso.split("-");
  return `${day}/${month}`;
}

/** Same rule as the db `needsReview` helper. */
function isPending(row: TransactionListItem): boolean {
  return row.kind !== "transfer" && row.categoryId === null;
}

/** Signed display: despesas negative, receitas positive, transfer neutral. */
function amountDisplay(row: TransactionListItem): {
  text: string;
  className: string;
} {
  if (row.kind === "expense") {
    return {
      text: `− ${formatBrl(row.amount.cents)}`,
      className: "ff-amount--neg",
    };
  }
  if (row.kind === "income") {
    return {
      text: `+ ${formatBrl(row.amount.cents)}`,
      className: "ff-amount--pos",
    };
  }
  return { text: formatBrl(row.amount.cents), className: "ff-dim" };
}

export function TransactionsTable({
  rows,
  categories,
  subcategories,
  responsibles,
  accounts = [],
  cards = [],
  footer,
}: Props) {
  const toast = useToast();
  const [isSaving, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  // Row id being description-edited + its draft text.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  // Row id being amount-edited + its draft text (pt-BR decimal string).
  const [editingAmountId, setEditingAmountId] = useState<string | null>(null);
  const [amountDraft, setAmountDraft] = useState("");
  // Row id waiting on the inline delete confirm (mockup's neg-wash row).
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  // Mobile: row id with the categorize/edit panel expanded.
  const [expandedId, setExpandedId] = useState<string | null>(null);

  function patchRow(transactionId: string, fields: Record<string, string>) {
    setError(null);
    startTransition(async () => {
      const formData = new FormData();
      formData.set("transactionId", transactionId);
      for (const [key, value] of Object.entries(fields)) {
        formData.set(key, value);
      }
      const result = await updateTransactionAction(formData);
      if (!result.ok) {
        const message = result.error ?? "Não foi possível salvar a alteração.";
        setError(message);
        toast.error(message);
      } else {
        toast.success("Alteração salva.");
      }
    });
  }

  function commitDescription(row: TransactionListItem) {
    const next = draft.trim();
    setEditingId(null);
    if (next === row.description) {
      return;
    }
    // Send even an empty value: the repo answers with its pt-BR validation.
    patchRow(row.id, { description: draft });
  }

  function removeRow(row: TransactionListItem) {
    setConfirmingId(null);
    setError(null);
    startTransition(async () => {
      const formData = new FormData();
      formData.set("transactionId", row.id);
      const result = await deleteTransactionAction(formData);
      if (!result.ok) {
        const message = result.error ?? "Não foi possível excluir o lançamento.";
        setError(message);
        toast.error(message);
      } else {
        toast.success("Lançamento excluído.");
      }
    });
  }

  function commitAmount(row: TransactionListItem) {
    setEditingAmountId(null);
    const trimmed = amountDraft.trim();
    if (trimmed === "") return;
    // Server re-validates; this just posts the pt-BR string.
    patchRow(row.id, { amount: trimmed });
  }

  function paymentName(row: TransactionListItem): string {
    if (row.creditCardId !== null) {
      return cards.find((c) => c.id === row.creditCardId)?.name ?? "cartão";
    }
    if (row.accountId !== null) {
      return accounts.find((a) => a.id === row.accountId)?.name ?? "conta";
    }
    return "—";
  }

  function categoryName(row: TransactionListItem): string {
    if (row.categoryId === null) return "sem categoria";
    return (
      categories.find((c) => c.id === row.categoryId)?.name ?? "sem categoria"
    );
  }

  function responsibleLabel(row: TransactionListItem): string {
    const value =
      row.responsibilityScope === "user" && row.responsibleUserId !== null
        ? row.responsibleUserId
        : "household";
    const label = responsibles.find((r) => r.value === value)?.label ?? "Casa";
    return label === "Casa" ? "a casa" : label;
  }

  function descriptionCell(row: TransactionListItem) {
    if (editingId === row.id) {
      return (
        <Input
          className="ff-input--compact ff-input--editing"
          value={draft}
          autoFocus
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => commitDescription(row)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.currentTarget.blur();
            } else if (e.key === "Escape") {
              setEditingId(null);
            }
          }}
          aria-label="Editar descrição"
        />
      );
    }
    return (
      <button
        type="button"
        onClick={() => {
          setEditingId(row.id);
          setDraft(row.description);
        }}
        title="Clique para editar a descrição"
        style={{
          background: "none",
          border: "none",
          padding: 0,
          font: "inherit",
          fontWeight: 500,
          cursor: "text",
          textAlign: "left",
          color: "inherit",
          display: "inline-flex",
          alignItems: "center",
          gap: 8,
          minWidth: 0,
        }}
      >
        <span
          style={{
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {row.description}
        </span>
        {row.installmentId !== null ? <Badge tone="accent">parcela</Badge> : null}
        {isPending(row) ? <Badge tone="warn">Pendente</Badge> : null}
      </button>
    );
  }

  function categorySelect(row: TransactionListItem, compact: boolean) {
    return (
      <Select
        className={`${compact ? "ff-select--compact" : ""}${
          row.categoryId === null ? " ff-select--warn" : ""
        }`}
        value={row.categoryId ?? ""}
        aria-label="Categoria"
        onChange={(e) =>
          // Changing the category resets the subcategory (it belongs to the
          // previous category).
          patchRow(row.id, { categoryId: e.target.value, subcategoryId: "" })
        }
      >
        <option value="">— sem categoria —</option>
        {categories.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </Select>
    );
  }

  function subcategorySelect(row: TransactionListItem, compact: boolean) {
    const rowSubcategories = subcategories.filter(
      (s) => s.categoryId === row.categoryId,
    );
    return (
      <Select
        className={compact ? "ff-select--compact" : undefined}
        value={row.subcategoryId ?? ""}
        aria-label="Subcategoria"
        disabled={row.categoryId === null}
        onChange={(e) => patchRow(row.id, { subcategoryId: e.target.value })}
      >
        <option value="">—</option>
        {rowSubcategories.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </Select>
    );
  }

  function responsibleSelect(row: TransactionListItem, compact: boolean) {
    const responsibleValue =
      row.responsibilityScope === "user" && row.responsibleUserId !== null
        ? row.responsibleUserId
        : "household";
    return (
      <Select
        className={compact ? "ff-select--compact" : undefined}
        value={responsibleValue}
        aria-label="Responsável"
        onChange={(e) => patchRow(row.id, { responsible: e.target.value })}
      >
        {responsibles.map((r) => (
          <option key={r.value} value={r.value}>
            {r.label}
          </option>
        ))}
      </Select>
    );
  }

  function paymentSelect(row: TransactionListItem, compact: boolean) {
    if (row.installmentId !== null || row.kind === "transfer") {
      // Parcelas: managed via the group. Transfers (bill payments): both
      // instruments are fixed — delete the row to undo.
      return <span className="ff-dim">{paymentName(row)}</span>;
    }
    const value =
      row.creditCardId !== null
        ? `card:${row.creditCardId}`
        : row.accountId !== null
          ? `account:${row.accountId}`
          : "";
    return (
      <Select
        className={compact ? "ff-select--compact" : undefined}
        value={value}
        aria-label="Pagamento"
        onChange={(e) => patchRow(row.id, { payment: e.target.value })}
      >
        {accounts.map((a) => (
          <option key={a.id} value={`account:${a.id}`}>
            Conta: {a.name}
          </option>
        ))}
        {row.kind === "expense"
          ? cards.map((c) => (
              <option key={c.id} value={`card:${c.id}`}>
                Cartão: {c.name}
              </option>
            ))
          : null}
      </Select>
    );
  }

  function amountCell(
    row: TransactionListItem,
    amount: { text: string; className: string },
  ) {
    if (row.installmentId === null && editingAmountId === row.id) {
      return (
        <Input
          className="ff-input--compact ff-input--editing"
          value={amountDraft}
          autoFocus
          inputMode="decimal"
          aria-label="Editar valor"
          onChange={(e) => setAmountDraft(e.target.value)}
          onBlur={() => commitAmount(row)}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
            else if (e.key === "Escape") setEditingAmountId(null);
          }}
        />
      );
    }
    return (
      <button
        type="button"
        className={`ff-num ${amount.className}`}
        title={
          row.installmentId === null
            ? "Clique para editar o valor"
            : "Valor de parcela — edite o parcelamento"
        }
        disabled={row.installmentId !== null}
        style={{
          background: "none",
          border: "none",
          padding: 0,
          font: "inherit",
          fontWeight: 600,
          cursor: row.installmentId === null ? "text" : "default",
          textAlign: "right",
          whiteSpace: "nowrap",
        }}
        onClick={() => {
          if (row.installmentId !== null) return;
          setEditingAmountId(row.id);
          setAmountDraft((row.amount.cents / 100).toFixed(2).replace(".", ","));
        }}
      >
        {amount.text}
      </button>
    );
  }

  if (rows.length === 0) {
    return (
      <p className="ff-muted" style={{ marginTop: 18 }}>
        Nenhum lançamento por aqui com esses filtros. Que tal conferir outro
        mês?
      </p>
    );
  }

  return (
    <div style={{ marginTop: 18 }}>
      {error !== null ? (
        <div
          role="alert"
          className="ff-alert ff-alert--negative"
          style={{ margin: "0 0 12px" }}
        >
          {error}
        </div>
      ) : null}

      {isSaving ? (
        <div className="ff-table-pending" role="status">
          <Spinner />
          Salvando alteração…
        </div>
      ) : null}

      <div style={{ opacity: isSaving ? 0.6 : 1 }}>
        <Table columns={COLUMNS} gridTemplate={GRID}>
          {rows.map((row) => {
            const amount = amountDisplay(row);

            if (confirmingId === row.id) {
              return (
                <div key={row.id} className="ff-row-confirm">
                  <span className="ff-row-confirm__text">
                    Excluir{" "}
                    <strong>
                      &quot;{row.description} · {amount.text}&quot;
                    </strong>
                    ? Isso não dá pra desfazer.
                  </span>
                  <button
                    type="button"
                    className="ff-btn ff-btn--danger-solid"
                    disabled={isSaving}
                    onClick={() => removeRow(row)}
                  >
                    {isSaving ? (
                      <span className="ff-btn__pending"><Spinner /> Excluindo…</span>
                    ) : (
                      "Excluir"
                    )}
                  </button>
                  <button
                    type="button"
                    className="ff-btn ff-btn--ghost-sm"
                    onClick={() => setConfirmingId(null)}
                  >
                    Deixa pra lá
                  </button>
                </div>
              );
            }

            return (
              <TableRow key={row.id} pending={isPending(row)}>
                <span className="ff-dim ff-num" style={{ whiteSpace: "nowrap" }}>
                  {formatDayMonth(row.occurredOn)}
                </span>
                <span style={{ minWidth: 0 }}>{descriptionCell(row)}</span>
                <span
                  style={{
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {paymentSelect(row, true)}
                </span>
                <span>{categorySelect(row, true)}</span>
                <span>{subcategorySelect(row, true)}</span>
                <span>{responsibleSelect(row, true)}</span>
                <span style={{ textAlign: "right" }}>
                  {amountCell(row, amount)}
                </span>
                <span
                  style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}
                >
                  <button
                    type="button"
                    className="ff-iconbtn"
                    title="editar"
                    aria-label={`Editar ${row.description}`}
                    onClick={() => {
                      setEditingId(row.id);
                      setDraft(row.description);
                    }}
                  >
                    <IconPencil size={14} />
                  </button>
                  <button
                    type="button"
                    className="ff-iconbtn ff-iconbtn--danger"
                    title="excluir"
                    aria-label={`Excluir ${row.description}`}
                    disabled={isSaving}
                    onClick={() => setConfirmingId(row.id)}
                  >
                    <IconTrash size={14} />
                  </button>
                </span>
              </TableRow>
            );
          })}
          {footer}
        </Table>

        <RowCardList>
          {rows.map((row) => {
            const amount = amountDisplay(row);
            const pending = isPending(row);
            const expanded = expandedId === row.id;

            return (
              <Card
                key={row.id}
                className={`ff-rowcard${pending ? " ff-rowcard--pending" : ""}`}
                soft={false}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      gap: 12,
                    }}
                  >
                    <span
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 8,
                        minWidth: 0,
                      }}
                    >
                      <span className="ff-txrow__desc">{row.description}</span>
                      {row.installmentId !== null ? (
                        <Badge tone="accent">parcela</Badge>
                      ) : null}
                      {pending ? <Badge tone="warn">Pendente</Badge> : null}
                    </span>
                    <span className="ff-txrow__amount">
                      {amountCell(row, amount)}
                    </span>
                  </div>
                  <div className="ff-txrow__meta">
                    {formatDayMonth(row.occurredOn)} · {paymentName(row)} ·{" "}
                    {categoryName(row)} · {responsibleLabel(row)}
                  </div>

                  {confirmingId === row.id ? (
                    <div className="ff-rowcard__panel">
                      <span className="ff-row-confirm__text">
                        Excluir{" "}
                        <strong>
                          &quot;{row.description} · {amount.text}&quot;
                        </strong>
                        ? Isso não dá pra desfazer.
                      </span>
                      <div style={{ display: "flex", gap: 8 }}>
                        <button
                          type="button"
                          className="ff-btn ff-btn--danger-solid"
                          disabled={isSaving}
                          onClick={() => removeRow(row)}
                        >
                          {isSaving ? (
                            <span className="ff-btn__pending"><Spinner /> Excluindo…</span>
                          ) : (
                            "Excluir"
                          )}
                        </button>
                        <button
                          type="button"
                          className="ff-btn ff-btn--ghost-sm"
                          onClick={() => setConfirmingId(null)}
                        >
                          Deixa pra lá
                        </button>
                      </div>
                    </div>
                  ) : expanded ? (
                    <div className="ff-rowcard__panel">
                      {descriptionCell(row)}
                      {paymentSelect(row, false)}
                      {categorySelect(row, false)}
                      {subcategorySelect(row, false)}
                      {responsibleSelect(row, false)}
                      <div style={{ display: "flex", gap: 8 }}>
                        <button
                          type="button"
                          className="ff-btn ff-btn--ghost-sm"
                          onClick={() => setExpandedId(null)}
                        >
                          fechar
                        </button>
                        <button
                          type="button"
                          className="ff-btn ff-btn--ghost-sm"
                          disabled={isSaving}
                          onClick={() => setConfirmingId(row.id)}
                        >
                          excluir
                        </button>
                      </div>
                    </div>
                  ) : pending ? (
                    <div className="ff-rowcard__actions">
                      <button
                        type="button"
                        className="ff-btn ff-btn--primary"
                        onClick={() => setExpandedId(row.id)}
                      >
                        Categorizar
                      </button>
                      <button
                        type="button"
                        className="ff-btn ff-btn--ghost-sm"
                        onClick={() => setExpandedId(null)}
                      >
                        depois
                      </button>
                    </div>
                  ) : (
                    <div className="ff-rowcard__actions">
                      <button
                        type="button"
                        className="ff-btn ff-btn--ghost-sm"
                        onClick={() => setExpandedId(row.id)}
                      >
                        editar
                      </button>
                    </div>
                  )}
                </div>
              </Card>
            );
          })}
        </RowCardList>
      </div>
    </div>
  );
}
