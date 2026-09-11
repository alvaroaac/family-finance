-- Runs after import-reliability-functional.sql, against a disposable database.
do $$
declare
  original installment_groups;
  saved installment_groups;
  batch jsonb;
  item jsonb;
  result jsonb;
  before_parcels jsonb;
  after_parcels jsonb;
  failure_item jsonb;
  rejected boolean;
  old_count integer;
begin
  select * into strict original from installment_groups where description = 'Notebook';
  select jsonb_agg(to_jsonb(p) - 'description' - 'updated_at' order by p.number)
    into before_parcels from installments p where installment_group_id = original.id;
  batch := jsonb_build_object(
    'household_id', original.household_id, 'source', 'nubank_ofx',
    'request_key', gen_random_uuid(), 'payload_fingerprint', repeat('b',64),
    'created_by_user_id', original.created_by_user_id);
  item := jsonb_build_object(
    'household_id', original.household_id, 'disposition', 'imported',
    'fingerprint_version',1, 'base_fingerprint',repeat('c',64),'occurrence_no',1,
    'source_line',1,'description','Milium Loja - Parcela 2/2',
    'amount_cents',-10000,'occurred_on','2026-08-10',
    'observed_installment_number',2,'observed_installment_count',2,'observed_due_month','2026-08',
    'existing_installment_group_id',original.id,'expected_group_updated_at',original.updated_at,
    'installment_group',(to_jsonb(original) - 'purchase_description') || jsonb_build_object('description','Milium Loja'),
    'installments','[]'::jsonb);
  result := confirm_import_v2(batch, jsonb_build_array(item));
  select * into strict saved from installment_groups where id = original.id;
  if saved.description <> 'Milium Loja' or saved.purchase_description <> 'Notebook'
     or (result ->> 'installment_groups_created')::integer <> 0
     or (result ->> 'transactions_created')::integer <> 0
     or (result ->> 'duplicate_rows')::integer <> 1
     or (to_jsonb(saved) - 'description' - 'purchase_description' - 'updated_at') is distinct from
        (to_jsonb(original) - 'description' - 'purchase_description' - 'updated_at') then
    raise exception 'existing purchase label/link invariant failed';
  end if;
  select jsonb_agg(to_jsonb(p) - 'description' - 'updated_at' order by p.number)
    into after_parcels from installments p where installment_group_id = original.id;
  if before_parcels is distinct from after_parcels then
    raise exception 'link changed existing parcel amounts, dates, IDs or categories';
  end if;
  if not exists (select 1 from import_rows where import_batch_id = (result->'batch'->>'id')::uuid
    and description = 'Milium Loja - Parcela 2/2' and installment_group_id = original.id) then
    raise exception 'bank audit text lost';
  end if;
  if not (confirm_import_v2(batch, jsonb_build_array(item))->>'replayed')::boolean then
    raise exception 'label confirmation is not retry safe';
  end if;

  select count(*) into old_count from import_batches;
  foreach failure_item in array array[
    item || jsonb_build_object('expected_group_updated_at','2000-01-01T00:00:00Z'),
    item || jsonb_build_object('existing_installment_group_id','22000000-0000-0000-0000-000000000002'),
    item || jsonb_build_object('amount_cents',-50000),
    item || jsonb_build_object('observed_due_month','2027-01'),
    item || jsonb_build_object('observed_installment_count',12),
    jsonb_set(item, '{installment_group,credit_card_id}', '"21000000-0000-0000-0000-000000000002"'),
    jsonb_set(item, '{installment_group,purchase_description}', to_jsonb(repeat('x',201)))
  ] loop
    rejected := false;
    begin
      perform confirm_import_v2(batch || jsonb_build_object('request_key',gen_random_uuid()),
        jsonb_build_array(failure_item));
    exception when check_violation or invalid_parameter_value then rejected := true;
    end;
    if not rejected then raise exception 'unsafe purchase update was accepted: %', failure_item; end if;
  end loop;
  if (select count(*) from import_batches) <> old_count then raise exception 'failed update was not atomic'; end if;

  -- A second file with the same identity links to the same purchase, retains its label.
  item := jsonb_set(item, '{expected_group_updated_at}', to_jsonb(saved.updated_at));
  result := confirm_import_v2(batch || jsonb_build_object('request_key',gen_random_uuid()), jsonb_build_array(item));
  if (result->>'installment_groups_created')::int <> 0 or
     (select purchase_description from installment_groups where id=original.id) <> 'Notebook' then
    raise exception 'reimport lost label or duplicated purchase';
  end if;
end $$;

-- Newly imported purchases also store the two texts separately.
do $$
declare
  original installment_groups;
  item jsonb;
  batch jsonb;
  result jsonb;
  label text;
  actual_label text;
  i integer := 0;
begin
  select * into strict original from installment_groups where description = 'Milium Loja';
  foreach label in array array['Utensílios da cozinha','  MILIUM   LOJA  '] loop
    i := i + 1;
    item := jsonb_build_object(
      'household_id',original.household_id,'disposition','imported','fingerprint_version',1,
      'base_fingerprint',repeat(i::text,64),'occurrence_no',99,'source_line',1,
      'description','Milium Loja - Parcela 2/2','observed_installment_number',2,'observed_installment_count',2,
      'installment_group',to_jsonb(original) || jsonb_build_object('purchase_description',label),
      'installments',(select jsonb_agg(to_jsonb(p)) from installments p where p.installment_group_id=original.id));
    batch := jsonb_build_object('household_id',original.household_id,'source','nubank_ofx',
      'request_key',gen_random_uuid(),'payload_fingerprint',repeat('d',64), 'created_by_user_id',original.created_by_user_id);
    result := confirm_import_v2(batch,jsonb_build_array(item));
    select purchase_description into actual_label from installment_groups where import_batch_id=(result->'batch'->>'id')::uuid;
    if (result->>'installment_groups_created')::int <> 1 or
       actual_label is distinct from (case when i=1 then label else null end) then
      raise exception 'new purchase label normalization failed';
    end if;
  end loop;
end $$;
