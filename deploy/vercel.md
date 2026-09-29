# Web deploy — Vercel checklist (spec §4.2)

The Next.js app (`apps/web`) deploys to Vercel. `unpdf` was chosen precisely
because it has no native deps and builds on Vercel. The web app talks to the
VPS Supabase over public HTTPS with the ANON key only — the service-role key is
NEVER a Vercel env.

## 1. Project env vars (Production)

| Variable                          | Value                                                      | Notes                                                               |
| --------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------- |
| `NEXT_PUBLIC_SUPABASE_URL`        | `https://supabase.family-finance.ondemandly.dev`           | Caddy → Kong on the VPS                                             |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY`   | anon JWT from `deploy/supabase/.env`                       | anon, NEVER service role                                            |
| `NEXT_PUBLIC_SITE_URL`            | `https://family-finance.ondemandly.dev`                    | canonical origin: metadata and the fallback for auth redirects      |
| `ALLOWED_WEB_HOSTS`               | comma-separated list of every web hostname on this project | auth redirects stay on the request host only when it is listed here |
| `IMPORT_PREVIEW_SIGNING_SECRET`   | independent random 32+ character secret                    | signs short-lived preview/confirmation claims; web-only             |
| `IMPORT_SUGGESTION_URL`           | the bot's HTTPS origin                                     | HTTPS bot origin; redirects are refused                             |
| `IMPORT_SUGGESTION_SHARED_SECRET` | same random 32+ character value as `deploy/bot/.env`       | HMAC-authenticates web-to-bot suggestion requests                   |

Do NOT set: `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_JWT_SECRET` (local-only in
`apps/web/.env.local`; web data access is RLS/anon + auth cookies).

Removed: `AUTHORIZED_EMAILS` and `HOUSEHOLD_SLUG`. Access is decided by an
active `household_members` row; the allowlist lives in the `allowed_emails`
table. Delete both variables from the project if they are still set.

One deployment serves every household. Each web hostname is a domain on the
same Vercel project; the household always comes from the signed-in member,
never from the hostname.

## 2. Google OAuth production redirect

In the Google Cloud console, on the SAME OAuth client used locally, add:

- Authorized redirect URI: `https://supabase.family-finance.ondemandly.dev/auth/v1/callback`
- Authorized JavaScript origins: every web hostname in `ALLOWED_WEB_HOSTS`

## 3. GoTrue config mirror

The VPS GoTrue must mirror the working local `supabase/config.toml`
(see `deploy/supabase/.env.example`):

- `SITE_URL` = the canonical web origin; `ADDITIONAL_REDIRECT_URLS` lists
  `https://<host>/auth/callback` for every web hostname.
- Google external provider enabled, client id/secret via env.
- `GOTRUE_EXTERNAL_GOOGLE_SKIP_NONCE_CHECK=true` (local parity).
- Email signup enabled + autoconfirm. The `allowed_emails` table provisions
  membership on signup; the web gate checks for an active membership.

## 4. Deploy

Vercel project root: `apps/web` (monorepo — framework preset Next.js, pnpm).
After the first deploy, log in with one Google account per household and
confirm each lands provisioned (row in `household_members`) and sees only its
own household. Households are created with `scripts/create-household.mjs`; the
full production sequence is in
[`docs/runbooks/multi-tenancy-cutover.md`](../docs/runbooks/multi-tenancy-cutover.md).
