import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  buildRequest,
  completePortuguese,
  parseAnswers,
  projectCases,
  summarize,
  wireRequest,
  type Answer,
  type Case,
  type Prediction,
  type RecordRow,
} from "./portuguese.js";
import type { Taxonomy, EvalCase } from "./types.js";

const taxonomy: Taxonomy = {
  version: "test",
  purposes: [],
  categories: [
    { name: "Alimentação", subcategories: ["Mercado", "Restaurante"] },
  ],
  investment_buckets: [],
};
const entry: Case = {
  id: "test",
  split: "test",
  text: "mercado 25",
  origin: "portuguese-v1",
  gold: {
    decision: "single",
    acceptable: ["Alimentação / Mercado"],
    required: [],
  },
};
const request = buildRequest(entry, taxonomy);
function answer(keys: string[], winner: string): Answer {
  return {
    choice: winner,
    confidence: 1,
    probabilities: Object.fromEntries(
      keys.map((k) => [k, k === winner ? 1 : 0]),
    ),
  };
}
function prediction(
  decision = "single",
  category = "Alimentação / Mercado",
): Prediction {
  return {
    decision: answer(
      Object.keys(request.questions.decision.criteria),
      decision,
    ),
    category: answer(
      Object.keys(request.questions.category.criteria),
      category,
    ),
  };
}
function row(p: Prediction | null): RecordRow {
  return {
    id: "test",
    split: "test",
    origin: "portuguese-v1",
    provider: "jev",
    model: "test",
    repetition: 1,
    latency_ms: 12,
    request_hash: "hash",
    prediction: p,
    usage: null,
  };
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
describe("Portuguese benchmark", () => {
  it("never includes gold labels, split, case IDs, or adjudication notes in state", () => {
    expect(request.state).toEqual({ text: entry.text });
    expect(JSON.stringify(request)).not.toContain('"gold"');
    expect(wireRequest(request).questions.decision.instructions).toContain(
      "Alimentação / Mercado",
    );
  });
  it("preserves all existing cases while projecting only categorization", () => {
    const originals = readFileSync(
      new URL("../../evals/v1/cases.jsonl", import.meta.url),
      "utf8",
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as EvalCase);
    const before = JSON.stringify(originals);
    const projected = projectCases(originals);
    expect(projected).toHaveLength(42);
    expect(projected.map((c) => c.id)).toEqual(originals.map((c) => c.id));
    expect(JSON.stringify(originals)).toBe(before);
    expect(projected.every((c) => !Object.hasOwn(c, "fields"))).toBe(true);
    const added = readFileSync(
      new URL("../../evals/portuguese-v1/cases.jsonl", import.meta.url),
      "utf8",
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Case);
    expect(added).toHaveLength(24);
    expect(new Set([...projected, ...added].map((c) => c.id)).size).toBe(66);
    expect(new Set(added.map((c) => c.gold.decision)).size).toBe(4);
  });
  it("validates winners, option coverage, finite probabilities, and sums", () => {
    expect(parseAnswers(prediction(), request)).toEqual(prediction());
    const invalid = prediction();
    invalid.category.choice = "Inventada";
    expect(() => parseAnswers(invalid, request)).toThrow();
    const missing = prediction();
    delete missing.category.probabilities.unknown;
    expect(() => parseAnswers(missing, request)).toThrow();
    const badSum = prediction();
    badSum.category.probabilities.unknown = 0.5;
    expect(() => parseAnswers(badSum, request)).toThrow();
    const wrongWinner = prediction();
    wrongWinner.category.choice = "unknown";
    expect(() => parseAnswers(wrongWinner, request)).toThrow();
    const nonFinite = prediction();
    nonFinite.category.confidence = NaN;
    expect(() => parseAnswers(nonFinite, request)).toThrow();
  });
  it("accepts the inclusive rounding boundary but rejects larger sum errors", () => {
    const low = prediction();
    low.category.probabilities["Alimentação / Mercado"] = 0.99;
    expect(() => parseAnswers(low, request)).not.toThrow();
    const high = prediction();
    high.category.probabilities.unknown = 0.01;
    expect(() => parseAnswers(high, request)).not.toThrow();
    high.category.probabilities.unknown = 0.02;
    expect(() => parseAnswers(high, request)).toThrow("probability sum");
  });
  it("retains usage and raw answers when validation fails", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "test-key");
    const invalid = prediction();
    invalid.category.probabilities.unknown = 0.3;
    const body = {
      model: "jev-1.13.0",
      answers: invalid,
      usage: { input_tokens: 100, output_tokens: 10 },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify(body))),
    );
    const result = await completePortuguese("jev", "jev-1.13.0", request);
    expect(result.prediction).toBeNull();
    expect(result.error).toContain("probability sum");
    expect(result.usage).toEqual(body.usage);
    expect(result.raw_response).toEqual(body);
  });
  it("counts failed calls in accuracy without including their latency", () => {
    const report = summarize(
      [entry],
      [
        row(prediction()),
        { ...row(null), latency_ms: 30000, error: "timeout" },
      ],
    );
    expect(report.category_top1_accuracy).toBe(0.5);
    expect(report.decision_accuracy).toBe(0.5);
    expect(report.latency_ms.p95).toBe(12);
    expect(report.failures).toHaveLength(1);
  });
  it("flags confident selection on ambiguous input even if its category is acceptable", () => {
    const ambiguous = {
      ...entry,
      gold: { ...entry.gold, decision: "choose" as const },
    };
    const report = summarize([ambiguous], [row(prediction())]);
    expect(report.category_top1_accuracy).toBe(1);
    expect(report.unsafe_single_selections).toBe(1);
    expect(report.high_probability_error_rate).toBe(1);
  });
  it("uses selected probability rather than confidence for the high-probability metric", () => {
    const p = prediction();
    p.category.confidence = 0.2;
    expect(
      summarize([entry], [row(p)]).high_probability_single_selections,
    ).toBe(1);
  });
  it("scores abstention without manufacturing category accuracy", () => {
    const c = {
      ...entry,
      gold: { decision: "abstain" as const, acceptable: [], required: [] },
    };
    const report = summarize([c], [row(prediction("abstain", "unknown"))]);
    expect(report.decision_accuracy).toBe(1);
    expect(report.category_top1_accuracy).toBeNull();
  });
  it("measures all required ambiguous alternatives in top three", () => {
    const p = prediction("choose");
    p.category.probabilities["Alimentação / Mercado"] = 0.6;
    p.category.probabilities["Alimentação / Restaurante"] = 0.4;
    const c = {
      ...entry,
      gold: {
        decision: "choose" as const,
        acceptable: ["Alimentação / Mercado", "Alimentação / Restaurante"],
        required: ["Alimentação / Mercado", "Alimentação / Restaurante"],
      },
    };
    expect(summarize([c], [row(p)]).required_candidate_recall_at3).toBe(1);
  });
  it("calls the official Jev endpoint and records native answers and usage", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "test-key");
    const mock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          model: "jev-1.13.0",
          answers: prediction(),
          usage: { input_tokens: 100, output_tokens: 10 },
        }),
      ),
    );
    vi.stubGlobal("fetch", mock);
    const result = await completePortuguese("jev", "jev-1.13.0", request);
    expect(result.prediction).toEqual(prediction());
    expect(result.usage?.input_tokens).toBe(100);
    expect(mock.mock.calls[0]?.[0]).toBe(
      "https://api.typesafe.ai/v1/systemone",
    );
    const body = JSON.parse(mock.mock.calls[0]?.[1].body as string);
    expect(body.state).toEqual({ text: entry.text });
    expect(body.questions.decision.instructions).toContain("Catálogo:");
  });
  it("parses the baseline against the same option schema", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            model: "haiku",
            content: [{ type: "text", text: JSON.stringify(prediction()) }],
            usage: { input_tokens: 100, output_tokens: 150 },
          }),
        ),
      ),
    );
    expect(
      (await completePortuguese("anthropic", "haiku", request)).prediction,
    ).toEqual(prediction());
  });
  it("does not persist provider error bodies", async () => {
    vi.stubEnv("TYPESAFE_API_KEY", "test-key");
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response("sensitive echoed data", { status: 401 }),
        ),
    );
    await expect(
      completePortuguese("jev", "jev-1.13.0", request),
    ).rejects.toThrow("jev HTTP 401");
  });
});
