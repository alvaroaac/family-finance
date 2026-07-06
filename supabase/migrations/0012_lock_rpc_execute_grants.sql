-- 0012_lock_rpc_execute_grants.sql
-- Harden EXECUTE grants on every SECURITY DEFINER RPC.
--
-- Why: the Supabase stack ships `ALTER DEFAULT PRIVILEGES ... GRANT ALL ON
-- FUNCTIONS TO anon, authenticated, service_role`, so functions created by
-- `supabase db push` receive an EXPLICIT per-role EXECUTE grant to `anon`.
-- The earlier migrations only `revoke ... from public`, which removes the
-- PUBLIC pseudo-grant but leaves anon's explicit grant intact.
--
-- For create_installment_purchase / confirm_import / merge_category the
-- `is_household_member` gate still blocks anon (auth.uid() is null -> false),
-- so this is defense in depth there. For materialize_obligation_payment it is
-- a REAL hole: its gate is `auth.uid() is not null AND not member`, so a
-- null-uid anon caller passes the gate and can insert expense transactions
-- for any obligation UUID. Verified against the live self-hosted stack
-- (`\dp` showed `anon=X` on all four).
--
-- Fix: revoke EXECUTE from anon (and public) on all four, and (re)assert the
-- explicit grants the app roles actually need — authenticated (web, RLS-gated
-- inside each body) and service_role (the bot, which bypasses RLS and calls
-- with a null auth.uid()). The membership gate inside each body is unchanged;
-- after this migration the only null-uid caller that can reach a body is
-- service_role, which is exactly the bot's intended bypass.

do $$
declare
  fn text;
  fns text[] := array[
    'create_installment_purchase(jsonb, jsonb)',
    'confirm_import(jsonb, jsonb)',
    'merge_category(uuid, uuid, uuid)',
    'materialize_obligation_payment(uuid, text, date)'
  ];
begin
  foreach fn in array fns loop
    execute format('revoke all on function %s from public;', fn);
    -- anon must never execute these — guarded so it also runs on a plain
    -- Postgres for review, where the anon role is absent.
    begin
      execute format('revoke all on function %s from anon;', fn);
    exception when undefined_object then null; end;
    begin
      execute format('grant execute on function %s to authenticated;', fn);
    exception when undefined_object then null; end;
    -- The bot uses the service_role client (bypasses RLS; auth.uid() null).
    begin
      execute format('grant execute on function %s to service_role;', fn);
    exception when undefined_object then null; end;
  end loop;
end $$;
