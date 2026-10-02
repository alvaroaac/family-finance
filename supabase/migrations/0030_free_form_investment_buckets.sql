-- 0030: free-form investment buckets (caixinhas).
--
-- Buckets used to be one of three fixed slugs (the investment_bucket_slug
-- enum). A household now names its own goals, so the slug becomes text
-- derived from the name: lowercase ASCII words joined by underscores.
--
-- Existing rows keep their slug, name and balance: the three enum labels
-- already satisfy the new format. unique (household_id, slug) and the
-- investment_buckets_member_all policy (for all, household members) are kept
-- as they are, so households can create and delete their own buckets.
--
-- Idempotent: each step checks the current schema before changing it.

do $$ begin
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'investment_buckets'
      and column_name = 'slug'
      and udt_name = 'investment_bucket_slug'
  ) then
    alter table public.investment_buckets
      alter column slug type text using slug::text;
  end if;
end $$;

do $$ begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.investment_buckets'::regclass
      and conname = 'investment_buckets_slug_format'
  ) then
    alter table public.investment_buckets
      add constraint investment_buckets_slug_format
      check (slug ~ '^[a-z0-9]+(_[a-z0-9]+)*$');
  end if;
end $$;

drop type if exists public.investment_bucket_slug;
