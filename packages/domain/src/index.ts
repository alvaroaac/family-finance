/**
 * @family-finance/domain
 *
 * Pure finance core. No imports from web, bot, db clients, or AI providers.
 * Both the web app and the Telegram bot create transactions and installment
 * plans through these contracts so financial rules live in exactly one place.
 */

// Money — BRL cents only.
export type { Currency, MoneyAmount } from "./money.js";
export {
  brl,
  ZERO_BRL,
  moneyAmountSchema,
  isValidMoney,
  addMoney,
  subtractMoney,
  splitCents,
} from "./money.js";

// Accounts, investment buckets (caixinhas), and credit cards.
export type {
  Account,
  AccountKind,
  InvestmentBucket,
  InvestmentBucketSlug,
  CreditCard,
} from "./accounts.js";
export {
  accountKindSchema,
  investmentBucketSlugSchema,
  creditCardSchema,
} from "./accounts.js";

// Categories.
export type {
  Category,
  Subcategory,
  CategoryRef,
} from "./categories.js";
export {
  categorySchema,
  subcategorySchema,
  categoryRefSchema,
} from "./categories.js";

// Transactions.
export type {
  TransactionKind,
  PaymentInstrument,
  Responsibility,
  TransactionDraft,
  CreateTransactionInput,
  ValidationError,
  DomainResult,
  CardBillSettlementInput,
  CardBillSettlementDraft,
} from "./transactions.js";
export {
  transactionKindSchema,
  HOUSEHOLD_RESPONSIBILITY,
  createTransactionDraft,
  isCardPayment,
  createCardBillSettlement,
} from "./transactions.js";

// Installments — support dashboard projections without a full invoice system.
export type {
  InstallmentGroupDraft,
  InstallmentDraft,
  InstallmentPlan,
  CreateInstallmentPlanInput,
} from "./installments.js";
export { createInstallmentPlan } from "./installments.js";

// Obligations — recurring fixed obligations as templates + projections.
export type {
  ObligationStatus,
  ObligationDraft,
  CreateObligationInput,
  ProjectableObligation,
  ProjectedEntry,
} from "./obligations.js";
export {
  createObligationDraft,
  addMonthsYm,
  obligationEndMonth,
  projectObligations,
  paidKey,
} from "./obligations.js";

// Household-local calendar semantics shared by server and browser entry points.
export {
  HOUSEHOLD_TIME_ZONE,
  currentHouseholdDate,
  currentHouseholdMonth,
} from "./calendar.js";
