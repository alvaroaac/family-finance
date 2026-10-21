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
 * Text, values and the set of user-edited fields survive a closed sheet or a
 * reload through localStorage, under a key per signed-in user.
 *
 * Fields the user edits (since the last `discard`) are protected: a later
 * `applyDraft` never overwrites them.
 */

/** Per user, so a shared browser never shows one member's draft to another. */
export function captureDraftKey(userId: string): string {
  return `ff-capture-draft:${userId}`;
}

export type CaptureResult = {
  explanation: string;
  candidates: Array<{ categoryId: string; subcategoryId?: string; name: string }>;
  needsReview: boolean;
};

type Stored = {
  text: string;
  values: TransactionFieldValues;
  edited: TransactionFieldKey[];
};

const KINDS: ReadonlyArray<TransactionFieldValues["kind"]> = ["expense", "income"];
const PURCHASE_MODES: ReadonlyArray<TransactionFieldValues["purchaseMode"]> = [
  "avista",
  "parcelado",
];

/**
 * A stored draft whose shape no longer matches the defaults is ignored; a
 * missing or malformed edited set restores as empty.
 */
function readStored(
  key: string,
  defaults: TransactionFieldValues,
  options: TransactionFieldOptions,
): Stored | null {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const { text, values, edited } = parsed as Record<string, unknown>;
    if (typeof text !== "string") return null;
    if (typeof values !== "object" || values === null) return null;
    const record = values as Record<string, unknown>;
    const matches = (Object.keys(defaults) as TransactionFieldKey[]).every(
      (key) => typeof record[key] === typeof defaults[key],
    );
    if (!matches) return null;
    if (!KINDS.includes(record.kind as TransactionFieldValues["kind"])) return null;
    if (
      !PURCHASE_MODES.includes(
        record.purchaseMode as TransactionFieldValues["purchaseMode"],
      )
    ) {
      return null;
    }
    const keys = Object.keys(defaults);
    const validEdited =
      Array.isArray(edited) &&
      edited.every((key) => typeof key === "string" && keys.includes(key));
    return {
      text,
      values: dropUnknownIds(values as TransactionFieldValues, defaults, options),
      edited: validEdited ? (edited as TransactionFieldKey[]) : [],
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
    "", // still to pick, as a fill leaves an installment without a known card
    ...options.accounts.map((account) => `account:${account.id}`),
    ...options.cards.map((card) => `card:${card.id}`),
  ];
  const responsible =
    values.responsible === "household" ||
    options.responsibles.some((r) => r.value === values.responsible)
      ? values.responsible
      : defaults.responsible;
  return fitCategory(
    {
      ...values,
      payment: payments.includes(values.payment) ? values.payment : defaults.payment,
      responsible,
    },
    options,
  );
}

/**
 * Clears a category that is unknown or of another kind, and a subcategory
 * that isn't its child — whoever picked them, like `changeKind` in
 * TransactionFields. The server checks neither, so this guards the save.
 */
function fitCategory(
  values: TransactionFieldValues,
  options: TransactionFieldOptions,
): TransactionFieldValues {
  const category = options.categories.find((c) => c.id === values.categoryId);
  if (values.categoryId !== "" && category?.kind !== values.kind) {
    return { ...values, categoryId: "", subcategoryId: "" };
  }
  const subcategory = options.subcategories.find(
    (s) => s.id === values.subcategoryId,
  );
  if (values.subcategoryId !== "" && subcategory?.categoryId !== values.categoryId) {
    return { ...values, subcategoryId: "" };
  }
  return values;
}

/** Income never goes on a card, so a fill under an income kind keeps only an account. */
function withoutCardFields(
  patch: Partial<TransactionFieldValues>,
): Partial<TransactionFieldValues> {
  const fitted = { ...patch };
  delete fitted.purchaseMode;
  delete fitted.installmentCount;
  if (!fitted.payment?.startsWith("account:")) delete fitted.payment;
  return fitted;
}

function writeStored(key: string, stored: Stored | null): void {
  try {
    if (stored === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(stored));
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
  };
  const responsible = options.responsibles.find(
    (r) => r.value === draft.responsibleUserId,
  );
  if (responsible !== undefined) proposed.responsible = responsible.value;
  if (draft.description.trim() !== "") proposed.description = draft.description;
  if (draft.amountCents !== undefined) {
    proposed.amount = centsToInputValue(draft.amountCents);
  }
  const installment = draft.installmentCount >= 2;
  if (draft.accountId !== undefined) {
    proposed.payment = `account:${draft.accountId}`;
  } else if (draft.creditCardId !== undefined || installment) {
    // An installment without a known card still needs one: "" makes the user pick.
    proposed.payment =
      draft.creditCardId !== undefined ? `card:${draft.creditCardId}` : "";
    proposed.purchaseMode = installment ? "parcelado" : "avista";
    if (installment) proposed.installmentCount = draft.installmentCount;
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
  userId: string,
  defaults: TransactionFieldValues,
  options: TransactionFieldOptions,
) {
  const key = captureDraftKey(userId);
  const [initial] = useState(() => readStored(key, defaults, options));
  const [text, setText] = useState(initial?.text ?? "");
  // One state so a fill can drop the AI mark of a field `fitCategory` cleared.
  const [form, setForm] = useState<{
    values: TransactionFieldValues;
    aiFilled: ReadonlySet<TransactionFieldKey>;
  }>(() => ({ values: initial?.values ?? defaults, aiFilled: new Set() }));
  const { values, aiFilled } = form;
  const [result, setResult] = useState<CaptureResult | null>(null);
  const edited = useRef(new Set<TransactionFieldKey>(initial?.edited));
  const defaultsRef = useRef(defaults);

  useEffect(() => {
    writeStored(
      key,
      isPristine(text, values, defaultsRef.current)
        ? null
        : { text, values, edited: [...edited.current] },
    );
  }, [key, text, values]);

  const setField = useCallback(
    <K extends TransactionFieldKey>(key: K, value: TransactionFieldValues[K]) => {
      edited.current.add(key);
      setForm((current) => {
        const marks = new Set(current.aiFilled);
        marks.delete(key);
        return { values: { ...current.values, [key]: value }, aiFilled: marks };
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
      const patch: Partial<TransactionFieldValues> = Object.fromEntries(
        filled.map((key) => [key, proposed[key]]),
      );
      // Review needed: the old category is a guess, so clear what the user didn't pick.
      if (draft.needsReview && !edited.current.has("categoryId")) {
        patch.categoryId = "";
        if (!edited.current.has("subcategoryId")) patch.subcategoryId = "";
      }
      setForm((current) => {
        const fitted =
          (patch.kind ?? current.values.kind) === "income"
            ? withoutCardFields(patch)
            : patch;
        const next = fitCategory({ ...current.values, ...fitted }, options);
        return {
          values: next,
          aiFilled: new Set(filled.filter((key) => next[key] === fitted[key])),
        };
      });
      setResult(toResult(draft, options));
    },
    [],
  );

  const discard = useCallback(() => {
    edited.current = new Set();
    setText("");
    setForm({ values: defaultsRef.current, aiFilled: new Set() });
    setResult(null);
    writeStored(key, null);
  }, [key]);

  return { text, setText, values, setField, aiFilled, applyDraft, result, discard };
}
