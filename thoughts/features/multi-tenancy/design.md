# Multi-tenancy, spec 1 of 2: tenancy

Date: 2026-09-29
Status: approved, implemented (see progress.md)
Follow-up: spec 2 (encryption at rest), not yet written

## Goal

Onboard a second household (a beta tester) on the existing deployment so that:

- their data is isolated from every other household, enforced by the database;
- their login does not interact with any other household's;
- the Telegram bot serves them inside their own household only;
- the app carries their household name and their colors;
- the URL they use, the login page, the Google consent screen and the bot never
  mention Alvaro or Karol.

Households are created by the operator from the command line. There is no signup
or configuration UI.

## Non-goals

- Signup, invitation, or household-management UI.
- Theme configuration UI.
- Billing, plans, per-tenant quotas beyond the existing AI quota.
- Encryption at rest and encrypted backups (spec 2).
- One Telegram bot per household.
- A user belonging to more than one household.
- A separate deployment or database per household.
- Login page branding per hostname.

## Decisions

| # | Decision | Rationale |
|---|---|---|
| D1 | Shared database, shared schema, isolation by `household_id` + RLS | Already built for every business table; schema-per-tenant or stack-per-tenant multiplies operations with no privacy gain |
| D2 | One user belongs to exactly one household | Matches both known households; removes the need for a household switcher |
| D3 | Authorization is an active `household_members` row | Replaces the `AUTHORIZED_EMAILS` env gate, which would require a redeploy per tenant |
| D4 | One shared Telegram bot | No new infrastructure; sender identity already maps to a household |
| D5 | Bot runs business queries under RLS as the resolved member | Turns cross-tenant bugs into database denials instead of relying on every call passing the right `household_id` |
| D6 | Theme is a base theme plus token overrides stored on the household | Reuses the two existing themes; a tenant's color is a small override, not a new stylesheet |
| D7 | Investment buckets are free-form per household | The `investment_bucket_slug` enum encodes one family's goals |
| D8 | One deployment, several web hostnames; the Supabase API moves to a neutral hostname | The existing household keeps `alvaroekarol.com.br`; other households get a neutral URL and a neutral Google consent screen without a second deployment |

## 1. Tenancy core

### Schema

- `allowed_emails.household_slug` is replaced by `household_id`, a required foreign
  key to `households`. Existing rows are backfilled to the existing household.
- The signup and allowlist provisioning triggers place the user in
  `allowed_emails.household_id`. The `select ... from households limit 1` lookup is
  removed.
- `household_members.user_id` becomes unique on its own (D2).
- An email may appear in `allowed_emails` once (already the primary key), so it maps
  to one household.

### Authorization

- The web gate (`requireAuthorizedUser`) allows a session when the user has an active
  `household_members` row, and denies otherwise. The denied screen stays.
- `AUTHORIZED_EMAILS` and `HOUSEHOLD_SLUG` are removed from config, env examples and
  deploy docs.
- A Google account that is not allowlisted can still complete OAuth and get an
  `auth.users` row. It has no membership, so RLS returns nothing and the web gate
  denies it. This is existing behavior and is kept.

### Hardcoded household

- New households must not depend on UUID `…0001`. Migrations 0021 and 0022 seeded
  income categories for that UUID only; they are history and stay untouched. The
  default category set moves into the provisioning script so every household gets it.
- Tests may keep using `…0001` as a fixture id.

### Provisioning script

`scripts/create-household` is the only onboarding tool. One invocation, run by the
operator against the production database, in one transaction:

| Input | Effect |
|---|---|
| household name | `households` row |
| base theme + token overrides | `households.theme` |
| member emails | `allowed_emails` rows pointing at the new household |
| (none) | default categories and subcategories |
| (none) | no investment buckets; the household creates its own |

It is idempotent on household name + email set, and prints the new household id.
Members appear in `household_members` on their first Google login, through the
existing trigger.

### Free-form investment buckets (D7)

- `investment_buckets.slug` changes from the enum to text; the enum is dropped.
  `unique(household_id, slug)` stays.
- The slug is derived from the name on creation.
- The investments page gets create, rename and delete for buckets. Delete is allowed
  only when the balance is zero.
- Code that switches on the three known slugs (dashboard, investments page and
  actions, domain `accounts`) is changed to treat buckets as data.
- The existing household keeps its three buckets unchanged.

## 2. Bot isolation

### Identity resolution

- Resolution is by `telegram_user_id` only. The column is unique across all
  households, so one Telegram account maps to at most one member.
- Amended after the pull request review (migration `0032`): a member links
  Telegram with a one-time code generated in Settings and sent to the bot as
  `/vincular CODE`. Matching by `telegram_username` was removed, because a member
  could type another person's identity and take over their bot access.
- Resolution moves behind a narrow `SECURITY DEFINER` function that returns only
  `household_id`, `user_id` and `display_name` for the given Telegram identity. It is
  the only cross-household read the bot can perform.

### Data access (D5)

- After resolution the bot creates a database client that acts as the resolved user,
  using a short-lived token signed with the project's JWT secret. All business reads
  and writes go through that client, so RLS applies.
- The service-role client remains only for: identity resolution, the import
  suggestion nonce and AI usage functions, and the conversation store.
- RPCs that currently accept a null `auth.uid()` for the service-role bot are
  tightened to require a member once the bot no longer calls them that way.
- The bot's web-facing endpoint (`/internal/v1/import-category-suggestions`) already
  receives requests signed by the web app; the household id used for quota comes from
  the signed payload and is verified against the requesting user.

### Conversation state

- `bot_conversations` is keyed by `(chat_id, telegram_user_id)` and carries
  `household_id`. In a group chat, two people never share a draft, whichever
  household they belong to.
- Existing rows are discarded by the migration; they expire in 24 hours anyway.

### Copy and prompts

- Unknown-sender replies stop naming a person. In pt-BR,
  the reply explains how to link: open Configurações in Family Finance, choose
  "Vincular Telegram" and send the code in a private chat. The exact text lives in
  `apps/bot/src/index.ts`.
- LLM prompt examples and reply examples use neutral placeholder names.
- The routing rules that match "Karol comprou" match any member `display_name` of the
  sender's household, loaded at request time.

### Third parties

The bot sends message text and audio to OpenAI, Anthropic and Telegram for every
household, using the operator's API keys and Codex subscription. This does not change
and must be disclosed to the tester before onboarding.

## 3. Theming and branding

### Theme (D6)

- `households.theme` is a JSON document: a base theme (`esmeralda` or `salvia`) and an
  optional map of token overrides.
- Overridable tokens are a closed list: `--ff-bg`, `--ff-surface`,
  `--ff-surface-soft`, `--ff-tint`, `--ff-ink`, `--ff-ink-soft`, `--ff-accent`,
  `--ff-accent-hover`, `--ff-border`, `--ff-on-accent`. Status colors (positive,
  negative, warn), radii and shadows are not overridable.
- Values are validated as hex colors when read. An invalid document falls back to the
  base theme and logs a warning.
- The authenticated layout loads the household and applies the overrides as CSS
  variables on the root element. No stylesheet is generated.
- The existing per-browser theme picker keeps choosing the base theme. Household
  overrides apply on top of whichever base is active, so an override set must be
  checked against both bases, or the household is seeded with the picker hidden. The
  seed decides per household with a `lockBase` flag in the theme document.
- The 13 hex colors hardcoded in `ui.css` are reviewed; any that represent brand color
  become tokens.

### Branding

- The app header shows `households.name` and drops the fixed "Alvaro & Karol" /
  "Nossa casa" text.
- Login page, metadata description and Open Graph image become product-neutral. The
  product name shown is "Family Finance" until a name is chosen.
- Login copy that implies a two-person invite is rewritten for any household.

## 4. Domains (D8)

One deployment serves several web hostnames. A hostname is an entry point, not a
tenant: the household always comes from the logged-in user's membership, never from
the host.

| Service | Hostname | Change |
|---|---|---|
| Web | `alvaroekarol.com.br` (current host) | stays |
| Web | `family-finance.ondemandly.dev` | added to the same Vercel project |
| Supabase API | `supabase.family-finance.ondemandly.dev` | moved from `supabase.alvaroekarol.com.br` |
| Bot | `bot.alvaroekarol.com.br` | stays; no user ever sees it |

### Web

- The OAuth `redirectTo` and every absolute URL the app builds are derived from the
  request host, checked against a closed list of allowed hosts in config. An unknown
  host falls back to the neutral hostname.
- `NEXT_PUBLIC_SITE_URL` stops being the source for redirects. It remains only as the
  canonical URL for metadata and points at the neutral hostname.
- Every web hostname is listed in the GoTrue redirect allowlist.
- Sessions are per hostname. A user logged in on one host is not logged in on another.
- The login page is the same neutral page on every host.

### Supabase API

- The Supabase API moves to the neutral hostname because Google's consent screen
  shows the domain of the OAuth callback, which is the Supabase API host.
- Changes: Traefik route, GoTrue external URL, Google OAuth authorized redirect URI,
  Supabase URL in web and bot env.
- The old Supabase hostname stays routed until the new one is verified, then is
  removed. Preserving existing sessions across the move is not a requirement; the
  current users logging in again once is acceptable. No work is done to avoid it.

### Adding a domain later

A household that brings its own domain needs three operator steps and no code
change: add the domain to the Vercel project, add it to the allowed hosts config, add
it to the GoTrue redirect allowlist.

### Limits of this model

- The Google consent screen is shared: one app name and one callback domain for all
  households. A single GoTrue instance holds one Google OAuth client.
- The bot has one name for all households.
- A household that needs its own Google consent branding is the trigger to consider
  a separate stack for that household.

## 5. Google OAuth

- Google Sign-In has no per-user or per-request charge. Self-hosted GoTrue has no
  monthly-active-user billing.
- The app requests only `openid`, `email` and `profile`.
- The OAuth consent screen must be in production status, not testing. Testing status
  limits sign-in to manually listed test users.
- To confirm before implementation, against Google's current documentation: whether
  production status with these scopes requires brand verification, and whether
  verification requires proof of ownership of `ondemandly.dev`.

## 6. Verification

| Check | Proves |
|---|---|
| `rls-proof` extended to two households, every table | A member of A reads and writes nothing of B |
| `rls-proof` extended to every RPC | No RPC accepts another household's ids |
| Provisioning test | A new allowlisted email joins the household named in `allowed_emails`, never another |
| Bot test: two members, two households, same group chat | Separate drafts, separate writes, callback taps refused across users |
| Bot test: unknown sender | Refusal, nothing written |
| Bot test: business query with a forged `household_id` | Denied by the database |
| Theme test | Overrides applied; invalid document falls back |
| Search for "Alvaro", "Karol", "alvaroekarol" in `apps/` and `packages/` non-test code | No matches |
| Login test per allowed host | The OAuth round trip returns to the host it started on |
| Login test with an unknown host header | Redirect goes to the neutral hostname |
| Manual: login on `alvaroekarol.com.br` | Existing household works as before |
| Manual: tester login on the neutral hostname | Consent screen and URL show only `ondemandly.dev` |

## Onboarding sequence

1. Ship this spec.
2. Disclose to the tester: third-party AI processing, and that data is not yet
   encrypted at rest.
3. Run `scripts/create-household` with their name, color and emails.
4. They log in with Google and link Telegram in Settings.

Step 3 does not wait for spec 2.

## Resolved questions (2026-09-29)

1. The tester onboards after this spec, pending their confirmation. Spec 2 follows.
2. The product name is "Family Finance" for now.
3. No administrator role. Every member links their own Telegram in Settings with a
   one-time code (section 2).
4. Domain model: one deployment serving several hostnames (section 4). A stack per
   household was rejected: it multiplies operations while the operator remains root
   on every stack.

## Carried to spec 2

- Encryption of free-text columns with per-household keys.
- Whether amounts are encrypted. Income amounts and bucket balances are sensitive on
  their own; encrypting them moves arithmetic out of about 14 SQL functions.
  Options to evaluate: plaintext amounts, encrypting bucket balances only, in-database
  decryption with a key supplied per request.
- Keyed fingerprints for import deduplication.
- Encrypted backups with the key held off the VPS.
- The master key in the bot's environment on the VPS is readable by the operator.
