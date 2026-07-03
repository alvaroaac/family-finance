/**
 * @family-finance/db
 *
 * Supabase client creation, hand-written database types, and RLS-aware
 * repository functions named around domain concepts. All write paths are
 * scoped by `household_id` and protected by the RLS policies defined in
 * `supabase/migrations/0001_initial_schema.sql`.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "./types.js";

export type DatabaseClientConfig = {
  supabaseUrl: string;
  supabaseAnonKey: string;
};

/**
 * Create a typed Supabase client for the Family Finance schema. The caller is
 * responsible for attaching the authenticated user's session so RLS applies;
 * an anonymous client only sees what the anon policies allow (nothing, here).
 */
export function createDatabaseClient(
  config: DatabaseClientConfig,
): SupabaseClient<Database> {
  return createClient<Database>(config.supabaseUrl, config.supabaseAnonKey);
}

export type ServiceRoleClientConfig = {
  supabaseUrl: string;
  serviceRoleKey: string;
};

/**
 * Create a typed Supabase client that authenticates with the SERVICE ROLE key,
 * bypassing RLS entirely. For the bot process ONLY — never the web app: the
 * web's data access stays behind user sessions + RLS. Session persistence and
 * token refresh are disabled because this is a headless server client with a
 * static key, not a user session.
 */
export function createServiceRoleClient(
  config: ServiceRoleClientConfig,
): SupabaseClient<Database> {
  return createClient<Database>(config.supabaseUrl, config.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// Database types (hand-written, static — no live connection required).
export type {
  Database,
  AccountKind,
  TransactionKind,
  InvestmentBucketSlug,
  ImportSource,
  ImportBatchStatus,
  ResponsibilityScope,
  BotChannel,
  HouseholdRow,
  HouseholdMemberRow,
  AccountRow,
  InvestmentBucketRow,
  CreditCardRow,
  CategoryRow,
  SubcategoryRow,
  TransactionRow,
  TransactionInsert,
  InstallmentGroupRow,
  InstallmentRow,
  InstallmentGroupInsertPayload,
  InstallmentInsertPayload,
  MergeCategoryResult,
  ImportBatchRow,
  ImportBatchInsert,
  ConfirmImportBatchPayload,
  ConfirmImportRowPayload,
  ConfirmImportResult,
  ImportRowRow,
  CategorizationMemoryRow,
  CategorizationMemoryInsert,
  BotInteractionRow,
  BotInteractionInsert,
  BotConversationRow,
  BotConversationInsert,
  ObligationStatus,
  ObligationRow,
  ObligationInsert,
  MaterializeObligationPaymentResult,
} from "./types.js";

// Repository functions and pure mappers.
export type {
  AppSupabaseClient,
  PersistedTransaction,
  MonthlySummary,
  CardPressure,
  UpcomingInstallment,
  DashboardTransaction,
  CardChargeSummary,
  TransactionFilters,
  TransactionListItem,
  TransactionPage,
  TransactionPatch,
  HouseholdMemberProfile,
  BotMemberIdentity,
  PersistedObligation,
  ObligationChanges,
  ObligationPaymentKey,
  ObligationsPressure,
} from "./repositories.js";
export {
  transactionInsertFromDraft,
  mapTransactionRow,
  mapTransactionListItem,
  monthDateRange,
  summarizeMonth,
  createTransaction,
  findCategoriesByHousehold,
  findSubcategoriesByCategory,
  getMonthlySummary,
  // Import batches (Task 5).
  findAccountsByHousehold,
  createImportBatch,
  confirmImport,
  // Category cleanup + categorization memory (Task 6).
  findHouseholdIdForCurrentUser,
  listAllCategories,
  listAllSubcategories,
  archiveCategory,
  restoreCategory,
  mergeCategory,
  listCategorizationMemory,
  listActiveCategorizationMemory,
  createCategorizationMemory,
  setCategorizationMemoryActive,
  // Bot interactions (auditing).
  createBotInteraction,
  // Accounts, investment buckets (caixinhas), credit cards (Task 9).
  accountInsert,
  investmentBucketInsert,
  creditCardInsert,
  installmentGroupInsertFromPlan,
  installmentInsertsFromPlan,
  installmentInsertPayloadsFromPlan,
  listAccounts,
  createAccount,
  updateAccount,
  deleteAccount,
  listInvestmentBuckets,
  createInvestmentBucket,
  updateInvestmentBucket,
  deleteInvestmentBucket,
  listCreditCards,
  createCreditCard,
  updateCreditCard,
  deleteCreditCard,
  createInstallmentPurchase,
  // Import-preview dedupe (Task 5).
  listInstallmentGroupsByHousehold,
  findCardChargesBetween,
  // Dashboard aggregation + reads (Task 10).
  currentMonth,
  summarizeCardPressure,
  mapUpcomingInstallment,
  mapDashboardTransaction,
  needsReview,
  getCardPressure,
  getCardPressureForCard,
  findUpcomingInstallments,
  findRecentTransactions,
  findPendingReviewTransactions,
  // Transações view + member profiles + caixinha balance + bot heartbeat
  // (v1.0 Task 2).
  transactionUpdateFromPatch,
  findTransactionsFiltered,
  updateTransaction,
  deleteTransaction,
  listHouseholdMembers,
  updateHouseholdMember,
  updateInvestmentBucketBalance,
  findLastBotInteraction,
  // Bot identity + persistent conversations (v1.0 Task 8).
  findMemberByTelegramUserId,
  loadBotConversation,
  saveBotConversation,
  deleteBotConversation,
  // Obligations (recurring fixed obligations — migration 0011).
  obligationInsertFromDraft,
  mapObligationRow,
  obligationUpdateFromChanges,
  obligationMonthYm,
  summarizeObligationsPressure,
  createObligation,
  listObligations,
  cancelObligation,
  updateObligation,
  materializeObligationPayment,
  listObligationPayments,
  getObligationsPressure,
} from "./repositories.js";
