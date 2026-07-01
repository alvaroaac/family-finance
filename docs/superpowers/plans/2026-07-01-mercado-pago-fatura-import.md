# Mercado Pago Fatura (PDF) Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Import a Mercado Pago credit-card fatura (PDF) through the existing `/imports` pipeline — flat charges become card transactions, parcela rows become editable inferred installment groups.

**Architecture:** A new pure `mercado-pago-pdf` text adapter + pure parcela-reconstruction module in `packages/importers` (PDF-free); `unpdf` text extraction happens only in the web `previewImport` action; persistence reuses the existing `confirm_import` and `create_installment_purchase` RPCs sequentially (no new SQL beyond one enum value). Spec: `docs/superpowers/specs/2026-06-30-mercado-pago-fatura-import-design.md` (as amended `db5b02d`).

**Tech Stack:** TypeScript NodeNext ESM workspaces, zod, vitest, Next.js App Router server actions, Supabase (local stack running), `unpdf`.

## Global Constraints

- `packages/importers` may import **only** `@family-finance/domain` + `zod` — never `unpdf`, never db/web clients. PDF bytes never reach this package.
- The PDF is transient: extracted in `previewImport`, then dropped. Never persisted, never sent to the client.
- All new fields on `NormalizedImportRow` / `AdapterResult` are **optional** — the two CSV adapters and their tests must keep passing unmodified.
- Intra-package relative imports use explicit `.js` extensions (NodeNext convention, see any existing file).
- The test fixture must be **anonymized**: no real cardholder name, no real card last-4s, no amounts/merchants that identify the holder.
- **Never run `supabase db reset`** — the running local stack holds live walkthrough data (auth user, membership, 3 contas, 1 cartão). Use `supabase migration up` for new migrations.
- Commit after each task with the message given in the task. Do NOT stage `thoughts/`, `memory/`, or `supabase/config.toml` (pre-existing dirty file).
- UI copy is pt-BR, matching existing strings on the imports page.
- Verify per task: `pnpm --filter <pkg> test` for the touched package, plus `pnpm typecheck` at the repo root.

---

## File map

| File | Task | Responsibility |
|---|---|---|
| `supabase/migrations/0006_mercado_pago_import_source.sql` | 1 | enum value `mercado_pago_pdf` |
| `packages/importers/src/__fixtures__/mercado-pago-fatura.ts` | 2 | anonymized extracted-text fixture (TS string export) |
| `packages/importers/src/types.ts` | 3 | `ImportSource` + optional row/statement fields |
| `packages/importers/src/mercado-pago-pdf.ts` | 3 | the adapter (pure text → rows) |
| `packages/importers/src/reconstruction.ts` | 4 | parcela → inferred groups; flat/parcela split; group-match predicate |
| `packages/importers/src/index.ts` | 3, 4 | exports + registry |
| `packages/db/src/repositories.ts` | 5 | `listInstallmentGroupsByHousehold`, `findCardChargesBetween` |
| `apps/web/app/(app)/imports/actions.ts` | 6, 7 | MP preview branch (unpdf + dedupe), MP confirm branch |
| `apps/web/app/(app)/imports/page.tsx` | 8 | source option, card selector, parcelamentos panel |

---

### Task 1: Migration — `mercado_pago_pdf` enum value

**Files:**
- Create: `supabase/migrations/0006_mercado_pago_import_source.sql`

**Interfaces:**
- Produces: DB enum `import_source` accepts `'mercado_pago_pdf'` (Task 6/7's `SOURCE_TO_DB` mapping casts to it inside the `confirm_import` RPC).

- [ ] **Step 1: Write the migration**

```sql
-- 0006_mercado_pago_import_source.sql
-- New import source: Mercado Pago credit-card fatura (PDF). The web action maps
-- the logical source "mercado-pago" to this enum value; confirm_import casts
-- batch_payload->>'source' to import_source, so the value must exist first.
-- ALTER TYPE ... ADD VALUE is safe inside a single-statement migration on PG 12+
-- (the new value just cannot be used in the same transaction that adds it).
alter type import_source add value if not exists 'mercado_pago_pdf';
```

- [ ] **Step 2: Apply to the running local stack (NOT db reset)**

Run: `cd /Users/alvarocarvalho/desenv/personal/alvaro-e-karol/family-finance && supabase migration up`
Expected: `Applying migration 0006_mercado_pago_import_source.sql...` then success.

- [ ] **Step 3: Verify the enum value exists**

Run: `docker exec supabase_db_family-finance psql -U postgres -d postgres -tAc "select unnest(enum_range(null::import_source))::text"`
(If the container name differs, find it with `docker ps --format '{{.Names}}' | grep supabase_db`.)
Expected output includes: `mercado_pago_pdf`

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/0006_mercado_pago_import_source.sql
git commit -m "feat(db): add mercado_pago_pdf import source enum value"
```

---

### Task 2: Anonymized fatura text fixture (from the real PDF)

**Files:**
- Create: `packages/importers/src/__fixtures__/mercado-pago-fatura.ts`
- Scratch (not committed): extraction script in the session scratchpad

**Interfaces:**
- Produces: `export const MERCADO_PAGO_FATURA_TEXT: string` — the exact text shape `unpdf` produces for a real fatura, anonymized. Task 3's adapter regexes are written against THIS text, so its line shapes are load-bearing.

**Why a real extraction first:** the spec documents the fatura's *visual* layout; `unpdf`'s text stream may join/split/reorder lines differently. Extract the real PDF first, then anonymize — do not invent the fixture from the spec.

- [ ] **Step 1: Install unpdf into apps/web (needed later anyway; use it from the scratch script via the workspace)**

Run: `pnpm add unpdf --filter @family-finance/web`
Expected: lockfile updated, install succeeds.

- [ ] **Step 2: Extract the real fatura text to the scratchpad**

Write this scratch script (adjust scratchpad path to the session's) and run it with `node`:

```js
// scratch/extract-fatura.mjs
import { readFile, writeFile } from "node:fs/promises";
import { extractText } from "unpdf";

const pdfPath = process.env.HOME +
  "/Documents/Personal/Financeiro e Notas Fiscais/credit cards/credit-card-mp-statement.pdf";
const data = new Uint8Array(await readFile(pdfPath));
const { text } = await extractText(data, { mergePages: true });
await writeFile("fatura-raw.txt", Array.isArray(text) ? text.join("\n") : text);
console.log("done, lines:", (Array.isArray(text) ? text.join("\n") : text).split("\n").length);
```

Run from `apps/web` (so `unpdf` resolves): `cd apps/web && node <scratchpad>/extract-fatura.mjs`
Expected: `fatura-raw.txt` written in the scratchpad; inspect it and confirm the shapes the spec describes are findable: card section headers (`Cartão Visa [****...7720]` or similar), `DD/MM <desc> R$ <valor>` rows, `Parcela X de Y`, the `Movimentações na fatura` block, `Emitida em: 30/06/2026`, `Consumos de 30/05 a 29/06`. **Record the exact observed line shapes** — if they differ from the spec's visual rendering (extra spaces, columns joined, etc.), Task 3's regexes must match the OBSERVED shapes.

- [ ] **Step 3: Write the anonymized fixture**

Create `packages/importers/src/__fixtures__/mercado-pago-fatura.ts` preserving the REAL extracted structure (line order, separators, headers, totals block, payment block) but with: fake cardholder name, fake last-4s (e.g. `1111`/`2222`/`3333`), rounded fake amounts, generic merchants (`SUPERMERCADO EXEMPLO`, `MERCADOLIVRE*LOJA` etc.). Keep at least:
- 2+ card sections; 3+ plain rows; 2+ `Parcela X de Y` rows (one with X>1 whose purchase month crosses the year boundary, e.g. `Parcela 14 de 18`); 1 international 2-line entry; the payment block with 1 `Pagamento da fatura` row; per-card `Total` lines; `Emitida em:` + `Consumos de ... a ...` header lines.

```ts
/**
 * Anonymized Mercado Pago fatura text, structurally identical to what
 * `unpdf.extractText(..., { mergePages: true })` produces for a real fatura
 * (June/2026 statement). Amounts, names, merchants, and card digits are fake.
 */
export const MERCADO_PAGO_FATURA_TEXT: string = `...anonymized real extraction...`;
```

- [ ] **Step 4: Delete the raw extraction from the scratchpad**

Run: `rm <scratchpad>/fatura-raw.txt`
(Privacy: the raw text carries the holder's name + limits; it must not outlive this task.)

- [ ] **Step 5: Commit**

```bash
git add packages/importers/src/__fixtures__/mercado-pago-fatura.ts apps/web/package.json pnpm-lock.yaml
git commit -m "feat(importers): add anonymized Mercado Pago fatura fixture + unpdf dep"
```

---

### Task 3: Importer types + `mercado-pago-pdf` adapter

**Files:**
- Modify: `packages/importers/src/types.ts`
- Create: `packages/importers/src/mercado-pago-pdf.ts`
- Modify: `packages/importers/src/index.ts`
- Test: `packages/importers/src/mercado-pago-pdf.test.ts`

**Interfaces:**
- Consumes: `MERCADO_PAGO_FATURA_TEXT` (Task 2); `parseBrlToCents`, `normalizeDescription`, `moneyFromSignedCents` from `./normalize.js`.
- Produces:
  - `ImportSource = "minhas-financas" | "nubank" | "mercado-pago"`
  - `NormalizedImportRow` gains `installment?: { number: number; count: number }` and `cardLast4?: string`
  - `AdapterResult` gains `statement?: StatementInfo` with `StatementInfo = { referenceMonth: string }` (YYYY-MM from `Emitida em:`)
  - `export const mercadoPagoPdfAdapter: ImportAdapter` registered in `importAdapters`

**IMPORTANT:** the regexes below assume the spec's visual layout; adjust them to the exact line shapes observed in the Task 2 extraction. Behavior contracts (what is a row, what is skipped, year inference) are fixed; the lexical patterns are not.

- [ ] **Step 1: Extend types**

In `packages/importers/src/types.ts`:

```ts
export type ImportSource = "minhas-financas" | "nubank" | "mercado-pago";
```

Add to `NormalizedImportRow` (after `sourceCategory?`):

```ts
  /**
   * Present when the source row is one parcel of an installment purchase
   * ("Parcela X de Y" on a fatura). Flat/à-vista rows omit it.
   */
  installment?: { number: number; count: number };
  /** Card last-4 of the fatura section this row came from, when known. */
  cardLast4?: string;
```

Add after `AdapterResult`'s current fields (as optional):

```ts
/** Statement-level metadata a fatura-style source can provide. */
export type StatementInfo = {
  /** YYYY-MM the statement was emitted in — anchors year inference. */
  referenceMonth: string;
};
```

and in `AdapterResult`: `statement?: StatementInfo;`

- [ ] **Step 2: Write the failing tests**

`packages/importers/src/mercado-pago-pdf.test.ts` (adjust expected amounts/descriptions to the Task 2 fixture's fake values — the ASSERTION SHAPES are the contract):

```ts
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
    const plain = rows.find((r) => r.description.includes("SUPERMERCADO EXEMPLO"));
    expect(plain).toMatchObject({
      occurredOn: "2026-05-30",       // 30/05 on a June statement -> same year
      kind: "expense",
      cardLast4: "1111",
      installment: undefined,
    });
    expect(plain?.amount.cents).toBeGreaterThan(0);
  });

  it("captures Parcela X de Y as installment metadata (description without the marker)", async () => {
    const { rows } = await mercadoPagoPdfAdapter.parse(MERCADO_PAGO_FATURA_TEXT);
    const parcela = rows.find((r) => r.installment !== undefined);
    expect(parcela?.installment).toEqual({ number: 14, count: 18 });
    expect(parcela?.description).not.toMatch(/parcela/i);
  });

  it("joins the international second line into the preceding row", async () => {
    const { rows } = await mercadoPagoPdfAdapter.parse(MERCADO_PAGO_FATURA_TEXT);
    const intl = rows.find((r) => r.description.includes("USD"));
    expect(intl).toBeDefined();          // R$ amount from line 1, currency appended
    expect(intl?.kind).toBe("expense");
  });

  it("skips the payment block, per-card totals, and headers", async () => {
    const { rows } = await mercadoPagoPdfAdapter.parse(MERCADO_PAGO_FATURA_TEXT);
    expect(rows.some((r) => /pagamento da fatura/i.test(r.description))).toBe(false);
    expect(rows.some((r) => /^total/i.test(r.description))).toBe(false);
  });

  it("assigns the previous year to a row month greater than the statement month", async () => {
    const { rows } = await mercadoPagoPdfAdapter.parse(MERCADO_PAGO_FATURA_TEXT);
    // Fixture must contain a 12/xx or 07..12/xx row; on a 2026-06 statement it is 2025.
    const wrapped = rows.find((r) => r.occurredOn.startsWith("2025-"));
    expect(wrapped).toBeDefined();
  });

  it("returns reviewable errors (not throws) for unmappable transaction-like lines", async () => {
    const broken = MERCADO_PAGO_FATURA_TEXT + "\n31/02 LINHA QUEBRADA R$ abc";
    const result = await mercadoPagoPdfAdapter.parse(broken);
    expect(result.errors.length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 3: Run tests — expect failure**

Run: `pnpm --filter @family-finance/importers test`
Expected: FAIL — `mercado-pago-pdf.js` not found.

- [ ] **Step 4: Implement the adapter**

`packages/importers/src/mercado-pago-pdf.ts` (adjust regexes to the real fixture shapes):

```ts
/**
 * Mercado Pago fatura (PDF) adapter. Input is the ALREADY-EXTRACTED text of the
 * statement (extraction happens in the web layer via unpdf — this package never
 * sees PDF bytes). Statement layout, not tabular:
 *
 *   Cartão Visa [************1111]     <- section header carries the last4
 *   30/05 SUPERMERCADO EXEMPLO R$ 412,10
 *   02/05 MERCADOLIVRE*LOJA Parcela 14 de 18 R$ 416,61
 *   02/06 Compra internacional em SERVICO X R$ 569,25
 *   BRL 0 = USD 1 = R$ 0 BRL 550.00    <- joined into the preceding row
 *   Total R$ 1.234,56                  <- skipped
 *   Movimentações na fatura            <- block skipped until next card section
 *   03/06 Pagamento da fatura de junho/2026 R$ 5.197,69
 *
 * Dates carry no year; the year is inferred from the emission date
 * ("Emitida em: 30/06/2026"): a row month GREATER than the statement month
 * belongs to the previous year.
 */

import {
  parseBrlToCents,
  normalizeDescription,
  moneyFromSignedCents,
} from "./normalize.js";
import type {
  ImportAdapter,
  AdapterResult,
  NormalizedImportRow,
  ImportRowError,
  StatementInfo,
} from "./types.js";

const EMITTED_RE = /Emitida em:?\s*(\d{2})\/(\d{2})\/(\d{4})/;
const CARD_SECTION_RE = /Cart[ãa]o\s+\S+\s+\[\*+(\d{4})\]/;
const PAYMENT_BLOCK_RE = /Movimenta[çc][õo]es na fatura/i;
const TOTAL_LINE_RE = /^\s*Total\b/i;
const ROW_RE = /^(\d{2})\/(\d{2})\s+(.+?)\s+R\$\s*([\d.,]+)\s*$/;
const PARCELA_RE = /\s*Parcela\s+(\d+)\s+de\s+(\d+)\s*/i;
const INTL_CONTINUATION_RE = /=\s*R\$.*?\b([A-Z]{3})\s+([\d.,]+)\s*$/;

function isRealDate(year: number, month: number, day: number): boolean {
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

/** Row year: statement year, unless the row month is AFTER the closing month. */
function inferYear(rowMonth: number, refYear: number, refMonth: number): number {
  return rowMonth > refMonth ? refYear - 1 : refYear;
}

async function parse(fileText: string): Promise<AdapterResult> {
  const rows: NormalizedImportRow[] = [];
  const errors: ImportRowError[] = [];
  const lines = fileText.split(/\r?\n/);

  const emitted = EMITTED_RE.exec(fileText);
  if (emitted === null) {
    return {
      source: "mercado-pago",
      rows,
      errors: [
        {
          sourceLine: 1,
          message:
            "Fatura não reconhecida: data de emissão (\"Emitida em: DD/MM/AAAA\") não encontrada.",
        },
      ],
    };
  }
  const refMonth = Number.parseInt(emitted[2] as string, 10);
  const refYear = Number.parseInt(emitted[3] as string, 10);
  const statement: StatementInfo = {
    referenceMonth: `${refYear}-${String(refMonth).padStart(2, "0")}`,
  };

  let currentLast4: string | undefined;
  let inPaymentBlock = false;

  for (let i = 0; i < lines.length; i += 1) {
    const line = (lines[i] as string).trim();
    const sourceLine = i + 1;
    if (line.length === 0) continue;

    const section = CARD_SECTION_RE.exec(line);
    if (section !== null) {
      currentLast4 = section[1];
      inPaymentBlock = false;
      continue;
    }
    if (PAYMENT_BLOCK_RE.test(line)) {
      inPaymentBlock = true;
      continue;
    }
    if (inPaymentBlock) continue;
    if (TOTAL_LINE_RE.test(line)) continue;

    // International continuation: enrich the PREVIOUS row's description.
    const intl = INTL_CONTINUATION_RE.exec(line);
    if (intl !== null && rows.length > 0) {
      const prev = rows[rows.length - 1] as NormalizedImportRow;
      prev.description = `${prev.description} (${intl[1]} ${intl[2]})`;
      continue;
    }

    const match = ROW_RE.exec(line);
    if (match === null) {
      // Any other line (page headers, limits, addresses) is layout noise —
      // skipped silently. Only transaction-LIKE lines that fail to parse
      // become errors (handled below via the amount/date checks).
      continue;
    }

    const day = Number.parseInt(match[1] as string, 10);
    const month = Number.parseInt(match[2] as string, 10);
    let descriptionRaw = match[3] as string;
    const rawValue = match[4] as string;

    let installment: { number: number; count: number } | undefined;
    const parcela = PARCELA_RE.exec(descriptionRaw);
    if (parcela !== null) {
      installment = {
        number: Number.parseInt(parcela[1] as string, 10),
        count: Number.parseInt(parcela[2] as string, 10),
      };
      descriptionRaw = descriptionRaw.replace(PARCELA_RE, " ");
    }

    const year = inferYear(month, refYear, refMonth);
    if (!isRealDate(year, month, day)) {
      errors.push({
        sourceLine,
        message: `Data inválida na linha ${sourceLine} (${match[1]}/${match[2]}).`,
      });
      continue;
    }
    const occurredOn = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;

    const cents = parseBrlToCents(rawValue);
    if (cents === null) {
      errors.push({
        sourceLine,
        message: `Valor inválido na linha ${sourceLine}.`,
      });
      continue;
    }
    // Fatura consumo rows are expenses; the sign is not carried on the row.
    const money = moneyFromSignedCents(-Math.abs(cents));
    if (money === null) {
      errors.push({
        sourceLine,
        message: `Valor zero não pode ser importado (linha ${sourceLine}).`,
      });
      continue;
    }

    const description = normalizeDescription(descriptionRaw);
    rows.push({
      sourceLine,
      occurredOn,
      description: description.length > 0 ? description : "(sem descrição)",
      amount: money.amount,
      kind: money.kind,
      installment,
      cardLast4: currentLast4,
    });
  }

  return { source: "mercado-pago", rows, errors, statement };
}

export const mercadoPagoPdfAdapter: ImportAdapter = {
  source: "mercado-pago",
  parse,
};
```

Note: with the sample-appended `31/02 ... R$ abc` line, ROW_RE won't match `R$ abc` — if the error-path test fails because of that, append a line the regex DOES match but with an invalid date (`31/02 LINHA QUEBRADA R$ 10,00`) in the test instead. Invalid-date and invalid-value paths must both be covered.

- [ ] **Step 5: Register + export**

In `packages/importers/src/index.ts`: export `mercadoPagoPdfAdapter` and `StatementInfo` type, and add to the registry:

```ts
export { mercadoPagoPdfAdapter } from "./mercado-pago-pdf.js";
// ...
export const importAdapters: Record<ImportSource, ImportAdapter> = {
  "minhas-financas": minhasFinancasCsvAdapter,
  nubank: nubankCsvAdapter,
  "mercado-pago": mercadoPagoPdfAdapter,
};
```

(also add the corresponding `import` statement next to the existing two, and `StatementInfo` to the `export type` list from `./types.js`).

- [ ] **Step 6: Run tests — expect pass, including the untouched CSV suites**

Run: `pnpm --filter @family-finance/importers test`
Expected: PASS — new tests + all pre-existing importer tests.

- [ ] **Step 7: Typecheck the workspace**

Run: `pnpm typecheck`
Expected: PASS 12/12 (the optional fields must not break db/web/bot).

- [ ] **Step 8: Commit**

```bash
git add packages/importers/src
git commit -m "feat(importers): add Mercado Pago fatura PDF-text adapter"
```

---

### Task 4: Parcela reconstruction + group-match predicate (pure)

**Files:**
- Create: `packages/importers/src/reconstruction.ts`
- Modify: `packages/importers/src/index.ts`
- Test: `packages/importers/src/reconstruction.test.ts`

**Interfaces:**
- Consumes: `NormalizedImportRow` (with `installment`) from Task 3; `normalizeDescription` from `./normalize.js`.
- Produces (used by Task 6's preview and Task 7's confirm):

```ts
export type InferredInstallmentGroup = {
  /** Index into the AdapterResult rows array of the parcela row. */
  rowIndex: number;
  sourceLine: number;
  description: string;
  cardLast4?: string;
  installmentNumber: number;   // X
  installmentCount: number;    // Y
  perInstallmentCents: number;
  estimatedTotalCents: number; // per × Y
  purchaseMonth: string;       // YYYY-MM = referenceMonth − (X−1)
  purchasedOn: string;         // YYYY-MM-DD = purchaseMonth + row day (clamped)
};

export function splitFlatAndInstallmentRows(
  rows: NormalizedImportRow[],
  referenceMonth: string,
): { flatRowIndices: number[]; groups: InferredInstallmentGroup[] };

export type ExistingGroupSummary = {
  description: string;
  installmentCount: number;
  purchasedOn: string; // ISO date from the DB row
};

export function matchExistingGroup(
  inferred: InferredInstallmentGroup,
  existing: ExistingGroupSummary[],
): number | null; // index into existing, or null
```

- [ ] **Step 1: Write the failing tests**

`packages/importers/src/reconstruction.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { brl } from "@family-finance/domain";
import {
  splitFlatAndInstallmentRows,
  matchExistingGroup,
} from "./reconstruction.js";
import type { NormalizedImportRow } from "./types.js";

function row(over: Partial<NormalizedImportRow>): NormalizedImportRow {
  return {
    sourceLine: 2,
    occurredOn: "2026-05-30",
    description: "LOJA",
    amount: brl(41661),
    kind: "expense",
    ...over,
  };
}

describe("splitFlatAndInstallmentRows", () => {
  it("keeps flat rows and converts parcela rows into inferred groups", () => {
    const rows = [
      row({ description: "SUPERMERCADO" }),
      row({
        description: "MERCADOLIVRE*LOJA",
        occurredOn: "2026-05-02",
        installment: { number: 14, count: 18 },
      }),
    ];
    const { flatRowIndices, groups } = splitFlatAndInstallmentRows(rows, "2026-06");
    expect(flatRowIndices).toEqual([0]);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      rowIndex: 1,
      installmentNumber: 14,
      installmentCount: 18,
      perInstallmentCents: 41661,
      estimatedTotalCents: 41661 * 18,
      purchaseMonth: "2025-05", // 2026-06 − 13 months
      purchasedOn: "2025-05-02", // row day 02 carried into the inferred month
    });
  });

  it("clamps the purchase day to the inferred month's length", () => {
    const rows = [
      row({
        occurredOn: "2026-05-31",
        installment: { number: 4, count: 6 },
      }),
    ];
    const { groups } = splitFlatAndInstallmentRows(rows, "2026-05");
    // 2026-05 − 3 = 2026-02; day 31 -> 28
    expect(groups[0]?.purchasedOn).toBe("2026-02-28");
  });

  it("parcela 1 de N stays in the statement month", () => {
    const rows = [
      row({ occurredOn: "2026-06-10", installment: { number: 1, count: 3 } }),
    ];
    const { groups } = splitFlatAndInstallmentRows(rows, "2026-06");
    expect(groups[0]?.purchaseMonth).toBe("2026-06");
    expect(groups[0]?.purchasedOn).toBe("2026-06-10");
  });
});

describe("matchExistingGroup", () => {
  const inferred = {
    rowIndex: 0,
    sourceLine: 2,
    description: "MERCADOLIVRE*LOJA",
    installmentNumber: 14,
    installmentCount: 18,
    perInstallmentCents: 41661,
    estimatedTotalCents: 749898,
    purchaseMonth: "2025-05",
    purchasedOn: "2025-05-02",
  };

  it("matches on normalized description + count + purchase month", () => {
    const existing = [
      { description: "  mercadolivre*loja ", installmentCount: 18, purchasedOn: "2025-05-15" },
    ];
    expect(matchExistingGroup(inferred, existing)).toBe(0);
  });

  it("returns null when count or month differ", () => {
    expect(
      matchExistingGroup(inferred, [
        { description: "MERCADOLIVRE*LOJA", installmentCount: 12, purchasedOn: "2025-05-02" },
        { description: "MERCADOLIVRE*LOJA", installmentCount: 18, purchasedOn: "2025-06-02" },
      ]),
    ).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests — expect failure**

Run: `pnpm --filter @family-finance/importers test`
Expected: FAIL — `reconstruction.js` not found.

- [ ] **Step 3: Implement**

`packages/importers/src/reconstruction.ts`:

```ts
/**
 * Parcela reconstruction: turn "Parcela X de Y" fatura rows into inferred,
 * user-editable installment-group previews, and split them away from the flat
 * (à-vista) rows that import as plain card transactions.
 *
 * Inference (spec §3): the fatura shows only THIS month's parcel, so
 *   count            = Y
 *   perInstallment   = the row amount
 *   estimatedTotal   = per × Y            (exact when parcels are equal)
 *   purchaseMonth    = referenceMonth − (X − 1)
 *   purchasedOn      = purchaseMonth + the row's day-of-month (the parcela
 *                      row's DD/MM is the original purchase date), clamped to
 *                      the month length. Everything is editable downstream.
 *
 * Pure: no I/O, no db types — matching runs on plain summaries the caller maps
 * from its rows.
 */

import type { NormalizedImportRow } from "./types.js";
import { normalizeDescription } from "./normalize.js";

export type InferredInstallmentGroup = {
  rowIndex: number;
  sourceLine: number;
  description: string;
  cardLast4?: string;
  installmentNumber: number;
  installmentCount: number;
  perInstallmentCents: number;
  estimatedTotalCents: number;
  purchaseMonth: string;
  purchasedOn: string;
};

export type ExistingGroupSummary = {
  description: string;
  installmentCount: number;
  purchasedOn: string;
};

/** YYYY-MM minus `offset` whole months, stable across year boundaries. */
function subtractMonths(referenceMonth: string, offset: number): string {
  const [y, m] = referenceMonth.split("-").map((p) => Number.parseInt(p, 10));
  const zeroBased = ((y as number) * 12 + ((m as number) - 1)) - offset;
  const year = Math.floor(zeroBased / 12);
  const month = (zeroBased % 12) + 1;
  return `${year}-${String(month).padStart(2, "0")}`;
}

/** Last day of a YYYY-MM month. */
function lastDayOfMonth(month: string): number {
  const [y, m] = month.split("-").map((p) => Number.parseInt(p, 10));
  return new Date(Date.UTC(y as number, m as number, 0)).getUTCDate();
}

export function splitFlatAndInstallmentRows(
  rows: NormalizedImportRow[],
  referenceMonth: string,
): { flatRowIndices: number[]; groups: InferredInstallmentGroup[] } {
  const flatRowIndices: number[] = [];
  const groups: InferredInstallmentGroup[] = [];

  rows.forEach((row, rowIndex) => {
    if (row.installment === undefined) {
      flatRowIndices.push(rowIndex);
      return;
    }
    const { number, count } = row.installment;
    const purchaseMonth = subtractMonths(referenceMonth, number - 1);
    const rowDay = Number.parseInt(row.occurredOn.slice(8, 10), 10);
    const day = Math.min(rowDay, lastDayOfMonth(purchaseMonth));
    groups.push({
      rowIndex,
      sourceLine: row.sourceLine,
      description: row.description,
      cardLast4: row.cardLast4,
      installmentNumber: number,
      installmentCount: count,
      perInstallmentCents: row.amount.cents,
      estimatedTotalCents: row.amount.cents * count,
      purchaseMonth,
      purchasedOn: `${purchaseMonth}-${String(day).padStart(2, "0")}`,
    });
  });

  return { flatRowIndices, groups };
}

/**
 * Loose dedupe match (spec §4): normalized description + installment count +
 * purchase MONTH (not day — the inferred day is an estimate). Returns the index
 * of the first matching existing group, or null.
 */
export function matchExistingGroup(
  inferred: InferredInstallmentGroup,
  existing: ExistingGroupSummary[],
): number | null {
  const wanted = normalizeDescription(inferred.description).toLowerCase();
  const index = existing.findIndex(
    (g) =>
      normalizeDescription(g.description).toLowerCase() === wanted &&
      g.installmentCount === inferred.installmentCount &&
      g.purchasedOn.slice(0, 7) === inferred.purchaseMonth,
  );
  return index === -1 ? null : index;
}
```

- [ ] **Step 4: Export from the package index**

In `packages/importers/src/index.ts` add:

```ts
export {
  splitFlatAndInstallmentRows,
  matchExistingGroup,
} from "./reconstruction.js";
export type {
  InferredInstallmentGroup,
  ExistingGroupSummary,
} from "./reconstruction.js";
```

- [ ] **Step 5: Run tests — expect pass**

Run: `pnpm --filter @family-finance/importers test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/importers/src
git commit -m "feat(importers): reconstruct installment groups from parcela rows"
```

---

### Task 5: db queries for dedupe

**Files:**
- Modify: `packages/db/src/repositories.ts` (add near `listCreditCards`, ~line 1014)
- Modify: `packages/db/src/index.ts` (re-export, follow the file's existing pattern)

**Interfaces:**
- Consumes: `AppSupabaseClient`, `InstallmentGroupRow` (existing types in `packages/db`).
- Produces (used by Task 6):

```ts
export async function listInstallmentGroupsByHousehold(
  client: AppSupabaseClient,
  householdId: string,
): Promise<InstallmentGroupRow[]>;

export type CardChargeSummary = {
  occurred_on: string;
  amount_cents: number;
  kind: string;
  description: string;
};

export async function findCardChargesBetween(
  client: AppSupabaseClient,
  householdId: string,
  startDate: string, // ISO inclusive
  endDate: string,   // ISO inclusive
): Promise<CardChargeSummary[]>;
```

**Design note (small, deliberate deviation from spec §4 wording):** both queries scope by HOUSEHOLD, not by a chosen card — the preview runs before the user picks the target card. Household-wide is strictly safer (more candidate matches, all visible + overridable). `findCardChargesBetween` still restricts to card-paid transactions (`credit_card_id` not null).

Repo convention check: existing query functions in this file are thin, untested wrappers (the test file covers only pure helpers) — follow that; no new tests here, the pure matching logic was tested in Task 4.

- [ ] **Step 1: Implement both queries**

Add to `packages/db/src/repositories.ts` after `listCreditCards`:

```ts
/**
 * All installment groups of a household, for import-preview dedupe (spec §4).
 * Household-wide on purpose: the preview runs before a target card is chosen,
 * and a broader candidate set only ADDS visible, overridable "already exists"
 * flags. RLS re-checks the household filter.
 */
export async function listInstallmentGroupsByHousehold(
  client: AppSupabaseClient,
  householdId: string,
): Promise<InstallmentGroupRow[]> {
  const { data, error } = await client
    .from("installment_groups")
    .select("*")
    .eq("household_id", householdId);
  if (error !== null) {
    throw new Error(`listInstallmentGroupsByHousehold failed: ${error.message}`);
  }
  return (data ?? []) as InstallmentGroupRow[];
}

/** Minimal card-paid transaction summary for against-DB import dedupe. */
export type CardChargeSummary = {
  occurred_on: string;
  amount_cents: number;
  kind: string;
  description: string;
};

/**
 * Card-paid transactions of a household inside [startDate, endDate], for the
 * against-DB flat-charge dedupe (spec §4): a re-imported fatura must flag rows
 * already written instead of silently duplicating them.
 */
export async function findCardChargesBetween(
  client: AppSupabaseClient,
  householdId: string,
  startDate: string,
  endDate: string,
): Promise<CardChargeSummary[]> {
  const { data, error } = await client
    .from("transactions")
    .select("occurred_on, amount_cents, kind, description")
    .eq("household_id", householdId)
    .not("credit_card_id", "is", null)
    .gte("occurred_on", startDate)
    .lte("occurred_on", endDate);
  if (error !== null) {
    throw new Error(`findCardChargesBetween failed: ${error.message}`);
  }
  return (data ?? []) as CardChargeSummary[];
}
```

If `InstallmentGroupRow` is not already imported/aliased in scope at that point of the file, follow how `createInstallmentPurchase` (line ~1100) references it.

- [ ] **Step 2: Re-export**

Check `packages/db/src/index.ts`: if it re-exports `*` from `./repositories.js`, nothing to do; otherwise add the two functions + `CardChargeSummary` type to the export list, matching the file's style.

- [ ] **Step 3: Verify**

Run: `pnpm --filter @family-finance/db test && pnpm typecheck`
Expected: PASS (existing db tests untouched; 12/12 typecheck).

- [ ] **Step 4: Commit**

```bash
git add packages/db/src
git commit -m "feat(db): household installment-group + card-charge queries for import dedupe"
```

---

### Task 6: `previewImport` MP branch (unpdf extraction + dedupe + card catalog)

**Files:**
- Modify: `apps/web/app/(app)/imports/actions.ts`

**Interfaces:**
- Consumes: `mercadoPagoPdfAdapter` via the existing registry; `splitFlatAndInstallmentRows`, `matchExistingGroup`, `normalizeDescription` (importers, Task 3/4); `listCreditCards`, `listInstallmentGroupsByHousehold`, `findCardChargesBetween` (db, Task 5); `unpdf` (installed Task 2).
- Produces (consumed by the Task 8 UI):

```ts
export type CreditCardOption = { id: string; name: string };
export type InferredGroupPreview = InferredInstallmentGroup & {
  status: "new" | "exists";
};
export type MpPreviewExtras = {
  referenceMonth: string;
  groups: InferredGroupPreview[];
  /** Row indices (into preview.rows) of parcela rows — NOT flat-importable. */
  installmentRowIndices: number[];
  /** Row indices already found in the DB (flag "já importada", default-skip). */
  dbDuplicateIndices: number[];
};
// PreviewState gains:  creditCards: CreditCardOption[];  mp?: MpPreviewExtras;
```

- [ ] **Step 1: Wire the source through parsing + db mapping**

In `apps/web/app/(app)/imports/actions.ts`:

```ts
const SOURCE_TO_DB: Record<ImportSource, DbImportSource> = {
  "minhas-financas": "minhas_financas_csv",
  nubank: "nubank_csv",
  "mercado-pago": "mercado_pago_pdf",
};

function parseSource(value: FormDataEntryValue | null): ImportSource {
  if (
    value === "minhas-financas" ||
    value === "nubank" ||
    value === "mercado-pago"
  ) {
    return value;
  }
  throw new Error("Fonte de importação inválida.");
}
```

`DbImportSource` comes from `packages/db` generated types — if the union there is hand-written, add `"mercado_pago_pdf"` to it (check `packages/db/src/types.ts`).

- [ ] **Step 2: Add extraction + MP preview extras**

Extend the imports at the top of the file:

```ts
import {
  getImportAdapter,
  buildImportPreview,
  splitFlatAndInstallmentRows,
  matchExistingGroup,
  normalizeDescription,
  type ImportSource,
  type ImportPreview,
  type NormalizedImportRow,
  type InferredInstallmentGroup,
} from "@family-finance/importers";
```

and from `@family-finance/db` add `listCreditCards`, `listInstallmentGroupsByHousehold`, `findCardChargesBetween`.

Add the new types right after `SubcategoryOption`:

```ts
export type CreditCardOption = { id: string; name: string };
export type InferredGroupPreview = InferredInstallmentGroup & {
  status: "new" | "exists";
};
export type MpPreviewExtras = {
  referenceMonth: string;
  groups: InferredGroupPreview[];
  installmentRowIndices: number[];
  dbDuplicateIndices: number[];
};
```

and extend `PreviewState` with `creditCards: CreditCardOption[]; mp?: MpPreviewExtras;`.

Inside `previewImport`, replace the single `const fileText = await file.text();` with:

```ts
    // PRIVACY: for the PDF fatura the bytes are extracted to text in-memory and
    // dropped immediately — same transient guarantee as the CSV path.
    let fileText: string;
    if (source === "mercado-pago") {
      const { extractText } = await import("unpdf");
      const bytes = new Uint8Array(await file.arrayBuffer());
      const extracted = await extractText(bytes, { mergePages: true });
      fileText = Array.isArray(extracted.text)
        ? extracted.text.join("\n")
        : extracted.text;
    } else {
      fileText = await file.text();
    }
```

After `const preview = buildImportPreview(...)`, keep the existing accounts/categories loading, add credit cards, and build the MP extras:

```ts
    const [accounts, categories, creditCards] = await Promise.all([
      findAccountsByHousehold(client, householdId),
      findCategoriesByHousehold(client, householdId),
      listCreditCards(client, householdId),
    ]);

    let mp: MpPreviewExtras | undefined;
    if (source === "mercado-pago") {
      const referenceMonth = parsed.statement?.referenceMonth;
      if (referenceMonth === undefined) {
        return {
          ok: false,
          message:
            "Não foi possível identificar o mês de emissão da fatura no PDF.",
        };
      }
      const { flatRowIndices, groups } = splitFlatAndInstallmentRows(
        rows,
        referenceMonth,
      );
      const installmentRowIndices = rows
        .map((_, i) => i)
        .filter((i) => !flatRowIndices.includes(i));

      // §4 dedupe — installment groups already in the DB.
      const existingGroups = await listInstallmentGroupsByHousehold(
        client,
        householdId,
      );
      const summaries = existingGroups.map((g) => ({
        description: g.description,
        installmentCount: g.installment_count,
        purchasedOn: g.purchased_on,
      }));
      const groupPreviews: InferredGroupPreview[] = groups.map((g) => ({
        ...g,
        status: matchExistingGroup(g, summaries) === null ? "new" : "exists",
      }));

      // §4 dedupe — flat charges already imported on a card in the period.
      const dates = rows
        .filter((_, i) => flatRowIndices.includes(i))
        .map((r) => r.occurredOn)
        .sort();
      let dbDuplicateIndices: number[] = [];
      const first = dates[0];
      const last = dates[dates.length - 1];
      if (first !== undefined && last !== undefined) {
        const charges = await findCardChargesBetween(
          client,
          householdId,
          first,
          last,
        );
        const seen = new Set(
          charges.map(
            (c) =>
              `${c.occurred_on}|${c.kind}|${Math.abs(c.amount_cents)}|` +
              normalizeDescription(c.description).toLowerCase(),
          ),
        );
        dbDuplicateIndices = flatRowIndices.filter((i) => {
          const r = rows[i] as NormalizedImportRow;
          const key =
            `${r.occurredOn}|${r.kind}|${r.amount.cents}|` +
            normalizeDescription(r.description).toLowerCase();
          return seen.has(key);
        });
      }

      mp = { referenceMonth, groups: groupPreviews, installmentRowIndices, dbDuplicateIndices };
    }
```

Note: the code above needs the adapter result in scope — rename the existing destructuring to `const parsed = await adapter.parse(fileText); const { rows, errors } = parsed;`.

Include `creditCards: creditCards.map((c) => ({ id: c.id, name: c.name }))` and `mp` in the returned `PreviewState`.

- [ ] **Step 3: Verify**

Run: `pnpm typecheck && pnpm --filter @family-finance/web test && pnpm --filter @family-finance/web build`
Expected: all PASS. (If the build fails resolving `unpdf` inside a server action, add `serverExternalPackages: ["unpdf"]` to `next.config.mjs` — document in the commit body if needed.)

- [ ] **Step 4: Commit**

```bash
git add "apps/web/app/(app)/imports/actions.ts" packages/db/src apps/web/next.config.mjs
git commit -m "feat(web): Mercado Pago fatura preview — unpdf extraction, inferred groups, against-DB dedupe"
```

(Drop `next.config.mjs` / `packages/db` from the add list if untouched.)

---

### Task 7: `confirmImport` MP branch (card charges + installment groups)

**Files:**
- Modify: `apps/web/app/(app)/imports/actions.ts`

**Interfaces:**
- Consumes: `createInstallmentPlan`, `brl` from `@family-finance/domain`; `createInstallmentPurchase` from `@family-finance/db`; `ConfirmInput` (existing).
- Produces (consumed by the Task 8 UI):

```ts
export type ConfirmGroupInput = {
  description: string;
  totalAmountCents: number;
  installmentCount: number;
  purchasedOn: string; // ISO YYYY-MM-DD (user-edited)
  categoryId?: string;
  subcategoryId?: string;
};
// ConfirmInput gains:
//   creditCardId?: string;      // required when source === "mercado-pago"
//   groups?: ConfirmGroupInput[];
// accountId stays required for CSV sources only.
```

- [ ] **Step 1: Extend `ConfirmInput` + target validation**

Add `creditCardId?: string;` and `groups?: ConfirmGroupInput[];` to `ConfirmInput` (and define `ConfirmGroupInput` above it). Replace the accountId guard at the top of `confirmImport` with:

```ts
    const isMp = input.source === "mercado-pago";
    if (isMp) {
      if (
        typeof input.creditCardId !== "string" ||
        input.creditCardId.length === 0
      ) {
        return {
          ok: false,
          message: "Escolha o cartão de destino antes de confirmar.",
        };
      }
    } else if (
      typeof input.accountId !== "string" ||
      input.accountId.length === 0
    ) {
      return {
        ok: false,
        message: "Escolha a conta de destino antes de confirmar.",
      };
    }
```

(`accountId` keeps its current type; the UI simply won't send it for MP — if the type is non-optional, make it `accountId?: string` and confirm the CSV path still validates it as above.)

- [ ] **Step 2: Card payment for MP drafts**

In the row loop, build the payment per source:

```ts
      const payment =
        isMp && typeof input.creditCardId === "string"
          ? ({ type: "card", creditCardId: input.creditCardId } as const)
          : ({ type: "account", accountId: input.accountId as string } as const);
```

and pass `payment` into `createTransactionDraft`.

- [ ] **Step 3: Persist the kept installment groups AFTER the batch (spec §5 order)**

Add imports: `createInstallmentPlan`, `brl` from `@family-finance/domain`; `createInstallmentPurchase` from `@family-finance/db`.

After the existing `await confirmImportBatch(...)` call and before `revalidatePath`:

```ts
    // §5 step 2: create the kept inferred installment groups, one RPC per
    // group. Not atomic with the batch above — acceptable per spec §5: a
    // re-import flags both already-imported charges and already-created
    // groups, so a partial failure is visible and recoverable, not duplicated.
    let groupsCreated = 0;
    const groupErrors: string[] = [];
    if (isMp && Array.isArray(input.groups)) {
      for (const g of input.groups) {
        const planResult = createInstallmentPlan({
          householdId,
          creditCardId: input.creditCardId as string,
          description: g.description,
          totalAmount: brl(g.totalAmountCents),
          installmentCount: g.installmentCount,
          purchasedOn: g.purchasedOn,
          createdByUserId,
          category:
            g.categoryId !== undefined
              ? { categoryId: g.categoryId, subcategoryId: g.subcategoryId }
              : undefined,
        });
        if (!planResult.ok) {
          groupErrors.push(
            `${g.description}: ${planResult.errors.map((e) => e.message).join("; ")}`,
          );
          continue;
        }
        try {
          await createInstallmentPurchase(client, planResult.value);
          groupsCreated += 1;
        } catch (error) {
          groupErrors.push(
            `${g.description}: ${error instanceof Error ? error.message : "falha ao gravar parcelamento"}`,
          );
        }
      }
    }
```

Verify `createInstallmentPlan`'s exact input field names against `packages/domain/src/installments.ts:55-80` before writing (they are `householdId, creditCardId, description, totalAmount, installmentCount, purchasedOn, createdByUserId, responsibleUserId?, category?`).

Extend the returned message:

```ts
    const parts: string[] = [];
    parts.push(
      writeErrors.length === 0
        ? `Importação confirmada: ${imported} transações gravadas.`
        : `Importadas ${imported}; ${writeErrors.length} linha(s) com erro.`,
    );
    if (isMp) {
      parts.push(`${groupsCreated} parcelamento(s) criado(s).`);
      if (groupErrors.length > 0) {
        parts.push(`Falhas em parcelamentos: ${groupErrors.join(" | ")}`);
      }
    }
    parts.push("Arquivo original descartado.");

    return {
      ok: writeErrors.length === 0 && groupErrors.length === 0,
      message: parts.join(" "),
      importedRows: imported,
      duplicateRows: input.duplicateRows,
      errorRows: input.errorRows + writeErrors.length,
    };
```

- [ ] **Step 4: Verify**

Run: `pnpm typecheck && pnpm --filter @family-finance/web test && pnpm --filter @family-finance/web build`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add "apps/web/app/(app)/imports/actions.ts"
git commit -m "feat(web): Mercado Pago fatura confirm — card charges + installment groups via existing RPCs"
```

---

### Task 8: Imports page UI

**Files:**
- Modify: `apps/web/app/(app)/imports/page.tsx`

**Interfaces:**
- Consumes: `CreditCardOption`, `MpPreviewExtras`, `InferredGroupPreview`, `ConfirmGroupInput` from `./actions` (Tasks 6–7).
- Produces: user-facing flow — source option, `.pdf` accept, card target selector, "Parcelamentos detectados" panel with editable inferred values, "já importada" flags pre-excluded.

- [ ] **Step 1: Source option + PDF accept**

- Add `<option value="mercado-pago">Mercado Pago (Fatura PDF)</option>` to the source select.
- File input: `accept={source === "mercado-pago" ? ".pdf,application/pdf" : ".csv,text/csv"}` and `aria-label="Arquivo"`.
- Extend the intro `<p>` to mention Mercado Pago.

- [ ] **Step 2: State for MP**

Extend `PreviewBundle` with `creditCards: CreditCardOption[]` and `mp?: MpPreviewExtras` (populate from the action result in `onPreview`). Add state:

```tsx
  const [creditCardId, setCreditCardId] = useState<string>("");
  // Per-group edits + skip flags, keyed by group array index.
  const [groupEdits, setGroupEdits] = useState<
    Record<number, { totalAmountCents: number; installmentCount: number; purchasedOn: string; skip: boolean }>
  >({});
```

In `onPreview`, after setting the bundle:

```tsx
    setCreditCardId(result.creditCards[0]?.id ?? "");
    const edits: Record<number, { totalAmountCents: number; installmentCount: number; purchasedOn: string; skip: boolean }> = {};
    (result.mp?.groups ?? []).forEach((g, i) => {
      edits[i] = {
        totalAmountCents: g.estimatedTotalCents,
        installmentCount: g.installmentCount,
        purchasedOn: g.purchasedOn,
        skip: g.status === "exists", // already-exists default-skipped (spec §4)
      };
    });
    setGroupEdits(edits);
    // Pre-exclude: probable in-file duplicates + rows already in the DB +
    // parcela rows (they import via groups, never as flat charges).
    setExcluded(
      new Set([
        ...result.preview.duplicates.map((d) => d.rowIndex),
        ...(result.mp?.dbDuplicateIndices ?? []),
        ...(result.mp?.installmentRowIndices ?? []),
      ]),
    );
```

- [ ] **Step 3: Rows table — flag MP rows**

Inside the row render, compute:

```tsx
    const isDbDuplicate = bundle?.mp?.dbDuplicateIndices.includes(index) ?? false;
    const isInstallmentRow = bundle?.mp?.installmentRowIndices.includes(index) ?? false;
```

- For `isDbDuplicate`, render a badge like the existing "duplicata provável" one with text `já importada` (background `#fdecec`, color `#8a2020`).
- For `isInstallmentRow`, render badge `parcelamento` (background `#e8f0fe`, color `#1a4fa0`) and DISABLE the row's import checkbox (`disabled` + `title="Parcelas entram pelo painel de parcelamentos"`) — parcela rows must not be flat-imported.

- [ ] **Step 4: "Parcelamentos detectados" panel**

Render between the errors card and the rows table, only when `bundle?.mp !== undefined && bundle.mp.groups.length > 0`:

```tsx
          <div style={card}>
            <h3 style={{ marginTop: 0, fontSize: 16 }}>
              Parcelamentos detectados ({bundle.mp.groups.length})
            </h3>
            <p style={{ color: "#6b7280", fontSize: 13, marginTop: 0 }}>
              Valores inferidos da fatura (total = parcela × quantidade; mês da
              compra a partir de “Parcela X de Y”). Revise e edite antes de
              confirmar; grupos já existentes vêm desmarcados.
            </p>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                <thead>
                  <tr style={{ textAlign: "left", color: "#6b7280" }}>
                    <th style={{ padding: "6px 8px" }}>Criar</th>
                    <th style={{ padding: "6px 8px" }}>Descrição</th>
                    <th style={{ padding: "6px 8px" }}>Parcela</th>
                    <th style={{ padding: "6px 8px" }}>Qtde</th>
                    <th style={{ padding: "6px 8px" }}>Total estimado (R$)</th>
                    <th style={{ padding: "6px 8px" }}>Data da compra</th>
                    <th style={{ padding: "6px 8px" }}>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {bundle.mp.groups.map((g, i) => {
                    const edit = groupEdits[i];
                    if (edit === undefined) return null;
                    return (
                      <tr key={i} style={{ borderTop: "1px solid #f0f2f4", opacity: edit.skip ? 0.55 : 1 }}>
                        <td style={{ padding: "6px 8px" }}>
                          <input
                            type="checkbox"
                            checked={!edit.skip}
                            onChange={() =>
                              setGroupEdits((prev) => ({
                                ...prev,
                                [i]: { ...edit, skip: !edit.skip },
                              }))
                            }
                            aria-label={`Criar parcelamento ${g.description}`}
                          />
                        </td>
                        <td style={{ padding: "6px 8px" }}>
                          {g.description}
                          {g.cardLast4 ? (
                            <span style={{ marginLeft: 6, fontSize: 11, color: "#6b7280" }}>
                              final {g.cardLast4}
                            </span>
                          ) : null}
                        </td>
                        <td style={{ padding: "6px 8px" }}>
                          {g.installmentNumber} de {g.installmentCount} ·{" "}
                          {formatBrl(g.perInstallmentCents)}
                        </td>
                        <td style={{ padding: "6px 8px" }}>
                          <input
                            type="number"
                            min={1}
                            value={edit.installmentCount}
                            onChange={(e) =>
                              setGroupEdits((prev) => ({
                                ...prev,
                                [i]: { ...edit, installmentCount: Number.parseInt(e.target.value, 10) || 1 },
                              }))
                            }
                            style={{ ...inputStyle, width: 64, padding: "4px 6px" }}
                            aria-label={`Quantidade de parcelas ${g.description}`}
                          />
                        </td>
                        <td style={{ padding: "6px 8px" }}>
                          <input
                            type="number"
                            min={0.01}
                            step={0.01}
                            value={(edit.totalAmountCents / 100).toFixed(2)}
                            onChange={(e) =>
                              setGroupEdits((prev) => ({
                                ...prev,
                                [i]: {
                                  ...edit,
                                  totalAmountCents: Math.round(Number.parseFloat(e.target.value || "0") * 100),
                                },
                              }))
                            }
                            style={{ ...inputStyle, width: 110, padding: "4px 6px" }}
                            aria-label={`Total do parcelamento ${g.description}`}
                          />
                        </td>
                        <td style={{ padding: "6px 8px" }}>
                          <input
                            type="date"
                            value={edit.purchasedOn}
                            onChange={(e) =>
                              setGroupEdits((prev) => ({
                                ...prev,
                                [i]: { ...edit, purchasedOn: e.target.value },
                              }))
                            }
                            style={{ ...inputStyle, padding: "4px 6px" }}
                            aria-label={`Data da compra ${g.description}`}
                          />
                        </td>
                        <td style={{ padding: "6px 8px" }}>
                          {g.status === "exists" ? (
                            <span style={{ fontSize: 11, color: "#8a6d00", background: "#ffeec0", borderRadius: 6, padding: "1px 6px" }}>
                              já existe
                            </span>
                          ) : (
                            <span style={{ fontSize: 11, color: "#15633a", background: "#e9f7ef", borderRadius: 6, padding: "1px 6px" }}>
                              novo
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
```

- [ ] **Step 5: Confirm section — card target + payload**

- Target selector: when `bundle?.mp !== undefined`, render a credit-card `<select>` (options from `bundle.creditCards`, value `creditCardId`, aria-label `"Cartão de destino"`, placeholder option `Cartão de destino…`) INSTEAD of the account select; keep the account select for CSV sources. Empty-card-list hint mirrors the accounts one: `Nenhum cartão cadastrado. Cadastre um cartão em “Cartões” antes de importar.`
- Confirm button disabled condition becomes: `isPending || (bundle?.mp !== undefined ? creditCardId === "" : accountId === "")`.
- In `onConfirm`, guard per source and build the payload:

```tsx
    const isMp = bundle.mp !== undefined;
    if (isMp ? creditCardId === "" : accountId === "") {
      setConfirmResult({
        ok: false,
        message: isMp
          ? "Escolha o cartão de destino antes de confirmar."
          : "Escolha a conta de destino antes de confirmar.",
      });
      return;
    }
    const groups = isMp
      ? (bundle.mp?.groups ?? [])
          .map((g, i) => ({ g, edit: groupEdits[i] }))
          .filter((x) => x.edit !== undefined && !x.edit.skip)
          .map(({ g, edit }) => ({
            description: g.description,
            totalAmountCents: edit!.totalAmountCents,
            installmentCount: edit!.installmentCount,
            purchasedOn: edit!.purchasedOn,
          }))
      : undefined;
```

and pass `creditCardId: isMp ? creditCardId : undefined, groups` into the `confirmImport` call (keep `accountId` as today for CSV; pass `accountId: isMp ? "" : accountId` if the field stays required — match whatever Task 7 decided for the type).

- [ ] **Step 6: Verify**

Run: `pnpm typecheck && pnpm --filter @family-finance/web lint && pnpm --filter @family-finance/web build`
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add "apps/web/app/(app)/imports/page.tsx"
git commit -m "feat(web): Mercado Pago fatura import UI — card target + editable parcelamentos panel"
```

---

### Task 9: Full gate + live smoke against the local stack

**Files:** none created (verification only; fix-forward anything found).

- [ ] **Step 1: Whole-tree gate**

Run from the repo root:
```bash
pnpm typecheck && pnpm test && pnpm --filter @family-finance/web lint && pnpm --filter @family-finance/web build && pnpm --filter @family-finance/bot build
```
Expected: typecheck 12/12; ≥117 tests + the new importer suites; both builds green; lint clean.

- [ ] **Step 2: Live smoke (local stack is running; web dev on :3000 may need relaunch)**

- If :3000 is down: `cd apps/web && nohup pnpm dev >/tmp/family-finance-web.log 2>&1 & disown` — check `lsof -iTCP:3000 -sTCP:LISTEN`.
- Verify the enum landed (Task 1 step 3 command) — if the stack was restarted from scratch since, run `supabase migration up` again.
- With the REAL fatura PDF (`~/Documents/Personal/Financeiro e Notas Fiscais/credit cards/credit-card-mp-statement.pdf`): exercise `previewImport` end-to-end. The auth-protected UI needs the user's Google session, so smoke at the action level is acceptable: a scratch script that calls `mercadoPagoPdfAdapter.parse` on a fresh unpdf extraction of the REAL PDF and prints row/error/group counts (no persistence, nothing written). Expected: rows > 0, errors ~0, at least one inferred group, referenceMonth `2026-06`.
- Report the counts in the task summary. Do NOT commit any file containing real fatura content; delete scratch outputs.

- [ ] **Step 3: Report residuals**

List anything deferred (e.g. UI click-through pending the user's logged-in browser session) in the final summary for the orchestrator — the user does the real in-browser import themselves.

---

## Self-review notes (done at plan time)

- **Spec coverage:** §1 extraction→Task 6; §2 adapter→Task 3; §3 reconstruction incl. `purchasedOn` rule→Task 4; §4 both dedupes→Tasks 4/5/6; §5 sequential persistence→Task 7; §6 plumbing→Tasks 1/3/6; §7 UI→Task 8; §8 testing→Tasks 3/4 + gate Task 9; privacy→Tasks 2/6/9.
- **Known judgment call:** dedupe queries are household-scoped, not card-scoped (preview runs before card pick) — noted in Task 5; strictly safer.
- **Type consistency:** `InferredInstallmentGroup` (Task 4) flows unchanged into `InferredGroupPreview` (Task 6) and the UI (Task 8); `ConfirmGroupInput` (Task 7) matches what Task 8 builds; `createInstallmentPlan` field names verified against `packages/domain/src/installments.ts:55-80`.
- **Honest uncertainty:** the adapter regexes are contracts against the Task 2 fixture, which is derived from the REAL unpdf extraction — Task 3 explicitly instructs adapting lexical patterns to observed shapes without changing behavior contracts.
