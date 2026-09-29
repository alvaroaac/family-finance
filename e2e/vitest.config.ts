import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["harness.test.ts", "create-household.test.ts"],
    testTimeout: 180_000,
    maxWorkers: 1,
    minWorkers: 1,
  },
});
