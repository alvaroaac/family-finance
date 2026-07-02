-- 0007: household member profile fields + caixinha manual balances (spec v1.0 §2.4/§2.5)
alter table household_members
  add column display_name text,
  add column telegram_user_id bigint unique;

alter table investment_buckets
  add column balance_cents bigint not null default 0 check (balance_cents >= 0);
