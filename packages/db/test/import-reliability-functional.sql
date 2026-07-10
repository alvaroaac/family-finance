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
     or (select count(*) from installment_groups) <> 1
     or (select count(*) from installments) <> 2 then
    raise exception 'mixed flat/installment atomic assertion failed';
  end if;
end;
$$;
