import { readFile } from "node:fs/promises";

import type { EvalCase, PredictionRecord, Taxonomy } from "./types.js";

export async function readJsonFile<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

export async function readJsonl<T>(path: string): Promise<T[]> {
  const text = await readFile(path, "utf8");
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line) as T;
      } catch (error) {
        throw new Error(
          `${path}:${index + 1}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    });
}

export function validateCases(cases: EvalCase[]): void {
  const ids = new Set<string>();
  for (const entry of cases) {
    if (!entry.id || ids.has(entry.id)) {
      throw new Error(`Missing or duplicate evaluation id: ${entry.id}`);
    }
    ids.add(entry.id);
    if (!entry.input?.text || !entry.gold?.intent) {
      throw new Error(`${entry.id}: missing input text or gold intent`);
    }
    if (entry.gold.categorization.acceptable.length > 3) {
      throw new Error(`${entry.id}: gold acceptable categories exceed top-3`);
    }
  }
}

export async function loadDataset(args: {
  casesPath: string;
  taxonomyPath: string;
}): Promise<{ cases: EvalCase[]; taxonomy: Taxonomy }> {
  const [cases, taxonomy] = await Promise.all([
    readJsonl<EvalCase>(args.casesPath),
    readJsonFile<Taxonomy>(args.taxonomyPath),
  ]);
  validateCases(cases);
  return { cases, taxonomy };
}

export async function loadPredictions(
  path: string,
): Promise<PredictionRecord[]> {
  return readJsonl<PredictionRecord>(path);
}
