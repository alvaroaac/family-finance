-- 0011_create_obligations.sql
-- Recurring fixed obligations (financings, mortgage, bills) as TEMPLATES.
--
-- Model (design: thoughts/features/recurring-obligations/design.md):
--   * One `obligations` row is the source of truth: monthly amount, start
--     month, term (fixed count or null = indefinite), due day, category,
--     responsibility, payment account. No rows are materialized up front —
--     the dashboard computes projections from the template.
--   * Marking a month paid MATERIALIZES one real `transactions` row for that
--     month (kind = expense, from the payment account) linked back to the
--     obligation via `obligation_id` + `obligation_month`. That month then
--     shows the actual and the projection is suppressed (anti-double-count).
--   * The unique partial index on (obligation_id, obligation_month) makes
--     materialization idempotent: a repeated "marcar como pago" is a no-op,
--     never a second charge.
--
-- Numbering: 0010 is reserved by the concurrent feat/family-finance-mvp
-- branch; this migration intentionally takes 0011.

-- ---------------------------------------------------------------------------
-- Status enum + table.
-- ---------------------------------------------------------------------------

do $$ begin
  create type obligation_status as enum ('active', 'ended', 'canceled');
exception when duplicate_object then null; end $$;

create table if not exists obligations (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households (id) on delete cascade,
  description text not null,
  -- Monthly amount in integer BRL cents. Positive; kind is always expense.
  amount_cents bigint not null check (amount_cents > 0),
  -- First month due, as `YYYY-MM` (same month-attribution grain as
  -- installments.due_month).
  start_month text not null check (start_month ~ '^\d{4}-(0[1-9]|1[0-2])$'),
  -- Fixed term in months (72 = solar financing) or null = indefinite (bills).
  term_months integer check (term_months is null or term_months > 0),
  -- Day of month the payment is due; 1-28 keeps every month valid (consistent
  -- with credit_cards.closing_day usage in the domain).
  due_day integer not null check (due_day between 1 and 28),
  category_id uuid references categories (id) on delete set null,
  subcategory_id uuid references subcategories (id) on delete set null,
  responsibility_scope responsibility_scope not null default 'household',
  responsible_user_id uuid references auth.users (id) on delete set null,
  -- Payment source: obligations are account-paid (boleto/débito), never
  -- card-bound — that is what distinguishes them from card installments.
  account_id uuid not null references accounts (id) on delete restrict,
  status obligation_status not null default 'active',
  created_by_user_id uuid not null references auth.users (id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (
    (responsibility_scope = 'user' and responsible_user_id is not null)
    or (responsibility_scope = 'household' and responsible_user_id is null)
  )
);

create index if not exists obligations_household_idx
  on obligations (household_id);

-- RLS: identical policy to every household-scoped table in 0001.
alter table obligations enable row level security;
drop policy if exists obligations_member_all on obligations;
create policy obligations_member_all on obligations
  for all using (is_household_member(household_id))
  with check (is_household_member(household_id));

-- ---------------------------------------------------------------------------
-- Transactions link columns + anti-double-pay index.
-- Mirrors the existing `installment_id` nullable-FK precedent.
-- ---------------------------------------------------------------------------

alter table transactions
  add column if not exists obligation_id uuid
    references obligations (id) on delete set null,
  -- First day of the satisfied month (a date so range queries stay cheap).
  add column if not exists obligation_month date;

-- A month can be paid at most once per obligation. This is the idempotency
-- backbone of materialize_obligation_payment.
create unique index if not exists transactions_obligation_month_uniq
  on transactions (obligation_id, obligation_month)
  where obligation_id is not null;

-- ---------------------------------------------------------------------------
-- Atomic, idempotent materialization RPC.
--
-- Mirrors 0002's pattern: SECURITY DEFINER bypasses RLS, so household
-- membership is re-asserted explicitly via is_household_member. search_path is
-- pinned so the body cannot be hijacked by a caller-controlled search_path.
--
-- `paid_on` override: the bot passes the message send date; the dashboard
-- omits it and gets the month's due date (month + due_day).
-- ---------------------------------------------------------------------------

create or replace function materialize_obligation_payment(
  target_obligation_id uuid,
  target_month text,
  paid_on date default null
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
  inserted transactions;
  existing transactions;
  already_paid boolean := false;
begin
  if target_month is null or target_month !~ '^\d{4}-(0[1-9]|1[0-2])$' then
    raise exception 'materialize_obligation_payment: invalid month %', target_month
      using errcode = '22023'; -- invalid_parameter_value
  end if;

  select * into obligation
  from obligations
  where id = target_obligation_id;

  -- Household isolation: SECURITY DEFINER skips RLS, so re-assert membership
  -- exactly as the table policies would have (the bot's service_role client
  -- bypasses RLS anyway — auth.uid() is null there). A non-member gets the
  -- SAME 'not found' error as a nonexistent id, and no household_id is ever
  -- echoed: distinguishable errors would let any authenticated user probe
  -- foreign obligation ids for existence/ownership that RLS hides.
  if obligation.id is null
     or (auth.uid() is not null
         and not is_household_member(obligation.household_id)) then
    raise exception 'materialize_obligation_payment: obligation % not found',
      target_obligation_id
      using errcode = '22023';
  end if;

  if obligation.status <> 'active' then
    raise exception 'materialize_obligation_payment: obligation % is %',
      target_obligation_id, obligation.status
      using errcode = '22023';
  end if;

  month_start := to_date(target_month || '-01', 'YYYY-MM-DD');

  -- The month must fall inside [start_month, end_month].
  if month_start < to_date(obligation.start_month || '-01', 'YYYY-MM-DD') then
    raise exception 'materialize_obligation_payment: month % precedes start %',
      target_month, obligation.start_month
      using errcode = '22023';
  end if;
  if obligation.term_months is not null then
    end_month_start :=
      to_date(obligation.start_month || '-01', 'YYYY-MM-DD')
      + make_interval(months => obligation.term_months - 1);
    if month_start > end_month_start then
      raise exception 'materialize_obligation_payment: month % is after the % -month term',
        target_month, obligation.term_months
        using errcode = '22023';
    end if;
  end if;

  -- Dashboard default: the month's due date. Bot override: the send date.
  effective_paid_on := coalesce(
    paid_on,
    month_start + (obligation.due_day - 1)
  );

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
    responsibility_scope,
    responsible_user_id,
    -- auth.uid() when a web user calls this; the obligation's creator when the
    -- bot's service_role client does (there is no auth user in that context).
    created_by_user_id,
    obligation_id,
    obligation_month
  )
  values (
    obligation.household_id,
    'expense',
    obligation.amount_cents,
    effective_paid_on,
    obligation.description,
    obligation.category_id,
    obligation.subcategory_id,
    obligation.account_id,
    null,
    obligation.responsibility_scope,
    obligation.responsible_user_id,
    coalesce(auth.uid(), obligation.created_by_user_id),
    obligation.id,
    month_start
  )
  on conflict (obligation_id, obligation_month)
    where obligation_id is not null
    do nothing
  returning * into inserted;

  if inserted.id is null then
    -- Unique index hit: the month was already materialized. Idempotent no-op.
    already_paid := true;
    select * into existing
    from transactions
    where obligation_id = obligation.id
      and obligation_month = month_start;
    return jsonb_build_object(
      'transaction', to_jsonb(existing),
      'already_paid', already_paid
    );
  end if;

  return jsonb_build_object(
    'transaction', to_jsonb(inserted),
    'already_paid', already_paid
  );
end;
$$;

-- Same execution surface as 0002: no public/anon execution; authenticated
-- callers pass through the explicit membership gate above. Guarded so the
-- migration also runs on a plain Postgres without Supabase's roles.
revoke all on function materialize_obligation_payment(uuid, text, date) from public;
do $$ begin
  grant execute on function materialize_obligation_payment(uuid, text, date)
    to authenticated;
exception when undefined_object then null; end $$;
