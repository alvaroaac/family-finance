/**
 * Hand-written database types for the Family Finance schema.
 *
 * These mirror `supabase/migrations/0001_initial_schema.sql` and are static —
 * no live Supabase connection is required to typecheck this package. When the
 * Supabase CLI becomes available locally, generated types could replace these,
 * but the shape and column names must stay in sync with the migration.
 *
 * Money is always stored as integer cents (see the domain `MoneyAmount`
 * contract); here that surfaces as `*_cents` numeric columns.
 */

// --- Enum-like column unions (mirror the SQL enum types) -------------------

export type AccountKind = "checking" | "investment";
export type TransactionKind = "expense" | "income" | "transfer";
export type InvestmentBucketSlug =
  | "filhos"
  | "casa"
  | "independencia_financeira";
export type ImportSource = "minhas_financas_csv" | "nubank_csv";
export type ImportBatchStatus =
  | "pending"
  | "previewed"
  | "confirmed"
  | "discarded";
export type ResponsibilityScope = "household" | "user";
export type BotChannel = "telegram";

// --- Row shapes ------------------------------------------------------------

export type HouseholdRow = {
  id: string;
  name: string;
  created_at: string;
  updated_at: string;
};

export type HouseholdMemberRow = {
  id: string;
  household_id: string;
  user_id: string;
  role: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
};

export type AccountRow = {
  id: string;
  household_id: string;
  kind: AccountKind;
  name: string;
  created_at: string;
  updated_at: string;
};

export type InvestmentBucketRow = {
  id: string;
  household_id: string;
  slug: InvestmentBucketSlug;
  name: string;
  created_at: string;
  updated_at: string;
};

export type CreditCardRow = {
  id: string;
  household_id: string;
  name: string;
  closing_day: number | null;
  due_day: number | null;
  created_at: string;
  updated_at: string;
};

export type CategoryRow = {
  id: string;
  household_id: string;
  name: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
};

export type SubcategoryRow = {
  id: string;
  household_id: string;
  category_id: string;
  name: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
};

export type TransactionRow = {
  id: string;
  household_id: string;
  kind: TransactionKind;
  amount_cents: number;
  occurred_on: string;
  description: string;
  category_id: string | null;
  subcategory_id: string | null;
  account_id: string | null;
  credit_card_id: string | null;
  installment_id: string | null;
  responsibility_scope: ResponsibilityScope;
  responsible_user_id: string | null;
  created_by_user_id: string;
  import_batch_id: string | null;
  created_at: string;
  updated_at: string;
};

export type InstallmentGroupRow = {
  id: string;
  household_id: string;
  credit_card_id: string;
  description: string;
  total_amount_cents: number;
  installment_count: number;
  purchased_on: string;
  category_id: string | null;
  subcategory_id: string | null;
  responsibility_scope: ResponsibilityScope;
  responsible_user_id: string | null;
  created_by_user_id: string;
  created_at: string;
  updated_at: string;
};

export type InstallmentRow = {
  id: string;
  household_id: string;
  installment_group_id: string;
  credit_card_id: string;
  number: number;
  installment_count: number;
  amount_cents: number;
  due_month: string;
  description: string;
  category_id: string | null;
  subcategory_id: string | null;
  responsibility_scope: ResponsibilityScope;
  responsible_user_id: string | null;
  created_by_user_id: string;
  created_at: string;
  updated_at: string;
};

export type ImportBatchRow = {
  id: string;
  household_id: string;
  source: ImportSource;
  status: ImportBatchStatus;
  total_rows: number;
  imported_rows: number;
  duplicate_rows: number;
  error_rows: number;
  notes: string | null;
  created_by_user_id: string;
  created_at: string;
  updated_at: string;
};

export type ImportRowRow = {
  id: string;
  household_id: string;
  import_batch_id: string;
  source_line: number | null;
  occurred_on: string | null;
  amount_cents: number | null;
  description: string | null;
  error_message: string | null;
  is_duplicate: boolean;
  transaction_id: string | null;
  created_at: string;
  updated_at: string;
};

export type CategorizationMemoryRow = {
  id: string;
  household_id: string;
  pattern: string;
  category_id: string | null;
  subcategory_id: string | null;
  confidence: number;
  explanation: string;
  is_active: boolean;
  created_by_user_id: string | null;
  created_at: string;
  updated_at: string;
};

export type BotInteractionRow = {
  id: string;
  household_id: string;
  channel: BotChannel;
  external_chat_id: string | null;
  user_id: string | null;
  input_kind: string;
  message_text: string | null;
  confidence: number | null;
  explanation: string | null;
  transaction_id: string | null;
  created_at: string;
  updated_at: string;
};

// --- Insert shapes ---------------------------------------------------------
//
// Insert types omit DB-managed columns (id, timestamps) which carry defaults,
// and make defaulted columns optional. They are intentionally narrow so callers
// must supply household_id explicitly on every write path.

type Insertable<Row, Optional extends keyof Row> =
  Omit<Row, "id" | "created_at" | "updated_at"> extends infer Base
    ? Omit<Base, Optional & keyof Base> &
        Partial<Pick<Base, Optional & keyof Base>>
    : never;

export type TransactionInsert = Insertable<
  TransactionRow,
  | "category_id"
  | "subcategory_id"
  | "account_id"
  | "credit_card_id"
  | "installment_id"
  | "responsibility_scope"
  | "responsible_user_id"
  | "import_batch_id"
>;

export type ImportBatchInsert = Insertable<
  ImportBatchRow,
  | "status"
  | "total_rows"
  | "imported_rows"
  | "duplicate_rows"
  | "error_rows"
  | "notes"
>;

export type CategorizationMemoryInsert = Insertable<
  CategorizationMemoryRow,
  "category_id" | "subcategory_id" | "is_active" | "created_by_user_id"
>;

export type BotInteractionInsert = Insertable<
  BotInteractionRow,
  | "external_chat_id"
  | "user_id"
  | "message_text"
  | "confidence"
  | "explanation"
  | "transaction_id"
>;

// --- Installment purchase RPC payloads -------------------------------------
//
// These are the exact column-keyed shapes the repository mappers build and the
// `create_installment_purchase` plpgsql function consumes (see
// supabase/migrations/0002_create_installment_purchase.sql). Keeping them here
// as the single source of truth keeps the mapper return types and the RPC Args
// in sync. `installment_group_id` is set by the function from the freshly
// inserted group id, so it is NOT part of the parcel payload.

export type InstallmentGroupInsertPayload = Pick<
  InstallmentGroupRow,
  | "household_id"
  | "credit_card_id"
  | "description"
  | "total_amount_cents"
  | "installment_count"
  | "purchased_on"
  | "category_id"
  | "subcategory_id"
  | "responsibility_scope"
  | "responsible_user_id"
  | "created_by_user_id"
>;

export type InstallmentInsertPayload = Pick<
  InstallmentRow,
  | "household_id"
  | "credit_card_id"
  | "number"
  | "installment_count"
  | "amount_cents"
  | "due_month"
  | "description"
  | "category_id"
  | "subcategory_id"
  | "responsibility_scope"
  | "responsible_user_id"
  | "created_by_user_id"
>;

// --- Database surface (compatible with @supabase/supabase-js generics) ------

type TableDef<Row, Insert> = {
  Row: Row;
  Insert: Insert;
  Update: Partial<Insert>;
  Relationships: [];
};

export type Database = {
  public: {
    Tables: {
      households: TableDef<HouseholdRow, Partial<HouseholdRow>>;
      household_members: TableDef<
        HouseholdMemberRow,
        Partial<HouseholdMemberRow>
      >;
      accounts: TableDef<AccountRow, Partial<AccountRow>>;
      investment_buckets: TableDef<
        InvestmentBucketRow,
        Partial<InvestmentBucketRow>
      >;
      credit_cards: TableDef<CreditCardRow, Partial<CreditCardRow>>;
      categories: TableDef<CategoryRow, Partial<CategoryRow>>;
      subcategories: TableDef<SubcategoryRow, Partial<SubcategoryRow>>;
      transactions: TableDef<TransactionRow, TransactionInsert>;
      installment_groups: TableDef<
        InstallmentGroupRow,
        Partial<InstallmentGroupRow>
      >;
      installments: TableDef<InstallmentRow, Partial<InstallmentRow>>;
      import_batches: TableDef<ImportBatchRow, ImportBatchInsert>;
      import_rows: TableDef<ImportRowRow, Partial<ImportRowRow>>;
      categorization_memory: TableDef<
        CategorizationMemoryRow,
        CategorizationMemoryInsert
      >;
      bot_interactions: TableDef<BotInteractionRow, BotInteractionInsert>;
    };
    Views: Record<string, never>;
    Functions: {
      is_household_member: {
        Args: { target_household_id: string };
        Returns: boolean;
      };
      // Atomic parcelado write (group + installments in one transaction).
      // See supabase/migrations/0002_create_installment_purchase.sql. Returns
      // `{ group, installments }` as JSON; the repository casts it to rows.
      create_installment_purchase: {
        Args: {
          group_payload: InstallmentGroupInsertPayload;
          installments_payload: InstallmentInsertPayload[];
        };
        Returns: {
          group: InstallmentGroupRow;
          installments: InstallmentRow[];
        };
      };
    };
    Enums: {
      account_kind: AccountKind;
      transaction_kind: TransactionKind;
      investment_bucket_slug: InvestmentBucketSlug;
      import_source: ImportSource;
      import_batch_status: ImportBatchStatus;
      responsibility_scope: ResponsibilityScope;
      bot_channel: BotChannel;
    };
  };
};
