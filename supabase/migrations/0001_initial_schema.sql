-- 0001_initial_schema.sql
-- Family Finance MVP — initial Postgres schema with Row Level Security (RLS).
--
-- Design principles (see docs/decisions/0002-rls-and-household-isolation.md):
--   * Every household-scoped table carries `household_id` and is isolated by RLS
--     from day one. This is a private finance app; retrofitting isolation later
--     is expensive and error-prone.
--   * Money is stored as integer cents (BRL) with non-negativity / value CHECKs,
--     mirroring the domain `MoneyAmount` contract. Never store reais as floats.
--   * AI / categorization outputs always carry a confidence in [0, 1].
--   * Import batches retain only lote/fonte/contagens/erros — never the raw file.
--
-- RLS model: access is granted to a row when the current authenticated user
-- (auth.uid()) is an active member of that row's household, via household_members.
-- A single SECURITY DEFINER helper `is_household_member(household_id)` keeps the
-- policies short and avoids recursive policy evaluation on household_members.

-- Supabase ships pgcrypto (gen_random_uuid) and the `auth` schema. Guard the
-- extension so this migration is also runnable on a plain Postgres for review.
create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- Enumerated domain types (mirror packages/domain contracts).
-- ---------------------------------------------------------------------------

-- Account kinds: conta corrente and conta investimento.
do $$ begin
  create type account_kind as enum ('checking', 'investment');
exception when duplicate_object then null; end $$;

-- Transaction kinds: expense (despesa), income (receita); transfer reserved.
do $$ begin
  create type transaction_kind as enum ('expense', 'income', 'transfer');
exception when duplicate_object then null; end $$;

-- Investment bucket (caixinha) slugs.
do $$ begin
  create type investment_bucket_slug as enum (
    'filhos', 'casa', 'independencia_financeira'
  );
exception when duplicate_object then null; end $$;

-- Import source adapters supported by the MVP.
do $$ begin
  create type import_source as enum ('minhas_financas_csv', 'nubank_csv');
exception when duplicate_object then null; end $$;

-- Import batch lifecycle status.
do $$ begin
  create type import_batch_status as enum (
    'pending', 'previewed', 'confirmed', 'discarded'
  );
exception when duplicate_object then null; end $$;

-- Responsibility scope: household (Casa) by default, or a specific user.
do $$ begin
  create type responsibility_scope as enum ('household', 'user');
exception when duplicate_object then null; end $$;

-- Bot channel for bot_interactions.
do $$ begin
  create type bot_channel as enum ('telegram');
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------------
-- Households and membership.
-- ---------------------------------------------------------------------------

create table if not exists households (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Membership links a Supabase auth user to a household. RLS keys off this table.
-- `user_id` references auth.users so isolation is anchored to real identities.
create table if not exists household_members (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  -- Display label only; MVP has no advanced roles. 'member' for everyone.
  role text not null default 'member',
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (household_id, user_id)
);

create index if not exists household_members_user_idx
  on household_members (user_id);
create index if not exists household_members_household_idx
  on household_members (household_id);

-- ---------------------------------------------------------------------------
-- Membership helper for RLS.
--
-- SECURITY DEFINER so the function can read household_members without being
-- subject to that table's own RLS (which would otherwise recurse). It only ever
-- answers "is the *current* auth user an active member of household X?", so it
-- cannot be used to leak other households' membership.
-- ---------------------------------------------------------------------------

create or replace function is_household_member(target_household_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from household_members hm
    where hm.household_id = target_household_id
      and hm.user_id = auth.uid()
      and hm.is_active
  );
$$;

-- ---------------------------------------------------------------------------
-- Financial instruments.
-- ---------------------------------------------------------------------------

create table if not exists accounts (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households (id) on delete cascade,
  kind account_kind not null,
  name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists accounts_household_idx on accounts (household_id);

create table if not exists investment_buckets (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households (id) on delete cascade,
  slug investment_bucket_slug not null,
  name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (household_id, slug)
);

create index if not exists investment_buckets_household_idx
  on investment_buckets (household_id);

create table if not exists credit_cards (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households (id) on delete cascade,
  name text not null,
  closing_day smallint check (closing_day between 1 and 31),
  due_day smallint check (due_day between 1 and 31),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists credit_cards_household_idx
  on credit_cards (household_id);

-- ---------------------------------------------------------------------------
-- Category taxonomy (macrocategoria + subcategoria).
-- ---------------------------------------------------------------------------

create table if not exists categories (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households (id) on delete cascade,
  name text not null,
  -- AI/import-suggested categories stay pending until approved (no sprawl).
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (household_id, name)
);

create index if not exists categories_household_idx on categories (household_id);

create table if not exists subcategories (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households (id) on delete cascade,
  category_id uuid not null references categories (id) on delete cascade,
  name text not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (household_id, category_id, name)
);

create index if not exists subcategories_household_idx
  on subcategories (household_id);
create index if not exists subcategories_category_idx
  on subcategories (category_id);

-- ---------------------------------------------------------------------------
-- Installment groups and installments (parcelado card purchases).
-- A group is the compra-mãe; installments are month-attributed parcels.
-- Declared before transactions so a transaction can reference its installment.
-- ---------------------------------------------------------------------------

create table if not exists installment_groups (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households (id) on delete cascade,
  credit_card_id uuid not null references credit_cards (id) on delete restrict,
  description text not null,
  -- Total purchase amount in integer BRL cents. Positive.
  total_amount_cents bigint not null check (total_amount_cents > 0),
  installment_count integer not null check (installment_count >= 1),
  purchased_on date not null,
  category_id uuid references categories (id) on delete set null,
  subcategory_id uuid references subcategories (id) on delete set null,
  responsibility_scope responsibility_scope not null default 'household',
  responsible_user_id uuid references auth.users (id) on delete set null,
  created_by_user_id uuid not null references auth.users (id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- responsible_user_id is set iff the scope is 'user'.
  check (
    (responsibility_scope = 'user' and responsible_user_id is not null)
    or (responsibility_scope = 'household' and responsible_user_id is null)
  )
);

create index if not exists installment_groups_household_idx
  on installment_groups (household_id);

create table if not exists installments (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households (id) on delete cascade,
  installment_group_id uuid not null
    references installment_groups (id) on delete cascade,
  credit_card_id uuid not null references credit_cards (id) on delete restrict,
  -- 1-based position within the group.
  number integer not null check (number >= 1),
  installment_count integer not null check (installment_count >= 1),
  amount_cents bigint not null check (amount_cents > 0),
  -- Year-month attribution as 'YYYY-MM' (not invoice timing).
  due_month text not null check (due_month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  description text not null,
  category_id uuid references categories (id) on delete set null,
  subcategory_id uuid references subcategories (id) on delete set null,
  responsibility_scope responsibility_scope not null default 'household',
  responsible_user_id uuid references auth.users (id) on delete set null,
  created_by_user_id uuid not null references auth.users (id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (installment_group_id, number),
  check (number <= installment_count),
  check (
    (responsibility_scope = 'user' and responsible_user_id is not null)
    or (responsibility_scope = 'household' and responsible_user_id is null)
  )
);

create index if not exists installments_household_idx
  on installments (household_id);
create index if not exists installments_group_idx
  on installments (installment_group_id);
create index if not exists installments_due_month_idx
  on installments (household_id, due_month);

-- ---------------------------------------------------------------------------
-- Transactions (despesa / receita / ajuste futuro).
-- Payment is account XOR card. A single-charge (à vista) card purchase may link
-- to an installment; parcelado purchases are represented by the installments
-- table instead, so transactions keep the "one event" grain.
-- ---------------------------------------------------------------------------

create table if not exists transactions (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households (id) on delete cascade,
  kind transaction_kind not null,
  -- Amount in integer BRL cents. Positive; sign is implied by `kind`.
  amount_cents bigint not null check (amount_cents > 0),
  occurred_on date not null,
  description text not null,
  category_id uuid references categories (id) on delete set null,
  subcategory_id uuid references subcategories (id) on delete set null,
  -- Payment instrument: exactly one of account_id / credit_card_id.
  account_id uuid references accounts (id) on delete restrict,
  credit_card_id uuid references credit_cards (id) on delete restrict,
  -- Optional link to the installment this charge corresponds to (à vista row).
  installment_id uuid references installments (id) on delete set null,
  responsibility_scope responsibility_scope not null default 'household',
  responsible_user_id uuid references auth.users (id) on delete set null,
  -- lançado por: who launched the transaction. Always recorded.
  created_by_user_id uuid not null references auth.users (id) on delete restrict,
  -- If this row came from an import, link the batch (no raw file retained).
  import_batch_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Exactly one payment instrument.
  check (
    (account_id is not null and credit_card_id is null)
    or (account_id is null and credit_card_id is not null)
  ),
  check (
    (responsibility_scope = 'user' and responsible_user_id is not null)
    or (responsibility_scope = 'household' and responsible_user_id is null)
  )
);

create index if not exists transactions_household_idx
  on transactions (household_id);
create index if not exists transactions_household_occurred_idx
  on transactions (household_id, occurred_on);
create index if not exists transactions_category_idx
  on transactions (category_id);

-- ---------------------------------------------------------------------------
-- Import batches and rows.
-- Privacy: the original CSV/XLSX file is never persisted. Only lote, fonte,
-- contagens, status and minimal per-row data/errors are stored.
-- ---------------------------------------------------------------------------

create table if not exists import_batches (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households (id) on delete cascade,
  source import_source not null,
  status import_batch_status not null default 'pending',
  -- Counts (estatísticas). Never the raw file.
  total_rows integer not null default 0 check (total_rows >= 0),
  imported_rows integer not null default 0 check (imported_rows >= 0),
  duplicate_rows integer not null default 0 check (duplicate_rows >= 0),
  error_rows integer not null default 0 check (error_rows >= 0),
  -- Minimal note for the operator (e.g. original filename), never file bytes.
  notes text,
  created_by_user_id uuid not null references auth.users (id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists import_batches_household_idx
  on import_batches (household_id);

create table if not exists import_rows (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households (id) on delete cascade,
  import_batch_id uuid not null
    references import_batches (id) on delete cascade,
  -- Original line number within the source file, for operator reference.
  source_line integer check (source_line >= 0),
  -- Normalized fields extracted from the row (transient, minimal). The raw
  -- file is discarded; only these parsed values survive.
  occurred_on date,
  amount_cents bigint check (amount_cents <> 0),
  description text,
  -- Free-form parser error/skip reason when the row could not be mapped.
  error_message text,
  is_duplicate boolean not null default false,
  -- The transaction this row produced once the batch is confirmed, if any.
  transaction_id uuid references transactions (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists import_rows_household_idx
  on import_rows (household_id);
create index if not exists import_rows_batch_idx
  on import_rows (import_batch_id);

-- Wire transactions.import_batch_id now that import_batches exists.
do $$ begin
  alter table transactions
    add constraint transactions_import_batch_fk
    foreign key (import_batch_id)
    references import_batches (id) on delete set null;
exception when duplicate_object then null; end $$;

-- ---------------------------------------------------------------------------
-- Categorization memory — auditable, explainable patterns.
-- Every suggestion-bearing row carries a confidence in [0, 1] and an
-- explanation, satisfying the "AI output must be explainable" rule.
-- ---------------------------------------------------------------------------

create table if not exists categorization_memory (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households (id) on delete cascade,
  -- Normalized merchant/description pattern this memory matches on.
  pattern text not null,
  category_id uuid references categories (id) on delete cascade,
  subcategory_id uuid references subcategories (id) on delete cascade,
  -- Confidence of the suggestion, constrained to [0, 1].
  confidence numeric(4, 3) not null
    check (confidence >= 0 and confidence <= 1),
  -- Human-readable reason this pattern was learned (auditability).
  explanation text not null,
  -- Memory can be disabled without deleting history.
  is_active boolean not null default true,
  -- Advanced user who taught/confirmed this pattern, if known.
  created_by_user_id uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists categorization_memory_household_idx
  on categorization_memory (household_id);
create index if not exists categorization_memory_pattern_idx
  on categorization_memory (household_id, pattern);

-- ---------------------------------------------------------------------------
-- Bot interactions — Telegram intake log, confirmation state, and AI metadata.
-- Confidence (when an AI suggestion was involved) is constrained to [0, 1].
-- Raw audio is never persisted (see import privacy rule); only transcription
-- text and outcome metadata are kept.
-- ---------------------------------------------------------------------------

create table if not exists bot_interactions (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households (id) on delete cascade,
  channel bot_channel not null default 'telegram',
  -- External chat/user identifier (e.g. Telegram chat id), never a secret.
  external_chat_id text,
  -- The authenticated app user this interaction maps to, if linked.
  user_id uuid references auth.users (id) on delete set null,
  -- 'text' | 'audio' — kept as text to stay extension-friendly.
  input_kind text not null default 'text',
  -- Parsed/transcribed message text. No raw audio bytes are stored.
  message_text text,
  -- Optional confidence of the AI interpretation, constrained to [0, 1].
  confidence numeric(4, 3) check (confidence >= 0 and confidence <= 1),
  -- Why the suggestion was made / fallback explanation (auditability).
  explanation text,
  -- The transaction this interaction produced once confirmed, if any.
  transaction_id uuid references transactions (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists bot_interactions_household_idx
  on bot_interactions (household_id);

-- ---------------------------------------------------------------------------
-- Row Level Security.
--
-- Enable RLS on every table and grant access only to active members of the
-- row's household. household_members is special-cased: a member may read their
-- own household's membership rows. Nothing is readable/writable by a user who
-- is not a member, which satisfies the unauthorized-access acceptance criteria.
-- ---------------------------------------------------------------------------

alter table households enable row level security;
alter table household_members enable row level security;
alter table accounts enable row level security;
alter table investment_buckets enable row level security;
alter table credit_cards enable row level security;
alter table categories enable row level security;
alter table subcategories enable row level security;
alter table transactions enable row level security;
alter table installment_groups enable row level security;
alter table installments enable row level security;
alter table import_batches enable row level security;
alter table import_rows enable row level security;
alter table categorization_memory enable row level security;
alter table bot_interactions enable row level security;

-- households: a member can see and update their own household.
drop policy if exists households_select on households;
create policy households_select on households
  for select using (is_household_member(id));

drop policy if exists households_update on households;
create policy households_update on households
  for update using (is_household_member(id))
  with check (is_household_member(id));

-- household_members: a member can read membership rows of their own household.
-- Membership rows are provisioned by an admin/service role (allowlist), so no
-- self-service insert policy is granted here.
drop policy if exists household_members_select on household_members;
create policy household_members_select on household_members
  for select using (is_household_member(household_id));

-- For all household-scoped tables the policy is identical: full access for
-- active members of the row's household, denied for everyone else.
do $$
declare
  t text;
  scoped_tables text[] := array[
    'accounts',
    'investment_buckets',
    'credit_cards',
    'categories',
    'subcategories',
    'transactions',
    'installment_groups',
    'installments',
    'import_batches',
    'import_rows',
    'categorization_memory',
    'bot_interactions'
  ];
begin
  foreach t in array scoped_tables loop
    execute format('drop policy if exists %I_member_all on %I;', t, t);
    execute format(
      'create policy %I_member_all on %I '
      || 'for all using (is_household_member(household_id)) '
      || 'with check (is_household_member(household_id));',
      t, t
    );
  end loop;
end $$;
