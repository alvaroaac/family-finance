-- Disposable test fixtures and auth stub changes are rolled back together.
begin;
create or replace function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('test.member_id', true), '')::uuid
$$;
insert into auth.users(id, email) values
  ('a0000000-0000-0000-0000-000000000001', 'compat-member@example.test'),
  ('a0000000-0000-0000-0000-000000000002', 'compat-outsider@example.test');
insert into households(id, name) values ('a0000000-0000-0000-0000-000000000001', 'Compatibility');
insert into household_members(household_id,user_id) values
  ('a0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001');
insert into accounts(id, household_id, name, kind) values
  ('a0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'Template account', 'checking');
insert into obligations(id, household_id, description, amount_cents, start_month, due_day, account_id, created_by_user_id) values
  ('a0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001', 'Compatibility', 71044, '2026-01', 5,
   'a0000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000001');
select set_config('test.member_id', 'a0000000-0000-0000-0000-000000000001', true);
set local role authenticated;
do $$
declare payment jsonb; repeated jsonb;
begin
  payment := materialize_obligation_payment('a0000000-0000-0000-0000-000000000001', '2026-01');
  if payment #>> '{transaction,amount_cents}' is distinct from '71044'
     or payment #>> '{transaction,account_id}' is distinct from 'a0000000-0000-0000-0000-000000000001'
     or payment #>> '{transaction,occurred_on}' is distinct from '2026-01-05' then
    raise exception 'two-argument call lost template defaults: %', payment;
  end if;
  repeated := materialize_obligation_payment('a0000000-0000-0000-0000-000000000001', '2026-01', '2026-01-15');
  if repeated ->> 'already_paid' is distinct from 'true'
     or repeated #>> '{transaction,id}' is distinct from payment #>> '{transaction,id}' then
    raise exception 'legacy call lost idempotency';
  end if;
  payment := materialize_obligation_payment('a0000000-0000-0000-0000-000000000001', '2026-02', '2026-02-12');
  if payment #>> '{transaction,amount_cents}' is distinct from '71044'
     or payment #>> '{transaction,account_id}' is distinct from 'a0000000-0000-0000-0000-000000000001'
     or payment #>> '{transaction,occurred_on}' is distinct from '2026-02-12' then
    raise exception 'three-argument call lost defaults or explicit date';
  end if;
end $$;
select set_config('test.member_id', 'a0000000-0000-0000-0000-000000000002', true);
do $$ begin
  begin
    perform materialize_obligation_payment('a0000000-0000-0000-0000-000000000001', '2026-03');
    raise exception 'outsider unexpectedly allowed';
  exception when invalid_parameter_value then null; end;
end $$;
reset role;
set local role anon;
do $$ begin
  begin
    perform public.materialize_obligation_payment('a0000000-0000-0000-0000-000000000001', '2026-03');
    raise exception 'anon unexpectedly allowed';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
rollback;
