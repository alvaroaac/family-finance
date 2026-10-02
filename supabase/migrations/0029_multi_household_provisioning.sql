-- Reject ambiguous legacy allowlists before changing any schema or data.
do $$
declare
  unassigned boolean;
begin
  if (select count(*) from households) <= 1 then
    return;
  end if;
  if exists (select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'allowed_emails' and column_name = 'household_id') then
    execute 'select exists (select 1 from allowed_emails where household_id is null)' into unassigned;
  else
    select exists (select 1 from allowed_emails) into unassigned;
  end if;
  if unassigned then
    raise exception 'ambiguous allowed_emails backfill: multiple households exist';
  end if;
end $$;

alter table allowed_emails add column if not exists household_id uuid;

do $$
declare
  household_count integer;
  removed_count integer;
  only_household_id uuid;
begin
  select count(*) into household_count from households;
  if household_count = 0 then
    delete from allowed_emails where household_id is null;
    get diagnostics removed_count = row_count;
    if removed_count > 0 then
      raise notice 'allowed_emails: deleted % unassigned row(s) because no household exists', removed_count;
    end if;
  elsif household_count = 1 then
    select id into only_household_id from households;
    update allowed_emails set household_id = only_household_id where household_id is null;
  end if;
end $$;

alter table allowed_emails alter column household_id set not null;
do $$ begin
  if not exists (select 1 from pg_constraint
    where conrelid = 'public.allowed_emails'::regclass
      and conname = 'allowed_emails_household_id_fkey') then
    alter table allowed_emails add constraint allowed_emails_household_id_fkey
      foreign key (household_id) references households(id) on delete cascade;
  end if;
end $$;
alter table allowed_emails drop column if exists household_slug;

-- The triggers match emails case-insensitively, so two rows differing only in
-- case could point one person at two households.
create unique index if not exists allowed_emails_email_lower_key
  on allowed_emails (lower(email));

do $$ begin
  if not exists (select 1 from pg_constraint
    where conrelid = 'public.household_members'::regclass
      and conname = 'household_members_user_id_key') then
    alter table household_members add constraint household_members_user_id_key unique (user_id);
  end if;
end $$;

alter table households add column if not exists theme jsonb;
alter table households alter column theme set default '{"base":"esmeralda"}'::jsonb;
update households set theme = '{"base":"esmeralda"}'::jsonb where theme is null;
alter table households alter column theme set not null;

create or replace function provision_household_member()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  target_household_id uuid;
begin
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

create or replace function provision_on_allowlist()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  existing_user record;
begin
  for existing_user in select u.id from auth.users u where lower(u.email) = lower(new.email) loop
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
