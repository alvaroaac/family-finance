-- The harness uses this same file to seed legacy rows before the new migration.
\if :{?prepare_backfill}
-- This disposable fixture creates two houses before multi-tenancy. Remove
-- only the bootstrap allowlist seed; assigning an unknown legacy email to
-- either fixture house would violate the real ambiguity guard.
delete from allowed_emails where email='alvaro.a.a.a.c@gmail.com';
do $$ begin
  if exists(select 1 from allowed_emails) then
    raise exception 'card fixture has unexpected legacy allowlist rows';
  end if;
end $$;
insert into auth.users(id,email) values
  ('81000000-0000-0000-0000-000000000001','bill-member@example.test'),
  ('81000000-0000-0000-0000-000000000002','bill-outsider@example.test');
insert into households(id,name) values
  ('82000000-0000-0000-0000-000000000001','Bill household'),
  ('82000000-0000-0000-0000-000000000002','Other household');
insert into household_members(household_id,user_id) values
  ('82000000-0000-0000-0000-000000000001','81000000-0000-0000-0000-000000000001'),
  ('82000000-0000-0000-0000-000000000002','81000000-0000-0000-0000-000000000002');
insert into accounts(id,household_id,kind,name) values
  ('83000000-0000-0000-0000-000000000001','82000000-0000-0000-0000-000000000001','checking','Source'),
  ('83000000-0000-0000-0000-000000000002','82000000-0000-0000-0000-000000000001','checking','Other source'),
  ('83000000-0000-0000-0000-000000000003','82000000-0000-0000-0000-000000000002','checking','Foreign source');
insert into credit_cards(id,household_id,name,closing_day) values
  ('84000000-0000-0000-0000-000000000001','82000000-0000-0000-0000-000000000001','Manual',null),
  ('84000000-0000-0000-0000-000000000002','82000000-0000-0000-0000-000000000001','Auto',31),
  ('84000000-0000-0000-0000-000000000003','82000000-0000-0000-0000-000000000002','Foreign',null);
insert into import_batches(id,household_id,source,created_by_user_id) values
  ('85000000-0000-0000-0000-000000000001','82000000-0000-0000-0000-000000000001','nubank_csv','81000000-0000-0000-0000-000000000001');
insert into transactions(household_id,kind,amount_cents,occurred_on,description,credit_card_id,account_id,created_by_user_id)
select '82000000-0000-0000-0000-000000000001', kind::transaction_kind, amount, occurred::date,
  description, card::uuid, account::uuid, '81000000-0000-0000-0000-000000000001'
from (values
  ('expense',100,'2000-04-29','Legacy expense','84000000-0000-0000-0000-000000000002',null),
  ('income',20,'2000-04-30','Legacy refund','84000000-0000-0000-0000-000000000002',null),
  ('expense',50,'2000-02-28','Legacy February','84000000-0000-0000-0000-000000000002',null),
  ('transfer',40,'2000-04-30','Legacy card transfer','84000000-0000-0000-0000-000000000002',null),
  ('expense',60,'2000-04-30','Legacy account',null,'83000000-0000-0000-0000-000000000001'),
  ('income',70,'2000-04-30','Legacy account income',null,'83000000-0000-0000-0000-000000000001'),
  ('transfer',80,'2000-04-30','Legacy account transfer',null,'83000000-0000-0000-0000-000000000001')
) as fixture(kind,amount,occurred,description,card,account);
update transactions set import_batch_id='85000000-0000-0000-0000-000000000001'
where description='Legacy February';
insert into transactions(household_id,kind,amount_cents,occurred_on,description,credit_card_id,
  account_id,bill_month,created_by_user_id)
values ('82000000-0000-0000-0000-000000000001','transfer',30,'2000-05-01','Legacy bill payment',
  '84000000-0000-0000-0000-000000000002','83000000-0000-0000-0000-000000000001','2000-04',
  '81000000-0000-0000-0000-000000000001');
create table card_bill_test_old_totals as
select household_id,credit_card_id,to_char(occurred_on,'YYYY-MM') as month,
  sum(case when kind='income' then -amount_cents else amount_cents end) as cents
from transactions where credit_card_id is not null and kind <> 'transfer'
group by household_id,credit_card_id,to_char(occurred_on,'YYYY-MM');
\else
\if :{?prepare_reapply}
-- Migration replay runs outside the API and has no JWT role.
create or replace function auth.role() returns text language sql stable
as $$ select null::text $$;
-- A live shifted attribution must survive migration replay, not be backfilled again.
insert into card_bill_closures(household_id,credit_card_id,bill_month,state,updated_by_user_id)
values ('82000000-0000-0000-0000-000000000001','84000000-0000-0000-0000-000000000001','2099-12','closed','81000000-0000-0000-0000-000000000001');
insert into transactions(household_id,kind,amount_cents,occurred_on,description,credit_card_id,created_by_user_id)
values ('82000000-0000-0000-0000-000000000001','expense',99,'2099-12-10','Preserved replay attribution','84000000-0000-0000-0000-000000000001','81000000-0000-0000-0000-000000000001');
\else
begin;
-- JWT-setting stubs model auth helpers without cached literal function bodies
-- when switching callers inside this transaction.
create or replace function auth.uid() returns uuid language sql stable
as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
create or replace function auth.role() returns text language sql stable
as $$ select nullif(current_setting('request.jwt.claim.role',true),'') $$;
create function pg_temp.assert_bill(ok boolean, message text) returns void
language plpgsql as $$ begin
  if ok is distinct from true then raise exception '%', message; end if;
end $$;
create function pg_temp.expect_bill_error(statement text, code text, message text) returns void
language plpgsql as $$ begin
  begin
    execute statement;
  exception when others then
    if sqlstate = code and position(message in sqlerrm) > 0 then return; end if;
    raise;
  end;
  raise exception 'Expected % containing %: %', code, message, statement;
end $$;
-- Test-only helpers keep every probe on the same public RPC/write path.
create function pg_temp.pay_bill(key text, amount bigint default 100,
  account uuid default '83000000-0000-0000-0000-000000000001',
  month text default '2090-12', paid date default (now() at time zone 'America/Sao_Paulo')::date,
  card uuid default '84000000-0000-0000-0000-000000000001') returns jsonb
language sql as $$ select settle_card_bill(
  '82000000-0000-0000-0000-000000000001',card,account,month,amount,paid,
  '81000000-0000-0000-0000-000000000001',key); $$;
create function pg_temp.charge_bill(day date, card uuid default '84000000-0000-0000-0000-000000000001',
  batch uuid default null, transaction_kind transaction_kind default 'expense') returns transactions
language sql as $$ insert into transactions(household_id,kind,amount_cents,occurred_on,
  description,credit_card_id,created_by_user_id,import_batch_id,invoice_month)
values ('82000000-0000-0000-0000-000000000001',transaction_kind,123,day,
  'Attribution probe',card,'81000000-0000-0000-0000-000000000001',batch,'1900-01') returning *; $$;

-- C27: all legacy rows, including refunds, retain their calendar-month attribution.
select pg_temp.assert_bill(not exists (
  select 1 from transactions where description like 'Legacy%'
  and invoice_month is distinct from case when credit_card_id is not null and kind <> 'transfer'
    then to_char(occurred_on,'YYYY-MM') else null end
), 'C27 legacy attribution differs');
select pg_temp.assert_bill(not exists (
  select 1 from card_bill_test_old_totals old
  full join (
    select household_id,credit_card_id,invoice_month as month,
      sum(case when kind='income' then -amount_cents else amount_cents end) as cents
    from transactions where description like 'Legacy%' and credit_card_id is not null and kind <> 'transfer'
    group by household_id,credit_card_id,invoice_month
  ) new using (household_id,credit_card_id,month)
  where old.cents is distinct from new.cents
), 'C27 historical totals changed');
select pg_temp.assert_bill((select invoice_month='2100-01' from transactions
  where description='Preserved replay attribution'), 'Migration replay reset shifted attribution');
select pg_temp.assert_bill(to_regprocedure('settle_card_bill(uuid,uuid,uuid,text,bigint,date,uuid)') is null,
  'Legacy 7-arg RPC remains');
select pg_temp.assert_bill(to_regclass('transactions_card_bill_month_uniq') is null,'Old payment limit remains');
select pg_temp.assert_bill(not has_function_privilege('anon',
  'settle_card_bill(uuid,uuid,uuid,text,bigint,date,uuid,text)','execute'), 'Anon can settle');
select pg_temp.assert_bill(has_function_privilege('authenticated',
  'card_bill_is_closed(uuid,text)','execute') and has_function_privilege('service_role',
  'card_bill_is_closed(uuid,text)','execute'), 'Closure helper grants missing');

-- C1/C3/C4/C5: dates in the distant past/future, plus exactly today's closing day.
select pg_temp.assert_bill(card_bill_is_closed('84000000-0000-0000-0000-000000000002',m), 'C3 past month not closed')
from (values ('2000-04'),('2000-02'),('2001-02')) months(m);
select pg_temp.assert_bill(not card_bill_is_closed('84000000-0000-0000-0000-000000000002','2090-04'), 'Future auto month closed');
select pg_temp.assert_bill(not card_bill_is_closed('84000000-0000-0000-0000-000000000001','2000-04'), 'C4 null closing day auto-closed');
update credit_cards set closing_day=extract(day from (now() at time zone 'America/Sao_Paulo')::date)
where id='84000000-0000-0000-0000-000000000002';
select pg_temp.assert_bill(not card_bill_is_closed('84000000-0000-0000-0000-000000000002',
  to_char(now() at time zone 'America/Sao_Paulo','YYYY-MM')), 'C5 today equals closing date must stay open');
select pg_temp.assert_bill((pg_temp.charge_bill((now() at time zone 'America/Sao_Paulo')::date,
  '84000000-0000-0000-0000-000000000002')).invoice_month=to_char(now() at time zone 'America/Sao_Paulo','YYYY-MM'),
  'C1 purchase on closing date bumped');
update credit_cards set closing_day=28 where id='84000000-0000-0000-0000-000000000002';
insert into card_bill_closures(household_id,credit_card_id,bill_month,state,updated_by_user_id) values
  ('82000000-0000-0000-0000-000000000001','84000000-0000-0000-0000-000000000002','2000-05','open','81000000-0000-0000-0000-000000000001'),
  ('82000000-0000-0000-0000-000000000001','84000000-0000-0000-0000-000000000001','2090-12','closed','81000000-0000-0000-0000-000000000001'),
  ('82000000-0000-0000-0000-000000000001','84000000-0000-0000-0000-000000000001','2091-01','closed','81000000-0000-0000-0000-000000000001');
select pg_temp.assert_bill((pg_temp.charge_bill('2000-04-29','84000000-0000-0000-0000-000000000002')).invoice_month='2000-05',
  'C2/C10 backdated auto-closed charge not bumped');
select pg_temp.assert_bill(card_bill_is_closed('84000000-0000-0000-0000-000000000001','2090-12'), 'C6 manual close ignored');
select pg_temp.assert_bill((pg_temp.charge_bill('2090-12-28')).invoice_month='2091-02', 'C6/C9/B4 consecutive closure/year rollover failed');
select pg_temp.assert_bill((pg_temp.charge_bill('2090-12-28',batch=>'85000000-0000-0000-0000-000000000001')).invoice_month='2090-12',
  'C11 imported charge bumped');
select pg_temp.assert_bill((pg_temp.charge_bill('2090-12-28',transaction_kind=>'income')).invoice_month='2091-02', 'Card income not attributed');
select pg_temp.assert_bill((pg_temp.charge_bill('2090-12-28',transaction_kind=>'transfer')).invoice_month is null, 'Transfer has invoice attribution');
update card_bill_closures set state='open' where credit_card_id='84000000-0000-0000-0000-000000000001' and bill_month='2090-12';
select pg_temp.assert_bill(not card_bill_is_closed('84000000-0000-0000-0000-000000000001','2090-12')
  and (pg_temp.charge_bill('2090-12-29')).invoice_month='2090-12', 'C7 manual reopen ignored');
insert into card_bill_closures(household_id,credit_card_id,bill_month,state,updated_by_user_id)
values ('82000000-0000-0000-0000-000000000001','84000000-0000-0000-0000-000000000002','2000-04','open','81000000-0000-0000-0000-000000000001');
select pg_temp.assert_bill(not card_bill_is_closed('84000000-0000-0000-0000-000000000002','2000-04')
  and (pg_temp.charge_bill('2000-04-29','84000000-0000-0000-0000-000000000002')).invoice_month='2000-04', 'C8 auto reopen ignored');

-- C12/C13: amount/description/client attribution edits preserve the stored month;
-- date, card and kind changes reapply the insertion rules.
do $$ declare row transactions; begin
  row := pg_temp.charge_bill('2090-12-15');
  update card_bill_closures set state='closed' where credit_card_id=row.credit_card_id and bill_month='2090-12';
  update transactions set amount_cents=456,description='Edited closed charge',invoice_month='1900-01' where id=row.id;
  perform pg_temp.assert_bill((select invoice_month='2090-12' and amount_cents=456 from transactions where id=row.id), 'C12 closed edit moved month');
  update transactions set occurred_on='2090-12-16' where id=row.id;
  perform pg_temp.assert_bill((select invoice_month='2091-02' from transactions where id=row.id), 'C13 date change not recomputed');
  update transactions set credit_card_id='84000000-0000-0000-0000-000000000002' where id=row.id;
  perform pg_temp.assert_bill((select invoice_month='2090-12' from transactions where id=row.id), 'C13 card change not recomputed');
  update transactions set kind='transfer' where id=row.id;
  perform pg_temp.assert_bill((select invoice_month is null from transactions where id=row.id), 'Kind transfer not cleared');
  update transactions set kind='income' where id=row.id;
  perform pg_temp.assert_bill((select invoice_month='2090-12' from transactions where id=row.id), 'Kind income not recomputed');
  update transactions set credit_card_id=null,account_id='83000000-0000-0000-0000-000000000001' where id=row.id;
  perform pg_temp.assert_bill((select invoice_month is null from transactions where id=row.id), 'Non-card update not cleared');
end $$;
insert into transactions(household_id,kind,amount_cents,occurred_on,description,account_id,created_by_user_id,invoice_month)
values ('82000000-0000-0000-0000-000000000001','expense',100,'2090-12-01','Non-card insert',
  '83000000-0000-0000-0000-000000000001','81000000-0000-0000-0000-000000000001','1900-01');
select pg_temp.assert_bill((select invoice_month is null from transactions where description='Non-card insert'), 'Non-card insert not cleared');
insert into card_bill_closures(household_id,credit_card_id,bill_month,state,updated_by_user_id)
select '82000000-0000-0000-0000-000000000001','84000000-0000-0000-0000-000000000001',
  to_char(date '2092-01-01'+ n*interval '1 month','YYYY-MM'),'closed','81000000-0000-0000-0000-000000000001'
from generate_series(0,23) n;
select pg_temp.assert_bill((pg_temp.charge_bill('2092-01-10')).invoice_month='2094-01', '24 bumps should reach first open month');
insert into card_bill_closures(household_id,credit_card_id,bill_month,state,updated_by_user_id)
values ('82000000-0000-0000-0000-000000000001','84000000-0000-0000-0000-000000000001','2094-01','closed','81000000-0000-0000-0000-000000000001');
select pg_temp.expect_bill_error($q$select pg_temp.charge_bill('2092-01-10')$q$,'22023','24');

-- Table format/state/override/household constraints and restricted card deletion.
select pg_temp.expect_bill_error($q$update card_bill_closures set total_override_cents=10,state='open' where bill_month='2090-12'$q$,'23514','check');
select pg_temp.expect_bill_error($q$update card_bill_closures set total_override_cents=-1 where bill_month='2090-12'$q$,'23514','check');
select pg_temp.expect_bill_error($q$update card_bill_closures set bill_month='2090-13' where bill_month='2090-12'$q$,'23514','check');
select pg_temp.expect_bill_error($q$update card_bill_closures set state='invalid' where bill_month='2090-12'$q$,'23514','check');
select pg_temp.expect_bill_error($q$update card_bill_closures set household_id='82000000-0000-0000-0000-000000000002' where bill_month='2090-12'$q$,'23503','foreign key');
select pg_temp.expect_bill_error($q$delete from credit_cards where id='84000000-0000-0000-0000-000000000001'$q$,'23503','foreign key');

-- E3/E11/E12/E16: authenticated member, same-key replay and partials.
grant usage on schema auth to authenticated, service_role;
select set_config('request.jwt.claim.sub','81000000-0000-0000-0000-000000000001',true);
select set_config('request.jwt.claim.role','authenticated',true);
set role authenticated;
do $$ declare first jsonb; replay jsonb; begin
  first := pg_temp.pay_bill('same-key');
  replay := pg_temp.pay_bill('same-key');
  perform pg_temp.assert_bill(first->'transaction'=replay->'transaction'
    and first->>'replayed'='false' and replay->>'replayed'='true', 'E11 replay is not original row');
  perform pg_temp.assert_bill(first->'transaction'->>'kind'='transfer'
    and first->'transaction'->>'bill_month'='2090-12'
    and first->'transaction'->>'occurred_on'=((now() at time zone 'America/Sao_Paulo')::date)::text
    and first->'transaction'->>'invoice_month' is null, 'E16 payment shape differs');
  perform pg_temp.pay_bill('second-key');
  perform pg_temp.pay_bill('open-key',month=>'2091-02');
  perform pg_temp.pay_bill('past-key',month=>'2000-04',paid=>'2000-05-01');
end $$;
-- The harness service_role is not BYPASSRLS, so inspect row counts as owner.
reset role;
select pg_temp.assert_bill((select count(*)=1 from transactions where idempotency_key='same-key'), 'E11 duplicate payment');
select pg_temp.assert_bill((select count(*)=2 from transactions where bill_month='2090-12'), 'E3 second payment blocked');
select pg_temp.assert_bill((select count(*)=1 from transactions where idempotency_key='open-key' and bill_month='2091-02')
  and (select count(*)=1 from transactions where idempotency_key='past-key' and bill_month='2000-04' and occurred_on='2000-05-01'),
  'Open/past fatura payments not persisted');
set role authenticated;
select pg_temp.expect_bill_error($q$select pg_temp.pay_bill('same-key',amount=>101)$q$,'22023','idempotency key reused with a different payment');
select pg_temp.expect_bill_error($q$select pg_temp.pay_bill('same-key',account=>'83000000-0000-0000-0000-000000000002')$q$,'22023','idempotency key reused with a different payment');
select pg_temp.expect_bill_error($q$select pg_temp.pay_bill('same-key',month=>'2090-11')$q$,'22023','idempotency key reused with a different payment');
select pg_temp.expect_bill_error($q$select pg_temp.pay_bill('same-key',paid=>(now() at time zone 'America/Sao_Paulo')::date-1)$q$,'22023','idempotency key reused with a different payment');
select pg_temp.expect_bill_error($q$select pg_temp.pay_bill('same-key',card=>'84000000-0000-0000-0000-000000000002')$q$,'22023','idempotency key reused with a different payment');
select pg_temp.expect_bill_error($q$select pg_temp.pay_bill('future',paid=>(now() at time zone 'America/Sao_Paulo')::date+1)$q$,'22023','future');
select pg_temp.expect_bill_error($q$select pg_temp.pay_bill(null)$q$,'22023','key');
select pg_temp.expect_bill_error($q$select pg_temp.pay_bill('')$q$,'22023','key');
select pg_temp.expect_bill_error($q$select pg_temp.pay_bill('null-amount',amount=>null)$q$,'22023','invalid amount');
select pg_temp.expect_bill_error($q$select pg_temp.pay_bill('zero',amount=>0)$q$,'22023','invalid amount');
select pg_temp.expect_bill_error($q$select pg_temp.pay_bill('negative',amount=>-1)$q$,'22023','invalid amount');
select pg_temp.expect_bill_error($q$select pg_temp.pay_bill('bad-month',month=>'2090-13')$q$,'22023','invalid month');
select pg_temp.expect_bill_error($q$select pg_temp.pay_bill('foreign-card',card=>'84000000-0000-0000-0000-000000000003')$q$,'22023','not found');
select pg_temp.expect_bill_error($q$select pg_temp.pay_bill('foreign-account',account=>'83000000-0000-0000-0000-000000000003')$q$,'22023','account 83000000-0000-0000-0000-000000000003 not found');
reset role;
select pg_temp.assert_bill((select count(*)=4 from transactions where idempotency_key is not null), 'Rejected payments wrote transactions');

-- C29/E15: real authenticated member CRUD, trigger visibility and RPC access.
grant usage on schema auth to authenticated, service_role;
select set_config('request.jwt.claim.sub','81000000-0000-0000-0000-000000000001',true);
select set_config('request.jwt.claim.role','authenticated',true);
set role authenticated;
insert into card_bill_closures(household_id,credit_card_id,bill_month,state,updated_by_user_id)
values ('82000000-0000-0000-0000-000000000001','84000000-0000-0000-0000-000000000001','2095-01','closed','81000000-0000-0000-0000-000000000001');
select pg_temp.assert_bill((select count(*)=1 from card_bill_closures where bill_month='2095-01'), 'C29 member select failed');
select pg_temp.assert_bill(card_bill_is_closed('84000000-0000-0000-0000-000000000001','2095-01'), 'Member closure helper ignored known closed month');
select pg_temp.assert_bill((pg_temp.charge_bill('2095-01-10')).invoice_month='2095-02', 'Member trigger cannot read closed override');
update card_bill_closures set state='open',total_override_cents=null where bill_month='2095-01';
select pg_temp.assert_bill((select state='open' from card_bill_closures where bill_month='2095-01'), 'C29 member update failed');
delete from card_bill_closures where bill_month='2095-01';
select pg_temp.assert_bill(not exists(select 1 from card_bill_closures where bill_month='2095-01'), 'C29 member delete failed');
select pg_temp.assert_bill((pg_temp.pay_bill('member-payment'))->>'replayed'='false', 'Member payment failed');
reset role;
select set_config('request.jwt.claim.sub','81000000-0000-0000-0000-000000000002',true);
set role authenticated;
select pg_temp.assert_bill(auth.uid()='81000000-0000-0000-0000-000000000002' and auth.role()='authenticated' and not is_household_member('82000000-0000-0000-0000-000000000001'), 'Non-member auth stub is stale');
select pg_temp.assert_bill(not exists(select 1 from card_bill_closures), 'C29 non-member sees closures');
select pg_temp.expect_bill_error($q$select card_bill_is_closed('84000000-0000-0000-0000-000000000001','2090-12')$q$,'42501','not accessible');
select pg_temp.expect_bill_error($q$insert into card_bill_closures(household_id,credit_card_id,bill_month,state,updated_by_user_id)
values ('82000000-0000-0000-0000-000000000001','84000000-0000-0000-0000-000000000001','2095-01','closed','81000000-0000-0000-0000-000000000002')$q$,'42501','row-level security');
update card_bill_closures set state='open' where bill_month='2090-12';
delete from card_bill_closures where bill_month='2090-12';
select pg_temp.expect_bill_error($q$select pg_temp.pay_bill('non-member')$q$,'42501','active member authentication required');
reset role;
select pg_temp.assert_bill((select state='closed' from card_bill_closures where bill_month='2090-12'), 'C29 non-member modified closure');
select set_config('request.jwt.claim.sub','',true);
set role authenticated;
select pg_temp.expect_bill_error($q$select pg_temp.pay_bill('null-uid')$q$,'42501','active member authentication required');
reset role;
select set_config('request.jwt.claim.role','',true);
set role authenticated;
select pg_temp.expect_bill_error($q$select pg_temp.pay_bill('null-role')$q$,'42501','active member authentication required');
reset role;

-- Integration: authorization loss must never turn a committed key into a
-- definitive-no-write result or grant a legacy draft a replacement key.
reset role;
select set_config('request.jwt.claim.sub','81000000-0000-0000-0000-000000000001',true);
select set_config('request.jwt.claim.role','authenticated',true);
set role authenticated;
do $$ declare rejected_hint text; begin
  begin
    perform pg_temp.pay_bill('hint-fresh',amount=>0);
    raise exception 'invalid amount accepted';
  exception when sqlstate '22023' then
    get stacked diagnostics rejected_hint = pg_exception_hint;
    perform pg_temp.assert_bill(rejected_hint='card_bill_definitive_no_write_v1', 'Authoritative absence hint missing');
  end;
  begin
    perform pg_temp.pay_bill('same-key',amount=>0);
    raise exception 'key mismatch accepted';
  exception when sqlstate '22023' then
    get stacked diagnostics rejected_hint = pg_exception_hint;
    perform pg_temp.assert_bill(coalesce(rejected_hint,'')='', 'Key mismatch was marked safe to rekey');
  end;
  perform pg_temp.assert_bill(reconcile_legacy_card_bill_payment(
    '82000000-0000-0000-0000-000000000001','84000000-0000-0000-0000-000000000002',
    '83000000-0000-0000-0000-000000000001','2000-04',30,'2000-05-01',
    '81000000-0000-0000-0000-000000000001')='matched','Exact legacy recovery failed');
  perform pg_temp.assert_bill(reconcile_legacy_card_bill_payment(
    '82000000-0000-0000-0000-000000000001','84000000-0000-0000-0000-000000000002',
    '83000000-0000-0000-0000-000000000001','2000-04',31,'2000-05-01',
    '81000000-0000-0000-0000-000000000001')='ambiguous','Legacy mismatch was not ambiguous');
end $$;
reset role;
update household_members set is_active=false where user_id='81000000-0000-0000-0000-000000000001';
set role authenticated;
select pg_temp.assert_bill(not exists(select 1 from transactions where idempotency_key='same-key'), 'Inactive member still sees payment');
do $$ declare rejected_hint text; begin
  begin
    perform pg_temp.pay_bill('same-key',amount=>0);
    raise exception 'inactive member payment passed';
  exception when insufficient_privilege then
    get stacked diagnostics rejected_hint = pg_exception_hint;
    perform pg_temp.assert_bill(coalesce(rejected_hint,'')='', 'Inactive member received a no-write marker');
  end;
  begin
    perform reconcile_legacy_card_bill_payment(
      '82000000-0000-0000-0000-000000000001','84000000-0000-0000-0000-000000000002',
      '83000000-0000-0000-0000-000000000001','2000-04',30,'2000-05-01',
      '81000000-0000-0000-0000-000000000001');
    raise exception 'Inactive legacy recovery allowed a new key';
  exception when insufficient_privilege then null; end;
end $$;
reset role;
update household_members set is_active=true where user_id='81000000-0000-0000-0000-000000000001';
select set_config('request.jwt.claim.sub','',true);
select set_config('request.jwt.claim.role','service_role',true);
set role service_role;
select pg_temp.expect_bill_error($q$select pg_temp.pay_bill('service-denied')$q$,'42501','active member authentication required');
reset role;
rollback;
\endif
\endif
