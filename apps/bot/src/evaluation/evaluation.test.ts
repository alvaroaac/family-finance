import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { loadDataset } from "./dataset.js";
import { buildEvaluationPrompt, promptHash } from "./prompt.js";
import {
  aggregateScores,
  currentContractGapReport,
  scoreCase,
} from "./scorer.js";
import type { EvalCase, EvalPrediction, PredictionRecord } from "./types.js";

const ROOT = resolve(import.meta.dirname, "../..");

async function dataset() {
  return loadDataset({
    casesPath: resolve(ROOT, "evals/v1/cases.jsonl"),
    taxonomyPath: resolve(ROOT, "evals/v1/taxonomy.json"),
  });
}

function perfectPrediction(entry: EvalCase): EvalPrediction {
  return {
    intent: entry.gold.intent,
    fields: {
      merchant: null,
      item: null,
      description: null,
      amount_kind: null,
      amount_cents: null,
      monthly_amount_cents: null,
      installment_count: null,
      card: null,
      occurred_on: null,
      due_day: null,
      term_months: null,
      ...entry.gold.fields,
    },
    categorization: {
      decision: entry.gold.categorization.decision,
      candidates:
        entry.gold.categorization.required_candidates ??
        entry.gold.categorization.acceptable,
      proposal: entry.gold.categorization.proposal
        ? { ...entry.gold.categorization.proposal, reason: "gold fixture" }
        : null,
    },
    accounting: entry.gold.accounting,
  };
}

describe("AI evaluation dataset v1", () => {
  it("loads 42 unique, versioned cases", async () => {
    const loaded = await dataset();
    expect(loaded.cases).toHaveLength(42);
    expect(new Set(loaded.cases.map((entry) => entry.id)).size).toBe(42);
    expect(loaded.taxonomy.version).toBe("family-taxonomy-v1-draft");
  });

  it("contains the user-critical Mercado Livre, solar and Giassi cases", async () => {
    const { cases } = await dataset();
    expect(cases.find((entry) => entry.id === "ml-005")?.gold.intent).toBe(
      "plain_card_expense",
    );
    expect(
      cases.find((entry) => entry.id === "solar-001")?.gold.fields
        .monthly_amount_cents,
    ).toBe(71044);
    expect(
      cases.find((entry) => entry.id === "giassi-001")?.gold.fields.merchant,
    ).toBe("Giassi");
  });

  it("keeps investment transfers outside consumption while subtracting available Saldo", async () => {
    const { cases } = await dataset();
    const investmentCases = cases.filter(
      (entry) => entry.gold.intent === "investment_transfer",
    );
    expect(investmentCases.length).toBeGreaterThanOrEqual(4);
    for (const entry of investmentCases) {
      expect(entry.gold.accounting).toMatchObject({
        cash_flow: "outflow",
        available_balance: "subtract",
        accounting_expense: "exclude",
        consumption_spend: "exclude",
      });
    }
  });

  it("produces a stable provider-neutral prompt hash", async () => {
    const { cases, taxonomy } = await dataset();
    const prompt = buildEvaluationPrompt(cases[0] as EvalCase, taxonomy);
    expect(prompt).toContain("apenas um objeto JSON");
    expect(prompt).toContain("NÃO entra como despesa contábil");
    expect(promptHash(prompt)).toHaveLength(16);
    expect(promptHash(prompt)).toBe(promptHash(prompt));
  });

  it("scores a gold fixture perfectly and flags critical amount errors", async () => {
    const { cases } = await dataset();
    const entry = cases.find(
      (candidate) => candidate.id === "solar-001",
    ) as EvalCase;
    const perfect = scoreCase(entry, perfectPrediction(entry));
    expect(perfect.intentCorrect).toBe(true);
    expect(perfect.fieldsCorrect).toBe(perfect.fieldsTotal);
    expect(perfect.catastrophic).toEqual([]);

    const wrong = perfectPrediction(entry);
    wrong.fields.monthly_amount_cents = 7104400;
    expect(scoreCase(entry, wrong).catastrophic).toContain(
      "critical_field:monthly_amount_cents",
    );
  });

  it("reports capabilities that current production contracts cannot express", async () => {
    const { cases } = await dataset();
    const report = currentContractGapReport(cases) as {
      gaps: Record<string, { count: number }>;
    };
    expect(report.gaps.ranked_top_3?.count).toBeGreaterThan(0);
    expect(report.gaps.plain_card_expense?.count).toBeGreaterThan(0);
    expect(report.gaps.new_subcategory_proposal?.count).toBeGreaterThan(0);
    expect(report.gaps.investment_accounting?.count).toBeGreaterThan(0);
  });

  it("aggregates scores independently by provider, model and repetition", async () => {
    const { cases } = await dataset();
    const entry = cases[0] as EvalCase;
    const record: PredictionRecord = {
      id: entry.id,
      provider: "fixture",
      model: "perfect",
      repetition: 1,
      latency_ms: 0,
      prompt_hash: "fixture",
      prediction: perfectPrediction(entry),
    };
    const aggregate = aggregateScores([entry], [record]) as Record<
      string,
      { intent_accuracy: number; catastrophic_errors: string[] }
    >;
    expect(aggregate["fixture:perfect:run-1"]?.intent_accuracy).toBe(1);
    expect(aggregate["fixture:perfect:run-1"]?.catastrophic_errors).toEqual([]);
  });
});
