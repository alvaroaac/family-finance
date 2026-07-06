import { describe, it, expect } from "vitest";

import {
  minhasFinancasCsvAdapter,
  nubankCsvAdapter,
  buildImportPreview,
  findDuplicateCandidates,
  parseCsv,
  parseBrlToCents,
  type NormalizedImportRow,
  type ImportPreview,
} from "./index.js";

// ---------------------------------------------------------------------------
// Synthetic fixtures. These contain NO real personal financial data — they are
// invented values designed only to exercise the parsers and dedupe logic.
// ---------------------------------------------------------------------------

/**
 * Minhas Financas "modelo customizado" CSV. Columns (pt-BR header):
 * Data;Descrição;Categoria;Valor;Tipo
 * - Brazilian date (DD/MM/YYYY) and decimal comma.
 * - One unparseable row (bad date / empty value) to prove partial import.
 */
const MINHAS_FINANCAS_CSV = [
  "Data;Descrição;Categoria;Valor;Tipo",
  "15/01/2026;Mercado Teste;Alimentação;-150,90;Despesa",
  "16/01/2026;Salário Fake;Renda;3.000,00;Receita",
  "data-invalida;Linha Quebrada;;;Despesa",
  "17/01/2026;Mercado Teste;Alimentação;-150,90;Despesa",
].join("\n");

/**
 * Nubank CSV. Columns (English header, ISO date, dot decimals, signed value):
 * date,title,amount
 */
const NUBANK_CSV = [
  "date,title,amount",
  "2026-02-03,Padaria Sintetica,-25.50",
  "2026-02-04,Estorno Sintetico,30.00",
  '2026-02-05,"Loja, com virgula",-99.99',
].join("\n");

describe("parseCsv (hand-rolled)", () => {
  it("splits rows and fields and respects quoted commas", () => {
    const rows = parseCsv('a,b,c\n1,"x,y",3', ",");
    expect(rows).toEqual([
      ["a", "b", "c"],
      ["1", "x,y", "3"],
    ]);
  });

  it("supports semicolon delimiter and skips blank lines", () => {
    const rows = parseCsv("a;b\n\n1;2\n", ";");
    expect(rows).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });
});

describe("parseBrlToCents", () => {
  it("parses Brazilian decimal comma with thousands separator", () => {
    expect(parseBrlToCents("3.000,00")).toBe(300000);
    expect(parseBrlToCents("-150,90")).toBe(-15090);
  });

  it("parses dot-decimal values", () => {
    expect(parseBrlToCents("-25.50")).toBe(-2550);
    expect(parseBrlToCents("30.00")).toBe(3000);
  });

  it("returns null for non-numeric input", () => {
    expect(parseBrlToCents("")).toBeNull();
    expect(parseBrlToCents("abc")).toBeNull();
  });
});

describe("minhasFinancasCsvAdapter", () => {
  it("normalizes valid rows by date, description, value (cents), and type", async () => {
    const result = await minhasFinancasCsvAdapter.parse(MINHAS_FINANCAS_CSV);

    expect(result.source).toBe("minhas-financas");
    // 4 data rows: 3 valid, 1 unparseable.
    expect(result.rows).toHaveLength(3);
    expect(result.errors).toHaveLength(1);

    const [expense, income] = result.rows;
    expect(expense).toMatchObject<Partial<NormalizedImportRow>>({
      occurredOn: "2026-01-15",
      description: "Mercado Teste",
      kind: "expense",
    });
    expect(expense?.amount.cents).toBe(15090);
    expect(income).toMatchObject<Partial<NormalizedImportRow>>({
      occurredOn: "2026-01-16",
      description: "Salário Fake",
      kind: "income",
    });
    expect(income?.amount.cents).toBe(300000);
  });

  it("returns an unmapped/unparseable row as a reviewable error, not a throw", async () => {
    const result = await minhasFinancasCsvAdapter.parse(MINHAS_FINANCAS_CSV);
    const error = result.errors[0];
    expect(error).toBeDefined();
    expect(error?.sourceLine).toBe(4); // header is line 1
    expect(error?.message).toBeTruthy();
    // The raw cell values are not retained as a permanent record — only a
    // human-readable reason and the source line for operator reference.
    expect(typeof error?.message).toBe("string");
  });
});

describe("nubankCsvAdapter", () => {
  it("normalizes ISO date, dot decimals, signed value, and quoted commas", async () => {
    const result = await nubankCsvAdapter.parse(NUBANK_CSV);

    expect(result.source).toBe("nubank");
    expect(result.rows).toHaveLength(3);
    expect(result.errors).toHaveLength(0);

    const [a, b, c] = result.rows;
    expect(a).toMatchObject({
      occurredOn: "2026-02-03",
      description: "Padaria Sintetica",
      kind: "expense",
    });
    expect(a?.amount.cents).toBe(2550);
    expect(b?.kind).toBe("income");
    expect(b?.amount.cents).toBe(3000);
    // Quoted comma preserved in description.
    expect(c?.description).toBe("Loja, com virgula");
  });
});

describe("findDuplicateCandidates", () => {
  it("flags rows with the same date, amount, and normalized description", () => {
    const rows: NormalizedImportRow[] = [
      {
        sourceLine: 2,
        occurredOn: "2026-01-15",
        description: "Mercado Teste",
        amount: { currency: "BRL", cents: 15090 },
        kind: "expense",
      },
      {
        sourceLine: 5,
        occurredOn: "2026-01-15",
        description: "mercado teste",
        amount: { currency: "BRL", cents: 15090 },
        kind: "expense",
      },
      {
        sourceLine: 6,
        occurredOn: "2026-01-16",
        description: "Outra Coisa",
        amount: { currency: "BRL", cents: 1000 },
        kind: "expense",
      },
    ];

    const dupes = findDuplicateCandidates(rows);
    expect(dupes).toHaveLength(1);
    // The second occurrence is flagged against the first.
    expect(dupes[0]?.rowIndex).toBe(1);
    expect(dupes[0]?.duplicateOfIndex).toBe(0);
    expect(dupes[0]?.reason).toContain("mesma data");
  });
});

describe("buildImportPreview", () => {
  it("assembles rows, errors, and duplicate candidates into one preview", async () => {
    const { rows, errors } = await minhasFinancasCsvAdapter.parse(
      MINHAS_FINANCAS_CSV,
    );
    const preview: ImportPreview = buildImportPreview({
      source: "minhas-financas",
      rows,
      errors,
    });

    expect(preview.source).toBe("minhas-financas");
    expect(preview.totalRows).toBe(4); // 3 parsed + 1 error
    expect(preview.rows).toHaveLength(3);
    expect(preview.errors).toHaveLength(1);
    // Rows on 15/01 and 17/01 share desc+amount but differ by date, so they are
    // NOT duplicates; the fixture has no same-date duplicate within itself.
    expect(preview.duplicates).toHaveLength(0);
    expect(preview.duplicateCount).toBe(0);
    expect(preview.errorCount).toBe(1);
    expect(preview.importableCount).toBe(3);
  });

  it("counts a duplicate candidate when one is present", () => {
    const rows: NormalizedImportRow[] = [
      {
        sourceLine: 2,
        occurredOn: "2026-03-01",
        description: "Assinatura X",
        amount: { currency: "BRL", cents: 2990 },
        kind: "expense",
      },
      {
        sourceLine: 3,
        occurredOn: "2026-03-01",
        description: "Assinatura X",
        amount: { currency: "BRL", cents: 2990 },
        kind: "expense",
      },
    ];
    const preview = buildImportPreview({ source: "nubank", rows, errors: [] });
    expect(preview.duplicates).toHaveLength(1);
    expect(preview.duplicateCount).toBe(1);
    // Importable excludes flagged duplicates by default.
    expect(preview.importableCount).toBe(1);
  });
});
