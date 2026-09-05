import { beforeEach, describe, expect, it, vi } from "vitest";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { AppSupabaseClient } from "@family-finance/db";
import {
  createObligationAction,
  updateObligationAction,
  cancelObligationAction,
  markObligationPaidAction,
  undoObligationPaymentAction,
} from "../app/(app)/obligations/actions.js";
import { requireAuthorizedUser } from "../lib/auth.js";
import {
  FakeSupabaseStore,
  createFakeSupabaseClient,
  type FakeDatabaseSeed,
} from "./fake-supabase.js";

const mockedSupabase = vi.hoisted(() => ({
  client: null as AppSupabaseClient | null,
}));
vi.mock("../lib/auth.js", () => ({
  requireAuthorizedUser: vi.fn(async () => undefined),
}));
vi.mock("../lib/supabase.js", () => ({
  createServerSupabaseClient: vi.fn(async () => {
    if (mockedSupabase.client === null)
      throw new Error("Fake Supabase client was not installed.");
    return mockedSupabase.client;
  }),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const HOUSEHOLD = "household-1";
const USER = "user-1";
function seed(): FakeDatabaseSeed {
  return {
    household_members: [
      { household_id: HOUSEHOLD, user_id: USER, is_active: true },
    ],
    accounts: [
      { id: "account-1", household_id: HOUSEHOLD, name: "Corrente" },
      { id: "foreign-account", household_id: "other", name: "Outra" },
    ],
    categories: [
      {
        id: "category-1",
        household_id: HOUSEHOLD,
        name: "Casa",
        is_active: true,
      },
      {
        id: "foreign-category",
        household_id: "other",
        name: "Outra",
        is_active: true,
      },
    ],
    obligations: [
      {
        id: "ob-1",
        household_id: HOUSEHOLD,
        description: "Aluguel",
        amount_cents: 10000,
        start_month: "2026-07",
        term_months: null,
        due_day: 5,
        account_id: "account-1",
        category_id: "category-1",
        status: "active",
        responsibility_scope: "household",
        responsible_user_id: null,
        created_by_user_id: USER,
      },
    ],
  };
}
function installClient(): FakeSupabaseStore {
  const store = new FakeSupabaseStore(seed());
  mockedSupabase.client = {
    ...createFakeSupabaseClient(store),
    auth: {
      getUser: vi.fn(async () => ({
        data: { user: { id: USER } },
        error: null,
      })),
    },
  } as unknown as AppSupabaseClient;
  return store;
}
function form(patch: Record<string, string> = {}): FormData {
  const fd = new FormData();
  for (const [key, value] of Object.entries({
    obligationId: "ob-1",
    description: "Aluguel",
    amount: "100,00",
    dueDay: "5",
    startMonth: "2026-07",
    month: "2026-07",
    accountId: "account-1",
    ...patch,
  }))
    fd.set(key, value);
  return fd;
}
function expectRevalidation(): void {
  expect(vi.mocked(revalidatePath).mock.calls).toEqual([
    ["/obligations"],
    ["/resumo"],
    ["/dashboard"],
  ]);
}

describe("obligation actions", () => {
  let store: FakeSupabaseStore;

  beforeEach(() => {
    vi.clearAllMocks();
    store = installClient();
  });

  it("creates and revalidates on success", async () => {
    expect(await createObligationAction(form())).toEqual({ ok: true });
    expect(store.table("obligations")).toHaveLength(2);
    expectRevalidation();
  });
  it("returns the domain validation message", async () => {
    expect(
      await createObligationAction(form({ startMonth: "invalid" })),
    ).toEqual({
      ok: false,
      error: "startMonth must be a valid YYYY-MM month.",
    });
    expect(revalidatePath).not.toHaveBeenCalled();
  });
  it.each([createObligationAction, updateObligationAction])(
    "checks ownership in %s",
    async (action) => {
      const before = structuredClone(store.table("obligations"));
      expect(await action(form({ accountId: "foreign-account" }))).toEqual({
        ok: false,
        error: "Conta de pagamento inválida.",
      });
      expect(await action(form({ categoryId: "foreign-category" }))).toEqual({
        ok: false,
        error: "Categoria inválida.",
      });
      expect(store.table("obligations")).toEqual(before);
      expect(revalidatePath).not.toHaveBeenCalled();
    },
  );
  it("updates fields and clears category", async () => {
    expect(
      await updateObligationAction(form({ categoryId: "", amount: "120,50" })),
    ).toEqual({ ok: true });
    expect(store.table("obligations")[0]).toMatchObject({
      amount_cents: 12050,
      account_id: "account-1",
      category_id: null,
    });
    expectRevalidation();
  });
  it("preserves omitted ownership fields", async () => {
    const fd = form();
    fd.delete("accountId");
    expect(await updateObligationAction(fd)).toEqual({ ok: true });
    expect(store.table("obligations")[0]).toMatchObject({
      account_id: "account-1",
      category_id: "category-1",
    });
  });
  it("returns repository validation copy", async () => {
    expect(await updateObligationAction(form({ dueDay: "29" }))).toEqual({
      ok: false,
      error: "O dia de vencimento precisa estar entre 1 e 28.",
    });
    expect(revalidatePath).not.toHaveBeenCalled();
  });
  it("cancels successfully", async () => {
    expect(await cancelObligationAction(form())).toEqual({ ok: true });
    expect(store.table("obligations")[0]?.status).toBe("canceled");
    expectRevalidation();
  });
  it("returns a failure for cancel without an id", async () => {
    expect(await cancelObligationAction(new FormData())).toEqual({
      ok: false,
      error: "Não foi possível salvar a obrigação.",
    });
    expect(revalidatePath).not.toHaveBeenCalled();
  });
  it("materializes payment successfully", async () => {
    expect(await markObligationPaidAction(form())).toEqual({ ok: true });
    expect(store.table("transactions")).toHaveLength(1);
    expectRevalidation();
  });
  it("returns payment parsing errors", async () => {
    expect(await markObligationPaidAction(form({ amount: "abc" }))).toEqual({
      ok: false,
      error: "Valor pago inválido — use por exemplo 710,44.",
    });
    expect(revalidatePath).not.toHaveBeenCalled();
  });
  it("hides actual RPC errors", async () => {
    expect(
      await markObligationPaidAction(form({ obligationId: "missing" })),
    ).toEqual({ ok: false, error: "Não foi possível salvar a obrigação." });
    expect(revalidatePath).not.toHaveBeenCalled();
  });
  describe.each([
    createObligationAction,
    updateObligationAction,
    cancelObligationAction,
    markObligationPaidAction,
    undoObligationPaymentAction,
  ])("error filtering: %s", (action) => {
    it("rethrows NEXT_REDIRECT without revalidating", async () => {
      let redirectError: unknown;
      try {
        redirect("/login");
      } catch (error) {
        redirectError = error;
      }
      expect(redirectError).toBeInstanceOf(Error);
      vi.mocked(requireAuthorizedUser).mockRejectedValueOnce(redirectError);

      await expect(action(form())).rejects.toBe(redirectError);
      expect(revalidatePath).not.toHaveBeenCalled();
    });

    it.each([
      new Error("updateObligation failed: private"),
      new Error("deleteObligationPayment lookup failed: private"),
      new Error("Missing required field: private"),
      new Error("No active household membership"),
      "unexpected",
    ])("hides internal error %s", async (error) => {
      vi.mocked(requireAuthorizedUser).mockRejectedValueOnce(error);
      expect(await action(form())).toEqual({
        ok: false,
        error:
          action === undoObligationPaymentAction
            ? "Não foi possível desfazer o pagamento."
            : "Não foi possível salvar a obrigação.",
      });
      expect(revalidatePath).not.toHaveBeenCalled();
    });
  });
});
