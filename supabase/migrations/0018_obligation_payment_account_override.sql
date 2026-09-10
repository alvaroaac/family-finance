-- 0018_obligation_payment_account_override.sql
-- Allow a payment to use an explicitly named account without changing the
-- obligation template's default account. Calls that omit the override retain
-- the existing default behavior through the four-argument compatibility RPC.

create or replace function materialize_obligation_payment(
  target_obligation_id uuid,
  target_month text,
  paid_on date,
  target_amount_cents bigint,
  target_account_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  obligation obligations;
  month_start date;
  end_month_start date;
  effective_paid_on date;
  effective_amount_cents bigint;
  effective_account_id uuid;
  inserted transactions;
  existing transactions;
begin
  if target_month is null or target_month !~ '^\d{4}-(0[1-9]|1[0-2])$' then
    raise exception 'materialize_obligation_payment: invalid month %', target_month
      using errcode = '22023';
  end if;
  if target_amount_cents is not null and target_amount_cents <= 0 then
    raise exception 'materialize_obligation_payment: actual amount must be positive'
      using errcode = '22023';
  end if;

  select * into obligation from obligations where id = target_obligation_id;
  if obligation.id is null
     or (auth.uid() is not null
         and not is_household_member(obligation.household_id)) then
    raise exception 'materialize_obligation_payment: obligation % not found',
      target_obligation_id using errcode = '22023';
  end if;
  if obligation.status <> 'active' then
    raise exception 'materialize_obligation_payment: obligation % is %',
      target_obligation_id, obligation.status using errcode = '22023';
  end if;

  if target_account_id is not null and not exists (
    select 1 from accounts
    where id = target_account_id
      and household_id = obligation.household_id
  ) then
    raise exception 'materialize_obligation_payment: account % not found in obligation household',
      target_account_id using errcode = '22023';
  end if;

  month_start := to_date(target_month || '-01', 'YYYY-MM-DD');
  if month_start < to_date(obligation.start_month || '-01', 'YYYY-MM-DD') then
    raise exception 'materialize_obligation_payment: month % precedes start %',
      target_month, obligation.start_month using errcode = '22023';
  end if;
  if obligation.term_months is not null then
    end_month_start :=
      to_date(obligation.start_month || '-01', 'YYYY-MM-DD')
      + make_interval(months => obligation.term_months - 1);
    if month_start > end_month_start then
      raise exception 'materialize_obligation_payment: month % is after the % -month term',
        target_month, obligation.term_months using errcode = '22023';
    end if;
  end if;

  effective_paid_on := coalesce(
    paid_on,
    month_start + (obligation.due_day - 1)
  );
  effective_amount_cents := coalesce(
    target_amount_cents,
    obligation.amount_cents
  );
  effective_account_id := coalesce(
    target_account_id,
    obligation.account_id
  );

  insert into transactions (
    household_id, kind, amount_cents, occurred_on, description,
    category_id, subcategory_id, account_id, credit_card_id,
    responsibility_scope, responsible_user_id, created_by_user_id,
    obligation_id, obligation_month
  ) values (
    obligation.household_id, 'expense', effective_amount_cents,
    effective_paid_on, obligation.description, obligation.category_id,
    obligation.subcategory_id, effective_account_id, null,
    obligation.responsibility_scope, obligation.responsible_user_id,
    coalesce(auth.uid(), obligation.created_by_user_id),
    obligation.id, month_start
  )
  on conflict (obligation_id, obligation_month)
    where obligation_id is not null
    do nothing
  returning * into inserted;

  if inserted.id is null then
    select * into existing from transactions
    where obligation_id = obligation.id and obligation_month = month_start;
    return jsonb_build_object(
      'transaction', to_jsonb(existing),
      'already_paid', true
    );
  end if;

  return jsonb_build_object(
    'transaction', to_jsonb(inserted),
    'already_paid', false
  );
end;
$$;

-- Preserve callers deployed before this migration. They retain the template
-- account because the compatibility overload passes no account override.
create or replace function materialize_obligation_payment(
  target_obligation_id uuid,
  target_month text,
  paid_on date,
  target_amount_cents bigint
)
returns jsonb
language sql
security definer
set search_path = public, pg_temp
as $$
  select materialize_obligation_payment(
    target_obligation_id,
    target_month,
    paid_on,
    target_amount_cents,
    null
  );
$$;

revoke all on function materialize_obligation_payment(uuid, text, date, bigint, uuid)
  from public;
revoke all on function materialize_obligation_payment(uuid, text, date, bigint)
  from public;
do $$ begin
  revoke all on function materialize_obligation_payment(uuid, text, date, bigint, uuid)
    from anon;
  revoke all on function materialize_obligation_payment(uuid, text, date, bigint)
    from anon;
  grant execute on function materialize_obligation_payment(uuid, text, date, bigint, uuid)
    to authenticated, service_role;
  grant execute on function materialize_obligation_payment(uuid, text, date, bigint)
    to authenticated, service_role;
exception when undefined_object then null; end $$;
