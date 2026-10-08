-- Run after 202610080004 in the disposable migration database.
begin;

do $$
declare
  a uuid := 'a0000000-0000-0000-0000-000000000001';
  b uuid := 'b0000000-0000-0000-0000-000000000001';
  a_user uuid := 'a0000000-0000-0000-0000-000000000002';
  b_user uuid := 'b0000000-0000-0000-0000-000000000002';
  a_account uuid := 'a0000000-0000-0000-0000-000000000003';
  b_account uuid := 'b0000000-0000-0000-0000-000000000003';
  a_card uuid := 'a0000000-0000-0000-0000-000000000004';
  a_group uuid := 'a0000000-0000-0000-0000-000000000005';
  a_obligation uuid := 'a0000000-0000-0000-0000-000000000006';
  a_batch uuid := 'a0000000-0000-0000-0000-000000000007';
  a_imported uuid := 'a0000000-0000-0000-0000-000000000008';
  a_replaced uuid := 'a0000000-0000-0000-0000-000000000009';
begin
  insert into households (id, name) values (a, 'To delete'), (b, 'To keep');
  insert into allowed_emails (email, household_id) values
    ('delete-household@example.test', a),
    ('keep-household@example.test', b);
  insert into auth.users (id, email, email_confirmed_at) values
    (a_user, 'delete-household@example.test', now()),
    (b_user, 'keep-household@example.test', now());
  insert into accounts (id, household_id, kind, name) values
    (a_account, a, 'checking', 'Account A'),
    (b_account, b, 'checking', 'Account B');
  insert into credit_cards (id, household_id, name) values
    (a_card, a, 'Card A');
  insert into transactions
    (household_id, kind, amount_cents, occurred_on, description,
     account_id, credit_card_id, created_by_user_id) values
    (a, 'expense', 100, '2026-09-01', 'Account purchase', a_account, null, a_user),
    (a, 'expense', 200, '2026-09-02', 'Card purchase', null, a_card, a_user),
    (b, 'expense', 300, '2026-09-03', 'Kept purchase', b_account, null, b_user);
  insert into installment_groups
    (id, household_id, credit_card_id, description, total_amount_cents,
     installment_count, purchased_on, created_by_user_id)
    values (a_group, a, a_card, 'Installment purchase', 400, 2,
            '2026-09-01', a_user);
  insert into installments
    (household_id, installment_group_id, credit_card_id, number,
     installment_count, amount_cents, due_month, description, created_by_user_id)
    values
    (a, a_group, a_card, 1, 2, 200, '2026-09', 'Installment 1', a_user),
    (a, a_group, a_card, 2, 2, 200, '2026-10', 'Installment 2', a_user);
  insert into obligations
    (id, household_id, description, amount_cents, start_month, due_day,
     account_id, created_by_user_id)
    values (a_obligation, a, 'Monthly bill', 500, '2026-09', 10,
            a_account, a_user);
  insert into transactions
    (household_id, kind, amount_cents, occurred_on, description,
     account_id, obligation_id, obligation_month, created_by_user_id)
    values (a, 'expense', 500, '2026-09-10', 'Bill payment',
            a_account, a_obligation, '2026-09-01', a_user);
  insert into investment_buckets (household_id, slug, name, balance_cents)
    values (a, 'goal_a', 'Goal A', 100), (b, 'goal_b', 'Goal B', 200);
  -- Import records reference batches, transactions and installment groups
  -- with "on delete restrict", which is the case a cascade can trip on.
  insert into import_batches (id, household_id, source, created_by_user_id)
    values (a_batch, a, 'nubank_csv', a_user);
  insert into transactions
    (id, household_id, kind, amount_cents, occurred_on, description,
     account_id, created_by_user_id)
    values (a_imported, a, 'expense', 600, '2026-09-04', 'Imported purchase',
            a_account, a_user);
  insert into import_rows (household_id, import_batch_id, transaction_id)
    values (a, a_batch, a_imported);
  insert into import_item_claims
    (household_id, source, fingerprint_version, base_fingerprint,
     occurrence_no, artifact_kind, import_batch_id, transaction_id)
    values (a, 'nubank_csv', 1, repeat('a', 64), 1, 'transaction',
            a_batch, a_imported);
  insert into import_transaction_replacements
    (original_transaction_id, household_id, import_batch_id,
     installment_group_id, original_record, replaced_by)
    values (a_replaced, a, a_batch, a_group, '{}'::jsonb, a_user);
end $$;

create temporary table counts_before on commit drop as
  select c.table_name::text, 0::bigint as kept_rows
  from information_schema.columns c
  join information_schema.tables t using (table_schema, table_name)
  where c.table_schema = 'public' and c.column_name = 'household_id'
    and t.table_type = 'BASE TABLE';

do $$
declare
  scoped record;
begin
  for scoped in select table_name from counts_before loop
    execute format(
      'update counts_before set kept_rows = (select count(*) from %I where household_id = $1) where table_name = $2',
      scoped.table_name)
      using 'b0000000-0000-0000-0000-000000000001'::uuid, scoped.table_name;
  end loop;
end $$;

\set household_id 'a0000000-0000-0000-0000-000000000001'
delete from households where id = :'household_id';

do $$
declare
  scoped record;
  count_a bigint;
  count_b bigint;
begin
  if exists (select 1 from households
             where id = 'a0000000-0000-0000-0000-000000000001') then
    raise exception 'household A was not deleted';
  end if;
  if not exists (select 1 from households
                 where id = 'b0000000-0000-0000-0000-000000000001') then
    raise exception 'household B was deleted';
  end if;
  for scoped in select table_name, kept_rows from counts_before loop
    execute format('select count(*) from %I where household_id = $1',
      scoped.table_name)
      into count_a using 'a0000000-0000-0000-0000-000000000001'::uuid;
    execute format('select count(*) from %I where household_id = $1',
      scoped.table_name)
      into count_b using 'b0000000-0000-0000-0000-000000000001'::uuid;
    if count_a <> 0 or count_b <> scoped.kept_rows then
      raise exception '% deletion/isolation failed: A %, B % (expected %)',
        scoped.table_name, count_a, count_b, scoped.kept_rows;
    end if;
  end loop;
end $$;

rollback;
