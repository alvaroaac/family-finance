-- Refuse to baseline a manually managed database unless the final schema
-- fingerprints prove that migrations 0001 through 0021 are already present.
do $migration_baseline$
declare
  missing text[] := array[]::text[];
begin
  if to_regclass('public.households') is null then missing := missing || '0001 households'; end if;
  if to_regprocedure('public.create_installment_purchase(jsonb,jsonb)') is null then
    missing := missing || '0002 installment purchase RPC';
  end if;
  if to_regprocedure('public.merge_category(uuid,uuid,uuid)') is null then missing := missing || '0003 merge_category'; end if;
  if to_regprocedure('public.confirm_import(jsonb,jsonb)') is null then missing := missing || '0004 confirm_import'; end if;
  if not has_table_privilege('authenticated', 'public.transactions', 'select,insert,update,delete') then
    missing := missing || '0005 API grants';
  end if;
  if not exists (
    select 1 from pg_enum enum_value
    join pg_type enum_type on enum_type.oid = enum_value.enumtypid
    where enum_type.typname = 'import_source' and enum_value.enumlabel = 'mercado_pago_pdf'
  ) then missing := missing || '0006 mercado_pago_pdf'; end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'household_members'
      and column_name in ('display_name', 'telegram_user_id')
    group by table_schema, table_name having count(*) = 2
  ) or not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'investment_buckets'
      and column_name = 'balance_cents'
  ) then missing := missing || '0007 member profile and balances'; end if;
  if to_regclass('public.bot_conversations') is null then missing := missing || '0008 bot_conversations'; end if;
  if to_regclass('public.allowed_emails') is null or not exists (
    select 1 from pg_trigger where tgname = 'provision_member_on_signup' and not tgisinternal
  ) then missing := missing || '0009 member provisioning'; end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'household_members'
      and column_name = 'telegram_username'
  ) or not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'household_members'
      and policyname = 'household_members_update'
  ) then missing := missing || '0010 member update policy'; end if;
  if to_regclass('public.obligations') is null then missing := missing || '0011 obligations'; end if;
  if has_function_privilege('anon', 'public.merge_category(uuid,uuid,uuid)', 'execute') then
    missing := missing || '0012 anon RPC lock';
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'transactions_hh_category_fk'
  ) then missing := missing || '0013 household foreign keys'; end if;
  if not exists (
    select 1 from pg_trigger where tgname = 'provision_member_on_allowlist' and not tgisinternal
  ) then missing := missing || '0014 resilient provisioning'; end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'transactions' and column_name = 'bill_month'
  ) or to_regprocedure('public.settle_card_bill(uuid,uuid,uuid,text,bigint,date,uuid)') is null then
    missing := missing || '0015 card bill payments';
  end if;
  if to_regclass('public.import_item_claims') is null
     or to_regclass('public.import_ai_usage') is null
     or to_regprocedure('public.confirm_import_v2(jsonb,jsonb)') is null then
    missing := missing || '0016 import reliability';
  end if;
  if to_regprocedure('public.materialize_obligation_payment(uuid,text,date,bigint)') is null then
    missing := missing || '0017 payment actual amount';
  end if;
  if to_regprocedure('public.materialize_obligation_payment(uuid,text,date,bigint,uuid)') is null then
    missing := missing || '0018 payment account override';
  end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'installment_groups'
      and column_name = 'idempotency_key'
  ) or to_regclass('public.installment_groups_idempotency_key_uniq') is null then
    missing := missing || '0019 installment idempotency';
  end if;
  if to_regprocedure('public.materialize_obligation_payment(uuid,text,date)') is not null then
    missing := missing || '0020 legacy payment RPC cleanup';
  end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'categories' and column_name = 'kind'
  ) then missing := missing || '0021 category kind'; end if;

  if cardinality(missing) > 0 then
    raise exception 'cannot baseline; missing schema fingerprints: %', array_to_string(missing, ', ');
  end if;
end
$migration_baseline$;
