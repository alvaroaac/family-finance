import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright config for the browser-level MVP flow (Task 11, part B).
 *
 * This drives the REAL app: a running Next.js dev server backed by a real
 * Supabase project (auth + RLS). It is NOT part of `pnpm test` (vitest excludes
 * `e2e/**`); run it explicitly with `pnpm --filter @family-finance/web test:e2e`
 * after `npx playwright install`. See docs/runbooks/local-mvp-verification.md.
 *
 * Required environment (no secrets committed):
 *   E2E_BASE_URL              default http://localhost:3000
 *   E2E_STORAGE_STATE         optional path to a pre-authenticated session
 *                             (Google OAuth cannot be scripted headlessly), e.g.
 *                             produced once via a manual login + `page.context().storageState`.
 */

const baseURL = process.env.E2E_BASE_URL ?? "http://localhost:3000";

export default defineConfig({
  testDir: "./e2e",
  // Only the Playwright specs; the offline vitest integration test lives under
  // integration/ and must never be picked up here.
  testMatch: /.*\.spec\.ts/,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : "list",
  use: {
    baseURL,
    trace: "on-first-retry",
    storageState: process.env.E2E_STORAGE_STATE,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
  ],
  // Start the dev server automatically unless one is already running.
  webServer: process.env.E2E_NO_SERVER
    ? undefined
    : {
        command: "pnpm dev",
        url: baseURL,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
      },
});
