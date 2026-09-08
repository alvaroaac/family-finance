"use client";

import Link from "next/link";
import { useEffect, useMemo, useState, useTransition } from "react";

import type { ImportSource, ImportPreview } from "@family-finance/importers";

import {
  Badge,
  Button,
  Card,
  Field,
  IconUpload,
  Input,
  RowCardList,
  Select,
  SubmitButton,
  Table,
  TableRow,
  useToast,
} from "../../../components/ui";
import {
  previewImport,
  confirmImport,
  suggestImportCategories,
  resolveImportTargets,
  type AccountOption,
  type CategoryOption,
  type SubcategoryOption,
  type CreditCardOption,
  type MpPreviewExtras,
  type ConfirmResult,
  type ImportPreviewSnapshot,
  type ImportAiSuggestion,
  type InstallmentCandidateMatch,
} from "./actions";
import {
  normalizeMerchantKey,
  type BatchCategorizationPlan,
} from "@family-finance/categorization";

// NOTE: server-driven page metadata cannot be exported from a client component.
// The layout already establishes the "Casa" workspace title; this screen is the
// "Importação" nav entry.

function formatBrl(cents: number): string {
  return (cents / 100).toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
  });
}

function providerLabel(provider: "codex" | "paid_fallback"): string {
  return provider === "codex" ? "Codex" : "fallback pago";
}

function installmentConfidenceLabel(
  confidence: InstallmentCandidateMatch["confidence"],
): string {
  if (confidence === "very_strong") return "confiança muito forte";
  if (confidence === "strong") return "confiança forte";
  return "confiança média";
}

/** "2026-06-05" -> "05/06". */
function formatDayMonth(iso: string): string {
  const [, month, day] = iso.split("-");
  return `${day}/${month}`;
}

type PreviewBundle = {
  requestKey: string;
  previewToken: string;
  fileFingerprint: string;
  normalizedFingerprint: string;
  parserVersion: string;
  snapshot: ImportPreviewSnapshot;
  preview: ImportPreview;
  categorizationPlan: BatchCategorizationPlan;
  priorDispositions: Record<
    number,
    | "imported"
    | "duplicate_existing"
    | "duplicate_in_file"
    | "parser_error"
    | "validation_error"
    | "excluded"
  >;
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
  const [cardByLast4, setCardByLast4] = useState<Record<string, string>>({});
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
        categoryId?: string;
        subcategoryId?: string;
      }
    >
  >({});
  const [persistedGroupDuplicates, setPersistedGroupDuplicates] = useState<
    Set<number>
  >(new Set());
  const [persistedGroupClaimIds, setPersistedGroupClaimIds] = useState<
    Record<number, string>
  >({});
  const [groupOverrides, setGroupOverrides] = useState<
    Record<number, { token?: string; claimId?: string; reason: string }>
  >({});
  const [groupMatchesByIndex, setGroupMatchesByIndex] = useState<
    Record<number, InstallmentCandidateMatch[]>
  >({});
  const [groupMatchDecisions, setGroupMatchDecisions] = useState<
    Record<number, "keep_existing" | "import_anyway">
  >({});
  const [mapping, setMapping] = useState<
    Record<number, { categoryId?: string; subcategoryId?: string }>
  >({});
  const [excluded, setExcluded] = useState<Set<number>>(new Set());
  const [confirmResult, setConfirmResult] = useState<ConfirmResult | null>(
    null,
  );
  const [aiSuggestions, setAiSuggestions] = useState<
    Record<number, ImportAiSuggestion>
  >({});
  const [aiMessage, setAiMessage] = useState<string | null>(null);
  const [taxonomyProposals, setTaxonomyProposals] = useState<
    Array<{
      rowKey: string;
      categoryName: string;
      subcategoryName: string | null;
      explanation: string;
      provider: "codex" | "paid_fallback";
    }>
  >([]);
  const [persistedDuplicates, setPersistedDuplicates] = useState<Set<number>>(
    new Set(),
  );
  const [learning, setLearning] = useState<
    Record<number, { sourceCategory?: boolean; merchant?: boolean }>
  >({});
  const [rowEdits, setRowEdits] = useState<
    Record<
      number,
      {
        occurredOn?: string;
        description?: string;
        amountCents?: number;
        kind?: "expense" | "income";
      }
    >
  >({});
  const [overrides, setOverrides] = useState<
    Record<number, { token?: string; claimId?: string; reason: string }>
  >({});
  const [persistedClaimIds, setPersistedClaimIds] = useState<
    Record<number, string>
  >({});
  const [provenance, setProvenance] = useState<
    Record<
      number,
      {
        source:
          | "memory"
          | "source_mapping"
          | "rule"
          | "codex"
          | "paid_fallback"
          | "user";
        confidence?: number;
        accepted: boolean;
        changed: boolean;
      }
    >
  >({});
  const [bulkCategoryId, setBulkCategoryId] = useState("");
  const [bulkMerchantKey, setBulkMerchantKey] = useState("");
  const [bulkSourceLabel, setBulkSourceLabel] = useState("");
  const [mappingUndo, setMappingUndo] = useState<typeof mapping | null>(null);
  const [isPending, startTransition] = useTransition();
  const toast = useToast();

  // Rows flagged as probable duplicates start excluded from the write.
  const duplicateIndices = useMemo(
    () => new Set(bundle?.preview.duplicates.map((d) => d.rowIndex) ?? []),
    [bundle],
  );
  const suppressedIndices = useMemo(
    () =>
      new Set(
        (bundle?.categorizationPlan.rows ?? []).flatMap((row, index) =>
          row.status === "suppressed" ? [index] : [],
        ),
      ),
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
      requestKey: result.requestKey,
      previewToken: result.previewToken,
      fileFingerprint: result.fileFingerprint,
      normalizedFingerprint: result.normalizedFingerprint,
      parserVersion: result.parserVersion,
      snapshot: result.snapshot,
      preview: result.preview,
      categorizationPlan: result.categorizationPlan,
      priorDispositions: result.priorDispositions,
      accounts: result.accounts,
      categories: result.categories,
      subcategories: result.subcategories,
      creditCards: result.creditCards,
      mp: result.mp,
    });
    const initialMapping: Record<
      number,
      { categoryId?: string; subcategoryId?: string }
    > = {};
    result.categorizationPlan.rows.forEach((planned, index) => {
      if (planned.status === "selected" && planned.selection !== null) {
        initialMapping[index] = {
          categoryId: planned.selection.categoryId,
          subcategoryId: planned.selection.subcategoryId,
        };
      }
    });
    const initialProvenance: typeof provenance = {};
    result.categorizationPlan.rows.forEach((planned, index) => {
      const candidate = planned.candidates[0];
      if (planned.selection !== null) {
        initialProvenance[index] = {
          source: planned.selection.source,
          confidence: candidate?.confidence,
          accepted: true,
          changed: false,
        };
      }
    });
    setProvenance(initialProvenance);
    setBulkCategoryId("");
    setBulkMerchantKey("");
    setBulkSourceLabel("");
    setMappingUndo(null);
    setMapping(initialMapping);
    // Destination is a claim identity component. Never guess it.
    setAccountId("");
    setCreditCardId("");
    setCardByLast4({});
    setAiSuggestions({});
    setAiMessage(null);
    setTaxonomyProposals([]);
    setPersistedDuplicates(new Set(result.mp?.dbDuplicateIndices ?? []));
    setLearning({});
    setRowEdits({});
    setOverrides({});
    setPersistedClaimIds({});
    setPersistedGroupDuplicates(new Set());
    setPersistedGroupClaimIds({});
    setGroupOverrides({});
    setGroupMatchesByIndex({});
    setGroupMatchDecisions({});
    const edits: Record<
      number,
      {
        totalAmountCents: number;
        installmentCount: number;
        purchasedOn: string;
        skip: boolean;
        categoryId?: string;
        subcategoryId?: string;
      }
    > = {};
    (result.mp?.groups ?? []).forEach((g, i) => {
      edits[i] = {
        totalAmountCents: g.estimatedTotalCents,
        installmentCount: g.installmentCount,
        purchasedOn: g.purchasedOn,
        skip: false,
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

  useEffect(() => {
    if (bundle === null) return;
    const mp = bundle.mp !== undefined;
    const required = [
      ...new Set(
        bundle.preview.rows
          .map((row) => row.cardLast4)
          .filter((value): value is string => value !== undefined),
      ),
    ];
    const needsDefault =
      bundle.preview.rows.some((row) => row.cardLast4 === undefined) ||
      required.length === 0;
    const ready = mp
      ? required.every((last4) => (cardByLast4[last4] ?? "") !== "") &&
        (!needsDefault || creditCardId !== "")
      : accountId !== "";
    if (!ready) return;
    let cancelled = false;
    void resolveImportTargets({
      previewToken: bundle.previewToken,
      snapshot: bundle.snapshot,
      accountId: mp ? undefined : accountId,
      creditCardId: mp ? creditCardId || undefined : undefined,
      creditCardByLast4: mp ? cardByLast4 : undefined,
    }).then((result) => {
      if (cancelled || !result.ok) return;
      const nextPersisted = new Set(result.duplicateIndices);
      setPersistedClaimIds(result.claimIdsByIndex);
      const nextGroupPersisted = new Set(result.groupDuplicateIndices);
      setGroupMatchesByIndex(result.groupMatchesByIndex);
      setGroupMatchDecisions({});
      setPersistedGroupClaimIds(result.groupClaimIdsByIndex);
      setPersistedGroupDuplicates((previousPersisted) => {
        setGroupEdits((previousEdits) => {
          const updated = { ...previousEdits };
          for (const index of previousPersisted) {
            const edit = updated[index];
            if (edit !== undefined) updated[index] = { ...edit, skip: false };
          }
          for (const index of nextGroupPersisted) {
            const edit = updated[index];
            if (edit !== undefined) updated[index] = { ...edit, skip: true };
          }
          return updated;
        });
        return nextGroupPersisted;
      });
      setGroupOverrides({});
      setPersistedDuplicates((previousPersisted) => {
        setExcluded((previous) => {
          const next = new Set(previous);
          for (const index of previousPersisted) next.delete(index);
          for (const index of nextPersisted) next.add(index);
          for (const duplicate of bundle.preview.duplicates)
            next.add(duplicate.rowIndex);
          for (const index of bundle.mp?.installmentRowIndices ?? [])
            next.add(index);
          return next;
        });
        return nextPersisted;
      });
    });
    return () => {
      cancelled = true;
    };
  }, [bundle, accountId, creditCardId, cardByLast4]);

  function toggleExcluded(index: number) {
    setExcluded((prev) => {
      const next = new Set(prev);
      if (next.has(index)) {
        if (persistedDuplicates.has(index) || duplicateIndices.has(index)) {
          const reason = window.prompt(
            "Esta linha já foi importada. Por que deseja importar novamente?",
          );
          if (reason === null || reason.trim().length < 5) return prev;
          setOverrides((current) => ({
            ...current,
            [index]: {
              ...(persistedClaimIds[index] === undefined
                ? {}
                : {
                    token: crypto.randomUUID(),
                    claimId: persistedClaimIds[index],
                  }),
              reason: reason.trim().slice(0, 200),
            },
          }));
        }
        next.delete(index);
      } else {
        next.add(index);
        setOverrides((current) => {
          const updated = { ...current };
          delete updated[index];
          return updated;
        });
      }
      return next;
    });
  }

  function setRowCategory(index: number, categoryId: string) {
    setMapping((prev) => ({
      ...prev,
      [index]: {
        categoryId: categoryId || undefined,
        subcategoryId: undefined,
      },
    }));
    setProvenance((previous) => ({
      ...previous,
      [index]: { source: "user", accepted: true, changed: true },
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
    setProvenance((previous) => ({
      ...previous,
      [index]: { source: "user", accepted: true, changed: true },
    }));
  }

  function onSuggestCategories() {
    if (bundle === null) return;
    setAiMessage(null);
    startTransition(async () => {
      const result = await suggestImportCategories({
        previewToken: bundle.previewToken,
        snapshot: bundle.snapshot,
      });
      if (!result.ok) {
        setAiMessage(
          `${result.message} Você ainda pode categorizar e importar manualmente.`,
        );
        return;
      }
      const byIndex: Record<number, ImportAiSuggestion> = {};
      const indexByRowKey = new Map(
        bundle.categorizationPlan.rows.map((row, index) => [row.rowKey, index]),
      );
      for (const suggestion of result.suggestions) {
        const index = indexByRowKey.get(suggestion.rowKey);
        if (index !== undefined && mapping[index]?.categoryId === undefined) {
          byIndex[index] = suggestion;
        }
      }
      setAiSuggestions(byIndex);
      setTaxonomyProposals(result.proposals);
      const parts = [
        `${Object.keys(byIndex).length} sugestão(ões) para revisar`,
      ];
      if (result.proposals.length > 0) {
        parts.push(
          `${result.proposals.length} proposta(s) de categoria nova — nenhuma foi criada`,
        );
      }
      if (result.unresolvedCount > 0)
        parts.push(`${result.unresolvedCount} sem sugestão`);
      setAiMessage(parts.join(" · "));
    });
  }

  function applyAiSuggestion(index: number) {
    const suggestion = aiSuggestions[index];
    if (suggestion === undefined) return;
    setMapping((previous) => ({
      ...previous,
      [index]: {
        categoryId: suggestion.categoryId,
        subcategoryId: suggestion.subcategoryId,
      },
    }));
    setProvenance((previous) => ({
      ...previous,
      [index]: {
        source: suggestion.provider,
        confidence: suggestion.confidence,
        accepted: true,
        changed: false,
      },
    }));
    setAiSuggestions((previous) => {
      const next = { ...previous };
      delete next[index];
      return next;
    });
  }

  function applyBulkCategory(
    mode: "selected" | "unresolved" | "merchant" | "source",
  ) {
    if (bundle === null || bulkCategoryId === "") return;
    setMappingUndo(mapping);
    const next = { ...mapping };
    const changed: number[] = [];
    bundle.preview.rows.forEach((row, index) => {
      if (
        excluded.has(index) ||
        bundle.mp?.installmentRowIndices.includes(index)
      )
        return;
      const matches =
        mode === "selected"
          ? true
          : mode === "unresolved"
            ? (mapping[index]?.categoryId ?? "") === ""
            : mode === "merchant"
              ? normalizeMerchantKey(row.description) === bulkMerchantKey
              : (row.sourceCategory ?? "") === bulkSourceLabel;
      if (!matches) return;
      next[index] = { categoryId: bulkCategoryId };
      changed.push(index);
    });
    setMapping(next);
    setProvenance((previous) => {
      const updated = { ...previous };
      for (const index of changed) {
        updated[index] = { source: "user", accepted: true, changed: true };
      }
      return updated;
    });
  }

  function undoBulkCategory() {
    if (mappingUndo === null) return;
    setMapping(mappingUndo);
    setMappingUndo(null);
  }

  function onConfirm() {
    if (bundle === null) {
      return;
    }
    const isMp = bundle.mp !== undefined;
    const requiredLast4s = [
      ...new Set(
        bundle.preview.rows
          .map((row) => row.cardLast4)
          .filter((value): value is string => value !== undefined),
      ),
    ];
    const needsDefaultCard =
      bundle.preview.rows.some((row) => row.cardLast4 === undefined) ||
      requiredLast4s.length === 0;
    const allMpTargets =
      requiredLast4s.every((last4) => (cardByLast4[last4] ?? "") !== "") &&
      (!needsDefaultCard || creditCardId !== "");
    if (isMp ? !allMpTargets : accountId === "") {
      setConfirmResult({
        ok: false,
        message: isMp
          ? "Escolha o cartão de destino antes de confirmar."
          : "Escolha a conta de destino antes de confirmar.",
      });
      return;
    }
    const pendingMatchReview = Object.entries(groupMatchesByIndex).find(
      ([rawIndex, matches]) => {
        const index = Number.parseInt(rawIndex, 10);
        return (
          matches.length > 0 &&
          groupEdits[index]?.skip === false &&
          groupMatchDecisions[index] === undefined
        );
      },
    );
    if (pendingMatchReview !== undefined) {
      setConfirmResult({
        ok: false,
        message:
          "Compare os possíveis parcelamentos existentes e escolha manter ou importar mesmo assim.",
      });
      return;
    }
    const selectedIndices = bundle.preview.rows
      .map((_, index) => index)
      .filter((index) => !excluded.has(index));
    const groups = isMp
      ? (bundle.mp?.groups ?? [])
          .map((g, i) => ({ g, edit: groupEdits[i] }))
          .filter((x) => x.edit !== undefined && !x.edit.skip)
          .map(({ g, edit }) => ({
            sourceGroupIndex: bundle.mp?.groups.indexOf(g) ?? -1,
            description: g.description,
            totalAmountCents: edit!.totalAmountCents,
            installmentCount: edit!.installmentCount,
            purchasedOn: edit!.purchasedOn,
            categoryId: edit!.categoryId,
            subcategoryId: edit!.subcategoryId,
            creditCardId:
              (g.cardLast4 ? cardByLast4[g.cardLast4] : undefined) ??
              creditCardId,
            cardLast4: g.cardLast4,
            ...(groupOverrides[bundle.mp?.groups.indexOf(g) ?? -1] === undefined
              ? {}
              : {
                  override: groupOverrides[bundle.mp?.groups.indexOf(g) ?? -1],
                }),
          }))
      : undefined;

    startTransition(async () => {
      const result = await confirmImport({
        previewToken: bundle.previewToken,
        snapshot: bundle.snapshot,
        requestKey: bundle.requestKey,
        fileFingerprint: bundle.fileFingerprint,
        normalizedFingerprint: bundle.normalizedFingerprint,
        parserVersion: bundle.parserVersion,
        source: bundle.preview.source,
        accountId: isMp ? "" : accountId,
        creditCardId: isMp ? creditCardId : undefined,
        creditCardByLast4: isMp ? cardByLast4 : undefined,
        groups,
        mapping,
        selectedIndices,
        learning,
        edits: rowEdits,
        overrides,
        provenance,
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
  const bulkMerchantKeys = useMemo(
    () =>
      [
        ...new Set(
          (bundle?.preview.rows ?? []).map((row) =>
            normalizeMerchantKey(row.description),
          ),
        ),
      ].sort(),
    [bundle],
  );
  const bulkSourceLabels = useMemo(
    () =>
      [
        ...new Set(
          (bundle?.preview.rows ?? []).flatMap((row) =>
            row.sourceCategory === undefined ? [] : [row.sourceCategory],
          ),
        ),
      ].sort(),
    [bundle],
  );
  const mpCardLast4s = useMemo(
    () =>
      [
        ...new Set(
          (bundle?.preview.rows ?? [])
            .map((row) => row.cardLast4)
            .filter((value): value is string => value !== undefined),
        ),
      ].sort(),
    [bundle],
  );
  const mpNeedsDefaultTarget = useMemo(
    () =>
      (bundle?.preview.rows ?? []).some((row) => row.cardLast4 === undefined),
    [bundle],
  );

  // Footer summary — "28 novos · 1 duplicata desmarcada · 1 já importada …".
  const selectedIndices = useMemo(
    () =>
      (preview?.rows ?? [])
        .map((_, index) => index)
        .filter((index) => !excluded.has(index)),
    [preview, excluded],
  );
  const selectedCount = selectedIndices.length;
  const selectedGroupCount = Object.values(groupEdits).filter(
    (edit) => !edit.skip,
  ).length;
  const excludedDuplicates = [...duplicateIndices].filter((i) =>
    excluded.has(i),
  ).length;
  const dbDuplicateCount = persistedDuplicates.size;
  const semCategoriaCount = selectedIndices.filter(
    (i) => (mapping[i]?.categoryId ?? "") === "" && !suppressedIndices.has(i),
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
    <span style={{ display: "grid", gap: 6 }}>
      {[
        ...mpCardLast4s,
        ...(mpNeedsDefaultTarget || mpCardLast4s.length === 0 ? [""] : []),
      ].map((last4) => (
        <Select
          key={last4 || "default"}
          value={last4 ? (cardByLast4[last4] ?? "") : creditCardId}
          onChange={(event) => {
            if (last4) {
              setCardByLast4((previous) => ({
                ...previous,
                [last4]: event.target.value,
              }));
            } else {
              setCreditCardId(event.target.value);
            }
          }}
          aria-label={last4 ? `Cartão final ${last4}` : "Cartão de destino"}
        >
          <option value="">
            {last4 ? `Final ${last4}…` : "Cartão de destino…"}
          </option>
          {(bundle?.creditCards ?? []).map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </Select>
      ))}
    </span>
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

  const hasAllMpTargets =
    mpCardLast4s.every((last4) => (cardByLast4[last4] ?? "") !== "") &&
    (!(mpNeedsDefaultTarget || mpCardLast4s.length === 0) ||
      creditCardId !== "");
  const confirmDisabled =
    isPending ||
    selectedCount + selectedGroupCount === 0 ||
    (isMp ? !hasAllMpTargets : accountId === "");
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
          {step === 1
            ? "O que chegou pra gente?"
            : "Dá uma olhada antes de gravar"}
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
                {confirmResult.batchId ? (
                  <Link
                    href={`/imports/${confirmResult.batchId}`}
                    className="ff-btn ff-btn--primary"
                  >
                    Ver detalhes do lote
                  </Link>
                ) : null}
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
                  <option value="mercado-pago">
                    Mercado Pago (Fatura PDF)
                  </option>
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
                <SubmitButton
                  variant="primary"
                  className="ff-btn--block"
                  pendingLabel="Lendo arquivo…"
                >
                  Ver prévia →
                </SubmitButton>
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
                    const isPersistedDuplicate =
                      persistedGroupDuplicates.has(i);
                    const matches = groupMatchesByIndex[i] ?? [];
                    const topMatch = matches[0];
                    const isExactImported =
                      persistedGroupClaimIds[i] !== undefined;
                    return (
                      <div
                        key={i}
                        className={`ff-group${
                          !isPersistedDuplicate && matches.length === 0
                            ? " ff-group--new"
                            : ""
                        }${
                          matches.length > 0 ? " ff-group--match" : ""
                        }${edit.skip ? " ff-off" : ""}`}
                      >
                        <div className="ff-group__head">
                          <span className="ff-group__name">
                            {g.description}
                          </span>
                          <Badge
                            tone={
                              isExactImported
                                ? "neutral"
                                : topMatch !== undefined
                                  ? "warn"
                                  : isPersistedDuplicate
                                    ? "neutral"
                                    : "positive"
                            }
                          >
                            {isExactImported
                              ? "já importado"
                              : topMatch !== undefined
                                ? installmentConfidenceLabel(
                                    topMatch.confidence,
                                  )
                                : isPersistedDuplicate
                                  ? "já existe neste cartão"
                                  : "novo"}
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
                                      Number.parseFloat(e.target.value || "0") *
                                        100,
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
                              max={120}
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
                          <Field label="Categoria">
                            <Select
                              className="ff-select--compact"
                              value={edit.categoryId ?? ""}
                              onChange={(event) =>
                                setGroupEdits((previous) => ({
                                  ...previous,
                                  [i]: {
                                    ...edit,
                                    categoryId: event.target.value || undefined,
                                    subcategoryId: undefined,
                                  },
                                }))
                              }
                              aria-label={`Categoria do parcelamento ${g.description}`}
                            >
                              <option value="">(sem categoria)</option>
                              {(bundle?.categories ?? []).map((category) => (
                                <option key={category.id} value={category.id}>
                                  {category.name}
                                </option>
                              ))}
                            </Select>
                          </Field>
                          <Field label="Subcategoria">
                            <Select
                              className="ff-select--compact"
                              value={edit.subcategoryId ?? ""}
                              disabled={edit.categoryId === undefined}
                              onChange={(event) =>
                                setGroupEdits((previous) => ({
                                  ...previous,
                                  [i]: {
                                    ...edit,
                                    subcategoryId:
                                      event.target.value || undefined,
                                  },
                                }))
                              }
                              aria-label={`Subcategoria do parcelamento ${g.description}`}
                            >
                              <option value="">(nenhuma)</option>
                              {(bundle?.subcategories ?? [])
                                .filter(
                                  (subcategory) =>
                                    subcategory.categoryId === edit.categoryId,
                                )
                                .map((subcategory) => (
                                  <option
                                    key={subcategory.id}
                                    value={subcategory.id}
                                  >
                                    {subcategory.name}
                                  </option>
                                ))}
                            </Select>
                          </Field>
                        </div>
                        {matches.length > 0 ? (
                          <div
                            className="ff-group-matches"
                            aria-label={`Possíveis correspondências para ${g.description}`}
                          >
                            <strong>Compare com o que já está no painel</strong>
                            {matches.map((match) => (
                              <div
                                className="ff-group-match"
                                key={match.installmentGroupId}
                              >
                                <div className="ff-group-match__head">
                                  <span>{match.description}</span>
                                  <Badge tone="warn">
                                    {installmentConfidenceLabel(
                                      match.confidence,
                                    )}
                                  </Badge>
                                </div>
                                <span className="ff-group__hint">
                                  {formatBrl(match.amountCents)} · parcela{" "}
                                  {match.installmentNumber} de{" "}
                                  {match.installmentCount} · {match.cardName} ·
                                  compra em {formatDayMonth(match.purchasedOn)}
                                  {match.amountDifferenceCents === 0
                                    ? " · valor exato"
                                    : ` · diferença de ${formatBrl(match.amountDifferenceCents)}`}
                                </span>
                              </div>
                            ))}
                            <div className="ff-group-match__actions">
                              <Button
                                variant={
                                  edit.skip &&
                                  groupMatchDecisions[i] !== "import_anyway"
                                    ? "primary"
                                    : "ghost"
                                }
                                onClick={() => {
                                  setGroupMatchDecisions((previous) => ({
                                    ...previous,
                                    [i]: "keep_existing",
                                  }));
                                  setGroupOverrides((previous) => {
                                    const updated = { ...previous };
                                    delete updated[i];
                                    return updated;
                                  });
                                  setGroupEdits((previous) => ({
                                    ...previous,
                                    [i]: { ...edit, skip: true },
                                  }));
                                }}
                              >
                                Manter o existente
                              </Button>
                              <Button
                                variant={
                                  groupMatchDecisions[i] === "import_anyway"
                                    ? "primary"
                                    : "ghost"
                                }
                                onClick={() => {
                                  const reason = window.prompt(
                                    "Por que deseja importar este parcelamento mesmo com uma possível correspondência?",
                                  );
                                  if (
                                    reason === null ||
                                    reason.trim().length < 5
                                  )
                                    return;
                                  const claimId = persistedGroupClaimIds[i];
                                  setGroupOverrides((previous) => ({
                                    ...previous,
                                    [i]: {
                                      reason: reason.trim().slice(0, 200),
                                      ...(claimId === undefined
                                        ? {}
                                        : {
                                            token: crypto.randomUUID(),
                                            claimId,
                                          }),
                                    },
                                  }));
                                  setGroupMatchDecisions((previous) => ({
                                    ...previous,
                                    [i]: "import_anyway",
                                  }));
                                  setGroupEdits((previous) => ({
                                    ...previous,
                                    [i]: { ...edit, skip: false },
                                  }));
                                }}
                              >
                                Importar mesmo assim
                              </Button>
                            </div>
                          </div>
                        ) : null}
                        <div className="ff-group__foot">
                          <span className="ff-group__hint">
                            {matches.length > 0
                              ? `na fatura: parcela ${g.installmentNumber} de ${g.installmentCount} · ${formatBrl(g.perInstallmentCents)}`
                              : isPersistedDuplicate
                                ? `a compra já foi importada neste cartão; mantenha pulada ou justifique a reimportação`
                                : `parcela ${g.installmentNumber} de ${g.installmentCount} · ${formatBrl(g.perInstallmentCents)}`}
                            {g.cardLast4 ? ` · final ${g.cardLast4}` : ""}
                          </span>
                          {matches.length === 0 ? (
                            <label className="ff-group__skip">
                              <input
                                className="ff-check"
                                type="checkbox"
                                checked={edit.skip}
                                onChange={() => {
                                  if (edit.skip && isPersistedDuplicate) {
                                    const claimId = persistedGroupClaimIds[i];
                                    const reason = window.prompt(
                                      "Este parcelamento já foi importado neste cartão. Por que deseja importar novamente?",
                                    );
                                    if (
                                      reason === null ||
                                      reason.trim().length < 5
                                    )
                                      return;
                                    setGroupOverrides((previous) => ({
                                      ...previous,
                                      [i]: {
                                        reason: reason.trim().slice(0, 200),
                                        ...(claimId === undefined
                                          ? {}
                                          : {
                                              token: crypto.randomUUID(),
                                              claimId,
                                            }),
                                      },
                                    }));
                                  } else {
                                    setGroupOverrides((previous) => {
                                      const updated = { ...previous };
                                      delete updated[i];
                                      return updated;
                                    });
                                  }
                                  setGroupEdits((prev) => ({
                                    ...prev,
                                    [i]: { ...edit, skip: !edit.skip },
                                  }));
                                }}
                                aria-label={`Pular parcelamento ${g.description}`}
                              />
                              pular
                            </label>
                          ) : null}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </Card>
            </div>
          ) : null}

          <div style={{ marginTop: 24 }}>
            <Card>
              <div className="ff-panel__head">
                <div>
                  <h2 className="ff-h2">Ações em lote</h2>
                  <span className="ff-note">
                    Revise a seleção antes de confirmar.
                  </span>
                </div>
                <Button
                  variant="ghost"
                  onClick={undoBulkCategory}
                  disabled={mappingUndo === null}
                >
                  Desfazer última ação
                </Button>
              </div>
              <div
                style={{
                  display: "flex",
                  gap: 8,
                  flexWrap: "wrap",
                  marginTop: 12,
                }}
              >
                <Select
                  value={bulkCategoryId}
                  onChange={(event) => setBulkCategoryId(event.target.value)}
                  aria-label="Categoria para ação em lote"
                >
                  <option value="">Categoria…</option>
                  {(bundle?.categories ?? []).map((category) => (
                    <option key={category.id} value={category.id}>
                      {category.name}
                    </option>
                  ))}
                </Select>
                <Button
                  variant="ghost"
                  onClick={() => applyBulkCategory("unresolved")}
                >
                  Aplicar a todos sem categoria
                </Button>
                <Button
                  variant="ghost"
                  onClick={() => applyBulkCategory("selected")}
                >
                  Aplicar às linhas marcadas
                </Button>
                <Select
                  value={bulkMerchantKey}
                  onChange={(event) => setBulkMerchantKey(event.target.value)}
                  aria-label="Estabelecimento para ação em lote"
                >
                  <option value="">Estabelecimento…</option>
                  {bulkMerchantKeys.map((merchant) => (
                    <option key={merchant} value={merchant}>
                      {merchant}
                    </option>
                  ))}
                </Select>
                <Button
                  variant="ghost"
                  disabled={bulkMerchantKey === ""}
                  onClick={() => applyBulkCategory("merchant")}
                >
                  Aplicar ao estabelecimento
                </Button>
                {bulkSourceLabels.length > 0 ? (
                  <>
                    <Select
                      value={bulkSourceLabel}
                      onChange={(event) =>
                        setBulkSourceLabel(event.target.value)
                      }
                      aria-label="Categoria da origem para ação em lote"
                    >
                      <option value="">Categoria da origem…</option>
                      {bulkSourceLabels.map((label) => (
                        <option key={label} value={label}>
                          {label}
                        </option>
                      ))}
                    </Select>
                    <Button
                      variant="ghost"
                      disabled={bulkSourceLabel === ""}
                      onClick={() => applyBulkCategory("source")}
                    >
                      Aplicar à categoria da origem
                    </Button>
                  </>
                ) : null}
              </div>
            </Card>
          </div>

          {/* Preview rows */}
          <div
            className="ff-panel__head"
            style={{ marginTop: 24, marginBottom: 12 }}
          >
            <div>
              <h2 className="ff-h2">Prévia dos lançamentos</h2>
              <span className="ff-note">duplicatas já vêm desmarcadas</span>
            </div>
            <Button
              variant="ghost"
              onClick={onSuggestCategories}
              disabled={
                isPending ||
                (bundle?.categorizationPlan.aiItems.length ?? 0) === 0
              }
            >
              {isPending ? "Consultando…" : "Sugerir com Codex"}
            </Button>
          </div>

          {aiMessage !== null ? (
            <div
              className="ff-alert ff-alert--warn"
              role="status"
              style={{ marginBottom: 12 }}
            >
              {aiMessage}
            </div>
          ) : null}
          {taxonomyProposals.length > 0 ? (
            <Card>
              <strong>Propostas de taxonomia (somente revisão)</strong>
              <ul style={{ marginBottom: 0 }}>
                {taxonomyProposals.map((proposal, index) => (
                  <li key={`${proposal.rowKey}-${index}`}>
                    {proposal.categoryName}
                    {proposal.subcategoryName
                      ? ` › ${proposal.subcategoryName}`
                      : ""}
                    {` · ${providerLabel(proposal.provider)} · ${proposal.explanation}`}
                  </li>
                ))}
              </ul>
              <p className="ff-note">
                Nenhuma categoria é criada por esta tela.
              </p>
            </Card>
          ) : null}

          <Table columns={PREVIEW_COLUMNS} gridTemplate={PREVIEW_GRID}>
            {preview.rows.map((row, index) => {
              const isDuplicate = duplicateIndices.has(index);
              const isExcluded = excluded.has(index);
              const isDbDuplicate = persistedDuplicates.has(index);
              const isInstallmentRow =
                bundle?.mp?.installmentRowIndices.includes(index) ?? false;
              const selectedCategory = mapping[index]?.categoryId ?? "";
              const aiSuggestion = aiSuggestions[index];
              const aiCategoryName = bundle?.categories.find(
                (category) => category.id === aiSuggestion?.categoryId,
              )?.name;
              const subs = selectedCategory
                ? (subsByCategory.get(selectedCategory) ?? [])
                : [];
              const finalKind = rowEdits[index]?.kind ?? row.kind;
              const finalDescription =
                rowEdits[index]?.description ?? row.description;
              const finalOccurredOn =
                rowEdits[index]?.occurredOn ?? row.occurredOn;
              const finalAmountCents =
                rowEdits[index]?.amountCents ?? row.amount.cents;
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
                  <Input
                    className="ff-input--compact ff-num"
                    type="date"
                    value={finalOccurredOn}
                    onChange={(event) =>
                      setRowEdits((previous) => ({
                        ...previous,
                        [index]: {
                          ...previous[index],
                          occurredOn: event.target.value,
                        },
                      }))
                    }
                    aria-label={`Data linha ${row.sourceLine}`}
                  />
                  <span
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      minWidth: 0,
                      fontWeight: 500,
                    }}
                  >
                    {aiSuggestion !== undefined &&
                    aiCategoryName !== undefined ? (
                      <button
                        type="button"
                        className="ff-btn ff-btn--ghost"
                        style={{ padding: "3px 7px", fontSize: 11 }}
                        onClick={() => applyAiSuggestion(index)}
                        title={aiSuggestion.explanation}
                      >
                        usar {aiCategoryName} ·{" "}
                        {providerLabel(aiSuggestion.provider)}
                      </button>
                    ) : null}
                    {!isInstallmentRow && selectedCategory !== "" ? (
                      <label
                        className="ff-note"
                        title="Opcional: reutilizar esta escolha em próximas importações"
                      >
                        <input
                          type="checkbox"
                          checked={learning[index]?.merchant === true}
                          onChange={(event) =>
                            setLearning((previous) => ({
                              ...previous,
                              [index]: {
                                ...previous[index],
                                merchant: event.target.checked,
                              },
                            }))
                          }
                        />{" "}
                        ensinar estabelecimento
                      </label>
                    ) : null}
                    {!isInstallmentRow &&
                    selectedCategory !== "" &&
                    row.sourceCategory ? (
                      <label
                        className="ff-note"
                        title="Opcional: mapear esta categoria do arquivo"
                      >
                        <input
                          type="checkbox"
                          checked={learning[index]?.sourceCategory === true}
                          onChange={(event) =>
                            setLearning((previous) => ({
                              ...previous,
                              [index]: {
                                ...previous[index],
                                sourceCategory: event.target.checked,
                              },
                            }))
                          }
                        />{" "}
                        ensinar categoria da origem
                      </label>
                    ) : null}
                    <Input
                      className="ff-input--compact"
                      value={finalDescription}
                      maxLength={200}
                      onChange={(event) =>
                        setRowEdits((previous) => ({
                          ...previous,
                          [index]: {
                            ...previous[index],
                            description: event.target.value,
                          },
                        }))
                      }
                      aria-label={`Descrição linha ${row.sourceLine}`}
                    />
                    {row.installment !== undefined ? (
                      <Badge tone="accent">
                        {row.installment.number}/{row.installment.count}
                      </Badge>
                    ) : null}
                  </span>
                  <span style={{ display: "grid", gap: 4 }}>
                    <Input
                      className="ff-input--compact ff-num"
                      type="number"
                      min={0.01}
                      step={0.01}
                      value={(finalAmountCents / 100).toFixed(2)}
                      onChange={(event) =>
                        setRowEdits((previous) => ({
                          ...previous,
                          [index]: {
                            ...previous[index],
                            amountCents: Math.round(
                              Number(event.target.value) * 100,
                            ),
                          },
                        }))
                      }
                      aria-label={`Valor linha ${row.sourceLine}`}
                    />
                    <Select
                      className="ff-select--compact"
                      value={finalKind}
                      onChange={(event) =>
                        setRowEdits((previous) => ({
                          ...previous,
                          [index]: {
                            ...previous[index],
                            kind: event.target.value as "expense" | "income",
                          },
                        }))
                      }
                      aria-label={`Tipo linha ${row.sourceLine}`}
                    >
                      <option value="expense">saída</option>
                      <option value="income">entrada</option>
                    </Select>
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
                    {bundle?.priorDispositions[row.sourceLine] !== undefined ? (
                      <Badge tone="neutral">
                        antes: {bundle.priorDispositions[row.sourceLine]}
                      </Badge>
                    ) : null}
                    {!isDuplicate &&
                    !isDbDuplicate &&
                    !isInstallmentRow &&
                    !isExcluded &&
                    selectedCategory === "" ? (
                      <Badge tone="warn">sem categoria</Badge>
                    ) : null}
                    {suppressedIndices.has(index) ? (
                      <Badge tone="neutral">sem categoria por memória</Badge>
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
                  loading={isPending}
                  loadingText="Importando…"
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
              const isDbDuplicate = persistedDuplicates.has(index);
              const isInstallmentRow =
                bundle?.mp?.installmentRowIndices.includes(index) ?? false;
              const selectedCategory = mapping[index]?.categoryId ?? "";
              const aiSuggestion = aiSuggestions[index];
              const aiCategoryName = bundle?.categories.find(
                (category) => category.id === aiSuggestion?.categoryId,
              )?.name;
              const subs = selectedCategory
                ? (subsByCategory.get(selectedCategory) ?? [])
                : [];
              const finalKind = rowEdits[index]?.kind ?? row.kind;
              const finalDescription =
                rowEdits[index]?.description ?? row.description;
              const finalOccurredOn =
                rowEdits[index]?.occurredOn ?? row.occurredOn;
              const finalAmountCents =
                rowEdits[index]?.amountCents ?? row.amount.cents;
              const isExpense = finalKind === "expense";
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
                        <span className="ff-txrow__desc">
                          {finalDescription}
                        </span>
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
                        {formatBrl(finalAmountCents)}
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
                      {formatDayMonth(finalOccurredOn)}
                      {isDuplicate ? (
                        <Badge tone="negative">duplicata provável</Badge>
                      ) : null}
                      {isDbDuplicate ? (
                        <Badge tone="neutral">já importada</Badge>
                      ) : null}
                      {aiSuggestion !== undefined &&
                      aiCategoryName !== undefined ? (
                        <button
                          type="button"
                          className="ff-btn ff-btn--ghost"
                          style={{ padding: "3px 7px", fontSize: 11 }}
                          onClick={() => applyAiSuggestion(index)}
                          title={aiSuggestion.explanation}
                        >
                          usar {aiCategoryName} ·{" "}
                          {providerLabel(aiSuggestion.provider)}
                        </button>
                      ) : null}
                      {isInstallmentRow ? (
                        <span className="ff-note">entra pelo parcelamento</span>
                      ) : null}
                    </div>
                    {!isInstallmentRow ? (
                      <details style={{ marginTop: 8 }}>
                        <summary className="ff-note">editar lançamento</summary>
                        <div style={{ display: "grid", gap: 8, marginTop: 8 }}>
                          <Input
                            value={finalDescription}
                            maxLength={200}
                            onChange={(event) =>
                              setRowEdits((previous) => ({
                                ...previous,
                                [index]: {
                                  ...previous[index],
                                  description: event.target.value,
                                },
                              }))
                            }
                            aria-label={`Descrição linha ${row.sourceLine}`}
                          />
                          <Input
                            type="date"
                            value={finalOccurredOn}
                            onChange={(event) =>
                              setRowEdits((previous) => ({
                                ...previous,
                                [index]: {
                                  ...previous[index],
                                  occurredOn: event.target.value,
                                },
                              }))
                            }
                            aria-label={`Data linha ${row.sourceLine}`}
                          />
                          <Input
                            type="number"
                            min={0.01}
                            step={0.01}
                            value={(finalAmountCents / 100).toFixed(2)}
                            onChange={(event) =>
                              setRowEdits((previous) => ({
                                ...previous,
                                [index]: {
                                  ...previous[index],
                                  amountCents: Math.round(
                                    Number(event.target.value) * 100,
                                  ),
                                },
                              }))
                            }
                            aria-label={`Valor linha ${row.sourceLine}`}
                          />
                          <Select
                            value={finalKind}
                            onChange={(event) =>
                              setRowEdits((previous) => ({
                                ...previous,
                                [index]: {
                                  ...previous[index],
                                  kind: event.target.value as
                                    | "expense"
                                    | "income",
                                },
                              }))
                            }
                            aria-label={`Tipo linha ${row.sourceLine}`}
                          >
                            <option value="expense">saída</option>
                            <option value="income">entrada</option>
                          </Select>
                        </div>
                      </details>
                    ) : null}
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
                  <Button
                    variant="primary"
                    className="ff-btn--block"
                    onClick={onConfirm}
                    disabled={confirmDisabled}
                    loading={isPending}
                    loadingText="Importando…"
                  >
                    {confirmLabel}
                  </Button>
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
