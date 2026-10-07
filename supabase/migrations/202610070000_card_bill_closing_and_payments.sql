-- Stored invoice attribution freezes which fatura receives a charge. Payments
-- remain transfers, with a caller key instead of a one-payment-per-month limit.
create table if not exists card_bill_closures (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households (id) on delete cascade,
  credit_card_id uuid not null,
  bill_month text not null check (bill_month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  state text not null check (state in ('closed','open')),
  total_override_cents bigint check (total_override_cents >= 0),
  updated_by_user_id uuid not null references auth.users (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (credit_card_id, bill_month),
  check (state = 'closed' or total_override_cents is null),
  constraint card_bill_closures_hh_card_fk foreign key (household_id, credit_card_id)
    references credit_cards (household_id, id) on delete restrict
);

alter table card_bill_closures enable row level security;
drop policy if exists card_bill_closures_member_all on card_bill_closures;
create policy card_bill_closures_member_all on card_bill_closures
  for all using (is_household_member(household_id))
  with check (is_household_member(household_id));
do $$ begin
  grant all on table card_bill_closures to anon, authenticated, service_role;
exception when undefined_object then null; end $$;

create or replace function card_bill_is_closed(target_credit_card_id uuid, target_month text)
returns boolean
language plpgsql
stable
-- Read-only definer access lets the attribution trigger work for every write
-- path, including the service-role bot and security-definer import RPCs.
security definer
set search_path = public, pg_temp
as $$
declare
  override_state text;
  card_closing_day smallint;
  month_start date;
  last_day integer;
begin
  select state into override_state from card_bill_closures
  where credit_card_id = target_credit_card_id and bill_month = target_month;
  if override_state is not null then
    return override_state = 'closed';
  end if;

  select closing_day into card_closing_day from credit_cards
  where id = target_credit_card_id;
  if card_closing_day is null then return false; end if;
  month_start := to_date(target_month || '-01', 'YYYY-MM-DD');
  last_day := extract(day from month_start + interval '1 month - 1 day');
  return (now() at time zone 'America/Sao_Paulo')::date > make_date(
    extract(year from month_start)::integer,
    extract(month from month_start)::integer,
    least(card_closing_day, last_day)
  );
end;
$$;
revoke all on function card_bill_is_closed(uuid, text) from public;
do $$ begin
  revoke all on function card_bill_is_closed(uuid, text) from anon;
exception when undefined_object then null; end $$;
do $$ begin
  grant execute on function card_bill_is_closed(uuid, text) to authenticated, service_role;
exception when undefined_object then null; end $$;

-- Only the first application backfills. A replay must not reset invoice_month
-- on charges that have since been shifted. The trigger does not exist yet when
-- the column is first added, so it cannot interfere with historical attribution.
do $$ begin
  if not exists (
    select 1 from pg_attribute where attrelid = 'transactions'::regclass
      and attname = 'invoice_month' and not attisdropped
  ) then
    alter table transactions add column invoice_month text;
    update transactions set invoice_month = case
      when credit_card_id is not null and kind <> 'transfer'
        then to_char(occurred_on, 'YYYY-MM')
      else null
    end;
  end if;
end $$;

do $$ begin
  alter table transactions add constraint transactions_invoice_month_format_check
    check (invoice_month is null or invoice_month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$');
exception when duplicate_object then null; end $$;
do $$ begin
  alter table transactions add constraint transactions_invoice_month_kind_check
    check (invoice_month is null or (credit_card_id is not null and kind <> 'transfer'));
exception when duplicate_object then null; end $$;
create index if not exists transactions_household_card_invoice_month_idx
  on transactions (household_id, credit_card_id, invoice_month);

create or replace function set_transaction_invoice_month()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  candidate_month date;
  bumps integer := 0;
begin
  if tg_op = 'UPDATE' then
    if new.occurred_on is not distinct from old.occurred_on
       and new.credit_card_id is not distinct from old.credit_card_id
       and new.kind is not distinct from old.kind then
      new.invoice_month := old.invoice_month;
      return new;
    end if;
  end if;

  new.invoice_month := null;
  if new.credit_card_id is not null and new.kind <> 'transfer' then
    candidate_month := date_trunc('month', new.occurred_on)::date;
    if new.import_batch_id is null then
      while card_bill_is_closed(new.credit_card_id, to_char(candidate_month, 'YYYY-MM')) loop
        if bumps >= 24 then
          raise exception 'invoice_month: no open fatura after 24 month advances'
            using errcode = '22023';
        end if;
        candidate_month := (candidate_month + interval '1 month')::date;
        bumps := bumps + 1;
      end loop;
    end if;
    new.invoice_month := to_char(candidate_month, 'YYYY-MM');
  end if;
  return new;
end;
$$;
drop trigger if exists transactions_set_invoice_month on transactions;
create trigger transactions_set_invoice_month
  before insert or update on transactions
  for each row execute function set_transaction_invoice_month();

alter table transactions add column if not exists idempotency_key text;
create unique index if not exists transactions_idempotency_key_uniq
  on transactions (household_id, idempotency_key)
  where idempotency_key is not null;
drop index if exists transactions_card_bill_month_uniq;
drop function if exists settle_card_bill(uuid, uuid, uuid, text, bigint, date, uuid);

create or replace function settle_card_bill(
  target_household_id uuid,
  target_credit_card_id uuid,
  target_account_id uuid,
  target_bill_month text,
  target_amount_cents bigint,
  target_paid_on date,
  target_created_by_user_id uuid,
  target_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  card credit_cards;
  paid_on date := coalesce(target_paid_on, (now() at time zone 'America/Sao_Paulo')::date);
  month_start date;
  inserted transactions;
  existing transactions;
begin
  if target_bill_month is null
     or target_bill_month !~ '^[0-9]{4}-(0[1-9]|1[0-2])$' then
    raise exception 'settle_card_bill: invalid month %', target_bill_month using errcode = '22023';
  end if;
  if target_amount_cents is null or target_amount_cents <= 0 then
    raise exception 'settle_card_bill: invalid amount' using errcode = '22023';
  end if;
  if target_idempotency_key is null or target_idempotency_key = '' then
    raise exception 'settle_card_bill: invalid idempotency key' using errcode = '22023';
  end if;
  if paid_on > (now() at time zone 'America/Sao_Paulo')::date then
    raise exception 'settle_card_bill: payment date cannot be in the future' using errcode = '22023';
  end if;

  select * into card from credit_cards
  where id = target_credit_card_id and household_id = target_household_id;
  if card.id is null
     or (coalesce(auth.role(), '') <> 'service_role'
         and not is_household_member(target_household_id)) then
    raise exception 'settle_card_bill: card % not found', target_credit_card_id using errcode = '22023';
  end if;
  if not exists (
    select 1 from accounts where id = target_account_id and household_id = target_household_id
  ) then
    raise exception 'settle_card_bill: account % not found', target_account_id using errcode = '22023';
  end if;
  if not exists (
    select 1 from household_members where household_id = target_household_id
      and user_id = target_created_by_user_id and is_active
  ) then
    raise exception 'settle_card_bill: created_by is not an active member' using errcode = '22023';
  end if;
  month_start := to_date(target_bill_month || '-01', 'YYYY-MM-DD');

  insert into transactions (
    household_id, kind, amount_cents, occurred_on, description,
    account_id, credit_card_id, responsibility_scope, responsible_user_id,
    created_by_user_id, bill_month, idempotency_key
  ) values (
    target_household_id, 'transfer', target_amount_cents, paid_on,
    'Fatura ' || card.name || ' — ' || to_char(month_start, 'MM/YYYY'),
    target_account_id, target_credit_card_id, 'household', null,
    coalesce(auth.uid(), target_created_by_user_id), target_bill_month, target_idempotency_key
  )
  on conflict (household_id, idempotency_key)
    where idempotency_key is not null do nothing
  returning * into inserted;

  if inserted.id is not null then
    return jsonb_build_object('transaction', to_jsonb(inserted), 'replayed', false);
  end if;
  select * into existing from transactions
  where household_id = target_household_id and idempotency_key = target_idempotency_key;
  if existing.kind is distinct from 'transfer'::transaction_kind
     or existing.credit_card_id is distinct from target_credit_card_id
     or existing.account_id is distinct from target_account_id
     or existing.bill_month is distinct from target_bill_month
     or existing.amount_cents is distinct from target_amount_cents
     or existing.occurred_on is distinct from paid_on then
    raise exception 'settle_card_bill: idempotency key reused with a different payment'
      using errcode = '22023';
  end if;
  return jsonb_build_object('transaction', to_jsonb(existing), 'replayed', true);
end;
$$;

revoke all on function settle_card_bill(uuid, uuid, uuid, text, bigint, date, uuid, text) from public;
do $$ begin
  revoke all on function settle_card_bill(uuid, uuid, uuid, text, bigint, date, uuid, text) from anon;
exception when undefined_object then null; end $$;
do $$ begin
  grant execute on function settle_card_bill(uuid, uuid, uuid, text, bigint, date, uuid, text)
    to authenticated, service_role;
exception when undefined_object then null; end $$;
