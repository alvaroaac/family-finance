import { spawn, spawnSync, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(new URL("../package.json", import.meta.url));
const { Client } = require("pg");
const databaseUrl = execFileSync("pnpm", ["e2e:env"], {
  cwd: root,
  encoding: "utf8",
})
  .split("\n")
  .find((line) => line.startsWith("DATABASE_URL="))
  ?.slice("DATABASE_URL=".length)
  .replace(/^"|"$/g, "");

function proofEnv() {
  const id = randomUUID();
  return {
    ...process.env,
    DATABASE_URL: databaseUrl,
    SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
    MEMBER_EMAIL: `proof-a-${id}@example.test`,
    MEMBER_PASSWORD: `Proof-a-${id}!`,
    MEMBER_B_EMAIL: `proof-b-${id}@example.test`,
    MEMBER_B_PASSWORD: `Proof-b-${id}!`,
    OUTSIDER_EMAIL: `proof-outsider-${id}@example.test`,
    OUTSIDER_PASSWORD: `Proof-outsider-${id}!`,
  };
}

function runProof() {
  return spawnSync("node", ["deploy/checks/rls-proof.mjs"], {
    cwd: root,
    encoding: "utf8",
    timeout: 180_000,
    env: proofEnv(),
  });
}

async function withDatabase<T>(callback: (db: any) => Promise<T>): Promise<T> {
  const db = new Client({ connectionString: databaseUrl });
  await db.connect();
  try {
    return await callback(db);
  } finally {
    await db.end();
  }
}

async function rowCounts(db: any) {
  const { rows } = await db.query(`
    select c.relname as name
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p')
    order by c.relname
  `);
  const counts: Record<string, number> = {};
  for (const { name } of rows) {
    const quoted = name.replaceAll('"', '""');
    const result = await db.query(
      `select count(*)::integer as count from public."${quoted}"`,
    );
    counts[name] = result.rows[0].count;
  }
  for (const name of ["users", "identities"]) {
    const result = await db.query(
      `select count(*)::integer as count from auth.${name}`,
    );
    counts[`auth.${name}`] = result.rows[0].count;
  }
  return counts;
}

describe("two-household RLS proof", () => {
  it("prints PASS for every isolation check and leaves all table counts unchanged", async () => {
    await withDatabase(async (db) => {
      const before = await rowCounts(db);
      const result = runProof();
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(result.stdout).not.toContain("[FAIL]");
      for (const check of [
        "households theme",
        "inactive member",
        "composite FK category",
        "composite FK account",
        "composite FK card",
        "composite FK subcategory",
        "no-policy bot_conversations",
        "no-policy allowed_emails",
        "no-policy import_suggestion_nonces",
      ]) {
        expect(result.stdout).toContain(`[PASS] ${check}`);
      }
      expect(await rowCounts(db)).toEqual(before);
    });
  }, 240_000);

  it("fails by name for an unhandled household table and still cleans up", async () => {
    await withDatabase(async (db) => {
      const name = `rls_proof_unknown_${randomUUID().replaceAll("-", "")}`;
      await db.query(
        `create table public."${name}" (id uuid primary key, household_id uuid not null)`,
      );
      try {
        const before = await rowCounts(db);
        const result = runProof();
        expect(result.status).not.toBe(0);
        expect(result.stdout + result.stderr).toContain(name);
        expect(await rowCounts(db)).toEqual(before);
      } finally {
        await db.query(`drop table public."${name}"`);
      }
    });
  }, 240_000);

  it("fails by name for an unhandled security definer and still cleans up", async () => {
    await withDatabase(async (db) => {
      const name = `rls_proof_unknown_${randomUUID().replaceAll("-", "")}`;
      await db.query(`create function public."${name}"(target_household_id uuid)
        returns uuid language sql security definer set search_path = public
        as 'select target_household_id'`);
      try {
        const before = await rowCounts(db);
        const result = runProof();
        expect(result.status).not.toBe(0);
        expect(result.stdout + result.stderr).toContain(name);
        expect(await rowCounts(db)).toEqual(before);
      } finally {
        await db.query(`drop function public."${name}"(uuid)`);
      }
    });
  }, 240_000);

  it("cleans up its fixtures when interrupted", async () => {
    await withDatabase(async (db) => {
      const before = await rowCounts(db);
      const result = await new Promise<{ code: number | null; output: string }>(
        (resolve, reject) => {
          const child = spawn("node", ["deploy/checks/rls-proof.mjs"], {
            cwd: root,
            env: proofEnv(),
          });
          let output = "";
          let signaled = false;
          const timeout = setTimeout(() => {
            child.kill("SIGKILL");
            reject(new Error(`proof did not exit after SIGINT: ${output}`));
          }, 180_000);
          child.stdout.on("data", (chunk) => {
            output += chunk.toString();
            if (!signaled && output.includes("fixture coverage")) {
              signaled = true;
              child.kill("SIGINT");
            }
          });
          child.stderr.on("data", (chunk) => {
            output += chunk.toString();
          });
          child.on("error", reject);
          child.on("close", (code) => {
            clearTimeout(timeout);
            resolve({ code, output });
          });
        },
      );
      expect(result.code).not.toBe(0);
      expect(result.output).toContain("SIGINT interrupted proof");
      expect(await rowCounts(db)).toEqual(before);
    });
  }, 240_000);
});
