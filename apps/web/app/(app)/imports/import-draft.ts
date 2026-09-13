import type { ConfirmInput } from "./actions";

export type ImportDraft = {
  rowCount: number;
  savedAt: string;
  mapping: NonNullable<ConfirmInput["mapping"]>;
  learning: NonNullable<ConfirmInput["learning"]>;
  excluded: number[];
  rowEdits: NonNullable<ConfirmInput["edits"]>;
  detached: number[];
};

export function draftKey(fileFingerprint: string): string {
  return `ff-import-draft:${fileFingerprint}`;
}

export function saveDraft(
  storage: Pick<Storage, "setItem">,
  fileFingerprint: string,
  draft: Omit<ImportDraft, "savedAt">,
  now = new Date(),
): ImportDraft {
  const saved = { ...draft, savedAt: now.toISOString() };
  try {
    storage.setItem(draftKey(fileFingerprint), JSON.stringify(saved));
  } catch {
    // Draft persistence is best-effort when browser storage is unavailable.
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
  fileFingerprint: string,
  rowCount: number,
): ImportDraft | null {
  try {
    const raw = storage.getItem(draftKey(fileFingerprint));
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
    if (!isRecord(mapping) || !isRecord(learning) || !isRecord(rowEdits))
      return null;
    return {
      rowCount,
      savedAt: payload.savedAt,
      mapping,
      learning,
      rowEdits,
      excluded: payload.excluded,
      detached: payload.detached,
    } as ImportDraft;
  } catch {
    return null;
  }
}

export function clearDraft(
  storage: Pick<Storage, "removeItem">,
  fileFingerprint: string,
): void {
  try {
    storage.removeItem(draftKey(fileFingerprint));
  } catch {
    // Browser storage can also become unavailable after a draft was saved.
  }
}

export function formatSavedAt(iso: string): string {
  const date = new Date(iso);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}
