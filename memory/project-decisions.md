# Project Decisions

Record durable decisions here. Keep entries short and revisit them when new evidence appears.

## 2026-06-22: MVP Shape

**Decision:** Build a hybrid MVP: Telegram-first quick entry plus historical import during onboarding.

**Why:** Quick entry creates daily value, while imported history gives categorization and dashboard context.

**Revisit if:** Import complexity blocks Telegram validation for too long.

## 2026-06-22: Platform

**Decision:** Use a responsive Next.js web app on Vercel with Supabase/Postgres.

**Why:** Fastest path to private family usage with a solid database and auth foundation.

**Revisit if:** Supabase Auth/RLS creates friction that outweighs its benefits.

## 2026-06-22: Auth

**Decision:** Google login with allowed emails only.

**Why:** The product is private to the family. Public signup is out of scope.

**Revisit if:** More family members need access or email identities become inconvenient.

## 2026-06-22: Bot Channel

**Decision:** Telegram first, WhatsApp later.

**Why:** Telegram is simpler to integrate and validate with text/audio during MVP.

**Revisit if:** Telegram usage does not match the family’s real habits.

## 2026-06-22: Workspace Baseline And Package Boundaries

**Decision:** Single shared strict `tsconfig.base.json` extended by every package/app; uniform `build`/`typecheck`/`test` scripts; package responsibilities and dependency direction documented in `docs/decisions/0001-package-boundaries.md`. No custom TS `paths` aliases (workspace package names already resolve everywhere).

**Why:** Feature agents must run root scripts without guessing per-package commands and must not re-invent boundaries. The hard rule "domain must not import web/bot/db/AI" is recorded once.

**Revisit if:** Build/typecheck times justify TypeScript project references, or a tool stops resolving workspace package names and aliases become necessary.

## 2026-06-22: Domain Core Contracts

**Decision:** The pure domain (`packages/domain`) is the single source of transaction rules. Money is BRL integer cents only (`MoneyAmount`). Transactions are created via `createTransactionDraft` and parcelado card purchases via `createInstallmentPlan`, both returning a structured `DomainResult` (`ok:false` carries field/code/message errors) instead of throwing for expected user mistakes. Payment is a discriminated union (`account` | `card`); responsibility defaults to household unless `responsibleUserId` is set; `createdByUserId` is always recorded. Installments carry a month attribution (`dueMonth` = `YYYY-MM`), not invoice timing.

**Why:** Web app and bot must create transactions through one contract so logic is not re-implemented per channel. Month-attributed installments let the dashboard project card pressure without a full invoice system.

**Revisit if:** Multi-currency is needed, or the dashboard needs real invoice/closing-day timing (then installment due-month derivation must use `CreditCard.closingDay`).

## 2026-06-22: Schema And RLS (Household Isolation)

**Decision:** The MVP Postgres schema (`supabase/migrations/0001_initial_schema.sql`) enables RLS on every table from day one. Access is granted only to active members of a row's `household_id`, via a single `SECURITY DEFINER` helper `is_household_member(household_id)` keyed on `household_members` + `auth.uid()`. Money is integer cents with `> 0` CHECKs; `transaction_kind`/`account_kind` are enums; confidence is `numeric(4,3)` CHECK `[0,1]`; payment is account-XOR-card; responsibility defaults to household with a CHECK that `responsible_user_id` is set iff scope is `user`. Import batches store only source/status/counts/notes — never the raw file. `packages/db` exposes hand-written static types (`types.ts`) and domain-named, RLS-aware repositories (`repositories.ts`) reusing `@family-finance/domain` contracts.

**Why:** Private finance app; retrofitting isolation later is expensive. One shared membership helper keeps policies consistent and non-recursive. Static DB types let the package typecheck with no live Supabase.

**Revisit if:** A second household/shared-resource scenario appears; real invoice timing is needed (installment `due_month` derivation changes); or generated Supabase types replace the hand-written ones. Details in `docs/decisions/0002-rls-and-household-isolation.md`.

## 2026-06-22: Import Privacy

**Decision:** Do not permanently store raw imported CSV/XLSX files.

**Why:** Financial exports are sensitive, and re-uploading is acceptable when reprocessing is needed.

**Revisit if:** Reprocessing becomes frequent enough to justify encrypted temporary retention.

