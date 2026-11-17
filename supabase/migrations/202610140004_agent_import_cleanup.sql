-- Invoke from a privileged maintenance scheduler every five minutes.
-- No application, anon, authenticated or service-role caller can execute it.
create or replace function agent_import.prune_expired() returns void
language plpgsql security definer set search_path=pg_catalog,agent_import as $$
begin
 delete from agent_import.events where draft_id in (
  select id from agent_import.drafts where state='cancelled' or (state<>'committed' and expires_at<now()-interval '24 hours')
 );
 delete from agent_import.approvals where expires_at<now();
 update agent_import.operations o set result=jsonb_build_object('import_id',d.id,'state',case when d.state='cancelled' then 'cancelled' else 'expired' end,'payload_removed',true)
 from agent_import.drafts d where o.result->>'import_id'=d.id::text and (d.state='cancelled' or (d.state<>'committed' and d.expires_at<now()-interval '24 hours')) and not (o.result ? 'payload_removed');
 update agent_import.drafts set state='expired',payload=payload||'{"state":"expired","rows":[],"sources":[],"warnings":[]}'::jsonb
 where state not in ('committed','cancelled') and expires_at<now()-interval '24 hours' and (payload->'rows'<>'[]'::jsonb or payload->'sources'<>'[]'::jsonb);
end $$;
revoke all on function agent_import.prune_expired() from public,anon,authenticated,service_role,ff_import_app;
