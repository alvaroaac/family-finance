-- Run after 0029 on a database with household A and a migrated allowlist.
do $$
declare
  a uuid := '00000000-0000-0000-0000-000000000001';
  b uuid := '00000000-0000-0000-0000-000000000002';
begin
  if (select count(*) from allowed_emails where household_id = a) <> 2
    or exists (select 1 from allowed_emails where household_id is null)
    or exists (select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'allowed_emails' and column_name = 'household_slug')
    or not exists (select 1 from pg_constraint where conname = 'household_members_user_id_key')
    or (select theme from households where id = a) <> '{"base":"esmeralda"}'::jsonb then
    raise exception 'provisioning schema or single-household backfill is wrong';
  end if;

  insert into households (id, name) values (b, 'Household B');
  insert into allowed_emails (email, household_id) values ('Case-Signup@example.test', b);
  insert into auth.users (id, email) values
    ('90000000-0000-0000-0000-000000000001', 'case-signup@EXAMPLE.test');
  if (select count(*) from household_members where user_id = '90000000-0000-0000-0000-000000000001') <> 1
    or not exists (select 1 from household_members where user_id = '90000000-0000-0000-0000-000000000001' and household_id = b) then
    raise exception 'signup was not provisioned only into B';
  end if;

  insert into auth.users (id, email) values
    ('90000000-0000-0000-0000-000000000002', 'EXISTING@example.test');
  insert into allowed_emails (email, household_id) values ('existing@example.test', b);
  if not exists (select 1 from household_members where user_id = '90000000-0000-0000-0000-000000000002' and household_id = b) then
    raise exception 'existing user was not provisioned into B';
  end if;

  insert into auth.users (id, email) values
    ('90000000-0000-0000-0000-000000000003', 'already@example.test');
  insert into household_members (household_id, user_id) values
    (a, '90000000-0000-0000-0000-000000000003');
  begin
    insert into allowed_emails (email, household_id) values ('ALREADY@example.test', b);
    raise exception 'member of A was allowlisted for B';
  exception when unique_violation then null;
  end;
  if exists (select 1 from allowed_emails where lower(email) = 'already@example.test')
    or (select count(*) from household_members where user_id = '90000000-0000-0000-0000-000000000003') <> 1
    or not exists (select 1 from household_members where user_id = '90000000-0000-0000-0000-000000000003' and household_id = a) then
    raise exception 'existing member moved or gained another household';
  end if;

  begin
    insert into allowed_emails (email, household_id) values ('null@example.test', null);
    raise exception 'null household accepted';
  exception when not_null_violation then null;
  end;
  begin
    insert into allowed_emails (email, household_id) values
      ('unknown@example.test', '99999999-9999-9999-9999-999999999999');
    raise exception 'unknown household accepted';
  exception when foreign_key_violation then null;
  end;
end $$;
