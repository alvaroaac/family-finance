import type { TransactionRow } from "@family-finance/db";
import type { InstallmentMatchConfidence } from "./group-duplicates";

export type FlatInstallmentMatch = {
  transactionId: string;
  updatedAt: string;
  description: string;
  amountCents: number;
  occurredOn: string;
  instrumentName: string;
  differentInstrument: boolean;
  confidence: InstallmentMatchConfidence;
  categoryId: string | null;
  subcategoryId: string | null;
};

export function normalizedPurchaseName(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

export function findFlatInstallmentMatches(
  group: { description: string; totalAmountCents: number; purchasedOn: string },
  cardId: string,
  transactions: TransactionRow[],
  instrumentNames: ReadonlyMap<string, string> = new Map(),
): FlatInstallmentMatch[] {
  const name = normalizedPurchaseName(group.description);
  return transactions
    .filter(
      (tx) =>
        tx.kind === "expense" &&
        tx.installment_id === null &&
        tx.import_batch_id === null &&
        tx.obligation_id === null &&
        tx.amount_cents === group.totalAmountCents &&
        name.length > 0 &&
        normalizedPurchaseName(tx.description) === name &&
        tx.occurred_on.slice(0, 7) === group.purchasedOn.slice(0, 7),
    )
    .map((tx) => ({
      transactionId: tx.id,
      updatedAt: tx.updated_at,
      description: tx.description,
      amountCents: tx.amount_cents,
      occurredOn: tx.occurred_on,
      instrumentName:
        instrumentNames.get(tx.credit_card_id ?? tx.account_id ?? "") ??
        "Outro pagamento",
      differentInstrument: tx.credit_card_id !== cardId,
      confidence:
        tx.credit_card_id === cardId
          ? ("very_strong" as const)
          : ("strong" as const),
      categoryId: tx.category_id,
      subcategoryId: tx.subcategory_id,
    }))
    .sort(
      (a, b) =>
        Number(a.differentInstrument) - Number(b.differentInstrument) ||
        a.occurredOn.localeCompare(b.occurredOn) ||
        a.transactionId.localeCompare(b.transactionId),
    );
}
