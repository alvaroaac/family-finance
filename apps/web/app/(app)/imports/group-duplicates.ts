import {
  matchExistingGroup,
  type InferredInstallmentGroup,
} from "@family-finance/importers";

export type ExistingInstallmentGroupSummary = {
  creditCardId: string;
  description: string;
  installmentCount: number;
  purchasedOn: string;
};

/** Legacy groups predate import claims, so their heuristic must be card-scoped. */
export function hasLegacyInstallmentGroupOnCard(
  group: InferredInstallmentGroup,
  creditCardId: string,
  existing: ExistingInstallmentGroupSummary[],
): boolean {
  return (
    matchExistingGroup(
      group,
      existing.filter((candidate) => candidate.creditCardId === creditCardId),
    ) !== null
  );
}
