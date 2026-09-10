-- One transaction for a purchase and every parcel, including server-side
-- validation of the effective category/subcategory when patch keys are omitted.
create or replace function update_installment_group_category(
  target_household_id uuid,
  target_group_id uuid,
  category_patch jsonb
) returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  purchase installment_groups;
  next_category uuid;
  next_subcategory uuid;
begin
  if target_household_id is null
     or not coalesce(is_household_member(target_household_id), false) then
    raise exception 'Not a member of household' using errcode = '42501';
  end if;
  if category_patch is null or jsonb_typeof(category_patch) <> 'object'
     or (category_patch - 'category_id' - 'subcategory_id') <> '{}'::jsonb then
    raise exception 'Invalid categorization patch' using errcode = '22023';
  end if;

  -- Serialize concurrent edits and read the effective values under the lock.
  select * into purchase from installment_groups
  where id = target_group_id and household_id = target_household_id
  for update;
  if not found then
    raise exception 'Installment purchase not found' using errcode = '22023';
  end if;
  if category_patch = '{}'::jsonb then return; end if;

  next_category := case when category_patch ? 'category_id'
    then (category_patch ->> 'category_id')::uuid else purchase.category_id end;
  next_subcategory := case when category_patch ? 'subcategory_id'
    then (category_patch ->> 'subcategory_id')::uuid else purchase.subcategory_id end;

  if next_category is not null then
    perform 1 from categories
    where id = next_category and household_id = target_household_id
      and kind = 'expense' and is_active
    for share;
    if not found then
      raise exception 'Select an active expense category' using errcode = '22023';
    end if;
  end if;
  if next_subcategory is not null then
    perform 1 from subcategories
    where id = next_subcategory and household_id = target_household_id
      and category_id = next_category and is_active
    for share;
    if not found then
      raise exception 'Subcategory must belong to the selected category'
        using errcode = '22023';
    end if;
  end if;

  update installment_groups
    set category_id = next_category, subcategory_id = next_subcategory
    where id = target_group_id and household_id = target_household_id;
  update installments
    set category_id = next_category, subcategory_id = next_subcategory
    where installment_group_id = target_group_id
      and household_id = target_household_id;
end;
$$;

revoke all on function update_installment_group_category(uuid, uuid, jsonb) from public;
do $$ begin
  revoke all on function update_installment_group_category(uuid, uuid, jsonb) from anon;
exception when undefined_object then null; end $$;
do $$ begin
  revoke all on function update_installment_group_category(uuid, uuid, jsonb) from service_role;
exception when undefined_object then null; end $$;
do $$ begin
  grant execute on function update_installment_group_category(uuid, uuid, jsonb) to authenticated;
exception when undefined_object then null; end $$;
