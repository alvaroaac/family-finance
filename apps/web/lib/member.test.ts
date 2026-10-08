import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./supabase", () => ({
  createServerSupabaseClient: async () => {
    throw new Error("offline");
  },
}));

const { currentHouseholdOrFallback, FALLBACK_HOUSEHOLD } =
  await import("./member");

describe("currentHouseholdOrFallback", () => {
  afterEach(() => vi.restoreAllMocks());

  it("returns the fallback household and logs when the load fails", async () => {
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    await expect(currentHouseholdOrFallback()).resolves.toEqual(
      FALLBACK_HOUSEHOLD,
    );
    expect(error).toHaveBeenCalledTimes(1);
  });
});
