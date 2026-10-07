import { defineConfig, devices } from "@playwright/test";

import { E2E_EMAIL, LOCAL_STORAGE_STATE } from "./e2e/local-env";

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
 *
 * `pnpm test:e2e:local` (E2E_LOCAL_SUPABASE=1) instead runs the card-bill
 * scenario against the disposable stack from scripts/e2e-local-stack.sh: a
 * setup project seeds it and signs in with a password user, and the dev server
 * starts on :3100 pointed at that stack.
 */

const local = process.env.E2E_LOCAL_SUPABASE === "1";
const baseURL =
  process.env.E2E_BASE_URL ??
  (local ? "http://localhost:3100" : "http://localhost:3000");

const localServerEnv = {
  NEXT_PUBLIC_SUPABASE_URL: process.env.E2E_SUPABASE_URL ?? "",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.E2E_SUPABASE_ANON_KEY ?? "",
  SUPABASE_SERVICE_ROLE_KEY: process.env.E2E_SUPABASE_SERVICE_ROLE_KEY ?? "",
  NEXT_PUBLIC_SITE_URL: baseURL,
  AUTHORIZED_EMAILS: E2E_EMAIL,
};

export default defineConfig({
  testDir: "./e2e",
  // Only the Playwright specs; the offline vitest integration test lives under
  // integration/ and must never be picked up here.
  testMatch: /.*\.spec\.ts/,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI
    ? "github"
    : local
      ? [["list"], ["html", { open: "never" }]]
      : "list",
  use: {
    baseURL,
    trace: local ? "on" : "on-first-retry",
    screenshot: local ? "on" : "off",
    storageState: process.env.E2E_STORAGE_STATE,
  },
  projects: local
    ? [
        { name: "local-setup", testMatch: /local-auth\.setup\.ts/ },
        {
          name: "local-chromium",
          testMatch: /card-bill-payments\.spec\.ts/,
          dependencies: ["local-setup"],
          use: {
            ...devices["Desktop Chrome"],
            storageState: LOCAL_STORAGE_STATE,
          },
        },
      ]
    : [
        {
          name: "chromium",
          testIgnore: /card-bill-payments\.spec\.ts/,
          use: { ...devices["Desktop Chrome"] },
        },
      ],
  // Start the dev server automatically unless one is already running.
  webServer: process.env.E2E_NO_SERVER
    ? undefined
    : {
        command: local ? "pnpm dev --port 3100" : "pnpm dev",
        url: baseURL,
        // Never reuse a server that may point at another database.
        reuseExistingServer: !process.env.CI && !local,
        timeout: 120_000,
        env: local ? localServerEnv : undefined,
      },
});
