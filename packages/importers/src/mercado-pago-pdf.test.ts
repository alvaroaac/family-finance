import { describe, it, expect } from "vitest";

import { mercadoPagoPdfAdapter } from "./mercado-pago-pdf.js";
import { MERCADO_PAGO_FATURA_TEXT } from "./__fixtures__/mercado-pago-fatura.js";

describe("mercadoPagoPdfAdapter", () => {
  it("extracts the statement reference month from the emission date", async () => {
    const result = await mercadoPagoPdfAdapter.parse(MERCADO_PAGO_FATURA_TEXT);
    expect(result.statement?.referenceMonth).toBe("2026-06");
  });

  it("parses plain rows with card section last4 and inferred year", async () => {
    const { rows } = await mercadoPagoPdfAdapter.parse(MERCADO_PAGO_FATURA_TEXT);
    const plain = rows.find((r) => r.description.includes("SUPERMERCADO EXEMPLO") && r.cardLast4 === "3333");
    expect(plain).toMatchObject({
      occurredOn: "2026-05-30", // 30/05 on a June statement -> same year
      kind: "expense",
      cardLast4: "3333",
      installment: undefined,
    });
    expect(plain?.amount.cents).toBeGreaterThan(0);
  });

  it("captures Parcela X de Y as installment metadata (description without the marker)", async () => {
    const { rows } = await mercadoPagoPdfAdapter.parse(MERCADO_PAGO_FATURA_TEXT);
    const parcela = rows.find((r) => r.installment !== undefined && r.description.includes("MERCADOLIVRE"));
    expect(parcela?.installment).toEqual({ number: 14, count: 18 });
    expect(parcela?.description).not.toMatch(/parcela/i);
  });

  it("joins the international second line into the preceding row", async () => {
    const { rows } = await mercadoPagoPdfAdapter.parse(MERCADO_PAGO_FATURA_TEXT);
    const intl = rows.find((r) => r.description.includes("USD"));
    expect(intl).toBeDefined(); // R$ amount from the row, currency appended
    expect(intl?.description).toContain("USD 100.00");
    expect(intl?.kind).toBe("expense");
  });

  it("skips the payment block, per-card totals, and headers", async () => {
    const { rows } = await mercadoPagoPdfAdapter.parse(MERCADO_PAGO_FATURA_TEXT);
    expect(rows.some((r) => /pagamento da fatura/i.test(r.description))).toBe(false);
    expect(rows.some((r) => /^total/i.test(r.description))).toBe(false);
  });

  it("assigns the previous year to a row month greater than the statement month", async () => {
    const { rows } = await mercadoPagoPdfAdapter.parse(MERCADO_PAGO_FATURA_TEXT);
    // 15/11 on a 2026-06 statement -> November is after June -> previous year.
    const wrapped = rows.find((r) => r.occurredOn.startsWith("2025-"));
    expect(wrapped).toBeDefined();
    expect(wrapped?.occurredOn).toBe("2025-11-15");
  });

  it("returns reviewable errors (not throws) for unmappable transaction-like lines", async () => {
    const broken = `${MERCADO_PAGO_FATURA_TEXT} 31/02 LINHA QUEBRADA R$ 10,00`;
    const result = await mercadoPagoPdfAdapter.parse(broken);
    expect(result.errors.length).toBeGreaterThan(0);
  });
});
