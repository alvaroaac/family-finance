# Isolated end-to-end harness

The stack uses Supabase CLI project `family-finance-e2e` on API port 56321 and
database port 56322. It has its own Docker containers and volumes. The CLI reads
the repository migrations and seed through symlinks in `e2e/supabase`.

```sh
pnpm e2e:up
pnpm e2e:bot
pnpm e2e:web
pnpm e2e:down
```

`e2e:up` starts the stack and resets it every time. It applies all migrations in
filename order, then `supabase/seed.sql`. `e2e:env` prints the local API URL and
keys as `KEY=value` lines. `e2e:down` stops only this project's containers and
deletes its volumes. The bot suite tests GoTrue provisioning and a webhook against
a fake Telegram API. The Playwright suite builds and starts the web app on port 3100 and uses
a temporary SSR session cookie. These suites are separate from `pnpm test`.
