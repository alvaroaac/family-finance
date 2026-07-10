import { describe, expect, it } from "vitest";

import {
  IMPORT_IDENTITY_VERSION,
  assignRowIdentities,
  canonicalJson,
  claimIdentity,
  normalizedRowsFingerprint,
  installmentGroupBaseIdentityHash,
  assignInstallmentGroupIdentities,
  rowBaseIdentityHash,
  sha256Hex,
  type NormalizedImportRow,
  type RowIdentityInput,
} from "./index.js";

function row(
  overrides: Partial<NormalizedImportRow> = {},
): NormalizedImportRow {
  return {
    sourceLine: 2,
    occurredOn: "2026-07-01",
    description: "Loja São João 12",
    amount: { currency: "BRL", cents: 1234 },
    kind: "expense",
    ...overrides,
  };
}

function input(overrides: Partial<RowIdentityInput> = {}): RowIdentityInput {
  return { source: "nubank", row: row(), ...overrides };
}

describe("stable import identity", () => {
  it("uses canonical sorted JSON and a golden SHA-256 implementation", () => {
    expect(canonicalJson({ z: 1, a: { y: 2, x: 3 } })).toBe(
      '{"a":{"x":3,"y":2},"z":1}',
    );
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("normalizes Unicode compatibility, case, and whitespace but preserves numbers", () => {
    const a = rowBaseIdentityHash(input());
    const b = rowBaseIdentityHash(
      input({ row: row({ description: "  LOJA  São\tJoão 12  " }) }),
    );
    const differentBranch = rowBaseIdentityHash(
      input({ row: row({ description: "Loja São João 13" }) }),
    );
    expect(a).toBe(b);
    expect(a).not.toBe(differentBranch);
  });

  it("excludes source line, category-like edits, and parser provenance from identity", () => {
    const a = rowBaseIdentityHash(input());
    const b = rowBaseIdentityHash(input({ row: row({ sourceLine: 999 }) }));
    expect(a).toBe(b);
  });

  it("uses provider ID as authoritative over mutable row fields", () => {
    const a = rowBaseIdentityHash(input({ providerTransactionId: "tx-42" }));
    const b = rowBaseIdentityHash(
      input({
        providerTransactionId: "tx-42",
        row: row({
          occurredOn: "2026-07-09",
          description: "Changed",
          amount: { currency: "BRL", cents: 1 },
        }),
      }),
    );
    expect(a).toBe(b);
    const repeated = assignRowIdentities([
      input({ providerTransactionId: "tx-42" }),
      input({ row: row({ providerTransactionId: "tx-42" }) }),
    ]);
    expect(repeated.map((identity) => identity.occurrenceNo)).toEqual([1, 1]);
  });

  it("includes Mercado Pago statement/card/installment identity metadata", () => {
    const mp = (last4: string) =>
      rowBaseIdentityHash({
        source: "mercado-pago",
        row: row({ cardLast4: last4, installment: { number: 2, count: 6 } }),
        sourceMetadata: { statementReferenceMonth: "2026-07" },
      });
    expect(mp("1234")).not.toBe(mp("5678"));
  });

  it("assigns deterministic occurrence slots to legitimate identical rows", () => {
    const identities = assignRowIdentities([
      input(),
      input(),
      input({ row: row({ amount: { currency: "BRL", cents: 500 } }) }),
    ]);
    expect(identities.map((item) => item.occurrenceNo)).toEqual([1, 2, 1]);
    expect(identities[0]?.identityVersion).toBe(IMPORT_IDENTITY_VERSION);
    expect(normalizedRowsFingerprint(identities)).toMatch(/^[a-f0-9]{64}$/);
  });

  it("scopes claim fingerprints to target instrument without changing row identity", () => {
    const identity = assignRowIdentities([input()])[0]!;
    const account = claimIdentity(identity, {
      type: "account",
      id: "account-1",
    });
    const card = claimIdentity(identity, { type: "credit_card", id: "card-1" });
    expect(account.baseIdentityHash).toBe(card.baseIdentityHash);
    expect(account.claimFingerprint).not.toBe(card.claimFingerprint);
  });

  it("identifies an installment purchase independently of observed statement parcel", () => {
    const purchase = {
      source: "mercado-pago" as const,
      description: "Notebook",
      installmentCount: 12,
      purchasedOn: "2026-01-10",
      cardLast4: "1234",
    };
    expect(installmentGroupBaseIdentityHash(purchase)).toBe(
      installmentGroupBaseIdentityHash({ ...purchase }),
    );
    expect(
      assignInstallmentGroupIdentities([purchase, purchase]).map(
        (identity) => identity.occurrenceNo,
      ),
    ).toEqual([1, 2]);
  });

  it("scopes the same inferred installment purchase to its selected card", () => {
    const identity = assignInstallmentGroupIdentities([
      {
        source: "mercado-pago",
        description: "Notebook",
        installmentCount: 10,
        purchasedOn: "2026-06-01",
      },
    ])[0]!;
    const cardA = claimIdentity(identity, {
      type: "credit_card",
      id: "card-a",
    });
    const cardB = claimIdentity(identity, {
      type: "credit_card",
      id: "card-b",
    });
    expect(cardA.claimFingerprint).not.toBe(cardB.claimFingerprint);
    expect(
      claimIdentity(identity, { type: "credit_card", id: "card-a" })
        .claimFingerprint,
    ).toBe(cardA.claimFingerprint);
  });
});
