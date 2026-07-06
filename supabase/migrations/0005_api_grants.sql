-- 0005_api_grants.sql
-- Grant the Supabase API roles table-level DML on the public schema.
--
-- Why: migration 0001 created every table but issued no GRANTs, relying on
-- implicit default privileges. On a fresh Supabase the public-schema default
-- privileges for the migration owner (postgres) grant the API roles only
-- `Dxtm` (TRUNCATE / REFERENCES / TRIGGER / MAINTAIN) — NOT SELECT / INSERT /
-- UPDATE / DELETE. The result: PostgREST returns "permission denied for table …"
-- for anon / authenticated / service_role on EVERY table, regardless of RLS, so
-- the web app and bot cannot read or write anything on a fresh project. This was
-- invisible to the offline throwaway-Postgres checks because those connected as
-- the table owner/superuser, which skips the table-privilege layer entirely; it
-- only surfaces against the real Supabase API roles.
--
-- What this does NOT change: Row Level Security still gates which ROWS each
-- caller sees (the `*_member_all` / `is_household_member` policies from 0001).
-- These grants only open the TABLE-level door PostgREST needs before RLS runs.
-- Granting `anon` is the Supabase-idiomatic default and is safe here: no RLS
-- policy passes for an unauthenticated caller (auth.uid() is null), so anon can
-- still read/write nothing.
--
-- Functions are intentionally NOT re-granted here: the SECURITY DEFINER RPCs in
-- migrations 0002–0004 already `revoke all … from public` and
-- `grant execute … to authenticated`, and re-opening them to anon would undo that
-- deliberate posture (they would fail the is_household_member gate anyway).
--
-- Guarded in a DO block so this migration is also runnable on a plain Postgres
-- for review, where Supabase's anon/authenticated/service_role roles are absent
-- (mirrors the defensive guards in 0001–0004).

do $$ begin
  grant usage on schema public to anon, authenticated, service_role;
  grant all on all tables in schema public to anon, authenticated, service_role;
  grant all on all sequences in schema public to anon, authenticated, service_role;
  -- Future tables/sequences created by the migration owner inherit the grant, so
  -- later migrations don't have to repeat it.
  alter default privileges in schema public
    grant all on tables to anon, authenticated, service_role;
  alter default privileges in schema public
    grant all on sequences to anon, authenticated, service_role;
exception when undefined_object then null; end $$;
