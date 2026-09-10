import { describe, expect, it } from "vitest";
import { nubankOfxAdapter, decodeOfx } from "./nubank-ofx.js";
import { nubankOfxFixture, ofxTransaction } from "./__fixtures__/nubank-ofx.js";
import { assignRowIdentities, claimIdentity } from "./identity.js";
import { findDuplicateCandidates } from "./dedupe.js";
import { splitFlatAndInstallmentRows } from "./reconstruction.js";

describe("Nubank OFX", () => {
  it("reads card transactions, preserving local dates, signs and scoped IDs", async () => {
    const parsed = await nubankOfxAdapter.parse(nubankOfxFixture());
    expect(parsed.errors).toEqual([]);
    expect(parsed.statement?.referenceMonth).toBe("2026-09");
    expect(parsed.rows[0]).toMatchObject({
      occurredOn: "2026-08-15",
      kind: "expense",
      amount: { cents: 2550 },
      providerTransactionId: JSON.stringify([
        "synthetic-card",
        "synthetic-1",
        "2026-08-15",
        "DEBIT",
        -2550,
      ]),
    });
  });

  it("keeps refunds and adjustments on the card and reports excluded payments", async () => {
    const rows = ["Estorno de compra", "Ajuste a credito", "Pagamento recebido"]
      .map((MEMO, i) =>
        ofxTransaction({
          MEMO,
          FITID: `credit-${i}`,
          TRNTYPE: "CREDIT",
          TRNAMT: "10.00",
        }),
      )
      .join("");
    const parsed = await nubankOfxAdapter.parse(nubankOfxFixture(rows));
    expect(parsed.errors).toEqual([]);
    expect(parsed.rows).toHaveLength(2);
    expect(
      parsed.rows.every(
        (row) => row.kind === "income" && row.amount.cents === 1000,
      ),
    ).toBe(true);
    expect(parsed.notices?.join(" ")).toContain("1 pagamento(s)");
  });

  it("reconstructs purchase and Pix installments without treating merchant numbers as parcels", async () => {
    const rows = [
      "Loja - Parcela 3/10",
      "Pix no Crédito - Pessoa teste - 2/3",
      "Loja 24/7",
    ]
      .map((MEMO, i) => ofxTransaction({ MEMO, FITID: `parcel-${i}` }))
      .join("");
    const parsed = await nubankOfxAdapter.parse(nubankOfxFixture(rows));
    expect(parsed.rows[0]).toMatchObject({
      description: "Loja",
      installment: { number: 3, count: 10 },
    });
    expect(parsed.rows[1]?.installment).toEqual({ number: 2, count: 3 });
    expect(parsed.rows[2]?.installment).toBeUndefined();
    const split = splitFlatAndInstallmentRows(
      parsed.rows,
      parsed.statement!.referenceMonth,
    );
    expect(split.flatRowIndices).toEqual([2]);
    expect(split.groups[0]).toMatchObject({
      purchaseMonth: "2026-07",
      installmentNumber: 3,
    });
  });

  it("uses FITID for repeat imports while keeping distinct purchases with identical descriptions", async () => {
    const first = await nubankOfxAdapter.parse(
      nubankOfxFixture(
        ofxTransaction() + ofxTransaction({ FITID: "synthetic-2" }),
      ),
    );
    expect(findDuplicateCandidates(first.rows)).toEqual([]);
    const next = await nubankOfxAdapter.parse(
      nubankOfxFixture(ofxTransaction({ MEMO: "Descricao atualizada" })),
    );
    const identity = (rows: typeof first.rows) =>
      assignRowIdentities(rows.map((row) => ({ source: "nubank-ofx", row })));
    expect(identity(first.rows)[0]?.baseIdentityHash).toBe(
      identity(next.rows)[0]?.baseIdentityHash,
    );
    const original = identity(first.rows)[0]!;
    expect(
      claimIdentity(original, { type: "credit_card", id: "a" })
        .claimFingerprint,
    ).not.toBe(
      claimIdentity(original, { type: "credit_card", id: "b" })
        .claimFingerprint,
    );
  });

  it("does not import duplicate IDs twice", async () => {
    const result = await nubankOfxAdapter.parse(
      nubankOfxFixture(ofxTransaction() + ofxTransaction()),
    );
    expect(result.rows).toHaveLength(1);
    expect(result.errors[0]?.message).toContain("FITID repetido");
  });

  it("preserves refunds and IOF sharing the purchase FITID", async () => {
    const result = await nubankOfxAdapter.parse(
      nubankOfxFixture(
        ofxTransaction() +
          ofxTransaction({
            TRNTYPE: "CREDIT",
            TRNAMT: "25.50",
            MEMO: "Estorno",
          }) +
          ofxTransaction({ TRNAMT: "-0.89", MEMO: "IOF da compra" }),
      ),
    );
    expect(result.errors).toEqual([]);
    expect(result.rows).toHaveLength(3);
    expect(findDuplicateCandidates(result.rows)).toEqual([]);
    expect(
      new Set(result.rows.map((row) => row.providerTransactionId)).size,
    ).toBe(3);
  });

  it.each([
    { TRNAMT: "12.00" },
    { TRNAMT: "-1.234" },
    { TRNAMT: "0" },
    { DTPOSTED: "20260230000000[-3:BRT]" },
    { FITID: "" },
    { MEMO: "Loja - Parcela 4/3" },
    { MEMO: "Loja - Parcela 0/3" },
  ])("isolates invalid rows: %j", async (invalid) => {
    const result = await nubankOfxAdapter.parse(
      nubankOfxFixture(
        ofxTransaction(invalid) + ofxTransaction({ FITID: "valid" }),
      ),
    );
    expect(result.rows).toHaveLength(1);
    expect(result.errors).toHaveLength(1);
  });

  it.each([
    (text: string) => text.replace("<CURDEF>BRL", "<CURDEF>USD"),
    (text: string) => text.replace("<FID>260", "<FID>999"),
    (text: string) => text.replaceAll("<CODE>0", "<CODE>2000"),
    (text: string) => text.replace("</OFX>", ""),
    (text: string) => text.replace("<DTEND>20260901", "<DTEND>20260101"),
  ])("rejects invalid statement envelopes", async (change) => {
    const result = await nubankOfxAdapter.parse(change(nubankOfxFixture()));
    expect(result.rows).toEqual([]);
    expect(result.errors).toHaveLength(1);
  });

  it("accepts SGML leaves without closing tags", async () => {
    const text = nubankOfxFixture().replace(
      /<\/(TRNTYPE|DTPOSTED|TRNAMT|FITID|MEMO|DTSTART|DTEND|CURDEF|ACCTID|CODE|SEVERITY|ORG|FID|BALAMT|DTASOF)>/g,
      "\n",
    );
    const result = await nubankOfxAdapter.parse(text);
    expect(result.errors).toEqual([]);
    expect(result.rows).toHaveLength(1);
  });

  it("decodes UTF-8 and Windows-1252 without losing accents", () => {
    const text = nubankOfxFixture(ofxTransaction({ MEMO: "Crédito" }));
    expect(decodeOfx(new TextEncoder().encode(text))).toBe(text);
    expect(
      decodeOfx(Uint8Array.from([...text].map((char) => char.charCodeAt(0)))),
    ).toBe(text);
  });
});
