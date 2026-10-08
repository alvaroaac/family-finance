# Multi-tenancy and card payments cutover

Release the combined reviewed card-payment and multi-household changes from one
pinned commit. Preserve existing household data and both web addresses. This
runbook describes operations; passing a local test does not establish that a
production step has run.

## Deployment targets and ordering

| Service            | Target                                                              |
| ------------------ | ------------------------------------------------------------------- |
| Canonical web      | `https://family-finance.b2tech.app`                                 |
| Existing web alias | `https://casa.alvaroekarol.com.br`                                  |
| Supabase API       | `https://supabase.alvaroekarol.com.br` (unchanged)                  |
| Google callback    | `https://supabase.alvaroekarol.com.br/auth/v1/callback` (unchanged) |
| Bot                | Existing `bot.alvaroekarol.com.br` route                            |
| VPS source         | `minesupply:/opt/family-finance`, deployed by rsync, without Git    |
| Supabase stack     | `/opt/supabase`                                                     |
| Vercel             | `family-finance` under `alvaroaacs-projects`, root `apps/web`       |

Confirm the Vercel project is still **not connected to Git**. Merge all reviewed
PRs first, then deploy the same clean merged commit manually. If automatic
deployment has since been enabled, stop and establish a staging-only deployment
path before merging. Never deploy the dirty primary working directory.

Applied migrations `0001`–`0027` retain their filenames and checksums. The combined
release adds `202610070000` (card bills), then `202610080001`–`202610080004`
(provisioning, investment buckets, bot member scope, verified identity binding).
The seven-argument payment RPC is replaced by the eight-argument keyed RPC.
Old payment callers and the old bot cannot operate safely during this transition.

Keep email autoconfirm **false** before, during, and after the release, including
rollback. Google sign-in remains enabled. This web-domain addition does not
require moving Supabase or changing Google's callback.

Both stacks have important Compose overrides. Always include both files:

```bash
supabase_compose() {
  docker compose --project-directory /opt/supabase \
    -f /opt/supabase/docker-compose.yml \
    -f /opt/supabase/docker-compose.override.yml "$@"
}
bot_compose() {
  docker compose --project-directory /opt/family-finance/deploy/bot \
    -f /opt/family-finance/deploy/bot/docker-compose.yml \
    -f /opt/family-finance/deploy/bot/docker-compose.override.yml "$@"
}
```

The Supabase override contains Google configuration; the bot override contains
its proxy routing. Recreating either service with only the base file loses those
settings. Preserve both files and both private `.env` files in the backup.

## 0. Before the window

### 0.1 Prechecks and remediation (production database)

Run with `docker exec -i supabase-db psql -U postgres -d postgres` on the VPS.
The queries are read-only. The remediations they lead to write to the
database and come before the backup of step 1, so take a logical dump before
the first write:

```bash
docker exec supabase-db pg_dump -U postgres -d postgres | gzip > /var/backups/family-finance/pre-remediation-$(date +%F-%H%M).sql.gz
```

Case-variant duplicate allowlist emails make migration `202610080001` fail on the
`lower(email)` unique index:

```sql
select lower(email), count(*) from allowed_emails group by 1 having count(*) > 1;
```

Expected: zero rows. If any, delete the duplicates before migrating.

The `202610080001` backfill assigns every allowlist row to the single existing
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

Members linked to Telegram by username only. Migration `202610080004` stops matching
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

### 0.2 Drafts, identity, and acceptance gates

Inventory bot conversation status and the presence of durable submission keys
without printing descriptions, amounts, or identities. Repeat after stopping the
bot. Any unresolved `*_submission_started`, `*_outcome_uncertain`, or recovery
state blocks the migration until its existing key is reconciled. Do not cancel,
rekey, or delete an uncertain payment to make this check pass.

The bot-scope migration clears old chat-only drafts. Preserve ordinary unsaved
drafts in a private export and the database backup before that reset. Account
for that reset when notifying existing members of the maintenance window.

Require independent review, CI, unit/type checks, and a successful build for the
exact release commit. Exercise both a fresh database and upgrade from the
production ledger, followed by replay; compare the resulting function signatures,
grants, and isolation behavior. Run the serial bot/RLS harness before browser
fixtures because the harness resets its disposable database. Preserve the card
payment scenario and two-household authorization checks.

Google's [audience rules](https://support.google.com/cloud/answer/15549945?hl=en)
exempt basic identity-only requests (`email`, `profile`, `openid`) from the
Testing named-user restriction. Confirm the live request's scopes; do not infer
a restriction from publishing status alone. A real Google sign-in remains an
acceptance check. No Google Console changes are part of this hostname rollout.

### 0.3 Prepare builds and configuration

Record the clean release SHA, current Vercel deployment ID and aliases, current
bot image ID, migration ledger, row counts, and backup location. Do not trust the
old `.deploy-revision` file as proof of the running source.

Stage the clean source in a separate VPS release directory using rsync. Exclude
`.git`, `.env`, `.env.*`, `node_modules`, `.next`, `.turbo`, `.vercel`, local test
state, and generated review artifacts. Build the bot from this staged tree before
downtime. Record its immutable image ID; do not start it against the old schema.

Prepare these Vercel production settings without printing secret values:

- `NEXT_PUBLIC_SITE_URL=https://family-finance.b2tech.app`.
- `ALLOWED_WEB_HOSTS=casa.alvaroekarol.com.br,family-finance.b2tech.app`.
- Retain the existing Supabase URL and anon key, and import-service settings.
- The new build no longer uses `AUTHORIZED_EMAILS` or `HOUSEHOLD_SLUG`.

From the linked clean repository root, stage production without assigning domains:

```bash
vercel deploy --prod --skip-domain
```

Require READY and record the exact staged URL/ID and source SHA. Do not promote
yet. Retain the old production ID for rollback. Deployment-host sign-in may be
rejected intentionally by the allowed-host configuration.

Prepare the Supabase `.env` changes for the maintenance window:

- `ENABLE_EMAIL_AUTOCONFIRM=false`.
- `SITE_URL=https://family-finance.b2tech.app`.
- Append `https://family-finance.b2tech.app/auth/callback` to
  `ADDITIONAL_REDIRECT_URLS`, preserving the Casa callback and other valid entries.
- Retain existing API/public URLs and Google callback/client settings.

Transfer `SUPABASE_JWT_SECRET` and `SUPABASE_ANON_KEY` into the bot's private env
from the existing Supabase stack on the VPS. Keep service/JWT secrets off Vercel,
out of logs and command arguments, and out of image layers. Keep env files mode 600. Report provider availability accurately; a missing TypeSafe key does not
mean Jev was exercised by the release checks.

## 1. Quiesce and verify backups

Pause bot, REST, and auth before taking the release snapshot. Existing web reads
and writes and new sign-ins will temporarily fail; this prevents old web callers
from writing during schema replacement. Stop other discovered application
writers too. Do not send maintenance messages on the user's behalf without
permission for that message.

```bash
bot_compose stop bot
supabase_compose stop rest auth
```

Repeat the durable-draft gate. Save only private copies of conversation contents.
Create a mode-700 timestamped backup directory under
`/var/backups/family-finance`; use `umask 077`. Save:

- Current bot image ID, old web deployment ID/aliases, pre-window ledger and counts.
- Both stacks' `.env` and both Compose files for each stack.
- Application source archive, excluding dependency/build caches; preserve runtime
  configuration separately and do not put credentials in a public artifact.
- A JSON export of `bot_conversations` and a custom-format PostgreSQL dump.

```bash
docker exec supabase-db pg_dump -U postgres -d postgres -Fc > "$FF_BACKUP_DIR/postgres.dump"
docker exec -i supabase-db pg_restore --list < "$FF_BACKUP_DIR/postgres.dump" > "$FF_BACKUP_DIR/postgres.dump.toc"
supabase_compose stop db
# Install a failure trap to restart db if the archive command fails.
tar -C /opt/supabase/volumes/db/data -czf "$FF_BACKUP_DIR/pgdata.tgz" .
gzip -t "$FF_BACKUP_DIR/pgdata.tgz"
supabase_compose start db
```

Require database health, nonempty dump/catalog files, successful archive checks,
and enough disk space. Rehearse restoring the physical backup into a separate
volume with the same database image, no production mounts, no published ports,
and no application traffic. Compare ledger and household/member/transaction
counts. Never run the rehearsal against the live data directory.

## 2. Migrate and activate the pinned release

Copy staged reviewed source to `/opt/family-finance`, preserving runtime env,
Compose overrides and authentication volumes. Apply the prepared auth and bot
env changes privately. With REST/auth/bot still stopped:

```bash
cd /opt/family-finance
./deploy/migrate.sh status
./deploy/migrate.sh apply
./deploy/migrate.sh status
```

Use the migration controller, not raw SQL and not a new baseline. Require a clean
ledger through `202610080004`, unchanged recorded checksums for applied history,
and the intended eight-argument `settle_card_bill` with no seven-argument overload.
Confirm member checks and grants on payment, installment, and obligation RPCs.

Promote the exact READY staged web deployment while REST remains stopped:

```bash
vercel promote <staged-deployment-url>
```

Recreate auth with **both** Supabase Compose files; verify runtime autoconfirm
false, Google enabled, and the intended redirect allowlist without exposing
client secrets. Start REST. Start the reviewed bot using both bot Compose files
plus a small private image override that pins the recorded immutable image ID:

```yaml
services:
  bot:
    image: sha256:<reviewed-image-id>
```

Pass that override as the last `-f` argument and use `up -d --no-build --pull never
bot`. A subsequent deployment must deliberately replace this pin. Verify the
actual running image, healthy auth/database, REST availability and bot `/health`.
Check recent errors with secrets redacted. A healthy process alone is not proof
of correct household access.

## 3. Production verification

Verify the exact deployment ID and both aliases, TLS, and the migration ledger.
Check that existing household financial counts are preserved, allowlist household
IDs are populated, one-membership uniqueness exists, active members are confirmed,
and only `display_name` remains writable on membership rows.

Run the integrated `deploy/checks/rls-proof.mjs` from an installed copy of the
reviewed source. Supply its required credentials through a private environment:
`SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SERVICE_ROLE_KEY`, `DATABASE_URL`, and the
three disposable member/outsider email-password pairs. Keep passwords out of
shell history and tool output. Run on the VPS or through a private SSH tunnel;
do not open public database access for the proof. The bot image does not include
this operator script or its root `pg` dependency.

Require exit zero and PASS for every catalog-discovered table and RPC, including
card bill closures and keyed settlements. Verify all disposable users, households,
and fixtures were cleaned. If interrupted, use the script's documented
`--cleanup <marker>` recovery path. Do not seed the beta household after a failed
isolation check.

Verify public email signup does not return a confirmed identity or session; clean
its disposable auth record even if SMTP returned an error. Verify real Google
sign-in on both canonical and Casa hosts, an unauthorized account's denial,
existing household data, and the new host staying in the callback flow. Verify
an existing linked Telegram member and an unlinked identity behave correctly.
Automated password sessions do not prove Google consent completed; report human
first-login and Telegram-link steps separately when not yet exercised.

## 4. Provision the empty beta household

Privately confirm the proposed emails are not already allowlisted or attached to
an unexpected auth identity. Investigate any conflict rather than deleting it.
After all release gates pass, supply `DATABASE_URL` privately and run:

```bash
node scripts/create-household.mjs \
  --name 'Renata&Cleiton' \
  --email renata.nesio2@gmail.com \
  --email cleitonfisica@gmail.com
```

No slug is used. The operator script seeds default categories, without sample
accounts, transactions, imports, or bills. Verify one named household, the exact
two allowlist entries, and zero financial records. Each person signs in with
their own Google account and receives membership in this same household.
Telegram linking is per person through Configurações and a private `/vincular`
message; no shared Google account is required.

Do not send invitations or other messages without approval of their exact text.
Provide the owner with the beta URL and any remaining first-login checks.

## 5. Rollback and later access changes

Before migrations, the old app can resume directly. After the combined schema
change, roll back database, bot source/image, and web deployment **together**.
The old payment UI and bot are not compatible with the migrated schema.

Keep writers stopped. Preserve the failed database directory separately, restore
the verified physical snapshot into the original volume path, and restart the
same database image with both Supabase Compose files. Restore old source and
runtime settings, retaining `ENABLE_EMAIL_AUTOCONFIRM=false`. Promote the recorded
old web deployment and verify aliases. Start the recorded old bot image with
both bot Compose files. Compare counts/ledger and verify auth/web/bot behavior
before ending maintenance. A snapshot rollback loses post-backup writes, which
is why writers remain quiesced until activation checks pass.

The VPS operator can technically access tenant data; household RLS does not
provide encryption against the operator. Explain data handling, configured AI
providers, export/deletion and the privacy work still pending before onboarding.
Use the actual configured providers, not a stale provider list.

Removing an allowlist entry alone does not revoke existing membership. For a
separately authorized revocation, deactivate the membership and remove its
allowlist entry. Existing requests must then fail membership checks. Household
delete cascades financial data and is not a routine rollback after testers have
started using it; preserve data and obtain explicit deletion authorization.
