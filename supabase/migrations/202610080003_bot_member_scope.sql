-- Bot identity lookup and per-sender conversation drafts. All business data is
-- accessed with the resolved member's authenticated JWT, under table RLS.

-- Existing chat-only drafts cannot safely be attributed to a member.
do $$ begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'bot_conversations'
      and column_name = 'telegram_user_id'
  ) then
    delete from bot_conversations;
    alter table bot_conversations drop constraint bot_conversations_pkey;
    alter table bot_conversations
      add column telegram_user_id bigint not null,
      add column household_id uuid not null references households(id) on delete cascade;
    alter table bot_conversations
      add constraint bot_conversations_pkey primary key (chat_id, telegram_user_id);
  end if;
end $$;

create or replace function resolve_telegram_member(
  p_telegram_user_id bigint,
  p_telegram_username text
)
returns table (household_id uuid, user_id uuid, display_name text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  linked household_members;
  username text := nullif(lower(regexp_replace(trim(p_telegram_username), '^@', '')), '');
begin
  select hm.* into linked
  from household_members hm
  where hm.telegram_user_id = p_telegram_user_id and hm.is_active;

  if linked.id is null and username is not null then
    select hm.* into linked
    from household_members hm
    where hm.telegram_username = username
      and hm.telegram_user_id is null
      and hm.is_active
    for update;
    if linked.id is not null then
      update household_members hm
      set telegram_user_id = p_telegram_user_id,
          telegram_username = null
      where hm.id = linked.id;
    end if;
  end if;

  if linked.id is not null then
    return query select linked.household_id, linked.user_id, linked.display_name;
  end if;
end;
$$;

-- Supabase may grant EXECUTE to API roles by default. Revoke both explicit and
-- PUBLIC privileges so the service role is the only caller.
revoke all on function resolve_telegram_member(bigint, text)
  from public, anon, authenticated;
grant execute on function resolve_telegram_member(bigint, text) to service_role;

-- The remaining definitions below are the current 0019/0015/0018 function
-- bodies with their membership gates changed to require auth.uid() explicitly.

-- create_installment_purchase: a missing UID can no longer inherit service-role access.
create or replace function create_installment_purchase(
  group_payload jsonb,
  installments_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  target_household_id uuid := (group_payload ->> 'household_id')::uuid;
  target_idempotency_key text := nullif(group_payload ->> 'idempotency_key', '');
  inserted_group installment_groups;
  inserted_installments jsonb;
  requested_installments_payload jsonb;
  persisted_installments_payload jsonb;
  inserted_new_group boolean := false;
begin
  -- All business writes must come from an active member, including the bot.
  if target_household_id is null
     or auth.uid() is null
     or not is_household_member(target_household_id) then
    raise exception 'create_installment_purchase: not a member of household %',
      target_household_id
      using errcode = '42501';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(installments_payload) as parcel
    where (parcel ->> 'household_id') is distinct from (group_payload ->> 'household_id')
  ) then
    raise exception 'create_installment_purchase: installment household_id mismatch'
      using errcode = '22023';
  end if;

  insert into installment_groups (
    household_id,
    credit_card_id,
    description,
    total_amount_cents,
    installment_count,
    purchased_on,
    category_id,
    subcategory_id,
    responsibility_scope,
    responsible_user_id,
    created_by_user_id,
    idempotency_key
  )
  values (
    target_household_id,
    (group_payload ->> 'credit_card_id')::uuid,
    group_payload ->> 'description',
    (group_payload ->> 'total_amount_cents')::bigint,
    (group_payload ->> 'installment_count')::integer,
    (group_payload ->> 'purchased_on')::date,
    (group_payload ->> 'category_id')::uuid,
    (group_payload ->> 'subcategory_id')::uuid,
    (group_payload ->> 'responsibility_scope')::responsibility_scope,
    (group_payload ->> 'responsible_user_id')::uuid,
    (group_payload ->> 'created_by_user_id')::uuid,
    target_idempotency_key
  )
  on conflict (household_id, idempotency_key)
    where idempotency_key is not null
    do nothing
  returning * into inserted_group;

  inserted_new_group := inserted_group.id is not null;

  if not inserted_new_group then
    select * into inserted_group
    from installment_groups
    where household_id = target_household_id
      and idempotency_key = target_idempotency_key;

    -- Treat accidental/corrupt key reuse as an error, never as permission to
    -- return a semantically different purchase.
    if inserted_group.credit_card_id is distinct from (group_payload ->> 'credit_card_id')::uuid
       or inserted_group.description is distinct from (group_payload ->> 'description')
       or inserted_group.total_amount_cents is distinct from (group_payload ->> 'total_amount_cents')::bigint
       or inserted_group.installment_count is distinct from (group_payload ->> 'installment_count')::integer
       or inserted_group.purchased_on is distinct from (group_payload ->> 'purchased_on')::date
       or inserted_group.category_id is distinct from (group_payload ->> 'category_id')::uuid
       or inserted_group.subcategory_id is distinct from (group_payload ->> 'subcategory_id')::uuid
       or inserted_group.responsibility_scope is distinct from (group_payload ->> 'responsibility_scope')::responsibility_scope
       or inserted_group.responsible_user_id is distinct from (group_payload ->> 'responsible_user_id')::uuid
       or inserted_group.created_by_user_id is distinct from (group_payload ->> 'created_by_user_id')::uuid then
      raise exception 'create_installment_purchase: idempotency key reused with different payload'
        using errcode = '22023';
    end if;

    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'household_id', (parcel ->> 'household_id')::uuid,
          'credit_card_id', (parcel ->> 'credit_card_id')::uuid,
          'number', (parcel ->> 'number')::integer,
          'installment_count', (parcel ->> 'installment_count')::integer,
          'amount_cents', (parcel ->> 'amount_cents')::bigint,
          'due_month', parcel ->> 'due_month',
          'description', parcel ->> 'description',
          'category_id', (parcel ->> 'category_id')::uuid,
          'subcategory_id', (parcel ->> 'subcategory_id')::uuid,
          'responsibility_scope', (parcel ->> 'responsibility_scope')::responsibility_scope,
          'responsible_user_id', (parcel ->> 'responsible_user_id')::uuid,
          'created_by_user_id', (parcel ->> 'created_by_user_id')::uuid
        ) order by (parcel ->> 'number')::integer
      ),
      '[]'::jsonb
    ) into requested_installments_payload
    from jsonb_array_elements(installments_payload) as parcel;

    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'household_id', existing.household_id,
          'credit_card_id', existing.credit_card_id,
          'number', existing.number,
          'installment_count', existing.installment_count,
          'amount_cents', existing.amount_cents,
          'due_month', existing.due_month,
          'description', existing.description,
          'category_id', existing.category_id,
          'subcategory_id', existing.subcategory_id,
          'responsibility_scope', existing.responsibility_scope,
          'responsible_user_id', existing.responsible_user_id,
          'created_by_user_id', existing.created_by_user_id
        ) order by existing.number
      ),
      '[]'::jsonb
    ) into persisted_installments_payload
    from installments existing
    where existing.installment_group_id = inserted_group.id;

    if persisted_installments_payload is distinct from requested_installments_payload then
      raise exception 'create_installment_purchase: idempotency key reused with different installments payload'
        using errcode = '22023';
    end if;
  end if;

  if inserted_new_group then
    with parcels as (
      select
        (parcel ->> 'credit_card_id')::uuid as credit_card_id,
        (parcel ->> 'number')::integer as number,
        (parcel ->> 'installment_count')::integer as installment_count,
        (parcel ->> 'amount_cents')::bigint as amount_cents,
        parcel ->> 'due_month' as due_month,
        parcel ->> 'description' as description,
        (parcel ->> 'category_id')::uuid as category_id,
        (parcel ->> 'subcategory_id')::uuid as subcategory_id,
        (parcel ->> 'responsibility_scope')::responsibility_scope as responsibility_scope,
        (parcel ->> 'responsible_user_id')::uuid as responsible_user_id,
        (parcel ->> 'created_by_user_id')::uuid as created_by_user_id
      from jsonb_array_elements(installments_payload) as parcel
    ),
    inserted as (
      insert into installments (
        household_id,
        installment_group_id,
        credit_card_id,
        number,
        installment_count,
        amount_cents,
        due_month,
        description,
        category_id,
        subcategory_id,
        responsibility_scope,
        responsible_user_id,
        created_by_user_id
      )
      select
        inserted_group.household_id,
        inserted_group.id,
        p.credit_card_id,
        p.number,
        p.installment_count,
        p.amount_cents,
        p.due_month,
        p.description,
        p.category_id,
        p.subcategory_id,
        p.responsibility_scope,
        p.responsible_user_id,
        p.created_by_user_id
      from parcels p
      returning *
    )
    select coalesce(jsonb_agg(to_jsonb(inserted) order by inserted.number), '[]'::jsonb)
      into inserted_installments
    from inserted;
  else
    select coalesce(jsonb_agg(to_jsonb(existing) order by existing.number), '[]'::jsonb)
      into inserted_installments
    from installments existing
    where existing.installment_group_id = inserted_group.id;
  end if;

  return jsonb_build_object(
    'group', to_jsonb(inserted_group),
    'installments', inserted_installments
  );
end;
$$;

-- Replace PR42's 8-argument API without reviving the legacy overload.
drop function if exists settle_card_bill(uuid, uuid, uuid, text, bigint, date, uuid);
create or replace function settle_card_bill(
  target_household_id uuid,
  target_credit_card_id uuid,
  target_account_id uuid,
  target_bill_month text,
  target_amount_cents bigint,
  target_paid_on date,
  target_created_by_user_id uuid,
  target_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  card credit_cards;
  paid_on date := coalesce(target_paid_on, (now() at time zone 'America/Sao_Paulo')::date);
  month_start date;
  inserted transactions;
  existing transactions;
begin
  -- Lock the caller's membership until this transaction completes. A concurrent
  -- deactivation cannot make an RLS absence look like proof of a missing write.
  if auth.uid() is null or coalesce(auth.role(), '') <> 'authenticated' then
    raise exception 'settle_card_bill: active member authentication required' using errcode = '42501';
  end if;
  perform 1 from household_members where household_id = target_household_id
    and user_id = auth.uid() and is_active for share;
  if not found then
    raise exception 'settle_card_bill: active member authentication required' using errcode = '42501';
  end if;
  if target_idempotency_key is null or target_idempotency_key = '' then
    raise exception 'settle_card_bill: invalid idempotency key' using errcode = '22023';
  end if;
  -- Every same-household/key invocation takes this lock before inspecting or
  -- claiming a key. Validation hints are issued only after an authoritative
  -- definer lookup, in the same transaction and while no competing claim exists.
  perform pg_advisory_xact_lock(hashtextextended(target_household_id::text || ':' || target_idempotency_key, 0));
  select * into existing from transactions
  where household_id = target_household_id and idempotency_key = target_idempotency_key;
  if existing.id is not null then
    if existing.kind is distinct from 'transfer'::transaction_kind
       or existing.credit_card_id is distinct from target_credit_card_id
       or existing.account_id is distinct from target_account_id
       or existing.bill_month is distinct from target_bill_month
       or existing.amount_cents is distinct from target_amount_cents
       or existing.occurred_on is distinct from paid_on
       or existing.created_by_user_id is distinct from auth.uid()
       or target_created_by_user_id is distinct from auth.uid() then
      raise exception 'settle_card_bill: idempotency key reused with a different payment'
        using errcode = '22023';
    end if;
    return jsonb_build_object('transaction', to_jsonb(existing), 'replayed', true);
  end if;
  if target_bill_month is null
     or target_bill_month !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' then
    raise exception 'settle_card_bill: invalid month %', target_bill_month
      using errcode = '22023', hint = 'card_bill_definitive_no_write_v1';
  end if;
  if target_amount_cents is null or target_amount_cents <= 0 then
    raise exception 'settle_card_bill: invalid amount'
      using errcode = '22023', hint = 'card_bill_definitive_no_write_v1';
  end if;
  if paid_on > (now() at time zone 'America/Sao_Paulo')::date then
    raise exception 'settle_card_bill: payment date cannot be in the future'
      using errcode = '22023', hint = 'card_bill_definitive_no_write_v1';
  end if;
  select * into card from credit_cards
  where id = target_credit_card_id and household_id = target_household_id;
  if card.id is null then
    raise exception 'settle_card_bill: card % not found', target_credit_card_id
      using errcode = '22023', hint = 'card_bill_definitive_no_write_v1';
  end if;
  if not exists (select 1 from accounts where id = target_account_id and household_id = target_household_id) then
    raise exception 'settle_card_bill: account % not found', target_account_id
      using errcode = '22023', hint = 'card_bill_definitive_no_write_v1';
  end if;
  perform 1 from household_members where household_id = target_household_id
    and user_id = target_created_by_user_id and is_active for share;
  if not found or target_created_by_user_id is distinct from auth.uid() then
    raise exception 'settle_card_bill: created_by is not the active caller'
      using errcode = '22023', hint = 'card_bill_definitive_no_write_v1';
  end if;
  month_start := to_date(target_bill_month || '-01', 'YYYY-MM-DD');

  insert into transactions (
    household_id, kind, amount_cents, occurred_on, description,
    account_id, credit_card_id, responsibility_scope, responsible_user_id,
    created_by_user_id, bill_month, idempotency_key
  ) values (
    target_household_id, 'transfer', target_amount_cents, paid_on,
    'Fatura ' || card.name || ' — ' || to_char(month_start, 'MM/YYYY'),
    target_account_id, target_credit_card_id, 'household', null,
    auth.uid(), target_bill_month, target_idempotency_key
  )
  on conflict (household_id, idempotency_key)
    where idempotency_key is not null do nothing
  returning * into inserted;

  if inserted.id is not null then
    return jsonb_build_object('transaction', to_jsonb(inserted), 'replayed', false);
  end if;
  select * into existing from transactions
  where household_id = target_household_id and idempotency_key = target_idempotency_key;
  if existing.kind is distinct from 'transfer'::transaction_kind
     or existing.credit_card_id is distinct from target_credit_card_id
     or existing.account_id is distinct from target_account_id
     or existing.bill_month is distinct from target_bill_month
     or existing.amount_cents is distinct from target_amount_cents
     or existing.occurred_on is distinct from paid_on
     or existing.created_by_user_id is distinct from auth.uid() then
    raise exception 'settle_card_bill: idempotency key reused with a different payment'
      using errcode = '22023';
  end if;
  return jsonb_build_object('transaction', to_jsonb(existing), 'replayed', true);
end;
$$;

revoke all on function settle_card_bill(uuid, uuid, uuid, text, bigint, date, uuid, text) from public;
do $$ begin
  revoke all on function settle_card_bill(uuid, uuid, uuid, text, bigint, date, uuid, text) from anon;
exception when undefined_object then null; end $$;
do $$ begin
  grant execute on function settle_card_bill(uuid, uuid, uuid, text, bigint, date, uuid, text)
    to authenticated, service_role;
exception when undefined_object then null; end $$;


-- Legacy null-key drafts also need authoritative membership-gated recovery.
-- RLS returning an empty set after deactivation must never permit a new key.
create or replace function reconcile_legacy_card_bill_payment(
  target_household_id uuid, target_credit_card_id uuid, target_account_id uuid,
  target_bill_month text, target_amount_cents bigint, target_paid_on date,
  target_created_by_user_id uuid
)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  matches bigint;
  exact_matches bigint;
begin
  if auth.uid() is null or coalesce(auth.role(), '') <> 'authenticated' then
    raise exception 'legacy payment recovery: active member authentication required' using errcode = '42501';
  end if;
  perform 1 from household_members where household_id = target_household_id
    and user_id = auth.uid() and is_active for share;
  if not found or target_created_by_user_id is distinct from auth.uid() then
    raise exception 'legacy payment recovery: active member authentication required' using errcode = '42501';
  end if;
  select count(*), count(*) filter (
    where account_id = target_account_id and amount_cents = target_amount_cents
      and occurred_on = target_paid_on and created_by_user_id = target_created_by_user_id
  ) into matches, exact_matches
  from transactions where household_id = target_household_id
    and kind = 'transfer' and credit_card_id = target_credit_card_id
    and bill_month = target_bill_month and idempotency_key is null;
  if matches = 0 then return 'none'; end if;
  if matches = 1 and exact_matches = 1 then return 'matched'; end if;
  return 'ambiguous';
end;
$$;
revoke all on function reconcile_legacy_card_bill_payment(uuid, uuid, uuid, text, bigint, date, uuid)
  from public, anon;
grant execute on function reconcile_legacy_card_bill_payment(uuid, uuid, uuid, text, bigint, date, uuid)
  to authenticated, service_role;

-- materialize_obligation_payment: a missing UID can no longer inherit service-role access.
create or replace function materialize_obligation_payment(
  target_obligation_id uuid,
  target_month text,
  paid_on date,
  target_amount_cents bigint,
  target_account_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  obligation obligations;
  month_start date;
  end_month_start date;
  effective_paid_on date;
  effective_amount_cents bigint;
  effective_account_id uuid;
  inserted transactions;
  existing transactions;
begin
  if target_month is null or target_month !~ '^\d{4}-(0[1-9]|1[0-2])$' then
    raise exception 'materialize_obligation_payment: invalid month %', target_month
      using errcode = '22023';
  end if;
  if target_amount_cents is not null and target_amount_cents <= 0 then
    raise exception 'materialize_obligation_payment: actual amount must be positive'
      using errcode = '22023';
  end if;

  select * into obligation from obligations where id = target_obligation_id;
  if obligation.id is null
     or auth.uid() is null
     or not is_household_member(obligation.household_id) then
    raise exception 'materialize_obligation_payment: obligation % not found',
      target_obligation_id using errcode = '22023';
  end if;
  if obligation.status <> 'active' then
    raise exception 'materialize_obligation_payment: obligation % is %',
      target_obligation_id, obligation.status using errcode = '22023';
  end if;

  if target_account_id is not null and not exists (
    select 1 from accounts
    where id = target_account_id
      and household_id = obligation.household_id
  ) then
    raise exception 'materialize_obligation_payment: account % not found in obligation household',
      target_account_id using errcode = '22023';
  end if;

  month_start := to_date(target_month || '-01', 'YYYY-MM-DD');
  if month_start < to_date(obligation.start_month || '-01', 'YYYY-MM-DD') then
    raise exception 'materialize_obligation_payment: month % precedes start %',
      target_month, obligation.start_month using errcode = '22023';
  end if;
  if obligation.term_months is not null then
    end_month_start :=
      to_date(obligation.start_month || '-01', 'YYYY-MM-DD')
      + make_interval(months => obligation.term_months - 1);
    if month_start > end_month_start then
      raise exception 'materialize_obligation_payment: month % is after the % -month term',
        target_month, obligation.term_months using errcode = '22023';
    end if;
  end if;

  effective_paid_on := coalesce(
    paid_on,
    month_start + (obligation.due_day - 1)
  );
  effective_amount_cents := coalesce(
    target_amount_cents,
    obligation.amount_cents
  );
  effective_account_id := coalesce(
    target_account_id,
    obligation.account_id
  );

  insert into transactions (
    household_id, kind, amount_cents, occurred_on, description,
    category_id, subcategory_id, account_id, credit_card_id,
    responsibility_scope, responsible_user_id, created_by_user_id,
    obligation_id, obligation_month
  ) values (
    obligation.household_id, 'expense', effective_amount_cents,
    effective_paid_on, obligation.description, obligation.category_id,
    obligation.subcategory_id, effective_account_id, null,
    obligation.responsibility_scope, obligation.responsible_user_id,
    auth.uid(),
    obligation.id, month_start
  )
  on conflict (obligation_id, obligation_month)
    where obligation_id is not null
    do nothing
  returning * into inserted;

  if inserted.id is null then
    select * into existing from transactions
    where obligation_id = obligation.id and obligation_month = month_start;
    return jsonb_build_object(
      'transaction', to_jsonb(existing),
      'already_paid', true
    );
  end if;

  return jsonb_build_object(
    'transaction', to_jsonb(inserted),
    'already_paid', false
  );
end;
$$;
