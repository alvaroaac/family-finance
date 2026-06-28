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
  ImportBatchRow,
  ImportBatchInsert,
  ImportRowRow,
  CategorizationMemoryRow,
  CategorizationMemoryInsert,
  BotInteractionRow,
  BotInteractionInsert,
} from "./types.js";

// Repository functions and pure mappers.
export type {
  AppSupabaseClient,
  PersistedTransaction,
  MonthlySummary,
  CardPressure,
  UpcomingInstallment,
  DashboardTransaction,
} from "./repositories.js";
export {
  transactionInsertFromDraft,
  mapTransactionRow,
  monthDateRange,
  summarizeMonth,
  createTransaction,
  findCategoriesByHousehold,
  findSubcategoriesByCategory,
  getMonthlySummary,
  // Import batches (Task 5).
  findAccountsByHousehold,
  createImportBatch,
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
  // Dashboard aggregation + reads (Task 10).
  currentMonth,
  summarizeCardPressure,
  mapUpcomingInstallment,
  mapDashboardTransaction,
  needsReview,
  getCardPressure,
  findUpcomingInstallments,
  findRecentTransactions,
  findPendingReviewTransactions,
} from "./repositories.js";
