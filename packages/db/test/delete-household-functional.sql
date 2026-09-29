-- Run after 0032 in the disposable migration database.
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
end $$;

\set household_id 'a0000000-0000-0000-0000-000000000001'
delete from households where id = :'household_id';

do $$
declare
  table_name text;
  count_a bigint;
  count_b bigint;
  expected_b bigint;
begin
  for table_name in select unnest(array[
    'households', 'allowed_emails', 'household_members', 'accounts',
    'credit_cards', 'transactions', 'installment_groups', 'installments',
    'obligations', 'investment_buckets'
  ]) loop
    execute format('select count(*) from %I where %I = $1', table_name,
      case when table_name = 'households' then 'id' else 'household_id' end)
      into count_a using 'a0000000-0000-0000-0000-000000000001'::uuid;
    execute format('select count(*) from %I where %I = $1', table_name,
      case when table_name = 'households' then 'id' else 'household_id' end)
      into count_b using 'b0000000-0000-0000-0000-000000000001'::uuid;
    expected_b := case when table_name in
      ('credit_cards', 'installment_groups', 'installments', 'obligations')
      then 0 else 1 end;
    if count_a <> 0 or count_b <> expected_b then
      raise exception '% deletion/isolation failed: A %, B %',
        table_name, count_a, count_b;
    end if;
  end loop;
end $$;

rollback;
