-- 0010: household_members was SELECT-only under RLS, so the Configurações
-- member form silently updated zero rows. Family trust model (spec §2.3):
-- any active member can edit member profiles of their own household.
drop policy if exists household_members_update on household_members;
create policy household_members_update on household_members
  for update
  using (is_household_member(household_id))
  with check (is_household_member(household_id));

-- Telegram @username as a friendlier alternative to the numeric id. Stored
-- lowercase without the "@"; the bot matches update.from.username against it
-- and back-fills telegram_user_id on first contact (ids are the stable key).
alter table household_members
  add column telegram_username text unique
  check (telegram_username = lower(telegram_username));
