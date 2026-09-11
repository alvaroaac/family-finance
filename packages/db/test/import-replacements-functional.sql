-- Runs only inside the disposable local verification database.
insert into categories(id, household_id, name) values
 ('71000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'Seguro');
insert into transactions(id, household_id, kind, amount_cents, occurred_on, description,
 account_id, category_id, created_by_user_id, updated_at) values
 ('72000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001',
 'expense', 69750, '2026-08-17', 'Prevencar', '20000000-0000-0000-0000-000000000001',
 '71000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', '2026-08-17T12:00:00Z');

do $$
declare
 batch jsonb := jsonb_build_object('household_id','10000000-0000-0000-0000-000000000001',
   'source','nubank_ofx','request_key','73000000-0000-0000-0000-000000000001',
   'payload_fingerprint',repeat('c',64),'created_by_user_id','00000000-0000-0000-0000-000000000001');
 group_data jsonb := jsonb_build_object('household_id','10000000-0000-0000-0000-000000000001',
   'credit_card_id','21000000-0000-0000-0000-000000000001','description','Prevencar',
   'total_amount_cents',69750,'installment_count',3,'purchased_on','2026-08-17',
   'created_by_user_id','00000000-0000-0000-0000-000000000001');
 item jsonb;
 bad jsonb;
 result jsonb;
 new_group uuid;
begin
 item := jsonb_build_object('household_id','10000000-0000-0000-0000-000000000001',
   'disposition','imported','source_line',36,'fingerprint_version',1,'base_fingerprint',repeat('d',64),
   'occurrence_no',1,'installment_group',group_data,
   'replace_transaction', jsonb_build_object('id','72000000-0000-0000-0000-000000000001', 'updated_at','2026-08-17T12:00:00Z'),
   'installments', (select jsonb_agg(group_data || jsonb_build_object('number', n,
     'amount_cents',23250,'due_month',to_char(date '2026-09-01' + (n-1)*interval '1 month','YYYY-MM')))
     from generate_series(1,3) n));

 -- Stale preview, wrong amount/name/month, and foreign household must not delete anything.
 for bad in select value from jsonb_array_elements(jsonb_build_array(
   jsonb_set(item, '{replace_transaction,updated_at}', '"2026-08-16T12:00:00Z"'),
   jsonb_set(item, '{installment_group,total_amount_cents}', '69749'),
   jsonb_set(item, '{installment_group,description}', '"Outra compra"'),
   jsonb_set(item, '{installment_group,purchased_on}', '"2026-07-17"'),
   jsonb_set(item, '{replace_transaction,id}', '"99999999-0000-0000-0000-000000000001"')
 )) loop
   begin
     perform confirm_import_with_replacements(batch, jsonb_build_array(bad));
     raise exception 'invalid replacement accepted';
   exception when sqlstate '22023' then null;
   end;
 end loop;
 begin
   perform confirm_import_with_replacements(batch, jsonb_build_array(item, item));
   raise exception 'shared original accepted';
 exception when sqlstate '22023' then null;
 end;
 begin
   perform confirm_import_with_replacements(batch || jsonb_build_object('household_id', '10000000-0000-0000-0000-000000000002'), jsonb_build_array(item));
   raise exception 'foreign household accepted';
 exception when sqlstate '42501' then null;
 end;
 -- Invalid parcel sum must roll back the batch, group, and original deletion.
 begin
   perform confirm_import_with_replacements(batch, jsonb_build_array(jsonb_set(item, '{installments,0,amount_cents}', '1')));
   raise exception 'broken installment plan accepted';
 exception when sqlstate '22023' then null;
 end;
 if not exists(select 1 from transactions where id = '72000000-0000-0000-0000-000000000001')
   or exists(select 1 from import_batches where request_key = '73000000-0000-0000-0000-000000000001') then
   raise exception 'failed replacement was not atomic';
 end if;

 result := confirm_import_with_replacements(batch, jsonb_build_array(item));
 select installment_group_id into new_group from import_transaction_replacements
   where original_transaction_id = '72000000-0000-0000-0000-000000000001';
 if new_group is null or exists(select 1 from transactions where id = '72000000-0000-0000-0000-000000000001')
   or (select count(*) from installments where installment_group_id = new_group) <> 3
   or (select sum(amount_cents) from installments where installment_group_id = new_group) <> 69750
   or (select category_id from installment_groups where id = new_group) is distinct from '71000000-0000-0000-0000-000000000001'::uuid
   or exists(select 1 from installments where installment_group_id = new_group and category_id is distinct from '71000000-0000-0000-0000-000000000001'::uuid)
   or (select original_record->>'account_id' from import_transaction_replacements where installment_group_id = new_group) is distinct from '20000000-0000-0000-0000-000000000001' then
   raise exception 'replacement did not preserve the original and category';
 end if;
 result := confirm_import_with_replacements(batch, jsonb_build_array(item));
 if not (result->>'replayed')::boolean then raise exception 'retry did not replay'; end if;
 begin
   perform confirm_import_with_replacements(batch, jsonb_build_array(jsonb_set(item, '{installment_group,description}', '"Changed"')));
   raise exception 'changed retry accepted';
 exception when sqlstate '22023' then null;
 end;

 -- A separately recorded expense cannot be removed if the purchase claim exists.
 insert into transactions(id, household_id, kind, amount_cents, occurred_on, description,
   credit_card_id, created_by_user_id, updated_at)
 values ('72000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000001',
 'expense',69750,'2026-08-17','Prevencar','21000000-0000-0000-0000-000000000001',
 '00000000-0000-0000-0000-000000000001','2026-08-17T12:00:00Z');
 begin
   perform confirm_import_with_replacements(batch || jsonb_build_object('request_key','73000000-0000-0000-0000-000000000002'),
     jsonb_build_array(jsonb_set(item, '{replace_transaction,id}', '"72000000-0000-0000-0000-000000000002"')));
   raise exception 'duplicate claim removed original';
 exception when sqlstate '22023' then null;
 end;
 if not exists(select 1 from transactions where id='72000000-0000-0000-0000-000000000002') then
   raise exception 'duplicate claim deleted original';
 end if;
end $$;
