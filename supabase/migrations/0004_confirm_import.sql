-- 0004_confirm_import.sql
-- Atomic import confirmation: create the import_batch, bulk-insert the kept
-- transactions linked to that batch, and write the per-row import_rows audit
-- trail — all in ONE transaction.
--
-- Why: the previous `confirmImport` web action inserted one transaction per kept
-- row in a LOOP of separate Supabase calls, created the import_batch only AFTER
-- the rows (so transactions.import_batch_id was never populated), and never wrote
-- the import_rows audit table at all. A partial failure mid-loop left transactions
-- with no batch and no audit record, and the counts on the batch could disagree
-- with what was actually written. A plpgsql function body runs in a single
-- transaction, so either the batch, every kept transaction, AND every audit row
-- persist together or nothing does.
--
-- Contract: the caller (packages/db `confirmImport` repository) validates each
-- selected normalized row into a transaction draft in TypeScript — so the domain
-- rules and the existing per-row error reporting stay in the app/domain, not here.
-- It then passes:
--   * batch_payload  — the same column-keyed import_batches summary the old action
--                      built (source, status, counts, notes, created_by_user_id);
--   * rows_payload    — one object per audit row. A row that produced a transaction
--                      carries a `transaction` object (the transactionInsertFromDraft
--                      payload, WITHOUT import_batch_id — the function fills it from
--                      the batch it inserts) plus the normalized audit fields; an
--                      error/duplicate/skipped row carries only the audit fields
--                      (source_line, occurred_on, amount_cents, description,
--                      error_message, is_duplicate) and no `transaction`.
-- The function inserts the batch, then for each rows_payload entry inserts the
-- transaction (when present) linked via import_batch_id, and an import_rows record
-- linked to the batch and to the produced transaction_id (null for audit-only
-- rows). It returns the stored batch plus the count of transactions written.
--
-- Isolation: SECURITY DEFINER bypasses RLS during the inserts, so household
-- isolation is enforced HERE explicitly instead — the function rejects any payload
-- whose batch / transactions / audit rows are not all scoped to a single household
-- the current auth user is an active member of (via `is_household_member`). This
-- preserves the exact RLS/household-isolation semantics of migration 0001's
-- `import_batches_member_all` / `transactions_member_all` / `import_rows_member_all`
-- policies, which gated each of the individual inserts the old loop issued.
--
-- search_path is pinned to a safe, minimal value so the SECURITY DEFINER body
-- cannot be hijacked by a caller-controlled search_path.

create or replace function confirm_import(
  batch_payload jsonb,
  rows_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  target_household_id uuid := (batch_payload ->> 'household_id')::uuid;
  inserted_batch import_batches;
  row_entry jsonb;
  tx_payload jsonb;
  inserted_tx_id uuid;
  imported_count integer := 0;
begin
  -- Household isolation: SECURITY DEFINER skips RLS, so re-assert membership
  -- exactly as the table policies would have. Rejects cross-household writes.
  if target_household_id is null
     or not is_household_member(target_household_id) then
    raise exception 'confirm_import: not a member of household %',
      target_household_id
      using errcode = '42501'; -- insufficient_privilege
  end if;

  -- Every audit/transaction row must belong to the SAME household as the batch;
  -- refuse a payload that tries to smuggle rows into another household.
  if exists (
    select 1
    from jsonb_array_elements(rows_payload) as entry
    where (entry ->> 'household_id') is distinct from (batch_payload ->> 'household_id')
       or (
         (entry -> 'transaction') is not null
         and (entry -> 'transaction' ->> 'household_id')
               is distinct from (batch_payload ->> 'household_id')
       )
  ) then
    raise exception 'confirm_import: row household_id mismatch'
      using errcode = '22023'; -- invalid_parameter_value
  end if;

  -- Insert the batch summary. Columns mirror migration 0001's import_batches;
  -- id / timestamps fall back to their table defaults. Counts come from the
  -- reviewed preview + the caller's per-row validation (never the raw file).
  insert into import_batches (
    household_id,
    source,
    status,
    total_rows,
    imported_rows,
    duplicate_rows,
    error_rows,
    notes,
    created_by_user_id
  )
  values (
    (batch_payload ->> 'household_id')::uuid,
    (batch_payload ->> 'source')::import_source,
    coalesce((batch_payload ->> 'status')::import_batch_status, 'confirmed'),
    coalesce((batch_payload ->> 'total_rows')::integer, 0),
    coalesce((batch_payload ->> 'imported_rows')::integer, 0),
    coalesce((batch_payload ->> 'duplicate_rows')::integer, 0),
    coalesce((batch_payload ->> 'error_rows')::integer, 0),
    batch_payload ->> 'notes',
    (batch_payload ->> 'created_by_user_id')::uuid
  )
  returning * into inserted_batch;

  -- Walk each row entry IN ORDER. Rows that carry a `transaction` object insert a
  -- transaction linked to this batch; every entry then writes an import_rows audit
  -- record linked to the batch (and to the produced transaction, when any). Any
  -- CHECK / constraint violation aborts the whole transaction, so the batch can
  -- never be left referencing transactions/audit rows that did not all persist.
  for row_entry in select * from jsonb_array_elements(rows_payload)
  loop
    inserted_tx_id := null;
    tx_payload := row_entry -> 'transaction';

    if tx_payload is not null then
      insert into transactions (
        household_id,
        kind,
        amount_cents,
        occurred_on,
        description,
        category_id,
        subcategory_id,
        account_id,
        credit_card_id,
        installment_id,
        responsibility_scope,
        responsible_user_id,
        created_by_user_id,
        import_batch_id
      )
      values (
        (tx_payload ->> 'household_id')::uuid,
        (tx_payload ->> 'kind')::transaction_kind,
        (tx_payload ->> 'amount_cents')::bigint,
        (tx_payload ->> 'occurred_on')::date,
        tx_payload ->> 'description',
        (tx_payload ->> 'category_id')::uuid,
        (tx_payload ->> 'subcategory_id')::uuid,
        (tx_payload ->> 'account_id')::uuid,
        (tx_payload ->> 'credit_card_id')::uuid,
        (tx_payload ->> 'installment_id')::uuid,
        coalesce(
          (tx_payload ->> 'responsibility_scope')::responsibility_scope,
          'household'
        ),
        (tx_payload ->> 'responsible_user_id')::uuid,
        (tx_payload ->> 'created_by_user_id')::uuid,
        -- Link the imported transaction to the batch created above. This is the
        -- column the old action never populated (batch existed only afterwards).
        inserted_batch.id
      )
      returning id into inserted_tx_id;

      imported_count := imported_count + 1;
    end if;

    -- Audit record for this row — normalized fields only, never the raw file.
    insert into import_rows (
      household_id,
      import_batch_id,
      source_line,
      occurred_on,
      amount_cents,
      description,
      error_message,
      is_duplicate,
      transaction_id
    )
    values (
      inserted_batch.household_id,
      inserted_batch.id,
      (row_entry ->> 'source_line')::integer,
      (row_entry ->> 'occurred_on')::date,
      (row_entry ->> 'amount_cents')::bigint,
      row_entry ->> 'description',
      row_entry ->> 'error_message',
      coalesce((row_entry ->> 'is_duplicate')::boolean, false),
      inserted_tx_id
    );
  end loop;

  return jsonb_build_object(
    'batch', to_jsonb(inserted_batch),
    'imported_rows', imported_count
  );
end;
$$;

-- Lock down execution to the same principals the table policies serve. anon is
-- intentionally excluded; authenticated callers still pass through the explicit
-- is_household_member() gate above. The grant is guarded so this migration also
-- runs on a plain Postgres for review, where Supabase's `authenticated` role is
-- absent (mirrors 0001's defensive blocks).
revoke all on function confirm_import(jsonb, jsonb) from public;
do $$ begin
  grant execute on function confirm_import(jsonb, jsonb)
    to authenticated;
exception when undefined_object then null; end $$;
