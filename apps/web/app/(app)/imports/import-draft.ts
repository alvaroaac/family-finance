import type { ConfirmInput } from "./actions";

export type DraftOwner = { userId: string; householdId: string };

export type DraftGroupEdit = {
  purchaseDescription?: string;
  purchaseDescriptionEdited?: boolean;
  existingGroupId?: string;
  existingGroupUpdatedAt?: string;
  totalAmountCents: number;
  installmentCount: number;
  purchasedOn: string;
  skip: boolean;
  categoryId?: string;
  subcategoryId?: string;
};

export type ImportDraft = {
  rowCount: number;
  savedAt: string;
  mapping: NonNullable<ConfirmInput["mapping"]>;
  learning: NonNullable<ConfirmInput["learning"]>;
  excluded: number[];
  rowEdits: NonNullable<ConfirmInput["edits"]>;
  detached: number[];
  groupEdits: Record<number, DraftGroupEdit>;
};

/** Browser storage, or null when the browser refuses access to it. */
export function draftStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function draftKey(owner: DraftOwner, fileFingerprint: string): string {
  return `ff-import-draft:v2:${owner.householdId}:${owner.userId}:${fileFingerprint}`;
}

/** Returns the saved draft, or null when storage refused the write. */
export function saveDraft(
  storage: Pick<Storage, "setItem">,
  owner: DraftOwner,
  fileFingerprint: string,
  draft: Omit<ImportDraft, "savedAt">,
  now = new Date(),
): ImportDraft | null {
  const saved = { ...draft, savedAt: now.toISOString() };
  try {
    storage.setItem(draftKey(owner, fileFingerprint), JSON.stringify(saved));
  } catch {
    return null;
  }
  return saved;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isNumberArray(value: unknown): value is number[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "number")
  );
}

export function loadDraft(
  storage: Pick<Storage, "getItem">,
  owner: DraftOwner,
  fileFingerprint: string,
  rowCount: number,
): ImportDraft | null {
  try {
    const raw = storage.getItem(draftKey(owner, fileFingerprint));
    if (raw === null) return null;
    const payload: unknown = JSON.parse(raw);
    if (
      !isRecord(payload) ||
      payload.rowCount !== rowCount ||
      typeof payload.savedAt !== "string" ||
      !isNumberArray(payload.excluded) ||
      !isNumberArray(payload.detached)
    )
      return null;
    const mapping = payload.mapping ?? {};
    const learning = payload.learning ?? {};
    const rowEdits = payload.rowEdits ?? {};
    const groupEdits = payload.groupEdits ?? {};
    if (
      !isRecord(mapping) ||
      !isRecord(learning) ||
      !isRecord(rowEdits) ||
      !isRecord(groupEdits)
    )
      return null;
    return {
      rowCount,
      savedAt: payload.savedAt,
      mapping,
      learning,
      rowEdits,
      groupEdits,
      excluded: payload.excluded,
      detached: payload.detached,
    } as ImportDraft;
  } catch {
    return null;
  }
}

export function clearDraft(
  storage: Pick<Storage, "removeItem">,
  owner: DraftOwner,
  fileFingerprint: string,
): void {
  try {
    storage.removeItem(draftKey(owner, fileFingerprint));
  } catch {
    // Browser storage can also become unavailable after a draft was saved.
  }
}

export function formatSavedAt(iso: string): string {
  const date = new Date(iso);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}
