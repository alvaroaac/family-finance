-- Optional purchase labels preserve the imported bank name and original audit rows.
-- Replace the atomic confirmation function so reviewed existing purchases can be
-- linked without changing their values, dates, categories, or number of parcels.
alter table installment_groups add column if not exists purchase_description text;
do $$ begin
  alter table installment_groups add constraint installment_purchase_description_length
    check (purchase_description is null or length(btrim(purchase_description)) between 1 and 200);
exception when duplicate_object then null; end $$;

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
  selected_group installment_groups;
  label text;
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
    selected_group := null;
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

    if item ->> 'existing_installment_group_id' is not null and
       (item_disposition <> 'imported' or group_data is null or tx is not null or
        item ->> 'override_token' is not null or item ->> 'override_reason' is not null) then
      raise exception 'confirm_import_v2: invalid existing purchase link' using errcode = '22023';
    end if;

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
      elsif item ->> 'existing_installment_group_id' is not null then
        -- The claim now points at a reviewed existing purchase, not a new plan.
        -- Scope, stale-preview and amount checks below run before any update.
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

    if item ->> 'existing_installment_group_id' is not null then
      select * into selected_group from installment_groups
      where id = (item ->> 'existing_installment_group_id')::uuid
        and household_id = target_household_id
      for update;
      if selected_group.id is null
         or (group_data ->> 'household_id') is distinct from target_household_id::text
         or selected_group.credit_card_id is distinct from (group_data ->> 'credit_card_id')::uuid
         or selected_group.installment_count is distinct from (item ->> 'observed_installment_count')::integer
         or selected_group.updated_at is distinct from (item ->> 'expected_group_updated_at')::timestamptz
         or (existing_claim.id is not null and existing_claim.installment_group_id is distinct from selected_group.id)
         or not exists (
           select 1 from installments p
           where p.installment_group_id = selected_group.id
             and p.household_id = target_household_id
             and p.due_month = item ->> 'observed_due_month'
             and abs(p.amount_cents - abs((item ->> 'amount_cents')::bigint))
               <= least(1000, round(abs((item ->> 'amount_cents')::numeric) * 0.10))
         ) then
        raise exception 'confirm_import_v2: existing purchase changed or does not match' using errcode = '22023';
      end if;
      if (select count(*) from jsonb_array_elements(items_payload) candidate
          where candidate ->> 'existing_installment_group_id' = selected_group.id::text) <> 1 then
        raise exception 'confirm_import_v2: purchase linked more than once' using errcode = '22023';
      end if;
      if nullif(btrim(group_data ->> 'description'), '') is null
         or length(group_data ->> 'description') > 200 then
        raise exception 'confirm_import_v2: invalid bank description' using errcode = '22023';
      end if;
      inserted_group := selected_group;
      if inserted_claim.id is not null then
        update import_item_claims set installment_group_id = selected_group.id where id = inserted_claim.id;
      end if;
    end if;

    -- Preserve source text in import_rows, and store the user's label separately.
    -- An unrelated duplicate claim must never rename a purchase.
    if inserted_group.id is not null then
      label := nullif(btrim(group_data ->> 'purchase_description'), '');
      if not (group_data ? 'purchase_description') and selected_group.id is not null then
        label := coalesce(selected_group.purchase_description, selected_group.description);
      end if;
      if lower(regexp_replace(btrim(label), '\s+', ' ', 'g')) =
         lower(regexp_replace(btrim(group_data ->> 'description'), '\s+', ' ', 'g')) then
        label := null;
      end if;
      update installment_groups set
        description = group_data ->> 'description', purchase_description = label
      where id = inserted_group.id;
      -- Parcel descriptions are display text; import identities use the original group name.
      update installments set description = coalesce(label, group_data ->> 'description')
      where installment_group_id = inserted_group.id;
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

-- Preserve both descriptions in the existing manual-expense conversion path.
create or replace function confirm_import_with_replacements(batch_payload jsonb, items_payload jsonb)
returns jsonb language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  household uuid := (batch_payload->>'household_id')::uuid;
  request_id uuid := (batch_payload->>'request_key')::uuid;
  item jsonb;
  original transactions;
  group_data jsonb;
  preserved jsonb;
  adjusted jsonb := '[]'::jsonb;
  originals jsonb := '{}'::jsonb;
  replacement_id uuid;
  new_group_id uuid;
  result jsonb;
  batch_id uuid;
begin
  if household is null or request_id is null or not is_household_member(household)
     or (batch_payload->>'created_by_user_id')::uuid is distinct from auth.uid() then
    raise exception 'Replacement requires an authenticated household member' using errcode = '42501';
  end if;
  if jsonb_typeof(items_payload) is distinct from 'array' then
    raise exception 'Invalid replacement items' using errcode = '22023';
  end if;
  -- Serialize retries before locking originals; bind retries to their exact intent.
  perform pg_advisory_xact_lock(hashtextextended(household::text || request_id::text, 0));
  batch_payload := batch_payload || jsonb_build_object('payload_fingerprint',
    encode(digest(coalesce(batch_payload->>'payload_fingerprint', '') || items_payload::text, 'sha256'), 'hex'));
  if exists(select 1 from import_batches where household_id = household and request_key = request_id) then
    return confirm_import_v2(batch_payload, items_payload);
  end if;
  perform 1 from transactions where household_id = household and id in (
    select (entry->'replace_transaction'->>'id')::uuid
    from jsonb_array_elements(items_payload) entry where entry ? 'replace_transaction'
  ) order by id for update;

  for item in select value from jsonb_array_elements(items_payload) loop
    if item ? 'replace_transaction' then
      replacement_id := (item->'replace_transaction'->>'id')::uuid;
      if replacement_id is null or originals ? replacement_id::text then
        raise exception 'A transaction can replace only one purchase' using errcode = '22023';
      end if;
      select * into original from transactions where id = replacement_id and household_id = household;
      group_data := item->'installment_group';
      if not found or original.kind <> 'expense' or original.installment_id is not null
         or original.import_batch_id is not null or original.obligation_id is not null
         or original.updated_at is distinct from (item->'replace_transaction'->>'updated_at')::timestamptz
         or item->>'disposition' is distinct from 'imported' or group_data is null
         or item ? 'transaction' or item ? 'existing_installment_group_id'
         or original.amount_cents is distinct from (group_data->>'total_amount_cents')::bigint
         or date_trunc('month', original.occurred_on) is distinct from date_trunc('month', (group_data->>'purchased_on')::date)
         or import_purchase_name(original.description) = ''
         or import_purchase_name(original.description) is distinct from import_purchase_name(group_data->>'description') then
        raise exception 'O lançamento mudou ou não corresponde à compra. Atualize a revisão.' using errcode = '22023';
      end if;
      originals := originals || jsonb_build_object(replacement_id::text,
        to_jsonb(original) || jsonb_build_object('bot_interactions',
          (select coalesce(jsonb_agg(to_jsonb(b)), '[]'::jsonb) from bot_interactions b where transaction_id = original.id)));
      preserved := jsonb_build_object('category_id', original.category_id,
        'subcategory_id', original.subcategory_id,
        'purchase_description', case when group_data ? 'purchase_description' then group_data->>'purchase_description' else original.description end,
        'responsibility_scope', original.responsibility_scope, 'responsible_user_id', original.responsible_user_id);
      item := item || jsonb_build_object('installment_group', group_data || preserved,
        'installments', (select jsonb_agg(p || preserved) from jsonb_array_elements(item->'installments') p));
    end if;
    adjusted := adjusted || jsonb_build_array(item);
  end loop;

  result := confirm_import_v2(batch_payload, adjusted);
  batch_id := (result->'batch'->>'id')::uuid;
  for item in select value from jsonb_array_elements(adjusted) where value ? 'replace_transaction' loop
    replacement_id := (item->'replace_transaction'->>'id')::uuid;
    select installment_group_id into new_group_id from import_rows
      where import_batch_id = batch_id and household_id = household and disposition = 'imported'
        and base_fingerprint = item->>'base_fingerprint' and occurrence_no = (item->>'occurrence_no')::integer;
    if new_group_id is null then
      raise exception 'A compra já foi importada. O lançamento original foi mantido.' using errcode = '22023';
    end if;
    insert into import_transaction_replacements(original_transaction_id, household_id, import_batch_id,
      installment_group_id, original_record, replaced_by)
    values(replacement_id, household, batch_id, new_group_id, originals->replacement_id::text, auth.uid());
    delete from transactions where id = replacement_id and household_id = household;
  end loop;
  return result;
end $$;
revoke all on function confirm_import_with_replacements(jsonb, jsonb) from public, anon;
grant execute on function confirm_import_with_replacements(jsonb, jsonb) to authenticated;
