import { CURRENT_CONTRACT_CAPABILITIES } from "./types.js";
import type {
  CategoryCandidate,
  EvalCase,
  EvalPrediction,
  PredictionRecord,
} from "./types.js";

function normalize(value: unknown): string {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase();
}

function categoryKey(value: CategoryCandidate): string {
  return [value.purpose, value.category, value.subcategory]
    .map(normalize)
    .join("|");
}

const REQUIRED_FIELD_KEYS = [
  "merchant",
  "item",
  "description",
  "amount_kind",
  "amount_cents",
  "monthly_amount_cents",
  "installment_count",
  "card",
  "occurred_on",
  "due_day",
  "term_months",
] as const;

function isPrediction(value: unknown): value is EvalPrediction {
  if (!value || typeof value !== "object") return false;
  const prediction = value as Partial<EvalPrediction>;
  if (typeof prediction.intent !== "string") return false;
  if (!prediction.fields || typeof prediction.fields !== "object") return false;
  if (!REQUIRED_FIELD_KEYS.every((key) => key in prediction.fields!))
    return false;
  const categorization = prediction.categorization;
  if (!categorization || typeof categorization !== "object") return false;
  if (
    !["single", "choose", "propose_new", "abstain"].includes(
      categorization.decision,
    )
  ) {
    return false;
  }
  if (
    !Array.isArray(categorization.candidates) ||
    categorization.candidates.length > 3
  ) {
    return false;
  }
  if (
    categorization.candidates.some(
      (candidate) =>
        !candidate ||
        typeof candidate.category !== "string" ||
        (candidate.purpose !== null && typeof candidate.purpose !== "string") ||
        (candidate.subcategory !== null &&
          typeof candidate.subcategory !== "string") ||
        (candidate.confidence !== undefined &&
          (typeof candidate.confidence !== "number" ||
            candidate.confidence < 0 ||
            candidate.confidence > 1)),
    )
  ) {
    return false;
  }
  if (
    categorization.proposal !== null &&
    typeof categorization.proposal !== "object"
  ) {
    return false;
  }
  return (
    prediction.accounting === null || typeof prediction.accounting === "object"
  );
}

function exactObjectSubset(
  expected: Record<string, unknown>,
  actual: Record<string, unknown>,
): { correct: number; total: number; failures: string[] } {
  let correct = 0;
  const failures: string[] = [];
  for (const [key, value] of Object.entries(expected)) {
    const matches =
      typeof value === "string"
        ? normalize(actual[key]) === normalize(value)
        : actual[key] === value;
    if (matches) correct += 1;
    else failures.push(key);
  }
  return { correct, total: Object.keys(expected).length, failures };
}

export type CaseScore = {
  id: string;
  schemaValid: boolean;
  intentCorrect: boolean;
  fieldsCorrect: number;
  fieldsTotal: number;
  top1Correct: boolean;
  recallAt3: number;
  categoryDecisionCorrect: boolean;
  proposalCorrect: boolean;
  accountingCorrect: boolean;
  catastrophic: string[];
};

export function scoreCase(
  entry: EvalCase,
  prediction: EvalPrediction | null,
): CaseScore {
  if (!isPrediction(prediction)) {
    return {
      id: entry.id,
      schemaValid: false,
      intentCorrect: false,
      fieldsCorrect: 0,
      fieldsTotal: Object.keys(entry.gold.fields).length,
      top1Correct: false,
      recallAt3: 0,
      categoryDecisionCorrect: false,
      proposalCorrect: entry.gold.categorization.proposal === undefined,
      accountingCorrect: entry.gold.accounting === null,
      catastrophic: ["invalid_schema"],
    };
  }
  const fields = exactObjectSubset(entry.gold.fields, prediction.fields ?? {});
  const acceptable = new Set(
    entry.gold.categorization.acceptable.map(categoryKey),
  );
  const predicted = (prediction.categorization?.candidates ?? []).slice(0, 3);
  const top1Correct = predicted[0]
    ? acceptable.has(categoryKey(predicted[0]))
    : false;
  const required =
    entry.gold.categorization.required_candidates ??
    entry.gold.categorization.acceptable;
  const predictedKeys = new Set(predicted.map(categoryKey));
  const recallAt3 =
    required.length === 0
      ? predicted.length === 0
        ? 1
        : 0
      : required.filter((candidate) =>
          predictedKeys.has(categoryKey(candidate)),
        ).length / required.length;
  const categoryDecisionCorrect =
    prediction.categorization?.decision ===
      entry.gold.categorization.decision &&
    (!entry.gold.categorization.must_not_auto_select ||
      prediction.categorization?.decision !== "single");
  const expectedProposal = entry.gold.categorization.proposal;
  const actualProposal = prediction.categorization.proposal;
  const proposalCorrect =
    expectedProposal === undefined
      ? actualProposal === null
      : actualProposal !== null &&
        normalize(actualProposal.kind) === normalize(expectedProposal.kind) &&
        normalize(actualProposal.category) ===
          normalize(expectedProposal.category) &&
        normalize(actualProposal.subcategory) ===
          normalize(expectedProposal.subcategory);
  const accountingCorrect =
    entry.gold.accounting === null
      ? prediction.accounting === null
      : prediction.accounting !== null &&
        exactObjectSubset(entry.gold.accounting, prediction.accounting)
          .correct === Object.keys(entry.gold.accounting).length;

  const catastrophic: string[] = [];
  if (
    ["obligation", "card_installment", "investment_transfer"].includes(
      entry.gold.intent,
    ) &&
    prediction.intent !== entry.gold.intent
  ) {
    catastrophic.push("critical_intent");
  }
  for (const field of fields.failures) {
    if (
      [
        "amount_cents",
        "monthly_amount_cents",
        "amount_kind",
        "installment_count",
        "card",
      ].includes(field)
    ) {
      catastrophic.push(`critical_field:${field}`);
    }
  }
  if (entry.gold.accounting !== null && !accountingCorrect) {
    catastrophic.push("accounting_semantics");
  }
  return {
    id: entry.id,
    schemaValid: true,
    intentCorrect: prediction.intent === entry.gold.intent,
    fieldsCorrect: fields.correct,
    fieldsTotal: fields.total,
    top1Correct,
    recallAt3,
    categoryDecisionCorrect,
    proposalCorrect,
    accountingCorrect,
    catastrophic,
  };
}

export function aggregateScores(
  cases: EvalCase[],
  records: PredictionRecord[],
): Record<string, unknown> {
  const byId = new Map(cases.map((entry) => [entry.id, entry]));
  const groups = new Map<
    string,
    { scores: CaseScore[]; latencies: number[] }
  >();
  for (const record of records) {
    const entry = byId.get(record.id);
    if (!entry) continue;
    const key = `${record.provider}:${record.model}:run-${record.repetition}`;
    const group = groups.get(key) ?? { scores: [], latencies: [] };
    group.scores.push(scoreCase(entry, record.prediction));
    group.latencies.push(record.latency_ms);
    groups.set(key, group);
  }
  return Object.fromEntries(
    [...groups.entries()].map(([key, group]) => {
      const { scores } = group;
      const ratio = (count: number) =>
        scores.length ? count / scores.length : 0;
      const fieldsTotal = scores.reduce(
        (sum, score) => sum + score.fieldsTotal,
        0,
      );
      const sortedLatency = [...group.latencies].sort((a, b) => a - b);
      const percentile = (fraction: number) =>
        sortedLatency[
          Math.min(
            sortedLatency.length - 1,
            Math.max(0, Math.ceil(sortedLatency.length * fraction) - 1),
          )
        ] ?? 0;
      return [
        key,
        {
          cases: scores.length,
          schema_valid: ratio(
            scores.filter((score) => score.schemaValid).length,
          ),
          intent_accuracy: ratio(
            scores.filter((score) => score.intentCorrect).length,
          ),
          field_accuracy:
            fieldsTotal === 0
              ? 1
              : scores.reduce((sum, score) => sum + score.fieldsCorrect, 0) /
                fieldsTotal,
          top_1_accuracy: ratio(
            scores.filter((score) => score.top1Correct).length,
          ),
          mean_recall_at_3:
            scores.reduce((sum, score) => sum + score.recallAt3, 0) /
            Math.max(1, scores.length),
          category_decision_accuracy: ratio(
            scores.filter((score) => score.categoryDecisionCorrect).length,
          ),
          proposal_accuracy: ratio(
            scores.filter((score) => score.proposalCorrect).length,
          ),
          accounting_accuracy: ratio(
            scores.filter((score) => score.accountingCorrect).length,
          ),
          latency_ms_p50: percentile(0.5),
          latency_ms_p95: percentile(0.95),
          catastrophic_errors: scores.flatMap((score) =>
            score.catastrophic.map((failure) => `${score.id}:${failure}`),
          ),
        },
      ];
    }),
  );
}

export function currentContractGapReport(
  cases: EvalCase[],
): Record<string, unknown> {
  const gaps = new Map<string, string[]>();
  for (const entry of cases) {
    for (const capability of entry.capabilities ?? []) {
      if (!CURRENT_CONTRACT_CAPABILITIES.has(capability)) {
        const ids = gaps.get(capability) ?? [];
        ids.push(entry.id);
        gaps.set(capability, ids);
      }
    }
  }
  return {
    cases: cases.length,
    cases_with_current_contract_gap: new Set([...gaps.values()].flat()).size,
    gaps: Object.fromEntries(
      [...gaps.entries()].map(([capability, ids]) => [
        capability,
        { count: ids.length, cases: ids },
      ]),
    ),
  };
}
