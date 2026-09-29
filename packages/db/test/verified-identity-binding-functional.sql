-- Run after 0032 with auth.users.email_confirmed_at in the migration harness.
do $$
declare
  home uuid := '00000000-0000-0000-0000-000000000001';
  unconfirmed uuid := '90000000-0000-0000-0000-000000000032';
  late uuid := '90000000-0000-0000-0000-000000000033';
  confirmed uuid := '90000000-0000-0000-0000-000000000034';
  confirmed_on_insert uuid := '90000000-0000-0000-0000-000000000035';
begin
  insert into households (id, name) values (home, 'Verified identity test');
  insert into allowed_emails (email, household_id) values ('unconfirmed32@example.test', home);
  insert into auth.users (id, email) values (unconfirmed, 'unconfirmed32@example.test');
  if exists (select 1 from household_members where user_id = unconfirmed) then
    raise exception 'unconfirmed signup was provisioned';
  end if;
  update auth.users set email_confirmed_at = now() where id = unconfirmed;
  if (select count(*) from household_members where user_id = unconfirmed) <> 1 then
    raise exception 'confirmation did not provision exactly once';
  end if;
  update auth.users set email_confirmed_at = now() + interval '1 second' where id = unconfirmed;
  if (select count(*) from household_members where user_id = unconfirmed) <> 1 then
    raise exception 'second confirmation created a duplicate';
  end if;

  insert into auth.users (id, email) values (late, 'late32@example.test');
  insert into allowed_emails (email, household_id) values ('late32@example.test', home);
  if exists (select 1 from household_members where user_id = late) then
    raise exception 'allowlisting an unconfirmed user provisioned it';
  end if;
  update auth.users set email_confirmed_at = now() where id = late;
  if (select count(*) from household_members where user_id = late) <> 1 then
    raise exception 'late confirmation did not provision';
  end if;

  insert into auth.users (id, email, email_confirmed_at)
    values (confirmed, 'confirmed32@example.test', now());
  insert into allowed_emails (email, household_id) values ('confirmed32@example.test', home);
  if (select count(*) from household_members where user_id = confirmed) <> 1 then
    raise exception 'confirmed allowlisted user was not provisioned';
  end if;
  insert into allowed_emails (email, household_id)
    values ('confirmed-insert32@example.test', home);
  insert into auth.users (id, email, email_confirmed_at)
    values (confirmed_on_insert, 'confirmed-insert32@example.test', now());
  if (select count(*) from household_members where user_id = confirmed_on_insert) <> 1 then
    raise exception 'confirmed signup was not provisioned';
  end if;
end $$;

do $$
declare
  confirmed uuid := '90000000-0000-0000-0000-000000000034';
  late uuid := '90000000-0000-0000-0000-000000000033';
  first_code text;
  second_code text;
  code_member uuid;
begin
  if not has_column_privilege('authenticated', 'household_members', 'display_name', 'update')
    or exists (select 1 from unnest(array[
      'telegram_user_id', 'telegram_username', 'is_active', 'role', 'user_id',
      'household_id']) col
      where has_column_privilege('authenticated', 'household_members', col, 'update')) then
    raise exception 'member column-level grants are wrong';
  end if;
  if has_function_privilege('anon', 'create_telegram_link_code()', 'execute')
    or has_function_privilege('authenticated', 'redeem_telegram_link_code(text,bigint)', 'execute')
    or has_function_privilege('authenticated', 'resolve_telegram_member(bigint)', 'execute')
    or not has_function_privilege('service_role', 'resolve_telegram_member(bigint)', 'execute')
    or has_table_privilege('authenticated', 'telegram_link_codes', 'select') then
    raise exception 'Telegram link privilege boundary is wrong';
  end if;
  if to_regprocedure('public.resolve_telegram_member(bigint,text)') is not null then
    raise exception 'obsolete two-argument Telegram resolver still exists';
  end if;
  perform set_config('request.jwt.claim.sub', confirmed::text, true);
  first_code := create_telegram_link_code();
  second_code := create_telegram_link_code();
  if first_code !~ '^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$'
    or second_code !~ '^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$' then
    raise exception 'link code alphabet or length is wrong';
  end if;
  select member_id into code_member from telegram_link_codes
    where code_hash = encode(sha256(convert_to(second_code, 'UTF8')), 'hex');
  if code_member is null or (select count(*) from telegram_link_codes) <> 1
    or exists (select 1 from redeem_telegram_link_code(first_code, 32001)) then
    raise exception 'second code did not replace first code';
  end if;
  update household_members set telegram_user_id = 32002 where user_id = late;
  if exists (select 1 from redeem_telegram_link_code(second_code, 32002)) then
    raise exception 'bound Telegram id redeemed a code';
  end if;
  if exists (select 1 from telegram_link_codes where member_id = code_member) then
    raise exception 'bound Telegram id did not consume rejected code';
  end if;
  second_code := create_telegram_link_code();
  update household_members set is_active = false where user_id = confirmed;
  if exists (select 1 from redeem_telegram_link_code(second_code, 32003)) then
    raise exception 'inactive member redeemed a code';
  end if;
  if exists (select 1 from telegram_link_codes where member_id = code_member) then
    raise exception 'inactive member did not consume rejected code';
  end if;
  update household_members set is_active = true where user_id = confirmed;
  second_code := create_telegram_link_code();
  if (select count(*) from redeem_telegram_link_code(second_code, 32003)) <> 1
    or exists (select 1 from redeem_telegram_link_code(second_code, 32003))
    or (select telegram_user_id from household_members where user_id = confirmed) <> 32003
    or not exists (select 1 from resolve_telegram_member(32003))
    or exists (select 1 from resolve_telegram_member(32004)) then
    raise exception 'valid code did not bind exactly once';
  end if;
  first_code := create_telegram_link_code();
  update telegram_link_codes set expires_at = now() - interval '1 minute';
  if exists (select 1 from redeem_telegram_link_code(first_code, 32004)) then
    raise exception 'expired code redeemed';
  end if;
  perform unlink_telegram();
  if (select telegram_user_id from household_members where user_id = confirmed) is not null
    or (select telegram_user_id from household_members where user_id = late) <> 32002
    or exists (select 1 from telegram_link_codes where member_id = code_member) then
    raise exception 'unlink touched another member or retained code';
  end if;
end $$;
