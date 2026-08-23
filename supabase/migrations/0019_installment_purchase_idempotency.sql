-- Make bot installment confirmation safe to replay after the purchase commits
-- but a later side effect (interaction log, conversation save, Telegram reply)
-- fails. The caller persists one random key in the pending conversation draft;
-- the unique index and RPC below turn every retry into the original result.

alter table installment_groups
  add column if not exists idempotency_key text;

create unique index if not exists installment_groups_idempotency_key_uniq
  on installment_groups (household_id, idempotency_key)
  where idempotency_key is not null;

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
  -- Only the service-role bot may bypass household membership. Checking the
  -- caller role explicitly keeps an authenticated request with a missing UID
  -- from being mistaken for the bot.
  if target_household_id is null
     or (coalesce(auth.role(), '') <> 'service_role'
         and not is_household_member(target_household_id)) then
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

revoke all on function create_installment_purchase(jsonb, jsonb) from public;
do $$ begin
  revoke all on function create_installment_purchase(jsonb, jsonb) from anon;
  grant execute on function create_installment_purchase(jsonb, jsonb)
    to authenticated, service_role;
exception when undefined_object then null; end $$;
