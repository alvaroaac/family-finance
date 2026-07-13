# Web deploy — Vercel checklist (spec §4.2)

The Next.js app (`apps/web`) deploys to Vercel. `unpdf` was chosen precisely
because it has no native deps and builds on Vercel. The web app talks to the
VPS Supabase over public HTTPS with the ANON key only — the service-role key is
NEVER a Vercel env.

## 1. Project env vars (Production)

| Variable | Value | Notes |
| --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | `https://supabase.alvaroekarol.com.br` | Caddy → Kong on the VPS |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | anon JWT from `deploy/supabase/.env` | anon, NEVER service role |
| `NEXT_PUBLIC_SITE_URL` | the Vercel production URL | used for auth redirects |
| `AUTHORIZED_EMAILS` | `alvaro.a.a.a.c@gmail.com,<karol-dotted-gmail>` | DOTTED Gmail forms — known gotcha: Google reports the dotted address, so the env must match it exactly |
| `HOUSEHOLD_SLUG` | `casa` | matches seed |
| `IMPORT_PREVIEW_SIGNING_SECRET` | independent random 32+ character secret | signs short-lived preview/confirmation claims; web-only |
| `IMPORT_SUGGESTION_URL` | `https://bot.alvaroekarol.com.br` | HTTPS bot origin; redirects are refused |
| `IMPORT_SUGGESTION_SHARED_SECRET` | same random 32+ character value as `deploy/bot/.env` | HMAC-authenticates web-to-bot suggestion requests |

Do NOT set: `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_JWT_SECRET` (local-only in
`apps/web/.env.local`; web data access is RLS/anon + auth cookies).

## 2. Google OAuth production redirect

In the Google Cloud console, on the SAME OAuth client used locally, add:

- Authorized redirect URI: `https://supabase.alvaroekarol.com.br/auth/v1/callback`
- Authorized JavaScript origin: the Vercel production URL

## 3. GoTrue config mirror

The VPS GoTrue must mirror the working local `supabase/config.toml`
(see `deploy/supabase/.env.example`):

- `SITE_URL` = the Vercel production URL (auth redirect allow-list).
- Google external provider enabled, client id/secret via env.
- `GOTRUE_EXTERNAL_GOOGLE_SKIP_NONCE_CHECK=true` (local parity).
- Email signup enabled + autoconfirm — signups are gated by the
  `allowed_emails` table (migration 0009) + the web `AUTHORIZED_EMAILS` check,
  not by disabling signup.

## 4. Deploy

Vercel project root: `apps/web` (monorepo — framework preset Next.js, pnpm).
After the first deploy, log in with both Google accounts and confirm each
lands provisioned (row in `household_members`) and sees the dashboard.
