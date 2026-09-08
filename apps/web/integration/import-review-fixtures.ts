import { brl } from "@family-finance/domain";
import {
  assignRowIdentities,
  assignInstallmentGroupIdentities,
  normalizedRowsFingerprint,
  buildImportPreview,
  type NormalizedImportRow,
} from "@family-finance/importers";
import { planCategorizationBatch } from "@family-finance/categorization";
import {
  importPreviewSnapshotHash,
  signImportPreviewToken,
} from "../app/(app)/imports/preview-token";
import type { PreviewState, ConfirmInput } from "../app/(app)/imports/actions";

export const HOUSEHOLD = "00000000-0000-0000-0000-000000000001";
export const USER = "11111111-1111-1111-1111-111111111111";
export const CARD = "33333333-3333-3333-3333-333333333333";
export const SECRET = "test-import-preview-secret-with-at-least-32-characters";

export function reviewPreview(groupCount = 1): PreviewState {
  const groups = Array.from({ length: groupCount }, (_, index) => ({
    rowIndex: index,
    sourceLine: index + 2,
    description: `MARKETPLACE LOJA ${index + 1}`,
    installmentCount: 10,
    installmentNumber: 1,
    purchasedOn: "2026-08-17",
    purchaseMonth: "2026-08",
    perInstallmentCents: 4199,
    estimatedTotalCents: 41990,
    status: "new" as const,
  }));
  const rows: NormalizedImportRow[] = groups.map((g) => ({
    sourceLine: g.sourceLine,
    occurredOn: "2026-08-17",
    description: g.description,
    amount: brl(4199),
    kind: "expense",
    installment: { number: 1, count: 10 },
  }));
  rows.push({
    sourceLine: groupCount + 2,
    occurredOn: "2026-08-19",
    description: "Compra avulsa",
    amount: brl(1234),
    kind: "expense",
  });
  const identities = assignRowIdentities(
    rows.map((row) => ({
      source: "mercado-pago",
      row,
      sourceMetadata: { statementReferenceMonth: "2026-09" },
    })),
  );
  const snapshot = {
    source: "mercado-pago" as const,
    rows,
    errors: [],
    identities,
    referenceMonth: "2026-09",
    installmentGroups: groups,
    groupSourceRowIndices: groups.map((_, i) => i),
    groupIdentities: assignInstallmentGroupIdentities(
      groups.map((g) => ({ ...g, source: "mercado-pago" })),
    ),
  };
  const normalizedFingerprint = normalizedRowsFingerprint(identities);
  const claims = {
    version: 2 as const,
    requestKey: "22222222-2222-2222-2222-222222222222",
    householdId: HOUSEHOLD,
    userId: USER,
    issuedAt: Date.now(),
    expiresAt: Date.now() + 60_000,
    source: "mercado-pago" as const,
    fileFingerprint: "a".repeat(64),
    normalizedFingerprint,
    parserVersion: "mercado-pago-v1",
    snapshotHash: importPreviewSnapshotHash(snapshot),
  };
  return {
    ok: true,
    version: 2,
    requestKey: claims.requestKey,
    previewToken: signImportPreviewToken(claims, SECRET),
    fileFingerprint: claims.fileFingerprint,
    normalizedFingerprint,
    parserVersion: claims.parserVersion,
    snapshot,
    preview: buildImportPreview({ source: "mercado-pago", rows, errors: [] }),
    categorizationPlan: planCategorizationBatch([], {
      catalog: { householdId: HOUSEHOLD, categories: [], subcategories: [] },
    }),
    priorDispositions: {},
    accounts: [],
    categories: [],
    subcategories: [],
    creditCards: [
      { id: CARD, name: "Cartão A" },
      { id: "other-card", name: "Cartão B" },
    ],
    mp: {
      referenceMonth: "2026-09",
      groups,
      installmentRowIndices: groups.map((_, i) => i),
      dbDuplicateIndices: [],
    },
  };
}

export function reviewConfirmation(preview = reviewPreview()): ConfirmInput {
  return {
    previewToken: preview.previewToken,
    snapshot: preview.snapshot,
    requestKey: preview.requestKey,
    fileFingerprint: preview.fileFingerprint,
    normalizedFingerprint: preview.normalizedFingerprint,
    parserVersion: preview.parserVersion,
    source: "mercado-pago",
    creditCardId: CARD,
    mapping: {},
    selectedIndices: [preview.snapshot.rows.length - 1],
    groups: preview.mp!.groups.map((g, i) => ({
      sourceGroupIndex: i,
      description: g.description,
      totalAmountCents: g.estimatedTotalCents,
      installmentCount: g.installmentCount,
      purchasedOn: g.purchasedOn,
      creditCardId: CARD,
    })),
  };
}
