import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "harness.test.ts",
      "create-household.test.ts",
      "rls-proof.test.ts",
      "bot-multi-tenant.test.ts",
    ],
    testTimeout: 180_000,
    maxWorkers: 1,
    minWorkers: 1,
  },
});
