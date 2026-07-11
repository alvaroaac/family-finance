create or replace function auth.uid() returns uuid language sql stable
as 'select ''00000000-0000-0000-0000-000000000001''::uuid';
create or replace function auth.role() returns text language sql stable
as 'select ''authenticated''::text';

insert into auth.users(id,email) values
  ('00000000-0000-0000-0000-000000000001','verify@example.com'),
  ('00000000-0000-0000-0000-000000000002','other@example.com');
insert into households(id,name)
values ('10000000-0000-0000-0000-000000000001','Verify');
insert into households(id,name)
values ('10000000-0000-0000-0000-000000000002','Other');
insert into household_members(household_id,user_id)
values ('10000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000001');
insert into accounts(id,household_id,kind,name)
values ('20000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','checking','Conta');
insert into credit_cards(id,household_id,name,closing_day,due_day)
values ('21000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','Cartão',10,17);
insert into household_members(household_id,user_id)
values ('10000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000002');
insert into credit_cards(id,household_id,name,closing_day,due_day)
values ('21000000-0000-0000-0000-000000000002','10000000-0000-0000-0000-000000000002','Outro cartão',10,17);
insert into installment_groups(
  id,household_id,credit_card_id,description,total_amount_cents,
  installment_count,purchased_on,created_by_user_id
) values (
  '22000000-0000-0000-0000-000000000002','10000000-0000-0000-0000-000000000002',
  '21000000-0000-0000-0000-000000000002','Foreign group',1000,1,'2026-07-01',
  '00000000-0000-0000-0000-000000000002'
);
insert into installments(
  id,household_id,installment_group_id,credit_card_id,number,installment_count,
  amount_cents,due_month,description,created_by_user_id
) values (
  '23000000-0000-0000-0000-000000000002','10000000-0000-0000-0000-000000000002',
  '22000000-0000-0000-0000-000000000002','21000000-0000-0000-0000-000000000002',
  1,1,1000,'2026-07','Foreign installment','00000000-0000-0000-0000-000000000002'
);

do $$
declare
  batch jsonb := jsonb_build_object(
    'household_id','10000000-0000-0000-0000-000000000001',
    'source','nubank_csv',
    'request_key','30000000-0000-0000-0000-000000000001',
    'payload_fingerprint',repeat('a',64),
    'created_by_user_id','00000000-0000-0000-0000-000000000001'
  );
  items jsonb := jsonb_build_array(jsonb_build_object(
    'household_id','10000000-0000-0000-0000-000000000001',
    'disposition','imported',
    'source_line',2,
    'fingerprint_version',1,
    'base_fingerprint',repeat('b',64),
    'occurrence_no',1,
    'transaction',jsonb_build_object(
      'household_id','10000000-0000-0000-0000-000000000001',
      'kind','expense','amount_cents',1234,'occurred_on','2026-07-10',
      'description','Teste','category_id',null,'subcategory_id',null,
      'account_id','20000000-0000-0000-0000-000000000001',
      'credit_card_id',null,'installment_id',null,
      'responsibility_scope','household','responsible_user_id',null,
      'created_by_user_id','00000000-0000-0000-0000-000000000001'
    )
  ));
  first_result jsonb;
  replay_result jsonb;
  duplicate_result jsonb;
begin
  first_result := confirm_import_v2(batch, items);
  replay_result := confirm_import_v2(batch, items);
  duplicate_result := confirm_import_v2(
    batch || jsonb_build_object(
      'request_key','30000000-0000-0000-0000-000000000002',
      'payload_fingerprint',repeat('c',64)
    ),
    items
  );
  if (first_result ->> 'transactions_created')::integer <> 1
     or not (replay_result ->> 'replayed')::boolean
     or (duplicate_result ->> 'duplicate_rows')::integer <> 1
     or (select count(*) from transactions) <> 1 then
    raise exception 'functional import/replay/claim assertion failed';
  end if;

  begin
    perform confirm_import_v2(
      batch || jsonb_build_object(
        'request_key','30000000-0000-0000-0000-000000000003',
        'payload_fingerprint',repeat('d',64)
      ),
      '[]'::jsonb
    );
    raise exception 'empty import unexpectedly succeeded';
  exception when sqlstate '22023' then null;
  end;

  begin
    perform confirm_import_v2(
      batch || jsonb_build_object(
        'request_key','30000000-0000-0000-0000-000000000004',
        'payload_fingerprint',repeat('e',64),
        'created_by_user_id','00000000-0000-0000-0000-000000000002'
      ),
      items
    );
    raise exception 'foreign attribution unexpectedly succeeded';
  exception when insufficient_privilege then null;
  end;
end;
$$;

-- An obligation's configured amount remains the forecast while each monthly
-- materialization may store the actual charge. Replays never rewrite history.
do $$
declare
  custom_result jsonb;
  replay_result jsonb;
  default_result jsonb;
begin
  insert into obligations(
    id,household_id,description,amount_cents,start_month,term_months,due_day,
    account_id,created_by_user_id
  ) values (
    '25000000-0000-0000-0000-000000000001',
    '10000000-0000-0000-0000-000000000001',
    'Health care',80000,'2026-07',null,10,
    '20000000-0000-0000-0000-000000000001',
    '00000000-0000-0000-0000-000000000001'
  );

  custom_result := materialize_obligation_payment(
    '25000000-0000-0000-0000-000000000001','2026-07','2026-07-11',92735
  );
  replay_result := materialize_obligation_payment(
    '25000000-0000-0000-0000-000000000001','2026-07','2026-07-12',99999
  );
  default_result := materialize_obligation_payment(
    '25000000-0000-0000-0000-000000000001','2026-08','2026-08-11',null
  );

  if (custom_result #>> '{transaction,amount_cents}')::bigint <> 92735
     or not (replay_result ->> 'already_paid')::boolean
     or (replay_result #>> '{transaction,amount_cents}')::bigint <> 92735
     or (default_result #>> '{transaction,amount_cents}')::bigint <> 80000
     or (select amount_cents from obligations
         where id = '25000000-0000-0000-0000-000000000001') <> 80000 then
    raise exception 'obligation forecast/actual amount assertion failed';
  end if;
end;
$$;

create or replace function verify_concurrent_import(
  request_key uuid,
  payload_hash text,
  base_hash text
) returns jsonb language sql as $$
  select confirm_import_v2(
    jsonb_build_object(
      'household_id','10000000-0000-0000-0000-000000000001',
      'source','nubank_csv','request_key',request_key,
      'payload_fingerprint',payload_hash,
      'created_by_user_id','00000000-0000-0000-0000-000000000001'
    ),
    jsonb_build_array(jsonb_build_object(
      'household_id','10000000-0000-0000-0000-000000000001',
      'disposition','imported','fingerprint_version',1,
      'base_fingerprint',base_hash,'occurrence_no',1,
      'transaction',jsonb_build_object(
        'household_id','10000000-0000-0000-0000-000000000001',
        'kind','expense','amount_cents',777,'occurred_on','2026-07-10',
        'description','Concurrent','category_id',null,'subcategory_id',null,
        'account_id','20000000-0000-0000-0000-000000000001',
        'credit_card_id',null,'installment_id',null,
        'responsibility_scope','household','responsible_user_id',null,
        'created_by_user_id','00000000-0000-0000-0000-000000000001'
      )
    ))
  );
$$;

do $$
begin
  if reserve_import_ai_paid_items(
       '10000000-0000-0000-0000-000000000001',
       '50000000-0000-0000-0000-000000000001', 10
     ) <> 10
     or reserve_import_ai_paid_items(
       '10000000-0000-0000-0000-000000000001',
       '50000000-0000-0000-0000-000000000001', 10
     ) <> 0
     or reserve_import_ai_paid_items(
       '10000000-0000-0000-0000-000000000001',
       '50000000-0000-0000-0000-000000000002', 20
     ) <> 15 then
    raise exception 'paid fallback budget assertion failed';
  end if;
end;
$$;

do $$
declare
  merge_result jsonb;
begin
  insert into categories(id,household_id,name) values
    ('24000000-0000-0000-0000-000000000001','10000000-0000-0000-0000-000000000001','Old category'),
    ('24000000-0000-0000-0000-000000000002','10000000-0000-0000-0000-000000000001','New category');
  insert into source_category_mappings(
    household_id,source,normalized_label,row_kind,category_id,
    suppress,created_by_user_id
  ) values (
    '10000000-0000-0000-0000-000000000001','nubank_csv','old label',
    'expense','24000000-0000-0000-0000-000000000001',false,
    '00000000-0000-0000-0000-000000000001'
  );
  merge_result := merge_category(
    '10000000-0000-0000-0000-000000000001',
    '24000000-0000-0000-0000-000000000001',
    '24000000-0000-0000-0000-000000000002'
  );
  if (merge_result #>> '{moved,source_category_mappings}')::integer <> 1
     or not exists (
       select 1 from source_category_mappings
       where normalized_label = 'old label'
         and category_id = '24000000-0000-0000-0000-000000000002'
     ) then
    raise exception 'category merge stranded source mapping';
  end if;
end;
$$;

-- A SECURITY DEFINER caller must not attach an imported household-A row to an
-- installment belonging to household B.
do $$
begin
  begin
    perform confirm_import_v2(
      jsonb_build_object(
        'household_id','10000000-0000-0000-0000-000000000001',
        'source','nubank_csv','request_key','30000000-0000-0000-0000-000000000007',
        'payload_fingerprint',repeat('7',64),
        'created_by_user_id','00000000-0000-0000-0000-000000000001'
      ),
      jsonb_build_array(jsonb_build_object(
        'household_id','10000000-0000-0000-0000-000000000001',
        'disposition','imported','fingerprint_version',1,
        'base_fingerprint',repeat('7',64),'occurrence_no',1,
        'transaction',jsonb_build_object(
          'household_id','10000000-0000-0000-0000-000000000001',
          'kind','expense','amount_cents',700,'occurred_on','2026-07-10',
          'description','Cross installment attack','category_id',null,'subcategory_id',null,
          'account_id','20000000-0000-0000-0000-000000000001','credit_card_id',null,
          'installment_id','23000000-0000-0000-0000-000000000002',
          'responsibility_scope','household','responsible_user_id',null,
          'created_by_user_id','00000000-0000-0000-0000-000000000001'
        )
      ))
    );
    raise exception 'cross-household installment link unexpectedly succeeded';
  exception when insufficient_privilege then null;
  end;
  if exists (select 1 from transactions where description = 'Cross installment attack') then
    raise exception 'cross-household installment attack left a transaction';
  end if;
end;
$$;

-- Shared nonce claims are atomic and direct mapping DML is not available to
-- browser roles even though the table was created under default privileges.
do $$
begin
  if not claim_import_suggestion_nonce('nonce-1234567890abcdef', now() + interval '2 minutes')
     or claim_import_suggestion_nonce('nonce-1234567890abcdef', now() + interval '2 minutes') then
    raise exception 'shared nonce replay assertion failed';
  end if;
  if has_table_privilege('authenticated', 'source_category_mappings', 'INSERT')
     or has_table_privilege('authenticated', 'source_category_mappings', 'UPDATE')
     or has_table_privilege('authenticated', 'source_category_mappings', 'DELETE')
     or has_table_privilege('anon', 'source_category_mappings', 'INSERT') then
    raise exception 'source mapping DML grants are too broad';
  end if;
end;
$$;

do $$
begin
  begin
    perform confirm_import_v2(
      jsonb_build_object(
        'household_id','10000000-0000-0000-0000-000000000002',
        'source','nubank_csv',
        'request_key','30000000-0000-0000-0000-000000000006',
        'payload_fingerprint',repeat('6',64),
        'created_by_user_id','00000000-0000-0000-0000-000000000001'
      ),
      jsonb_build_array(jsonb_build_object(
        'household_id','10000000-0000-0000-0000-000000000002',
        'disposition','imported','fingerprint_version',1,
        'base_fingerprint',repeat('6',64),'occurrence_no',1,
        'transaction',jsonb_build_object(
          'household_id','10000000-0000-0000-0000-000000000002',
          'kind','expense','amount_cents',1,'occurred_on','2026-07-10',
          'description','Cross household','category_id',null,'subcategory_id',null,
          'account_id',null,'credit_card_id',null,'installment_id',null,
          'responsibility_scope','household','responsible_user_id',null,
          'created_by_user_id','00000000-0000-0000-0000-000000000001'
        )
      ))
    );
    raise exception 'cross-household import unexpectedly succeeded';
  exception when insufficient_privilege then null;
  end;
end;
$$;

-- A late installment failure must roll back the preceding flat row, claim, and
-- batch from the same RPC invocation.
do $$
declare
  group_payload jsonb := jsonb_build_object(
    'household_id','10000000-0000-0000-0000-000000000001',
    'credit_card_id','21000000-0000-0000-0000-000000000002',
    'description','Invalid foreign card group','total_amount_cents',1000,
    'installment_count',1,'purchased_on','2026-07-10',
    'category_id',null,'subcategory_id',null,'responsibility_scope','household',
    'responsible_user_id',null,
    'created_by_user_id','00000000-0000-0000-0000-000000000001'
  );
begin
  begin
    perform confirm_import_v2(
      jsonb_build_object(
        'household_id','10000000-0000-0000-0000-000000000001',
        'source','mercado_pago_pdf','request_key','30000000-0000-0000-0000-000000000008',
        'payload_fingerprint',repeat('8',64),
        'created_by_user_id','00000000-0000-0000-0000-000000000001'
      ),
      jsonb_build_array(
        jsonb_build_object(
          'household_id','10000000-0000-0000-0000-000000000001',
          'disposition','imported','fingerprint_version',1,
          'base_fingerprint',repeat('8',64),'occurrence_no',1,
          'transaction',jsonb_build_object(
            'household_id','10000000-0000-0000-0000-000000000001',
            'kind','expense','amount_cents',800,'occurred_on','2026-07-10',
            'description','Must roll back','category_id',null,'subcategory_id',null,
            'account_id','20000000-0000-0000-0000-000000000001','credit_card_id',null,
            'installment_id',null,'responsibility_scope','household',
            'responsible_user_id',null,
            'created_by_user_id','00000000-0000-0000-0000-000000000001'
          )
        ),
        jsonb_build_object(
          'household_id','10000000-0000-0000-0000-000000000001',
          'disposition','imported','fingerprint_version',1,
          'base_fingerprint',repeat('9',64),'occurrence_no',1,
          'installment_group',group_payload,
          'installments',jsonb_build_array(
            group_payload - 'total_amount_cents' - 'purchased_on' ||
              jsonb_build_object('number',1,'amount_cents',1000,'due_month','2026-07')
          )
        )
      )
    );
    raise exception 'mixed invalid import unexpectedly succeeded';
  exception when foreign_key_violation then null;
  end;
  if exists (select 1 from transactions where description = 'Must roll back')
     or exists (select 1 from import_batches where request_key = '30000000-0000-0000-0000-000000000008')
     or exists (select 1 from import_item_claims where base_fingerprint = repeat('8',64)) then
    raise exception 'mixed failure did not roll back atomically';
  end if;
end;
$$;

do $$
declare
  result jsonb;
  common_group jsonb := jsonb_build_object(
    'household_id','10000000-0000-0000-0000-000000000001',
    'credit_card_id','21000000-0000-0000-0000-000000000001',
    'description','Notebook','total_amount_cents',20000,
    'installment_count',2,'purchased_on','2026-07-10',
    'category_id',null,'subcategory_id',null,
    'responsibility_scope','household','responsible_user_id',null,
    'created_by_user_id','00000000-0000-0000-0000-000000000001'
  );
begin
  result := confirm_import_v2(
    jsonb_build_object(
      'household_id','10000000-0000-0000-0000-000000000001',
      'source','mercado_pago_pdf',
      'request_key','30000000-0000-0000-0000-000000000005',
      'payload_fingerprint',repeat('f',64),
      'created_by_user_id','00000000-0000-0000-0000-000000000001'
    ),
    jsonb_build_array(
      jsonb_build_object(
        'household_id','10000000-0000-0000-0000-000000000001',
        'disposition','imported','fingerprint_version',1,
        'base_fingerprint',repeat('1',64),'occurrence_no',1,
        'transaction',jsonb_build_object(
          'household_id','10000000-0000-0000-0000-000000000001',
          'kind','expense','amount_cents',500,'occurred_on','2026-07-10',
          'description','Flat','category_id',null,'subcategory_id',null,
          'account_id',null,'credit_card_id','21000000-0000-0000-0000-000000000001',
          'installment_id',null,'responsibility_scope','household',
          'responsible_user_id',null,
          'created_by_user_id','00000000-0000-0000-0000-000000000001'
        )
      ),
      jsonb_build_object(
        'household_id','10000000-0000-0000-0000-000000000001',
        'disposition','imported','fingerprint_version',1,
        'base_fingerprint',repeat('2',64),'occurrence_no',1,
        'installment_group',common_group,
        'installments',jsonb_build_array(
          common_group - 'total_amount_cents' - 'purchased_on' ||
            jsonb_build_object('number',1,'amount_cents',10000,'due_month','2026-07'),
          common_group - 'total_amount_cents' - 'purchased_on' ||
            jsonb_build_object('number',2,'amount_cents',10000,'due_month','2026-08')
        )
      )
    )
  );
  if (result ->> 'transactions_created')::integer <> 1
     or (result ->> 'installment_groups_created')::integer <> 1
     or (select count(*) from installment_groups
         where household_id = '10000000-0000-0000-0000-000000000001') <> 1
     or (select count(*) from installments
         where household_id = '10000000-0000-0000-0000-000000000001') <> 2 then
    raise exception 'mixed flat/installment atomic assertion failed';
  end if;
end;
$$;
