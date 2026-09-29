import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "../../..");

function run(args: string[]) {
  const { DATABASE_URL: _databaseUrl, ...env } = process.env;
  return spawnSync("node", ["scripts/create-household.mjs", ...args], {
    cwd: root,
    encoding: "utf8",
    env,
  });
}

describe("create-household CLI validation", () => {
  it("prints usage and exits 2 without a name or email", () => {
    for (const args of [
      [],
      ["--email", "member@example.test"],
      ["--name", "Casa"],
    ]) {
      const result = run(args);
      expect(result.status).toBe(2);
      expect(result.stderr).toMatch(/usage:.*--name.*--email/i);
    }
  });

  it("requires DATABASE_URL for otherwise valid arguments", () => {
    const result = run(["--name", "Casa", "--email", "member@example.test"]);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("DATABASE_URL");
  });

  it("rejects invalid theme base, token, hex and lockBase without a database", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "household-cli-theme-"));
    try {
      const themes = [
        { base: "unknown", lockBase: true, overrides: {} },
        {
          base: "salvia",
          lockBase: true,
          overrides: { "--ff-secret": "#abc" },
        },
        {
          base: "salvia",
          lockBase: true,
          overrides: { "--ff-accent": "blue" },
        },
        { base: "salvia", lockBase: "true", overrides: {} },
      ];
      for (const [index, theme] of themes.entries()) {
        const file = path.join(dir, `${index}.json`);
        writeFileSync(file, JSON.stringify(theme));
        const result = run([
          "--name",
          "Casa",
          "--email",
          "member@example.test",
          "--theme",
          file,
        ]);
        expect(result.status).not.toBe(0);
        expect(result.stderr).toMatch(/theme|tema/i);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
