import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  confirmImport,
  resolveImportTargets,
} from "../app/(app)/imports/actions";
import {
  reviewPreview,
  reviewConfirmation,
  HOUSEHOLD,
  USER,
  CARD,
  SECRET,
} from "./import-review-fixtures";
import { claimIdentity } from "@family-finance/importers";

const db = vi.hoisted(() => ({
  groups: vi.fn(),
  installments: vi.fn(),
  claims: vi.fn(),
  persist: vi.fn(),
  manualExpenses: vi.fn(),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("../lib/auth", () => ({ requireAuthorizedUser: vi.fn() }));
vi.mock("../lib/supabase", () => ({
  createServerSupabaseClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: USER } } }) },
  }),
}));
vi.mock("@family-finance/config", () => ({
  getServerEnv: () => ({ IMPORT_PREVIEW_SIGNING_SECRET: SECRET }),
}));
vi.mock("@family-finance/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@family-finance/db")>()),
  findHouseholdIdForCurrentUser: async () => HOUSEHOLD,
  findAccountsByHousehold: async () => [],
  listCreditCards: async () => [
    { id: CARD, name: "Cartão A", closing_day: 28, due_day: 5 },
  ],
  findCategoriesByHousehold: async () => [],
  findTransactionsForInstrumentBetween: async () => [],
  findManualExpensesBetween: db.manualExpenses,
  listInstallmentGroupsByHousehold: db.groups,
  listInstallmentsByDueMonth: db.installments,
  findImportItemClaims: db.claims,
  confirmImportV2: db.persist,
}));

function installCandidates(count = 1, amount = 4199) {
  db.groups.mockResolvedValue(
    Array.from({ length: count }, (_, i) => ({
      id: `existing-${i}`,
      credit_card_id: CARD,
      description: `Teclado ${i}`,
      total_amount_cents: amount * 10,
      installment_count: 10,
      purchased_on: "2026-08-24",
    })),
  );
  db.installments.mockImplementation(async (_client, _household, month) =>
    month === "2026-09"
      ? Array.from({ length: count }, (_, i) => ({
          installment_group_id: `existing-${i}`,
          credit_card_id: CARD,
          number: 1,
          installment_count: 10,
          amount_cents: amount,
        }))
      : [],
  );
}
function targets(preview = reviewPreview()) {
  return {
    previewToken: preview.previewToken,
    snapshot: preview.snapshot,
    creditCardId: CARD,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  installCandidates();
  db.claims.mockResolvedValue([]);
  db.manualExpenses.mockResolvedValue([]);
  db.persist.mockResolvedValue({
    batch: { id: "batch" },
    replayed: false,
    imported_rows: 2,
    transactions_created: 1,
    installment_groups_created: 1,
    duplicate_rows: 0,
    error_rows: 0,
    excluded_rows: 0,
  });
});

describe("installment review through the real server actions", () => {
  it("requires review for a flat expense with the same total, name and month", async () => {
    db.groups.mockResolvedValue([]);
    db.installments.mockResolvedValue([]);
    db.manualExpenses.mockResolvedValue([
      {
        id: "flat",
        kind: "expense",
        amount_cents: 41990,
        description: "MARKETPLACE LOJA 1",
        occurred_on: "2026-08-16",
        credit_card_id: CARD,
        account_id: null,
        installment_id: null,
        import_batch_id: null,
        obligation_id: null,
        updated_at: "2026-08-16T12:00:00Z",
        category_id: null,
        subcategory_id: null,
      },
    ]);
    expect(await resolveImportTargets(targets())).toMatchObject({
      ok: true,
      groupDuplicateIndices: [],
      groupReviewRequiredIndices: [0],
      flatMatchesByIndex: {
        0: [{ transactionId: "flat", confidence: "very_strong" }],
      },
    });
    expect(await confirmImport(reviewConfirmation())).toMatchObject({
      ok: false,
    });
    expect(db.persist).not.toHaveBeenCalled();
    const input = reviewConfirmation();
    input.groups![0]!.replaceTransaction = {
      id: "flat",
      updatedAt: "2026-08-16T12:00:00Z",
    };
    expect(await confirmImport(input)).toMatchObject({ ok: true });
    expect(db.persist.mock.calls[0]![2]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          replace_transaction: {
            id: "flat",
            updated_at: "2026-08-16T12:00:00Z",
          },
        }),
      ]),
    );
  });
  it("rejects sharing one replacement between two imported groups", async () => {
    db.groups.mockResolvedValue([]);
    db.installments.mockResolvedValue([]);
    const input = reviewConfirmation(reviewPreview(2));
    input.groups!.forEach((group) => {
      group.replaceTransaction = {
        id: "flat",
        updatedAt: "2026-08-16T12:00:00Z",
      };
    });
    expect(await confirmImport(input)).toMatchObject({
      ok: false,
      message: expect.stringContaining("duas compras"),
    });
    expect(db.persist).not.toHaveBeenCalled();
  });
  it("classifies a unique exact amount/count/card match despite different descriptions", async () => {
    const result = await resolveImportTargets(targets());
    expect(result).toMatchObject({
      ok: true,
      groupDuplicateIndices: [0],
      groupMatchCountsByIndex: { 0: 1 },
      groupMatchesByIndex: {
        0: [{ confidence: "very_strong", installmentGroupId: "existing-0" }],
      },
    });
    expect(db.installments).toHaveBeenCalledWith(
      expect.anything(),
      HOUSEHOLD,
      "2026-09",
    );
  });
  it("keeps two distinct statement purchases sharing one candidate for explicit review", async () => {
    const result = await resolveImportTargets(targets(reviewPreview(2)));
    expect(result).toMatchObject({
      ok: true,
      groupDuplicateIndices: [],
      groupMatchCountsByIndex: { 0: 1, 1: 1 },
    });
  });
  it("preserves exact persisted claims even when another group shares the candidate", async () => {
    const preview = reviewPreview(2);
    const claim = claimIdentity(preview.snapshot.groupIdentities![0]!, {
      type: "credit_card",
      id: CARD,
    });
    db.claims.mockResolvedValue([
      {
        id: "claim",
        base_fingerprint: claim.claimFingerprint,
        occurrence_no: claim.occurrenceNo,
      },
    ]);
    expect(await resolveImportTargets(targets(preview))).toMatchObject({
      ok: true,
      groupDuplicateIndices: [0],
      groupClaimIdsByIndex: { 0: "claim" },
    });
  });
  it.each([4199, 4100])(
    "rejects missing and short reasons for a %i-cent existing installment before persistence",
    async (amount) => {
      installCandidates(1, amount);
      const input = reviewConfirmation();
      expect(await confirmImport(input)).toMatchObject({
        ok: false,
        message: expect.stringContaining("motivo"),
      });
      input.groups![0]!.override = { reason: "abc" };
      expect(await confirmImport(input)).toMatchObject({ ok: false });
      expect(db.persist).not.toHaveBeenCalled();
      input.groups![0]!.override = { reason: "São compras diferentes" };
      expect(await confirmImport(input)).toMatchObject({ ok: true });
      expect(db.persist.mock.calls[0]![2]).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            disposition: "imported",
            override_reason: "São compras diferentes",
            installment_group: expect.any(Object),
          }),
        ]),
      );
    },
  );
  it("requires a reason for ambiguous candidates too", async () => {
    installCandidates(2);
    expect(await confirmImport(reviewConfirmation())).toMatchObject({
      ok: false,
    });
    expect(db.persist).not.toHaveBeenCalled();
  });
  it("allows an unrelated amount without a reason", async () => {
    installCandidates(1, 9999);
    expect(await confirmImport(reviewConfirmation())).toMatchObject({
      ok: true,
    });
  });
  it("does not use installments from a different billing month", async () => {
    // The repository has matching parcels only outside the signed reference month.
    const preview = reviewPreview();
    db.installments.mockImplementation(async (_client, _household, month) =>
      month === "2026-08"
        ? [
            {
              installment_group_id: "existing-0",
              credit_card_id: CARD,
              number: 1,
              installment_count: 10,
              amount_cents: 4199,
            },
          ]
        : [],
    );
    expect(await resolveImportTargets(targets(preview))).toMatchObject({
      ok: true,
      groupMatchesByIndex: {},
    });
    expect(await confirmImport(reviewConfirmation(preview))).toMatchObject({
      ok: true,
    });
  });
  it("returns bounded pages without turning a multi-candidate match into a unique one", async () => {
    installCandidates(12);
    const first = await resolveImportTargets(targets());
    const second = await resolveImportTargets({
      ...targets(),
      matchPage: { groupIndex: 0, offset: 5 },
    });
    expect(first).toMatchObject({
      ok: true,
      groupDuplicateIndices: [],
      groupMatchCountsByIndex: { 0: 12 },
    });
    if (!first.ok || !second.ok) throw new Error("Resolution failed");
    expect(first.groupMatchesByIndex[0]).toHaveLength(5);
    expect(second.groupMatchesByIndex[0]).toHaveLength(5);
    expect(
      new Set(
        [
          ...first.groupMatchesByIndex[0]!,
          ...second.groupMatchesByIndex[0]!,
        ].map((m) => m.installmentGroupId),
      ).size,
    ).toBe(10);
    expect(second.groupDuplicateIndices).toEqual([]);
  });
  it("keeps legacy-only matches reviewable without automatically skipping them", async () => {
    const preview = reviewPreview();
    db.groups.mockResolvedValue([
      {
        id: "legacy",
        credit_card_id: CARD,
        description: preview.mp!.groups[0]!.description,
        installment_count: 10,
        purchased_on: "2026-08-17",
        total_amount_cents: 41990,
      },
    ]);
    db.installments.mockResolvedValue([]);
    expect(await resolveImportTargets(targets(preview))).toMatchObject({
      ok: true,
      groupDuplicateIndices: [],
      groupMatchesByIndex: {},
      groupReviewRequiredIndices: [0],
    });
    const input = reviewConfirmation(preview);
    expect(await confirmImport(input)).toMatchObject({ ok: false });
    expect(db.persist).not.toHaveBeenCalled();
    input.groups![0]!.override = { reason: "São compras diferentes" };
    expect(await confirmImport(input)).toMatchObject({ ok: true });
  });
  it("requires justification for amount-only medium confidence", async () => {
    db.installments.mockResolvedValue([
      {
        installment_group_id: "existing-0",
        credit_card_id: CARD,
        number: 1,
        installment_count: 4,
        amount_cents: 4199,
      },
    ]);
    expect(await resolveImportTargets(targets())).toMatchObject({
      ok: true,
      groupMatchesByIndex: { 0: [{ confidence: "medium" }] },
    });
    expect(await confirmImport(reviewConfirmation())).toMatchObject({
      ok: false,
    });
    expect(db.persist).not.toHaveBeenCalled();
  });
  it("bounds a repeated-amount statement response", async () => {
    installCandidates(100);
    const result = await resolveImportTargets(targets(reviewPreview(100)));
    if (!result.ok) throw new Error(result.message);
    expect(Object.values(result.groupMatchesByIndex).flat()).toHaveLength(500);
    expect(result.groupDuplicateIndices).toEqual([]);
  });
  it("rejects invalid pagination and invalid signatures", async () => {
    expect(
      await resolveImportTargets({
        ...targets(),
        matchPage: { groupIndex: 0, offset: -1 },
      }),
    ).toMatchObject({ ok: false });
    expect(
      await resolveImportTargets({ ...targets(), previewToken: "invalid" }),
    ).toMatchObject({ ok: false });
  });
});
