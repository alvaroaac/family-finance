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
};

export default function ImportsPage() {
  const [source, setSource] = useState<ImportSource>("minhas-financas");
  const [bundle, setBundle] = useState<PreviewBundle | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [accountId, setAccountId] = useState<string>("");
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
    });
    setMapping({});
    // Pre-exclude probable duplicates so they are not written by default.
    setExcluded(new Set(result.preview.duplicates.map((d) => d.rowIndex)));
    setAccountId(result.accounts[0]?.id ?? "");
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
    if (accountId === "") {
      setConfirmResult({
        ok: false,
        message: "Escolha a conta de destino antes de confirmar.",
      });
      return;
    }
    const rows: NormalizedImportRow[] = bundle.preview.rows;
    const selectedIndices = rows
      .map((_, index) => index)
      .filter((index) => !excluded.has(index));

    startTransition(async () => {
      const result = await confirmImport({
        source: bundle.preview.source,
        rows,
        accountId,
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
        Importe seu histórico do <strong>Minhas Financas</strong> ou{" "}
        <strong>Nubank</strong>. Você verá um <strong>preview normalizado</strong>{" "}
        com possíveis <strong>duplicatas</strong> antes de gravar. O arquivo
        original <strong>não é salvo</strong> — apenas as linhas normalizadas e um
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
          </select>
          <input
            type="file"
            name="file"
            accept=".csv,text/csv"
            required
            style={inputStyle}
            aria-label="Arquivo CSV"
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
              Escolha a conta de destino e confirme. Nada é gravado até você
              confirmar; o arquivo original é descartado após o processamento.
            </p>
            <div
              style={{
                display: "flex",
                gap: 12,
                flexWrap: "wrap",
                alignItems: "center",
              }}
            >
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
              <button
                type="button"
                onClick={onConfirm}
                disabled={isPending || accountId === ""}
                style={accountId === "" || isPending ? btnGhost : btn}
              >
                {isPending ? "Importando…" : "Confirmar importação"}
              </button>
            </div>
            {(bundle?.accounts ?? []).length === 0 ? (
              <p style={{ color: "#8a6d00", fontSize: 13, marginTop: 10 }}>
                Nenhuma conta cadastrada. Cadastre uma conta em “Contas” antes de
                importar.
              </p>
            ) : null}
          </div>
        </>
      ) : null}
    </section>
  );
}
