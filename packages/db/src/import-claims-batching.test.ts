import { expect, it, vi } from "vitest";
import {
  findImportItemClaims,
  type AppSupabaseClient,
} from "./repositories.js";

it("batches 132 fingerprints, deduplicates input, and collects all matches", async () => {
  const fingerprints = Array.from({ length: 132 }, (_, i) =>
    i.toString(16).padStart(64, "0"),
  );
  const query = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    in: vi.fn(async (_column: string, values: string[]) => ({
      data: values.map((base_fingerprint) => ({ base_fingerprint })),
      error: null,
    })),
  };
  const client = { from: vi.fn(() => query) } as unknown as AppSupabaseClient;
  const result = await findImportItemClaims(
    client,
    "household",
    "nubank_ofx",
    1,
    [...fingerprints, fingerprints[0]!],
  );
  expect(query.in.mock.calls.map((call) => call[1].length)).toEqual([
    50, 50, 32,
  ]);
  expect(result.map((claim) => claim.base_fingerprint)).toEqual(fingerprints);
  expect(query.eq).toHaveBeenCalledWith("household_id", "household");
});

it("fails the whole comparison when a later batch fails", async () => {
  const query = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    in: vi
      .fn()
      .mockResolvedValueOnce({ data: [], error: null })
      .mockResolvedValueOnce({ data: null, error: { message: "unavailable" } }),
  };
  await expect(
    findImportItemClaims(
      { from: () => query } as unknown as AppSupabaseClient,
      "household",
      "nubank_ofx",
      1,
      Array.from({ length: 51 }, (_, i) => String(i)),
    ),
  ).rejects.toThrow("findImportItemClaims failed: unavailable");
});

it("bounds concurrent batches and preserves input order when they finish out of order", async () => {
  const releases: (() => void)[] = [];
  let active = 0;
  let peak = 0;
  const query = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    in: vi.fn(
      (_column: string, values: string[]) =>
        new Promise((resolve) => {
          active++;
          peak = Math.max(peak, active);
          releases.push(() => {
            active--;
            resolve({
              data: values.map((base_fingerprint) => ({ base_fingerprint })),
              error: null,
            });
          });
        }),
    ),
  };
  const fingerprints = Array.from({ length: 251 }, (_, i) => String(i));
  const pending = findImportItemClaims(
    { from: () => query } as unknown as AppSupabaseClient,
    "household",
    "nubank_ofx",
    1,
    fingerprints,
  );
  expect(query.in).toHaveBeenCalledTimes(4);
  for (const release of releases.slice().reverse()) release();
  await vi.waitFor(() => expect(query.in).toHaveBeenCalledTimes(6));
  for (const release of releases.slice(4).reverse()) release();
  expect((await pending).map((claim) => claim.base_fingerprint)).toEqual(
    fingerprints,
  );
  expect(peak).toBe(4);
  expect(active).toBe(0);
});

it("settles in-flight requests and rejects without starting another window after a transport failure", async () => {
  let release!: () => void;
  const query = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    in: vi
      .fn()
      .mockRejectedValueOnce(new Error("network unavailable"))
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = () => resolve({ data: [], error: null });
          }),
      )
      .mockResolvedValue({ data: [], error: null }),
  };
  let settled = false;
  const pending = findImportItemClaims(
    { from: () => query } as unknown as AppSupabaseClient,
    "household",
    "nubank_ofx",
    1,
    Array.from({ length: 251 }, (_, i) => String(i)),
  );
  const rejection = expect(
    pending.finally(() => {
      settled = true;
    }),
  ).rejects.toThrow("network unavailable");
  await Promise.resolve();
  expect(settled).toBe(false);
  release();
  await rejection;
  expect(query.in).toHaveBeenCalledTimes(4);
});
