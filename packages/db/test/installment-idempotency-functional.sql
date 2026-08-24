-- Executable probe for migration 0019. The import reliability fixture loaded
-- immediately before this file provides household/card/user rows.

create or replace function auth.uid() returns uuid language sql stable
as 'select null::uuid';
create or replace function auth.role() returns text language sql stable
as 'select ''service_role''::text';

set role service_role;
do $$
declare
  group_payload jsonb := jsonb_build_object(
    'household_id','10000000-0000-0000-0000-000000000001',
    'credit_card_id','21000000-0000-0000-0000-000000000001',
    'description','Lost response probe',
    'total_amount_cents',1001,
    'installment_count',2,
    'purchased_on','2026-07-10',
    'category_id',null,
    'subcategory_id',null,
    'responsibility_scope','household',
    'responsible_user_id',null,
    'created_by_user_id','00000000-0000-0000-0000-000000000001',
    'idempotency_key','service-role-lost-response-probe'
  );
  installments_payload jsonb := jsonb_build_array(
    jsonb_build_object(
      'household_id','10000000-0000-0000-0000-000000000001',
      'credit_card_id','21000000-0000-0000-0000-000000000001',
      'number',1,'installment_count',2,'amount_cents',501,
      'due_month','2026-08','description','Lost response probe',
      'category_id',null,'subcategory_id',null,
      'responsibility_scope','household','responsible_user_id',null,
      'created_by_user_id','00000000-0000-0000-0000-000000000001'
    ),
    jsonb_build_object(
      'household_id','10000000-0000-0000-0000-000000000001',
      'credit_card_id','21000000-0000-0000-0000-000000000001',
      'number',2,'installment_count',2,'amount_cents',500,
      'due_month','2026-09','description','Lost response probe',
      'category_id',null,'subcategory_id',null,
      'responsibility_scope','household','responsible_user_id',null,
      'created_by_user_id','00000000-0000-0000-0000-000000000001'
    )
  );
  first_result jsonb;
  replay_result jsonb;
  mismatch_rejected boolean := false;
begin
  first_result := create_installment_purchase(group_payload, installments_payload);
  replay_result := create_installment_purchase(group_payload, installments_payload);

  if first_result -> 'group' ->> 'id' is distinct from replay_result -> 'group' ->> 'id'
     or jsonb_array_length(replay_result -> 'installments') <> 2 then
    raise exception 'service-role replay did not return the persisted purchase';
  end if;

  begin
    perform create_installment_purchase(
      group_payload,
      jsonb_set(installments_payload, '{0,due_month}', '"2026-07"'::jsonb)
    );
  exception when sqlstate '22023' then
    mismatch_rejected := true;
  end;
  if not mismatch_rejected then
    raise exception 'installment payload mismatch was not rejected';
  end if;
end $$;
reset role;

do $$ begin
  if (
    select count(*)
    from installment_groups
    where household_id = '10000000-0000-0000-0000-000000000001'
      and idempotency_key = 'service-role-lost-response-probe'
  ) <> 1 then
    raise exception 'idempotent replay created a duplicate group';
  end if;
end $$;

-- An authenticated caller with the same null UID must not inherit the bot's
-- service-role bypass.
create or replace function auth.role() returns text language sql stable
as 'select ''authenticated''::text';

set role authenticated;
do $$
declare
  rejected boolean := false;
begin
  begin
    perform create_installment_purchase(
      jsonb_build_object(
        'household_id','10000000-0000-0000-0000-000000000001',
        'credit_card_id','21000000-0000-0000-0000-000000000001',
        'description','Null UID forbidden','total_amount_cents',100,
        'installment_count',1,'purchased_on','2026-07-10',
        'category_id',null,'subcategory_id',null,
        'responsibility_scope','household','responsible_user_id',null,
        'created_by_user_id','00000000-0000-0000-0000-000000000001',
        'idempotency_key','authenticated-null-uid-forbidden-probe'
      ),
      '[]'::jsonb
    );
  exception when sqlstate '42501' then
    rejected := true;
  end;
  if not rejected then
    raise exception 'authenticated caller with null uid was not rejected';
  end if;
end $$;
reset role;

-- A real household member remains authorized as an authenticated caller.
create or replace function auth.uid() returns uuid language sql stable
as 'select ''00000000-0000-0000-0000-000000000001''::uuid';

set role authenticated;
do $$
declare
  member_result jsonb;
begin
  member_result := create_installment_purchase(
    jsonb_build_object(
      'household_id','10000000-0000-0000-0000-000000000001',
      'credit_card_id','21000000-0000-0000-0000-000000000001',
      'description','Authenticated member','total_amount_cents',100,
      'installment_count',1,'purchased_on','2026-07-10',
      'category_id',null,'subcategory_id',null,
      'responsibility_scope','household','responsible_user_id',null,
      'created_by_user_id','00000000-0000-0000-0000-000000000001',
      'idempotency_key','authenticated-member-probe'
    ),
    jsonb_build_array(jsonb_build_object(
      'household_id','10000000-0000-0000-0000-000000000001',
      'credit_card_id','21000000-0000-0000-0000-000000000001',
      'number',1,'installment_count',1,'amount_cents',100,
      'due_month','2026-08','description','Authenticated member',
      'category_id',null,'subcategory_id',null,
      'responsibility_scope','household','responsible_user_id',null,
      'created_by_user_id','00000000-0000-0000-0000-000000000001'
    ))
  );

  if member_result -> 'group' ->> 'id' is null
     or jsonb_array_length(member_result -> 'installments') <> 1 then
    raise exception 'authenticated household member was not authorized';
  end if;
end $$;
reset role;

create or replace function auth.uid() returns uuid language sql stable
as 'select ''00000000-0000-0000-0000-000000000002''::uuid';

set role authenticated;
do $$
declare
  rejected boolean := false;
begin
  begin
    perform create_installment_purchase(
      jsonb_build_object(
        'household_id','10000000-0000-0000-0000-000000000001',
        'credit_card_id','21000000-0000-0000-0000-000000000001',
        'description','Forbidden','total_amount_cents',100,
        'installment_count',1,'purchased_on','2026-07-10',
        'category_id',null,'subcategory_id',null,
        'responsibility_scope','household','responsible_user_id',null,
        'created_by_user_id','00000000-0000-0000-0000-000000000002',
        'idempotency_key','forbidden-probe'
      ),
      '[]'::jsonb
    );
  exception when sqlstate '42501' then
    rejected := true;
  end;
  if not rejected then
    raise exception 'authenticated non-member was not rejected';
  end if;
end $$;
reset role;

create or replace function auth.uid() returns uuid language sql stable
as 'select ''00000000-0000-0000-0000-000000000001''::uuid';
