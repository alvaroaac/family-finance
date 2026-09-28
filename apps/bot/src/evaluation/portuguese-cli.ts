import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { loadEnvFile } from "node:process";
import { loadDataset, readJsonl } from "./dataset.js";
import {
  buildRequest,
  completePortuguese,
  hashRequest,
  projectCases,
  summarize,
  wireRequest,
  type Case,
  type RecordRow,
} from "./portuguese.js";

const root = resolve(import.meta.dirname, "../..");
const option = (name: string, fallback: string) => {
  const index = process.argv.indexOf(`--${name}`);
  return index < 0 ? fallback : (process.argv[index + 1] ?? fallback);
};
async function main() {
  const env = resolve(root, "../../.env");
  if (existsSync(env)) loadEnvFile(env);
  const { cases: original, taxonomy } = await loadDataset({
    casesPath: resolve(root, "evals/v1/cases.jsonl"),
    taxonomyPath: resolve(root, "evals/v1/taxonomy.json"),
  });
  const cases = [
    ...projectCases(original),
    ...(await readJsonl<Case>(
      resolve(root, "evals/portuguese-v1/cases.jsonl"),
    )),
  ];
  const ids = new Set<string>();
  const options = buildRequest({ text: "" }, taxonomy).questions.category
    .criteria;
  for (const c of cases) {
    if (ids.has(c.id) || !c.text || !["dev", "test"].includes(c.split))
      throw new Error(`Invalid case ${c.id}`);
    ids.add(c.id);
    for (const label of c.gold.acceptable)
      if (!(label in options) && c.gold.decision !== "propose_new")
        throw new Error(`Unknown gold category ${label}`);
  }
  const providers = option("providers", "jev,anthropic").split(",");
  if (
    !providers.length ||
    providers.some((p) => !["jev", "anthropic"].includes(p)) ||
    new Set(providers).size !== providers.length
  )
    throw new Error(
      "--providers must contain jev and/or anthropic without duplicates",
    );
  const repetitions = Number(option("repetitions", "3"));
  if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 10)
    throw new Error("Invalid repetitions");
  const selected = option("split", "all");
  if (!["all", "dev", "test"].includes(selected))
    throw new Error("Invalid split");
  const selectedCases = cases.filter(
    (c) => selected === "all" || c.split === selected,
  );
  const dry = process.argv.includes("--dry-run");
  if (dry) {
    console.log(
      JSON.stringify(
        {
          cases: selectedCases.length,
          dev: selectedCases.filter((c) => c.split === "dev").length,
          test: selectedCases.filter((c) => c.split === "test").length,
          providers,
          repetitions,
          requests: providers.length * repetitions * selectedCases.length,
        },
        null,
        2,
      ),
    );
    return;
  }
  for (const p of providers)
    if (
      !process.env[
        p === "jev" ? "TYPESAFE_API_KEY" : "ANTHROPIC_API_KEY"
      ]?.trim()
    )
      throw new Error(`Missing key for ${p}; no requests made`);
  const output = resolve(
    option(
      "output",
      resolve(
        root,
        "eval-results",
        `portuguese-${new Date().toISOString().replace(/[:.]/g, "-")}`,
      ),
    ),
  );
  await mkdir(output, { recursive: true });
  const manifest = {
    version: "portuguese-categorization-v1.1",
    validation:
      "complete option sets; probability sum tolerance 0.01 + 1e-9; raw responses retained",
    created_at: new Date().toISOString(),
    repetitions,
    concurrency: 4,
    limitations: [
      "Draft hand-labelled examples, not a representative production sample",
      "Category-only projection: no purpose, amount/date extraction, accounting or generated category names",
      "Generative baseline probabilities are self-reported, unlike Jev's native distributions",
      "High probability means selected category probability >= 0.85, not Jev confidence",
      "Failed calls count as incorrect; latency covers successful calls only; failed-call billing unknown",
    ],
    cases: selectedCases,
    taxonomy,
    requests: selectedCases.map((c) => ({
      id: c.id,
      request: wireRequest(buildRequest(c, taxonomy)),
    })),
    prices: {
      jev: {
        input_per_million_usd: 0.042,
        output_per_million_usd: 0,
        source: "https://docs.typesafe.ai/models",
      },
      anthropic: {
        input_per_million_usd: 1,
        output_per_million_usd: 5,
        source: "https://platform.claude.com/docs/en/about-claude/pricing",
      },
    },
  };
  await writeFile(
    resolve(output, "manifest.json"),
    JSON.stringify(manifest, null, 2),
    { flag: "wx" },
  );
  const reports: Record<string, unknown> = {};
  for (const provider of providers as RecordRow["provider"][]) {
    const model = option(
      provider === "jev" ? "jev-model" : "baseline-model",
      provider === "jev" ? "jev-1.13.0" : "claude-haiku-4-5-20251001",
    );
    const records: RecordRow[] = [];
    const path = resolve(output, `${provider}.jsonl`);
    await writeFile(path, "", { flag: "wx" });
    const jobs = Array.from({ length: repetitions }, (_, index) =>
      selectedCases.map((entry) => ({ entry, repetition: index + 1 })),
    ).flat();
    for (let offset = 0; offset < jobs.length; offset += 4) {
      const completed = await Promise.allSettled(
        jobs.slice(offset, offset + 4).map(async ({ entry, repetition }) => {
          const request = buildRequest(entry, taxonomy);
          const started = performance.now();
          const record: RecordRow = {
            id: entry.id,
            split: entry.split,
            origin: entry.origin,
            provider,
            model,
            repetition,
            latency_ms: 0,
            request_hash: hashRequest(wireRequest(request)),
            prediction: null,
            usage: null,
          };
          try {
            Object.assign(
              record,
              await completePortuguese(provider, model, request),
            );
          } catch (error) {
            record.error =
              error instanceof Error ? error.message : String(error);
          }
          record.latency_ms = Math.round(performance.now() - started);
          records.push(record);
          await appendFile(path, JSON.stringify(record) + "\n");
          console.error(
            `${provider} ${records.length}/${selectedCases.length * repetitions} ${entry.id}: ${record.error ?? "ok"} (${record.latency_ms}ms)`,
          );
          // An invalid key/model/credit state should not spend the entire run failing.
          if (record.error && /HTTP (400|401|402|403|404)/.test(record.error))
            throw new Error(
              `${record.error}; partial records saved in ${output}`,
            );
        }),
      );
      const failed = completed.find((result) => result.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
    }
    const knownPricing =
      (provider === "jev" && model === "jev-1.13.0") ||
      (provider === "anthropic" && model === "claude-haiku-4-5-20251001");
    const price = manifest.prices[provider];
    const cost = knownPricing
      ? records.reduce(
          (sum, r) =>
            sum +
            (r.usage
              ? (r.usage.input_tokens * price.input_per_million_usd +
                  r.usage.output_tokens * price.output_per_million_usd) /
                1e6
              : 0),
          0,
        )
      : null;
    reports[provider] = {
      requested_model: model,
      returned_models: [...new Set(records.map((r) => r.model))],
      recorded_usage_cost_usd: cost,
      cost_complete: knownPricing && records.every((r) => r.usage !== null),
      all: summarize(selectedCases, records),
      dev: summarize(
        selectedCases,
        records.filter((r) => r.split === "dev"),
      ),
      test: summarize(
        selectedCases,
        records.filter((r) => r.split === "test"),
      ),
      added_cases: summarize(
        selectedCases,
        records.filter((r) => r.origin === "portuguese-v1"),
      ),
    };
    await writeFile(
      resolve(output, "report.json"),
      JSON.stringify(reports, null, 2),
    );
  }
  console.log(JSON.stringify({ output, reports }, null, 2));
}
main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
