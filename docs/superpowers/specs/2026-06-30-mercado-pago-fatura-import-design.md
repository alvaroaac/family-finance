# Mercado Pago fatura import — design

**Date:** 2026-06-30
**Status:** Approved design, pending implementation plan

## Goal

Let the dashboard import a Mercado Pago credit-card **fatura (PDF)** through the
existing import pipeline at `apps/web/app/(app)/imports`, alongside the current
Minhas Finanças and Nubank CSV adapters.

Sample input lives at
`~/Documents/Personal/Financeiro e Notas Fiscais/credit cards/credit-card-mp-statement.pdf`.

## Source format (observed)

Mercado Pago fatura = 6-page PDF, statement layout (not tabular). Real
transaction content is on the per-card pages:

- **Multiple cards**, each its own section header `Cartão Visa [************7720]`
  followed by rows and a per-card `Total` line.
- Transaction rows: `DD/MM <descrição> R$ <valor>`, e.g.
  `30/05 GIASSI SUPERMERCADOS R$ 412,10`.
- **Parcela rows** carry inline `Parcela X de Y`, e.g.
  `02/05 MERCADOLIVRE*EBAZARCOMBRL Parcela 14 de 18 R$ 416,61`. The fatura shows
  only **this month's installment amount**, never the original purchase total.
- **International purchases are two lines**:
  `02/06 Compra internacional em ANTHROPIC* CLAUDE SUB R$ 569,25`
  then `BRL 0 = USD 1 = R$ 0 BRL 550.00`. The R$ line carries the billed amount.
- **Payments/credits** appear in a `Movimentações na fatura` block:
  `03/06 Pagamento da fatura de junho/2026 R$ 5.197,69`.
- **Dates have no year** (`DD/MM`). Year is inferred from the statement period
  (`Consumos de 30/05 a 29/06`) and emission date (`Emitida em: 30/06/2026`).

## Product decisions

- **Parcelas → installment groups.** Each parcela row reconstructs one
  `InstallmentGroup`. Values are **inferred** (count, purchase month, estimated
  total) and **editable in the preview** before confirm. Groups already present
  in the DB are **auto-detected and shown** (default-skipped), not silently
  dropped.
- **Single credit card target.** All card sections (the 3 Visa last-4s) roll
  into one `credit_cards` record the user picks. No per-card split.
- **Payments/credits skipped.** Only consumo (expenses) import; the
  `Pagamento da fatura` block is ignored.
- **PDF library:** `unpdf` (serverless/edge-friendly, zero native deps).
- **Persistence:** sequential reuse of existing RPCs (no new SQL).

## Schema facts that shape the design

- `accounts.kind` is only `checking | investment` — there is **no credit-card
  account kind**. Cards live in the separate `credit_cards` table.
- `transactions` enforces **exactly one** of `account_id` / `credit_card_id`
  (CHECK). A fatura charge therefore must use `credit_card_id`, not `account_id`.
- `installment_groups.credit_card_id` is **NOT NULL** → installments require a
  card.
- The domain already supports `payment: { type: "card", creditCardId }`
  (`packages/domain/src/transactions.ts`). The current import action hardcodes
  `{ type: "account", accountId }`; the MP path uses the card variant.
- `transactions.installment_id` and `credit_card_id` columns already exist;
  `confirm_import` already inserts them when present.

## Architecture

### 1. PDF → text (web layer only)

Add `unpdf` to `apps/web`. In `previewImport`, when `source === "mercado-pago"`,
extract text server-side and pass the resulting string into the existing
`adapter.parse(fileText: string)` contract. **No change to the importer
contract.** The PDF bytes are read into memory, extracted, and dropped — never
persisted, preserving the current privacy guarantee. The `importers` package
stays PDF-free and pure (domain + zod only).

CSV sources keep using `file.text()`; only MP routes through extraction.

### 2. New adapter `mercado-pago-pdf` (importers package)

`ImportSource` gains `"mercado-pago"`. A new `mercado-pago-pdf.ts` adapter parses
the extracted text:

- Iterate lines, tracking the **current card section** (`Cartão Visa [****NNNN]`
  → last4).
- Match transaction rows `DD/MM <desc> R$ <valor>`, capturing optional
  `Parcela X de Y`.
- Join the **international second line** into the preceding row (use the R$
  amount; append original currency to description).
- **Skip**: page/section headers, per-card `Total` lines, and the entire
  `Movimentações na fatura` payment block.
- **Year inference**: derive the statement's reference month from the period /
  emission date; a row whose `MM` is greater than the statement closing month
  belongs to the previous year (handles `06/02` parcela on a June fatura).
- Unmappable rows become reviewable `errors` (never throw), matching existing
  adapters.

`NormalizedImportRow` gains two **optional** fields (backward-compatible with the
CSV adapters):

```ts
installment?: { number: number; count: number };
cardLast4?: string;
```

à-vista rows have no `installment` and become flat transactions as today.

### 3. Parcela reconstruction (importers, pure)

A pure function groups parcela rows and produces inferred installment plans. For
each parcela row (one parcel per group appears per fatura):

- `count = Y`
- `perInstallmentCents = thisRow.amount`
- `estimatedTotalCents = perInstallmentCents × Y`
- `purchaseMonth = statementMonth − (X − 1)`
- `description`, `cardLast4` carried through.

Output is an `InferredInstallmentGroup[]` preview model with all inferred values
**editable** downstream. The estimate is exact when parcels are equal (typical
for MP); the user can correct the total/start/count in the preview.

### 4. Dedupe vs existing installment groups (db query)

A new `packages/db` query finds existing `installment_groups` for the household +
chosen credit card matching an inferred group by **description + count +
purchase month**. The preview classifies inferred groups into three buckets:

- **new** — no match, will be created (selected by default);
- **already exists** — match found, shown to the user, default-skipped;
- **needs input** — inference incomplete/ambiguous, user supplies total/date
  before it can be created.

### 5. Persistence (sequential reuse of existing RPCs)

`confirmImport` action, MP branch, performs two writes in sequence:

1. **Flat charges** (à-vista expenses) → existing `confirm_import` RPC, with the
   transaction payload using `credit_card_id` (not `account_id`).
2. **Inferred groups** the user kept → existing `create_installment_purchase`
   RPC, one call per group, built from the edited values via the domain
   `createInstallmentPlan`.

Not atomic across the two RPCs. Acceptable because installment groups carry no
batch link and re-import dedupe (§4) makes a partial failure recoverable — a
re-run detects already-created groups and already-imported charges.

### 6. Plumbing

- **Migration** `00NN_mercado_pago_import_source.sql`:
  `alter type import_source add value 'mercado_pago_pdf';` (enum value must exist
  before `confirm_import` casts `::import_source`).
- `SOURCE_TO_DB` += `"mercado-pago" -> "mercado_pago_pdf"` and `parseSource`
  whitelist (`apps/web/.../imports/actions.ts`).
- Adapter registry in `packages/importers/src/index.ts`.

### 7. UI (imports page)

- Source `<select>` gains **"Mercado Pago (PDF)"**.
- When MP is selected: file input `accept=".pdf"`; the target selector switches
  from **account** to **credit card** (loads household `credit_cards`).
- A new **"Parcelamentos detectados"** panel above the flat-rows table lists
  inferred groups with editable total/start/count and the already-exists matches.
- CSV sources are unchanged.

### 8. Testing

- Adapter unit tests over an **anonymized** fatura-text fixture covering:
  multi-card sections, parcela rows, international 2-line entries, payment-block
  skip, per-card `Total` skip, and cross-year date inference.
- Reconstruction tests: inference math (count/total/purchase-month) and the
  dedupe-match predicate.
- Existing CSV adapter tests must keep passing (optional fields are additive).

## Privacy

The PDF contains the cardholder's full name and credit limits. It is extracted
transiently in `previewImport` and discarded; only normalized rows, inferred
group metadata, and batch counts are persisted — identical to the current CSV
guarantee. The test fixture is anonymized (no real names, card numbers, or
amounts that identify the holder).

## Out of scope (YAGNI)

- Per-card account splitting (single card target chosen).
- Importing payments/credits (skipped).
- Exact original-total recovery (estimate + manual edit instead).
- A combined atomic fatura RPC (sequential reuse chosen).
