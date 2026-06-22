export type MoneyAmount = {
  currency: "BRL";
  cents: number;
};

export type TransactionKind = "expense" | "income" | "transfer";

export type TransactionDraft = {
  householdId: string;
  kind: TransactionKind;
  amount: MoneyAmount;
  occurredOn: string;
  description: string;
  categoryId?: string;
  accountId?: string;
  creditCardId?: string;
};
