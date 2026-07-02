import { defineConfig } from "vitest/config";

/**
 * Vitest config for the web app.
 *
 * The browser-level Playwright spec lives at `e2e/*.spec.ts` and runs against a
 * real dev server + Supabase (see docs/runbooks/local-mvp-verification.md). It
 * is NOT a vitest test, so it is excluded here; `pnpm test` runs only the unit
 * and offline integration tests (`lib/**`, `integration/**`).
 */
export default defineConfig({
  // Next's tsconfig uses `jsx: "preserve"` (the Next compiler handles JSX).
  // Vitest runs .tsx through esbuild, so pick React's automatic runtime here —
  // needed by the renderToStaticMarkup primitive tests.
  esbuild: { jsx: "automatic" },
  test: {
    // Vitest's default exclude list (node_modules, dist, .next, etc.) plus the
    // Playwright e2e specs so they never get collected by vitest.
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.next/**",
      "**/.{idea,git,cache,output,temp}/**",
      "e2e/**",
    ],
  },
});
