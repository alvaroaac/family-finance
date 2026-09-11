-- Manual expense -> installment conversion shares the import's transaction.
create table if not exists import_transaction_replacements (
  original_transaction_id uuid primary key,
  household_id uuid not null references households(id) on delete cascade,
  import_batch_id uuid not null references import_batches(id) on delete restrict,
  installment_group_id uuid not null references installment_groups(id) on delete restrict,
  original_record jsonb not null,
  replaced_by uuid not null references auth.users(id),
  replaced_at timestamptz not null default now()
);
alter table import_transaction_replacements enable row level security;
drop policy if exists replacements_member_read on import_transaction_replacements;
create policy replacements_member_read on import_transaction_replacements
  for select to authenticated using (is_household_member(household_id));
grant select on import_transaction_replacements to authenticated;

create or replace function import_purchase_name(value text)
returns text language sql immutable strict set search_path = public, pg_temp
as $$ select regexp_replace(translate(lower(value),
  'áàâãäåéèêëíìîïóòôõöúùûüçñ', 'aaaaaaeeeeiiiiooooouuuucn'), '[^a-z0-9]', '', 'g') $$;

create or replace function confirm_import_with_replacements(batch_payload jsonb, items_payload jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  household uuid := (batch_payload->>'household_id')::uuid;
  request_id uuid := (batch_payload->>'request_key')::uuid;
  item jsonb;
  original transactions;
  group_data jsonb;
  preserved jsonb;
  adjusted jsonb := '[]'::jsonb;
  originals jsonb := '{}'::jsonb;
  replacement_id uuid;
  new_group_id uuid;
  result jsonb;
  batch_id uuid;
begin
  if household is null or request_id is null or not is_household_member(household)
     or (batch_payload->>'created_by_user_id')::uuid is distinct from auth.uid() then
    raise exception 'Replacement requires an authenticated household member' using errcode = '42501';
  end if;
  if jsonb_typeof(items_payload) is distinct from 'array' then
    raise exception 'Invalid replacement items' using errcode = '22023';
  end if;
  -- Serialize retries before locking originals; bind retries to their exact intent.
  perform pg_advisory_xact_lock(hashtextextended(household::text || request_id::text, 0));
  batch_payload := batch_payload || jsonb_build_object('payload_fingerprint',
    encode(digest(coalesce(batch_payload->>'payload_fingerprint', '') || items_payload::text, 'sha256'), 'hex'));
  if exists(select 1 from import_batches where household_id = household and request_key = request_id) then
    return confirm_import_v2(batch_payload, items_payload);
  end if;
  perform 1 from transactions where household_id = household and id in (
    select (entry->'replace_transaction'->>'id')::uuid
    from jsonb_array_elements(items_payload) entry where entry ? 'replace_transaction'
  ) order by id for update;

  for item in select value from jsonb_array_elements(items_payload) loop
    if item ? 'replace_transaction' then
      replacement_id := (item->'replace_transaction'->>'id')::uuid;
      if replacement_id is null or originals ? replacement_id::text then
        raise exception 'A transaction can replace only one purchase' using errcode = '22023';
      end if;
      select * into original from transactions where id = replacement_id and household_id = household;
      group_data := item->'installment_group';
      if not found or original.kind <> 'expense' or original.installment_id is not null
         or original.import_batch_id is not null or original.obligation_id is not null
         or original.updated_at is distinct from (item->'replace_transaction'->>'updated_at')::timestamptz
         or item->>'disposition' is distinct from 'imported' or group_data is null
         or item ? 'transaction'
         or original.amount_cents is distinct from (group_data->>'total_amount_cents')::bigint
         or date_trunc('month', original.occurred_on) is distinct from date_trunc('month', (group_data->>'purchased_on')::date)
         or import_purchase_name(original.description) = ''
         or import_purchase_name(original.description) is distinct from import_purchase_name(group_data->>'description') then
        raise exception 'O lançamento mudou ou não corresponde à compra. Atualize a revisão.' using errcode = '22023';
      end if;
      originals := originals || jsonb_build_object(replacement_id::text,
        to_jsonb(original) || jsonb_build_object('bot_interactions',
          (select coalesce(jsonb_agg(to_jsonb(b)), '[]'::jsonb) from bot_interactions b where transaction_id = original.id)));
      preserved := jsonb_build_object('category_id', original.category_id,
        'subcategory_id', original.subcategory_id, 'description', original.description,
        'responsibility_scope', original.responsibility_scope, 'responsible_user_id', original.responsible_user_id);
      item := item || jsonb_build_object('installment_group', group_data || preserved,
        'installments', (select jsonb_agg(p || preserved) from jsonb_array_elements(item->'installments') p));
    end if;
    adjusted := adjusted || jsonb_build_array(item);
  end loop;

  result := confirm_import_v2(batch_payload, adjusted);
  batch_id := (result->'batch'->>'id')::uuid;
  for item in select value from jsonb_array_elements(adjusted) where value ? 'replace_transaction' loop
    replacement_id := (item->'replace_transaction'->>'id')::uuid;
    select installment_group_id into new_group_id from import_rows
      where import_batch_id = batch_id and household_id = household and disposition = 'imported'
        and base_fingerprint = item->>'base_fingerprint' and occurrence_no = (item->>'occurrence_no')::integer;
    if new_group_id is null then
      raise exception 'A compra já foi importada. O lançamento original foi mantido.' using errcode = '22023';
    end if;
    insert into import_transaction_replacements(original_transaction_id, household_id, import_batch_id,
      installment_group_id, original_record, replaced_by)
    values(replacement_id, household, batch_id, new_group_id, originals->replacement_id::text, auth.uid());
    delete from transactions where id = replacement_id and household_id = household;
  end loop;
  return result;
end $$;
revoke all on function confirm_import_with_replacements(jsonb, jsonb) from public, anon;
grant execute on function confirm_import_with_replacements(jsonb, jsonb) to authenticated;
