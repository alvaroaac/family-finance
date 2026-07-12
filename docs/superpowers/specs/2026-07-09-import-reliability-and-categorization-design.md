# Import reliability and categorization — design

**Date:** 2026-07-09  
**Status:** Proposed design  
**Scope:** Existing Minhas Finanças CSV, Nubank CSV, and Mercado Pago PDF flows,
from upload through reliable confirmation and import-preview categorization.

## 1. Goal

Make Importação trustworthy enough for repeated household use:

1. importing or retrying the same data must not silently duplicate money;
2. every persisted artifact must be traceable to a reviewed batch and source row;
3. preview must expose errors, duplicates, edits, and category provenance before
   any write;
4. confirmed household memory and source mappings should remove repetitive work;
5. Codex may enrich unresolved rows in bounded batches, but imports must remain
   fully usable when every AI provider is unavailable;
6. AI never writes transactions, taxonomy, mappings, or memory without an
   explicit user confirmation.

This design supersedes the earlier Mercado Pago decisions that accepted a
single target card and non-atomic flat/group persistence. The existing adapters
remain; this work hardens and connects them.

## 2. Non-goals

The following are intentionally outside this tranche:

- investment-transfer accounting and Saldo semantics;
- automatic creation of categories or subcategories;
- automatic import without a human preview/confirmation step;
- XLSX, OFX, Open Finance, or additional institution adapters;
- full bank-account balance reconciliation and statement closing balances;
- deleting import history as an undo mechanism;
- using AI to decide whether a row is a transfer, refund, card payment, income,
  or expense. Those semantics need a separate accounting design.

The schema should not block those future capabilities, but this delivery ends
when existing expense/income imports have reliable dedupe and useful category
suggestions.

## 3. Current baseline

The product already supports:

- Minhas Finanças CSV and Nubank CSV parsing;
- one observed Mercado Pago PDF layout, including last-four card metadata,
  flat charges, international-description suffixes, and installment inference;
- transient file handling: raw bytes are not persisted;
- normalized preview, row errors, include/exclude, and manual category mapping;
- within-file probable-duplicate flags;
- Mercado Pago against-database flat-charge and group heuristics;
- atomic `confirm_import` persistence for batch + flat transactions + selected
  row audit records;
- RLS, active-household membership checks, and same-household foreign keys.

Known correctness gaps drive this design:

- CSV re-imports are not checked against existing transactions;
- no source-native ID, stable fingerprint, unique claim, or request idempotency
  key exists;
- preview dedupe is advisory and confirm does not recheck under a lock;
- Mercado Pago flat rows and installment groups commit in separate RPCs;
- a multi-card PDF is assigned to one selected card even though last-four values
  are parsed;
- parser errors and excluded rows are counted but not fully audited;
- client-provided batch counts are trusted;
- `sourceCategory` is parsed but ignored;
- production import does not use categorization memory, rules, merchant aliases,
  Codex, or Haiku;
- current browser E2E proves only that `/imports` opens.

## 4. Product decisions

### 4.1 Preview remains mandatory

Parsing and suggestions never persist financial artifacts. A user must review
and confirm every batch. High-confidence deterministic categories may be
preselected, but remain visible and editable in the preview.

### 4.2 Duplicate signals have explicit strength

The UI and persistence layer distinguish:

- **exact request retry:** same signed preview/request key;
- **exact source-item duplicate:** same stable provider row ID and target
  instrument;
- **exact file replay:** same original file hash; this reopens prior batch/row
  dispositions but is not, by itself, proof that every row must stay skipped;
- **probable duplicate:** matching normalized date, direction, amount,
  description, and target instrument without a provider ID;
- **intentional duplicate:** user explicitly overrides a probable/exact warning
  with a stable override token and reason.

Probable matches are never silently discarded. They start excluded and require
an explicit override to import. Exact request retries return the original result
without creating a second batch.

### 4.3 Imported categories are suggestions, not source truth

An old/source category label is useful evidence, not a current taxonomy ID. It
must be mapped to an active household category/subcategory. It never creates a
taxonomy entry.

### 4.4 Learning requires explicit opt-in

Correcting one row changes only that row unless the user separately chooses:

- apply to matching rows in this preview;
- remember this merchant for future imports; or
- save this source-category mapping.

Confirming a batch does not implicitly authorize global learning.

### 4.5 AI is last in the cascade

Precedence for a row is:

1. explicit per-row or bulk user choice;
2. confirmed exact merchant memory, including an explicit “always leave
   uncategorized” suppression;
3. saved household + import-source category mapping;
4. deterministic merchant rules/aliases;
5. Codex batch suggestion for unresolved expense rows;
6. optional provider-neutral paid fallback for operationally failed/missing
   Codex items only;
7. uncategorized.

Merchant-specific memory outranks a broad source label. AI never outranks a
confirmed household rule.

Every memory, source mapping, and rule declares the row kinds it applies to.
Merchant memories default to `expense`; they must never classify income merely
because the description matches. Income may use an explicit income-scoped source
mapping/memory/rule or remain uncategorized. Model enrichment is
expense-only until income/refund/transfer semantics receive their own design.

### 4.6 AI failure never blocks import

Timeout, authentication failure, circuit opening, invalid schema, or provider
unavailability leaves affected rows uncategorized. Preview and confirm remain
available.

## 5. Invariants

The implementation must preserve all of the following:

- Original file bytes are read in memory and discarded.
- Only normalized/audit fields and one-way hashes are persisted.
- Money remains integer BRL cents; dates are real ISO calendar dates.
- Household ID comes from the authenticated server session, never the client.
- Account/card/category IDs are active and belong to that household.
- A selected subcategory belongs to the selected category.
- Request retries and concurrent confirmation cannot create duplicate artifacts.
- Flat transactions and inferred installment groups in one preview are one
  atomic confirmation.
- Database counts are derived from persisted dispositions, never trusted from
  the browser.
- Every source row has an audit disposition, including parser error, excluded,
  duplicate, validation error, imported transaction, or imported group.
- Suggestions contain only real active catalog IDs. Novel names remain pending
  proposals and are never selected automatically.
- Category/memory learning is auditable, household-scoped, and attributable to
  the confirming user.

## 6. End-to-end flow

```text
file bytes
  -> size/type/signature checks
  -> SHA-256 + source adapter/version
  -> normalized immutable source rows
  -> target account / card-last4 mapping
  -> versioned row identities + DB claim lookup
  -> deterministic category cascade
  -> optional Codex batch enrichment
  -> editable review + explicit learning choices
  -> signed preview/request payload
  -> server revalidation + confirm_import_v2
  -> claims + batch + all audit rows + transactions/groups, atomically
  -> batch detail/result
```

The preview response contains immutable normalized source fields and separate
editable final fields. Edits never change the source fingerprint.

## 7. Identity and idempotency

### 7.1 Request and content identifiers

Each preview carries:

- `requestKey`: server-generated UUID reused by every retry/double-click;
- `fileFingerprint`: SHA-256 of original file bytes;
- `normalizedFingerprint`: SHA-256 of immutable canonical normalized rows plus
  the stable source-identity version;
- `confirmationFingerprint`: computed at confirm from the normalized fingerprint,
  target mapping, final edits, dispositions, override tokens, and learning choices.

Each importable item also gets a `claimFingerprint` after the user resolves its
target instrument. It combines stable source identity with the target type/ID;
changing destination therefore triggers a duplicate refresh in preview and a
mandatory confirm-time recheck.

The server returns a signed preview token containing household ID, user ID,
request key, source, file fingerprint, `normalizedFingerprint`, parser
version, and expiry. On confirm it recomputes the normalized hash and rejects a
modified/expired token. User edits are validated separately as final fields and
included in the confirmation fingerprint used for idempotent result matching.

`IMPORT_PREVIEW_SIGNING_SECRET` is server-only, independent from public auth
keys, and rotatable. Token contents contain hashes/IDs, not raw file data.

### 7.2 Versioned row fingerprint

`@family-finance/importers` owns a pure, golden-tested identity contract:

1. build canonical sorted JSON;
2. encode UTF-8;
3. SHA-256;
4. store an explicit stable `identityVersion`.

Common identity fields:

- logical import source;
- provider transaction ID when available; when present, the stable source item
  identity is source + provider ID and does not also depend on mutable
  date/description fields;
- otherwise, original normalized date, kind, integer cents, and description;
- source-specific identity metadata.

The claim fingerprint adds resolved target instrument type + ID to that stable
source identity. Adapter/parser version remains provenance on the batch/row and
does not change natural claim identity.

Mercado Pago additionally includes statement reference month, card last four,
and observed installment number/count. A reconstructed group claim uses its
original inferred identity plus resolved target card.

Identity inputs exclude parser version, category, subcategory, suggestions,
user edits, filename, source line, and model/provider metadata. Recategorizing
or upgrading a parser must not defeat re-import detection.

Description identity normalization is versioned: Unicode NFKC, trim, whitespace
collapse, and case fold. It must not broadly remove numbers because legitimate
merchant names/branches contain them.

Changing identity normalization requires a new `identityVersion` plus an
explicit compatibility rollout: preview queries active claims from compatible
prior versions and migration/golden fixtures map equivalent old/new identities.
No release may silently start a fresh uniqueness namespace merely because the
parser or normalizer changed.

### 7.3 Identical legitimate rows

When a provider supplies a stable transaction ID, that ID is authoritative.
Otherwise, exact-looking rows are inherently ambiguous. Rows sharing one base
fingerprint receive deterministic `occurrenceNo` values in source order so two
identical purchases in one export can occupy slots 1 and 2.

Across overlapping exports without provider IDs, a match is “probable,” not
mathematical truth. The preview shows the existing artifact and permits an
explicit, audited override.

### 7.4 Database claims

Add `import_item_claims` as the single uniqueness/provenance layer for both flat
transactions and installment groups:

- household, source, identity version, base identity hash, occurrence number;
- artifact kind (`transaction` or `installment_group`);
- import batch and source line;
- transaction ID or installment-group ID;
- optional provider row ID;
- optional explicit override token/reason/actor;
- released/reverted metadata and timestamps.

A partial unique index on the active natural claim prevents concurrent batches
from importing the same source item twice **only where `override_token is
null`**. An intentional duplicate references the conflicting canonical claim,
sets a stable override token/reason/actor, and is excluded from the natural
unique index. A separate unique `(household_id, override_token)` makes that
intentional duplicate retry-safe.

Uniqueness must live above transactions/groups: otherwise a parser-version
change could import the same source row once as a flat transaction and once as
an installment group.

### 7.5 Batch identity

Extend `import_batches` with:

- `request_key`, `file_fingerprint`, `normalized_fingerprint`,
  `confirmation_fingerprint`, `parser_version`;
- target/mapping summary;
- `confirmed_at`;
- future `reverted_at` and `reverted_by_user_id` fields.

Unique `(household_id, request_key)` makes lost-response retry return the
existing result only when its confirmation fingerprint also matches. A reused
request key with different reviewed input is rejected.

An exact file replay opens prior batch/item dispositions. A new review may still
claim rows that were previously excluded or failed validation; already active
claims appear as duplicates. File hash is advisory/history and is not a blanket
unique constraint. Intentional re-import of an already claimed row uses the
explicit override path and links to the canonical claim.

Legacy batches are not backfilled with false certainty. They remain candidates
for heuristic duplicate warnings only.

## 8. Atomic confirmation v2

Replace the current split write with `confirm_import_v2(batch, items)`:

1. authenticate active household membership inside the SECURITY DEFINER RPC;
2. acquire an advisory transaction lock for household + request key;
3. return the prior batch when the same request key + confirmation fingerprint
   already succeeded;
4. reject the same request key with a different confirmation fingerprint;
5. validate same-household target/category/subcategory references;
6. attempt claims for every importable item;
7. mark claim conflicts as `duplicate_existing` unless a valid explicit
   override token exists;
8. insert flat transactions and complete installment groups/parcels;
9. write an audit row for every original source row;
10. derive counts from persisted dispositions;
11. commit all artifacts together or roll everything back.

The TypeScript action validates domain drafts/plans before RPC invocation.
Validation failures become audit-only items, not exceptions halfway through SQL.
The database still reasserts structural and household invariants.

### 8.1 Audit dispositions

Extend `import_rows` with:

- claim and optional installment-group links;
- identity-hash/version/occurrence metadata;
- disposition: `imported`, `duplicate_existing`, `duplicate_in_file`,
  `validation_error`, `parser_error`, or `excluded`;
- duplicate target claim/artifact;
- card last four and observed installment information;
- final category provenance, confidence, and accepted/changed state;
- immutable original artifact ID for future history after undo.

Parser errors have no transaction payload but retain bounded normalized reason
and source ordinal. Raw row contents remain absent.

### 8.2 Mercado Pago card mapping

The preview requires each distinct parsed last-four value to map to an active
household card. Rows/groups fingerprint and persist against that card. “Apply
one card to all sections” may be offered explicitly, but cannot be an implicit
default.

DB duplicate/group queries are card-scoped. This removes current cross-card
false positives and prevents silently routing multiple physical cards into one
ledger card.

### 8.3 Undo foundation

This tranche records enough provenance for future batch history/undo, but need
not ship the undo UI. A future `revert_import(batch_id)` must preserve the batch
and audit, delete only artifacts owned by that batch, release claims, and mark
the batch reverted atomically.

If an imported artifact was edited later, the safest first policy is to refuse
automatic revert and require manual resolution. Never delete the batch itself.

## 9. Preview hardening and editing

Server-side limits are mandatory:

- allowed source + MIME/signature/extension consistency;
- maximum bytes, PDF pages, normalized rows, description/source-label length,
  installment count, and total generated parcels;
- parsing and AI timeouts;
- strict Zod schemas for preview and confirm payloads;
- bounded notes/explanations and no control characters;
- request/rate limits by user and household.

The exact initial limits belong in configuration and tests. Suggested defaults:

- CSV 10 MiB, PDF 20 MiB/50 pages;
- 10,000 normalized rows per file;
- descriptions 200 characters, source labels 100;
- installment count 1–120;
- at most 50 AI signatures per preview and 25 per AI chunk.

Preview permits editing final description, date, amount, kind, and destination,
but always shows that an edit differs from source. Editing kind into transfer,
refund, or payment is not supported in this tranche; such rows must be excluded
with an explanation until accounting semantics exist.

## 10. Categorization architecture

### 10.1 Merchant identity

Add a pure, versioned `merchantKey` normalizer in
`@family-finance/categorization`. Preserve display description separately.
Normalization may fold case/Unicode/whitespace and remove only explicitly known
processor/order suffix patterns. It must have fixture and collision tests.

Merchant memory defaults to exact normalized-key matching. Prefix matching is
allowed only when the user explicitly teaches it. Existing substring memories
remain supported as legacy entries but rank below exact merchant memory.

Add memory match kinds such as:

- `merchant_exact`;
- `merchant_prefix`;
- legacy `description_contains`;
- `suppress` (intentionally leave matching items uncategorized).

Memory/rule records also carry an explicit applicable row kind. Existing legacy
description memories migrate as expense-only unless a user deliberately edits
their scope.

A suppression match terminates the cascade instead of falling through to rules
or AI.

### 10.2 Source-category mappings

Add `source_category_mappings`:

- household ID and import source;
- normalized source label + display label;
- applicable row kind (`expense` or `income`);
- active category/subcategory IDs;
- active flag, creator, timestamps;
- composite same-household foreign keys;
- unique active household/source/row-kind/normalized label.

The preview groups distinct source labels and shows, for example:

`Alimentação antiga (37 linhas) -> Alimentação > Mercado`

Saved mappings prefill future previews. The user can apply a mapping for this
preview without saving it, or explicitly choose “Salvar para próximas
importações.” Source mappings never create categories.

### 10.3 Batch planner

Extend `@family-finance/categorization` with pure batch planning/arbitration:

- load catalog, active memory, source mappings, and rule set once;
- resolve deterministic stages across all included rows;
- group unresolved expense rows by merchant key and relevant source context;
- emit opaque suggestion request keys and representative bounded contexts;
- fan results back to every matching row;
- keep provenance and explanation per selected candidate.

One hundred repeated merchant descriptions must create one model item, not one
hundred model calls.

### 10.4 Suggestion contract

Each row may carry up to three candidates:

- active category ID;
- optional active subcategory ID belonging to that category;
- source (`source_mapping`, `memory`, `rule`, `codex`, `paid_fallback`);
- confidence/tier and bounded explanation;
- model/prompt/rules/normalizer version where relevant.

AI replies use opaque request keys and real IDs or an explicit abstention.
Provider confidence is uncalibrated: AI candidates remain review-required until
evaluation justifies a higher policy. Deterministic confirmed memory/source
mappings may be high-confidence and preselected.

Every candidate is revalidated against the live catalog at confirmation. A
renamed item remains valid by ID; an archived/missing item is cleared and
returned for review.

### 10.5 Taxonomy proposals

Codex or the configured paid fallback may return a separate bounded
novel-category/subcategory proposal.
It is non-selected and never created during ordinary import confirmation.

The user may map it to an existing path or leave the row uncategorized. A later
separate create/reuse flow must validate name length/control characters,
accent/case duplicates, archived names, and the parent for a subcategory.

Unknown subcategories under a known macro must no longer disappear silently;
they become explicit pending-subcategory proposals or an explicit warning.

## 11. Codex and paid-fallback connection

### 11.1 Deployment boundary

The web application runs on Vercel and cannot spawn the Codex CLI authenticated
inside the VPS bot container. Web code must not import from `apps/bot`.

Add a narrow internal batch-suggestion endpoint to the VPS bot service, reusing
the hardened tool-free Codex runtime. Vercel calls it server-to-server.

The request contains only:

- household-scoped opaque request/signature keys;
- bounded normalized merchant/description context;
- amount/date/source-category evidence where useful;
- active category/subcategory IDs and names.

It excludes raw files, user names, account balances, auth tokens, and unrelated
transactions.

### 11.2 Internal authentication

Protect the endpoint with a dedicated shared server secret and signed request:

- timestamp, nonce, method/path, and body hash;
- HMAC signature;
- short clock window and replay cache;
- body/item/rate limits;
- no browser access and no CORS exposure.

The endpoint verifies household/catalog structure and never performs financial
writes. Logs contain request IDs, counts, latency, provider/outcome, and schema
failures—not descriptions or raw model output.

### 11.3 Batch execution

- Maximum 25 unique signatures per Codex invocation.
- Maximum two concurrent chunks and a hard per-preview budget.
- Strict JSON schema with no extra keys and bounded strings/items.
- Per-item validation: one invalid suggestion does not discard valid siblings.
- Tool-free/no-network Codex subprocess, read-only sandbox, minimal environment,
  event audit, timeout/output limits, circuit breaker, and concurrency cap.
- Paid fallback is disabled by default. Enabling it requires an explicit
  supported provider and exact model ID; no paid model (including Haiku) is
  selected implicitly.
- Only operational Codex failure or an omitted/invalid item is eligible. A valid
  Codex item with an explicit empty result is an abstention and remains manual.
- The bot atomically reserves quota after Codex and immediately before the paid
  call, for exactly the items it will attempt. Reservation is idempotent per
  attempt and bounded per preview and household/day.
- Telemetry persists provider, model, attempted/resolved counts, outcome, and
  latency without descriptions or raw output.
- Partial/time-out result returns valid suggestions plus unresolved keys.

The initial paid fallback default should be conservative and observable. Model
selection is configuration, not hardcoded product behavior.

### 11.4 Progressive UX

Base preview returns deterministic results first. “Buscar sugestões com Codex”
may run as a separate enrichment action so upload/parse is not held hostage by
model latency. The UI shows progress and keeps manual confirmation available.

AI results merge only into unresolved/review rows and never overwrite a user
edit made while the request was running.

## 12. Preview UX

The review screen shows:

- counts: ready, needs review, uncategorized, duplicate, error, excluded;
- category/subcategory plus provenance chip: `Lembrado`, `Categoria do arquivo`,
  `Regra`, `Codex`, or `Fallback pago`;
- explanation on demand;
- source-vs-final differences for edited fields;
- exact/probable duplicate reason and link to existing artifact/batch;
- multi-card mapping panel for PDF last-four values;
- distinct source-category mapping panel;
- installment-group category selection;
- explicit unresolved count at confirm.

Bulk actions include:

- same merchant;
- same source label;
- selected rows;
- all unresolved;
- apply category/subcategory;
- include/exclude;
- undo last bulk edit.

Teaching controls are separate and unchecked by default:

- `Aplicar às N linhas deste comerciante`;
- `Lembrar este comerciante para próximas importações`;
- `Salvar mapeamento desta categoria do arquivo`.

An empty batch cannot be confirmed. Confirm labels count flat transactions and
installment groups accurately.

## 13. Learning and persistence

On confirmation:

- final category choices persist with transactions/groups;
- suggestion provenance/accepted-or-changed status persists in import audit;
- opted-in source mappings are upserted household/source/label;
- opted-in merchant memory is upserted by normalized pattern/match kind;
- conflicting prior exact memory is deactivated/replaced, not duplicated;
- creator and explanation remain auditable.

Requested learning commands are part of `confirm_import_v2` and commit atomically
with financial artifacts and audit rows. The server validates every command
before RPC invocation; source mappings/memory use idempotent upserts. If a
requested learning command is invalid or conflicts irreconcilably, confirmation
returns to preview and nothing commits. Users who do not want learning can
uncheck it and confirm the financial batch alone. Lost-response retry returns
the same atomic result through request-key/confirmation-fingerprint matching.

## 14. Package boundaries

`@family-finance/importers`

- adapters, immutable normalized source fields, source metadata, fingerprint
  inputs, occurrence assignment;
- no database, catalog, memory, or provider access.

`@family-finance/categorization`

- merchant normalization, deterministic cascade, batch planning/arbitration,
  confidence/provenance contracts, strict provider reply schemas;
- injected catalog/memory/source mappings/provider interface;
- no database or network clients.

`@family-finance/db`

- claims, source mappings, evolved memory, batch/audit repositories,
  confirmation/revert RPC contracts and RLS/composite FKs.

`apps/web`

- auth, upload limits/extraction, one-time dependency loads, preview signing,
  duplicate queries, deterministic orchestration, internal AI client, review UI,
  and confirmation action.

`apps/bot`

- internal batch-suggestion HTTP endpoint and hardened Codex/paid-fallback runtime.

Provider-neutral contracts may move to a server-only shared package if needed;
web must not import implementation from bot.

## 15. Testing and verification

### 15.1 Pure/unit

- golden row fingerprints across Unicode, whitespace/case, source variants,
  target instruments, occurrence slots, and excluded category/user edits;
- property/fuzz tests for CSV parsing, money ambiguity, size limits, and merchant
  normalization collisions;
- source mapping and memory/rule/AI precedence, including suppression;
- 100 repeated descriptions -> one AI request item;
- AI chunk limits, partial invalid replies, timeout, abstention, and fallback cap;
- novel taxonomy proposal never becomes a selected ID.

### 15.2 Real Postgres/RLS

- same request twice returns one batch/result;
- lost-response retry returns the stored result;
- concurrent same request and concurrent different requests for the same item
  create exactly one artifact;
- exact file re-import after a complete batch creates none unless explicitly
  overridden; replay after a partial/excluded review can claim only previously
  unclaimed rows;
- two legitimate identical rows occupy distinct occurrence claims;
- cross-household claim/payload/category attacks fail;
- DB derives correct counts and audits all dispositions;
- mixed Mercado Pago flat/group failure rolls back the whole batch;
- multi-card mapping persists each artifact to the correct card;
- transaction/group/claim/batch/audit provenance links are complete.

### 15.3 Browser/server action

For every supported source:

1. upload a realistic fixture;
2. preview normalized rows/errors;
3. map source labels and card/account targets;
4. see duplicate/categorization provenance;
5. bulk correct and explicitly remember one merchant;
6. confirm;
7. refresh and inspect batch/result;
8. double-click/retry/re-import and prove no duplicate;
9. import a later file and prove saved mapping/memory is reused.

Test AI unavailable/timeout, invalid schema, stale taxonomy, malicious prompt-like
description, oversized files/payloads, and no-learning-without-opt-in.

Real anonymized exports/fixtures must cover line endings, BOM/encoding, quoted
newlines, delimiter variants, Mercado Pago layout variation, multiple cards,
payments/credits excluded, and international entries.

## 16. Rollout and observability

1. Additive schema/claims/source-mapping migration and v2 RPC behind a flag.
2. Deploy dual-read preview: new exact claims plus legacy probable heuristics.
3. Enable v2 confirmation for one household/source at a time.
4. Verify retry/concurrency/RLS gates against production-like Postgres.
5. Revoke authenticated execution of v1 after rollback window.
6. Ship deterministic categorization/source mappings and review UX.
7. Ship explicit correction learning.
8. Deploy the bot's dual v1/v2 suggestion reader before the v2 web caller, then
   deploy the web app. Legacy v1 requests remain Codex-only during the rollback
   window so an old caller cannot trigger the new paid path.
9. Enable Codex batch enrichment; keep provider-neutral paid fallback disabled
   until an operator explicitly configures its provider and exact model for
   operational failures.

Metrics/logs:

- parse duration, rows/errors, source/parser version;
- exact/probable/overridden duplicate counts;
- confirmation retry/conflict/rollback outcomes;
- category provenance and accepted/changed/uncategorized counts;
- unique AI signatures, calls, latency, invalid items, fallback items, estimated
  paid cost, and unresolved results;
- no raw file, descriptions, source labels, or prompts in telemetry.

## 17. Delivery slices

### A. Reliability foundation

- versioned fingerprints and claims;
- request/file/payload identity and signed preview;
- `confirm_import_v2` with atomic flat + group persistence;
- full audit dispositions, multi-card mapping, server limits;
- Postgres concurrency/RLS and browser retry/re-import gates.

### B. Deterministic review intelligence

- merchant normalizer and exact/suppress memory semantics;
- source-category mappings;
- batch cascade with memory/mapping/rules;
- provenance/confidence UI, editable fields, bulk apply/undo;
- explicit mapping/memory opt-in persistence.

### C. Codex/paid-fallback enrichment

- internal authenticated batch endpoint;
- strict provider-neutral schema and bounded chunk orchestration;
- Codex-first, operational-failure-only provider-neutral paid fallback,
  disabled by default;
- progressive preview integration and adversarial/evaluation gates.

Each slice must leave import functional and safe if the next slice never ships.

## 18. Acceptance criteria

This design is complete when:

- every supported source can be uploaded, reviewed, confirmed, retried, and
  re-imported without silent duplicates;
- concurrent confirmation cannot create duplicate financial artifacts;
- Mercado Pago flat and installment artifacts commit atomically and map to the
  correct cards;
- every source row has an auditable disposition;
- batch counts and duplicate decisions are server/DB-derived;
- deterministic category suggestions use confirmed memory/source mappings/rules
  in the documented precedence order;
- users can bulk review and explicitly choose what the system learns;
- Codex receives only unresolved grouped signatures and never blocks import;
- paid fallback spend is bounded, observable, reserved only for actual attempts,
  and limited to operational Codex failures;
- AI cannot create taxonomy or persist unconfirmed categories;
- real Postgres/RLS and browser E2E prove upload through safe re-import;
- telemetry proves reliability/cost without logging raw financial content.

## 19. Open questions before implementation planning

1. Should future batch undo ship with slice A’s history UI or remain schema-only
   until after categorization?
2. What initial file/page/row limits match the family’s largest real exports?
3. Which real Minhas Finanças/Nubank export variants can be anonymized into the
   fixture matrix?
4. Should deterministic high-confidence suggestions start preselected, or only
   highlighted until one production evaluation calibrates acceptance rates?
