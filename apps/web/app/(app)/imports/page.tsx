"use client";

import type { FlatInstallmentMatch } from "./flat-installment-matches";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";

import type { ImportSource, ImportPreview } from "@family-finance/importers";

import {
  Badge,
  Button,
  Card,
  Field,
  IconUpload,
  Input,
  Select,
  SubmitButton,
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
import { INSTALLMENT_MATCH_PAGE_SIZE } from "./group-duplicates";
import type { BatchCategorizationPlan } from "@family-finance/categorization";

import { purchaseDescription } from "./purchase-description";
import { ConfirmBlockedDialog } from "./confirm-blocked-dialog";
import { derivePendencias, type Pendencia } from "./confirm-blockers";
import {
  clearDraft,
  draftStorage,
  formatSavedAt,
  loadDraft,
  saveDraft,
  type DraftGroupEdit,
} from "./import-draft";
import {
  buildMerchantGroups,
  filterGroups,
  formatPeriod,
  orderMerchantGroups,
  type MerchantGroup,
  type PreviewFilter,
} from "./merchant-groups";
import { PreviewList, type PreviewRowView } from "./preview-list";

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
  draftOwner: { userId: string; householdId: string };
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
  notices?: string[];
};

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
  const [groupEdits, setGroupEdits] = useState<Record<number, DraftGroupEdit>>(
    {},
  );
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
  const [flatMatchesByIndex, setFlatMatchesByIndex] = useState<
    Record<number, FlatInstallmentMatch[]>
  >({});
  const [replacements, setReplacements] = useState<
    Record<number, { id: string; updatedAt: string }>
  >({});
  const [groupMatchCountsByIndex, setGroupMatchCountsByIndex] = useState<
    Record<number, number>
  >({});
  const [groupReviewRequiredIndices, setGroupReviewRequiredIndices] = useState<
    number[]
  >([]);
  const [matchPageOffsets, setMatchPageOffsets] = useState<
    Record<number, number>
  >({});
  const [loadingMatchPages, setLoadingMatchPages] = useState<
    Record<number, boolean>
  >({});
  const [matchPageError, setMatchPageError] = useState<string | null>(null);
  const [resolvedTargetKey, setResolvedTargetKey] = useState<string | null>(
    null,
  );
  const [targetError, setTargetError] = useState<{
    key: string;
    message: string;
  } | null>(null);
  const [targetRetry, setTargetRetry] = useState(0);
  const targetKey = JSON.stringify([
    bundle?.previewToken,
    accountId,
    creditCardId,
    Object.entries(cardByLast4).sort(),
    targetRetry,
  ]);
  const currentTargetKey = useRef(targetKey);
  currentTargetKey.current = targetKey;
  const resolutionVersion = useRef(0);
  const reviewedGroupIndices = useRef<Set<number>>(new Set());
  const targetsResolved = bundle !== null && resolvedTargetKey === targetKey;
  const [groupMatchDecisions, setGroupMatchDecisions] = useState<
    Record<number, "keep_existing" | "import_anyway" | "replace">
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
  const [bulkSubcategoryId, setBulkSubcategoryId] = useState("");
  const [bulkChanged, setBulkChanged] = useState<number[]>([]);
  const bulkChangedSet = useMemo(() => new Set(bulkChanged), [bulkChanged]);
  const [provenanceUndo, setProvenanceUndo] = useState<
    typeof provenance | null
  >(null);
  // Rows whose category the user set individually ("mudar só esta").
  const [detached, setDetached] = useState<Set<number>>(new Set());
  const [filter, setFilter] = useState<PreviewFilter>("all");
  const [search, setSearch] = useState("");
  const [pendenciasOpen, setPendenciasOpen] = useState(false);
  const [draftSavedAt, setDraftSavedAt] = useState<string | null>(null);
  const [bulkSourceLabel, setBulkSourceLabel] = useState("");
  const [mappingUndo, setMappingUndo] = useState<typeof mapping | null>(null);
  const [isPending, startTransition] = useTransition();
  const toast = useToast();
  useEffect(() => {
    if (bulkChanged.length === 0) return;
    const timeout = setTimeout(() => setBulkChanged([]), 900);
    return () => clearTimeout(timeout);
  }, [bulkChanged]);

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
    setMappingUndo(null);
    setProvenanceUndo(null);
    setBulkChanged([]);
    setBulkCategoryId("");
    setBulkSubcategoryId("");
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
      draftOwner: result.draftOwner,
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
      notices: result.notices,
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
    const edits: Record<number, DraftGroupEdit> = {};
    (result.mp?.groups ?? []).forEach((g, i) => {
      edits[i] = {
        totalAmountCents: g.estimatedTotalCents,
        installmentCount: g.installmentCount,
        purchasedOn: g.purchasedOn,
        skip: false,
      };
    });
    setGroupEdits(edits);
    setDetached(new Set());
    setFilter("all");
    setSearch("");
    setPendenciasOpen(false);
    setDraftSavedAt(null);
    // Pre-exclude: probable in-file duplicates + rows already in the DB +
    // parcela rows (they import via groups, never as flat charges).
    const preExcluded = new Set([
      ...result.preview.duplicates.map((d) => d.rowIndex),
      ...(result.mp?.dbDuplicateIndices ?? []),
      ...(result.mp?.installmentRowIndices ?? []),
    ]);
    const storage = draftStorage();
    const draft =
      storage === null
        ? null
        : loadDraft(
            storage,
            result.draftOwner,
            result.fileFingerprint,
            result.preview.rows.length,
          );
    if (draft === null) {
      setExcluded(preExcluded);
      return;
    }
    // Same file, same row count: pick up where the user stopped.
    setMapping({ ...initialMapping, ...draft.mapping });
    setProvenance((previous) => {
      const updated = { ...previous };
      for (const key of Object.keys(draft.mapping)) {
        const index = Number(key);
        if (
          draft.mapping[index]?.categoryId !== initialMapping[index]?.categoryId
        )
          updated[index] = { source: "user", accepted: true, changed: true };
      }
      return updated;
    });
    setLearning(draft.learning);
    setRowEdits(draft.rowEdits);
    // Matches against existing installment groups are recomputed on resolve.
    setGroupEdits(
      Object.fromEntries(
        Object.entries(edits).map(([key, edit]) => {
          const saved = draft.groupEdits[Number(key)];
          return [
            key,
            saved === undefined
              ? edit
              : {
                  ...saved,
                  existingGroupId: undefined,
                  existingGroupUpdatedAt: undefined,
                },
          ];
        }),
      ),
    );
    setDetached(new Set(draft.detached));
    setExcluded(new Set([...preExcluded, ...draft.excluded]));
    setDraftSavedAt(formatSavedAt(draft.savedAt));
    toast.success("Rascunho restaurado. Você parou aqui da última vez.");
  }

  // Everything the user decided in the preview, in the shape the draft keeps.
  const reviewDraft = useMemo(
    () =>
      bundle === null
        ? null
        : {
            rowCount: bundle.preview.rows.length,
            mapping,
            learning,
            excluded: [...excluded],
            rowEdits,
            detached: [...detached],
            groupEdits,
          },
    [bundle, mapping, learning, excluded, rowEdits, detached, groupEdits],
  );
  // Autosave the review so closing the tab does not lose the work.
  useEffect(() => {
    if (bundle === null || reviewDraft === null) return;
    const { draftOwner, fileFingerprint } = bundle;
    const timeout = setTimeout(() => {
      const storage = draftStorage();
      const saved =
        storage === null
          ? null
          : saveDraft(storage, draftOwner, fileFingerprint, reviewDraft);
      setDraftSavedAt(saved === null ? null : formatSavedAt(saved.savedAt));
    }, 800);
    return () => clearTimeout(timeout);
  }, [bundle, reviewDraft]);

  useEffect(() => {
    resolutionVersion.current += 1;
    setResolvedTargetKey(null);
    setReplacements({});
    setFlatMatchesByIndex({});
    setTargetError(null);
    setMatchPageError(null);
    setLoadingMatchPages({});
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
    })
      .then((result) => {
        if (cancelled) return;
        if (!result.ok) {
          setTargetError({ key: targetKey, message: result.message });
          return;
        }
        setResolvedTargetKey(targetKey);
        const previousMatched = reviewedGroupIndices.current;
        reviewedGroupIndices.current = new Set(
          result.groupReviewRequiredIndices,
        );
        setGroupMatchCountsByIndex(result.groupMatchCountsByIndex);
        setGroupReviewRequiredIndices(result.groupReviewRequiredIndices);
        setMatchPageOffsets({});
        const nextPersisted = new Set(result.duplicateIndices);
        setPersistedClaimIds(result.claimIdsByIndex);
        const nextGroupPersisted = new Set(result.groupDuplicateIndices);
        setGroupMatchesByIndex(result.groupMatchesByIndex);
        setFlatMatchesByIndex(result.flatMatchesByIndex ?? {});
        setGroupMatchDecisions({});
        setPersistedGroupClaimIds(result.groupClaimIdsByIndex);
        setPersistedGroupDuplicates((previousPersisted) => {
          setGroupEdits((previousEdits) => {
            const updated = Object.fromEntries(
              Object.entries(previousEdits).map(([key, edit]) => [
                key,
                edit.existingGroupId
                  ? {
                      ...edit,
                      existingGroupId: undefined,
                      existingGroupUpdatedAt: undefined,
                      purchaseDescription: edit.purchaseDescriptionEdited
                        ? edit.purchaseDescription
                        : undefined,
                    }
                  : edit,
              ]),
            );
            for (const [key, matches] of Object.entries(
              result.groupMatchesByIndex,
            )) {
              const index = Number(key);
              const edit = updated[index];
              const match =
                matches.length === 1 &&
                result.groupMatchCountsByIndex[index] === 1
                  ? matches[0]
                  : undefined;
              const bankName = bundle.mp?.groups[index]?.description;
              if (edit && match && bankName)
                updated[index] = {
                  ...edit,
                  existingGroupId: match.installmentGroupId,
                  existingGroupUpdatedAt: match.updatedAt,
                  purchaseDescription: edit.purchaseDescriptionEdited
                    ? edit.purchaseDescription
                    : (purchaseDescription(
                        bankName,
                        match.purchaseDescription ?? match.description,
                      ) ?? ""),
                };
            }
            for (const index of new Set([
              ...previousPersisted,
              ...previousMatched,
            ])) {
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
      })
      .catch(() => {
        if (!cancelled)
          setTargetError({
            key: targetKey,
            message:
              "Não foi possível carregar as comparações. Tente novamente.",
          });
      });
    return () => {
      cancelled = true;
    };
  }, [bundle, accountId, creditCardId, cardByLast4, targetKey]);

  async function loadMatchPage(groupIndex: number, offset: number) {
    if (bundle === null || !targetsResolved) return;
    const version = resolutionVersion.current;
    const requestKey = targetKey;
    setLoadingMatchPages((previous) => ({ ...previous, [groupIndex]: true }));
    setMatchPageError(null);
    try {
      const result = await resolveImportTargets({
        previewToken: bundle.previewToken,
        snapshot: bundle.snapshot,
        creditCardId: creditCardId || undefined,
        creditCardByLast4: cardByLast4,
        matchPage: { groupIndex, offset },
      });
      if (
        version !== resolutionVersion.current ||
        currentTargetKey.current !== requestKey
      )
        return;
      if (!result.ok) {
        setMatchPageError(result.message);
        return;
      }
      setGroupMatchesByIndex((previous) => ({
        ...previous,
        [groupIndex]: result.groupMatchesByIndex[groupIndex] ?? [],
      }));
      setGroupMatchCountsByIndex((previous) => ({
        ...previous,
        [groupIndex]: result.groupMatchCountsByIndex[groupIndex] ?? 0,
      }));
      setMatchPageOffsets((previous) => ({
        ...previous,
        [groupIndex]: offset,
      }));
    } catch {
      if (
        version === resolutionVersion.current &&
        currentTargetKey.current === requestKey
      )
        setMatchPageError(
          "Não foi possível carregar mais correspondências. Tente novamente.",
        );
    } finally {
      if (
        version === resolutionVersion.current &&
        currentTargetKey.current === requestKey
      )
        setLoadingMatchPages((previous) => ({
          ...previous,
          [groupIndex]: false,
        }));
    }
  }

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

  function applyBulkCategory(mode: "selected" | "unresolved" | "source") {
    if (bundle === null) return;
    if (bulkCategoryId === "") {
      toast.error("Selecione uma categoria para aplicar em lote.");
      return;
    }
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
            : (row.sourceCategory ?? "") === bulkSourceLabel;
      if (!matches) return;
      if (
        mapping[index]?.categoryId === bulkCategoryId &&
        (mapping[index]?.subcategoryId ?? "") === bulkSubcategoryId
      )
        return;
      next[index] = {
        categoryId: bulkCategoryId,
        subcategoryId: bulkSubcategoryId || undefined,
      };
      changed.push(index);
    });
    if (changed.length === 0) {
      toast.success(
        "Nenhum lançamento alterado na revisão: confira a seleção e as categorias atuais.",
      );
      return;
    }
    setMappingUndo(mapping);
    setProvenanceUndo(provenance);
    // Bound simultaneous paints; the toast still counts every changed row.
    setBulkChanged(changed.slice(0, 24));
    toast.success(
      `${changed.length} ${changed.length === 1 ? "lançamento atualizado" : "lançamentos atualizados"} na revisão da importação.`,
    );
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
    if (provenanceUndo !== null) setProvenance(provenanceUndo);
    setProvenanceUndo(null);
    setMappingUndo(null);
    toast.success("Última ação em lote desfeita na revisão da importação.");
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
    if (!targetsResolved) {
      setConfirmResult({
        ok: false,
        message: "Aguarde a conclusão das comparações antes de confirmar.",
      });
      return;
    }
    const pendingMatchReview = groupReviewRequiredIndices.find(
      (index) =>
        groupEdits[index]?.skip === false &&
        groupMatchDecisions[index] === undefined,
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
          .map((g, i) => ({
            g,
            edit: groupEdits[i],
            decision: groupMatchDecisions[i],
          }))
          .filter(
            (x) =>
              x.edit !== undefined &&
              (!x.edit.skip ||
                (x.decision === "keep_existing" &&
                  x.edit.existingGroupId !== undefined)),
          )
          .map(({ g, edit, decision }) => ({
            purchaseDescription: edit!.purchaseDescription,
            existingGroupUpdatedAt:
              decision === "keep_existing"
                ? edit!.existingGroupUpdatedAt
                : undefined,
            existingGroupId:
              decision === "keep_existing" ? edit!.existingGroupId : undefined,
            sourceGroupIndex: bundle.mp?.groups.indexOf(g) ?? -1,
            replaceTransaction:
              replacements[bundle.mp?.groups.indexOf(g) ?? -1],
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
        const storage = draftStorage();
        if (storage !== null)
          clearDraft(storage, bundle.draftOwner, bundle.fileFingerprint);
        setDraftSavedAt(null);
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
  const selectedGroupCount = Object.entries(groupEdits).filter(
    ([index, edit]) =>
      !edit.skip ||
      (groupMatchDecisions[Number(index)] === "keep_existing" &&
        edit.existingGroupId !== undefined),
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
    <span className="ff-num">
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
  const confirmLabel = isPending
    ? "Importando…"
    : selectedGroupCount > 0
      ? "Gravar importação"
      : selectedCount === 1
        ? "Gravar 1 lançamento"
        : `Gravar ${selectedCount} lançamentos`;

  // --- Grouped preview (one row per merchant) ---
  const installmentRowSet = useMemo(
    () => new Set(bundle?.mp?.installmentRowIndices ?? []),
    [bundle],
  );
  const rowViews = useMemo(() => {
    const views = new Map<number, PreviewRowView>();
    if (bundle === null) return views;
    bundle.preview.rows.forEach((row, index) => {
      views.set(index, {
        index,
        row,
        occurredOn: rowEdits[index]?.occurredOn ?? row.occurredOn,
        description: rowEdits[index]?.description ?? row.description,
        amountCents: rowEdits[index]?.amountCents ?? row.amount.cents,
        kind: rowEdits[index]?.kind ?? row.kind,
        excluded: excluded.has(index),
        duplicate: duplicateIndices.has(index),
        dbDuplicate: persistedDuplicates.has(index),
        installmentRow: installmentRowSet.has(index),
        suppressed: suppressedIndices.has(index),
        categoryId: mapping[index]?.categoryId ?? "",
        subcategoryId: mapping[index]?.subcategoryId ?? "",
        detached: detached.has(index),
        rememberMerchant: learning[index]?.merchant === true,
        learnSourceCategory: learning[index]?.sourceCategory === true,
        aiSuggestion: aiSuggestions[index],
        priorDisposition: bundle.priorDispositions[row.sourceLine],
        recentlyChanged: bulkChangedSet.has(index),
      });
    });
    return views;
  }, [
    bundle,
    rowEdits,
    excluded,
    duplicateIndices,
    persistedDuplicates,
    installmentRowSet,
    suppressedIndices,
    mapping,
    detached,
    learning,
    aiSuggestions,
    bulkChangedSet,
  ]);
  const isUncategorizedRow = (index: number): boolean => {
    const view = rowViews.get(index);
    return (
      view !== undefined &&
      !view.excluded &&
      !view.suppressed &&
      !view.installmentRow &&
      view.categoryId === ""
    );
  };
  // Order is fixed when the preview loads (merchants still uncategorized by
  // the plan come first) so groups do not jump around while the user works.
  const orderedGroups = useMemo(() => {
    if (bundle === null) return [];
    const plan = bundle.categorizationPlan.rows;
    return orderMerchantGroups(
      buildMerchantGroups(bundle.preview.rows).map((group) => ({
        group,
        uncategorizedSelected: group.indices.filter(
          (index) =>
            !installmentRowSet.has(index) &&
            !duplicateIndices.has(index) &&
            plan[index]?.status !== "suppressed" &&
            plan[index]?.selection == null,
        ).length,
      })),
    );
  }, [bundle, installmentRowSet, duplicateIndices]);
  const isDuplicateRow = (index: number) =>
    duplicateIndices.has(index) || persistedDuplicates.has(index);
  const isInstallmentRow = (index: number) => installmentRowSet.has(index);
  const groupsFor = (which: PreviewFilter, term: string) =>
    filterGroups(orderedGroups, {
      filter: which,
      search: term,
      isUncategorized: isUncategorizedRow,
      isDuplicate: isDuplicateRow,
      isInstallment: isInstallmentRow,
    });
  const visibleGroups = groupsFor(filter, search);
  const filterCounts: Record<PreviewFilter, number> = {
    all: orderedGroups.length,
    uncategorized: groupsFor("uncategorized", "").length,
    duplicates: groupsFor("duplicates", "").length,
    installments: groupsFor("installments", "").length,
  };

  // --- Pendências: why "Gravar" would not go through right now ---
  const destinationMissing = isMp ? !hasAllMpTargets : accountId === "";
  const comparisonFailed =
    !destinationMissing && targetError?.key === targetKey;
  const comparisonPending =
    !destinationMissing && !targetsResolved && !comparisonFailed;
  const pendingInstallmentReviews = groupReviewRequiredIndices.filter(
    (index) =>
      groupEdits[index]?.skip === false &&
      groupMatchDecisions[index] === undefined,
  ).length;
  const uncategorizedByGroup = orderedGroups
    .map((group) => ({
      label: group.label,
      count: group.indices.filter(isUncategorizedRow).length,
    }))
    .filter((entry) => entry.count > 0)
    .sort((a, b) => b.count - a.count);
  const pendencias = derivePendencias({
    destinationMissing,
    comparisonFailed,
    comparisonPending,
    selectedCount: selectedCount + selectedGroupCount,
    pendingInstallmentReviews,
    uncategorized: uncategorizedByGroup,
  });
  const comparison: "ok" | "pending" | "failed" = comparisonFailed
    ? "failed"
    : comparisonPending
      ? "pending"
      : "ok";

  /** Attached, non-installment rows: what the group selects and Lembrar control. */
  function groupEditableIndices(group: MerchantGroup): number[] {
    return group.indices.filter((index) => {
      const view = rowViews.get(index);
      return view !== undefined && !view.detached && !view.installmentRow;
    });
  }
  function markUserChoice(indices: number[]) {
    setProvenance((previous) => {
      const updated = { ...previous };
      for (const index of indices)
        updated[index] = { source: "user", accepted: true, changed: true };
      return updated;
    });
  }
  function onGroupCategory(group: MerchantGroup, categoryId: string) {
    const indices = groupEditableIndices(group);
    setMapping((previous) => {
      const next = { ...previous };
      for (const index of indices)
        next[index] = {
          categoryId: categoryId || undefined,
          subcategoryId: undefined,
        };
      return next;
    });
    setLearning((previous) => {
      const next = { ...previous };
      for (const index of indices)
        next[index] = { ...next[index], merchant: categoryId !== "" };
      return next;
    });
    markUserChoice(indices);
  }
  function onGroupSubcategory(group: MerchantGroup, subcategoryId: string) {
    const indices = groupEditableIndices(group);
    setMapping((previous) => {
      const next = { ...previous };
      for (const index of indices)
        next[index] = {
          categoryId: previous[index]?.categoryId,
          subcategoryId: subcategoryId || undefined,
        };
      return next;
    });
    markUserChoice(indices);
  }
  function onGroupRemember(group: MerchantGroup, remember: boolean) {
    const indices = groupEditableIndices(group);
    setLearning((previous) => {
      const next = { ...previous };
      for (const index of indices)
        next[index] = { ...next[index], merchant: remember };
      return next;
    });
  }
  function onToggleGroup(group: MerchantGroup, selected: boolean) {
    // Duplicates keep their per-row confirmation; installment rows enter via
    // the installment panel. The group checkbox only moves the plain rows.
    const plain = group.indices.filter((index) => {
      const view = rowViews.get(index);
      return (
        view !== undefined &&
        !view.duplicate &&
        !view.dbDuplicate &&
        !view.installmentRow
      );
    });
    setExcluded((previous) => {
      const next = new Set(previous);
      for (const index of plain) {
        if (selected) next.delete(index);
        else next.add(index);
      }
      return next;
    });
  }
  function onDetachRow(index: number) {
    setDetached((previous) => new Set(previous).add(index));
    // The group's Lembrar no longer covers this row, and it has no control of its own.
    setLearning((previous) => ({
      ...previous,
      [index]: { ...previous[index], merchant: false },
    }));
  }
  function onAttachRow(group: MerchantGroup, index: number) {
    setDetached((previous) => {
      const next = new Set(previous);
      next.delete(index);
      return next;
    });
    const sibling = groupEditableIndices(group).find((i) => i !== index);
    if (sibling === undefined) return;
    setMapping((previous) => ({
      ...previous,
      [index]: { ...previous[sibling] },
    }));
    setLearning((previous) => ({
      ...previous,
      [index]: { ...previous[index], merchant: previous[sibling]?.merchant },
    }));
    markUserChoice([index]);
  }
  function onRowEdit(
    index: number,
    patch: {
      occurredOn?: string;
      description?: string;
      amountCents?: number;
      kind?: "expense" | "income";
    },
  ) {
    setRowEdits((previous) => ({
      ...previous,
      [index]: { ...previous[index], ...patch },
    }));
  }
  function onLearnSourceCategory(index: number, checked: boolean) {
    setLearning((previous) => ({
      ...previous,
      [index]: { ...previous[index], sourceCategory: checked },
    }));
  }
  function scrollTo(selector: string) {
    document.querySelector(selector)?.scrollIntoView({ block: "start" });
  }
  function onGravar() {
    if (pendencias.length > 0) setPendenciasOpen(true);
    else onConfirm();
  }
  function onPendenciaAction(pendencia: Pendencia) {
    setPendenciasOpen(false);
    if (pendencia.id === "destination") {
      // The modal is still open (and the page inert) until its effect closes it.
      setTimeout(() => {
        document
          .querySelector<HTMLSelectElement>(
            isMp ? '[aria-label^="Cartão"]' : '[aria-label="Conta de destino"]',
          )
          ?.focus();
      }, 0);
      return;
    }
    if (pendencia.id === "comparison-failed") {
      setTargetRetry((value) => value + 1);
      return;
    }
    if (pendencia.id === "nothing-selected") {
      setFilter("all");
      setSearch("");
      scrollTo('[data-testid="preview-list"]');
      return;
    }
    if (pendencia.id === "installment-review") {
      scrollTo(".ff-group--match");
      return;
    }
    if (pendencia.id === "uncategorized") {
      setFilter("uncategorized");
      setSearch("");
      scrollTo('[data-testid="preview-list"]');
    }
  }
  function onContinueLater() {
    if (bundle === null || reviewDraft === null) return;
    const storage = draftStorage();
    const saved =
      storage === null
        ? null
        : saveDraft(
            storage,
            bundle.draftOwner,
            bundle.fileFingerprint,
            reviewDraft,
          );
    if (saved === null) {
      toast.error(
        "Não consegui salvar o rascunho neste navegador. A lista continua aqui.",
      );
      return;
    }
    setBundle(null);
    toast.success(
      "Rascunho salvo. Envie o mesmo arquivo de novo pra continuar de onde parou.",
    );
  }

  return (
    <section>
      {matchPageError !== null ? <p role="alert">{matchPageError}</p> : null}
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
            ? "CSV do Minhas Financas, CSV ou OFX do Nubank e PDF do Mercado Pago."
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
                  <option value="nubank-ofx">Nubank (Fatura OFX)</option>
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
                      : source === "nubank-ofx"
                        ? ".ofx,application/x-ofx,application/ofx"
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
                  ou <strong>escolhe do computador</strong> · PDF, CSV ou OFX
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
          {bundle?.notices?.map((notice) => (
            <p key={notice} className="ff-note" role="status">
              {notice}
            </p>
          ))}
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
                    const selectedMatch =
                      matches.find(
                        (match) =>
                          match.installmentGroupId === edit.existingGroupId,
                      ) ??
                      (matches.length === 1 && groupMatchCountsByIndex[i] === 1
                        ? topMatch
                        : undefined);
                    const canLink =
                      selectedMatch !== undefined &&
                      selectedMatch.creditCardId ===
                        ((g.cardLast4 ? cardByLast4[g.cardLast4] : undefined) ??
                          creditCardId) &&
                      selectedMatch.installmentCount === g.installmentCount;
                    const matchCount = groupMatchCountsByIndex[i] ?? 0;
                    const needsReview = groupReviewRequiredIndices.includes(i);
                    const matchOffset = matchPageOffsets[i] ?? 0;
                    const isExactImported =
                      persistedGroupClaimIds[i] !== undefined;
                    return (
                      <div
                        key={i}
                        className={`ff-group${
                          !isPersistedDuplicate && !needsReview
                            ? " ff-group--new"
                            : ""
                        }${
                          needsReview ? " ff-group--match" : ""
                        }${edit.skip && !edit.existingGroupId ? " ff-off" : ""}`}
                      >
                        <div className="ff-group__head">
                          <span className="ff-group__name">
                            {purchaseDescription(
                              g.description,
                              edit.purchaseDescription,
                            ) ?? g.description}
                          </span>
                          <Badge
                            tone={
                              !targetsResolved || isExactImported
                                ? "neutral"
                                : topMatch !== undefined
                                  ? "warn"
                                  : needsReview
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
                                : needsReview
                                  ? "compra semelhante encontrada"
                                  : isPersistedDuplicate
                                    ? "já existe neste cartão"
                                    : !targetsResolved
                                      ? "comparação pendente"
                                      : "novo"}
                          </Badge>
                        </div>
                        <p className="ff-group__hint">
                          Nome no banco: {g.description}
                        </p>
                        <Field label="Descrição da compra (opcional)">
                          <Input
                            maxLength={200}
                            value={edit.purchaseDescription ?? ""}
                            placeholder="Ex.: utensílios para a cozinha"
                            aria-label={`Descrição da compra ${g.description}`}
                            onChange={(event) =>
                              setGroupEdits((previous) => ({
                                ...previous,
                                [i]: {
                                  ...edit,
                                  purchaseDescription: event.target.value,
                                  purchaseDescriptionEdited: true,
                                },
                              }))
                            }
                          />
                        </Field>
                        <fieldset
                          className="ff-group__grid"
                          disabled={
                            groupMatchDecisions[i] === "keep_existing" &&
                            edit.existingGroupId !== undefined
                          }
                          style={{
                            border: 0,
                            padding: 0,
                            margin: "12px 0 0",
                            minWidth: 0,
                          }}
                        >
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
                              disabled={replacements[i] !== undefined}
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
                              disabled={replacements[i] !== undefined}
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
                              disabled={replacements[i] !== undefined}
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
                              disabled={replacements[i] !== undefined}
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
                              disabled={
                                edit.categoryId === undefined ||
                                replacements[i] !== undefined
                              }
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
                        </fieldset>
                        {needsReview ? (
                          <div
                            className="ff-group-matches"
                            aria-label={`Possíveis correspondências para ${g.description}`}
                          >
                            <strong>Compare com o que já está no painel</strong>
                            {matchCount === 0 &&
                            (flatMatchesByIndex[i]?.length ?? 0) === 0 ? (
                              <p>
                                Já existe uma compra com a mesma descrição,
                                quantidade de parcelas e mês de compra neste
                                cartão. Confira antes de importar novamente.
                              </p>
                            ) : null}
                            {matches.map((match) => (
                              <div
                                className="ff-group-match"
                                key={match.installmentGroupId}
                              >
                                <div className="ff-group-match__head">
                                  <label>
                                    <input
                                      type="radio"
                                      name={`purchase-match-${i}`}
                                      checked={
                                        selectedMatch?.installmentGroupId ===
                                        match.installmentGroupId
                                      }
                                      aria-label={`Selecionar ${match.purchaseDescription ?? match.description} para ${g.description}`}
                                      onChange={() => {
                                        setGroupMatchDecisions((previous) => {
                                          const next = { ...previous };
                                          delete next[i];
                                          return next;
                                        });
                                        setGroupEdits((previous) => ({
                                          ...previous,
                                          [i]: {
                                            ...edit,
                                            existingGroupId:
                                              match.installmentGroupId,
                                            existingGroupUpdatedAt:
                                              match.updatedAt,
                                            purchaseDescription:
                                              purchaseDescription(
                                                g.description,
                                                match.purchaseDescription ??
                                                  match.description,
                                              ) ?? "",
                                          },
                                        }));
                                      }}
                                    />{" "}
                                    {match.purchaseDescription ??
                                      match.description}
                                  </label>
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
                            {(flatMatchesByIndex[i] ?? []).map((match) => (
                              <div
                                className="ff-group-match"
                                key={match.transactionId}
                              >
                                <div className="ff-group-match__head">
                                  <span>
                                    {match.description} · despesa única
                                  </span>
                                  <Badge tone="warn">
                                    {installmentConfidenceLabel(
                                      match.confidence,
                                    )}
                                  </Badge>
                                </div>
                                <p className="ff-group__hint">
                                  {formatBrl(match.amountCents)} ·{" "}
                                  {match.instrumentName} ·{" "}
                                  {formatDayMonth(match.occurredOn)}
                                  {match.differentInstrument
                                    ? " · pagamento diferente"
                                    : " · mesmo cartão"}
                                </p>
                                <Button
                                  disabled={
                                    !targetsResolved ||
                                    isPending ||
                                    edit.totalAmountCents !==
                                      match.amountCents ||
                                    edit.purchasedOn.slice(0, 7) !==
                                      match.occurredOn.slice(0, 7)
                                  }
                                  variant={
                                    replacements[i]?.id === match.transactionId
                                      ? "primary"
                                      : "ghost"
                                  }
                                  onClick={() => {
                                    if (
                                      !window.confirm(
                                        `Substituir a despesa única “${match.description}” de ${formatBrl(match.amountCents)} (${match.instrumentName}) por ${edit.installmentCount} parcelas no cartão selecionado? A categoria e o registro original serão preservados. A mudança só será aplicada ao confirmar a importação.`,
                                      )
                                    )
                                      return;
                                    setReplacements((previous) => ({
                                      ...previous,
                                      [i]: {
                                        id: match.transactionId,
                                        updatedAt: match.updatedAt,
                                      },
                                    }));
                                    setGroupMatchDecisions((previous) => ({
                                      ...previous,
                                      [i]: "replace",
                                    }));
                                    setGroupOverrides((previous) => {
                                      const next = { ...previous };
                                      delete next[i];
                                      return next;
                                    });
                                    setGroupEdits((previous) => ({
                                      ...previous,
                                      [i]: {
                                        ...edit,
                                        skip: false,
                                        existingGroupId: undefined,
                                        existingGroupUpdatedAt: undefined,
                                        purchaseDescription:
                                          edit.purchaseDescriptionEdited
                                            ? edit.purchaseDescription
                                            : (purchaseDescription(
                                                g.description,
                                                match.description,
                                              ) ?? ""),
                                        purchasedOn: match.occurredOn,
                                        categoryId:
                                          match.categoryId ?? undefined,
                                        subcategoryId:
                                          match.subcategoryId ?? undefined,
                                      },
                                    }));
                                  }}
                                >
                                  {replacements[i]?.id === match.transactionId
                                    ? "Substituição selecionada"
                                    : "Substituir por parcelamento"}
                                </Button>
                              </div>
                            ))}
                            {matchCount > INSTALLMENT_MATCH_PAGE_SIZE ? (
                              <div
                                className="ff-group-match__actions"
                                aria-label={`Páginas de correspondências para ${g.description}`}
                              >
                                <Button
                                  disabled={
                                    !targetsResolved ||
                                    loadingMatchPages[i] ||
                                    matchOffset === 0
                                  }
                                  onClick={() =>
                                    void loadMatchPage(
                                      i,
                                      Math.max(
                                        0,
                                        matchOffset -
                                          INSTALLMENT_MATCH_PAGE_SIZE,
                                      ),
                                    )
                                  }
                                >
                                  Anteriores
                                </Button>
                                <span aria-live="polite">
                                  {loadingMatchPages[i]
                                    ? "Carregando…"
                                    : `${matchOffset + 1}–${Math.min(matchOffset + matches.length, matchCount)} de ${matchCount}`}
                                </span>
                                <Button
                                  disabled={
                                    !targetsResolved ||
                                    loadingMatchPages[i] ||
                                    matchOffset + INSTALLMENT_MATCH_PAGE_SIZE >=
                                      matchCount
                                  }
                                  onClick={() =>
                                    void loadMatchPage(
                                      i,
                                      matchOffset + INSTALLMENT_MATCH_PAGE_SIZE,
                                    )
                                  }
                                >
                                  Próximas
                                </Button>
                              </div>
                            ) : null}
                            <div className="ff-group-match__actions">
                              <Button
                                disabled={
                                  !targetsResolved ||
                                  (matchCount > 0 && !canLink)
                                }
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
                                  setReplacements((previous) => {
                                    const next = { ...previous };
                                    delete next[i];
                                    return next;
                                  });
                                  setGroupOverrides((previous) => {
                                    const updated = { ...previous };
                                    delete updated[i];
                                    return updated;
                                  });
                                  setGroupEdits((previous) => ({
                                    ...previous,
                                    [i]: {
                                      ...edit,
                                      skip: true,
                                      ...(selectedMatch
                                        ? {
                                            existingGroupId:
                                              selectedMatch.installmentGroupId,
                                            existingGroupUpdatedAt:
                                              selectedMatch.updatedAt,
                                            purchaseDescription:
                                              edit.purchaseDescription ??
                                              purchaseDescription(
                                                g.description,
                                                selectedMatch.purchaseDescription ??
                                                  selectedMatch.description,
                                              ) ??
                                              "",
                                            totalAmountCents:
                                              selectedMatch.totalAmountCents,
                                            installmentCount:
                                              selectedMatch.installmentCount,
                                            purchasedOn:
                                              selectedMatch.purchasedOn,
                                            categoryId:
                                              selectedMatch.categoryId ??
                                              undefined,
                                            subcategoryId:
                                              selectedMatch.subcategoryId ??
                                              undefined,
                                          }
                                        : {}),
                                    },
                                  }));
                                }}
                              >
                                Manter o existente
                              </Button>
                              <Button
                                disabled={!targetsResolved}
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
                                  setReplacements((previous) => {
                                    const next = { ...previous };
                                    delete next[i];
                                    return next;
                                  });
                                  setGroupEdits((previous) => ({
                                    ...previous,
                                    [i]: {
                                      ...edit,
                                      skip: false,
                                      existingGroupId: undefined,
                                      existingGroupUpdatedAt: undefined,
                                      purchaseDescription:
                                        edit.purchaseDescriptionEdited
                                          ? edit.purchaseDescription
                                          : undefined,
                                    },
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
                          {!needsReview ? (
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
                  onChange={(event) => {
                    setBulkCategoryId(event.target.value);
                    setBulkSubcategoryId("");
                  }}
                  aria-label="Categoria para ação em lote"
                >
                  <option value="">Categoria…</option>
                  {(bundle?.categories ?? []).map((category) => (
                    <option key={category.id} value={category.id}>
                      {category.name}
                    </option>
                  ))}
                </Select>
                <Select
                  value={bulkSubcategoryId}
                  onChange={(event) => setBulkSubcategoryId(event.target.value)}
                  disabled={bulkCategoryId === ""}
                  aria-label="Subcategoria para ação em lote"
                >
                  <option value="">Sem subcategoria</option>
                  {(bundle?.subcategories ?? [])
                    .filter(
                      (subcategory) =>
                        subcategory.categoryId === bulkCategoryId,
                    )
                    .map((subcategory) => (
                      <option key={subcategory.id} value={subcategory.id}>
                        {subcategory.name}
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

          {comparisonFailed && targetError !== null ? (
            <div
              className="ff-alert ff-alert--negative"
              role="alert"
              style={{ marginBottom: 12 }}
            >
              <strong>Não consegui comparar com o que já está no banco</strong>
              <p style={{ margin: "6px 0 10px" }}>
                A lista continua aqui pra você revisar; a gravação só é liberada
                quando a comparação funcionar.
              </p>
              <Button
                variant="ghost"
                onClick={() => setTargetRetry((value) => value + 1)}
              >
                Tentar novamente
              </Button>
              <details style={{ marginTop: 8 }}>
                <summary className="ff-note">Detalhe técnico</summary>
                <p className="ff-note" style={{ margin: "4px 0 0" }}>
                  {targetError.message}
                </p>
              </details>
            </div>
          ) : null}

          <PreviewList
            groups={visibleGroups}
            rowsByIndex={rowViews}
            totalGroupCount={orderedGroups.length}
            categories={bundle?.categories ?? []}
            subsByCategory={subsByCategory}
            providerLabel={providerLabel}
            comparison={comparison}
            toolbar={{
              filter,
              onFilter: setFilter,
              counts: filterCounts,
              search,
              onSearch: setSearch,
              period: formatPeriod(preview.rows),
              canUndo: mappingUndo !== null,
              onUndo: undoBulkCategory,
            }}
            onToggleRow={toggleExcluded}
            onToggleGroup={onToggleGroup}
            onGroupCategory={onGroupCategory}
            onGroupSubcategory={onGroupSubcategory}
            onGroupRemember={onGroupRemember}
            onRowCategory={setRowCategory}
            onRowSubcategory={setRowSubcategory}
            onDetachRow={onDetachRow}
            onAttachRow={onAttachRow}
            onRowEdit={onRowEdit}
            onLearnSourceCategory={onLearnSourceCategory}
            onApplyAiSuggestion={applyAiSuggestion}
            footer={{
              summary: summaryLine,
              pendenciasCount: pendencias.length,
              onOpenPendencias: () => setPendenciasOpen(true),
              draftSavedAt,
              onContinueLater,
              destination: destinationSelect,
              onBack: () => setBundle(null),
              onConfirm: onGravar,
              confirmLabel,
              isPending,
            }}
          />
          <ConfirmBlockedDialog
            open={pendenciasOpen}
            pendencias={pendencias}
            selectedCount={selectedCount + selectedGroupCount}
            onClose={() => setPendenciasOpen(false)}
            onAction={onPendenciaAction}
            onConfirmAnyway={() => {
              setPendenciasOpen(false);
              onConfirm();
            }}
          />

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
