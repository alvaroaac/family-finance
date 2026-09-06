-- Refuse to baseline a manually managed database unless the final schema
-- fingerprints prove that migrations 0001 through 0021 are already present.
do $migration_baseline$
declare
  missing text[] := array[]::text[];
  installment_rpc text;
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
    where enum_type.oid = to_regtype('public.import_source')
      and enum_value.enumlabel = 'mercado_pago_pdf'
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
    select 1
    from pg_trigger trigger
    join pg_class relation on relation.oid = trigger.tgrelid
    join pg_namespace schema on schema.oid = relation.relnamespace
    where trigger.tgname = 'provision_member_on_signup'
      and not trigger.tgisinternal
      and schema.nspname = 'auth'
      and relation.relname = 'users'
      and trigger.tgfoid = to_regprocedure('public.provision_household_member()')
      and trigger.tgenabled in ('O', 'A')
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
  if exists (
    select 1
    from unnest(array[
      'public.create_installment_purchase(jsonb,jsonb)',
      'public.confirm_import(jsonb,jsonb)',
      'public.confirm_import_v2(jsonb,jsonb)',
      'public.merge_category(uuid,uuid,uuid)',
      'public.materialize_obligation_payment(uuid,text,date,bigint)',
      'public.materialize_obligation_payment(uuid,text,date,bigint,uuid)',
      'public.settle_card_bill(uuid,uuid,uuid,text,bigint,date,uuid)'
    ]) rpc(signature)
    where to_regprocedure(rpc.signature) is null
       or has_function_privilege('anon', to_regprocedure(rpc.signature), 'execute')
  ) then
    missing := missing || '0012 anon RPC lock';
  end if;
  if not exists (
    select 1
    from pg_constraint constraint_record
    where constraint_record.conname = 'transactions_hh_category_fk'
      and constraint_record.contype = 'f'
      and constraint_record.conrelid = 'public.transactions'::regclass
      and constraint_record.confrelid = 'public.categories'::regclass
      and pg_get_constraintdef(constraint_record.oid) =
        'FOREIGN KEY (household_id, category_id) REFERENCES categories(household_id, id) ON DELETE SET NULL'
  ) then missing := missing || '0013 household foreign keys'; end if;
  if not exists (
    select 1
    from pg_trigger trigger
    join pg_class relation on relation.oid = trigger.tgrelid
    join pg_namespace schema on schema.oid = relation.relnamespace
    where trigger.tgname = 'provision_member_on_allowlist'
      and not trigger.tgisinternal
      and schema.nspname = 'public'
      and relation.relname = 'allowed_emails'
      and trigger.tgfoid = to_regprocedure('public.provision_on_allowlist()')
      and trigger.tgenabled in ('O', 'A')
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
  select lower(pg_get_functiondef(to_regprocedure('public.create_installment_purchase(jsonb,jsonb)')))
    into installment_rpc;
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'installment_groups'
      and column_name = 'idempotency_key'
  ) or not exists (
    select 1
    from pg_index index_record
    join pg_class index_relation on index_relation.oid = index_record.indexrelid
    where index_relation.relnamespace = 'public'::regnamespace
      and index_relation.relname = 'installment_groups_idempotency_key_uniq'
      and index_record.indrelid = 'public.installment_groups'::regclass
      and index_record.indisunique
      and pg_get_indexdef(index_record.indexrelid) like '%(household_id, idempotency_key)%'
      and pg_get_indexdef(index_record.indexrelid) like '%WHERE (idempotency_key IS NOT NULL)%'
  ) or installment_rpc is null
     or position('security definer' in installment_rpc) = 0
     or position('set search_path to ''public'', ''pg_temp''' in installment_rpc) = 0
     or position('target_idempotency_key text := nullif(group_payload ->> ''idempotency_key'', '''')' in installment_rpc) = 0
     or position('on conflict (household_id, idempotency_key)' in installment_rpc) = 0
     or position('idempotency key reused with different installments payload' in installment_rpc) = 0 then
    missing := missing || '0019 installment idempotency';
  end if;
  if to_regprocedure('public.materialize_obligation_payment(uuid,text,date)') is not null then
    missing := missing || '0020 legacy payment RPC cleanup';
  end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'categories' and column_name = 'kind'
      and data_type = 'text' and is_nullable = 'NO'
      and column_default = '''expense''::text'
  ) or not exists (
    select 1
    from pg_constraint constraint_record
    where constraint_record.conrelid = 'public.categories'::regclass
      and constraint_record.contype = 'c'
      and pg_get_constraintdef(constraint_record.oid) =
        'CHECK ((kind = ANY (ARRAY[''expense''::text, ''income''::text])))'
  ) or exists (
    select 1
    from (values ('Receitas'), ('Salário'), ('Freelas'), ('Investimentos')) expected(name)
    where not exists (
      select 1 from public.categories category
      where category.household_id = '00000000-0000-0000-0000-000000000001'
        and category.name = expected.name
        and category.kind = 'income'
    )
  ) then missing := missing || '0021 category kind'; end if;

  if cardinality(missing) > 0 then
    raise exception 'cannot baseline; missing schema fingerprints: %', array_to_string(missing, ', ');
  end if;
end
$migration_baseline$;
