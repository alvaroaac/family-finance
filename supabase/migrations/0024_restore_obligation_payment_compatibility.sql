-- Restore optional-argument callers after the already-applied 0020 cleanup.
-- Delegate all validation, authorization and idempotency to the current RPC.
create or replace function materialize_obligation_payment(
  target_obligation_id uuid,
  target_month text,
  paid_on date default null
)
returns jsonb
language sql
security definer
set search_path = public, pg_temp
as $$
  select materialize_obligation_payment(
    target_obligation_id, target_month, paid_on, null::bigint, null::uuid
  );
$$;

revoke all on function materialize_obligation_payment(uuid, text, date)
  from public, anon;
grant execute on function materialize_obligation_payment(uuid, text, date)
  to authenticated, service_role;
