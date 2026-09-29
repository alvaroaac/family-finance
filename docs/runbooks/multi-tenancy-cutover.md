# Multi-tenancy cutover runbook

Moves production from one household to several households on one deployment
(design: `thoughts/features/multi-tenancy/design.md`).

Nothing in this runbook was executed by the implementation session. Production
was not touched. Every step lists its action, its verification and its rollback.
Run the steps in order.

Hostnames used below:

| Service      | Before                        | After                                           |
| ------------ | ----------------------------- | ----------------------------------------------- |
| Web          | the existing household's host | unchanged, plus `family-finance.ondemandly.dev` |
| Supabase API | `supabase.<existing domain>`  | `supabase.family-finance.ondemandly.dev`        |
| Bot          | `bot.<existing domain>`       | unchanged                                       |

## 0. Before the window

### 0.1 Prechecks (read-only, production database)

Run with `docker exec -i supabase-db psql -U postgres -d postgres` on the VPS.

Case-variant duplicate allowlist emails make migration `0029` fail on the
`lower(email)` unique index:

```sql
select lower(email), count(*) from allowed_emails group by 1 having count(*) > 1;
```

Expected: zero rows. If any, delete the duplicates before migrating.

The `0029` backfill assigns every allowlist row to the single existing
household:

```sql
select count(*) from households;
```

Expected: `1`.

A user with more than one membership blocks `household_members_user_id_key`:

```sql
select user_id, count(*) from household_members group by 1 having count(*) > 1;
```

Expected: zero rows.

Pending bot drafts are deleted by `0031` (the conversation table is re-keyed).
Finish or cancel any draft in Telegram before the window.

### 0.2 Google brand verification (2–3 business days, start early)

- Verify `ondemandly.dev` in Google Search Console with the account that owns
  the Google Cloud project.
- The neutral web host needs a public homepage and a privacy policy page,
  linked from the homepage and from the consent screen. The login page is not
  a homepage for this purpose if it sits behind a redirect.
- Scopes stay `openid`, `email`, `profile`. These are non-sensitive, so full
  app verification is not required and there is no cost and no user cap.
- Without brand verification the consent screen shows the Supabase callback
  domain instead of the app name. Sign-in still works.

### 0.3 Decisions the owner takes before onboarding the tester

- Third-party processing: message text and audio go to OpenAI, Anthropic and
  Telegram under the operator's keys. Decide what is disclosed and whether any
  provider is disabled for tenant households.
- Data is not encrypted at rest until spec 2 ships. As VPS and database owner,
  the operator can technically read tenant data. Spec 1 gives isolation
  between households, not privacy from the operator.
- Spec 2 phase-0 items (`thoughts/features/multi-tenancy/spec-2-privacy-research.md`):
  encrypted off-site backups, retention job, privacy notice, recorded
  acceptance, incident runbook, record of processing activities, VPS location
  confirmed.

## 1. Backup

- Action: on the VPS,
  `docker exec supabase-db pg_dump -U postgres -d postgres | gzip > /var/backups/family-finance/pre-multi-tenancy-$(date +%F-%H%M).sql.gz`.
  Copy `deploy/bot/.env` and the Supabase stack `.env` next to it (mode 600).
- Verification: `gunzip -t` on the file succeeds and its size is close to the
  latest nightly dump.
- Rollback: not applicable. This file is the rollback source for step 2.

## 2. Migrations 0029–0031 and bot redeploy (same window)

Order constraint: the bot must be redeployed with the new env in the same
window as migration `0031`. The old bot build cannot use the re-keyed
`bot_conversations` table, and it calls `create_installment_purchase`,
`settle_card_bill` and `materialize_obligation_payment` as service role, which
`0031` now rejects (they require an authenticated member). Between the
migration and the redeploy the bot fails closed; keep that gap short.

### 2.1 Stop the bot

- Action: `docker compose -f deploy/bot/docker-compose.yml stop`.
- Verification: `docker compose ps` shows the bot stopped. Telegram queues
  updates and redelivers them once the webhook answers again.
- Rollback: `docker compose up -d` with the previous image.

### 2.2 Apply migrations

- Action: update the VPS checkout to the merged `main`, then
  `./deploy/migrate.sh status` and `./deploy/migrate.sh apply`.
- What they do:
  - `0029`: `allowed_emails.household_id` (not null, backfilled),
    `household_slug` dropped, case-insensitive unique email, one membership per
    user, `households.theme`, provisioning trigger scoped to the allowlisted
    household.
  - `0030`: investment bucket slug becomes free text per household.
  - `0031`: bot conversation table re-keyed by chat, Telegram user and
    household; `resolve_telegram_member`; the three RPCs above require an
    authenticated member.
- Verification: `./deploy/migrate.sh status` is clean through `0031`, and

  ```sql
  select count(*) from allowed_emails where household_id is null;      -- 0
  select theme from households;                                         -- {"base": "esmeralda"}
  select conname from pg_constraint where conname = 'household_members_user_id_key';
  ```

- Rollback: restore the step 1 dump into the database and redeploy the
  previous bot and web builds. The migrations have no down scripts.

### 2.3 Bot env and redeploy

- Action: in `deploy/bot/.env` add `SUPABASE_JWT_SECRET` (the `JWT_SECRET` of
  the Supabase stack) and `SUPABASE_ANON_KEY`. Keep the file at mode 600.
  Rebuild and start the bot from the merged `main`.
- Verification: the bot's health endpoint answers; a message from a linked
  member gets a normal reply; a message from an unlinked Telegram account gets
  the refusal "Oi! Eu ainda não conheço você por aqui — peça para quem
  administra a sua casa vincular seu Telegram nas Configurações."
- Rollback: restore the dump (step 2.2 rollback) and start the previous image.
  The previous image does not work against the migrated schema.

## 3. Supabase hostname move

The old hostname stays routed until the new one is verified.

- Action:
  1. DNS: `supabase.family-finance.ondemandly.dev` points at the VPS.
  2. Reverse proxy (Traefik in production; `deploy/caddy/Caddyfile` is the
     repository template): add a route for the new hostname to Kong, keeping
     the old route.
  3. Supabase stack `.env`: `API_EXTERNAL_URL` and `SUPABASE_PUBLIC_URL` become
     `https://supabase.family-finance.ondemandly.dev`. `SITE_URL` becomes
     `https://family-finance.ondemandly.dev`. `ADDITIONAL_REDIRECT_URLS` lists
     the callback of every web hostname, for example
     `https://<existing host>/auth/callback,https://family-finance.ondemandly.dev/auth/callback`.
  4. `docker compose up -d` for the auth and Kong services.
- Verification: `curl https://supabase.family-finance.ondemandly.dev/auth/v1/health`
  answers 200, and the old hostname still answers.
- Rollback: restore the previous `.env` values and restart. The old route was
  never removed.

Existing sessions end when the web app starts using the new Supabase URL,
because the auth cookie name derives from the Supabase hostname. Members sign
in again once. The owner accepted this.

## 4. Google console

- Action: on the existing OAuth client,
  - add the authorized redirect URI
    `https://supabase.family-finance.ondemandly.dev/auth/v1/callback`, keeping
    the old one until step 5 is verified;
  - add each web hostname as an authorized JavaScript origin;
  - consent screen: publishing status "In production", scopes `openid`,
    `email`, `profile`, app name "Family Finance", homepage and privacy policy
    on `ondemandly.dev`.
- Verification: the client shows both redirect URIs; the consent screen shows
  "In production".
- Rollback: the old redirect URI is still present, so reverting step 3 and
  step 5 restores the previous flow.

"In production" with non-sensitive scopes has no user cap and no fee.
"Testing" status limits sign-in to listed test users and expires refresh
tokens after seven days; do not leave it in "Testing".

## 5. Vercel

- Action:
  - add the domain `family-finance.ondemandly.dev` to the same project;
  - env `ALLOWED_WEB_HOSTS` = `<existing host>,family-finance.ondemandly.dev`;
  - env `NEXT_PUBLIC_SITE_URL` = `https://family-finance.ondemandly.dev`;
  - env `NEXT_PUBLIC_SUPABASE_URL` = `https://supabase.family-finance.ondemandly.dev`;
  - remove `AUTHORIZED_EMAILS` and `HOUSEHOLD_SLUG`;
  - deploy the merged `main`.
- Verification:
  - sign in on the existing host with both existing accounts; each lands on
    `/dashboard` and sees the existing data;
  - sign in on the neutral host with an existing account; same household;
  - a Google account that is not allowlisted lands on the access-denied
    screen on both hosts;
  - a request with an unknown `Host` header redirects to the neutral host.
- Rollback: promote the previous Vercel deployment and restore the previous
  env values. This only works if the database was also rolled back, because
  the previous build reads `AUTHORIZED_EMAILS` and the old schema.

After verification, remove the old Supabase route from the reverse proxy and
the old redirect URI from the Google client.

## 6. rls-proof against production

- Action: from the repository root,

  ```bash
  SUPABASE_URL=https://supabase.family-finance.ondemandly.dev \
  SUPABASE_ANON_KEY=<anon key> \
  SERVICE_ROLE_KEY=<service role key> \
  DATABASE_URL=<postgres url> \
  MEMBER_EMAIL=rls-proof.member@example.com MEMBER_PASSWORD=<throwaway> \
  MEMBER_B_EMAIL=rls-proof.member-b@example.com MEMBER_B_PASSWORD=<throwaway> \
  OUTSIDER_EMAIL=rls-proof.outsider@example.com OUTSIDER_PASSWORD=<throwaway> \
  node deploy/checks/rls-proof.mjs
  ```

  The emails must not be allowlisted. `DATABASE_URL` needs a route to Postgres
  (run on the VPS or through an SSH tunnel). Member A's fixtures are created
  inside the existing household, tagged with the run marker printed on the
  first line; member B gets a throwaway household. The script proves that
  neither side can read or write the other's rows through tables, views or
  RPCs, then deletes its fixtures and users.

- Verification: exit code 0, every check reports PASS (361 checks on the
  local stack), and no household named `rls-proof-*` remains.
- Rollback: if any check fails, do not create the tester's household. If the
  run was killed before teardown, remove its fixtures with
  `node deploy/checks/rls-proof.mjs --cleanup <marker>` (needs `SUPABASE_URL`,
  `SERVICE_ROLE_KEY`, `DATABASE_URL`).

## 7. Create the tester's household

- Action: on a machine that can reach the production database,

  ```bash
  DATABASE_URL=<postgres url> node scripts/create-household.mjs \
    --name "<household name>" \
    --email <tester google email> \
    [--email <second member email>] \
    [--theme <path to theme json>]
  ```

  The theme file holds `base`, `lockBase` and `overrides`. Override keys come
  from the closed token list and values are `#rgb` or `#rrggbb`.

- Verification: the script prints the household id; the tester signs in on
  `https://family-finance.ondemandly.dev` and lands on an empty dashboard with
  the household name in the sidebar. After the tester links Telegram in
  Configurações, a bot message creates a draft in the tester's household only.
- Rollback: delete the household row; membership, allowlist and data cascade.

  ```sql
  delete from households where id = '<household id>';
  ```

## 8. Disclosure to the tester

Send before the first login:

- what is stored: transactions, accounts, imports, Telegram messages sent to
  the bot;
- who processes it: the operator's VPS, Vercel, Telegram, and the AI providers
  that read message text and audio (OpenAI, Anthropic);
- that data is isolated from other households by database policy;
- that data is not yet encrypted at rest and the operator can technically
  access it; encryption is planned (spec 2);
- how to ask for export or deletion, and that deletion removes the household
  and everything in it.
