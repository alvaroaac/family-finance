-- allowlisted-email auto-provisioning into household "casa" (spec §4.1)
create table allowed_emails (
  email text primary key,
  household_slug text not null default 'casa'
);
alter table allowed_emails enable row level security; -- no policies: service/definer only

insert into allowed_emails (email) values
  ('alvaro.a.a.a.c@gmail.com');
-- NOTE: add Karol's dotted-form Gmail before prod deploy (runbook step) — not known at migration time.

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
    if target_household_id is not null then
      insert into household_members (household_id, user_id, role, is_active)
      values (target_household_id, new.id, 'member', true)
      on conflict (household_id, user_id) do nothing;
    end if;
  end if;
  return new;
end;
$$;

create trigger provision_member_on_signup
  after insert on auth.users
  for each row execute function provision_household_member();
