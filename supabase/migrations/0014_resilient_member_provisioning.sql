-- 0014_resilient_member_provisioning.sql
-- Make allowlisted-email provisioning resilient to two silent-failure paths in
-- migration 0009:
--   (a) the trigger only fires on auth.users INSERT, so a member allowlisted
--       AFTER they first logged in (e.g. Karol, added in a runbook step) never
--       gets a household_members row — they authenticate, pass the allowlist,
--       and see an empty app with no error and no retry;
--   (b) if no household exists yet (seed.sql not applied, or applied after the
--       first login) the trigger silently returns, so provisioning is dropped
--       with no diagnostic.
--
-- This migration: (1) makes the signup trigger raise a WARNING (server log)
-- when it wants to provision but finds no household; (2) adds a trigger on
-- allowed_emails so allowlisting an already-signed-up user provisions them
-- retroactively; (3) backfills any currently-allowlisted user missing a
-- membership. All idempotent (on conflict do nothing; create or replace).

-- (1) Signup trigger: same behavior, but log when there is no household to
-- provision into instead of silently dropping the member.
create or replace function provision_household_member()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  target_household_id uuid;
begin
  if exists (select 1 from allowed_emails where lower(email) = lower(new.email)) then
    select h.id into target_household_id from households h limit 1;
    if target_household_id is null then
      raise warning 'provision_household_member: allowlisted % signed up but no household exists yet — provision manually after seeding',
        new.email;
    else
      insert into household_members (household_id, user_id, role, is_active)
      values (target_household_id, new.id, 'member', true)
      on conflict (household_id, user_id) do nothing;
    end if;
  end if;
  return new;
end;
$$;

-- (2) Allowlist trigger: when an email is added to the allowlist, provision any
-- auth.users already holding that email (the "logged in before allowlisted"
-- case). Fires on INSERT into allowed_emails.
create or replace function provision_on_allowlist()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  target_household_id uuid;
begin
  select h.id into target_household_id from households h limit 1;
  if target_household_id is null then
    raise warning 'provision_on_allowlist: % allowlisted but no household exists yet — provision manually after seeding',
      new.email;
    return new;
  end if;
  insert into household_members (household_id, user_id, role, is_active)
  select target_household_id, u.id, 'member', true
  from auth.users u
  where lower(u.email) = lower(new.email)
  on conflict (household_id, user_id) do nothing;
  return new;
end;
$$;

drop trigger if exists provision_member_on_allowlist on allowed_emails;
create trigger provision_member_on_allowlist
  after insert on allowed_emails
  for each row execute function provision_on_allowlist();

-- (3) One-time backfill: provision every currently-allowlisted user that has no
-- membership yet (covers users who signed up before this migration, before
-- their email was allowlisted, or before the household was seeded).
do $$
declare
  target_household_id uuid;
  backfilled integer;
begin
  select h.id into target_household_id from households h limit 1;
  if target_household_id is null then
    raise warning 'member provisioning backfill: no household exists yet — skipped';
    return;
  end if;
  insert into household_members (household_id, user_id, role, is_active)
  select target_household_id, u.id, 'member', true
  from auth.users u
  join allowed_emails a on lower(a.email) = lower(u.email)
  where not exists (
    select 1 from household_members m
    where m.household_id = target_household_id and m.user_id = u.id
  )
  on conflict (household_id, user_id) do nothing;
  get diagnostics backfilled = row_count;
  raise notice 'member provisioning backfill: % member(s) provisioned', backfilled;
end $$;
