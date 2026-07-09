export const CURRENT_CONTRACT_CAPABILITIES = new Set([
  "single_category",
  "new_macro_category_proposal",
  "card_installment",
  "obligation",
  "mark_paid",
]);

export type EvalCapability =
  | "ranked_top_3"
  | "merchant_item_separation"
  | "plain_card_expense"
  | "new_subcategory_proposal"
  | "investment_accounting"
  | "transfer_intent";

export type CategoryCandidate = {
  purpose: string | null;
  category: string;
  subcategory: string | null;
  confidence?: number;
};

export type AccountingExpectation = {
  cash_flow: "outflow" | "inflow" | "neutral";
  available_balance: "subtract" | "add" | "unchanged";
  accounting_expense: "include" | "exclude";
  consumption_spend: "include" | "exclude";
  destination: string | null;
};

export type EvalPrediction = {
  intent: string;
  fields: Record<string, string | number | boolean | null>;
  categorization: {
    decision: "single" | "choose" | "propose_new" | "abstain";
    candidates: CategoryCandidate[];
    proposal: {
      kind: "category" | "subcategory";
      category: string;
      subcategory: string | null;
      reason: string;
    } | null;
  };
  accounting: AccountingExpectation | null;
};

export type EvalCase = {
  id: string;
  suite: "intent_extraction" | "categorization" | "end_to_end";
  split: "dev" | "test";
  input: { text: string; today: string; input_kind: "text" | "audio" };
  context?: {
    cards?: string[];
    merchant_aliases?: Record<string, string[]>;
    note?: string;
  };
  gold: {
    intent: string;
    fields: Record<string, string | number | boolean | null>;
    categorization: {
      decision: "single" | "choose" | "propose_new" | "abstain";
      acceptable: CategoryCandidate[];
      required_candidates?: CategoryCandidate[];
      must_not_auto_select?: boolean;
      proposal?: {
        kind: "category" | "subcategory";
        category: string;
        subcategory: string | null;
      };
    };
    accounting: AccountingExpectation | null;
  };
  capabilities?: EvalCapability[];
  tags: string[];
};

export type PredictionRecord = {
  id: string;
  provider: "anthropic" | "openai" | "fixture";
  model: string;
  repetition: number;
  latency_ms: number;
  prompt_hash: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
  } | null;
  pricing_version: string;
  estimated_cost_usd: number | null;
  prediction: EvalPrediction | null;
  error?: string;
};

export type Taxonomy = {
  version: string;
  purposes: string[];
  categories: Array<{ name: string; subcategories: string[] }>;
  investment_buckets: string[];
};

export type PricingTable = {
  version: string;
  effective_date: string;
  currency: "USD";
  models: Record<
    string,
    {
      input_usd_per_million_tokens: number;
      output_usd_per_million_tokens: number;
      note?: string;
    }
  >;
};
