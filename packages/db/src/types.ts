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
export type ImportSource =
  | "minhas_financas_csv"
  | "nubank_csv"
  | "mercado_pago_pdf";
export type ImportBatchStatus =
  | "pending"
  | "previewed"
  | "confirmed"
  | "discarded";
export type ImportArtifactKind = "transaction" | "installment_group";
export type ImportRowDisposition =
  | "imported"
  | "duplicate_existing"
  | "duplicate_in_file"
  | "parser_error"
  | "validation_error"
  | "excluded";
export type CategorizationMemoryMatchKind =
  | "merchant_exact"
  | "merchant_prefix"
  | "description_contains"
  | "suppress";
export type ResponsibilityScope = "household" | "user";
export type BotChannel = "telegram";
export type ObligationStatus = "active" | "ended" | "canceled";

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
  display_name: string | null;
  telegram_user_id: number | null;
  telegram_username: string | null;
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
  balance_cents: number;
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

export type CategoryKind = "expense" | "income";

export type CategoryRow = {
  id: string;
  household_id: string;
  name: string;
  kind: CategoryKind;
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
  /** Set when this row materializes an obligation month (migration 0011). */
  obligation_id: string | null;
  /** First day of the satisfied month (date), when obligation_id is set. */
  obligation_month: string | null;
  /** Set on the kind='transfer' card-bill settle row (migration 0015). */
  bill_month: string | null;
  created_at: string;
  updated_at: string;
};

/**
 * A recurring fixed obligation TEMPLATE (migration 0011). Months are projected
 * from it; marking a month paid materializes one transactions row linked via
 * obligation_id/obligation_month.
 */
export type ObligationRow = {
  id: string;
  household_id: string;
  description: string;
  amount_cents: number;
  /** `YYYY-MM` first month due. */
  start_month: string;
  /** Fixed term in months, or null = indefinite. */
  term_months: number | null;
  /** 1–28. */
  due_day: number;
  category_id: string | null;
  subcategory_id: string | null;
  responsibility_scope: ResponsibilityScope;
  responsible_user_id: string | null;
  account_id: string;
  status: ObligationStatus;
  created_by_user_id: string;
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
  /** Stable caller token used to replay a purchase without duplicating it. */
  idempotency_key: string | null;
  /** Set when the group was reconstructed by confirm_import_v2. */
  import_batch_id: string | null;
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
  request_key: string | null;
  payload_fingerprint: string | null;
  file_fingerprint: string | null;
  parser_version: string | null;
  normalized_fingerprint: string | null;
  confirmed_at: string | null;
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
  installment_group_id: string | null;
  claim_id: string | null;
  disposition: ImportRowDisposition | null;
  duplicate_of_claim_id: string | null;
  fingerprint_version: number | null;
  base_fingerprint: string | null;
  occurrence_no: number | null;
  observed_installment_number: number | null;
  observed_installment_count: number | null;
  card_last4: string | null;
  override_reason: string | null;
  category_source: string | null;
  category_confidence: number | null;
  category_accepted: boolean | null;
  category_changed: boolean | null;
  created_at: string;
  updated_at: string;
};

export type ImportItemClaimRow = {
  id: string;
  household_id: string;
  source: ImportSource;
  fingerprint_version: number;
  base_fingerprint: string;
  occurrence_no: number;
  artifact_kind: ImportArtifactKind;
  import_batch_id: string;
  transaction_id: string | null;
  installment_group_id: string | null;
  source_line: number | null;
  override_token: string | null;
  override_of_claim_id: string | null;
  override_reason: string | null;
  override_by_user_id: string | null;
  created_at: string;
};

export type CategorizationMemoryRow = {
  id: string;
  household_id: string;
  pattern: string;
  row_kind: "expense" | "income";
  category_id: string | null;
  subcategory_id: string | null;
  confidence: number;
  explanation: string;
  suppress: boolean;
  match_kind: CategorizationMemoryMatchKind | null;
  normalizer_version: string | null;
  import_managed: boolean;
  is_active: boolean;
  created_by_user_id: string | null;
  created_at: string;
  updated_at: string;
};

export type SourceCategoryMappingRow = {
  id: string;
  household_id: string;
  source: ImportSource;
  normalized_label: string;
  row_kind: "expense" | "income";
  category_id: string | null;
  subcategory_id: string | null;
  suppress: boolean;
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

/**
 * Persisted bot conversation state, keyed by the Telegram chat id. NOT
 * household-scoped: rows exist before the sender is resolved to a member, and
 * the table has RLS enabled with zero policies, so only the bot's
 * service_role client (which bypasses RLS) can read or write it.
 */
export type BotConversationRow = {
  chat_id: number;
  state: unknown;
  updated_at: string;
};

export type BotConversationInsert = {
  chat_id: number;
  state: unknown;
  updated_at?: string;
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
  | "obligation_id"
  | "obligation_month"
  | "bill_month"
>;

export type ObligationInsert = Insertable<
  ObligationRow,
  | "category_id"
  | "subcategory_id"
  | "responsibility_scope"
  | "responsible_user_id"
  | "term_months"
  | "status"
>;

/**
 * Shape returned by `materialize_obligation_payment` (migration 0011): the
 * materialized (or pre-existing) transactions row plus whether the month had
 * already been paid (idempotent no-op).
 */
export type MaterializeObligationPaymentResult = {
  transaction: TransactionRow;
  already_paid: boolean;
};

/**
 * Shape returned by `settle_card_bill` (migration 0015): the settled (or
 * pre-existing) kind='transfer' transactions row plus whether the bill month
 * had already been paid (idempotent no-op).
 */
export type SettleCardBillResult = {
  transaction: TransactionRow;
  already_paid: boolean;
};

export type ImportBatchInsert = Insertable<
  ImportBatchRow,
  | "status"
  | "total_rows"
  | "imported_rows"
  | "duplicate_rows"
  | "error_rows"
  | "notes"
  | "request_key"
  | "payload_fingerprint"
  | "file_fingerprint"
  | "parser_version"
  | "confirmed_at"
>;

export type CategorizationMemoryInsert = Insertable<
  CategorizationMemoryRow,
  | "category_id"
  | "subcategory_id"
  | "row_kind"
  | "suppress"
  | "match_kind"
  | "normalizer_version"
  | "import_managed"
  | "is_active"
  | "created_by_user_id"
>;

export type SourceCategoryMappingInsert = Insertable<
  SourceCategoryMappingRow,
  "subcategory_id" | "suppress" | "is_active" | "created_by_user_id"
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
  | "idempotency_key"
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

// --- Confirm import RPC payloads + result ----------------------------------
//
// Shapes the `confirm_import` plpgsql function consumes/returns (see
// supabase/migrations/0004_confirm_import.sql). The repository validates each
// selected normalized row into a transaction draft in TypeScript (so the domain
// rules + per-row error reporting stay in the app), then hands the function the
// batch summary plus one entry per audit row. An entry that produced a
// transaction carries a `transaction` insert payload (WITHOUT import_batch_id —
// the function fills it from the batch it inserts in the same transaction); an
// error/duplicate/skipped entry carries only the normalized audit fields.

/** The import_batches summary the confirm RPC inserts (counts only, no file). */
export type ConfirmImportBatchPayload = Pick<
  ImportBatchRow,
  | "household_id"
  | "source"
  | "status"
  | "total_rows"
  | "imported_rows"
  | "duplicate_rows"
  | "error_rows"
  | "notes"
  | "created_by_user_id"
>;

/**
 * One audit row for the confirm RPC. The normalized fields populate import_rows;
 * `transaction`, when present, is inserted (linked to the batch) and its id is
 * written back onto the audit row's `transaction_id`. `transaction` omits
 * `import_batch_id` — the function sets it from the freshly inserted batch id.
 */
export type ConfirmImportRowPayload = Pick<
  ImportRowRow,
  | "household_id"
  | "source_line"
  | "occurred_on"
  | "amount_cents"
  | "description"
  | "error_message"
  | "is_duplicate"
> & {
  transaction?: Omit<TransactionInsert, "import_batch_id"> | null;
};

/**
 * Shape returned by `confirm_import`: the stored batch row plus the count of
 * transactions actually written (mirrors the function's jsonb result).
 */
export type ConfirmImportResult = {
  batch: ImportBatchRow;
  imported_rows: number;
};

// --- Reliable import v2 RPC ------------------------------------------------

export type ConfirmImportV2BatchPayload = {
  household_id: string;
  source: ImportSource;
  /** Stable per-preview UUID; the same key must be reused on retries. */
  request_key: string;
  /** SHA-256 hex of the immutable reviewed payload. */
  payload_fingerprint: string;
  created_by_user_id: string;
  notes?: string | null;
  file_fingerprint?: string | null;
  parser_version?: string | null;
  normalized_fingerprint?: string | null;
};

export type ImportCategoryLearning = {
  row_kind: "expense" | "income";
  category_id: string | null;
  subcategory_id?: string | null;
  suppress: boolean;
};

export type ConfirmImportV2Learning = {
  source_category?:
    | (ImportCategoryLearning & {
        normalized_label: string;
      })
    | null;
  merchant_memory?:
    | (ImportCategoryLearning & {
        pattern: string;
        confidence: number;
        explanation: string;
        match_kind?: Exclude<CategorizationMemoryMatchKind, "suppress">;
        normalizer_version?: string | null;
      })
    | null;
};

type ConfirmImportV2AuditFields = {
  household_id: string;
  disposition: Exclude<ImportRowDisposition, "duplicate_existing">;
  source_line?: number | null;
  occurred_on?: string | null;
  /** Signed source amount for audit; transaction payload stays positive. */
  amount_cents?: number | null;
  description?: string | null;
  error_message?: string | null;
  fingerprint_version?: number | null;
  base_fingerprint?: string | null;
  occurrence_no?: number | null;
  observed_installment_number?: number | null;
  observed_installment_count?: number | null;
  card_last4?: string | null;
  override_reason?: string | null;
  category_source?: string | null;
  category_confidence?: number | null;
  category_accepted?: boolean | null;
  category_changed?: boolean | null;
  /** Present only after the user explicitly opts in to teaching the mapping. */
  learning?: ConfirmImportV2Learning | null;
};

export type ConfirmImportV2TransactionItem = ConfirmImportV2AuditFields & {
  disposition: "imported";
  fingerprint_version: number;
  base_fingerprint: string;
  occurrence_no: number;
  override_token?: string | null;
  override_of_claim_id?: string | null;
  transaction: Omit<TransactionInsert, "import_batch_id">;
  installment_group?: never;
  installments?: never;
};

export type ConfirmImportV2InstallmentItem = ConfirmImportV2AuditFields & {
  disposition: "imported";
  fingerprint_version: number;
  base_fingerprint: string;
  occurrence_no: number;
  override_token?: string | null;
  override_of_claim_id?: string | null;
  transaction?: never;
  installment_group: InstallmentGroupInsertPayload;
  installments: InstallmentInsertPayload[];
};

export type ConfirmImportV2AuditItem = ConfirmImportV2AuditFields & {
  disposition:
    | "duplicate_in_file"
    | "parser_error"
    | "validation_error"
    | "excluded";
  transaction?: never;
  installment_group?: never;
  installments?: never;
  override_token?: never;
};

export type ConfirmImportV2Item =
  | ConfirmImportV2TransactionItem
  | ConfirmImportV2InstallmentItem
  | ConfirmImportV2AuditItem;

export type ConfirmImportV2Result = {
  batch: ImportBatchRow;
  imported_rows: number;
  duplicate_rows: number;
  error_rows: number;
  excluded_rows: number;
  transactions_created: number;
  installment_groups_created: number;
  replayed: boolean;
};

// --- Merge category RPC result ---------------------------------------------
//
// Shape returned by the `merge_category` plpgsql function (see
// supabase/migrations/0003_merge_category.sql): the archived source category row
// plus per-table counts of re-pointed rows. The repository discards it (its
// public contract is void), but the verifier and the fake client assert on it.

export type MergeCategoryResult = {
  source: CategoryRow;
  moved: {
    transactions: number;
    installment_groups: number;
    installments: number;
    subcategories: number;
    categorization_memory: number;
    source_category_mappings: number;
  };
};

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
      obligations: TableDef<ObligationRow, ObligationInsert>;
      installment_groups: TableDef<
        InstallmentGroupRow,
        Partial<InstallmentGroupRow>
      >;
      installments: TableDef<InstallmentRow, Partial<InstallmentRow>>;
      import_batches: TableDef<ImportBatchRow, ImportBatchInsert>;
      import_rows: TableDef<ImportRowRow, Partial<ImportRowRow>>;
      import_item_claims: TableDef<
        ImportItemClaimRow,
        Partial<ImportItemClaimRow>
      >;
      source_category_mappings: TableDef<
        SourceCategoryMappingRow,
        SourceCategoryMappingInsert
      >;
      categorization_memory: TableDef<
        CategorizationMemoryRow,
        CategorizationMemoryInsert
      >;
      bot_interactions: TableDef<BotInteractionRow, BotInteractionInsert>;
      bot_conversations: TableDef<BotConversationRow, BotConversationInsert>;
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
      // Atomic import confirmation: create the import_batch, bulk-insert the
      // kept transactions linked via import_batch_id, and write the per-row
      // import_rows audit trail — all in one transaction. See
      // supabase/migrations/0004_confirm_import.sql. Returns `{ batch,
      // imported_rows }` as JSON; the repository casts it to the result shape.
      confirm_import: {
        Args: {
          batch_payload: ConfirmImportBatchPayload;
          rows_payload: ConfirmImportRowPayload[];
        };
        Returns: ConfirmImportResult;
      };
      /** Atomic, claim-protected flat + installment import (migration 0016). */
      confirm_import_v2: {
        Args: {
          batch_payload: ConfirmImportV2BatchPayload;
          items_payload: ConfirmImportV2Item[];
        };
        Returns: ConfirmImportV2Result;
      };
      reserve_import_ai_paid_items: {
        Args: {
          target_household_id: string;
          target_budget_key: string;
          target_attempt_key: string;
          requested_items: number;
          preview_max_items: number;
          target_created_by_user_id: string;
        };
        Returns: number;
      };
      record_import_ai_paid_result: {
        Args: {
          target_household_id: string;
          target_attempt_key: string;
          target_provider: string;
          target_model: string;
          target_outcome: "success" | "invalid_schema" | "error";
          target_resolved_items: number;
          target_latency_ms: number;
        };
        Returns: undefined;
      };
      claim_import_suggestion_nonce: {
        Args: { target_nonce: string; target_expires_at: string };
        Returns: boolean;
      };
      update_installment_group_category: {
        Args: {
          target_household_id: string;
          target_group_id: string;
          category_patch: {
            category_id?: string | null;
            subcategory_id?: string | null;
          };
        };
        Returns: undefined;
      };
      // Atomic category merge: re-point transactions / installment groups /
      // installments / subcategories / categorization_memory off the source
      // onto the target and archive the source, all in one transaction. See
      // supabase/migrations/0003_merge_category.sql. Returns a jsonb summary
      // (archived source row + per-table moved counts) the repository ignores.
      merge_category: {
        Args: {
          target_household_id: string;
          source_category_id: string;
          target_category_id: string;
        };
        Returns: MergeCategoryResult;
      };
      // Atomic, idempotent obligation-month materialization: insert ONE
      // expense transaction linked via obligation_id/obligation_month, or
      // return the existing one (already_paid = true). See
      // supabase/migrations/0011_create_obligations.sql.
      materialize_obligation_payment: {
        Args: {
          target_obligation_id: string;
          target_month: string;
          paid_on?: string | null;
          target_amount_cents?: number | null;
          target_account_id?: string | null;
        };
        Returns: MaterializeObligationPaymentResult;
      };
      // Atomic, idempotent card-bill settlement: insert ONE kind='transfer'
      // transaction (account = source, card = destination, bill_month = the
      // settled marker), or return the existing one (already_paid = true).
      // See supabase/migrations/0015_settle_card_bill.sql.
      settle_card_bill: {
        Args: {
          target_household_id: string;
          target_credit_card_id: string;
          target_account_id: string;
          target_bill_month: string;
          target_amount_cents: number;
          target_paid_on: string;
          target_created_by_user_id: string;
        };
        Returns: unknown;
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
