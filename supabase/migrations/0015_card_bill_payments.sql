-- 0015_card_bill_payments.sql
-- PR-2: card-bill payment = ONE kind='transfer' row carrying BOTH instruments
-- (account = source, credit card = destination) + bill_month as the settled
-- marker. Also re-gates create_installment_purchase (0002) to the 0011 gate
-- pattern so the bot's null-uid service-role client can persist installments
-- (0012 granted service_role EXECUTE, but 0002's body gate rejects null uid).
-- Every statement is guarded so the migration is re-runnable.

-- --- transactions.bill_month ------------------------------------------------
do $$ begin
  alter table transactions add column bill_month text;
exception when duplicate_column then null; end $$;

do $$ begin
  alter table transactions add constraint transactions_bill_month_format_check
    check (bill_month is null or bill_month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$');
exception when duplicate_object then null; end $$;

-- bill_month only makes sense on the settle transfer row.
do $$ begin
  alter table transactions add constraint transactions_bill_month_kind_check
    check (bill_month is null or kind = 'transfer');
exception when duplicate_object then null; end $$;

-- --- Narrowed instrument check ----------------------------------------------
-- 0001's exactly-one-instrument CHECK was declared inline and unnamed, so we
-- locate it by definition (the only CHECK mentioning both instrument columns)
-- and drop it before adding the named, narrowed replacement.
do $$
declare cname text;
begin
  select c.conname into cname
  from pg_constraint c
  where c.conrelid = 'transactions'::regclass
    and c.contype = 'c'
    and pg_get_constraintdef(c.oid) like '%account_id%'
    and pg_get_constraintdef(c.oid) like '%credit_card_id%'
    and pg_get_constraintdef(c.oid) not like '%bill_month%';
  if cname is not null then
    execute format('alter table transactions drop constraint %I', cname);
  end if;
end $$;

-- expense/income → exactly one instrument (as before).
-- transfer + bill_month → BOTH (a card-bill payment).
-- transfer without bill_month (caixinha) → exactly one, as before.
do $$ begin
  alter table transactions add constraint transactions_payment_instrument_check
    check (
      case
        when kind = 'transfer' and bill_month is not null
          then account_id is not null and credit_card_id is not null
        else
          (account_id is not null and credit_card_id is null)
          or (account_id is null and credit_card_id is not null)
      end
    );
exception when duplicate_object then null; end $$;

-- A card's bill is settled at most once per month (idempotency backbone of
-- settle_card_bill, mirroring transactions_obligation_month_uniq).
create unique index if not exists transactions_card_bill_month_uniq
  on transactions (credit_card_id, bill_month)
  where kind = 'transfer' and bill_month is not null;

-- --- settle_card_bill ---------------------------------------------------------
create or replace function settle_card_bill(
  target_household_id uuid,
  target_credit_card_id uuid,
  target_account_id uuid,
  target_bill_month text,
  target_amount_cents bigint,
  target_paid_on date,
  target_created_by_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  card credit_cards;
  member_ok boolean;
  month_start date;
  inserted transactions;
  existing transactions;
  already_paid boolean := false;
begin
  if target_bill_month is null
     or target_bill_month !~ '^\d{4}-(0[1-9]|1[0-2])$' then
    raise exception 'settle_card_bill: invalid month %', target_bill_month
      using errcode = '22023';
  end if;
  if target_amount_cents is null or target_amount_cents <= 0 then
    raise exception 'settle_card_bill: invalid amount'
      using errcode = '22023';
  end if;

  select * into card
  from credit_cards
  where id = target_credit_card_id
    and household_id = target_household_id;

  -- 0011 gate: SECURITY DEFINER skips RLS, so re-assert membership. The bot's
  -- service-role client has auth.uid() null and passes; an authenticated
  -- non-member gets the SAME 'not found' as a nonexistent id (no probing).
  if card.id is null
     or (auth.uid() is not null
         and not is_household_member(target_household_id)) then
    raise exception 'settle_card_bill: card % not found', target_credit_card_id
      using errcode = '22023';
  end if;

  -- The bot path cannot derive the creator from auth.uid(); the claimed
  -- created_by must be an active member of the target household.
  select exists (
    select 1 from household_members
    where household_id = target_household_id
      and user_id = target_created_by_user_id
      and is_active
  ) into member_ok;
  if not member_ok then
    raise exception 'settle_card_bill: created_by is not an active member'
      using errcode = '22023';
  end if;

  month_start := to_date(target_bill_month || '-01', 'YYYY-MM-DD');

  -- The composite household FKs (0013) enforce that both instruments belong
  -- to target_household_id. The account is validated there, not re-queried.
  insert into transactions (
    household_id, kind, amount_cents, occurred_on, description,
    account_id, credit_card_id,
    responsibility_scope, responsible_user_id, created_by_user_id, bill_month
  )
  values (
    target_household_id, 'transfer', target_amount_cents,
    coalesce(target_paid_on, current_date),
    'Fatura ' || card.name || ' — ' || to_char(month_start, 'MM/YYYY'),
    target_account_id, target_credit_card_id,
    'household', null,
    coalesce(auth.uid(), target_created_by_user_id),
    target_bill_month
  )
  on conflict (credit_card_id, bill_month)
    where kind = 'transfer' and bill_month is not null
    do nothing
  returning * into inserted;

  if inserted.id is null then
    -- Unique index hit: this card+month is already settled. Idempotent no-op.
    already_paid := true;
    select * into existing
    from transactions
    where credit_card_id = target_credit_card_id
      and bill_month = target_bill_month
      and kind = 'transfer';
    return jsonb_build_object(
      'transaction', to_jsonb(existing),
      'already_paid', already_paid
    );
  end if;

  return jsonb_build_object(
    'transaction', to_jsonb(inserted),
    'already_paid', already_paid
  );
end;
$$;

-- Full 0012 hardening in the same migration (Supabase default privileges
-- auto-grant EXECUTE to anon on new functions).
revoke all on function settle_card_bill(uuid, uuid, uuid, text, bigint, date, uuid) from public;
do $$ begin
  revoke all on function settle_card_bill(uuid, uuid, uuid, text, bigint, date, uuid) from anon;
exception when undefined_object then null; end $$;
do $$ begin
  grant execute on function settle_card_bill(uuid, uuid, uuid, text, bigint, date, uuid)
    to authenticated;
exception when undefined_object then null; end $$;
do $$ begin
  grant execute on function settle_card_bill(uuid, uuid, uuid, text, bigint, date, uuid)
    to service_role;
exception when undefined_object then null; end $$;

-- --- Re-gate create_installment_purchase (2a) --------------------------------
-- Copy of 0002_create_installment_purchase.sql's full body verbatim, with ONLY
-- the membership gate changed to the 0011 pattern: SECURITY DEFINER skips RLS,
-- so re-assert membership, but treat a null auth.uid() (the bot's service-role
-- client) as passing — safe post-0012, since anon/public EXECUTE is revoked
-- there, so the only null-uid caller that can reach this body is service_role
-- (exactly the bot). The web (authenticated) path is unchanged.
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
  inserted_group installment_groups;
  inserted_installments jsonb;
begin
  -- Household isolation: SECURITY DEFINER skips RLS, so re-assert membership
  -- exactly as the table policies would have. Rejects cross-household writes.
  -- auth.uid() is null for the bot's service-role client, which must pass —
  -- 0012 already restricts EXECUTE to authenticated/service_role, so the only
  -- null-uid caller that can reach here is the bot itself.
  if target_household_id is null
     or (auth.uid() is not null
         and not is_household_member(target_household_id)) then
    raise exception 'create_installment_purchase: not a member of household %',
      target_household_id
      using errcode = '42501'; -- insufficient_privilege
  end if;

  -- The installments must all belong to the same household as the group; refuse
  -- a payload that tries to smuggle parcels into another household.
  if exists (
    select 1
    from jsonb_array_elements(installments_payload) as parcel
    where (parcel ->> 'household_id') is distinct from (group_payload ->> 'household_id')
  ) then
    raise exception 'create_installment_purchase: installment household_id mismatch'
      using errcode = '22023'; -- invalid_parameter_value
  end if;

  -- Insert the parent group. Columns mirror migration 0001's installment_groups;
  -- id / timestamps fall back to their table defaults.
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
    created_by_user_id
  )
  values (
    (group_payload ->> 'household_id')::uuid,
    (group_payload ->> 'credit_card_id')::uuid,
    group_payload ->> 'description',
    (group_payload ->> 'total_amount_cents')::bigint,
    (group_payload ->> 'installment_count')::integer,
    (group_payload ->> 'purchased_on')::date,
    (group_payload ->> 'category_id')::uuid,
    (group_payload ->> 'subcategory_id')::uuid,
    (group_payload ->> 'responsibility_scope')::responsibility_scope,
    (group_payload ->> 'responsible_user_id')::uuid,
    (group_payload ->> 'created_by_user_id')::uuid
  )
  returning * into inserted_group;

  -- Insert every parcel, linking it to the group just created. Any CHECK / UNIQUE
  -- violation (e.g. number > installment_count) aborts the whole transaction, so
  -- a childless group can never be left behind.
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
      (parcel ->> 'responsibility_scope')::responsibility_scope
        as responsibility_scope,
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

  return jsonb_build_object(
    'group', to_jsonb(inserted_group),
    'installments', inserted_installments
  );
end;
$$;
