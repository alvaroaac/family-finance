import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const UI_DIR = join(__dirname, "..", "components", "ui");
const FORBIDDEN = [
  /@family-finance\//, // domain/db/config/etc.
  /from\s+["'].*\/lib\//, // apps/web/lib helpers
  /next\/headers/,
  /next\/cache/, // server context — pages' job
  /from\s+["'].*\/app\//, // app routes
];

describe("design firewall — components/ui is presentational only", () => {
  it("ui/ exists and no file imports logic layers", () => {
    expect(existsSync(UI_DIR)).toBe(true);
    for (const f of readdirSync(UI_DIR).filter((f) => /\.(ts|tsx)$/.test(f))) {
      const src = readFileSync(join(UI_DIR, f), "utf8");
      for (const rule of FORBIDDEN) {
        expect(src, `${f} violates the design firewall: ${rule}`).not.toMatch(rule);
      }
    }
  });
});
