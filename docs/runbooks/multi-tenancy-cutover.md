# Multi-tenancy cutover runbook

Moves production from one household to several households on one deployment
(design: `thoughts/features/multi-tenancy/design.md`).

Nothing in this runbook was executed by the implementation session. Production
was not touched. Every step lists its action, its verification and its rollback.
Run the steps in order. The order matters in four places, each explained where
it applies:

- email autoconfirm is switched off **before** the migrations, so nobody can
  obtain a confirmed account for an allowlisted address in between (step 2.0);
- the database is migrated from the branch **before** the pull request is
  merged (step 2);
- Google learns the new callback **before** the auth server starts sending it
  (steps 3 and 4);
- the old callback and the old Supabase route are removed only after a fresh
  Google sign-in was seen using the new ones (step 5).

Hostnames used below:

| Service      | Before                        | After                                           |
| ------------ | ----------------------------- | ----------------------------------------------- |
| Web          | the existing household's host | unchanged, plus `family-finance.ondemandly.dev` |
| Supabase API | `supabase.<existing domain>`  | `supabase.family-finance.ondemandly.dev`        |
| Bot          | `bot.<existing domain>`       | unchanged                                       |

## 0. Before the window

### 0.1 Prechecks and remediation (production database)

Run with `docker exec -i supabase-db psql -U postgres -d postgres` on the VPS.
The queries are read-only. The remediations they lead to write to the
database and come before the backup of step 1, so take a logical dump before
the first write:

```bash
docker exec supabase-db pg_dump -U postgres -d postgres | gzip > /var/backups/family-finance/pre-remediation-$(date +%F-%H%M).sql.gz
```

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

Auth users that are not members. Public email signup was open until this
cutover, so stray accounts may exist:

```sql
select u.email, u.created_at, u.email_confirmed_at, u.raw_app_meta_data->'providers' as providers
from auth.users u
where not exists (select 1 from household_members m where m.user_id = u.id);
```

Expected: zero rows, or only accounts the owner recognises. Delete the others
in Supabase Studio (Authentication → Users) before the window.

Members linked to Telegram by username only. Migration `0032` stops matching
by username, so these members link again with a code after the cutover
(Configurações → Vincular Telegram):

```sql
select display_name from household_members
where telegram_user_id is null and telegram_username is not null;
```

Members with a numeric `telegram_user_id` keep working without action. Until
this cutover a numeric id could be filled in by the member or back-filled from
a typed username, so it is not proof of ownership. List the bindings and
confirm each one with the member (the member sends any message to
`@userinfobot` in Telegram to read their own id):

```sql
select display_name, telegram_user_id from household_members
where telegram_user_id is not null;
```

For any id the member does not recognise, clear it after step 2 and let the
member link again with a code:

```sql
update household_members
set telegram_user_id = null, telegram_username = null
where id = '<member id>';
```

Members whose account can sign in with a password. Membership should rest on
a Google identity; a password or an email identity on a member account means
someone signed up by email for that address, or added a password later:

```sql
select u.email, u.email_confirmed_at, u.raw_app_meta_data->'providers' as providers
from auth.users u
join household_members m on m.user_id = u.id
where coalesce(u.encrypted_password, '') <> ''
  or exists (
    select 1 from auth.identities i where i.user_id = u.id and i.provider = 'email'
  );
```

Expected: zero rows. For any row, ask the member whether the account is
theirs.

- The account is theirs (it also has a Google identity they use): remove the
  password, the email identity and the open sessions. The password hash lives
  on the user row, so deleting the identity alone may leave password sign-in
  working.

  How an account without a password is stored depends on the auth server
  version. Read what a Google-only account holds:

  ```sql
  select encrypted_password is null as is_null, encrypted_password = '' as is_empty
  from auth.users u
  where not exists (
    select 1 from auth.identities i where i.user_id = u.id and i.provider = 'email'
  )
  limit 5;
  ```

  Write the same value (`null` or `''`) to the member's row:

  ```sql
  update auth.users set encrypted_password = <null or ''> where id = '<user id>';
  delete from auth.identities where user_id = '<user id>' and provider = 'email';
  delete from auth.sessions where user_id = '<user id>';
  ```

  Deleting the sessions ends refresh. An access token that was already
  issued stays valid until it expires (one hour by default).

  Verification: the password audit query above no longer returns the account,
  a password sign-in for that address is refused, and Google sign-in still
  works for the member.

  ```bash
  curl -s -X POST "https://<current supabase host>/auth/v1/token?grant_type=password" \
    -H "apikey: <anon key>" -H "Content-Type: application/json" \
    -d '{"email":"<member email>","password":"<any value>"}'
  ```

  Expected: an error with code `invalid_credentials` or `invalid_grant`
  ("Invalid login credentials"), depending on the auth server version, and no
  `access_token`. This shows only that the tried value fails; the cleared
  hash is what removes the old password.

- The member disowns the account: it belongs to someone else. Deactivate the
  membership, then delete the auth user in Studio, which also ends its
  sessions.

  ```sql
  update household_members set is_active = false where user_id = '<user id>';
  ```

  Verification: the user is gone from `auth.users`, and no active
  `household_members` row references it.

  If the delete is refused by a foreign key, the account wrote records in the
  household. Keep the membership deactivated, review those records with the
  members (`created_by_user_id = '<user id>'`), and delete the auth user
  after they are reassigned or removed.

Members without a confirmed email. No membership may rest on an unconfirmed
address:

```sql
select m.id, u.email
from household_members m
join auth.users u on u.id = m.user_id
where m.is_active and u.email_confirmed_at is null;
```

Expected: zero rows. Deactivate any row found and delete its auth user.

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

- Third-party processing: message text, audio and member display names go to
  OpenAI, Anthropic and Telegram under the operator's keys. Decide what is
  disclosed and whether any provider is disabled for tenant households.
- Data is not encrypted at rest until spec 2 ships. As VPS and database owner,
  the operator can technically read tenant data. Spec 1 gives isolation
  between households, not privacy from the operator.
- Spec 2 phase-0 items (`thoughts/features/multi-tenancy/spec-2-privacy-research.md`):
  encrypted off-site backups, retention job, privacy notice, recorded
  acceptance, incident runbook, record of processing activities, VPS location
  confirmed.

### 0.4 Do not merge yet

The new web build does not run on the old schema (it selects
`households.theme`) and refuses to start without `NEXT_PUBLIC_SITE_URL`. If
the Vercel project deploys `main` automatically, merging before step 2 takes
the existing household's site down until step 5 is finished.

- Action: keep the pull request open until step 5. In Vercel, add one
  variable now, for Production: `ALLOWED_WEB_HOSTS` =
  `<existing host>,family-finance.ondemandly.dev`. The current build ignores
  it. Do **not** change `NEXT_PUBLIC_SITE_URL` yet: the current build uses it
  for the sign-in redirect, and the neutral host is not served before step 5.
  Confirm it is set to the existing host.
- Verification: the variable is listed in the project settings; the
  production site still works.
- Rollback: remove the variable.

The reverse combination is safe: the current web build keeps working on the
migrated schema between step 2 and step 5, with one exception. Its Telegram
field in Configurações fails with a permission error after `0032`, because
members can no longer write Telegram columns.

## 1. Backup

Tell the members not to use the web app or the bot during the window. Anything
written after this step is lost if the database is rolled back.

- Action: on the VPS,
  1. logical dump, kept as the long-term copy:
     `docker exec supabase-db pg_dump -U postgres -d postgres | gzip > /var/backups/family-finance/pre-multi-tenancy-$(date +%F-%H%M).sql.gz`;
  2. physical copy, which is the rollback source. Stop the database container,
     archive its data volume (the volume mounted at
     `/var/lib/postgresql/data` in the `db` service of the Supabase compose
     file), start the container again:

     ```bash
     docker compose stop db
     tar -C <host path of the db data volume> -czf /var/backups/family-finance/pre-multi-tenancy-pgdata.tgz .
     docker compose start db
     ```

  3. copy `deploy/bot/.env` and the Supabase stack `.env` next to the archives
     (mode 600).

- Verification: `gunzip -t` succeeds on both archives; the dump size is close
  to the latest nightly dump; the site answers again after the restart.
- Rollback: not applicable. These files are the rollback source for step 2.

The physical copy is used because the plain dump cannot be piped into the live
database: it has no `DROP` statements and fails on the first existing object.
The restore procedure in step 2.2 was not rehearsed by the implementation
session. Rehearse it once on a copy if the window allows.

## 2. Migrations 0029–0032 and bot redeploy (same window)

Order constraint: the bot must be redeployed with the new env in the same
window as migration `0031`. The old bot build cannot use the re-keyed
`bot_conversations` table, and it calls `create_installment_purchase`,
`settle_card_bill` and `materialize_obligation_payment` as service role, which
`0031` now rejects (they require an authenticated member). Between the
migration and the redeploy the bot fails closed; keep that gap short.

### 2.0 Switch off email autoconfirm

Done first, on the current hostname. With autoconfirm, anyone can sign up
with a password for an allowlisted address and receive a confirmed account,
which the provisioning trigger turns into a membership. Migration `0032`
provisions confirmed users only; that protects nothing while the auth server
confirms every signup by itself.

- Action: in the Supabase stack `.env` set `ENABLE_EMAIL_AUTOCONFIRM=false`,
  then `docker compose up -d auth`. The email provider stays enabled, because
  the isolation proof of step 6 signs in with passwords.
- Verification: public signup yields no session and no confirmed user:

  ```bash
  curl -s -X POST https://<current supabase host>/auth/v1/signup \
    -H "apikey: <anon key>" -H "Content-Type: application/json" \
    -d '{"email":"signup-probe@example.com","password":"<throwaway>"}'
  ```

  Expected: an error, or a user object without `access_token` and with
  `email_confirmed_at` empty. Whatever the response, look for the probe
  address in `auth.users` and delete it; a failed confirmation email can
  return an error and still create the row. Then repeat
  the stray-users and password-identity queries of step 0.1; both must still
  be clean. Google sign-in on the existing site still works.

- Rollback: restore the previous value and restart the auth service.

### 2.1 Stop the bot

- Action: `docker compose -f deploy/bot/docker-compose.yml stop`.
- Verification: `docker compose ps` shows the bot stopped. Telegram queues
  updates and redelivers them once the webhook answers again.
- Rollback: `docker compose up -d` with the previous image.

### 2.2 Apply migrations

- Action: on the VPS checkout, `git fetch` and check out the head commit of
  the pull request branch `feat/multi-tenancy` (not `main`, see 0.4), then
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
  - `0032`: only users with a confirmed email are provisioned; members can
    update `display_name` only (rows of their own household); Telegram is linked with a one-time code
    redeemed by the bot; username matching is removed.
- Verification: `./deploy/migrate.sh status` is clean through `0032`, and

  ```sql
  select count(*) from allowed_emails where household_id is null;      -- 0
  select count(*) from household_members m
    join auth.users u on u.id = m.user_id
    where m.is_active and u.email_confirmed_at is null;                 -- 0
  select theme from households;                                         -- {"base": "esmeralda"}
  select conname from pg_constraint where conname = 'household_members_user_id_key';
  select has_table_privilege('authenticated', 'household_members', 'update');            -- f
  select has_column_privilege('authenticated', 'household_members', 'display_name', 'update'); -- t
  ```

- Rollback: the migrations have no down scripts. Restore the physical copy of
  step 1 and start the previous bot image:

  ```bash
  docker compose stop            # whole Supabase stack
  mv <host path of the db data volume> <same path>.failed
  mkdir <host path of the db data volume>
  tar -C <host path of the db data volume> -xzf /var/backups/family-finance/pre-multi-tenancy-pgdata.tgz
  docker compose up -d
  ```

  Then check the row counts of `transactions` and `household_members` against
  the values noted before the window. The web build was not changed yet, so
  it needs no rollback at this point.

### 2.3 Bot env and redeploy

- Action: in `deploy/bot/.env` add `SUPABASE_JWT_SECRET` (the `JWT_SECRET` of
  the Supabase stack) and `SUPABASE_ANON_KEY`. Keep the file at mode 600.
  Rebuild and start the bot from the same branch commit as step 2.2.
- Verification: the bot's health endpoint answers; a message from a linked
  member gets a normal reply; a message from an unlinked Telegram account gets
  the refusal that starts with "Oi! Eu ainda não conheço você por aqui."
- Rollback: restore the database (step 2.2 rollback) and start the previous
  image. The previous image does not work against the migrated schema.

## 3. Google console

Done before the auth server changes, so Google already accepts the new
callback when the auth server starts sending it.

- Action: on the existing OAuth client,
  - add the authorized redirect URI
    `https://supabase.family-finance.ondemandly.dev/auth/v1/callback`, keeping
    the old one until step 5 is verified;
  - add each web hostname as an authorized JavaScript origin;
  - consent screen: publishing status "In production", scopes `openid`,
    `email`, `profile`, app name "Family Finance", homepage and privacy policy
    on `ondemandly.dev`.
- Verification: the client shows both redirect URIs; the consent screen shows
  "In production". Sign-in on the existing site still works.
- Rollback: remove the added URI and origins. Nothing uses them yet.

"In production" with non-sensitive scopes has no user cap and no fee.
"Testing" status limits sign-in to listed test users and expires refresh
tokens after seven days; do not leave it in "Testing".

## 4. Supabase hostname move and signup hardening

The old hostname stays routed until step 5 is verified.

- Action:
  1. DNS: `supabase.family-finance.ondemandly.dev` points at the VPS.
  2. Reverse proxy (Traefik in production; `deploy/caddy/Caddyfile` is the
     repository template): add a route for the new hostname to Kong, keeping
     the old route.
  3. Supabase stack `.env`:
     - `API_EXTERNAL_URL` and `SUPABASE_PUBLIC_URL` become
       `https://supabase.family-finance.ondemandly.dev`;
     - `GOTRUE_EXTERNAL_GOOGLE_REDIRECT_URI` becomes
       `https://supabase.family-finance.ondemandly.dev/auth/v1/callback`.
       Confirm that the `auth` service in the compose file reads this
       variable; the production compose file is not in the repository. If it
       hardcodes or derives the value, change it there;
     - `SITE_URL` becomes `https://family-finance.ondemandly.dev`;
     - `ADDITIONAL_REDIRECT_URLS` lists the callback of every web hostname,
       for example
       `https://<existing host>/auth/callback,https://family-finance.ondemandly.dev/auth/callback`;
     - `ENABLE_EMAIL_AUTOCONFIRM` stays `false` (step 2.0).
  4. `docker compose up -d` for the auth and Kong services.
- Verification:
  - `curl https://supabase.family-finance.ondemandly.dev/auth/v1/health`
    answers 200, and the old hostname still answers;
  - a fresh Google sign-in on the existing site succeeds, and the Google
    consent URL carries `redirect_uri` with the **new** Supabase host;
  - the signup probe of step 2.0, sent to the new hostname, still yields no
    session.

- Rollback: restore the previous `.env` values and restart. The old route and
  the old Google redirect URI were never removed.

Existing sessions may end when the web app starts using the new Supabase
URL. Members sign in again if asked. Sessions that survive are not a sign of
a failed cutover. The owner accepted either outcome.

## 5. Vercel and merge

- Action:
  - add the domain `family-finance.ondemandly.dev` to the same project;
  - env `NEXT_PUBLIC_SUPABASE_URL` = `https://supabase.family-finance.ondemandly.dev`;
  - confirm `ALLOWED_WEB_HOSTS` from step 0.4, and set
    `NEXT_PUBLIC_SITE_URL` = `https://family-finance.ondemandly.dev`;
  - remove `AUTHORIZED_EMAILS` and `HOUSEHOLD_SLUG`;
  - merge the pull request and deploy `main` (automatic, or by hand if
    automatic deployment is off);
  - update the VPS checkout to the merged `main`;
  - bot: if `SUPABASE_URL` in `deploy/bot/.env` is the old public hostname,
    set it to `https://supabase.family-finance.ondemandly.dev` and restart
    the bot.
- Verification:
  - a linked member sends the bot a message and gets a normal reply;
  - sign in on the existing host with both existing accounts; each lands on
    `/dashboard` and sees the existing data;
  - sign in on the neutral host with an existing account; same household;
  - a Google account that is not allowlisted lands on the access-denied
    screen on both hosts;
  - a sign-in started on the project's `*.vercel.app` address, which is not
    in `ALLOWED_WEB_HOSTS`, ends on the login page of the neutral host with a
    sign-in error and no session. The browser never returns to the
    `*.vercel.app` address;
  - each sign-in above showed the new Supabase host in the Google consent
    URL.
- Rollback: promote the previous Vercel deployment and restore the previous
  env values, including `NEXT_PUBLIC_SUPABASE_URL` and
  `NEXT_PUBLIC_SITE_URL`. The previous build works on the migrated schema
  (see 0.4), so the database does not need a rollback for this step. Restore
  the bot's previous `SUPABASE_URL` if it was changed.

Only after every verification above passed: remove the old Supabase route
from the reverse proxy and the old redirect URI from the Google client. Then
repeat one Google sign-in and one bot message from a linked member.

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
  RPCs, that members cannot write identity columns, and that public signup
  yields neither a session nor a membership. It then deletes its fixtures and
  users.

- Verification: exit code 0, every check reports PASS, and no household named
  `rls-proof-*` remains.
- Rollback: if any check fails, do not create the tester's household. If the
  run was killed before teardown, remove its fixtures with
  `node deploy/checks/rls-proof.mjs --cleanup <marker>` (needs `SUPABASE_URL`,
  `SERVICE_ROLE_KEY`, `DATABASE_URL`).

## 7. Create the tester's household

- Precheck: no auth user may already exist for an address about to be
  allowlisted. An existing confirmed user would be provisioned immediately.

  ```sql
  select id, email, email_confirmed_at, raw_app_meta_data->'providers'
  from auth.users where lower(email) in ('<tester email>', '<second email>');
  ```

  Expected: zero rows. If a row exists and the tester did not create it,
  delete that user before continuing.

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
  the household name in the sidebar. The tester opens Configurações, chooses
  "Vincular Telegram" and sends the shown `/vincular` message to the bot in a private chat (the bot
  refuses to link in a group); the
  bot confirms, and the next bot message creates a draft in the tester's
  household only.
- Rollback: delete the household row; membership, allowlist and data,
  including import records, cascade (covered by
  `packages/db/test/delete-household-functional.sql`). The
  members' auth users are outside the cascade; delete them in Studio after
  the household row.

  ```sql
  delete from households where id = '<household id>';
  ```

## 8. Disclosure to the tester

Send before the first login:

- what is stored: transactions, accounts, imports, Telegram messages sent to
  the bot;
- who processes it: the operator's VPS, Vercel, Telegram, and the AI providers
  that read message text, audio and the display names of the household's
  members (OpenAI, Anthropic);
- that data is isolated from other households by database policy;
- that data is not yet encrypted at rest and the operator can technically
  access it; encryption is planned (spec 2);
- how to ask for export or deletion, and that deletion removes the household
  and everything in it.

## 9. Removing a member later

Membership belongs to the account, not to the email address. Removing an
address from `allowed_emails` only stops future provisioning, and a member who
changes their email keeps their membership. To revoke access:

```sql
update household_members set is_active = false where id = '<member id>';
delete from allowed_emails where lower(email) = '<member email>';
```

The web app and the bot both refuse an inactive member on the next request.
