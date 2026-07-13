import { describe, expect, it } from "vitest";

import {
  IMPORT_PREVIEW_VERSION,
  importPreviewSnapshotHash,
  signImportPreviewToken,
  verifyImportPreviewToken,
} from "./preview-token";

const secret = "preview-secret-that-is-at-least-32-bytes";
const snapshot = { rows: [{ line: 2, amount: 1200 }] };

function claims() {
  return {
    version: IMPORT_PREVIEW_VERSION,
    requestKey: "2a8777c9-e8bb-4d34-8be2-a295c212ed86",
    householdId: "household-1",
    userId: "user-1",
    issuedAt: 1_000,
    expiresAt: 1_801_000,
    source: "nubank" as const,
    fileFingerprint: "a".repeat(64),
    normalizedFingerprint: "b".repeat(64),
    parserVersion: "nubank-v1",
    snapshotHash: importPreviewSnapshotHash(snapshot),
  };
}

describe("import preview token", () => {
  it("round-trips an unchanged preview", () => {
    const token = signImportPreviewToken(claims(), secret);
    expect(
      verifyImportPreviewToken({ token, secret, snapshot, now: 2_000 }),
    ).toEqual(claims());
  });

  it("rejects client-side row changes", () => {
    const token = signImportPreviewToken(claims(), secret);
    expect(() =>
      verifyImportPreviewToken({
        token,
        secret,
        snapshot: { rows: [{ line: 2, amount: 9999 }] },
        now: 2_000,
      }),
    ).toThrow(/alterado/);
  });

  it("rejects expired and incorrectly signed tokens", () => {
    const token = signImportPreviewToken(claims(), secret);
    expect(() =>
      verifyImportPreviewToken({ token, secret, snapshot, now: 1_802_000 }),
    ).toThrow(/expirado/);
    expect(() =>
      verifyImportPreviewToken({
        token,
        secret: "x".repeat(32),
        snapshot,
        now: 2_000,
      }),
    ).toThrow(/inválido/);
  });
});
