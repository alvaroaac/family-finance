-- 0003_merge_category.sql
-- Atomic category merge: re-point every transaction, installment group,
-- installment, subcategory, and categorization_memory row from a source macro
-- category onto a target, then archive the now-empty source — all in ONE
-- transaction.
--
-- Why: the previous `mergeCategory` repository ran the four re-points + the
-- subcategory move + the memory move + the source archive as a SEQUENCE of
-- separate Supabase calls. Supabase JS has no client-side transaction, so a
-- failure mid-sequence left a PARTIAL merge — some rows pointing at the target,
-- the source still active (or vice versa). A plpgsql function body runs in a
-- single transaction, so either every re-point AND the archive persist together
-- or nothing does.
--
-- Contract: the caller passes the same household + source/target ids the
-- repository already validates (source <> target is checked client-side and
-- re-asserted here). The function returns a small jsonb summary of how many rows
-- moved per table plus the archived source row, so the repository keeps its
-- existing void contract while a verifier can still assert the merge happened.
--
-- Isolation: SECURITY DEFINER bypasses RLS during the updates, so household
-- isolation is enforced HERE explicitly instead — the function rejects any call
-- whose household the current auth user is not an active member of (via
-- `is_household_member`). This preserves the exact RLS/household-isolation
-- semantics of migration 0001's `*_member_all` policies, which gated each of the
-- individual UPDATEs the old sequence issued.
--
-- search_path is pinned to a safe, minimal value so the SECURITY DEFINER body
-- cannot be hijacked by a caller-controlled search_path.

create or replace function merge_category(
  target_household_id uuid,
  source_category_id uuid,
  target_category_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  archived_source categories;
  moved_transactions integer;
  moved_installment_groups integer;
  moved_installments integer;
  moved_subcategories integer;
  moved_memory integer;
begin
  -- Source and target must differ — mirrors the repository's guard so the rule
  -- holds even if a future caller skips it.
  if source_category_id = target_category_id then
    raise exception 'merge_category: source and target must differ'
      using errcode = '22023'; -- invalid_parameter_value
  end if;

  -- Household isolation: SECURITY DEFINER skips RLS, so re-assert membership
  -- exactly as the table policies would have. Rejects cross-household merges.
  if target_household_id is null
     or not is_household_member(target_household_id) then
    raise exception 'merge_category: not a member of household %',
      target_household_id
      using errcode = '42501'; -- insufficient_privilege
  end if;

  -- Re-point every row that referenced the source category onto the target.
  -- Each UPDATE is household-scoped, matching the old sequence's `.eq` filters.
  update transactions
    set category_id = target_category_id
    where household_id = target_household_id
      and category_id = source_category_id;
  get diagnostics moved_transactions = row_count;

  update installment_groups
    set category_id = target_category_id
    where household_id = target_household_id
      and category_id = source_category_id;
  get diagnostics moved_installment_groups = row_count;

  update installments
    set category_id = target_category_id
    where household_id = target_household_id
      and category_id = source_category_id;
  get diagnostics moved_installments = row_count;

  -- Move subcategories under the target macro category.
  update subcategories
    set category_id = target_category_id
    where household_id = target_household_id
      and category_id = source_category_id;
  get diagnostics moved_subcategories = row_count;

  -- Re-point memory entries so learned patterns follow the merge.
  update categorization_memory
    set category_id = target_category_id
    where household_id = target_household_id
      and category_id = source_category_id;
  get diagnostics moved_memory = row_count;

  -- Archive (soft-delete) the now-empty source — same effect as the old
  -- `archiveCategory` tail of the sequence. Scoped to the household.
  update categories
    set is_active = false
    where household_id = target_household_id
      and id = source_category_id
    returning * into archived_source;

  return jsonb_build_object(
    'source', to_jsonb(archived_source),
    'moved', jsonb_build_object(
      'transactions', moved_transactions,
      'installment_groups', moved_installment_groups,
      'installments', moved_installments,
      'subcategories', moved_subcategories,
      'categorization_memory', moved_memory
    )
  );
end;
$$;

-- Lock down execution to the same principals the table policies serve. anon is
-- intentionally excluded; authenticated callers still pass through the explicit
-- is_household_member() gate above. The grant is guarded so this migration also
-- runs on a plain Postgres for review, where Supabase's `authenticated` role is
-- absent (mirrors 0001's defensive blocks).
revoke all on function merge_category(uuid, uuid, uuid) from public;
do $$ begin
  grant execute on function merge_category(uuid, uuid, uuid)
    to authenticated;
exception when undefined_object then null; end $$;
