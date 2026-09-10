-- Backfill preserves IDs, archive state and references, and seed replay is safe.
do $$ begin
  if (select count(*) from categories where id in (
    '70000000-0000-0000-0000-000000000001',
    '70000000-0000-0000-0000-000000000002',
    '70000000-0000-0000-0000-000000000003') and kind = 'income') <> 3
    or (select is_active from categories where id = '70000000-0000-0000-0000-000000000001')
    or not exists (select 1 from subcategories where name = 'Preserved'
      and category_id = '70000000-0000-0000-0000-000000000001') then
    raise exception 'income backfill lost existing data';
  end if;
  if has_function_privilege('anon','update_installment_group_category(uuid,uuid,jsonb)','execute')
    or has_function_privilege('service_role','update_installment_group_category(uuid,uuid,jsonb)','execute')
    or not has_function_privilege('authenticated','update_installment_group_category(uuid,uuid,jsonb)','execute') then
    raise exception 'incorrect RPC grants';
  end if;
end $$;

create or replace function auth.uid() returns uuid language sql stable
as 'select nullif(current_setting(''request.jwt.claim.sub'', true), '''')::uuid';
select set_config('request.jwt.claim.sub','80000000-0000-0000-0000-000000000001',false);
insert into auth.users(id,email) values
  ('80000000-0000-0000-0000-000000000001','category-test@example.com');
insert into household_members(household_id,user_id) values
  ('00000000-0000-0000-0000-000000000001','80000000-0000-0000-0000-000000000001');
insert into households(id,name) values ('80000000-0000-0000-0000-000000000002','Other');
insert into categories(id,household_id,name,kind,is_active) values
  ('81000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000001','Expense A','expense',true),
  ('81000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000001','Expense B','expense',true),
  ('81000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000001','Archived','expense',false),
  ('81000000-0000-0000-0000-000000000004','80000000-0000-0000-0000-000000000002','Foreign','expense',true);
insert into subcategories(id,household_id,category_id,name) values
  ('82000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000001','81000000-0000-0000-0000-000000000001','Sub A'),
  ('82000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000001','81000000-0000-0000-0000-000000000002','Sub B');
insert into credit_cards(id,household_id,name,closing_day,due_day) values
  ('83000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000001','Card',10,17);
insert into installment_groups(id,household_id,credit_card_id,description,total_amount_cents,
  installment_count,purchased_on,created_by_user_id,category_id,subcategory_id) values
  ('84000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000001',
   '83000000-0000-0000-0000-000000000001','Purchase',2000,2,'2026-09-10',
   '80000000-0000-0000-0000-000000000001','81000000-0000-0000-0000-000000000001',
   '82000000-0000-0000-0000-000000000001');
insert into installments(household_id,installment_group_id,credit_card_id,number,
  installment_count,amount_cents,due_month,description,created_by_user_id,category_id,subcategory_id)
select '00000000-0000-0000-0000-000000000001','84000000-0000-0000-0000-000000000001',
  '83000000-0000-0000-0000-000000000001',n,2,1000,'2026-10','Purchase',
  '80000000-0000-0000-0000-000000000001','81000000-0000-0000-0000-000000000001',
  '82000000-0000-0000-0000-000000000001'
from generate_series(1,2) as n;

set role authenticated;
do $$
declare
  h uuid := '00000000-0000-0000-0000-000000000001';
  g uuid := '84000000-0000-0000-0000-000000000001';
  bad jsonb;
begin
  -- Income, archived, foreign, mismatched subcategory, omitted stale
  -- subcategory, null parent with non-null subcategory, and invalid patch keys.
  foreach bad in array array[
    '{"category_id":"70000000-0000-0000-0000-000000000002","subcategory_id":null}'::jsonb,
    '{"category_id":"81000000-0000-0000-0000-000000000003","subcategory_id":null}'::jsonb,
    '{"category_id":"81000000-0000-0000-0000-000000000004","subcategory_id":null}'::jsonb,
    '{"subcategory_id":"82000000-0000-0000-0000-000000000002"}'::jsonb,
    '{"category_id":"81000000-0000-0000-0000-000000000002"}'::jsonb,
    '{"category_id":null}'::jsonb,
    '{"amount_cents":1}'::jsonb
  ] loop
    begin
      perform update_installment_group_category(h,g,bad);
      raise exception 'invalid patch unexpectedly accepted: %',bad;
    exception when sqlstate '22023' then null;
    end;
  end loop;
  begin
    perform update_installment_group_category('80000000-0000-0000-0000-000000000002',g,'{}');
    raise exception 'foreign household accepted';
  exception when insufficient_privilege then null;
  end;
  begin
    perform update_installment_group_category(h,'84000000-0000-0000-0000-000000000099','{}');
    raise exception 'missing group accepted';
  exception when sqlstate '22023' then null;
  end;
  perform update_installment_group_category(h,g,
    '{"category_id":"81000000-0000-0000-0000-000000000002","subcategory_id":"82000000-0000-0000-0000-000000000002"}');
  if (select count(*) from installments where installment_group_id=g
    and category_id='81000000-0000-0000-0000-000000000002'
    and subcategory_id='82000000-0000-0000-0000-000000000002') <> 2 then
    raise exception 'parcels not updated';
  end if;
  perform update_installment_group_category(h,g,'{"subcategory_id":null}');
  if (select category_id from installment_groups where id=g) <> '81000000-0000-0000-0000-000000000002' then
    raise exception 'omitted category not preserved';
  end if;
end $$;
reset role;

-- Fail on the second parcel, after the parent and first parcel were touched.
create function fail_second_parcel() returns trigger language plpgsql as $$
begin
  if new.number=2 then raise exception 'forced parcel failure' using errcode='P0002'; end if;
  return new;
end $$;
create trigger fail_second_parcel before update on installments
for each row execute function fail_second_parcel();
set role authenticated;
do $$ begin
  begin
    perform update_installment_group_category('00000000-0000-0000-0000-000000000001',
      '84000000-0000-0000-0000-000000000001','{"category_id":null,"subcategory_id":null}');
    raise exception 'forced failure did not fire';
  exception when sqlstate 'P0002' then null;
  end;
  if exists (select 1 from installment_groups where id='84000000-0000-0000-0000-000000000001'
    and category_id is distinct from '81000000-0000-0000-0000-000000000002'::uuid)
    or (select count(*) from installments where installment_group_id='84000000-0000-0000-0000-000000000001'
      and category_id='81000000-0000-0000-0000-000000000002') <> 2 then
    raise exception 'failed operation partially committed';
  end if;
end $$;
reset role;
drop trigger fail_second_parcel on installments;
drop function fail_second_parcel();
set role authenticated;
select update_installment_group_category('00000000-0000-0000-0000-000000000001',
  '84000000-0000-0000-0000-000000000001','{"category_id":null,"subcategory_id":null}');
do $$ begin
  if exists (select 1 from installment_groups where id='84000000-0000-0000-0000-000000000001'
    and (category_id is not null or subcategory_id is not null))
    or exists (select 1 from installments where installment_group_id='84000000-0000-0000-0000-000000000001'
      and (category_id is not null or subcategory_id is not null)) then
    raise exception 'explicit nulls did not clear categorization';
  end if;
end $$;
reset role;
