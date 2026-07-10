-- Reliable, retry-safe imports.
--
-- `confirm_import_v2` is the single write boundary for flat transactions and
-- reconstructed installment purchases.  A request key makes a repeated RPC an
-- idempotent replay; source-item claims make concurrent/different batches that
-- contain the same normalized item safe.  The original file remains transient.

do $$ begin
  create type import_artifact_kind as enum ('transaction', 'installment_group');
exception when duplicate_object then null; end $$;

do $$ begin
  create type import_row_disposition as enum (
    'imported',
    'duplicate_existing',
    'duplicate_in_file',
    'parser_error',
    'validation_error',
    'excluded'
  );
exception when duplicate_object then null; end $$;

-- Source labels and learned merchant rules are direction-scoped.  "Mercado"
-- on an expense must not classify a refund/income, and explicit suppression is
-- a durable decision rather than an uncategorized accident.
alter table categorization_memory
  add column if not exists row_kind transaction_kind not null default 'expense';
alter table categorization_memory
  add column if not exists suppress boolean not null default false;
alter table categorization_memory
  add column if not exists match_kind text;
alter table categorization_memory
  add column if not exists normalizer_version text;
alter table categorization_memory
  add column if not exists import_managed boolean not null default false;

do $$ begin
  alter table categorization_memory add constraint categorization_memory_row_kind_check
    check (row_kind in ('expense', 'income'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table categorization_memory add constraint categorization_memory_match_kind_check
    check (match_kind is null or match_kind in (
      'merchant_exact', 'merchant_prefix', 'description_contains', 'suppress'
    ));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table categorization_memory add constraint categorization_memory_normalizer_version_check
    check (normalizer_version is null or length(normalizer_version) between 1 and 80);
exception when duplicate_object then null; end $$;
do $$ begin
  alter table categorization_memory add constraint categorization_memory_suppress_shape
    check (not suppress or (category_id is null and subcategory_id is null));
exception when duplicate_object then null; end $$;

-- Do not impose new uniqueness on legacy rules: an existing household may
-- legitimately have duplicate historical patterns. Only v2-managed learning
-- is unique; when an explicit learned rule is stored, matching legacy rows are
-- disabled (not deleted) below so the new choice wins without losing audit.
drop index if exists categorization_memory_kind_pattern_uniq;
create unique index if not exists categorization_memory_import_kind_pattern_uniq
  on categorization_memory (household_id, pattern, row_kind)
  where import_managed;

create table if not exists source_category_mappings (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households (id) on delete cascade,
  source import_source not null,
  normalized_label text not null check (
    length(normalized_label) between 1 and 200 and normalized_label = btrim(normalized_label)
  ),
  row_kind transaction_kind not null check (row_kind in ('expense', 'income')),
  category_id uuid references categories (id) on delete set null,
  subcategory_id uuid references subcategories (id) on delete set null,
  suppress boolean not null default false,
  is_active boolean not null default true,
  created_by_user_id uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (household_id, source, normalized_label, row_kind),
  check (
    (suppress and category_id is null and subcategory_id is null)
    or (not suppress and category_id is not null)
  )
);

create index if not exists source_category_mappings_household_idx
  on source_category_mappings (household_id, source, row_kind);

do $$ begin
  alter table source_category_mappings add constraint source_category_mappings_hh_category_fk
    foreign key (household_id, category_id)
    references categories (household_id, id) on delete set null;
exception when duplicate_object then null; end $$;
do $$ begin
  alter table source_category_mappings add constraint source_category_mappings_hh_subcategory_fk
    foreign key (household_id, subcategory_id)
    references subcategories (household_id, id) on delete set null;
exception when duplicate_object then null; end $$;

alter table source_category_mappings enable row level security;
drop policy if exists source_category_mappings_member_all on source_category_mappings;
create policy source_category_mappings_member_all on source_category_mappings
  for select using (is_household_member(household_id));
do $$ begin
  revoke all on source_category_mappings from public, anon, authenticated;
  grant select on source_category_mappings to authenticated;
  grant all on source_category_mappings to service_role;
exception when undefined_object then null; end $$;

-- Migration 0003 predates source mappings. Replace its merge function so a
-- category merge cannot strand learned mappings on the archived category.
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
  moved_source_mappings integer;
begin
  if source_category_id = target_category_id then
    raise exception 'merge_category: source and target must differ'
      using errcode = '22023';
  end if;
  if target_household_id is null
     or not is_household_member(target_household_id) then
    raise exception 'merge_category: not a member of household %', target_household_id
      using errcode = '42501';
  end if;
  if not exists (
    select 1 from categories
    where household_id = target_household_id
      and id = target_category_id and is_active
  ) then
    raise exception 'merge_category: active target category not found'
      using errcode = '22023';
  end if;

  update transactions set category_id = target_category_id
    where household_id = target_household_id and category_id = source_category_id;
  get diagnostics moved_transactions = row_count;
  update installment_groups set category_id = target_category_id
    where household_id = target_household_id and category_id = source_category_id;
  get diagnostics moved_installment_groups = row_count;
  update installments set category_id = target_category_id
    where household_id = target_household_id and category_id = source_category_id;
  get diagnostics moved_installments = row_count;
  update subcategories set category_id = target_category_id
    where household_id = target_household_id and category_id = source_category_id;
  get diagnostics moved_subcategories = row_count;
  update categorization_memory set category_id = target_category_id
    where household_id = target_household_id and category_id = source_category_id;
  get diagnostics moved_memory = row_count;
  update source_category_mappings set category_id = target_category_id
    where household_id = target_household_id and category_id = source_category_id;
  get diagnostics moved_source_mappings = row_count;
  update categories set is_active = false
    where household_id = target_household_id and id = source_category_id
    returning * into archived_source;
  if archived_source.id is null then
    raise exception 'merge_category: source category not found'
      using errcode = '22023';
  end if;

  return jsonb_build_object(
    'source', to_jsonb(archived_source),
    'moved', jsonb_build_object(
      'transactions', moved_transactions,
      'installment_groups', moved_installment_groups,
      'installments', moved_installments,
      'subcategories', moved_subcategories,
      'categorization_memory', moved_memory,
      'source_category_mappings', moved_source_mappings
    )
  );
end;
$$;
revoke all on function merge_category(uuid, uuid, uuid) from public;
do $$ begin
  revoke all on function merge_category(uuid, uuid, uuid) from anon;
  grant execute on function merge_category(uuid, uuid, uuid) to authenticated;
exception when undefined_object then null; end $$;

-- Shared replay protection for the internal web -> bot suggestion endpoint.
-- A primary-key insert is atomic across bot processes and survives restarts.
create table if not exists import_suggestion_nonces (
  nonce text primary key check (nonce ~ '^[A-Za-z0-9_-]{16,128}$'),
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
alter table import_suggestion_nonces enable row level security;
do $$ begin
  revoke all on import_suggestion_nonces from public, anon, authenticated;
  grant all on import_suggestion_nonces to service_role;
exception when undefined_object then null; end $$;

create or replace function claim_import_suggestion_nonce(
  target_nonce text,
  target_expires_at timestamptz
)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  inserted_count integer;
begin
  if target_nonce !~ '^[A-Za-z0-9_-]{16,128}$'
     or target_expires_at <= now()
     or target_expires_at > now() + interval '5 minutes' then
    raise exception 'claim_import_suggestion_nonce: invalid claim'
      using errcode = '22023';
  end if;
  delete from import_suggestion_nonces where expires_at <= now();
  insert into import_suggestion_nonces (nonce, expires_at)
    values (target_nonce, target_expires_at)
    on conflict do nothing;
  get diagnostics inserted_count = row_count;
  return inserted_count = 1;
end;
$$;
revoke all on function claim_import_suggestion_nonce(text, timestamptz) from public;
do $$ begin
  revoke all on function claim_import_suggestion_nonce(text, timestamptz)
    from anon, authenticated;
  grant execute on function claim_import_suggestion_nonce(text, timestamptz)
    to service_role;
exception when undefined_object then null; end $$;

alter table import_batches add column if not exists request_key uuid;
alter table import_batches add column if not exists payload_fingerprint text;
alter table import_batches add column if not exists file_fingerprint text;
alter table import_batches add column if not exists parser_version text;
alter table import_batches add column if not exists normalized_fingerprint text;
alter table import_batches add column if not exists confirmed_at timestamptz;

do $$ begin
  alter table import_batches add constraint import_batches_payload_fingerprint_shape
    check (payload_fingerprint is null or payload_fingerprint ~ '^[0-9a-f]{64}$');
exception when duplicate_object then null; end $$;
do $$ begin
  alter table import_batches add constraint import_batches_normalized_fingerprint_shape
    check (normalized_fingerprint is null or normalized_fingerprint ~ '^[0-9a-f]{64}$');
exception when duplicate_object then null; end $$;
create index if not exists import_batches_normalized_fingerprint_idx
  on import_batches (household_id, source, normalized_fingerprint);
do $$ begin
  alter table import_batches add constraint import_batches_file_fingerprint_shape
    check (file_fingerprint is null or file_fingerprint ~ '^[0-9a-f]{64}$');
exception when duplicate_object then null; end $$;

do $$ begin
  alter table import_batches add constraint import_batches_request_key_uniq
    unique (household_id, request_key);
exception when duplicate_object or duplicate_table then null; end $$;

do $$ begin
  alter table import_batches add constraint import_batches_household_id_uniq
    unique (household_id, id);
exception when duplicate_object or duplicate_table then null; end $$;

do $$ begin
  alter table transactions add constraint transactions_household_id_uniq
    unique (household_id, id);
exception when duplicate_object or duplicate_table then null; end $$;
do $$ begin
  alter table installment_groups add constraint installment_groups_household_id_uniq
    unique (household_id, id);
exception when duplicate_object or duplicate_table then null; end $$;

alter table installment_groups add column if not exists import_batch_id uuid;

do $$ begin
  alter table installment_groups add constraint installment_groups_import_batch_fk
    foreign key (import_batch_id) references import_batches (id) on delete set null;
exception when duplicate_object then null; end $$;

do $$ begin
  alter table installment_groups add constraint installment_groups_hh_import_batch_fk
    foreign key (household_id, import_batch_id)
    references import_batches (household_id, id) on delete set null;
exception when duplicate_object then null; end $$;

create table if not exists import_item_claims (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households (id) on delete cascade,
  source import_source not null,
  fingerprint_version smallint not null check (fingerprint_version >= 1),
  base_fingerprint text not null check (base_fingerprint ~ '^[0-9a-f]{64}$'),
  occurrence_no integer not null check (occurrence_no >= 1),
  artifact_kind import_artifact_kind not null,
  import_batch_id uuid not null references import_batches (id) on delete restrict,
  transaction_id uuid references transactions (id) on delete restrict,
  installment_group_id uuid references installment_groups (id) on delete restrict,
  source_line integer check (source_line >= 0),
  override_token uuid,
  override_of_claim_id uuid,
  override_reason text,
  override_by_user_id uuid,
  created_at timestamptz not null default now(),
  check (not (transaction_id is not null and installment_group_id is not null))
);

alter table import_item_claims add column if not exists override_of_claim_id uuid;
alter table import_item_claims add column if not exists override_reason text;
alter table import_item_claims add column if not exists override_by_user_id uuid;
do $$ begin
  alter table import_item_claims add constraint import_item_claims_override_of_fk
    foreign key (override_of_claim_id) references import_item_claims (id) on delete restrict;
exception when duplicate_object then null; end $$;
do $$ begin
  alter table import_item_claims add constraint import_item_claims_override_by_fk
    foreign key (override_by_user_id) references auth.users (id) on delete restrict;
exception when duplicate_object then null; end $$;
do $$ begin
  alter table import_item_claims add constraint import_item_claims_override_reason_shape
    check (override_reason is null or length(btrim(override_reason)) between 5 and 200);
exception when duplicate_object then null; end $$;

create unique index if not exists import_item_claims_identity_uniq
  on import_item_claims (
    household_id, source, fingerprint_version, base_fingerprint, occurrence_no
  )
  where override_token is null;

create unique index if not exists import_item_claims_override_uniq
  on import_item_claims (household_id, override_token)
  where override_token is not null;

create index if not exists import_item_claims_batch_idx
  on import_item_claims (import_batch_id);

create table if not exists import_ai_usage (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references households (id) on delete cascade,
  request_key uuid not null,
  paid_items_reserved integer not null check (paid_items_reserved between 0 and 25),
  created_by_user_id uuid not null references auth.users (id) on delete restrict,
  created_at timestamptz not null default now(),
  unique (household_id, request_key)
);
create table if not exists import_ai_daily_usage (
  household_id uuid not null references households (id) on delete cascade,
  usage_date date not null default current_date,
  paid_items_reserved integer not null default 0 check (paid_items_reserved between 0 and 25),
  updated_at timestamptz not null default now(),
  primary key (household_id, usage_date)
);
alter table import_ai_usage enable row level security;
alter table import_ai_daily_usage enable row level security;
drop policy if exists import_ai_usage_select on import_ai_usage;
create policy import_ai_usage_select on import_ai_usage
  for select using (is_household_member(household_id));
drop policy if exists import_ai_daily_usage_select on import_ai_daily_usage;
create policy import_ai_daily_usage_select on import_ai_daily_usage
  for select using (is_household_member(household_id));
do $$ begin
  grant select on import_ai_usage, import_ai_daily_usage to authenticated, service_role;
exception when undefined_object then null; end $$;

create or replace function reserve_import_ai_paid_items(
  target_household_id uuid,
  target_request_key uuid,
  requested_items integer
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  reservation_id uuid;
  already_reserved integer;
  allowed integer;
begin
  if requested_items not between 0 and 25
     or not is_household_member(target_household_id) then
    raise exception 'reserve_import_ai_paid_items: invalid request'
      using errcode = '42501';
  end if;
  insert into import_ai_usage (
    household_id, request_key, paid_items_reserved, created_by_user_id
  ) values (
    target_household_id, target_request_key, 0, auth.uid()
  ) on conflict (household_id, request_key) do nothing
  returning id into reservation_id;
  if reservation_id is null then return 0; end if;

  insert into import_ai_daily_usage (household_id, usage_date)
  values (target_household_id, current_date)
  on conflict (household_id, usage_date) do nothing;
  select paid_items_reserved into already_reserved
  from import_ai_daily_usage
  where household_id = target_household_id and usage_date = current_date
  for update;
  allowed := least(requested_items, greatest(0, 25 - already_reserved));
  update import_ai_daily_usage
  set paid_items_reserved = paid_items_reserved + allowed, updated_at = now()
  where household_id = target_household_id and usage_date = current_date;
  update import_ai_usage set paid_items_reserved = allowed where id = reservation_id;
  return allowed;
end;
$$;
revoke all on function reserve_import_ai_paid_items(uuid, uuid, integer) from public;
do $$ begin
  grant execute on function reserve_import_ai_paid_items(uuid, uuid, integer) to authenticated;
exception when undefined_object then null; end $$;

do $$ begin
  alter table import_item_claims add constraint import_item_claims_hh_batch_fk
    foreign key (household_id, import_batch_id)
    references import_batches (household_id, id) on delete restrict;
exception when duplicate_object then null; end $$;

do $$ begin
  alter table import_item_claims add constraint import_item_claims_hh_transaction_fk
    foreign key (household_id, transaction_id)
    references transactions (household_id, id) on delete restrict;
exception when duplicate_object then null; end $$;
do $$ begin
  alter table import_item_claims add constraint import_item_claims_hh_group_fk
    foreign key (household_id, installment_group_id)
    references installment_groups (household_id, id) on delete restrict;
exception when duplicate_object then null; end $$;

create or replace function validate_import_item_claim_artifact()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
declare
  current_claim import_item_claims;
begin
  -- A deferred INSERT event retains its original NEW tuple, so read the final
  -- row state after all artifact/link updates in the transaction.
  select * into current_claim from import_item_claims where id = new.id;
  if (current_claim.artifact_kind = 'transaction'
      and (current_claim.transaction_id is null or current_claim.installment_group_id is not null))
     or (current_claim.artifact_kind = 'installment_group'
      and (current_claim.installment_group_id is null or current_claim.transaction_id is not null)) then
    raise exception 'import item claim % does not have exactly its declared artifact', new.id
      using errcode = '23514';
  end if;
  return null;
end;
$$;

drop trigger if exists import_item_claim_artifact_check on import_item_claims;
create constraint trigger import_item_claim_artifact_check
after insert or update on import_item_claims
deferrable initially deferred
for each row execute function validate_import_item_claim_artifact();

alter table import_rows add column if not exists claim_id uuid;
alter table import_rows add column if not exists installment_group_id uuid;
alter table import_rows add column if not exists disposition import_row_disposition;
alter table import_rows add column if not exists duplicate_of_claim_id uuid;
alter table import_rows add column if not exists fingerprint_version smallint;
alter table import_rows add column if not exists base_fingerprint text;
alter table import_rows add column if not exists occurrence_no integer;
alter table import_rows add column if not exists observed_installment_number integer;
alter table import_rows add column if not exists observed_installment_count integer;
alter table import_rows add column if not exists card_last4 text;
alter table import_rows add column if not exists override_reason text;
alter table import_rows add column if not exists category_source text;
alter table import_rows add column if not exists category_confidence numeric;
alter table import_rows add column if not exists category_accepted boolean;
alter table import_rows add column if not exists category_changed boolean;

do $$ begin
  alter table import_rows add constraint import_rows_claim_fk
    foreign key (claim_id) references import_item_claims (id) on delete set null;
exception when duplicate_object then null; end $$;
do $$ begin
  alter table import_rows add constraint import_rows_category_confidence_shape
    check (category_confidence is null or category_confidence between 0 and 1);
exception when duplicate_object then null; end $$;
do $$ begin
  alter table import_rows add constraint import_rows_duplicate_claim_fk
    foreign key (duplicate_of_claim_id) references import_item_claims (id) on delete set null;
exception when duplicate_object then null; end $$;
do $$ begin
  alter table import_rows add constraint import_rows_installment_group_fk
    foreign key (installment_group_id) references installment_groups (id) on delete set null;
exception when duplicate_object then null; end $$;
do $$ begin
  alter table import_rows add constraint import_rows_fingerprint_shape
    check (base_fingerprint is null or base_fingerprint ~ '^[0-9a-f]{64}$');
exception when duplicate_object then null; end $$;
do $$ begin
  alter table import_rows add constraint import_rows_installment_observation
    check (
      (observed_installment_number is null and observed_installment_count is null)
      or (
        observed_installment_number between 1 and observed_installment_count
        and observed_installment_count >= 1
      )
    );
exception when duplicate_object then null; end $$;
do $$ begin
  alter table import_rows add constraint import_rows_card_last4_shape
    check (card_last4 is null or card_last4 ~ '^[0-9]{4}$');
exception when duplicate_object then null; end $$;
do $$ begin
  alter table import_rows add constraint import_rows_override_reason_shape
    check (override_reason is null or length(btrim(override_reason)) between 5 and 200);
exception when duplicate_object then null; end $$;

alter table import_item_claims enable row level security;
drop policy if exists import_item_claims_select on import_item_claims;
create policy import_item_claims_select on import_item_claims
  for select using (is_household_member(household_id));
do $$ begin
  grant select on import_item_claims to authenticated, service_role;
exception when undefined_object then null; end $$;

-- Writes deliberately have no table policy: the RPC below is the only write
-- path and re-asserts household membership before using SECURITY DEFINER.

create or replace function confirm_import_v2(
  batch_payload jsonb,
  items_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  target_household_id uuid := (batch_payload ->> 'household_id')::uuid;
  target_source import_source := (batch_payload ->> 'source')::import_source;
  target_request_key uuid := (batch_payload ->> 'request_key')::uuid;
  target_payload_fingerprint text := batch_payload ->> 'payload_fingerprint';
  target_created_by_user_id uuid := (batch_payload ->> 'created_by_user_id')::uuid;
  caller_user_id uuid := auth.uid();
  inserted_batch import_batches;
  existing_batch import_batches;
  item jsonb;
  tx jsonb;
  group_data jsonb;
  parcels jsonb;
  learning jsonb;
  source_learning jsonb;
  memory_learning jsonb;
  inserted_claim import_item_claims;
  existing_claim import_item_claims;
  inserted_tx transactions;
  inserted_group installment_groups;
  inserted_parcels jsonb;
  item_disposition import_row_disposition;
  artifact_kind import_artifact_kind;
  imported_count integer := 0;
  duplicate_count integer := 0;
  error_count integer := 0;
  excluded_count integer := 0;
  transaction_count integer := 0;
  group_count integer := 0;
  persisted_parcel_count integer;
  persisted_parcel_sum bigint;
  parcel_shape_valid boolean;
begin
  if target_household_id is null
     or target_request_key is null
     or target_payload_fingerprint is null
     or target_payload_fingerprint !~ '^[0-9a-f]{64}$' then
    raise exception 'confirm_import_v2: invalid batch identity'
      using errcode = '22023';
  end if;

  if coalesce(auth.role(), '') <> 'service_role'
     and not is_household_member(target_household_id) then
    raise exception 'confirm_import_v2: not a member of household %', target_household_id
      using errcode = '42501';
  end if;

  if target_created_by_user_id is null
     or not exists (
       select 1 from household_members
       where household_id = target_household_id
         and user_id = target_created_by_user_id
         and is_active
     )
     or (
       coalesce(auth.role(), '') <> 'service_role'
       and target_created_by_user_id is distinct from caller_user_id
     ) then
    raise exception 'confirm_import_v2: invalid created_by_user_id attribution'
      using errcode = '42501';
  end if;

  if jsonb_typeof(items_payload) is distinct from 'array' then
    raise exception 'confirm_import_v2: items_payload must be an array'
      using errcode = '22023';
  end if;
  if jsonb_array_length(items_payload) = 0
     or not exists (
       select 1 from jsonb_array_elements(items_payload) candidate
       where candidate ->> 'disposition' = 'imported'
     ) then
    raise exception 'confirm_import_v2: empty import cannot be confirmed'
      using errcode = '22023';
  end if;
  if exists (
    select 1
    from jsonb_array_elements(items_payload) candidate
    where candidate -> 'learning' -> 'source_category' is not null
    group by
      candidate -> 'learning' -> 'source_category' ->> 'normalized_label',
      candidate -> 'learning' -> 'source_category' ->> 'row_kind'
    having count(distinct jsonb_build_object(
      'category_id', candidate -> 'learning' -> 'source_category' ->> 'category_id',
      'subcategory_id', candidate -> 'learning' -> 'source_category' ->> 'subcategory_id',
      'suppress', candidate -> 'learning' -> 'source_category' ->> 'suppress'
    )) > 1
  ) or exists (
    select 1
    from jsonb_array_elements(items_payload) candidate
    where candidate -> 'learning' -> 'merchant_memory' is not null
    group by
      candidate -> 'learning' -> 'merchant_memory' ->> 'pattern',
      candidate -> 'learning' -> 'merchant_memory' ->> 'row_kind'
    having count(distinct jsonb_build_object(
      'category_id', candidate -> 'learning' -> 'merchant_memory' ->> 'category_id',
      'subcategory_id', candidate -> 'learning' -> 'merchant_memory' ->> 'subcategory_id',
      'suppress', candidate -> 'learning' -> 'merchant_memory' ->> 'suppress'
    )) > 1
  ) then
    raise exception 'confirm_import_v2: conflicting learning commands'
      using errcode = '22023';
  end if;

  -- The request-key uniqueness constraint serializes concurrent retries.  If a
  -- prior call committed, return it only when the immutable payload hash agrees.
  insert into import_batches (
    household_id, source, status, total_rows, imported_rows, duplicate_rows,
    error_rows, notes, created_by_user_id, request_key, payload_fingerprint,
    file_fingerprint, parser_version, confirmed_at
    , normalized_fingerprint
  ) values (
    target_household_id,
    target_source,
    'confirmed',
    0, 0, 0, 0,
    nullif(batch_payload ->> 'notes', ''),
    target_created_by_user_id,
    target_request_key,
    target_payload_fingerprint,
    nullif(batch_payload ->> 'file_fingerprint', ''),
    nullif(batch_payload ->> 'parser_version', ''),
    now(),
    nullif(batch_payload ->> 'normalized_fingerprint', '')
  )
  on conflict (household_id, request_key) do nothing
  returning * into inserted_batch;

  if inserted_batch.id is null then
    select * into existing_batch
    from import_batches
    where household_id = target_household_id and request_key = target_request_key;

    if existing_batch.payload_fingerprint is distinct from target_payload_fingerprint then
      raise exception 'confirm_import_v2: request key reused with different payload'
        using errcode = '22023';
    end if;

    select
      count(*) filter (where transaction_id is not null),
      count(*) filter (where installment_group_id is not null)
    into transaction_count, group_count
    from import_item_claims where import_batch_id = existing_batch.id;

    return jsonb_build_object(
      'batch', to_jsonb(existing_batch),
      'imported_rows', existing_batch.imported_rows,
      'duplicate_rows', existing_batch.duplicate_rows,
      'error_rows', existing_batch.error_rows,
      'excluded_rows', (
        select count(*) from import_rows
        where import_batch_id = existing_batch.id and disposition = 'excluded'
      ),
      'transactions_created', transaction_count,
      'installment_groups_created', group_count,
      'replayed', true
    );
  end if;

  for item in select * from jsonb_array_elements(items_payload)
  loop
    if (item ->> 'household_id') is distinct from target_household_id::text then
      raise exception 'confirm_import_v2: item household_id mismatch'
        using errcode = '22023';
    end if;

    inserted_claim := null;
    existing_claim := null;
    inserted_tx := null;
    inserted_group := null;
    tx := nullif(item -> 'transaction', 'null'::jsonb);
    group_data := nullif(item -> 'installment_group', 'null'::jsonb);
    parcels := nullif(item -> 'installments', 'null'::jsonb);
    learning := nullif(item -> 'learning', 'null'::jsonb);
    source_learning := nullif(learning -> 'source_category', 'null'::jsonb);
    memory_learning := nullif(learning -> 'merchant_memory', 'null'::jsonb);
    item_disposition := coalesce(
      (item ->> 'disposition')::import_row_disposition,
      'imported'
    );

    if item_disposition = 'duplicate_existing' then
      raise exception 'confirm_import_v2: duplicate_existing is server-derived'
        using errcode = '22023';
    end if;

    if item_disposition <> 'imported' and (tx is not null or group_data is not null) then
      raise exception 'confirm_import_v2: audit-only item cannot carry an artifact'
        using errcode = '22023';
    end if;

    if item_disposition = 'imported' then
      if (tx is null) = (group_data is null) then
        raise exception 'confirm_import_v2: imported item needs exactly one artifact'
          using errcode = '22023';
      end if;
      if item ->> 'base_fingerprint' is null
         or (item ->> 'base_fingerprint') !~ '^[0-9a-f]{64}$'
         or coalesce((item ->> 'fingerprint_version')::integer, 0) < 1
         or coalesce((item ->> 'occurrence_no')::integer, 0) < 1 then
        raise exception 'confirm_import_v2: invalid item identity'
          using errcode = '22023';
      end if;
      if ((item ->> 'override_token') is null) <> ((item ->> 'override_of_claim_id') is null)
         or ((item ->> 'override_token') is not null and (item ->> 'override_reason') is null)
         or ((item ->> 'override_reason') is not null
           and length(btrim(item ->> 'override_reason')) not between 5 and 200) then
        raise exception 'confirm_import_v2: override token, claim, and reason must be supplied together'
          using errcode = '22023';
      end if;
      if item ->> 'override_of_claim_id' is not null then
        select * into existing_claim from import_item_claims
        where id = (item ->> 'override_of_claim_id')::uuid
          and household_id = target_household_id
          and source = target_source
          and fingerprint_version = (item ->> 'fingerprint_version')::smallint
          and base_fingerprint = item ->> 'base_fingerprint'
          and occurrence_no = (item ->> 'occurrence_no')::integer
          and override_token is null;
        if existing_claim.id is null then
          raise exception 'confirm_import_v2: override does not reference the conflicting natural claim'
            using errcode = '22023';
        end if;
      end if;

      artifact_kind := case when tx is not null
        then 'transaction'::import_artifact_kind
        else 'installment_group'::import_artifact_kind end;

      insert into import_item_claims (
        household_id, source, fingerprint_version, base_fingerprint,
        occurrence_no, artifact_kind, import_batch_id, source_line, override_token,
        override_of_claim_id, override_reason, override_by_user_id
      ) values (
        target_household_id,
        target_source,
        (item ->> 'fingerprint_version')::smallint,
        item ->> 'base_fingerprint',
        (item ->> 'occurrence_no')::integer,
        artifact_kind,
        inserted_batch.id,
        (item ->> 'source_line')::integer,
        (item ->> 'override_token')::uuid,
        (item ->> 'override_of_claim_id')::uuid,
        nullif(btrim(item ->> 'override_reason'), ''),
        case when item ->> 'override_token' is null then null
          else (batch_payload ->> 'created_by_user_id')::uuid end
      )
      on conflict do nothing
      returning * into inserted_claim;

      if inserted_claim.id is null then
        if item ->> 'override_token' is not null then
          select * into existing_claim from import_item_claims
          where household_id = target_household_id
            and override_token = (item ->> 'override_token')::uuid;
          if existing_claim.id is null
             or existing_claim.source is distinct from target_source
             or existing_claim.fingerprint_version is distinct from (item ->> 'fingerprint_version')::smallint
             or existing_claim.base_fingerprint is distinct from item ->> 'base_fingerprint'
             or existing_claim.occurrence_no is distinct from (item ->> 'occurrence_no')::integer
             or existing_claim.artifact_kind is distinct from artifact_kind
             or existing_claim.override_of_claim_id is distinct from (item ->> 'override_of_claim_id')::uuid then
            raise exception 'confirm_import_v2: override token belongs to another item'
              using errcode = '22023';
          end if;
        else
          select * into existing_claim from import_item_claims
          where household_id = target_household_id
            and source = target_source
            and fingerprint_version = (item ->> 'fingerprint_version')::smallint
            and base_fingerprint = item ->> 'base_fingerprint'
            and occurrence_no = (item ->> 'occurrence_no')::integer
            and override_token is null;
        end if;
        item_disposition := 'duplicate_existing';
      elsif tx is not null then
        if (tx ->> 'household_id') is distinct from target_household_id::text then
          raise exception 'confirm_import_v2: transaction household_id mismatch'
            using errcode = '22023';
        end if;
        if (tx ->> 'created_by_user_id') is distinct from target_created_by_user_id::text
           or (tx ->> 'installment_id') is not null
           or ((tx ->> 'responsible_user_id') is not null and not exists (
             select 1 from household_members
             where household_id = target_household_id
               and user_id = (tx ->> 'responsible_user_id')::uuid
               and is_active
           ))
           or ((tx ->> 'category_id') is not null and not exists (
             select 1 from categories
             where id = (tx ->> 'category_id')::uuid
               and household_id = target_household_id and is_active
           ))
           or ((tx ->> 'subcategory_id') is not null and not exists (
             select 1 from subcategories
             where id = (tx ->> 'subcategory_id')::uuid
               and household_id = target_household_id and is_active
               and category_id = (tx ->> 'category_id')::uuid
           )) then
          raise exception 'confirm_import_v2: invalid transaction attribution or taxonomy'
            using errcode = '42501';
        end if;
        insert into transactions (
          household_id, kind, amount_cents, occurred_on, description,
          category_id, subcategory_id, account_id, credit_card_id,
          installment_id, responsibility_scope, responsible_user_id,
          created_by_user_id, import_batch_id
        ) values (
          target_household_id,
          (tx ->> 'kind')::transaction_kind,
          (tx ->> 'amount_cents')::bigint,
          (tx ->> 'occurred_on')::date,
          tx ->> 'description',
          (tx ->> 'category_id')::uuid,
          (tx ->> 'subcategory_id')::uuid,
          (tx ->> 'account_id')::uuid,
          (tx ->> 'credit_card_id')::uuid,
          (tx ->> 'installment_id')::uuid,
          coalesce((tx ->> 'responsibility_scope')::responsibility_scope, 'household'),
          (tx ->> 'responsible_user_id')::uuid,
          (tx ->> 'created_by_user_id')::uuid,
          inserted_batch.id
        ) returning * into inserted_tx;

        update import_item_claims set transaction_id = inserted_tx.id
        where id = inserted_claim.id;
        transaction_count := transaction_count + 1;
      else
        if (group_data ->> 'household_id') is distinct from target_household_id::text
           or jsonb_typeof(parcels) is distinct from 'array'
           or exists (
             select 1 from jsonb_array_elements(parcels) p
             where (p ->> 'household_id') is distinct from target_household_id::text
                or (p ->> 'credit_card_id') is distinct from (group_data ->> 'credit_card_id')
           ) then
          raise exception 'confirm_import_v2: installment plan scope mismatch'
            using errcode = '22023';
        end if;
        if (group_data ->> 'created_by_user_id') is distinct from target_created_by_user_id::text
           or ((group_data ->> 'responsible_user_id') is not null and not exists (
             select 1 from household_members
             where household_id = target_household_id
               and user_id = (group_data ->> 'responsible_user_id')::uuid
               and is_active
           ))
           or ((group_data ->> 'category_id') is not null and not exists (
             select 1 from categories
             where id = (group_data ->> 'category_id')::uuid
               and household_id = target_household_id and is_active
           ))
           or ((group_data ->> 'subcategory_id') is not null and not exists (
             select 1 from subcategories
             where id = (group_data ->> 'subcategory_id')::uuid
               and household_id = target_household_id and is_active
               and category_id = (group_data ->> 'category_id')::uuid
           ))
           or exists (
             select 1 from jsonb_array_elements(parcels) p
             where (p ->> 'created_by_user_id') is distinct from target_created_by_user_id::text
                or ((p ->> 'responsible_user_id') is not null and not exists (
                  select 1 from household_members
                  where household_id = target_household_id
                    and user_id = (p ->> 'responsible_user_id')::uuid
                    and is_active
                ))
                or ((p ->> 'category_id') is not null and not exists (
                  select 1 from categories
                  where id = (p ->> 'category_id')::uuid
                    and household_id = target_household_id and is_active
                ))
                or ((p ->> 'subcategory_id') is not null and not exists (
                  select 1 from subcategories
                  where id = (p ->> 'subcategory_id')::uuid
                    and household_id = target_household_id and is_active
                    and category_id = (p ->> 'category_id')::uuid
                ))
           ) then
          raise exception 'confirm_import_v2: invalid installment attribution or taxonomy'
            using errcode = '42501';
        end if;

        insert into installment_groups (
          household_id, credit_card_id, description, total_amount_cents,
          installment_count, purchased_on, category_id, subcategory_id,
          responsibility_scope, responsible_user_id, created_by_user_id,
          import_batch_id
        ) values (
          target_household_id,
          (group_data ->> 'credit_card_id')::uuid,
          group_data ->> 'description',
          (group_data ->> 'total_amount_cents')::bigint,
          (group_data ->> 'installment_count')::integer,
          (group_data ->> 'purchased_on')::date,
          (group_data ->> 'category_id')::uuid,
          (group_data ->> 'subcategory_id')::uuid,
          coalesce((group_data ->> 'responsibility_scope')::responsibility_scope, 'household'),
          (group_data ->> 'responsible_user_id')::uuid,
          (group_data ->> 'created_by_user_id')::uuid,
          inserted_batch.id
        ) returning * into inserted_group;

        with parcel_data as (
          select p from jsonb_array_elements(parcels) p
        ), inserted as (
          insert into installments (
            household_id, installment_group_id, credit_card_id, number,
            installment_count, amount_cents, due_month, description,
            category_id, subcategory_id, responsibility_scope,
            responsible_user_id, created_by_user_id
          )
          select
            target_household_id,
            inserted_group.id,
            (p ->> 'credit_card_id')::uuid,
            (p ->> 'number')::integer,
            (p ->> 'installment_count')::integer,
            (p ->> 'amount_cents')::bigint,
            p ->> 'due_month',
            p ->> 'description',
            (p ->> 'category_id')::uuid,
            (p ->> 'subcategory_id')::uuid,
            coalesce((p ->> 'responsibility_scope')::responsibility_scope, 'household'),
            (p ->> 'responsible_user_id')::uuid,
            (p ->> 'created_by_user_id')::uuid
          from parcel_data
          returning *
        )
        select coalesce(jsonb_agg(to_jsonb(inserted) order by inserted.number), '[]'::jsonb)
        into inserted_parcels from inserted;

        select count(*), coalesce(sum(amount_cents), 0), bool_and(
          installment_count = inserted_group.installment_count
          and number between 1 and inserted_group.installment_count
        )
        into persisted_parcel_count, persisted_parcel_sum, parcel_shape_valid
        from installments where installment_group_id = inserted_group.id;

        if persisted_parcel_count <> inserted_group.installment_count
           or persisted_parcel_sum <> inserted_group.total_amount_cents
           or not coalesce(parcel_shape_valid, false) then
          raise exception 'confirm_import_v2: installments do not match group total/count'
            using errcode = '22023';
        end if;

        update import_item_claims set installment_group_id = inserted_group.id
        where id = inserted_claim.id;
        group_count := group_count + 1;
      end if;
    end if;

    if item_disposition = 'imported' then
      imported_count := imported_count + 1;
    elsif item_disposition in ('duplicate_existing', 'duplicate_in_file') then
      duplicate_count := duplicate_count + 1;
    elsif item_disposition in ('parser_error', 'validation_error') then
      error_count := error_count + 1;
    elsif item_disposition = 'excluded' then
      excluded_count := excluded_count + 1;
    end if;

    insert into import_rows (
      household_id, import_batch_id, source_line, occurred_on, amount_cents,
      description, error_message, is_duplicate, transaction_id,
      installment_group_id, claim_id, disposition, duplicate_of_claim_id,
      fingerprint_version, base_fingerprint, occurrence_no,
      observed_installment_number, observed_installment_count, card_last4,
      override_reason, category_source, category_confidence,
      category_accepted, category_changed
    ) values (
      target_household_id,
      inserted_batch.id,
      (item ->> 'source_line')::integer,
      (item ->> 'occurred_on')::date,
      (item ->> 'amount_cents')::bigint,
      item ->> 'description',
      item ->> 'error_message',
      item_disposition in ('duplicate_existing', 'duplicate_in_file'),
      inserted_tx.id,
      inserted_group.id,
      inserted_claim.id,
      item_disposition,
      existing_claim.id,
      (item ->> 'fingerprint_version')::smallint,
      item ->> 'base_fingerprint',
      (item ->> 'occurrence_no')::integer,
      (item ->> 'observed_installment_number')::integer,
      (item ->> 'observed_installment_count')::integer,
      nullif(item ->> 'card_last4', ''),
      nullif(btrim(item ->> 'override_reason'), ''),
      nullif(item ->> 'category_source', ''),
      (item ->> 'category_confidence')::numeric,
      (item ->> 'category_accepted')::boolean,
      (item ->> 'category_changed')::boolean
    );

    -- Learning is opt-in and rides in the same transaction as confirmation.
    -- A retry returns before this loop; a later import updates the same scoped
    -- rule instead of multiplying it.
    if source_learning is not null then
      if nullif(btrim(source_learning ->> 'normalized_label'), '') is null
         or length(source_learning ->> 'normalized_label') > 200
         or (source_learning ->> 'row_kind')::transaction_kind not in ('expense', 'income')
         or (
           coalesce((source_learning ->> 'suppress')::boolean, false)
           and ((source_learning ->> 'category_id') is not null
             or (source_learning ->> 'subcategory_id') is not null)
         )
         or (
           not coalesce((source_learning ->> 'suppress')::boolean, false)
           and (source_learning ->> 'category_id') is null
         )
         or ((source_learning ->> 'category_id') is not null and not exists (
           select 1 from categories
           where id = (source_learning ->> 'category_id')::uuid
             and household_id = target_household_id and is_active
         ))
         or ((source_learning ->> 'subcategory_id') is not null and not exists (
           select 1 from subcategories
           where id = (source_learning ->> 'subcategory_id')::uuid
             and household_id = target_household_id and is_active
             and category_id = (source_learning ->> 'category_id')::uuid
         )) then
        raise exception 'confirm_import_v2: invalid source-category learning payload'
          using errcode = '22023';
      end if;

      insert into source_category_mappings (
        household_id, source, normalized_label, row_kind, category_id,
        subcategory_id, suppress, is_active, created_by_user_id
      ) values (
        target_household_id,
        target_source,
        btrim(source_learning ->> 'normalized_label'),
        (source_learning ->> 'row_kind')::transaction_kind,
        (source_learning ->> 'category_id')::uuid,
        (source_learning ->> 'subcategory_id')::uuid,
        coalesce((source_learning ->> 'suppress')::boolean, false),
        true,
        (batch_payload ->> 'created_by_user_id')::uuid
      )
      on conflict (household_id, source, normalized_label, row_kind) do update set
        category_id = excluded.category_id,
        subcategory_id = excluded.subcategory_id,
        suppress = excluded.suppress,
        is_active = true,
        created_by_user_id = excluded.created_by_user_id,
        updated_at = now();
    end if;

    if memory_learning is not null then
      if nullif(btrim(memory_learning ->> 'pattern'), '') is null
         or length(memory_learning ->> 'pattern') > 200
         or (memory_learning ->> 'row_kind')::transaction_kind not in ('expense', 'income')
         or coalesce((memory_learning ->> 'confidence')::numeric, -1) not between 0 and 1
         or nullif(btrim(memory_learning ->> 'explanation'), '') is null
         or (
           coalesce((memory_learning ->> 'suppress')::boolean, false)
           and ((memory_learning ->> 'category_id') is not null
             or (memory_learning ->> 'subcategory_id') is not null)
         )
         or (
           not coalesce((memory_learning ->> 'suppress')::boolean, false)
           and (memory_learning ->> 'category_id') is null
         )
         or ((memory_learning ->> 'category_id') is not null and not exists (
           select 1 from categories
           where id = (memory_learning ->> 'category_id')::uuid
             and household_id = target_household_id and is_active
         ))
         or ((memory_learning ->> 'subcategory_id') is not null and not exists (
           select 1 from subcategories
           where id = (memory_learning ->> 'subcategory_id')::uuid
             and household_id = target_household_id and is_active
             and category_id = (memory_learning ->> 'category_id')::uuid
         )) then
        raise exception 'confirm_import_v2: invalid merchant-memory learning payload'
          using errcode = '22023';
      end if;

      update categorization_memory set is_active = false, updated_at = now()
      where household_id = target_household_id
        and pattern = btrim(memory_learning ->> 'pattern')
        and row_kind = (memory_learning ->> 'row_kind')::transaction_kind
        and not import_managed;

      insert into categorization_memory (
        household_id, pattern, row_kind, category_id, subcategory_id,
        suppress, match_kind, normalizer_version, confidence, explanation,
        is_active, import_managed, created_by_user_id
      ) values (
        target_household_id,
        btrim(memory_learning ->> 'pattern'),
        (memory_learning ->> 'row_kind')::transaction_kind,
        (memory_learning ->> 'category_id')::uuid,
        (memory_learning ->> 'subcategory_id')::uuid,
        coalesce((memory_learning ->> 'suppress')::boolean, false),
        case when coalesce((memory_learning ->> 'suppress')::boolean, false)
          then 'suppress' else coalesce(memory_learning ->> 'match_kind', 'merchant_exact') end,
        nullif(memory_learning ->> 'normalizer_version', ''),
        (memory_learning ->> 'confidence')::numeric,
        btrim(memory_learning ->> 'explanation'),
        true,
        true,
        (batch_payload ->> 'created_by_user_id')::uuid
      )
      on conflict (household_id, pattern, row_kind) where import_managed do update set
        category_id = excluded.category_id,
        subcategory_id = excluded.subcategory_id,
        suppress = excluded.suppress,
        match_kind = excluded.match_kind,
        normalizer_version = excluded.normalizer_version,
        confidence = excluded.confidence,
        explanation = excluded.explanation,
        is_active = true,
        import_managed = true,
        created_by_user_id = excluded.created_by_user_id,
        updated_at = now();
    end if;
  end loop;

  update import_batches set
    total_rows = imported_count + duplicate_count + error_count + excluded_count,
    imported_rows = imported_count,
    duplicate_rows = duplicate_count,
    error_rows = error_count,
    updated_at = now()
  where id = inserted_batch.id
  returning * into inserted_batch;

  return jsonb_build_object(
    'batch', to_jsonb(inserted_batch),
    'imported_rows', imported_count,
    'duplicate_rows', duplicate_count,
    'error_rows', error_count,
    'excluded_rows', excluded_count,
    'transactions_created', transaction_count,
    'installment_groups_created', group_count,
    'replayed', false
  );
end;
$$;

revoke all on function confirm_import_v2(jsonb, jsonb) from public;
do $$ begin
  revoke all on function confirm_import_v2(jsonb, jsonb) from anon;
exception when undefined_object then null; end $$;
do $$ begin
  grant execute on function confirm_import_v2(jsonb, jsonb) to authenticated;
exception when undefined_object then null; end $$;
do $$ begin
  grant execute on function confirm_import_v2(jsonb, jsonb) to service_role;
exception when undefined_object then null; end $$;
