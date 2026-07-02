"use client";

import { useState, useTransition } from "react";

import type { TransactionListItem } from "@family-finance/db";

import { updateTransactionAction, deleteTransactionAction } from "./actions";

/**
 * Client table for the "Transações" screen: inline edit of descrição,
 * categoria/subcategoria, responsável, plus the guarded excluir. Every change
 * posts ONE edited field to a server action (the household is re-resolved from
 * the session there); the action revalidates the page, so the fresh rows come
 * back through the server component. Amount/kind/payment are read-only here.
 */

export type CategoryOption = { id: string; name: string };
export type SubcategoryOption = { id: string; categoryId: string; name: string };
export type ResponsibleOption = { value: string; label: string };

type Props = {
  rows: TransactionListItem[];
  categories: CategoryOption[];
  subcategories: SubcategoryOption[];
  /** "household" (Casa) + one entry per member (display name or "Membro"). */
  responsibles: ResponsibleOption[];
};

const cellStyle = {
  padding: "10px 8px",
  borderBottom: "1px solid #eef1f4",
  fontSize: 14,
  verticalAlign: "middle",
} as const;

const headStyle = {
  ...cellStyle,
  color: "#556",
  fontWeight: 600,
  fontSize: 13,
  textAlign: "left",
  whiteSpace: "nowrap",
} as const;

const selectStyle = {
  padding: "6px 8px",
  border: "1px solid #cbd2d9",
  borderRadius: 8,
  fontSize: 13,
  maxWidth: 160,
  background: "#fff",
} as const;

const descriptionInputStyle = {
  padding: "6px 8px",
  border: "1px solid #cbd2d9",
  borderRadius: 8,
  fontSize: 14,
  width: "100%",
  minWidth: 180,
} as const;

const badgePendente = {
  display: "inline-block",
  background: "#fdf3e3",
  border: "1px solid #eccf9a",
  color: "#8a5b12",
  borderRadius: 999,
  padding: "2px 10px",
  fontSize: 12,
  fontWeight: 600,
} as const;

const btnDanger = {
  padding: "6px 12px",
  borderRadius: 8,
  border: "1px solid #e0b4b4",
  background: "#fff",
  color: "#8a2020",
  fontSize: 13,
  cursor: "pointer",
} as const;

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

/** Same rule as the db `needsReview` helper. */
function isPending(row: TransactionListItem): boolean {
  return row.kind !== "transfer" && row.categoryId === null;
}

/** Signed display: despesas negative, receitas positive, transfer neutral. */
function amountDisplay(row: TransactionListItem): {
  text: string;
  color: string;
} {
  if (row.kind === "expense") {
    return { text: `− ${formatBrl(row.amount.cents)}`, color: "#8a2020" };
  }
  if (row.kind === "income") {
    return { text: `+ ${formatBrl(row.amount.cents)}`, color: "#1f6b3a" };
  }
  return { text: formatBrl(row.amount.cents), color: "#556" };
}

export function TransactionsTable({
  rows,
  categories,
  subcategories,
  responsibles,
}: Props) {
  const [isSaving, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  // Row id being description-edited + its draft text.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

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
        setError(result.error ?? "Não foi possível salvar a alteração.");
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
    const ok = window.confirm(
      `Excluir "${row.description}" de ${formatDate(row.occurredOn)}? Essa ação não pode ser desfeita.`,
    );
    if (!ok) return;
    setError(null);
    startTransition(async () => {
      const formData = new FormData();
      formData.set("transactionId", row.id);
      const result = await deleteTransactionAction(formData);
      if (!result.ok) {
        setError(result.error ?? "Não foi possível excluir o lançamento.");
      }
    });
  }

  if (rows.length === 0) {
    return (
      <p style={{ color: "#556", marginTop: 16 }}>
        Nenhum lançamento por aqui com esses filtros. Que tal conferir outro
        mês?
      </p>
    );
  }

  return (
    <div>
      {error !== null ? (
        <div
          role="alert"
          style={{
            background: "#fdecec",
            border: "1px solid #f3b4b4",
            color: "#8a2020",
            borderRadius: 10,
            padding: 12,
            marginBottom: 12,
            fontSize: 14,
          }}
        >
          {error}
        </div>
      ) : null}

      <div style={{ overflowX: "auto", opacity: isSaving ? 0.6 : 1 }}>
        <table style={{ borderCollapse: "collapse", width: "100%" }}>
          <thead>
            <tr>
              <th style={headStyle}>Data</th>
              <th style={headStyle}>Descrição</th>
              <th style={headStyle}>Categoria</th>
              <th style={headStyle}>Subcategoria</th>
              <th style={headStyle}>Responsável</th>
              <th style={{ ...headStyle, textAlign: "right" }}>Valor</th>
              <th style={headStyle} />
              <th style={headStyle} />
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => {
              const rowSubcategories = subcategories.filter(
                (s) => s.categoryId === row.categoryId,
              );
              const responsibleValue =
                row.responsibilityScope === "user" &&
                row.responsibleUserId !== null
                  ? row.responsibleUserId
                  : "household";
              const amount = amountDisplay(row);

              return (
                <tr key={row.id}>
                  <td style={{ ...cellStyle, whiteSpace: "nowrap" }}>
                    {formatDate(row.occurredOn)}
                  </td>
                  <td style={{ ...cellStyle, minWidth: 200 }}>
                    {editingId === row.id ? (
                      <input
                        style={descriptionInputStyle}
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
                    ) : (
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
                          fontSize: 14,
                          cursor: "text",
                          textAlign: "left",
                        }}
                      >
                        {row.description}
                        {row.installmentId !== null ? (
                          <span
                            style={{
                              marginLeft: 8,
                              color: "#556",
                              fontSize: 12,
                            }}
                          >
                            (parcela)
                          </span>
                        ) : null}
                      </button>
                    )}
                  </td>
                  <td style={cellStyle}>
                    <select
                      style={selectStyle}
                      value={row.categoryId ?? ""}
                      aria-label="Categoria"
                      onChange={(e) =>
                        // Changing the category resets the subcategory (it
                        // belongs to the previous category).
                        patchRow(row.id, {
                          categoryId: e.target.value,
                          subcategoryId: "",
                        })
                      }
                    >
                      <option value="">— sem categoria —</option>
                      {categories.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td style={cellStyle}>
                    <select
                      style={selectStyle}
                      value={row.subcategoryId ?? ""}
                      aria-label="Subcategoria"
                      disabled={row.categoryId === null}
                      onChange={(e) =>
                        patchRow(row.id, { subcategoryId: e.target.value })
                      }
                    >
                      <option value="">—</option>
                      {rowSubcategories.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td style={cellStyle}>
                    <select
                      style={selectStyle}
                      value={responsibleValue}
                      aria-label="Responsável"
                      onChange={(e) =>
                        patchRow(row.id, { responsible: e.target.value })
                      }
                    >
                      {responsibles.map((r) => (
                        <option key={r.value} value={r.value}>
                          {r.label}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td
                    style={{
                      ...cellStyle,
                      textAlign: "right",
                      whiteSpace: "nowrap",
                      color: amount.color,
                      fontVariantNumeric: "tabular-nums",
                    }}
                  >
                    {amount.text}
                  </td>
                  <td style={cellStyle}>
                    {isPending(row) ? (
                      <span style={badgePendente}>pendente</span>
                    ) : null}
                  </td>
                  <td style={{ ...cellStyle, textAlign: "right" }}>
                    <button
                      type="button"
                      style={btnDanger}
                      disabled={isSaving}
                      onClick={() => removeRow(row)}
                    >
                      Excluir
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
