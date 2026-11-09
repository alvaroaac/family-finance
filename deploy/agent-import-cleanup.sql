-- Run only against the intended environment via the approved maintenance role.
-- Schedule every five minutes. Does not remove committed import evidence/history.
\set ON_ERROR_STOP on
begin;
select agent_import.prune_expired();
commit;
