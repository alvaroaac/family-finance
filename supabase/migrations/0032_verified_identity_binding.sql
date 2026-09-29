-- Membership is issued only for confirmed auth identities.
create or replace function provision_household_member()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  target_household_id uuid;
begin
  if new.email_confirmed_at is null then
    return new;
  end if;
  if tg_op = 'UPDATE' then
    if old.email_confirmed_at is not null then
      return new;
    end if;
  end if;
  select a.household_id into target_household_id
  from allowed_emails a where lower(a.email) = lower(new.email);
  if target_household_id is not null then
    insert into household_members (household_id, user_id, role, is_active)
    values (target_household_id, new.id, 'member', true)
    on conflict (user_id) do nothing;
    if not found and exists (select 1 from household_members
      where user_id = new.id and household_id <> target_household_id) then
      raise warning 'provision_household_member: % already belongs to another household; skipped', new.email;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists provision_member_on_signup on auth.users;
create trigger provision_member_on_signup
  after insert or update of email_confirmed_at on auth.users
  for each row execute function provision_household_member();

create or replace function provision_on_allowlist()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  existing_user record;
begin
  for existing_user in
    select u.id from auth.users u
    where lower(u.email) = lower(new.email) and u.email_confirmed_at is not null
  loop
    insert into household_members (household_id, user_id, role, is_active)
    values (new.household_id, existing_user.id, 'member', true)
    on conflict (user_id) do nothing;
    if not found and exists (select 1 from household_members
      where user_id = existing_user.id and household_id <> new.household_id) then
      raise exception 'provision_on_allowlist: % already belongs to another household', new.email
        using errcode = 'unique_violation';
    end if;
  end loop;
  return new;
end;
$$;

-- RLS still limits rows; column grants limit what a member can change.
revoke update on household_members from public, anon, authenticated;
grant update (display_name) on household_members to authenticated;

create table if not exists telegram_link_codes (
  member_id uuid primary key references household_members(id) on delete cascade,
  code_hash text not null unique,
  expires_at timestamptz not null
);
alter table telegram_link_codes enable row level security;
revoke all on telegram_link_codes from public, anon, authenticated;

create or replace function create_telegram_link_code()
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  member uuid;
  code text := '';
  bytes bytea := extensions.gen_random_bytes(8);
  alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  i integer;
begin
  select hm.id into member from household_members hm
  where hm.user_id = auth.uid() and hm.is_active;
  if member is null then
    raise exception 'create_telegram_link_code: active membership required'
      using errcode = '42501';
  end if;
  for i in 0..7 loop
    code := code || substr(alphabet, get_byte(bytes, i) % length(alphabet) + 1, 1);
  end loop;
  insert into telegram_link_codes (member_id, code_hash, expires_at)
  values (member, encode(pg_catalog.sha256(convert_to(code, 'UTF8')), 'hex'),
          now() + interval '10 minutes')
  on conflict (member_id) do update
    set code_hash = excluded.code_hash, expires_at = excluded.expires_at;
  return code;
end;
$$;
revoke all on function create_telegram_link_code() from public, anon, service_role;
grant execute on function create_telegram_link_code() to authenticated;

create or replace function redeem_telegram_link_code(p_code text, p_telegram_user_id bigint)
returns table (household_id uuid, user_id uuid, display_name text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  linked household_members;
  candidate uuid;
begin
  select lc.member_id into candidate from telegram_link_codes lc
  where lc.code_hash = encode(pg_catalog.sha256(
    convert_to(upper(trim(p_code)), 'UTF8')), 'hex')
    and lc.expires_at > now()
  for update;
  if candidate is null or p_telegram_user_id is null then
    return;
  end if;
  perform pg_advisory_xact_lock(p_telegram_user_id);
  select hm.* into linked from household_members hm
  where hm.id = candidate and hm.is_active for update;
  if linked.id is null or exists (
    select 1 from household_members hm
    where hm.telegram_user_id = p_telegram_user_id and hm.id <> candidate
  ) then
    return;
  end if;
  update household_members hm
  set telegram_user_id = p_telegram_user_id, telegram_username = null
  where hm.id = candidate;
  delete from telegram_link_codes lc where lc.member_id = candidate;
  return query select linked.household_id, linked.user_id, linked.display_name;
end;
$$;
revoke all on function redeem_telegram_link_code(text, bigint)
  from public, anon, authenticated;
grant execute on function redeem_telegram_link_code(text, bigint) to service_role;

create or replace function unlink_telegram()
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  member uuid;
begin
  select hm.id into member from household_members hm
  where hm.user_id = auth.uid() and hm.is_active;
  if member is null then
    raise exception 'unlink_telegram: active membership required'
      using errcode = '42501';
  end if;
  update household_members hm
  set telegram_user_id = null, telegram_username = null where hm.id = member;
  delete from telegram_link_codes lc where lc.member_id = member;
end;
$$;
revoke all on function unlink_telegram() from public, anon, service_role;
grant execute on function unlink_telegram() to authenticated;

create or replace function resolve_telegram_member(
  p_telegram_user_id bigint,
  p_telegram_username text
)
returns table (household_id uuid, user_id uuid, display_name text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  return query select hm.household_id, hm.user_id, hm.display_name
  from household_members hm
  where hm.telegram_user_id = p_telegram_user_id and hm.is_active;
end;
$$;
revoke all on function resolve_telegram_member(bigint, text)
  from public, anon, authenticated;
grant execute on function resolve_telegram_member(bigint, text) to service_role;
