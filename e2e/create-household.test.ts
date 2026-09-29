import { spawnSync, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { createTestUser } from "./lib/users.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);
const databaseUrl = execFileSync("pnpm", ["e2e:env"], {
  cwd: root,
  encoding: "utf8",
})
  .split("\n")
  .find((line) => line.startsWith("DATABASE_URL="))
  ?.slice("DATABASE_URL=".length)
  .replace(/^"|"$/g, "");

function run(args: string[]) {
  return spawnSync("node", ["scripts/create-household.mjs", ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, DATABASE_URL: databaseUrl },
  });
}

async function rows(table: string, householdId: string) {
  const { data, error } = await admin
    .from(table)
    .select("*")
    .eq("household_id", householdId);
  expect(error).toBeNull();
  return data ?? [];
}

async function household(name: string) {
  const { data, error } = await admin
    .from("households")
    .select("id,theme")
    .eq("name", name);
  expect(error).toBeNull();
  return data ?? [];
}

describe("create-household provisioning", () => {
  it("creates one complete household and repeating the same name and email set changes nothing", async () => {
    const name = `Casa ${randomUUID()}`;
    const firstEmail = `first-${randomUUID()}@example.test`;
    const secondEmail = `second-${randomUUID()}@example.test`;
    const dir = mkdtempSync(path.join(tmpdir(), "household-theme-"));
    const themeFile = path.join(dir, "theme.json");
    const theme = {
      base: "salvia",
      lockBase: true,
      overrides: { "--ff-accent": "#a1b2c3" },
    };
    writeFileSync(themeFile, JSON.stringify(theme));
    try {
      const args = [
        "--name",
        name,
        "--email",
        firstEmail.toUpperCase(),
        "--email",
        secondEmail,
        "--theme",
        themeFile,
      ];
      const created = run(args);
      expect(created.status, created.stderr).toBe(0);
      expect(created.stdout).toMatch(/^household_id=[0-9a-f-]{36}\n$/);
      const id = created.stdout.trim().slice("household_id=".length);
      expect(await household(name)).toEqual([{ id, theme }]);
      expect(
        (await rows("allowed_emails", id)).map((row) => row.email).sort(),
      ).toEqual([firstEmail, secondEmail].sort());

      const categories = await rows("categories", id);
      expect(categories.map(({ name, kind }) => [name, kind]).sort()).toEqual(
        [
          ["Alimentação", "expense"],
          ["Moradia", "expense"],
          ["Transporte", "expense"],
          ["Saúde", "expense"],
          ["Lazer", "expense"],
          ["Educação", "expense"],
          ["Receitas", "income"],
          ["Salário", "income"],
          ["Freelas", "income"],
          ["Investimentos", "income"],
          ["Outros", "expense"],
        ].sort(),
      );
      const subcategories = await rows("subcategories", id);
      expect(
        subcategories
          .map((row) => [
            categories.find((category) => category.id === row.category_id)
              ?.name,
            row.name,
          ])
          .sort(),
      ).toEqual([
        ["Alimentação", "Mercado"],
        ["Alimentação", "Restaurante"],
      ]);
      for (const table of ["investment_buckets", "accounts", "credit_cards"]) {
        expect(await rows(table, id)).toEqual([]);
      }

      const repeated = run([
        "--name",
        name,
        "--email",
        secondEmail.toUpperCase(),
        "--email",
        firstEmail,
        "--theme",
        themeFile,
      ]);
      expect(repeated.status, repeated.stderr).toBe(0);
      expect(repeated.stdout).toBe(created.stdout);
      expect(await household(name)).toEqual([{ id, theme }]);
      expect(await rows("categories", id)).toEqual(categories);
      expect(await rows("subcategories", id)).toEqual(subcategories);
      expect(
        (await rows("allowed_emails", id)).map((row) => row.email).sort(),
      ).toEqual([firstEmail, secondEmail].sort());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a different email set for an existing name without changing it", async () => {
    const name = `Casa ${randomUUID()}`;
    const email = `member-${randomUUID()}@example.test`;
    const created = run(["--name", name, "--email", email]);
    expect(created.status, created.stderr).toBe(0);
    const id = created.stdout.trim().slice("household_id=".length);
    const categories = await rows("categories", id);
    const changed = run([
      "--name",
      name,
      "--email",
      `other-${randomUUID()}@example.test`,
    ]);
    expect(changed.status).not.toBe(0);
    expect(changed.stderr).toMatch(/conflict|conflito/i);
    expect(changed.stderr).toContain(name);
    expect(await household(name)).toHaveLength(1);
    expect((await rows("allowed_emails", id)).map((row) => row.email)).toEqual([
      email,
    ]);
    expect(await rows("categories", id)).toEqual(categories);
  });

  it("rolls back when an email is already allowlisted in another household", async () => {
    const firstName = `Casa ${randomUUID()}`;
    const secondName = `Casa ${randomUUID()}`;
    const email = `shared-${randomUUID()}@example.test`;
    expect(run(["--name", firstName, "--email", email]).status).toBe(0);
    const attempt = run([
      "--name",
      secondName,
      "--email",
      `free-${randomUUID()}@example.test`,
      "--email",
      email.toUpperCase(),
    ]);
    expect(attempt.status).not.toBe(0);
    expect(attempt.stderr).toContain(email);
    expect(await household(secondName)).toEqual([]);
  });

  it("rolls back when an existing user belongs to another household", async () => {
    const email = `member-${randomUUID()}@example.test`;
    const { userId } = await createTestUser(email, "Test-password-123!");
    const { error } = await admin.from("household_members").insert({
      household_id: "00000000-0000-0000-0000-000000000001",
      user_id: userId,
    });
    expect(error).toBeNull();
    const name = `Casa ${randomUUID()}`;
    const attempt = run(["--name", name, "--email", email]);
    expect(attempt.status).not.toBe(0);
    expect(attempt.stderr).toContain(email);
    expect(await household(name)).toEqual([]);
  });

  it("rejects an invalid theme before writing any household", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "household-theme-"));
    try {
      for (const [label, theme] of Object.entries({
        base: { base: "unknown", lockBase: true, overrides: {} },
        token: {
          base: "salvia",
          lockBase: true,
          overrides: { "--ff-secret": "#fff" },
        },
        color: {
          base: "salvia",
          lockBase: true,
          overrides: { "--ff-accent": "blue" },
        },
      })) {
        const name = `Invalid ${label} ${randomUUID()}`;
        const themeFile = path.join(dir, `${label}.json`);
        writeFileSync(themeFile, JSON.stringify(theme));
        const attempt = run([
          "--name",
          name,
          "--email",
          `test-${randomUUID()}@example.test`,
          "--theme",
          themeFile,
        ]);
        expect(attempt.status).not.toBe(0);
        expect(attempt.stderr).toMatch(/theme|tema/i);
        expect(await household(name)).toEqual([]);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
