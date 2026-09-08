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

export type InstallmentMatchConfidence = "medium" | "strong" | "very_strong";

export type ExistingInstallmentCandidate = {
  installmentGroupId: string;
  creditCardId: string;
  cardName: string;
  description: string;
  totalAmountCents: number;
  purchasedOn: string;
  installmentNumber: number;
  installmentCount: number;
  amountCents: number;
};

export type InstallmentCandidateMatch = ExistingInstallmentCandidate & {
  confidence: InstallmentMatchConfidence;
  exactAmount: boolean;
  amountDifferenceCents: number;
};

const CONFIDENCE_RANK: Record<InstallmentMatchConfidence, number> = {
  medium: 1,
  strong: 2,
  very_strong: 3,
};

/**
 * Compare a statement parcel with existing parcels in the same billing month.
 * Amount is always required. Exact amount matches follow the user's three-tier
 * model; fuzzy matches are deliberately demoted and need corroborating signals.
 * The outer tolerance is 10%, capped at R$ 10, so large purchases do not create
 * implausibly broad candidate sets.
 */
export function findInstallmentCandidateMatches(
  group: InferredInstallmentGroup,
  targetCreditCardId: string,
  existing: ExistingInstallmentCandidate[],
): InstallmentCandidateMatch[] {
  const fivePercent = Math.min(
    1_000,
    Math.round(group.perInstallmentCents * 0.05),
  );
  const tenPercent = Math.min(
    1_000,
    Math.round(group.perInstallmentCents * 0.1),
  );

  return existing
    .flatMap((candidate): InstallmentCandidateMatch[] => {
      const amountDifferenceCents = Math.abs(
        candidate.amountCents - group.perInstallmentCents,
      );
      const exactAmount = amountDifferenceCents === 0;
      const countMatches =
        candidate.installmentCount === group.installmentCount;
      const cardMatches = candidate.creditCardId === targetCreditCardId;

      let confidence: InstallmentMatchConfidence | null = null;
      if (exactAmount) {
        confidence =
          countMatches && cardMatches
            ? "very_strong"
            : countMatches
              ? "strong"
              : "medium";
      } else if (amountDifferenceCents <= fivePercent && countMatches) {
        confidence = cardMatches ? "strong" : "medium";
      } else if (
        amountDifferenceCents <= tenPercent &&
        countMatches &&
        cardMatches
      ) {
        confidence = "medium";
      }

      return confidence === null
        ? []
        : [
            {
              ...candidate,
              confidence,
              exactAmount,
              amountDifferenceCents,
            },
          ];
    })
    .sort(
      (left, right) =>
        CONFIDENCE_RANK[right.confidence] - CONFIDENCE_RANK[left.confidence] ||
        left.amountDifferenceCents - right.amountDifferenceCents ||
        left.description.localeCompare(right.description, "pt-BR"),
    );
}

export function hasUniqueVeryStrongMatch(
  matches: InstallmentCandidateMatch[],
): boolean {
  return (
    matches.filter((match) => match.confidence === "very_strong").length === 1
  );
}

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
