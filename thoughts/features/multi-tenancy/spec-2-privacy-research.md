# Spec 2 research: data privacy, encryption and LGPD

Date: 2026-09-29
Status: research input for spec 2. Nothing in the repository was changed.
Scope: `family-finance` monorepo (Next.js on Vercel, self-hosted Supabase and Telegram bot on a Hostinger VPS).
Author note: I am not a lawyer. The LGPD section is an engineering reading of primary sources; section 6.13 lists where paid legal review is needed.

---

## 1. Summary and recommendation

### The question

The product stores household financial data for more than one household. The operator (a solo developer) is root on the database host. The owner wants (a) the operator to be unable to read tenant data casually, (b) amounts protected, not only free text, and (c) real LGPD compliance if this becomes a paid product.

### Three findings that change the picture

1. **Encrypting amounts is much cheaper in this codebase than spec 1 assumed.** Spec 1 says encrypting amounts "moves arithmetic out of about 14 SQL functions". Reading the functions shows that almost none of them do arithmetic. Every dashboard aggregate already runs in TypeScript (`summarizeMonth`, `summarizeCardPressure`, `summarizeObligationsPressure` over rows fetched with `fetchAllRows`). No query sorts or filters by amount. The SQL functions treat amounts as values to validate and insert. Only five live functions touch amounts at all, and what they do is: positivity checks, one "parcels sum equals total" check, one 10% tolerance match, one equality check, and one `coalesce` default. All of these can move to application code while the RPCs keep their atomic writes.

2. **No server-side design gives a guarantee against the operator.** The operator deploys the code, administers Vercel, and is root on the VPS. Any key that a server can use, the operator can obtain by a deliberate act. Encryption with server-held keys turns "can read by browsing" into "must deliberately write code or extract a key to read". That is a real and worthwhile change, and it is exactly the threat model the owner chose ("hardened, no casual access"), but it must not be described to users as "we cannot see your data". Only a user-held key with client-side decryption approaches that claim, and it conflicts with the bot and server-side AI, which need standing access to plaintext.

3. **The largest privacy exposures today are not in the database.** They are: (a) the Codex CLI logged in with a personal ChatGPT subscription, which falls under consumer data controls where training is on unless switched off and for which no DPA exists; (b) unencrypted backups on the same host; (c) the VPS IP is registered to "Hostinger US", so the whole database may already be an international transfer; (d) `bot_interactions.message_text` kept forever. These are cheap to fix and should come before any cryptography.

### Recommended architecture

**Application-layer envelope encryption of all amounts and all free text, with per-household data keys, and no decryption key stored on the VPS.**

- Encrypt in the application (Next.js server on Vercel, and the bot), AES-256-GCM, one data key (DEK) per household.
- DEKs are stored wrapped by a key-encryption key (KEK). The KEK lives off the VPS: first as a Vercel sensitive environment variable, later in a cloud KMS.
- The bot does not hold the KEK. It obtains a household DEK from a small key-release endpoint on Vercel, keeps it in memory for a few minutes, and every release is logged off the VPS.
- Import fingerprints become HMACs keyed per household, because today's unkeyed SHA-256 over date, amount and description can be reversed by guessing.
- Backups are encrypted to a public key whose private half is never on the VPS, and copied off-site.
- Amount arithmetic and validation move to TypeScript; RPCs stay atomic and treat amounts and text as opaque ciphertext.

Rejected as the main path: in-database decryption with pgcrypto (the key would cross the operator's own host in clear on every request, and every read would need a view or RPC), targeted encryption of only income and balances (same schema cost as encrypting everything, leaks the rest), confidential computing (not realistic for one developer, and users cannot verify it).

### Phased path

| Phase | When | What | Size |
|---|---|---|---|
| 0 | Before the beta tester logs in | Fix AI provider settings and the Codex route, encrypted off-site backups, retention job for bot messages, privacy notice and disclosure, contact channel, incident runbook, confirm VPS location | S (days, mostly configuration and documents) |
| 1 | Spec 2 proper | Envelope encryption of amounts and free text, KEK on Vercel, bot key-release endpoint, keyed fingerprints, RPC refactor, backfill and purge of plaintext | L (3 to 5 weeks of focused work) |
| 2 | Before charging money | KMS with audit log, data-subject features (export, delete account, consent toggles), Telegram webhook handler moved off the VPS, database in Brazil or managed, contracts and legal review | M to L |
| 3 | Only if privacy becomes the product's selling point | User-held key ("private mode") for households that accept losing the bot's read features, or a TEE | XL |

### What we can truthfully tell a user, per phase

- **Today:** "Your data is isolated from other households by the database. The developer who runs the service has technical access to everything you enter, including amounts. Your messages and imported descriptions are sent to AI providers in the United States."
- **After phase 0:** the same, plus "Backups are encrypted and AI providers are configured not to train on your data. The developer has access and commits contractually not to look."
- **After phase 1:** "Amounts, descriptions and messages are encrypted before they reach the database. Someone who obtains the database or a backup cannot read them. The developer cannot read them by browsing the database; doing so would require deliberately extracting a key or changing the application. The service itself must decrypt your data to show it to you and to run the assistant."
- **After phase 2:** the same, plus "Every use of the master key is recorded in an audit log outside the database server. You can export or delete your data yourself."
- **After phase 3 (private mode only):** "Your household key is derived from a secret only you hold. The service can decrypt only while you are signed in. If you lose the secret and the recovery code, the data cannot be recovered by anyone."

Do not, at any phase, say "end-to-end encrypted", "zero knowledge" or "nobody but you can see your data". None of those would be true.

---

## 2. Option comparison

Sizes: S under a week, M one to two weeks, L three to five weeks, XL more than two months or a new skill domain.

| Option | Operator can still see (without a deliberate act) | Guarantee or effort-raiser | What breaks | Size | Ops burden | Key loss | Verdict |
|---|---|---|---|---|---|---|---|
| a. Plaintext amounts, encrypted text | All amounts, balances, income, dates, categories | Effort-raiser for text only | Nothing | M | Low | Text lost | Rejected by owner; rightly |
| b. App-side encryption of amounts and text | Row counts, dates, kinds, category and account links, membership, e-mails | Real guarantee against database or backup theft and cross-tenant leaks; effort-raiser against the operator | DB `CHECK`s on amounts, in-SQL invariants, `ilike` search, DB-side sort by description, unkeyed fingerprints | L | Medium (key custody) | Total loss of encrypted fields | **Recommended** |
| c. pgcrypto with per-request key | Same as b at rest; key and plaintext visible in the database process on the operator's host | Effort-raiser only, weaker than b | Every PostgREST table read must become a view or RPC; key exposure in logs | L to XL | High | Same as b | Reject |
| d. Targeted (balances, income) | All expenses and everything else | Effort-raiser for two facts | Little | S for balances; income costs the same as b | Low | Partial | Only as a first slice of b |
| e1. KEK in Vercel env, bot via key release | As b | Removes keys at rest from the VPS; effort-raiser against operator | Bot depends on Vercel availability | S on top of b | Low | Total unless escrowed | **Recommended with b (phase 1)** |
| e2. Cloud KMS | As b | Non-exportable key and audit trail; operator is still the account admin | Adds a cloud account and latency on cache miss | S to M on top of b | Medium | Total if key deleted; KMS has deletion delay | **Phase 2** |
| e3. Bot off the VPS | As b | VPS holds ciphertext only; trades root for console admin | Codex CLI needs a persistent container | M | Medium | n/a | Phase 2, partial (webhook handler only) |
| e4. User-held key | Ciphertext only while users are offline | Closest to a real guarantee; still trusts operator-served code | Bot reads, server AI, scheduled jobs; recovery UX | XL | High (support for lost keys) | **Permanent loss** unless recovery code | Phase 3, opt-in |
| e5. TEE / confidential computing | Ciphertext only, if attestation policy is honest | Strong in theory; operator controls the policy and users cannot verify | Whole deployment model | XL | Very high | Depends | Not now |
| f. Managed Postgres | Everything (operator is project owner) | No change against operator; real gain against infrastructure threats and for compliance paperwork | Self-hosted GoTrue config, JWT secret handling, cost | M | Lower than today | n/a | Decide before charging |

---

## 3. What the codebase actually does with amounts

This section is the evidence behind finding 1. File references are under `/Users/alvarocarvalho/desenv/personal/alvaro-e-karol/family-finance`.

### 3.1 Columns holding money

| Table | Column | Constraint today |
|---|---|---|
| `transactions` | `amount_cents` | `> 0` |
| `installments` | `amount_cents` | `> 0` |
| `installment_groups` | `total_amount_cents` | `> 0` |
| `obligations` | `amount_cents` | `> 0` |
| `import_rows` | `amount_cents` | `<> 0` |
| `investment_buckets` | `balance_cents` | `>= 0` |

Amounts are also embedded in `bot_conversations.state` (jsonb drafts) and `import_transaction_replacements.original_record` (jsonb copy of a replaced transaction).

### 3.2 SQL functions

28 migrations define 16 distinct functions (some with overloads and several redefinitions). Only five live ones touch amounts:

| Function (latest definition) | What it does with amounts | After encryption |
|---|---|---|
| `settle_card_bill` (0015) | Rejects null or `<= 0`, inserts | App validates; function inserts ciphertext |
| `create_installment_purchase` (0019) | Casts from JSON, inserts, compares stored total with payload for idempotent replay | Compare moves to a keyed hash of the payload or to the app; insert unchanged |
| `materialize_obligation_payment` (0018, 0024) | Rejects `<= 0`; `coalesce(target, obligation.amount_cents)`; copies `obligation.description` | Ciphertext copy works if the authenticated data binds household and field class, not row id (see 5.3) |
| `confirm_import_v2` (0028, about 700 lines) | Inserts; checks `sum(parcel amounts) = total`; matches an existing purchase within `least(1000, 10%)`; compares normalised descriptions | The three checks move to the app's preview step. The function already verifies `expected_group_updated_at`, so it can still prove that what the app checked has not changed since |
| `confirm_import_with_replacements` (0027) | `original.amount_cents is distinct from total`; compares `import_purchase_name(description)` | Same: app checks, function verifies `updated_at` |

Functions with no amount logic and no change needed: `is_household_member`, `merge_category`, `update_installment_group_category`, `provision_household_member`, `provision_on_allowlist`, `claim_import_suggestion_nonce`, `reserve_import_ai_paid_items`, `record_import_ai_paid_result`, `validate_import_item_claim_artifact`. The SQL helper `import_purchase_name` normalises descriptions and needs a TypeScript equivalent once descriptions are ciphertext. The legacy `confirm_import` (0004) should be dropped rather than ported.

There are no views, no materialised views, no triggers that compute on amounts, and no SQL that maintains `balance_cents` (it is set directly by `updateInvestmentBucketBalance`).

### 3.3 Application queries (`packages/db/src/repositories.ts`, 3,231 lines, 109 functions)

- 57 `.select(` calls, 24 writes, 10 `.rpc(` calls. 59 lines mention an amount column, 57 mention a free-text column.
- **Aggregation:** all in TypeScript already. `getMonthlySummary`, `getCardPressure`, `getCardPressureForCard`, `getObligationsPressure` fetch `kind, amount_cents` rows and sum in memory.
- **Filtering by amount:** none.
- **Sorting by amount:** none.
- **Sorting by text:** `order("description")` as a secondary key in `findUpcomingInstallments` and in `listObligations`; `order("name")` on categories, accounts, cards, buckets; `order("pattern")` and `order("normalized_label")` on memory tables.
- **Text search:** `ilike` on `description` in `findTransactionsFiltered` and on `description`/`purchase_description` in `findInstallmentPurchasesFiltered`.
- **Pagination:** range-based over `occurred_on, created_at`; unaffected unless combined with text search.
- **Mapping seam:** pure mappers already exist (`mapTransactionRow`, `transactionInsertFromDraft`, `mapObligationRow`, `installmentInsertsFromPlan`, and others). Encryption can be introduced at this seam without touching pages or the bot's conversation logic.
- The web app has no browser Supabase client; all data access is in server components and server actions (`apps/web/lib/supabase.ts`). Decryption therefore happens on Vercel, never in the browser and never on the VPS for web traffic.

### 3.4 Fingerprints

`packages/importers/src/identity.ts` builds `base_fingerprint` as an unkeyed SHA-256 of the normalised source row (date, amount, description, source metadata). The database stores it in `import_item_claims` and `import_rows` and uses it in unique indexes.

With encrypted amounts this becomes the weakest point: dates are visible, amounts have low entropy, merchant strings are guessable. An operator or thief can confirm guesses offline ("was there a R$ 12.500,00 'salario' row on the 5th?"). It must become `HMAC-SHA256(household fingerprint key, canonical row)`. The database logic is unchanged because it only compares 64-hex strings. This needs a new identity version (`import-row-v2`) and a one-time recomputation of stored claims from the decrypted `import_rows` fields. Note that `import_rows.original_description` only exists from migration 0028; older rows can be recomputed only if the stored normalised description equals the fingerprint input. This must be verified on production data before committing to the migration; the fallback is to keep v1 claims as they are and accept that pre-migration imports remain guessable.

---

## 4. Options in detail

### a. Plaintext amounts (baseline)

- **Operator sees:** every amount, salary (`kind = income` plus date), net worth (`balance_cents`), spending per category.
- **Breaks:** nothing.
- **Verdict:** the owner's objection is correct. In a finance product the numbers are the secret; descriptions are secondary. Encrypting only text would let a marketing claim of "encrypted" coexist with a fully readable ledger.

### b. Application-side encryption of amounts and text (recommended)

**What the operator still sees in the database:** number of rows and when they were created, transaction dates, kind (income, expense, transfer), which account, card and category each row links to, installment counts and due months, membership, Google e-mails in `auth.users`, Telegram ids. Category, account and card names too unless they are also encrypted (recommended in phase 2, see below). This metadata is not trivial: "one income row on the 5th of every month, forty expense rows, a transfer to a card on the 10th" is a readable pattern. Dates cannot be encrypted without losing month-range queries and pagination. This is the ceiling of option b and should be stated in the privacy notice.

**What breaks and how it is replaced:**

| Today | Replacement | Cost |
|---|---|---|
| Six `CHECK` constraints on amounts | Zod validation in the domain layer before encrypt; GCM authentication tag protects against corruption | Loses database-level defence against an application bug writing zero or negative values |
| In-RPC invariants (parcel sum, tolerance, equality) | Same checks in TypeScript during preview and confirm; RPC keeps the `updated_at` staleness check | The checks stop being atomic with the write, but the staleness check closes the gap |
| `ilike` search | In-memory filter after decrypt. With a month filter this is a few hundred rows. Without one it is the household's whole history: thousands of rows per year, tens of milliseconds to decrypt | Pagination with search becomes "fetch all, filter, slice" |
| `order("description")` as secondary sort | Sort in TypeScript after fetch (both cases are bounded lists) | Trivial |
| Unique constraints on text (`categories (household_id, name)`, `subcategories`, `source_category_mappings.normalized_label`, `categorization_memory.pattern`) | Add a blind-index column: `HMAC(household index key, normalised value)`, unique on that | One extra column per constrained field |
| Unkeyed fingerprints | Keyed HMAC (3.4) | Version bump and recomputation script |
| Studio and `psql` debugging | A small operator CLI that decrypts one household's row on purpose, logging the access | Support becomes slower; that is the point |

**Atomic RPCs:** they stay. They receive ciphertext strings and write them in one transaction exactly as now. They lose the ability to reason about values, not the ability to be atomic.

**Dedupe of manual entries** (`findManualExpensesBetween`, replacement matching): already fetches candidate rows by date range and compares in TypeScript in the import preview; works after decrypt.

**Implementation size: L.** Cost drivers, in order:
1. `confirm_import_v2` and `confirm_import_with_replacements` refactor and their tests (the largest and most delicate functions in the schema).
2. Expand-and-contract migration: add ciphertext columns, dual-write, backfill, switch reads, drop plaintext columns, then remove plaintext from dead tuples and old backups (4.b.1).
3. Codec layer at the repository mapper seam, including the jsonb blobs (`bot_conversations.state`, `original_record`).
4. Fingerprint v2.
5. Extending `deploy/checks/rls-proof.mjs` with a "no plaintext" proof: scan every text and numeric column of a seeded household for known plaintext values.

**Performance:** AES-256-GCM on values under 200 bytes costs a few microseconds each in Node. A year of one household (say 3,000 rows, two encrypted fields each) decrypts in well under 50 ms. Ciphertext adds about 40 bytes per value plus base64 overhead. Not a concern at any plausible scale for this product.

**Failure modes:**
- KEK lost: every household's encrypted data is unrecoverable. Mitigation in 5.5.
- One wrapped DEK row lost or corrupted: that household's data is unrecoverable. Mitigation: the wrapped DEK is tiny; store a second copy outside the database.
- Nonce reuse: avoided by random 96-bit nonces per value; at this volume the collision bound is irrelevant.
- Bug writes plaintext into a ciphertext column: prevented by a format check constraint on the column (`value ~ '^v1\.'`) and by the "no plaintext" proof in CI.

**4.b.1 Plaintext residue.** After backfill, plaintext persists in: dead tuples until `VACUUM FULL` or a dump-and-restore, WAL, the 14 nightly dumps, and any copy the operator made. The migration plan must include rewriting the tables and deleting every pre-migration backup once the new backups are verified. Otherwise the claim "encrypted at rest" is false for up to 14 days after cut-over, and indefinitely for stray copies.

### c. In-database decryption with pgcrypto and a per-request key

**How the key would travel:** the web server would send the household key in a request header; Traefik forwards to Kong, Kong to PostgREST, PostgREST exposes headers to SQL through the `request.headers` setting; functions call `pgp_sym_decrypt` or `decrypt` with `current_setting(...)`.

**Exposure points, all on the host the operator is root on:**
- Traefik and Kong see the header in clear after TLS termination. Access logs do not record arbitrary headers by default, but one configuration line changes that.
- PostgREST passes headers as a bound parameter; PostgreSQL logs bound parameters when `log_statement` or `log_min_duration_statement` fires, and in error context (`log_parameter_max_length_on_error`).
- `pg_stat_statements` normalises constants, so keys passed as parameters are not stored there, but any function that builds SQL dynamically with the key would leak it.
- The key and the plaintext exist in the database backend's memory on every request.
- A `SECURITY DEFINER` function owner (the operator) can redefine any function to copy the key into a table.

**What breaks:** PostgREST table reads return ciphertext. To get plaintext from SQL, every one of the 57 selects must go through a decrypting view or RPC. That is a larger rewrite than option b, not a smaller one, and it moves business reads into plpgsql.

**What it buys over b:** SQL-side sums and constraints inside RPCs. The codebase does not use SQL-side sums, so the benefit is close to zero here.

**Verdict:** reject. It is strictly weaker than b (the key visits the operator's machine on every request) and costs more.

### d. Targeted encryption (balances and income only)

- `investment_buckets.balance_cents`: one column, one writer, no RPC. Size S. Worth doing as the first slice of b because it validates the key plumbing end to end on the least risky table.
- Income amounts: `transactions.amount_cents` is one column shared by income and expense. Encrypting "only income" needs the same column type change, the same RPC changes and the same codec as encrypting everything, and then leaves expenses readable. It also makes encrypted rows stand out.
- **Verdict:** balances first as a pilot; do not stop there.

### e. Moving the key out of the operator's reach

The honest framing: for a solo developer there is no place that is out of his reach, only places that are out of his *casual* reach and places that *record* when he reaches. The options differ in how much deliberate effort is needed and whether evidence is left.

**e1. KEK in a Vercel sensitive environment variable; bot calls a key-release endpoint.**
- Vercel sensitive variables cannot be read back from the dashboard after creation; they are readable by deployed code. The operator can deploy code that prints it. That is a deliberate act that leaves a deployment record.
- The bot authenticates to the endpoint with an HMAC secret (the pattern already exists: `IMPORT_SUGGESTION_SHARED_SECRET`), asks for one household's DEK after resolving the Telegram sender, keeps it in memory with a short TTL, never writes it to disk or logs.
- Root on the VPS can read the bot's HMAC secret and call the endpoint, or dump the bot's memory. So: no guarantee, but no key at rest on the VPS, and each release is logged on Vercel.
- Failure mode: Vercel outage makes the bot unable to decrypt. Acceptable; the bot replies with a retry message.
- Size: S on top of b.

**e2. Cloud KMS (AWS KMS in `sa-east-1` or Google Cloud KMS in `southamerica-east1`).**
- The KEK is generated inside the KMS and cannot be exported. Wrap and unwrap are API calls. Cost is around one US dollar per key per month plus fractions of a cent per thousand calls; with DEK caching the call volume is tiny.
- Real gains: the key cannot be copied into a password manager or leak in an environment dump; permissions can be split (the provisioning script gets encrypt-only, the runtime gets decrypt-only); every unwrap is in an audit log; deletion has a mandatory waiting period, which protects against accidental key loss.
- Ceiling: the operator owns the cloud account and can grant himself decrypt. The audit log records it, but the only auditor is the operator. The value is discipline and evidence (useful in an ANPD inquiry or dispute), not prevention.
- Size: S to M on top of e1. Adds one more vendor and one more sub-processor entry (keys only, no personal data).

**e3. Moving the bot off the VPS.**
- The Telegram webhook handler is a stateless HTTP service that calls OpenAI, Anthropic and Whisper over HTTPS. It can run as a Vercel function.
- The Codex CLI subprocess cannot: it needs a persistent credential volume. It can stay on the VPS as a categorisation worker that receives only the row descriptions the web app already sends it (`/internal/v1/import-category-suggestions`), holds no key, and stores nothing.
- Result: the VPS holds ciphertext and sees transient descriptions during imports only. This is a clean property to explain and defends against VPS compromise and hosting-provider access. Against the operator it trades "root" for "Vercel admin".
- Size: M. Recommended in phase 2, after phase 1 proves the key-release flow.

**e4. User-held key component.**
- Users sign in with Google, so there is no password to derive a key from. Options: a separate passphrase (Argon2id), or a passkey with the WebAuthn PRF extension (support varies by browser and device; must be tested on the actual users' phones).
- Flow: the browser derives a key that unwraps the household DEK, then hands the DEK to the server for the session (the app is server-rendered). The server can decrypt only during sessions.
- Members: each member holds their own wrapping of the DEK. Adding a member requires an existing member to be online to wrap the DEK for the newcomer. Removing a member requires rotating the DEK and re-encrypting the household's data, otherwise the removed member's copy still works on any ciphertext they kept.
- **The bot problem:** Telegram messages arrive when no browser session exists. Either the household grants the bot a standing wrapped copy (which returns to the server-held model), or the bot becomes write-only: it encrypts new entries to a household public key and cannot read anything back. The current bot reads recent transactions, card bills, obligations, categories and categorisation memory, so write-only removes features (recent list, mark as paid, category memory).
- **Key loss is data loss.** A recovery code shown once at setup is the only mitigation that does not reintroduce operator access. Expect support requests from people who lost both.
- Ceiling: the operator serves the JavaScript and the server receives the DEK during sessions. A malicious operator can capture it. This protects data while users are offline and against everything short of a deliberate code change.
- Size: XL. Offer later as an opt-in "private mode", not as the default.

**e5. Confidential computing.**
- Options that exist: AWS Nitro Enclaves with KMS attestation conditions, Google Confidential Space, Azure confidential containers.
- For this product it means re-platforming the decrypting service into an enclave image, reproducible builds, an attestation-bound key policy, and a way for users to verify the measurement. The operator still controls the key policy. Without third-party audit, users gain nothing they can check.
- Verdict: not realistic now. Revisit only with revenue and an external auditor.

### f. Managed Postgres instead of the VPS

- **What it does not buy:** any reduction in operator access. The project owner has the SQL editor, the service-role key and the backups. Against the chosen threat model it changes nothing.
- **What it buys:** disk and backup encryption managed by the provider, point-in-time recovery, patching, a SOC 2 report and a signed DPA (useful evidence for LGPD art. 46 and for the sub-processor chain), and the ability to choose São Paulo as region, which removes the database from the international-transfer list. Supabase offers `sa-east-1` and a DPA that limits staff access to business need.
- **Cost:** around 25 US dollars per month on the Supabase Pro plan; migration of `auth.users`, GoTrue settings, Google OAuth callback and the JWT signing secret the bot uses for member-scoped tokens (spec 1, D5). Size M.
- **Cheaper alternative for residency only:** move the VPS to Hostinger's São Paulo data centre. Same operator access, same ops burden, but data stays in Brazil.
- **Verdict:** combined with option b, managed hosting gives the best overall posture, because the provider then sees only ciphertext for sensitive fields. It is a decision for "before charging money", not for the beta.

---

## 5. Key management design (for option b with e1, then e2)

### 5.1 Hierarchy

```
KEK  (one, versioned)            AES-256; phase 1: Vercel sensitive env var; phase 2: cloud KMS, non-exportable
 └─ DEK per household            256 random bits; stored only wrapped: household_keys(household_id, kek_version, wrapped_dek, created_at)
     ├─ field encryption key     HKDF(DEK, "enc/v1")   → AES-256-GCM
     ├─ blind index key          HKDF(DEK, "idx/v1")   → HMAC-SHA256 for unique constraints on text
     └─ fingerprint key          HKDF(DEK, "fp/v1")    → HMAC-SHA256 for import identities
```

### 5.2 Where each key lives

| Key | At rest | In memory | Never |
|---|---|---|---|
| KEK | Vercel env (phase 1) or KMS (phase 2); one offline recovery copy (5.5) | Vercel functions (phase 1 only) | VPS, repository, backups, logs |
| Wrapped DEK | `household_keys` table; second copy outside the database | n/a | n/a |
| Plain DEK | Nowhere | Vercel function instance, bot process; TTL of minutes | Disk, logs, database, `bot_conversations` |
| Bot HMAC secret | `deploy/bot/.env` on the VPS | Bot process | Repository |
| Backup private key | Operator's password manager and one offline copy | Only during a restore | VPS |

### 5.3 Ciphertext format

`v1.<dek_version>.<nonce>.<ciphertext+tag>` as text. Authenticated data: `household_id || field class` (for example `amount`, `text`, `json`).

Deliberate call: the authenticated data does not include the row id. Reason: `materialize_obligation_payment` copies amount and description from `obligations` to `transactions` inside SQL, and `confirm_import_with_replacements` copies a whole transaction into `original_record`. Binding to row id would force those copies through the application. Consequence to accept: someone with write access to the database can swap two ciphertexts of the same class within one household. They cannot read them or move them across households.

Amounts are encrypted as decimal strings padded to a fixed length so that ciphertext length does not reveal magnitude.

### 5.4 Rotation

| Event | Action | Cost |
|---|---|---|
| KEK rotation (yearly, or on suspicion) | New KEK version; rewrap every DEK; one row per household | Seconds |
| DEK rotation (household asks, or suspected exposure) | New DEK version; background re-encryption of that household's rows; readers accept both versions during the run | Minutes per household |
| Bot HMAC secret rotation | Change in both environments | Restart |
| Backup key rotation | New key pair; old private key kept until old backups expire | 14 days overlap |

### 5.5 Backup and recovery

- **Database backups:** `pg_dump | age -r <public key>`, uploaded to object storage outside the VPS, 14-day retention, monthly restore test into a scratch database. The VPS holds only the public key. This protects the fields that stay in plaintext (e-mails, metadata) and everything else during the migration window.
- **KEK recovery:** losing the KEK loses all tenant data. In phase 1, keep one copy in the operator's password manager and one printed copy in a sealed envelope stored away from the computer. In phase 2, the KMS holds it; enable key deletion protection and the maximum deletion waiting period.
- Be plain about this: a recovery copy of the KEK means the operator can decrypt. That is inherent in any design where the service can recover data for users. The alternative (no recovery copy) trades privacy for a real risk of losing every customer's data to one mistake.
- **Deletion and crypto-shredding:** deleting a household deletes its wrapped DEK (both copies) and its rows. Backups taken before deletion still contain the wrapped DEK and remain decryptable until they expire. The privacy notice should therefore state "removed from backups within 14 days", which is true.

### 5.6 Membership changes

In the server-held model members never hold key material. Access is an active `household_members` row enforced by RLS (spec 1, D3).

- **Member added:** no key operation.
- **Member removed:** no key operation; the row is deactivated and RLS denies access. DEK rotation is optional.
- **Household deleted:** crypto-shred as above.

(In the phase 3 user-held model, add requires an online existing member and remove requires DEK rotation; see e4.)

### 5.7 How the bot gets access

1. Telegram update arrives. The bot resolves the sender to `(household_id, user_id)` through the narrow resolver from spec 1.
2. The bot requests the DEK for that household from `POST /internal/v1/household-key` on the web deployment. The request carries household id, user id, a timestamp and a nonce, signed with the bot's HMAC secret. The endpoint verifies the signature, freshness, nonce and that the user is an active member, then unwraps and returns the DEK over TLS.
3. The endpoint writes one log line per release: time, household, requester, reason. No key material.
4. The bot caches the DEK in memory for a short TTL keyed by household, uses it to decrypt what it reads and to encrypt what it writes, and drops it on expiry or restart.
5. `bot_conversations.state` and `bot_interactions.message_text` are encrypted with the same DEK before being stored.
6. Text sent to OpenAI, Anthropic or Whisper is necessarily plaintext. Encryption at rest does not change what AI providers receive.

Phase 2 variant: the webhook handler runs on Vercel and unwraps locally; step 2 disappears for Telegram traffic.

### 5.8 Provisioning

`scripts/create-household` (spec 1) must create the DEK. The operator's laptop should not handle the KEK. Phase 1: the script calls an authenticated admin endpoint on Vercel that generates and wraps the DEK. Phase 2: the script generates the DEK locally and wraps it with a KMS identity that has encrypt permission only.

---

## 6. LGPD analysis

Primary sources were read directly where marked "verified". Items marked "not verified" rely on secondary sources or could not be fetched.

### 6.1 Roles

| Party | Role | Reasoning |
|---|---|---|
| The developer, as provider of the service | **Controller** (controlador) | Decides purposes and means: what is collected, which AI providers are used, retention |
| OpenAI, Anthropic, Vercel, Hostinger, future KMS or database provider | **Operators** (operadores, the LGPD term for processors) | Process on the controller's behalf under their API or hosting terms |
| Google (sign-in) and Telegram (messaging) | Most likely **independent controllers** for their own platforms | The user has a direct relationship with each; the developer still must disclose them and, for Telegram, is responsible for choosing it as a channel |
| Household members | **Data subjects** (titulares) | Also third parties named in descriptions (an employer, a domestic worker, a landlord) are data subjects whose data the user enters |

Terminology trap: in this project "operator" means the developer who runs the servers. In LGPD, "operador" means processor. The developer is the controller, not the operador.

**Household exemption (art. 4, I)** — verified text: the law does not apply to processing "realizado por pessoa natural para fins exclusivamente particulares e não econômicos".
- It plausibly covers a **user** recording their own family's finances, including names of third parties, for private purposes.
- It plausibly covered the developer while the only household was his own family.
- It does **not** cover the developer providing the service to another household. He is not processing for his own private purposes, and a beta of something intended to become a paid product is hard to describe as "exclusively non-economic". Treat LGPD as fully applicable from the first external user, paid or not. Needs legal confirmation.

### 6.2 Is financial data "sensitive personal data"?

**No, not by the legal definition.** Art. 5, II (verified) lists: racial or ethnic origin, religious conviction, political opinion, membership of a union or of a religious, philosophical or political organisation, data concerning health or sex life, genetic or biometric data. Financial data is not on the list.

Three qualifications that matter in practice:
1. **Inference.** Transaction descriptions can reveal listed categories: pharmacy and therapy (health), tithes (religion), union dues, political donations. Art. 11, §1 extends the sensitive-data regime to processing that reveals sensitive data and may cause harm. Free text in a finance app should be treated as potentially sensitive.
2. **ANPD treats financial data as high-impact.** The incident regulation lists "dados financeiros" among the criteria that make an incident reportable (Resolução CD/ANPD 15/2024, art. 5; read through a secondary mirror of the official text).
3. **Banking secrecy** (Lei Complementar 105/2001) binds financial institutions. This product is not one and does not connect to banks; users upload their own statements. Not verified beyond that; confirm with counsel if Open Finance integration is ever considered.

So the common statement "financial data is sensitive under LGPD" is legally wrong, but designing as if it were is the right engineering posture.

### 6.3 Legal bases per purpose

| Purpose | Suggested basis | Note |
|---|---|---|
| Account, ledger, imports, dashboards | Contract execution, art. 7, V | Requires terms of use the user accepts |
| Telegram bot text interpretation by AI | Contract execution if described as part of the service; otherwise consent, art. 7, I | If consent, it must be revocable without losing the rest of the product |
| Voice notes sent to Whisper | Consent recommended | Voice is more intrusive and optional; a voiceprint is not extracted, so it is not biometric processing, but say so explicitly |
| AI categorisation of imports | Contract execution | Offer a manual-only switch |
| Security logs, abuse prevention, AI usage telemetry without content | Legitimate interest, art. 7, IX | Keep a short written balancing test; art. 37 asks for records especially for this basis |
| Access logs kept six months | Legal obligation, art. 7, II | Marco Civil da Internet, art. 15, applies to application providers that are legal entities acting professionally; relevant once a company exists |
| Invoices and tax records | Legal obligation | Only when charging |
| Improving prompts using real user messages | Avoid, or separate consent | The evaluation corpus in `apps/bot/src/evaluation` must not contain tenant data |

Consent must not be the basis for the core service: it can be revoked at any time (art. 8, §5), and then the service would have to keep working.

### 6.4 Data subject rights and the features they imply

Art. 18 (verified) grants: confirmation, access, correction, anonymisation or blocking or deletion of unnecessary data, portability, deletion of consent-based data, information about sharing, information about refusing consent, and revocation of consent. Art. 19 sets the only statutory deadline: simplified answer immediately, or a complete declaration within 15 days. General deadlines for art. 18 requests are left to regulation; ANPD has the data-subject-rights regulation on its 2025-2026 agenda and, as far as I could find, has not issued it (not verified beyond secondary sources). Small agents get double time (Resolução 2/2022, art. 14) and may give the simplified declaration within 15 days (art. 15).

| Right | Feature | Phase |
|---|---|---|
| Confirmation and access | "My data" page; one-click export | 2 (manual on request in phase 0) |
| Portability | Export as JSON and CSV: transactions, installments, obligations, categories, accounts, buckets, bot interactions | 2 |
| Correction | Exists for ledger data; add editing of display name and Telegram link | Mostly exists |
| Deletion | Delete my account; delete household with crypto-shredding; stated backup expiry | 2 (manual script in phase 0) |
| Consent revocation | Per-member switches: voice, AI interpretation | 2 |
| Information on sharing | Public sub-processor list in the privacy notice | 0 |
| Petition and contact | Published e-mail channel | 0 |

**Design question specific to households:** the ledger is joint. If one member asks for deletion, the household's transactions are also other members' data. Suggested rule: deleting a member removes the account, profile, Telegram link and their bot messages, and replaces their id in ledger rows with "former member"; the ledger is deleted only when the household is deleted. Put this in the terms. Needs legal review.

### 6.5 International transfer

Art. 33 (verified) allows transfer only under listed mechanisms. There is no ANPD adequacy decision for the United States. ANPD recognised the European Union as adequate in January 2026 (Resolução CD/ANPD 32/2026; secondary sources), which helps only if processing is placed in the EU.

| Recipient | Data | Location | Notes |
|---|---|---|---|
| OpenAI | Bot message text, voice audio, import row descriptions and amounts | United States | API offers data residency regions, none in Brazil |
| Anthropic | Same as OpenAI when configured as fallback | United States | |
| Vercel | All data in transit and in function memory; logs | United States by default; function region is configurable | Setting the function region to São Paulo reduces but does not remove transfer |
| Hostinger VPS | Entire database and bot | **Not stated in the deploy docs.** The IP `2.24.71.244` is registered as "Hostinger US" | **Open question.** Registration country is not proof of data-centre location; check the Hostinger panel |
| Telegram | All bot conversations | Outside Brazil | Bot chats are cloud chats, not end-to-end encrypted |
| Google | Sign-in identity | Global | Scopes limited to `openid`, `email`, `profile` |

Mechanisms realistically available to a solo developer:
1. **Art. 33, IX with art. 7, V:** transfer necessary to perform the contract with the data subject. Fits AI interpretation when it is part of the contracted service. Probably the most workable basis.
2. **Art. 33, VIII:** specific, highlighted consent for the transfer, with prior information that it is international. Simple for a beta tester; brittle at scale because it can be revoked.
3. **Standard contractual clauses, art. 33, II, b:** Resolução CD/ANPD 19/2024 (verified on gov.br) requires ANPD's clauses to be adopted in full and without changes, and the grace period ended on 23 August 2025. Whether OpenAI, Anthropic and Vercel offer ANPD's clauses in their DPAs is **not verified**; their public DPAs are built around EU clauses. A solo developer cannot negotiate this.

Transparency duties under Resolução 19/2024, art. 17: publish form, duration and purpose of the transfer, destination country, controller identity and data subject rights; answer requests for the clauses within 15 days.

Practical reduction of transfer: database in São Paulo, Vercel functions in São Paulo, and send AI providers the minimum text needed. The transfer to AI providers remains and must be disclosed.

This section needs legal review more than any other.

### 6.6 Sub-processors, contracts and provider settings

| Provider | Contract to have on file | Settings to apply |
|---|---|---|
| OpenAI API | Accept the DPA under the API organisation | API data is not used for training by default (verified on OpenAI's documentation). Abuse-monitoring logs are kept up to 30 days. Do not set `store: true`. Zero Data Retention exists for `/v1/chat/completions`, `/v1/responses` and `/v1/audio/transcriptions` but requires approval through sales; request it, expect that a small account may not get it |
| **Codex CLI with ChatGPT login** | **None available.** Consumer plans have no DPA | OpenAI's help centre states that ChatGPT data controls apply to Codex and content may be used to improve models unless training is switched off (the help page returned 403 to my fetch; statement taken from search-result excerpts, so **partially verified**). **Action:** switch off "improve the model for everyone" now. For households other than the developer's own, do not route data through the personal subscription: set the import path to the paid API fallback that already exists (`IMPORT_PAID_FALLBACK_*`). Using a personal subscription to process customers' data may also conflict with the consumer terms (not verified) |
| Anthropic API | Commercial terms and DPA | Inputs and outputs deleted within 30 days; up to 2 years if flagged for policy violation; no training on commercial API data (verified on Anthropic's privacy centre, training statement via secondary source) |
| Vercel | DPA | Mark secrets as sensitive; set function region; confirm no request bodies are logged |
| Hostinger | DPA or terms | Confirm data-centre location; consider São Paulo |
| Telegram | Bot developer terms | Bots must have a privacy policy; disclose that chats are stored by Telegram. Recommend users talk to the bot in a private chat |
| Google | OAuth terms | Minimal scopes (already so); consent screen in production |
| Future: KMS provider, backup storage, managed database | DPA each | Backup storage holds only encrypted files |

### 6.7 Security measures (arts. 46 to 49)

Art. 46 (verified) requires technical and administrative measures from the design phase. Art. 48, §3 says that when ANPD judges the gravity of an incident it considers whether measures made the data unintelligible. That is the direct legal payoff of option b: a stolen backup containing only ciphertext is a far less serious incident.

ANPD's security guide for small agents (2021) is the practical benchmark. Minimum set for this product:

- Encryption in transit everywhere (exists) and at rest for sensitive fields (phase 1).
- Encrypted, off-site, tested backups (phase 0).
- Access control: Supabase Studio not publicly reachable; SSH by key only; two-factor on Google, Vercel, Hostinger, OpenAI, Anthropic, registrar and GitHub accounts.
- Secrets only in environment stores, rotated on schedule.
- Patch cadence for the VPS and the pinned Supabase tag.
- Logs without personal content (the AI telemetry record in `apps/bot/src/ai-telemetry.ts` already contains only metadata; keep the deploy smoke check that asserts descriptions are absent from bot logs).
- A short written information-security policy (a simplified one is allowed for small agents, Resolução 2/2022, art. 13).
- The two-household `rls-proof` from spec 1, run on every deploy.

### 6.8 Incidents

Resolução CD/ANPD 15/2024 (read through mirrors of the official text):

- Notify **ANPD and the affected data subjects** when an incident may cause relevant risk or harm. Financial data is one of the listed criteria.
- Deadline: **three working days** from knowing that personal data was affected. **Six working days** for small agents.
- Content follows art. 48, §1 of the law: nature of data, subjects involved, security measures in place, risks, reasons for any delay, mitigation.
- Keep a record of **every** incident, including those not reported, for at least **five years**.

Needed: a one-page runbook (who decides, ANPD form location, user message template in Portuguese) and an incident log file. Both are phase 0 documents.

### 6.9 Retention and deletion

Art. 16 (verified): data is deleted at the end of processing, except for legal obligation and a few other cases. Proposed schedule, to be decided by the owner:

| Data | Today | Proposal |
|---|---|---|
| Ledger (transactions, installments, obligations, buckets) | Indefinite | While the account exists; deleted within 30 days of account deletion |
| `bot_interactions.message_text` and `explanation` | Indefinite | Clear the text after 90 days; keep the row's metadata for audit |
| `bot_conversations.state` | 24 hours | Keep; encrypt |
| `import_rows` (`description`, `original_description`, amounts) | Indefinite | Needed for deduplication only through fingerprints; clear text and amounts after 12 months, keep fingerprints |
| `import_transaction_replacements.original_record` | Indefinite | Same as ledger; encrypt |
| `categorization_memory.pattern` | Indefinite | While the account exists |
| AI usage telemetry (`import_ai_usage`) | Indefinite | No content; 12 months |
| Container and Vercel logs | Platform default | No content; 30 to 90 days |
| Backups | 14 days on the VPS | 14 days, encrypted, off-site |
| Access logs | Not collected deliberately | Six months once a company exists (Marco Civil, art. 15) |
| Voice audio | Not stored | Keep it that way; say so in the notice |

### 6.10 Records of processing, DPO, small-agent regime

Resolução CD/ANPD 2/2022 (verified on gov.br):
- Small agents include micro and small companies, startups, and **natural persons** who process personal data (art. 2, I). A solo developer qualifies by size.
- Benefits: simplified record of processing (art. 9), no obligation to appoint a DPO provided a communication channel exists (art. 11), simplified security policy (art. 13), double deadlines (art. 14).
- **Exclusion:** agents doing **high-risk** processing lose these benefits (art. 3, I). High risk needs one general and one specific criterion (art. 4):
  - general: large scale, **or** processing that may significantly affect data subjects' interests and fundamental rights, with examples including material harm and financial fraud;
  - specific: **use of emerging or innovative technologies**, surveillance of public areas, solely automated decisions, or sensitive data or data of children, adolescents or the elderly.

**This product is at real risk of being classified as high-risk.** It processes financial data (arguably meeting the second general criterion) and uses generative AI (which ANPD materials give as an example of emerging technology). ANPD's guide on high-risk processing was put to consultation and not approved (secondary sources), so there is no official test to rely on.

Recommendation: do not build the compliance posture on the exemptions. The expensive-looking obligations are cheap for one person:
- Appoint yourself as encarregado and publish name and contact (Resolução CD/ANPD 18/2024 allows accumulation of functions where there is no conflict of interest; whether a sole controller acting as his own encarregado is a conflict is a question for counsel).
- Keep a full but short record of processing activities: purpose, basis, data categories, recipients, transfer, retention, security. One page per purpose.
- Plan for three working days on incidents, not six.
- Write a short data protection impact assessment (RIPD). ANPD can request one (art. 38), and it is the natural place to document the encryption design.

### 6.11 Privacy notice and terms

The notice (art. 9, verified) must state, in clear Portuguese:
- specific purposes; form and duration of processing;
- controller identity and contact; encarregado or contact channel;
- sharing: the sub-processor list with purpose and country;
- international transfers and their basis;
- retention periods, including backups;
- data subject rights under art. 18 and how to exercise them;
- security measures in honest terms, including the statement from section 1 about who can see data;
- that voice audio is transcribed by a third party and not stored;
- that the service is not a financial institution and gives no financial advice.

The terms of use must contain: service description, beta status and no availability guarantee, household model and the joint-ledger deletion rule, acceptable use, what happens on cancellation, liability limits consistent with the consumer code, governing law and forum.

### 6.12 Before one unpaid beta tester versus before charging

| Item | Before the beta tester | Before charging |
|---|---|---|
| Privacy notice in Portuguese, published | Required (short version) | Full version |
| Sub-processor and international transfer disclosure | Required | Required |
| Explicit, recorded acceptance from each member (not only the person who was invited) | Required | Required, in-product |
| Contact channel for data requests | Required | Required |
| Codex personal subscription not used for tenant data; training switched off | Required | Required |
| OpenAI and Anthropic accounts under API terms with DPA accepted | Required | Required |
| Encrypted off-site backups | Required | Required |
| Incident runbook and incident log | Required | Required |
| Record of processing activities | Required (one page) | Full |
| Manual export and deletion on request | Required | Replaced by self-service |
| Retention job for bot messages | Recommended | Required |
| Field encryption (phase 1) | Recommended; disclose its absence | Required in practice |
| VPS location confirmed and disclosed | Required | Data in Brazil recommended |
| Terms of use | Short beta agreement | Full terms reviewed by a lawyer |
| Legal entity (CNPJ), invoices, tax records | No | Required |
| Encarregado named | Recommended | Required unless counsel confirms the exemption |
| Impact assessment (RIPD) | Recommended | Required in practice |
| Self-service export, deletion, consent switches | No | Required in practice |
| Transfer mechanism confirmed by counsel | No (rely on disclosure and consent) | Required |
| Consumer-law review (Código de Defesa do Consumidor), payment provider DPA | No | Required |

LGPD makes no exception for unpaid or small-scale services to third parties. The difference between the two columns is risk tolerance and proportionality, not legal applicability.

### 6.13 Where to get legal review

1. Whether art. 4, I covers anything once an external household exists.
2. High-risk classification and therefore whether the small-agent benefits apply.
3. Legal basis for AI processing and the international transfer mechanism, including whether providers' DPAs satisfy Resolução 19/2024.
4. Whether the developer can be his own encarregado.
5. The joint-ledger deletion rule.
6. Terms of use, liability and consumer law before charging.
7. Use of the Codex subscription for third-party data under OpenAI's terms.

### 6.14 Not verified

- Planalto blocked the automated fetch tool; the law text was downloaded directly from planalto.gov.br and the quoted articles (4, 5, 7, 9, 16, 18, 19, 33, 37, 39, 41, 46, 48, 49) were read from that file. Art. 11, §1 and art. 38 are cited from memory of the law and were not re-read.
- Resolução 15/2024 was read through LegisWeb, not the Diário Oficial.
- Resolução 18/2024 and Resolução 32/2026 are cited from secondary sources.
- The OpenAI help article on Codex and ChatGPT plans could not be fetched (HTTP 403).
- Anthropic's no-training commitment for API data is cited from secondary summaries of its commercial terms.
- Hostinger's DPA and the VPS's physical location.
- Whether any provider offers ANPD's standard clauses.
- Marco Civil art. 15 and Lei Complementar 105/2001 are cited from prior knowledge, not re-read.
- ANPD was converted into the Agência Nacional de Proteção de Dados by Lei 15.352/2026 (news sources from the Chamber and Senate); existing resolutions are assumed to remain in force.

---

## 7. Decisions the owner must make

| # | Decision | Recommendation |
|---|---|---|
| 1 | Accept that the phase 1 promise is "no casual access", not "cannot access" | Accept, and use the wording in section 1 |
| 2 | Encrypt all amounts and free text (option b) | Yes |
| 3 | Encrypt names of categories, accounts, cards and buckets | Yes, in phase 2, with blind indexes |
| 4 | Accept losing database `CHECK`s and in-SQL invariants on amounts | Yes, with application validation and a CI "no plaintext" proof |
| 5 | Accept that dates, kinds and links stay visible | Yes; disclose it |
| 6 | KEK location for phase 1: Vercel env or KMS immediately | Vercel env first; KMS in phase 2 |
| 7 | KEK recovery copy exists (operator can decrypt) or not (one mistake loses everything) | Keep a recovery copy |
| 8 | Text search: in-memory filter, or drop search without a month filter | In-memory |
| 9 | Fingerprint migration: recompute old claims or leave v1 | Recompute if production data allows; verify first |
| 10 | Codex for tenant households | Off for every household except the developer's own, from phase 0 |
| 11 | Voice notes for tenants | Opt-in with consent |
| 12 | Retention periods (6.9) | As proposed |
| 13 | Joint-ledger deletion rule (6.4) | As proposed, pending counsel |
| 14 | Where the database lives: current VPS, São Paulo VPS, or managed São Paulo | Confirm current location now; decide on managed before charging |
| 15 | Move the Telegram webhook handler to Vercel | Phase 2 |
| 16 | Offer a user-held-key private mode | Defer; revisit with paying customers |
| 17 | Whether the tester onboards before phase 1 | Acceptable if phase 0 is done and the absence of encryption is disclosed in writing (spec 1 already plans the disclosure) |
| 18 | Budget for a lawyer | Before charging at the latest; a one-hour consult before the beta is cheap insurance |

---

## 8. Sources

### Repository (read, not modified)

- `thoughts/features/multi-tenancy/design.md`
- `docs/decisions/0002-rls-and-household-isolation.md`
- `deploy/README.md`, `deploy/supabase/README.md`, `deploy/vercel.md`
- `supabase/migrations/0001` to `0028`, in particular `0015`, `0018`, `0019`, `0024`, `0026`, `0027`, `0028`
- `packages/db/src/repositories.ts`
- `packages/importers/src/identity.ts`
- `apps/bot/src/ai-telemetry.ts`, `apps/bot/src/interpret.ts`, `apps/web/lib/supabase.ts`

### Law and regulation

- LGPD, Lei 13.709/2018: https://www.planalto.gov.br/ccivil_03/_ato2015-2018/2018/lei/l13709.htm
- Resolução CD/ANPD 2/2022 (small agents): https://www.gov.br/anpd/pt-br/acesso-a-informacao/institucional/atos-normativos/regulamentacoes_anpd/resolucao-cd-anpd-no-2-de-27-de-janeiro-de-2022
- Resolução CD/ANPD 15/2024 (incident communication), mirror: https://www.legisweb.com.br/legislacao/?id=458235
- ANPD news on the incident regulation: https://www.gov.br/anpd/pt-br/assuntos/noticias/anpd-aprova-o-regulamento-de-comunicacao-de-incidente-de-seguranca
- Resolução CD/ANPD 19/2024 (international transfer): https://www.gov.br/anpd/pt-br/acesso-a-informacao/institucional/atos-normativos/regulamentacoes_anpd/resolucao-cd-anpd-no-19-de-23-de-agosto-de-2024
- ANPD page on international transfer: https://www.gov.br/anpd/pt-br/assuntos/assuntos-internacionais/transferencia-internacional-de-dados
- End of the grace period for standard clauses (Mayer Brown): https://www.mayerbrown.com/pt/insights/publications/2025/08/end-of-grace-period-implementation-of-brazils-standard-contractual-clauses-in-international-transfers-of-personal-data
- Brazil and EU mutual adequacy (Serpro): https://www.serpro.gov.br/menu/noticias/noticias-2026/brasil-e-uniao-europeia-reconhecem-adequacao-em-protecao-de-dados-efeitos-sobre-fluxos-internacionais
- Resolução CD/ANPD 18/2024 (encarregado), copy: https://www.ipea.gov.br/protecaodedados/arquivos/Resolucao_cd_regulamento_atuacao_encarregado.pdf
- ANPD security guide for small agents: https://www.gov.br/anpd/pt-br/centrais-de-conteudo/materiais-educativos-e-publicacoes/guia-orientativo-sobre-seguranca-da-informacao-para-agentes-de-tratamento-de-pequeno-porte
- ANPD high-risk guide not approved (Mattos Filho): https://www.mattosfilho.com.br/unico/anpd-guia-dados-risco/
- ANPD data subject rights page: https://www.gov.br/anpd/pt-br/assuntos/titular-de-dados-1/direito-dos-titulares
- ANPD becomes an agency, Lei 15.352/2026 (Câmara): https://www.camara.leg.br/noticias/1248401-entra-em-vigor-lei-que-cria-a-agencia-nacional-de-protecao-de-dados/

### Providers

- OpenAI API data controls: https://developers.openai.com/api/docs/guides/your-data
- OpenAI enterprise privacy: https://openai.com/enterprise-privacy/
- OpenAI, Codex with a ChatGPT plan (not fetched, HTTP 403): https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan
- Anthropic retention for organisations: https://privacy.claude.com/en/articles/7996866-how-long-do-you-store-my-organization-s-data
- Anthropic API and data retention: https://platform.claude.com/docs/en/manage-claude/api-and-data-retention
- Vercel DPA: https://vercel.com/legal/dpa
- Vercel environment variables: https://vercel.com/docs/environment-variables/managing-environment-variables
- Supabase DPA: https://supabase.com/legal/customer-resources/data-processing-addendum
- Supabase regions: https://supabase.com/regions
- Hostinger São Paulo data centre: https://www.hostinger.com/blog/brazilian-vps-data-center/
- Telegram end-to-end encryption scope: https://core.telegram.org/api/end-to-end
