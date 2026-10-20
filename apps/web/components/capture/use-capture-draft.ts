"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import type { CaptureDraft } from "../../app/(app)/capture/actions";
import { centsToInputValue } from "../../lib/format";
import type {
  TransactionFieldKey,
  TransactionFieldOptions,
  TransactionFieldValues,
} from "../transaction-fields";

/**
 * State of one quick-capture draft: the free text, the editable field values,
 * which fields the AI filled, and the last fill's explanation/candidates.
 * Text and values survive a closed sheet or a reload through localStorage.
 *
 * Fields the user edits (since mount or the last `discard`) are protected:
 * a later `applyDraft` never overwrites them.
 */

export const CAPTURE_DRAFT_KEY = "ff-capture-draft";

export type CaptureResult = {
  explanation: string;
  candidates: Array<{ categoryId: string; subcategoryId?: string; name: string }>;
  needsReview: boolean;
};

type Stored = { text: string; values: TransactionFieldValues };

/** A stored draft whose shape no longer matches the defaults is ignored. */
function readStored(
  defaults: TransactionFieldValues,
  options: TransactionFieldOptions,
): Stored | null {
  try {
    const raw = localStorage.getItem(CAPTURE_DRAFT_KEY);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const { text, values } = parsed as Record<string, unknown>;
    if (typeof text !== "string") return null;
    if (typeof values !== "object" || values === null) return null;
    const record = values as Record<string, unknown>;
    const matches = (Object.keys(defaults) as TransactionFieldKey[]).every(
      (key) => typeof record[key] === typeof defaults[key],
    );
    if (!matches) return null;
    return {
      text,
      values: dropUnknownIds(values as TransactionFieldValues, defaults, options),
    };
  } catch {
    return null;
  }
}

/** Ids restored from storage that the current options no longer list fall back to the defaults. */
function dropUnknownIds(
  values: TransactionFieldValues,
  defaults: TransactionFieldValues,
  options: TransactionFieldOptions,
): TransactionFieldValues {
  const payments = [
    ...options.accounts.map((account) => `account:${account.id}`),
    ...options.cards.map((card) => `card:${card.id}`),
  ];
  const categoryId = options.categories.some((c) => c.id === values.categoryId)
    ? values.categoryId
    : defaults.categoryId;
  const subcategoryId = options.subcategories.some(
    (s) => s.id === values.subcategoryId && s.categoryId === categoryId,
  )
    ? values.subcategoryId
    : defaults.subcategoryId;
  const responsible =
    values.responsible === "household" ||
    options.responsibles.some((r) => r.value === values.responsible)
      ? values.responsible
      : defaults.responsible;
  return {
    ...values,
    payment: payments.includes(values.payment) ? values.payment : defaults.payment,
    categoryId,
    subcategoryId,
    responsible,
  };
}

function writeStored(stored: Stored | null): void {
  try {
    if (stored === null) localStorage.removeItem(CAPTURE_DRAFT_KEY);
    else localStorage.setItem(CAPTURE_DRAFT_KEY, JSON.stringify(stored));
  } catch {
    // Storage full or blocked: the draft just doesn't survive a reload.
  }
}

function isPristine(
  text: string,
  values: TransactionFieldValues,
  defaults: TransactionFieldValues,
): boolean {
  return (
    text === "" &&
    (Object.keys(defaults) as TransactionFieldKey[]).every(
      (key) => values[key] === defaults[key],
    )
  );
}

/** The field values a draft proposes; keys it has nothing for are left out. */
function draftToValues(
  draft: CaptureDraft,
  options: TransactionFieldOptions,
): Partial<TransactionFieldValues> {
  const proposed: Partial<TransactionFieldValues> = {
    kind: draft.kind,
    occurredOn: draft.date,
    responsible:
      options.responsibles.find((r) => r.value === draft.responsibleUserId)
        ?.value ?? "household",
  };
  if (draft.description.trim() !== "") proposed.description = draft.description;
  if (draft.amountCents !== undefined) {
    proposed.amount = centsToInputValue(draft.amountCents);
  }
  if (draft.accountId !== undefined) {
    proposed.payment = `account:${draft.accountId}`;
  } else if (draft.creditCardId !== undefined) {
    proposed.payment = `card:${draft.creditCardId}`;
    proposed.purchaseMode = draft.installmentCount >= 2 ? "parcelado" : "avista";
    if (draft.installmentCount >= 2) {
      proposed.installmentCount = draft.installmentCount;
    }
  }
  if (!draft.needsReview && draft.categoryId !== undefined) {
    proposed.categoryId = draft.categoryId;
    proposed.subcategoryId = draft.subcategoryId ?? "";
  }
  return proposed;
}

function toResult(
  draft: CaptureDraft,
  options: TransactionFieldOptions,
): CaptureResult {
  return {
    explanation: draft.explanation,
    needsReview: draft.needsReview,
    candidates: draft.candidates.flatMap((candidate) => {
      const category = options.categories.find(
        (c) => c.id === candidate.categoryId,
      );
      if (category === undefined) return [];
      return [
        {
          categoryId: candidate.categoryId,
          ...(candidate.subcategoryId !== undefined
            ? { subcategoryId: candidate.subcategoryId }
            : {}),
          name: category.name,
        },
      ];
    }),
  };
}

export function useCaptureDraft(
  defaults: TransactionFieldValues,
  options: TransactionFieldOptions,
) {
  const [initial] = useState(() => readStored(defaults, options));
  const [text, setText] = useState(initial?.text ?? "");
  const [values, setValues] = useState(initial?.values ?? defaults);
  const [aiFilled, setAiFilled] = useState<ReadonlySet<TransactionFieldKey>>(
    () => new Set(),
  );
  const [result, setResult] = useState<CaptureResult | null>(null);
  const edited = useRef(new Set<TransactionFieldKey>());
  const defaultsRef = useRef(defaults);

  useEffect(() => {
    writeStored(
      isPristine(text, values, defaultsRef.current) ? null : { text, values },
    );
  }, [text, values]);

  const setField = useCallback(
    <K extends TransactionFieldKey>(key: K, value: TransactionFieldValues[K]) => {
      edited.current.add(key);
      setValues((current) => ({ ...current, [key]: value }));
      setAiFilled((current) => {
        if (!current.has(key)) return current;
        const next = new Set(current);
        next.delete(key);
        return next;
      });
    },
    [],
  );

  const applyDraft = useCallback(
    (draft: CaptureDraft, options: TransactionFieldOptions) => {
      const proposed = draftToValues(draft, options);
      const filled = (Object.keys(proposed) as TransactionFieldKey[]).filter(
        (key) => !edited.current.has(key),
      );
      const patch = Object.fromEntries(filled.map((key) => [key, proposed[key]]));
      const keep = new Set(edited.current);
      // No category from this fill: the old one is wrong when review is
      // needed or the kind changed, so clear whatever the user didn't pick.
      const clearCategory = (current: TransactionFieldValues) =>
        proposed.categoryId === undefined &&
        (draft.needsReview || (patch.kind ?? current.kind) !== current.kind);
      setValues((current) => {
        const next = { ...current, ...patch };
        if (clearCategory(current)) {
          if (!keep.has("categoryId")) next.categoryId = "";
          if (!keep.has("subcategoryId")) next.subcategoryId = "";
        }
        return next;
      });
      setAiFilled(new Set(filled));
      setResult(toResult(draft, options));
    },
    [],
  );

  const discard = useCallback(() => {
    edited.current = new Set();
    setText("");
    setValues(defaultsRef.current);
    setAiFilled(new Set());
    setResult(null);
    writeStored(null);
  }, []);

  return { text, setText, values, setField, aiFilled, applyDraft, result, discard };
}
