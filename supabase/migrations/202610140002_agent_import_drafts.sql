-- Server-only access uses a dedicated LOGIN without superuser or BYPASSRLS.
-- Provision its password separately; never use postgres/service_role at runtime.
do $$ begin
  if not exists (select 1 from pg_roles where rolname='ff_import_app') then
    create role ff_import_app login inherit nosuperuser nocreatedb nocreaterole nobypassrls;
  end if;
end $$;
grant authenticated to ff_import_app;
create schema if not exists agent_import;
revoke all on schema agent_import from public, anon, authenticated;
grant usage on schema agent_import to ff_import_app;

create table if not exists agent_import.lineages (
 id uuid primary key, household_id uuid not null references public.households(id),
 user_id uuid not null references auth.users(id), committed_draft_id uuid,
 unique(id,household_id,user_id)
);
create table if not exists agent_import.drafts (
 id uuid primary key, lineage_id uuid not null, household_id uuid not null, user_id uuid not null,
 revision integer not null check(revision>0), state text not null check(state in ('collecting','review','committed','cancelled','expired')),
 expires_at timestamptz not null, payload jsonb not null, updated_at timestamptz not null default now(),
 foreign key(lineage_id,household_id,user_id) references agent_import.lineages(id,household_id,user_id),
 unique(id,household_id,user_id)
);
create table if not exists agent_import.operations (
 household_id uuid not null references public.households(id), user_id uuid not null references auth.users(id),
 operation_key text not null, request_hash text not null, result jsonb not null, created_at timestamptz not null default now(),
 primary key(household_id,user_id,operation_key)
);
create table if not exists agent_import.approvals (
 draft_id uuid primary key, household_id uuid not null, user_id uuid not null, revision integer not null,
 payload_hash text not null, challenge_hash text not null, expires_at timestamptz not null,
 approved_at timestamptz, consumed_at timestamptz,
 foreign key(draft_id,household_id,user_id) references agent_import.drafts(id,household_id,user_id)
);
create table if not exists agent_import.events (
 id bigint generated always as identity primary key, draft_id uuid not null, household_id uuid not null,user_id uuid not null,
 revision integer not null, client_id text not null, changes jsonb not null, created_at timestamptz not null default now(),
 foreign key(draft_id,household_id,user_id) references agent_import.drafts(id,household_id,user_id)
);
create table if not exists agent_import.client_grants (
 household_id uuid not null references public.households(id), user_id uuid not null references auth.users(id),
 client_id text not null, scopes text[] not null, revoked_at timestamptz, created_at timestamptz not null default now(),
 primary key(household_id,user_id,client_id),
 check(scopes <@ array['finance:context:read','imports:read','imports:prepare','imports:commit']::text[])
);
create table if not exists agent_import.source_mappings (
 id uuid primary key default gen_random_uuid(),household_id uuid not null references public.households(id),
 namespace text not null,normalized_label text not null,row_kind text not null check(row_kind in ('expense','income')),
 category_id uuid,subcategory_id uuid,suppress boolean not null default false,
 foreign key(category_id,household_id) references public.categories(id,household_id),
 foreign key(subcategory_id,household_id) references public.subcategories(id,household_id),
 unique(household_id,namespace,normalized_label,row_kind)
);
do $$ declare t text; begin
 foreach t in array array['lineages','drafts','operations','approvals','events','client_grants'] loop
  execute format('alter table agent_import.%I enable row level security',t);
  execute format('alter table agent_import.%I force row level security',t);
  execute format('drop policy if exists owner_scope on agent_import.%I',t);
  execute format('create policy owner_scope on agent_import.%I to ff_import_app using (user_id=auth.uid() and public.is_household_member(household_id)) with check (user_id=auth.uid() and public.is_household_member(household_id))',t);
 end loop;
end $$;
alter table agent_import.source_mappings enable row level security;
alter table agent_import.source_mappings force row level security;
drop policy if exists household_scope on agent_import.source_mappings;
create policy household_scope on agent_import.source_mappings to ff_import_app using(public.is_household_member(household_id)) with check(public.is_household_member(household_id));
grant select,insert,update,delete on all tables in schema agent_import to ff_import_app;
grant usage,select on all sequences in schema agent_import to ff_import_app;
create index if not exists drafts_expiry on agent_import.drafts(expires_at) where state not in ('committed','cancelled');

-- OAuth access tokens are deliberately NOT general-purpose PostgREST sessions.
-- The server uses verified identity with RLS through ff_import_app instead.
-- This blocks legacy RPCs and direct financial writes that bypass review.
create or replace function public.reject_direct_oauth_access() returns void
language plpgsql set search_path=pg_catalog as $$
begin
 if nullif(current_setting('request.jwt.claims',true),'')::jsonb ->> 'client_id' is not null then
  raise sqlstate '42501' using message='OAuth clients must use the scoped import API';
 end if;
end $$;
revoke all on function public.reject_direct_oauth_access() from public;
grant execute on function public.reject_direct_oauth_access() to anon,authenticated,service_role;
do $$ begin if exists(select 1 from pg_roles where rolname='authenticator') then
 alter role authenticator set pgrst.db_pre_request='public.reject_direct_oauth_access';
end if; end $$;
notify pgrst, 'reload config';
