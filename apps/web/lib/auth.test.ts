import { beforeEach, describe, expect, it, vi } from "vitest";

const { getUser, findHouseholdIdForCurrentUser } = vi.hoisted(() => ({
  getUser: vi.fn(),
  findHouseholdIdForCurrentUser: vi.fn(),
}));

vi.mock("./supabase", () => ({
  createServerSupabaseClient: async () => ({ auth: { getUser } }),
}));
vi.mock("@family-finance/db", () => ({ findHouseholdIdForCurrentUser }));

import { evaluateAccess, getAuthState, type AccessDecision } from "./auth";

describe("evaluateAccess", () => {
  it("requires sign-in without a session", () => {
    const decision: AccessDecision = evaluateAccess(null, null);
    expect(decision).toEqual({ status: "unauthenticated" });
  });

  it("requires sign-in without a usable email", () => {
    expect(evaluateAccess({ email: "   " }, "household-1")).toEqual({
      status: "unauthenticated",
    });
  });

  it("authorizes a user with an active membership", () => {
    expect(evaluateAccess({ email: " Member@Example.com " }, "household-1")).toEqual({
      status: "authorized",
      email: "member@example.com",
    });
  });

  it("denies a user without an active membership and keeps the email", () => {
    expect(evaluateAccess({ email: "member@example.com" }, null)).toEqual({
      status: "forbidden",
      email: "member@example.com",
    });
  });
});

describe("getAuthState", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not query membership without a session", async () => {
    getUser.mockResolvedValue({ data: { user: null }, error: null });
    expect(await getAuthState()).toEqual({ status: "unauthenticated" });
    expect(findHouseholdIdForCurrentUser).not.toHaveBeenCalled();
  });

  it("authorizes a session with an active membership", async () => {
    getUser.mockResolvedValue({ data: { user: { email: "member@example.com" } }, error: null });
    findHouseholdIdForCurrentUser.mockResolvedValue("household-1");
    expect(await getAuthState()).toEqual({
      status: "authorized",
      email: "member@example.com",
      householdId: "household-1",
    });
  });

  it("denies a session with no membership or only inactive membership", async () => {
    getUser.mockResolvedValue({ data: { user: { email: "member@example.com" } }, error: null });
    findHouseholdIdForCurrentUser.mockResolvedValue(null);
    expect(await getAuthState()).toEqual({
      status: "forbidden",
      email: "member@example.com",
    });
  });

  it("treats a membership database error as unauthenticated", async () => {
    getUser.mockResolvedValue({ data: { user: { email: "member@example.com" } }, error: null });
    findHouseholdIdForCurrentUser.mockRejectedValue(new Error("database unavailable"));
    expect(await getAuthState()).toEqual({ status: "unauthenticated" });
  });
});
