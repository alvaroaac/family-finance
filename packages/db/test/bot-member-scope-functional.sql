-- Run after 202610080003 on an isolated database. These rows are test fixtures only.
create or replace function auth.uid() returns uuid language sql stable
as 'select nullif(current_setting(''request.jwt.claim.sub'', true), '''')::uuid';
create or replace function auth.role() returns text language sql stable
as 'select current_setting(''request.jwt.claim.role'', true)';

insert into households(id, name) values
  ('51000000-0000-0000-0000-000000000001', 'Casa A'),
  ('51000000-0000-0000-0000-000000000002', 'Casa B');
insert into auth.users(id, email) values
  ('52000000-0000-0000-0000-000000000001', 'bot-a@example.test'),
  ('52000000-0000-0000-0000-000000000002', 'bot-b@example.test'),
  ('52000000-0000-0000-0000-000000000003', 'bot-a2@example.test');
insert into household_members(household_id, user_id, display_name, telegram_user_id, telegram_username) values
  ('51000000-0000-0000-0000-000000000001', '52000000-0000-0000-0000-000000000001', 'Ana', 701, 'ana_test'),
  ('51000000-0000-0000-0000-000000000002', '52000000-0000-0000-0000-000000000002', 'Bia', null, 'bia_teste'),
  ('51000000-0000-0000-0000-000000000001', '52000000-0000-0000-0000-000000000003', 'Cris', 703, null);

do $$ begin
  if has_function_privilege('anon', 'resolve_telegram_member(bigint,text)', 'execute')
    or has_function_privilege('authenticated', 'resolve_telegram_member(bigint,text)', 'execute')
    or not has_function_privilege('service_role', 'resolve_telegram_member(bigint,text)', 'execute') then
    raise exception 'Telegram resolver execute grants are wrong';
  end if;
  if (select count(*) from bot_conversations where chat_id = 9001) <> 0 then
    raise exception 'old chat-only conversation survived migration';
  end if;
end $$;

set role anon;
do $$ begin
  begin
    perform * from resolve_telegram_member(701, null);
    raise exception 'anon executed Telegram resolver';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

set role authenticated;
do $$ begin
  begin
    perform * from resolve_telegram_member(701, null);
    raise exception 'authenticated executed Telegram resolver';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

set role service_role;
do $$
declare
  matched record;
begin
  select * into matched from resolve_telegram_member(701, 'irrelevant');
  if matched.household_id <> '51000000-0000-0000-0000-000000000001'
    or matched.user_id <> '52000000-0000-0000-0000-000000000001'
    or matched.display_name <> 'Ana' then
    raise exception 'stable Telegram id resolution failed';
  end if;
  if exists(select 1 from resolve_telegram_member(799, '@ana_test')) then
    raise exception 'already linked username was rebound to another Telegram id';
  end if;
  select * into matched from resolve_telegram_member(702, '@BIA_TESTE');
  if matched.household_id <> '51000000-0000-0000-0000-000000000002'
    or matched.user_id <> '52000000-0000-0000-0000-000000000002' then
    raise exception 'username resolution failed';
  end if;
  if exists(select 1 from resolve_telegram_member(999, 'unknown')) then
    raise exception 'unknown Telegram sender resolved';
  end if;
  if exists(select 1 from resolve_telegram_member(999, '@bia_teste')) then
    raise exception 'cleared username was reused by a different sender';
  end if;
end $$;
reset role;

do $$ begin
  if not exists(select 1 from household_members
    where user_id = '52000000-0000-0000-0000-000000000001'
      and telegram_user_id = 701 and telegram_username = 'ana_test') then
    raise exception 'rejected username rebind changed the linked member';
  end if;
  if not exists (select 1 from household_members
    where user_id = '52000000-0000-0000-0000-000000000002'
      and telegram_user_id = 702 and telegram_username is null) then
    raise exception 'username match did not back-fill id and clear username';
  end if;
  insert into bot_conversations(chat_id, telegram_user_id, household_id, state) values
    (9001, 701, '51000000-0000-0000-0000-000000000001', '{"draft":"A"}'),
    (9001, 702, '51000000-0000-0000-0000-000000000002', '{"draft":"B"}'),
    (9001, 703, '51000000-0000-0000-0000-000000000001', '{"draft":"A2"}');
  if (select count(*) from bot_conversations where chat_id = 9001) <> 3
    or (select state ->> 'draft' from bot_conversations where chat_id = 9001 and telegram_user_id = 703) <> 'A2' then
    raise exception 'group-chat drafts are not independent by Telegram sender';
  end if;
end $$;

set role authenticated;
do $$ begin
  if exists (select 1 from bot_conversations) then
    raise exception 'member could read service-role conversation drafts';
  end if;
  begin
    insert into bot_conversations(chat_id, telegram_user_id, household_id, state)
    values (9002, 701, '51000000-0000-0000-0000-000000000001', '{}');
    raise exception 'member could write service-role conversation drafts';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;

insert into accounts(id, household_id, kind, name) values
  ('53000000-0000-0000-0000-000000000001', '51000000-0000-0000-0000-000000000001', 'checking', 'A'),
  ('53000000-0000-0000-0000-000000000002', '51000000-0000-0000-0000-000000000002', 'checking', 'B');
insert into credit_cards(id, household_id, name) values
  ('54000000-0000-0000-0000-000000000001', '51000000-0000-0000-0000-000000000001', 'Cartão A'),
  ('54000000-0000-0000-0000-000000000002', '51000000-0000-0000-0000-000000000002', 'Cartão B');
insert into categories(id, household_id, name) values
  ('55000000-0000-0000-0000-000000000001', '51000000-0000-0000-0000-000000000001', 'A'),
  ('55000000-0000-0000-0000-000000000002', '51000000-0000-0000-0000-000000000002', 'B');
insert into categorization_memory(household_id, pattern, confidence, explanation) values
  ('51000000-0000-0000-0000-000000000001', 'a', 1, 'A'),
  ('51000000-0000-0000-0000-000000000002', 'b', 1, 'B');
insert into transactions(household_id, kind, amount_cents, occurred_on, description, account_id, created_by_user_id) values
  ('51000000-0000-0000-0000-000000000002', 'expense', 100, current_date, 'B', '53000000-0000-0000-0000-000000000002', '52000000-0000-0000-0000-000000000002');
insert into obligations(id, household_id, description, amount_cents, start_month, due_day, account_id, created_by_user_id) values
  ('56000000-0000-0000-0000-000000000001', '51000000-0000-0000-0000-000000000001',
    'Aluguel', 100, '2026-10', 10, '53000000-0000-0000-0000-000000000001',
    '52000000-0000-0000-0000-000000000001');

select set_config('request.jwt.claim.sub', '52000000-0000-0000-0000-000000000001', false);
select set_config('request.jwt.claim.role', 'authenticated', false);
set role authenticated;
do $$ begin
  if (select count(*) from categories) <> 1
    or (select count(*) from categorization_memory) <> 1
    or (select count(*) from credit_cards) <> 1
    or (select count(*) from transactions) <> 0 then
    raise exception 'member business reads crossed household boundary';
  end if;
  begin
    insert into transactions(household_id, kind, amount_cents, occurred_on, description, account_id, created_by_user_id)
    values ('51000000-0000-0000-0000-000000000002', 'expense', 100, current_date, 'forged',
      '53000000-0000-0000-0000-000000000002', '52000000-0000-0000-0000-000000000001');
    raise exception 'foreign household transaction was accepted';
  exception when insufficient_privilege then null;
  end;
  insert into transactions(household_id, kind, amount_cents, occurred_on, description, account_id, created_by_user_id)
  values ('51000000-0000-0000-0000-000000000001', 'expense', 100, current_date, 'own',
    '53000000-0000-0000-0000-000000000001', '52000000-0000-0000-0000-000000000001');
end $$;
reset role;

-- A missing UID must not pass the bot-facing SECURITY DEFINER RPCs.
select set_config('request.jwt.claim.sub', '', false);
set role authenticated;
do $$ begin
  begin
    perform settle_card_bill(
      '51000000-0000-0000-0000-000000000001',
      '54000000-0000-0000-0000-000000000001',
      '53000000-0000-0000-0000-000000000001',
      '2026-10', 100, date '2026-10-10',
      '52000000-0000-0000-0000-000000000001', 'null-uid');
    raise exception 'null-UID card settlement passed';
  exception when insufficient_privilege then null;
  end;
  begin
    perform materialize_obligation_payment(
      '56000000-0000-0000-0000-000000000001', '2026-10',
      date '2026-10-10', null::bigint, null::uuid);
    raise exception 'null-UID obligation payment passed';
  exception when sqlstate '22023' then null;
  end;
end $$;
reset role;

select set_config('request.jwt.claim.role', 'service_role', false);
set role service_role;
do $$ begin
  begin
    perform create_installment_purchase(
      jsonb_build_object(
        'household_id', '51000000-0000-0000-0000-000000000001',
        'credit_card_id', '54000000-0000-0000-0000-000000000001',
        'description', 'Null UID', 'total_amount_cents', 100,
        'installment_count', 1, 'purchased_on', '2026-10-01',
        'responsibility_scope', 'household',
        'created_by_user_id', '52000000-0000-0000-0000-000000000001'),
      '[]'::jsonb);
    raise exception 'null-UID installment purchase passed';
  exception when insufficient_privilege then null;
  end;
end $$;
reset role;
