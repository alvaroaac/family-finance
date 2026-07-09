import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { loadDataset, loadPredictions } from "./dataset.js";
import { buildEvaluationPrompt, promptHash } from "./prompt.js";
import { completeEvaluation, parseModelTargets } from "./provider.js";
import { aggregateScores, currentContractGapReport } from "./scorer.js";
import type { PredictionRecord } from "./types.js";

const BOT_ROOT = resolve(import.meta.dirname, "../..");
const DEFAULT_CASES = resolve(BOT_ROOT, "evals/v1/cases.jsonl");
const DEFAULT_TAXONOMY = resolve(BOT_ROOT, "evals/v1/taxonomy.json");
const DEFAULT_MODELS = [
  "anthropic:claude-haiku-4-5",
  "anthropic:claude-sonnet-5",
  "openai:gpt-5.4-mini",
  "openai:gpt-5.5",
].join(",");

function option(name: string, fallback?: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

async function main(): Promise<void> {
  const command = process.argv[2];
  const casesPath = resolve(option("cases", DEFAULT_CASES) as string);
  const taxonomyPath = resolve(option("taxonomy", DEFAULT_TAXONOMY) as string);
  const dataset = await loadDataset({ casesPath, taxonomyPath });

  if (command === "gaps") {
    console.log(
      JSON.stringify(currentContractGapReport(dataset.cases), null, 2),
    );
    return;
  }
  if (command === "score") {
    const predictionsPath = option("predictions");
    if (!predictionsPath) throw new Error("--predictions PATH is required");
    const records = await loadPredictions(resolve(predictionsPath));
    console.log(
      JSON.stringify(aggregateScores(dataset.cases, records), null, 2),
    );
    return;
  }
  if (command !== "run") {
    throw new Error("Usage: cli.ts run|score|gaps [options]");
  }

  const modelValue = option(
    "models",
    process.env.EVAL_MODELS ?? DEFAULT_MODELS,
  ) as string;
  const targets = parseModelTargets(modelValue);
  const repetitions = Number(option("repetitions", "1"));
  if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 10) {
    throw new Error("--repetitions must be an integer from 1 to 10");
  }
  const outputDir = resolve(
    option("output", resolve(BOT_ROOT, "eval-results")) as string,
  );
  await mkdir(outputDir, { recursive: true });

  for (const target of targets) {
    const outputPath = resolve(
      outputDir,
      `${target.provider}-${target.model.replace(/[^a-z0-9_.-]/gi, "_")}.jsonl`,
    );
    await writeFile(outputPath, "", "utf8");
    for (let repetition = 1; repetition <= repetitions; repetition += 1) {
      for (const entry of dataset.cases) {
        const prompt = buildEvaluationPrompt(entry, dataset.taxonomy);
        const started = performance.now();
        let prediction: PredictionRecord["prediction"] = null;
        let error: string | undefined;
        try {
          prediction = await completeEvaluation(target, prompt);
        } catch (caught) {
          error = caught instanceof Error ? caught.message : String(caught);
        }
        const record: PredictionRecord = {
          id: entry.id,
          provider: target.provider,
          model: target.model,
          repetition,
          latency_ms: Math.round(performance.now() - started),
          prompt_hash: promptHash(prompt),
          prediction,
          ...(error ? { error } : {}),
        };
        await appendFile(outputPath, `${JSON.stringify(record)}\n`, "utf8");
      }
    }
    const records = await loadPredictions(outputPath);
    console.log(
      JSON.stringify(aggregateScores(dataset.cases, records), null, 2),
    );
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
