-- 0013_composite_household_fks.sql
-- Enforce household consistency of category/subcategory/account/card references
-- at the SCHEMA level, so no write path can point a row at another household's
-- category, account, or card.
--
-- Why: the single-column FKs (`category_id references categories(id)`) only
-- prove the referenced row EXISTS somewhere — not that it belongs to the SAME
-- household as the referencing row. The SECURITY DEFINER RPCs
-- (create_installment_purchase / confirm_import / merge_category) re-assert
-- membership of the row's household but never validate that a supplied
-- category/account/card id is in that household, and plain RLS-gated inserts
-- share the gap. A member could therefore set their own rows' category/card to
-- a foreign id (no data leak — RLS still hides the other household's rows — but
-- the reference is inconsistent and renders as "missing category").
--
-- Fix (the reviewer's "composite (household_id, id) FKs long-term"): add a
-- UNIQUE(household_id, id) on each parent and a composite FK
-- (household_id, <ref>) on each child. Composite FKs use MATCH SIMPLE, so a
-- NULL in the nullable ref column leaves the FK unchecked (uncategorized /
-- account-less rows stay valid); when the ref is set, both columns are non-null
-- and Postgres enforces same-household membership for ALL write paths at once.
--
-- Every statement is guarded (duplicate_object / duplicate_table swallowed) so
-- the migration is re-runnable.

-- --- Parent UNIQUE(household_id, id) targets ------------------------------
do $$ begin
  alter table categories    add constraint categories_household_id_uniq    unique (household_id, id);
exception when duplicate_object or duplicate_table then null; end $$;
do $$ begin
  alter table subcategories add constraint subcategories_household_id_uniq unique (household_id, id);
exception when duplicate_object or duplicate_table then null; end $$;
do $$ begin
  alter table accounts      add constraint accounts_household_id_uniq      unique (household_id, id);
exception when duplicate_object or duplicate_table then null; end $$;
do $$ begin
  alter table credit_cards  add constraint credit_cards_household_id_uniq  unique (household_id, id);
exception when duplicate_object or duplicate_table then null; end $$;

-- --- Child composite FKs ---------------------------------------------------
-- Each references the SAME-household parent row. on delete set null mirrors the
-- existing single-column FK behavior for the nullable refs.

-- transactions
do $$ begin
  alter table transactions add constraint transactions_hh_category_fk
    foreign key (household_id, category_id) references categories (household_id, id) on delete set null;
exception when duplicate_object then null; end $$;
do $$ begin
  alter table transactions add constraint transactions_hh_subcategory_fk
    foreign key (household_id, subcategory_id) references subcategories (household_id, id) on delete set null;
exception when duplicate_object then null; end $$;
do $$ begin
  alter table transactions add constraint transactions_hh_account_fk
    foreign key (household_id, account_id) references accounts (household_id, id) on delete restrict;
exception when duplicate_object then null; end $$;
do $$ begin
  alter table transactions add constraint transactions_hh_card_fk
    foreign key (household_id, credit_card_id) references credit_cards (household_id, id) on delete restrict;
exception when duplicate_object then null; end $$;

-- installment_groups
do $$ begin
  alter table installment_groups add constraint installment_groups_hh_category_fk
    foreign key (household_id, category_id) references categories (household_id, id) on delete set null;
exception when duplicate_object then null; end $$;
do $$ begin
  alter table installment_groups add constraint installment_groups_hh_subcategory_fk
    foreign key (household_id, subcategory_id) references subcategories (household_id, id) on delete set null;
exception when duplicate_object then null; end $$;
do $$ begin
  alter table installment_groups add constraint installment_groups_hh_card_fk
    foreign key (household_id, credit_card_id) references credit_cards (household_id, id) on delete restrict;
exception when duplicate_object then null; end $$;

-- installments
do $$ begin
  alter table installments add constraint installments_hh_category_fk
    foreign key (household_id, category_id) references categories (household_id, id) on delete set null;
exception when duplicate_object then null; end $$;
do $$ begin
  alter table installments add constraint installments_hh_subcategory_fk
    foreign key (household_id, subcategory_id) references subcategories (household_id, id) on delete set null;
exception when duplicate_object then null; end $$;
do $$ begin
  alter table installments add constraint installments_hh_card_fk
    foreign key (household_id, credit_card_id) references credit_cards (household_id, id) on delete restrict;
exception when duplicate_object then null; end $$;

-- subcategories (must sit under a same-household macro category)
do $$ begin
  alter table subcategories add constraint subcategories_hh_category_fk
    foreign key (household_id, category_id) references categories (household_id, id) on delete cascade;
exception when duplicate_object then null; end $$;

-- categorization_memory
do $$ begin
  alter table categorization_memory add constraint categorization_memory_hh_category_fk
    foreign key (household_id, category_id) references categories (household_id, id) on delete set null;
exception when duplicate_object then null; end $$;
do $$ begin
  alter table categorization_memory add constraint categorization_memory_hh_subcategory_fk
    foreign key (household_id, subcategory_id) references subcategories (household_id, id) on delete set null;
exception when duplicate_object then null; end $$;

-- obligations (migration 0011 — account-paid, optionally categorized)
do $$ begin
  alter table obligations add constraint obligations_hh_account_fk
    foreign key (household_id, account_id) references accounts (household_id, id) on delete restrict;
exception when duplicate_object then null; end $$;
do $$ begin
  alter table obligations add constraint obligations_hh_category_fk
    foreign key (household_id, category_id) references categories (household_id, id) on delete set null;
exception when duplicate_object then null; end $$;
do $$ begin
  alter table obligations add constraint obligations_hh_subcategory_fk
    foreign key (household_id, subcategory_id) references subcategories (household_id, id) on delete set null;
exception when duplicate_object then null; end $$;
