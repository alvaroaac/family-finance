"use client";

import { useMemo, useState, useTransition } from "react";

import type {
  ImportSource,
  ImportPreview,
  NormalizedImportRow,
} from "@family-finance/importers";

import {
  previewImport,
  confirmImport,
  type AccountOption,
  type CategoryOption,
  type SubcategoryOption,
  type CreditCardOption,
  type MpPreviewExtras,
  type ConfirmResult,
} from "./actions";

// NOTE: server-driven page metadata cannot be exported from a client component.
// The layout already establishes the "Casa" workspace title; this screen is the
// "Importação" nav entry.

const card = {
  background: "#fff",
  border: "1px solid #e3e6ea",
  borderRadius: 12,
  padding: 20,
  marginTop: 20,
} as const;

const inputStyle = {
  padding: "8px 10px",
  border: "1px solid #cbd2d9",
  borderRadius: 8,
  fontSize: 14,
} as const;

const btn = {
  padding: "8px 14px",
  borderRadius: 8,
  border: "1px solid #11271f",
  background: "#11271f",
  color: "#fff",
  fontSize: 14,
  cursor: "pointer",
} as const;

const btnGhost = {
  ...btn,
  background: "#fff",
  color: "#11271f",
} as const;

function formatBrl(cents: number): string {
  return (cents / 100).toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
  });
}

type PreviewBundle = {
  preview: ImportPreview;
  accounts: AccountOption[];
  categories: CategoryOption[];
  subcategories: SubcategoryOption[];
  creditCards: CreditCardOption[];
  mp?: MpPreviewExtras;
};

export default function ImportsPage() {
  const [source, setSource] = useState<ImportSource>("minhas-financas");
  const [bundle, setBundle] = useState<PreviewBundle | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [accountId, setAccountId] = useState<string>("");
  const [creditCardId, setCreditCardId] = useState<string>("");
  // Per-group edits + skip flags, keyed by group array index.
  const [groupEdits, setGroupEdits] = useState<
    Record<
      number,
      {
        totalAmountCents: number;
        installmentCount: number;
        purchasedOn: string;
        skip: boolean;
      }
    >
  >({});
  const [mapping, setMapping] = useState<
    Record<number, { categoryId?: string; subcategoryId?: string }>
  >({});
  const [excluded, setExcluded] = useState<Set<number>>(new Set());
  const [confirmResult, setConfirmResult] = useState<ConfirmResult | null>(null);
  const [isPending, startTransition] = useTransition();

  // Rows flagged as probable duplicates start excluded from the write.
  const duplicateIndices = useMemo(
    () => new Set(bundle?.preview.duplicates.map((d) => d.rowIndex) ?? []),
    [bundle],
  );

  async function onPreview(formData: FormData) {
    setConfirmResult(null);
    setPreviewError(null);
    const result = await previewImport(formData);
    if (!result.ok) {
      setBundle(null);
      setPreviewError(result.message);
      return;
    }
    setBundle({
      preview: result.preview,
      accounts: result.accounts,
      categories: result.categories,
      subcategories: result.subcategories,
      creditCards: result.creditCards,
      mp: result.mp,
    });
    setMapping({});
    setAccountId(result.accounts[0]?.id ?? "");
    setCreditCardId(result.creditCards[0]?.id ?? "");
    const edits: Record<
      number,
      {
        totalAmountCents: number;
        installmentCount: number;
        purchasedOn: string;
        skip: boolean;
      }
    > = {};
    (result.mp?.groups ?? []).forEach((g, i) => {
      edits[i] = {
        totalAmountCents: g.estimatedTotalCents,
        installmentCount: g.installmentCount,
        purchasedOn: g.purchasedOn,
        skip: g.status === "exists", // already-exists default-skipped (spec §4)
      };
    });
    setGroupEdits(edits);
    // Pre-exclude: probable in-file duplicates + rows already in the DB +
    // parcela rows (they import via groups, never as flat charges).
    setExcluded(
      new Set([
        ...result.preview.duplicates.map((d) => d.rowIndex),
        ...(result.mp?.dbDuplicateIndices ?? []),
        ...(result.mp?.installmentRowIndices ?? []),
      ]),
    );
  }

  function toggleExcluded(index: number) {
    setExcluded((prev) => {
      const next = new Set(prev);
      if (next.has(index)) {
        next.delete(index);
      } else {
        next.add(index);
      }
      return next;
    });
  }

  function setRowCategory(index: number, categoryId: string) {
    setMapping((prev) => ({
      ...prev,
      [index]: { categoryId: categoryId || undefined, subcategoryId: undefined },
    }));
  }

  function setRowSubcategory(index: number, subcategoryId: string) {
    setMapping((prev) => ({
      ...prev,
      [index]: {
        categoryId: prev[index]?.categoryId,
        subcategoryId: subcategoryId || undefined,
      },
    }));
  }

  function onConfirm() {
    if (bundle === null) {
      return;
    }
    const isMp = bundle.mp !== undefined;
    if (isMp ? creditCardId === "" : accountId === "") {
      setConfirmResult({
        ok: false,
        message: isMp
          ? "Escolha o cartão de destino antes de confirmar."
          : "Escolha a conta de destino antes de confirmar.",
      });
      return;
    }
    const rows: NormalizedImportRow[] = bundle.preview.rows;
    const selectedIndices = rows
      .map((_, index) => index)
      .filter((index) => !excluded.has(index));
    const groups = isMp
      ? (bundle.mp?.groups ?? [])
          .map((g, i) => ({ g, edit: groupEdits[i] }))
          .filter((x) => x.edit !== undefined && !x.edit.skip)
          .map(({ g, edit }) => ({
            description: g.description,
            totalAmountCents: edit!.totalAmountCents,
            installmentCount: edit!.installmentCount,
            purchasedOn: edit!.purchasedOn,
          }))
      : undefined;

    startTransition(async () => {
      const result = await confirmImport({
        source: bundle.preview.source,
        rows,
        accountId: isMp ? "" : accountId,
        creditCardId: isMp ? creditCardId : undefined,
        groups,
        mapping,
        selectedIndices,
        totalRows: bundle.preview.totalRows,
        errorRows: bundle.preview.errorCount,
        duplicateRows: bundle.preview.duplicateCount,
      });
      setConfirmResult(result);
      if (result.ok) {
        // The import is done; clear the in-memory preview (file already gone).
        setBundle(null);
      }
    });
  }

  const preview = bundle?.preview ?? null;
  const subsByCategory = useMemo(() => {
    const map = new Map<string, SubcategoryOption[]>();
    for (const sub of bundle?.subcategories ?? []) {
      const list = map.get(sub.categoryId) ?? [];
      list.push(sub);
      map.set(sub.categoryId, list);
    }
    return map;
  }, [bundle]);

  return (
    <section>
      <h1 style={{ marginTop: 0 }}>Importação</h1>
      <p style={{ color: "#555", maxWidth: 720 }}>
        Importe seu histórico do <strong>Minhas Financas</strong>,{" "}
        <strong>Nubank</strong> ou a fatura em PDF do{" "}
        <strong>Mercado Pago</strong>. Você verá um{" "}
        <strong>preview normalizado</strong> com possíveis{" "}
        <strong>duplicatas</strong> antes de gravar. O arquivo original{" "}
        <strong>não é salvo</strong> — apenas as linhas normalizadas e um
        resumo do lote.
      </p>

      {/* Upload + source selection */}
      <div style={card}>
        <h2 style={{ marginTop: 0, fontSize: 18 }}>1 · Enviar arquivo</h2>
        <form
          action={onPreview}
          style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}
        >
          <select
            name="source"
            value={source}
            onChange={(e) => setSource(e.target.value as ImportSource)}
            style={inputStyle}
            aria-label="Fonte"
          >
            <option value="minhas-financas">Minhas Financas (CSV)</option>
            <option value="nubank">Nubank (CSV)</option>
            <option value="mercado-pago">Mercado Pago (Fatura PDF)</option>
          </select>
          <input
            type="file"
            name="file"
            accept={
              source === "mercado-pago" ? ".pdf,application/pdf" : ".csv,text/csv"
            }
            required
            style={inputStyle}
            aria-label="Arquivo"
          />
          <button type="submit" style={btn}>
            Gerar preview
          </button>
        </form>
        {previewError ? (
          <div
            role="alert"
            style={{
              background: "#fdecec",
              border: "1px solid #f3b4b4",
              color: "#8a2020",
              borderRadius: 10,
              padding: 12,
              marginTop: 12,
              fontSize: 14,
            }}
          >
            {previewError}
          </div>
        ) : null}
      </div>

      {confirmResult ? (
        <div
          role="status"
          style={{
            background: confirmResult.ok ? "#e9f7ef" : "#fff6e6",
            border: `1px solid ${confirmResult.ok ? "#9bd9b4" : "#f0d28a"}`,
            color: confirmResult.ok ? "#15633a" : "#7a5a00",
            borderRadius: 10,
            padding: 14,
            marginTop: 16,
            fontSize: 14,
          }}
        >
          {confirmResult.message}
        </div>
      ) : null}

      {preview ? (
        <>
          {/* Summary counts */}
          <div style={card}>
            <h2 style={{ marginTop: 0, fontSize: 18 }}>2 · Revisar preview</h2>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
                gap: 12,
              }}
            >
              {[
                { label: "Linhas no arquivo", value: preview.totalRows },
                { label: "Importáveis", value: preview.importableCount },
                { label: "Duplicatas prováveis", value: preview.duplicateCount },
                { label: "Erros (revisar)", value: preview.errorCount },
              ].map((s) => (
                <div
                  key={s.label}
                  style={{
                    background: "#f7f9fa",
                    border: "1px solid #eceff2",
                    borderRadius: 10,
                    padding: 12,
                  }}
                >
                  <div style={{ fontSize: 12, color: "#6b7280" }}>{s.label}</div>
                  <div style={{ fontSize: 22, fontWeight: 700 }}>{s.value}</div>
                </div>
              ))}
            </div>
          </div>

          {/* Errors */}
          {preview.errors.length > 0 ? (
            <div style={card}>
              <h3 style={{ marginTop: 0, fontSize: 16 }}>
                Linhas não importadas ({preview.errors.length})
              </h3>
              <p style={{ color: "#6b7280", fontSize: 13, marginTop: 0 }}>
                Estas linhas não puderam ser mapeadas. Corrija no arquivo e
                importe novamente, se necessário. O restante segue normalmente.
              </p>
              <ul style={{ margin: 0, paddingLeft: 18, fontSize: 14 }}>
                {preview.errors.map((e) => (
                  <li key={e.sourceLine} style={{ color: "#8a2020" }}>
                    Linha {e.sourceLine}: {e.message}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {/* Parcelamentos detectados (Mercado Pago) */}
          {bundle?.mp !== undefined && bundle.mp.groups.length > 0 ? (
            <div style={card}>
              <h3 style={{ marginTop: 0, fontSize: 16 }}>
                Parcelamentos detectados ({bundle.mp.groups.length})
              </h3>
              <p style={{ color: "#6b7280", fontSize: 13, marginTop: 0 }}>
                Valores inferidos da fatura (total = parcela × quantidade; mês da
                compra a partir de “Parcela X de Y”). Revise e edite antes de
                confirmar; grupos já existentes vêm desmarcados.
              </p>
              <div style={{ overflowX: "auto" }}>
                <table
                  style={{
                    width: "100%",
                    borderCollapse: "collapse",
                    fontSize: 13,
                  }}
                >
                  <thead>
                    <tr style={{ textAlign: "left", color: "#6b7280" }}>
                      <th style={{ padding: "6px 8px" }}>Criar</th>
                      <th style={{ padding: "6px 8px" }}>Descrição</th>
                      <th style={{ padding: "6px 8px" }}>Parcela</th>
                      <th style={{ padding: "6px 8px" }}>Qtde</th>
                      <th style={{ padding: "6px 8px" }}>Total estimado (R$)</th>
                      <th style={{ padding: "6px 8px" }}>Data da compra</th>
                      <th style={{ padding: "6px 8px" }}>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {bundle.mp.groups.map((g, i) => {
                      const edit = groupEdits[i];
                      if (edit === undefined) return null;
                      return (
                        <tr
                          key={i}
                          style={{
                            borderTop: "1px solid #f0f2f4",
                            opacity: edit.skip ? 0.55 : 1,
                          }}
                        >
                          <td style={{ padding: "6px 8px" }}>
                            <input
                              type="checkbox"
                              checked={!edit.skip}
                              onChange={() =>
                                setGroupEdits((prev) => ({
                                  ...prev,
                                  [i]: { ...edit, skip: !edit.skip },
                                }))
                              }
                              aria-label={`Criar parcelamento ${g.description}`}
                            />
                          </td>
                          <td style={{ padding: "6px 8px" }}>
                            {g.description}
                            {g.cardLast4 ? (
                              <span
                                style={{
                                  marginLeft: 6,
                                  fontSize: 11,
                                  color: "#6b7280",
                                }}
                              >
                                final {g.cardLast4}
                              </span>
                            ) : null}
                          </td>
                          <td style={{ padding: "6px 8px" }}>
                            {g.installmentNumber} de {g.installmentCount} ·{" "}
                            {formatBrl(g.perInstallmentCents)}
                          </td>
                          <td style={{ padding: "6px 8px" }}>
                            <input
                              type="number"
                              min={1}
                              value={edit.installmentCount}
                              onChange={(e) =>
                                setGroupEdits((prev) => ({
                                  ...prev,
                                  [i]: {
                                    ...edit,
                                    installmentCount:
                                      Number.parseInt(e.target.value, 10) || 1,
                                  },
                                }))
                              }
                              style={{ ...inputStyle, width: 64, padding: "4px 6px" }}
                              aria-label={`Quantidade de parcelas ${g.description}`}
                            />
                          </td>
                          <td style={{ padding: "6px 8px" }}>
                            <input
                              type="number"
                              min={0.01}
                              step={0.01}
                              value={(edit.totalAmountCents / 100).toFixed(2)}
                              onChange={(e) =>
                                setGroupEdits((prev) => ({
                                  ...prev,
                                  [i]: {
                                    ...edit,
                                    totalAmountCents: Math.round(
                                      Number.parseFloat(e.target.value || "0") * 100,
                                    ),
                                  },
                                }))
                              }
                              style={{ ...inputStyle, width: 110, padding: "4px 6px" }}
                              aria-label={`Total do parcelamento ${g.description}`}
                            />
                          </td>
                          <td style={{ padding: "6px 8px" }}>
                            <input
                              type="date"
                              value={edit.purchasedOn}
                              onChange={(e) =>
                                setGroupEdits((prev) => ({
                                  ...prev,
                                  [i]: { ...edit, purchasedOn: e.target.value },
                                }))
                              }
                              style={{ ...inputStyle, padding: "4px 6px" }}
                              aria-label={`Data da compra ${g.description}`}
                            />
                          </td>
                          <td style={{ padding: "6px 8px" }}>
                            {g.status === "exists" ? (
                              <span
                                style={{
                                  fontSize: 11,
                                  color: "#8a6d00",
                                  background: "#ffeec0",
                                  borderRadius: 6,
                                  padding: "1px 6px",
                                }}
                              >
                                já existe
                              </span>
                            ) : (
                              <span
                                style={{
                                  fontSize: 11,
                                  color: "#15633a",
                                  background: "#e9f7ef",
                                  borderRadius: 6,
                                  padding: "1px 6px",
                                }}
                              >
                                novo
                              </span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          ) : null}

          {/* Rows table with mapping + duplicate flags */}
          <div style={card}>
            <h3 style={{ marginTop: 0, fontSize: 16 }}>
              Transações normalizadas ({preview.rows.length})
            </h3>
            <div style={{ overflowX: "auto" }}>
              <table
                style={{
                  width: "100%",
                  borderCollapse: "collapse",
                  fontSize: 13,
                }}
              >
                <thead>
                  <tr style={{ textAlign: "left", color: "#6b7280" }}>
                    <th style={{ padding: "6px 8px" }}>Importar</th>
                    <th style={{ padding: "6px 8px" }}>Data</th>
                    <th style={{ padding: "6px 8px" }}>Descrição</th>
                    <th style={{ padding: "6px 8px" }}>Tipo</th>
                    <th style={{ padding: "6px 8px", textAlign: "right" }}>
                      Valor
                    </th>
                    <th style={{ padding: "6px 8px" }}>Categoria</th>
                    <th style={{ padding: "6px 8px" }}>Subcategoria</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.rows.map((row, index) => {
                    const isDuplicate = duplicateIndices.has(index);
                    const isExcluded = excluded.has(index);
                    const isDbDuplicate =
                      bundle?.mp?.dbDuplicateIndices.includes(index) ?? false;
                    const isInstallmentRow =
                      bundle?.mp?.installmentRowIndices.includes(index) ?? false;
                    const selectedCategory = mapping[index]?.categoryId ?? "";
                    const subs = selectedCategory
                      ? (subsByCategory.get(selectedCategory) ?? [])
                      : [];
                    return (
                      <tr
                        key={index}
                        style={{
                          borderTop: "1px solid #f0f2f4",
                          background: isDuplicate ? "#fff8e6" : undefined,
                          opacity: isExcluded ? 0.55 : 1,
                        }}
                      >
                        <td style={{ padding: "6px 8px" }}>
                          <input
                            type="checkbox"
                            checked={!isExcluded}
                            onChange={() => toggleExcluded(index)}
                            disabled={isInstallmentRow}
                            title={
                              isInstallmentRow
                                ? "Parcelas entram pelo painel de parcelamentos"
                                : undefined
                            }
                            aria-label={`Importar linha ${row.sourceLine}`}
                          />
                        </td>
                        <td style={{ padding: "6px 8px" }}>{row.occurredOn}</td>
                        <td style={{ padding: "6px 8px" }}>
                          {row.description}
                          {isDuplicate ? (
                            <span
                              style={{
                                marginLeft: 6,
                                fontSize: 11,
                                color: "#8a6d00",
                                background: "#ffeec0",
                                borderRadius: 6,
                                padding: "1px 6px",
                              }}
                            >
                              duplicata provável
                            </span>
                          ) : null}
                          {isDbDuplicate ? (
                            <span
                              style={{
                                marginLeft: 6,
                                fontSize: 11,
                                color: "#8a2020",
                                background: "#fdecec",
                                borderRadius: 6,
                                padding: "1px 6px",
                              }}
                            >
                              já importada
                            </span>
                          ) : null}
                          {isInstallmentRow ? (
                            <span
                              style={{
                                marginLeft: 6,
                                fontSize: 11,
                                color: "#1a4fa0",
                                background: "#e8f0fe",
                                borderRadius: 6,
                                padding: "1px 6px",
                              }}
                            >
                              parcelamento
                            </span>
                          ) : null}
                        </td>
                        <td style={{ padding: "6px 8px" }}>
                          {row.kind === "expense" ? "Despesa" : "Receita"}
                        </td>
                        <td
                          style={{
                            padding: "6px 8px",
                            textAlign: "right",
                            color: row.kind === "expense" ? "#8a2020" : "#15633a",
                          }}
                        >
                          {formatBrl(row.amount.cents)}
                        </td>
                        <td style={{ padding: "6px 8px" }}>
                          <select
                            value={selectedCategory}
                            onChange={(e) =>
                              setRowCategory(index, e.target.value)
                            }
                            style={{ ...inputStyle, padding: "4px 6px" }}
                            aria-label={`Categoria linha ${row.sourceLine}`}
                          >
                            <option value="">(sem categoria)</option>
                            {(bundle?.categories ?? []).map((c) => (
                              <option key={c.id} value={c.id}>
                                {c.name}
                              </option>
                            ))}
                          </select>
                        </td>
                        <td style={{ padding: "6px 8px" }}>
                          <select
                            value={mapping[index]?.subcategoryId ?? ""}
                            onChange={(e) =>
                              setRowSubcategory(index, e.target.value)
                            }
                            disabled={selectedCategory === ""}
                            style={{ ...inputStyle, padding: "4px 6px" }}
                            aria-label={`Subcategoria linha ${row.sourceLine}`}
                          >
                            <option value="">(nenhuma)</option>
                            {subs.map((s) => (
                              <option key={s.id} value={s.id}>
                                {s.name}
                              </option>
                            ))}
                          </select>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* Confirm */}
          <div style={card}>
            <h2 style={{ marginTop: 0, fontSize: 18 }}>3 · Confirmar importação</h2>
            <p style={{ color: "#6b7280", fontSize: 14, marginTop: 0 }}>
              {bundle?.mp !== undefined
                ? "Escolha o cartão de destino e confirme. Nada é gravado até você confirmar; o arquivo original é descartado após o processamento."
                : "Escolha a conta de destino e confirme. Nada é gravado até você confirmar; o arquivo original é descartado após o processamento."}
            </p>
            <div
              style={{
                display: "flex",
                gap: 12,
                flexWrap: "wrap",
                alignItems: "center",
              }}
            >
              {bundle?.mp !== undefined ? (
                <select
                  value={creditCardId}
                  onChange={(e) => setCreditCardId(e.target.value)}
                  style={inputStyle}
                  aria-label="Cartão de destino"
                >
                  <option value="">Cartão de destino…</option>
                  {(bundle?.creditCards ?? []).map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              ) : (
                <select
                  value={accountId}
                  onChange={(e) => setAccountId(e.target.value)}
                  style={inputStyle}
                  aria-label="Conta de destino"
                >
                  <option value="">Conta de destino…</option>
                  {(bundle?.accounts ?? []).map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
              )}
              <button
                type="button"
                onClick={onConfirm}
                disabled={
                  isPending ||
                  (bundle?.mp !== undefined
                    ? creditCardId === ""
                    : accountId === "")
                }
                style={
                  (bundle?.mp !== undefined
                    ? creditCardId === ""
                    : accountId === "") || isPending
                    ? btnGhost
                    : btn
                }
              >
                {isPending ? "Importando…" : "Confirmar importação"}
              </button>
            </div>
            {bundle?.mp !== undefined
              ? (bundle?.creditCards ?? []).length === 0 && (
                  <p style={{ color: "#8a6d00", fontSize: 13, marginTop: 10 }}>
                    Nenhum cartão cadastrado. Cadastre um cartão em “Cartões”
                    antes de importar.
                  </p>
                )
              : (bundle?.accounts ?? []).length === 0 && (
                  <p style={{ color: "#8a6d00", fontSize: 13, marginTop: 10 }}>
                    Nenhuma conta cadastrada. Cadastre uma conta em “Contas”
                    antes de importar.
                  </p>
                )}
          </div>
        </>
      ) : null}
    </section>
  );
}
