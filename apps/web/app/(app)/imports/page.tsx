"use client";

import Link from "next/link";
import { useMemo, useState, useTransition } from "react";

import type {
  ImportSource,
  ImportPreview,
  NormalizedImportRow,
} from "@family-finance/importers";

import {
  Badge,
  Button,
  Card,
  Field,
  IconUpload,
  Input,
  RowCardList,
  Select,
  Table,
  TableRow,
  useToast,
} from "../../../components/ui";
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

function formatBrl(cents: number): string {
  return (cents / 100).toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
  });
}

/** "2026-06-05" -> "05/06". */
function formatDayMonth(iso: string): string {
  const [, month, day] = iso.split("-");
  return `${day}/${month}`;
}

type PreviewBundle = {
  preview: ImportPreview;
  accounts: AccountOption[];
  categories: CategoryOption[];
  subcategories: SubcategoryOption[];
  creditCards: CreditCardOption[];
  mp?: MpPreviewExtras;
};

const PREVIEW_COLUMNS = [
  { key: "check", label: "" },
  { key: "dia", label: "Dia" },
  { key: "descricao", label: "Descrição" },
  { key: "valor", label: "Valor", align: "right" as const },
  { key: "categoria", label: "Categoria" },
  { key: "subcategoria", label: "Subcategoria" },
  { key: "status", label: "" },
];

const PREVIEW_GRID = "44px 56px minmax(150px, 1fr) 110px 150px 150px 150px";

/** 3-dot progress (Importacao mockup): Enviar arquivo · Revisar · Confirmar. */
function Stepper({ step }: { step: 1 | 2 | 3 }) {
  const items = [
    { n: 1, label: "Enviar arquivo" },
    { n: 2, label: "Revisar" },
    { n: 3, label: "Confirmar" },
  ];
  return (
    <div className="ff-steps">
      {items.map((item, i) => (
        <span key={item.n} style={{ display: "contents" }}>
          {i > 0 ? (
            <span
              className={`ff-steps__line${step > item.n - 1 ? " ff-steps__line--done" : ""}`}
            />
          ) : null}
          <span
            className={`ff-step${
              step > item.n
                ? " ff-step--done"
                : step === item.n
                  ? " ff-step--current"
                  : ""
            }`}
          >
            <span className="ff-step__dot">{step > item.n ? "✓" : item.n}</span>
            <span className="ff-step__label">{item.label}</span>
          </span>
        </span>
      ))}
    </div>
  );
}

export default function ImportsPage() {
  const [source, setSource] = useState<ImportSource>("minhas-financas");
  const [bundle, setBundle] = useState<PreviewBundle | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [accountId, setAccountId] = useState<string>("");
  const [creditCardId, setCreditCardId] = useState<string>("");
  // Purely presentational: the chosen file's name echoed in the dropzone.
  const [fileName, setFileName] = useState<string | null>(null);
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
  const toast = useToast();

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
        toast.success("Importação concluída.");
      } else {
        toast.error(result.message);
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

  const step: 1 | 2 | 3 =
    confirmResult?.ok === true ? 3 : preview !== null ? 2 : 1;

  const isMp = bundle?.mp !== undefined;

  // Footer summary — "28 novos · 1 duplicata desmarcada · 1 já importada …".
  const selectedIndices = useMemo(
    () =>
      (preview?.rows ?? [])
        .map((_, index) => index)
        .filter((index) => !excluded.has(index)),
    [preview, excluded],
  );
  const selectedCount = selectedIndices.length;
  const excludedDuplicates = [...duplicateIndices].filter((i) =>
    excluded.has(i),
  ).length;
  const dbDuplicateCount = bundle?.mp?.dbDuplicateIndices.length ?? 0;
  const semCategoriaCount = selectedIndices.filter(
    (i) => (mapping[i]?.categoryId ?? "") === "",
  ).length;

  const summaryParts: string[] = [];
  if (excludedDuplicates > 0) {
    summaryParts.push(
      excludedDuplicates === 1
        ? "1 duplicata desmarcada"
        : `${excludedDuplicates} duplicatas desmarcadas`,
    );
  }
  if (dbDuplicateCount > 0) {
    summaryParts.push(
      dbDuplicateCount === 1
        ? "1 já importada"
        : `${dbDuplicateCount} já importadas`,
    );
  }
  if (semCategoriaCount > 0) {
    summaryParts.push(
      semCategoriaCount === 1
        ? "1 sem categoria"
        : `${semCategoriaCount} sem categoria`,
    );
  }

  const summaryLine = (
    <span className="ff-table__foot-note ff-num">
      <strong style={{ fontWeight: 600, color: "var(--ff-ink)" }}>
        {selectedCount === 1 ? "1 novo" : `${selectedCount} novos`}
      </strong>
      {summaryParts.length > 0 ? ` · ${summaryParts.join(" · ")}` : ""}
    </span>
  );

  const destinationSelect = isMp ? (
    <Select
      value={creditCardId}
      onChange={(e) => setCreditCardId(e.target.value)}
      aria-label="Cartão de destino"
    >
      <option value="">Cartão de destino…</option>
      {(bundle?.creditCards ?? []).map((c) => (
        <option key={c.id} value={c.id}>
          {c.name}
        </option>
      ))}
    </Select>
  ) : (
    <Select
      value={accountId}
      onChange={(e) => setAccountId(e.target.value)}
      aria-label="Conta de destino"
    >
      <option value="">Conta de destino…</option>
      {(bundle?.accounts ?? []).map((a) => (
        <option key={a.id} value={a.id}>
          {a.name}
        </option>
      ))}
    </Select>
  );

  const confirmDisabled =
    isPending || (isMp ? creditCardId === "" : accountId === "");
  const confirmLabel = isPending
    ? "Importando…"
    : selectedCount === 1
      ? "Gravar 1 lançamento"
      : `Gravar ${selectedCount} lançamentos`;

  return (
    <section>
      <header>
        <div className="ff-kicker" style={{ letterSpacing: "0.26em" }}>
          Nossa casa · Importação
        </div>
        <h1 className="ff-page-title__heading">
          {step === 1 ? "O que chegou pra gente?" : "Dá uma olhada antes de gravar"}
        </h1>
        <p className="ff-page-title__lead">
          {step === 1
            ? "CSV do Minhas Financas, do Nubank ou fatura em PDF do Mercado Pago."
            : "Nada entra sem a sua revisão — desmarca o que não for da casa."}
        </p>
      </header>

      <Stepper step={step} />

      {previewError ? (
        <div
          role="alert"
          className="ff-alert ff-alert--negative"
          style={{ marginTop: 20 }}
        >
          {previewError}
        </div>
      ) : null}

      {confirmResult !== null && !confirmResult.ok ? (
        <div
          role="status"
          className="ff-alert ff-alert--warn"
          style={{ marginTop: 20 }}
        >
          {confirmResult.message}
        </div>
      ) : null}

      {/* ---- Passo 3 · Confirmado ---- */}
      {step === 3 && confirmResult !== null ? (
        <div style={{ maxWidth: 620, marginTop: 24 }}>
          <Card>
            <div className="ff-kicker" style={{ letterSpacing: "0.26em" }}>
              Importação · Passo 3 de 3
            </div>
            <div className="ff-success">
              <span className="ff-success__badge">✓</span>
              <h2 className="ff-success__title ff-serif">Tudo guardado ✨</h2>
              <p className="ff-success__lead" role="status">
                {confirmResult.message}
              </p>
              <div className="ff-success__actions">
                <Link href="/transactions" className="ff-btn ff-btn--primary">
                  Ver na lista
                </Link>
                <Button variant="ghost" onClick={() => setConfirmResult(null)}>
                  Importar outra
                </Button>
              </div>
            </div>
          </Card>
        </div>
      ) : null}

      {/* ---- Passo 1 · Enviar arquivo ---- */}
      {step === 1 ? (
        <div style={{ maxWidth: 620, marginTop: 24 }}>
          <Card>
            <form action={onPreview}>
              <Field label="Origem">
                <Select
                  name="source"
                  value={source}
                  onChange={(e) => setSource(e.target.value as ImportSource)}
                  aria-label="Fonte"
                >
                  <option value="minhas-financas">Minhas Financas (CSV)</option>
                  <option value="nubank">Nubank (CSV)</option>
                  <option value="mercado-pago">Mercado Pago (Fatura PDF)</option>
                </Select>
              </Field>

              <label className="ff-dropzone">
                <input
                  className="ff-dropzone__input"
                  type="file"
                  name="file"
                  accept={
                    source === "mercado-pago"
                      ? ".pdf,application/pdf"
                      : ".csv,text/csv"
                  }
                  onChange={(e) =>
                    setFileName(e.target.files?.[0]?.name ?? null)
                  }
                  aria-label="Arquivo"
                />
                <span className="ff-dropzone__icon">
                  <IconUpload size={20} />
                </span>
                <span className="ff-dropzone__title">
                  {fileName ?? "Solta o arquivo aqui"}
                </span>
                <span className="ff-dropzone__hint">
                  ou <strong>escolhe do computador</strong> · PDF ou CSV
                </span>
              </label>

              <div style={{ marginTop: 18 }}>
                <button
                  type="submit"
                  className="ff-btn ff-btn--primary"
                  style={{ width: "100%", padding: 13 }}
                >
                  Ver prévia →
                </button>
              </div>

              <p className="ff-note" style={{ marginTop: 14, marginBottom: 0 }}>
                Você verá um preview normalizado com possíveis duplicatas antes
                de gravar. O arquivo original não é salvo — apenas as linhas
                normalizadas e um resumo do lote.
              </p>
            </form>
          </Card>
        </div>
      ) : null}

      {/* ---- Passo 2 · Revisar ---- */}
      {step === 2 && preview !== null ? (
        <>
          {/* Errors */}
          {preview.errors.length > 0 ? (
            <div style={{ marginTop: 24 }}>
              <Card>
                <div className="ff-panel__head">
                  <h2 className="ff-h2">
                    Linhas não importadas ({preview.errors.length})
                  </h2>
                </div>
                <p className="ff-note" style={{ marginTop: 10 }}>
                  Estas linhas não puderam ser mapeadas. Corrija no arquivo e
                  importe novamente, se necessário. O restante segue
                  normalmente.
                </p>
                <ul
                  style={{
                    margin: "10px 0 0",
                    paddingLeft: 18,
                    fontSize: 13,
                    color: "var(--ff-negative)",
                  }}
                >
                  {preview.errors.map((e) => (
                    <li key={e.sourceLine}>
                      Linha {e.sourceLine}: {e.message}
                    </li>
                  ))}
                </ul>
              </Card>
            </div>
          ) : null}

          {/* Parcelamentos detectados (Mercado Pago) */}
          {bundle?.mp !== undefined && bundle.mp.groups.length > 0 ? (
            <div style={{ marginTop: 24 }}>
              <Card>
                <div className="ff-panel__head">
                  <h2 className="ff-h2">Parcelamentos detectados</h2>
                  <span className="ff-note">
                    {bundle.mp.groups.length === 1
                      ? "a gente achou 1 compra parcelada nessa fatura"
                      : `a gente achou ${bundle.mp.groups.length} compras parceladas nessa fatura`}
                  </span>
                </div>
                <div className="ff-groups-grid">
                  {bundle.mp.groups.map((g, i) => {
                    const edit = groupEdits[i];
                    if (edit === undefined) return null;
                    return (
                      <div
                        key={i}
                        className={`ff-group${
                          g.status === "new" ? " ff-group--new" : ""
                        }${edit.skip ? " ff-off" : ""}`}
                      >
                        <div className="ff-group__head">
                          <span className="ff-group__name">
                            {g.description}
                          </span>
                          <Badge
                            tone={g.status === "exists" ? "neutral" : "positive"}
                          >
                            {g.status === "exists" ? "já existe" : "novo"}
                          </Badge>
                        </div>
                        <div className="ff-group__grid">
                          <Field label="Total">
                            <Input
                              className="ff-input--compact ff-num"
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
                                      Number.parseFloat(
                                        e.target.value || "0",
                                      ) * 100,
                                    ),
                                  },
                                }))
                              }
                              aria-label={`Total do parcelamento ${g.description}`}
                            />
                          </Field>
                          <Field label="Parcelas">
                            <Input
                              className="ff-input--compact ff-num"
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
                              aria-label={`Quantidade de parcelas ${g.description}`}
                            />
                          </Field>
                          <Field label="Compra">
                            <Input
                              className="ff-input--compact ff-num"
                              type="date"
                              value={edit.purchasedOn}
                              onChange={(e) =>
                                setGroupEdits((prev) => ({
                                  ...prev,
                                  [i]: { ...edit, purchasedOn: e.target.value },
                                }))
                              }
                              aria-label={`Data da compra ${g.description}`}
                            />
                          </Field>
                        </div>
                        <div className="ff-group__foot">
                          <span className="ff-group__hint">
                            {g.status === "exists"
                              ? `vamos ligar a parcela ${g.installmentNumber}/${g.installmentCount} ao grupo que já existe`
                              : `parcela ${g.installmentNumber} de ${g.installmentCount} · ${formatBrl(g.perInstallmentCents)}`}
                            {g.cardLast4 ? ` · final ${g.cardLast4}` : ""}
                          </span>
                          <label className="ff-group__skip">
                            <input
                              className="ff-check"
                              type="checkbox"
                              checked={edit.skip}
                              onChange={() =>
                                setGroupEdits((prev) => ({
                                  ...prev,
                                  [i]: { ...edit, skip: !edit.skip },
                                }))
                              }
                              aria-label={`Pular parcelamento ${g.description}`}
                            />
                            pular
                          </label>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </Card>
            </div>
          ) : null}

          {/* Preview rows */}
          <div
            className="ff-panel__head"
            style={{ marginTop: 24, marginBottom: 12 }}
          >
            <h2 className="ff-h2">Prévia dos lançamentos</h2>
            <span className="ff-note">duplicatas já vêm desmarcadas</span>
          </div>

          <Table columns={PREVIEW_COLUMNS} gridTemplate={PREVIEW_GRID}>
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
              const isExpense = row.kind === "expense";
              return (
                <TableRow
                  key={index}
                  className={isExcluded ? "ff-off" : undefined}
                >
                  <input
                    className="ff-check"
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
                  <span className="ff-dim ff-num">
                    {formatDayMonth(row.occurredOn)}
                  </span>
                  <span
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      minWidth: 0,
                      fontWeight: 500,
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
                    {row.installment !== undefined ? (
                      <Badge tone="accent">
                        {row.installment.number}/{row.installment.count}
                      </Badge>
                    ) : null}
                  </span>
                  <span
                    className={`ff-num ${isExpense ? "ff-amount--neg" : "ff-amount--pos"}`}
                    style={{
                      textAlign: "right",
                      whiteSpace: "nowrap",
                      fontWeight: 600,
                    }}
                  >
                    {isExpense ? "− " : "+ "}
                    {formatBrl(row.amount.cents)}
                  </span>
                  <span>
                    {isInstallmentRow ? (
                      <span className="ff-dim" style={{ fontStyle: "italic" }}>
                        —
                      </span>
                    ) : (
                      <Select
                        className={`ff-select--compact${
                          selectedCategory === "" ? " ff-select--warn" : ""
                        }`}
                        value={selectedCategory}
                        onChange={(e) => setRowCategory(index, e.target.value)}
                        aria-label={`Categoria linha ${row.sourceLine}`}
                      >
                        <option value="">escolher…</option>
                        {(bundle?.categories ?? []).map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name}
                          </option>
                        ))}
                      </Select>
                    )}
                  </span>
                  <span>
                    {isInstallmentRow ? null : (
                      <Select
                        className="ff-select--compact"
                        value={mapping[index]?.subcategoryId ?? ""}
                        onChange={(e) =>
                          setRowSubcategory(index, e.target.value)
                        }
                        disabled={selectedCategory === ""}
                        aria-label={`Subcategoria linha ${row.sourceLine}`}
                      >
                        <option value="">(nenhuma)</option>
                        {subs.map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.name}
                          </option>
                        ))}
                      </Select>
                    )}
                  </span>
                  <span
                    style={{
                      display: "flex",
                      gap: 6,
                      justifyContent: "flex-end",
                      flexWrap: "wrap",
                    }}
                  >
                    {isDuplicate ? (
                      <Badge tone="negative">duplicata provável</Badge>
                    ) : null}
                    {isDbDuplicate ? (
                      <Badge tone="neutral">já importada</Badge>
                    ) : null}
                    {isInstallmentRow ? (
                      <span className="ff-note">entra pelo parcelamento</span>
                    ) : null}
                    {!isDuplicate &&
                    !isDbDuplicate &&
                    !isInstallmentRow &&
                    !isExcluded &&
                    selectedCategory === "" ? (
                      <Badge tone="warn">sem categoria</Badge>
                    ) : null}
                  </span>
                </TableRow>
              );
            })}

            {/* Footer (desktop): summary + destino + voltar/gravar */}
            <div className="ff-table__foot">
              {summaryLine}
              <span
                style={{
                  display: "flex",
                  gap: 10,
                  alignItems: "center",
                  flexWrap: "wrap",
                }}
              >
                <span style={{ minWidth: 190 }}>{destinationSelect}</span>
                <Button variant="ghost" onClick={() => setBundle(null)}>
                  ‹ Voltar
                </Button>
                <Button
                  variant="primary"
                  onClick={onConfirm}
                  disabled={confirmDisabled}
                >
                  {confirmLabel}
                </Button>
              </span>
            </div>
          </Table>

          {/* Mobile collapse of the preview rows */}
          <RowCardList>
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
              const isExpense = row.kind === "expense";
              return (
                <Card
                  key={index}
                  className={`ff-rowcard${isExcluded ? " ff-off" : ""}`}
                >
                  <input
                    className="ff-check"
                    type="checkbox"
                    checked={!isExcluded}
                    onChange={() => toggleExcluded(index)}
                    disabled={isInstallmentRow}
                    aria-label={`Importar linha ${row.sourceLine}`}
                  />
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
                          gap: 6,
                          minWidth: 0,
                        }}
                      >
                        <span className="ff-txrow__desc">{row.description}</span>
                        {row.installment !== undefined ? (
                          <Badge tone="accent">
                            {row.installment.number}/{row.installment.count}
                          </Badge>
                        ) : null}
                      </span>
                      <span
                        className={`ff-txrow__amount ff-num ${
                          isExpense ? "ff-amount--neg" : "ff-amount--pos"
                        }`}
                      >
                        {isExpense ? "− " : "+ "}
                        {formatBrl(row.amount.cents)}
                      </span>
                    </div>
                    <div
                      className="ff-txrow__meta"
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 6,
                        flexWrap: "wrap",
                      }}
                    >
                      {formatDayMonth(row.occurredOn)}
                      {isDuplicate ? (
                        <Badge tone="negative">duplicata provável</Badge>
                      ) : null}
                      {isDbDuplicate ? (
                        <Badge tone="neutral">já importada</Badge>
                      ) : null}
                      {isInstallmentRow ? (
                        <span className="ff-note">entra pelo parcelamento</span>
                      ) : null}
                    </div>
                    {!isInstallmentRow ? (
                      <div
                        style={{
                          display: "flex",
                          gap: 8,
                          marginTop: 10,
                          flexWrap: "wrap",
                        }}
                      >
                        <span style={{ flex: 1, minWidth: 130 }}>
                          <Select
                            className={`ff-select--compact${
                              selectedCategory === "" ? " ff-select--warn" : ""
                            }`}
                            value={selectedCategory}
                            onChange={(e) =>
                              setRowCategory(index, e.target.value)
                            }
                            aria-label={`Categoria linha ${row.sourceLine}`}
                          >
                            <option value="">escolher categoria…</option>
                            {(bundle?.categories ?? []).map((c) => (
                              <option key={c.id} value={c.id}>
                                {c.name}
                              </option>
                            ))}
                          </Select>
                        </span>
                        <span style={{ flex: 1, minWidth: 130 }}>
                          <Select
                            className="ff-select--compact"
                            value={mapping[index]?.subcategoryId ?? ""}
                            onChange={(e) =>
                              setRowSubcategory(index, e.target.value)
                            }
                            disabled={selectedCategory === ""}
                            aria-label={`Subcategoria linha ${row.sourceLine}`}
                          >
                            <option value="">(nenhuma)</option>
                            {subs.map((s) => (
                              <option key={s.id} value={s.id}>
                                {s.name}
                              </option>
                            ))}
                          </Select>
                        </span>
                      </div>
                    ) : null}
                  </div>
                </Card>
              );
            })}
          </RowCardList>

          {/* Mobile twin of the footer (the table is hidden under 720px). */}
          <div className="ff-mobile-foot" style={{ alignItems: "stretch" }}>
            <div style={{ textAlign: "center" }}>{summaryLine}</div>
            {destinationSelect}
            <div style={{ display: "flex", gap: 8 }}>
              <Button variant="ghost" onClick={() => setBundle(null)}>
                ‹ Voltar
              </Button>
              <span style={{ flex: 1, display: "flex" }}>
                <span style={{ flex: 1 }}>
                  <button
                    type="button"
                    className="ff-btn ff-btn--primary"
                    style={{ width: "100%" }}
                    onClick={onConfirm}
                    disabled={confirmDisabled}
                  >
                    {confirmLabel}
                  </button>
                </span>
              </span>
            </div>
          </div>

          {isMp && (bundle?.creditCards ?? []).length === 0 ? (
            <div className="ff-alert ff-alert--warn" style={{ marginTop: 16 }}>
              Nenhum cartão cadastrado. Cadastre um cartão em “Cartões” antes de
              importar.
            </div>
          ) : null}
          {!isMp && (bundle?.accounts ?? []).length === 0 ? (
            <div className="ff-alert ff-alert--warn" style={{ marginTop: 16 }}>
              Nenhuma conta cadastrada. Cadastre uma conta em “Contas” antes de
              importar.
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
