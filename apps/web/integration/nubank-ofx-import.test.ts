import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  previewImport,
  confirmImport,
  resolveImportTargets,
  type PreviewState,
} from "../app/(app)/imports/actions";
import {
  nubankOfxFixture,
  ofxTransaction,
} from "../../../packages/importers/src/__fixtures__/nubank-ofx";

const mocks = vi.hoisted(() => ({
  confirm: vi.fn(),
  claims: vi.fn(async (..._args: unknown[]) => []),
  client: {
    auth: {
      getUser: async () => ({
        data: { user: { id: "11111111-1111-4111-8111-111111111111" } },
      }),
    },
  },
}));
const CARD = "22222222-2222-4222-8222-222222222222";
vi.mock("../lib/auth", () => ({
  requireAuthorizedUser: async () => undefined,
}));
vi.mock("../lib/supabase", () => ({
  createServerSupabaseClient: async () => mocks.client,
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@family-finance/config", async (original) => ({
  ...(await original<typeof import("@family-finance/config")>()),
  getServerEnv: () => ({
    IMPORT_PREVIEW_SIGNING_SECRET:
      "synthetic-signing-secret-with-32-characters",
  }),
}));
vi.mock("@family-finance/db", async (original) => ({
  ...(await original<typeof import("@family-finance/db")>()),
  findHouseholdIdForCurrentUser: async () =>
    "33333333-3333-4333-8333-333333333333",
  findAccountsByHousehold: async () => [],
  findCategoriesByHousehold: async () => [],
  findSubcategoriesByCategory: async () => [],
  listCreditCards: async () => [
    {
      id: "22222222-2222-4222-8222-222222222222",
      name: "Nubank",
      closing_day: 1,
      due_day: 8,
    },
  ],
  listActiveCategorizationMemory: async () => [],
  listSourceCategoryMappings: async () => [],
  findImportRowsByFileFingerprint: async () => [],
  findCardChargesBetween: async () => [],
  findImportItemClaims: mocks.claims,
  findTransactionsForInstrumentBetween: async () => [],
  findManualExpensesBetween: async () => [],
  listInstallmentGroupsByHousehold: async () => [],
  listInstallmentsByDueMonth: async () => [],
  confirmImportV2: mocks.confirm,
}));

async function preview(text = nubankOfxFixture()): Promise<PreviewState> {
  const form = new FormData();
  form.set("source", "nubank-ofx");
  form.set(
    "file",
    new File([text], "synthetic.ofx", { type: "application/x-ofx" }),
  );
  const result = await previewImport(form);
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (!result.ok) throw new Error(result.message);
  return result;
}

function confirmation(bundle: PreviewState) {
  return {
    ...bundle,
    source: bundle.snapshot.source,
    mapping: {},
    creditCardId: CARD,
    selectedIndices: bundle.preview.rows.map((_, i) => i),
  };
}

describe("Nubank OFX server import flow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.confirm.mockResolvedValue({
      transactions_created: 2,
      installment_groups_created: 0,
      duplicate_rows: 0,
      error_rows: 0,
      imported_rows: 2,
      batch: { id: "batch" },
      replayed: false,
    });
  });

  it("previews and confirms purchases and refunds against the selected card, excluding payments", async () => {
    const bundle = await preview(
      nubankOfxFixture(
        ofxTransaction() +
          ofxTransaction({
            FITID: "refund",
            MEMO: "Estorno",
            TRNTYPE: "CREDIT",
            TRNAMT: "10.00",
          }) +
          ofxTransaction({
            FITID: "payment",
            MEMO: "Pagamento recebido",
            TRNTYPE: "CREDIT",
            TRNAMT: "100.00",
          }),
      ),
    );
    expect(bundle.mp).toBeDefined();
    expect(bundle.preview.rows).toHaveLength(2);
    expect(bundle.notices?.join(" ")).toContain("1 pagamento(s)");
    const result = await confirmImport(confirmation(bundle));
    expect(result.ok, JSON.stringify(result)).toBe(true);
    const [, batch, items] = mocks.confirm.mock.calls[0]!;
    expect(batch.source).toBe("nubank_ofx");
    expect(items).toHaveLength(2);
    expect(items[0].transaction).toMatchObject({
      credit_card_id: CARD,
      kind: "expense",
      amount_cents: 2550,
    });
    expect(items[1].transaction).toMatchObject({
      credit_card_id: CARD,
      kind: "income",
      amount_cents: 1000,
    });
    expect(
      items.every(
        (item: { transaction: { account_id: unknown } }) =>
          !item.transaction.account_id,
      ),
    ).toBe(true);
  });

  it("requires an active card and validates the signed preview", async () => {
    const bundle = await preview();
    expect(
      (
        await confirmImport({
          ...confirmation(bundle),
          creditCardId: "unknown",
        })
      ).ok,
    ).toBe(false);
    expect(
      (
        await confirmImport({
          ...confirmation(bundle),
          snapshot: { ...bundle.snapshot, rows: [] },
        })
      ).ok,
    ).toBe(false);
    expect(mocks.confirm).not.toHaveBeenCalled();
  });

  it("reuses the installment confirmation flow", async () => {
    const bundle = await preview(
      nubankOfxFixture(ofxTransaction({ MEMO: "Loja - Parcela 2/3" })),
    );
    const group = bundle.snapshot.installmentGroups![0]!;
    const result = await confirmImport({
      ...confirmation(bundle),
      groups: [
        {
          sourceGroupIndex: 0,
          description: group.description,
          totalAmountCents: group.estimatedTotalCents,
          installmentCount: group.installmentCount,
          purchasedOn: group.purchasedOn,
          creditCardId: CARD,
        },
      ],
    });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    const items = mocks.confirm.mock.calls[0]![2];
    const parcel = items.find(
      (item: { installment_group?: unknown }) => item.installment_group,
    );
    expect(parcel.installment_group.credit_card_id).toBe(CARD);
    expect(parcel.installments).toHaveLength(3);
    expect(parcel.observed_installment_number).toBe(2);
  });

  it("resolves stable OFX claims using the card destination", async () => {
    const bundle = await preview();
    const result = await resolveImportTargets({
      ...bundle,
      creditCardId: CARD,
    });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(mocks.claims).toHaveBeenCalled();
    expect(mocks.claims.mock.calls[0]?.[2]).toBe("nubank_ofx");
  });

  it("rejects PDF disguised as an OFX and keeps CSV upload validation", async () => {
    for (const source of ["nubank", "nubank-ofx"]) {
      const form = new FormData();
      form.set("source", source);
      form.set(
        "file",
        new File(["%PDF-fake"], "fake.ofx", { type: "application/pdf" }),
      );
      expect((await previewImport(form)).ok).toBe(false);
    }
  });
});
