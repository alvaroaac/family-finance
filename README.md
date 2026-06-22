# Family Finance

Private family finance MVP for Alvaro and Karol.

## Structure

- `apps/web`: Next.js web app.
- `apps/bot`: Telegram bot.
- `packages/*`: shared domain, database, import, categorization, and config code.
- `supabase`: migrations and seed data.
- `docs/specs`: MVP spec and future backlog.

## Setup

```sh
pnpm install
pnpm lint
pnpm typecheck
pnpm test
```

Copy `.env.example` to `.env.local` before running locally.
