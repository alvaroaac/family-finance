import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  authenticateMobile,
  MobileError,
  withMobileContext,
  getMobileContext,
  type MobileContext,
} from "./context";
import { saveMobileEntry } from "./entries";
const mocks = vi.hoisted(() => ({
  getUser: vi.fn(),
  members: vi.fn(),
  insert: vi.fn(),
  single: vi.fn(),
  installment: vi.fn(),
  createClient: vi.fn(),
}));
vi.mock("@supabase/supabase-js", () => ({ createClient: mocks.createClient }));
vi.mock("@family-finance/config", () => ({
  getSupabasePublicConfig: () => ({
    supabaseUrl: "https://example.supabase.co",
    supabaseAnonKey: "public",
  }),
  getAuthorizedEmails: () => ["member@example.com"],
  isEmailAuthorized: (e: string) => e === "member@example.com",
}));
const household = "11111111-1111-4111-8111-111111111111";
const user = "22222222-2222-4222-8222-222222222222";
const account = "33333333-3333-4333-8333-333333333333";
const card = "44444444-4444-4444-8444-444444444444";
vi.mock("@family-finance/db", async (original) => ({
  ...(await original<object>()),
  listAccounts: vi.fn(async () => [
    { id: "33333333-3333-4333-8333-333333333333" },
  ]),
  listCreditCards: vi.fn(async () => [
    { id: "44444444-4444-4444-8444-444444444444", closing_day: 20 },
  ]),
  listAllCategories: vi.fn(async () => []),
  listAllSubcategories: vi.fn(async () => []),
  listHouseholdMembers: vi.fn(async () => [
    { userId: "22222222-2222-4222-8222-222222222222" },
  ]),
  createInstallmentPurchase: mocks.installment,
}));
function client() {
  return {
    auth: { getUser: mocks.getUser },
    from: (table: string) => {
      if (table === "household_members")
        return { select: () => ({ eq: () => ({ eq: mocks.members }) }) };
      return {
        insert: mocks.insert,
        select: () => ({
          eq: () => ({ eq: () => ({ single: mocks.single }) }),
        }),
      };
    },
  };
}
const ctx = () =>
  ({
    client: client(),
    householdId: household,
    userId: user,
  }) as unknown as MobileContext;
const entry = () => ({
  id: "55555555-5555-4555-8555-555555555555",
  description: "Mercado",
  amountCents: 8500,
  kind: "expense",
  date: "2026-09-05",
  accountId: account,
  creditCardId: null,
  categoryId: null,
  subcategoryId: null,
  responsibleUserId: null,
  installmentCount: 1,
});
beforeEach(() => {
  vi.clearAllMocks();
  mocks.createClient.mockReturnValue(client());
  mocks.getUser.mockResolvedValue({
    data: { user: { id: user, email: "member@example.com" } },
    error: null,
  });
  mocks.members.mockResolvedValue({
    data: [{ household_id: household }],
    error: null,
  });
  mocks.insert.mockResolvedValue({ error: null });
});
afterEach(() => vi.restoreAllMocks());
describe("native authentication boundary", () => {
  it("rejects requests without bearer authentication before database access", async () => {
    await expect(
      authenticateMobile(new Request("https://casa.test/api")),
    ).rejects.toMatchObject({ status: 401 });
    expect(mocks.createClient).not.toHaveBeenCalled();
  });
  it("verifies the token and scopes the database client to it", async () => {
    const result = await authenticateMobile(
      new Request("https://casa.test/api", {
        headers: { Authorization: "Bearer sample-session" },
      }),
    );
    expect(result.householdId).toBe(household);
    expect(mocks.getUser).toHaveBeenCalledWith("sample-session");
    expect(
      mocks.createClient.mock.calls[0]?.[2].global.headers.Authorization,
    ).toBe("Bearer sample-session");
  });
  it("refuses a household outside the verified memberships", async () => {
    await expect(
      authenticateMobile(
        new Request("https://casa.test/api", {
          headers: { Authorization: "Bearer token", "x-household-id": "other" },
        }),
      ),
    ).rejects.toMatchObject({ status: 403 });
  });
  it("refuses expired tokens and users outside the allowlist", async () => {
    mocks.getUser.mockResolvedValueOnce({ data: { user: null }, error: {} });
    await expect(
      authenticateMobile(
        new Request("https://casa.test/api", {
          headers: { Authorization: "Bearer token" },
        }),
      ),
    ).rejects.toBeInstanceOf(MobileError);
    mocks.getUser.mockResolvedValueOnce({
      data: { user: { id: user, email: "other@example.com" } },
      error: null,
    });
    await expect(
      authenticateMobile(
        new Request("https://casa.test/api", {
          headers: { Authorization: "Bearer token" },
        }),
      ),
    ).rejects.toMatchObject({ status: 403 });
  });
  it("keeps overlapping request contexts isolated and clears them afterward", async () => {
    const a = ctx();
    const b = { ...ctx(), householdId: "other" };
    const values = await Promise.all([
      withMobileContext(a, async () => {
        await Promise.resolve();
        return getMobileContext()?.householdId;
      }),
      withMobileContext(b, async () => getMobileContext()?.householdId),
    ]);
    expect(values).toEqual([household, "other"]);
    expect(getMobileContext()).toBeUndefined();
  });
});
describe("native transaction retries", () => {
  it("writes the stable client ID with the authenticated household", async () => {
    await saveMobileEntry(ctx(), entry());
    expect(mocks.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        id: entry().id,
        household_id: household,
        amount_cents: 8500,
        created_by_user_id: user,
      }),
    );
  });
  it("treats a retry of the identical write as success", async () => {
    await saveMobileEntry(ctx(), entry());
    const row = mocks.insert.mock.calls[0]![0];
    mocks.insert.mockResolvedValue({ error: { code: "23505" } });
    mocks.single.mockResolvedValue({ data: row, error: null });
    await expect(saveMobileEntry(ctx(), entry())).resolves.toMatchObject({
      ok: true,
      id: entry().id,
    });
  });
  it("rejects reuse of a draft ID with different financial data", async () => {
    mocks.insert.mockResolvedValue({ error: { code: "23505" } });
    mocks.single.mockResolvedValue({
      data: { id: entry().id, amount_cents: 1 },
      error: null,
    });
    await expect(saveMobileEntry(ctx(), entry())).rejects.toMatchObject({
      status: 409,
    });
  });
  it("rejects cross-household instruments before any write", async () => {
    await expect(
      saveMobileEntry(ctx(), {
        ...entry(),
        accountId: "66666666-6666-4666-8666-666666666666",
      }),
    ).rejects.toMatchObject({ status: 422 });
    expect(mocks.insert).not.toHaveBeenCalled();
  });
  it("uses the existing atomic installment idempotency key", async () => {
    mocks.installment.mockResolvedValue({ group: { id: "group" } });
    await saveMobileEntry(ctx(), {
      ...entry(),
      accountId: null,
      creditCardId: card,
      installmentCount: 3,
    });
    expect(mocks.installment).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      { idempotencyKey: `mobile:${user}:${entry().id}` },
    );
    expect(mocks.insert).not.toHaveBeenCalled();
  });
  it("rejects an income paid to a credit card", async () => {
    await expect(
      saveMobileEntry(ctx(), {
        ...entry(),
        kind: "income",
        accountId: null,
        creditCardId: card,
      }),
    ).rejects.toThrow();
    expect(mocks.insert).not.toHaveBeenCalled();
  });
});
