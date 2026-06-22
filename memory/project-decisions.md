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

## 2026-06-22: Import Privacy

**Decision:** Do not permanently store raw imported CSV/XLSX files.

**Why:** Financial exports are sensitive, and re-uploading is acceptable when reprocessing is needed.

**Revisit if:** Reprocessing becomes frequent enough to justify encrypted temporary retention.

