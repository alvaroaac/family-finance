/** Shared fixtures for the local-Supabase e2e run (test values only). */

import { join } from "node:path";

export const E2E_EMAIL = "e2e@family-finance.test";
export const E2E_PASSWORD = "e2e-local-only-password";
export const E2E_ACCOUNT = "Conta E2E";
export const E2E_CARD = "Nubank E2E";
export const E2E_SEED_PURCHASE = { description: "Mercado E2E", cents: 30000 };

// Playwright runs from apps/web; test-results/ is gitignored.
export const LOCAL_STORAGE_STATE = join(
  process.cwd(),
  "test-results",
  ".auth",
  "local.json",
);

/** Today in the household timezone, YYYY-MM-DD. */
export function todaySp(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
  }).format(new Date());
}

/** YYYY-MM shifted by `delta` months. */
export function addMonths(month: string, delta: number): string {
  const [year, mon] = month.split("-").map(Number) as [number, number];
  const index = year * 12 + (mon - 1) + delta;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}`;
}

/** MM/YYYY, the label the UI uses for a fatura month. */
export function monthLabel(month: string): string {
  return `${month.slice(5, 7)}/${month.slice(0, 4)}`;
}
