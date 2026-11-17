-- Configure the resource once during activation, then enable this GoTrue hook.
create table if not exists agent_import.oauth_config(singleton boolean primary key default true check(singleton),resource text not null check(resource ~ '^https?://'));
revoke all on agent_import.oauth_config from public,anon,authenticated,ff_import_app;
create or replace function public.agent_import_access_token_hook(event jsonb) returns jsonb
language plpgsql stable security definer set search_path=public,pg_temp as $$
declare claims jsonb:=event->'claims'; resource_name text; client text:=event->'claims'->>'client_id';
begin
 if client is null then return event; end if;
 select resource into resource_name from agent_import.oauth_config where singleton;
 if resource_name is null then raise exception 'Agent OAuth resource not configured'; end if;
 -- Subject is the existing GoTrue user, never an email supplied by a client.
 -- The API also checks the live grant on every operation, so revocation is immediate.
 if exists(select 1 from agent_import.client_grants g join public.household_members m on m.household_id=g.household_id and m.user_id=g.user_id and m.is_active where g.user_id=(event->>'user_id')::uuid and g.client_id=client and g.revoked_at is null) then
  claims:=jsonb_set(claims,'{aud}',jsonb_build_array('authenticated',resource_name));
 end if;
 return jsonb_set(event,'{claims}',claims);
end $$;
revoke all on function public.agent_import_access_token_hook(jsonb) from public,anon,authenticated,service_role,ff_import_app;
do $$ begin if exists(select 1 from pg_roles where rolname='supabase_auth_admin') then
 grant execute on function public.agent_import_access_token_hook(jsonb) to supabase_auth_admin;
end if; end $$;
