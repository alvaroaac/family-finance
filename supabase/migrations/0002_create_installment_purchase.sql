-- 0002_create_installment_purchase.sql
-- Atomic parcelado purchase write: insert the installment_groups parent row and
-- all its installments rows in ONE transaction.
--
-- Why: the previous `createInstallmentPurchase` repository performed two separate
-- Supabase calls (group insert, then installments insert). Supabase JS has no
-- client-side transaction, so a failed parcel insert orphaned a childless group.
-- A plpgsql function body runs in a single transaction, so either the group and
-- every parcel persist together or nothing does.
--
-- Contract: the caller passes the SAME column-keyed payloads the repository
-- mappers already build (`installmentGroupInsertFromPlan` /
-- `installmentInsertsFromPlan`), so the money-split / due-month logic stays in
-- the domain — this function only does the atomic write. The installments'
-- `installment_group_id` is overwritten with the freshly inserted group id, so
-- the caller never has to know it in advance.
--
-- Isolation: SECURITY DEFINER bypasses RLS during the inserts, so household
-- isolation is enforced HERE explicitly instead — the function rejects any payload
-- whose group/installments are not all scoped to a single household the current
-- auth user is an active member of (via `is_household_member`). This preserves the
-- exact RLS/household-isolation semantics of migration 0001's
-- `installment_groups_member_all` / `installments_member_all` policies.
--
-- search_path is pinned to a safe, minimal value so the SECURITY DEFINER body
-- cannot be hijacked by a caller-controlled search_path.

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
  if target_household_id is null
     or not is_household_member(target_household_id) then
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

-- Lock down execution to the same principals the table policies serve. anon is
-- intentionally excluded; authenticated callers still pass through the explicit
-- is_household_member() gate above. The grant is guarded so this migration also
-- runs on a plain Postgres for review, where Supabase's `authenticated` role is
-- absent (mirrors 0001's defensive blocks).
revoke all on function create_installment_purchase(jsonb, jsonb) from public;
do $$ begin
  grant execute on function create_installment_purchase(jsonb, jsonb)
    to authenticated;
exception when undefined_object then null; end $$;
