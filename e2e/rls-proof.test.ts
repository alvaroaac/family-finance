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
  const env = proofEnv();
  return spawnSync("node", ["deploy/checks/rls-proof.mjs"], {
    cwd: root,
    encoding: "utf8",
    timeout: 180_000,
    env,
  });
}

function markerFrom(output: string) {
  const marker = output
    .split("\n", 1)[0]
    .match(/marker: (rls-proof-[0-9a-f-]{36})/)?.[1];
  expect(marker, output).toBeDefined();
  return marker!;
}

async function expectNoFixtures(db: any, marker: string, emails: string[]) {
  const { rows: tables } = await db.query(`
    select c.relname as name from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p')
  `);
  for (const { name } of tables) {
    const quoted = name.replaceAll('"', '""');
    const result = await db.query(
      `select count(*)::integer as count from public."${quoted}" t where to_jsonb(t)::text like $1`,
      [`%${marker}%`],
    );
    expect(result.rows[0].count, `marker remains in ${name}`).toBe(0);
  }
  const users = await db.query(
    "select email from auth.users where email = any($1::text[]) or raw_user_meta_data ->> 'rls_proof_marker' = $2",
    [emails, marker],
  );
  expect(users.rows).toEqual([]);
}

async function interruptProof(
  signal: "SIGINT" | "SIGTERM" | "SIGKILL",
  env: NodeJS.ProcessEnv,
) {
  return new Promise<{ code: number | null; output: string }>(
    (resolve, reject) => {
      const child = spawn("node", ["deploy/checks/rls-proof.mjs"], {
        cwd: root,
        env,
      });
      let output = "";
      let signaled = false;
      const timeout = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`proof did not exit after ${signal}: ${output}`));
      }, 180_000);
      child.stdout.on("data", (chunk) => {
        output += chunk.toString();
        if (!signaled && output.includes("fixture coverage")) {
          signaled = true;
          child.kill(signal);
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
      const env = proofEnv();
      const result = spawnSync("node", ["deploy/checks/rls-proof.mjs"], {
        cwd: root,
        encoding: "utf8",
        timeout: 180_000,
        env,
      });
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
        "PostgREST rejects auth schema",
        "PostgREST rejects family_finance_migrations schema",
        "trigger provision_household_member",
        "trigger provision_on_allowlist",
        "public email signup does not yield a session or a membership",
        "member cannot update telegram_user_id on own row",
        "member can update display_name in own household",
        "valid code binds its creating member",
        "rejected Telegram link code cannot be reused",
        "expired Telegram link code binds nothing",
        "service role resolves B Telegram id",
        "service role cannot resolve inactive Telegram member",
        "service role cannot resolve an unknown Telegram id",
      ]) {
        expect(result.stdout).toContain(`[PASS] ${check}`);
      }
      expect(await rowCounts(db)).toEqual(before);
      await expectNoFixtures(db, markerFrom(result.stdout), [
        env.MEMBER_EMAIL!,
        env.MEMBER_B_EMAIL!,
        env.OUTSIDER_EMAIL!,
      ]);
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
        await expectNoFixtures(db, markerFrom(result.stdout), []);
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
        await expectNoFixtures(db, markerFrom(result.stdout), []);
      } finally {
        await db.query(`drop function public."${name}"(uuid)`);
      }
    });
  }, 240_000);

  it("fails by name for a household FK with another column name", async () => {
    await withDatabase(async (db) => {
      const name = `rls_proof_fk_${randomUUID().replaceAll("-", "")}`;
      await db.query(`create table public."${name}" (
        id uuid primary key, owner_household uuid references public.households(id))`);
      try {
        const result = runProof();
        expect(result.status).not.toBe(0);
        expect(result.stdout).toContain(`${name}.owner_household`);
        await expectNoFixtures(db, markerFrom(result.stdout), []);
      } finally {
        await db.query(`drop table public."${name}"`);
      }
    });
  }, 240_000);

  it("fails by name for unhandled public views and materialized views", async () => {
    await withDatabase(async (db) => {
      for (const kind of ["view", "materialized view"]) {
        const name = `rls_proof_view_${randomUUID().replaceAll("-", "")}`;
        await db.query(
          `create ${kind} public."${name}" as select id from public.households`,
        );
        try {
          const result = runProof();
          expect(result.status).not.toBe(0);
          expect(result.stdout).toContain(`view coverage public.${name}`);
          await expectNoFixtures(db, markerFrom(result.stdout), []);
        } finally {
          await db.query(`drop ${kind} public."${name}"`);
        }
      }
    });
  }, 240_000);

  it("cleans up its fixtures when interrupted", async () => {
    await withDatabase(async (db) => {
      const before = await rowCounts(db);
      const env = proofEnv();
      const result = await interruptProof("SIGINT", env);
      expect(result.code).not.toBe(0);
      expect(result.output).toContain("SIGINT interrupted proof");
      expect(await rowCounts(db)).toEqual(before);
      await expectNoFixtures(db, markerFrom(result.output), [
        env.MEMBER_EMAIL!,
        env.MEMBER_B_EMAIL!,
        env.OUTSIDER_EMAIL!,
      ]);
    });
  }, 240_000);

  it("cleans up its fixtures on SIGTERM", async () => {
    await withDatabase(async (db) => {
      const before = await rowCounts(db);
      const env = proofEnv();
      const result = await interruptProof("SIGTERM", env);
      expect(result.code).not.toBe(0);
      expect(result.output).toContain("SIGTERM interrupted proof");
      expect(await rowCounts(db)).toEqual(before);
      await expectNoFixtures(db, markerFrom(result.output), [
        env.MEMBER_EMAIL!,
        env.MEMBER_B_EMAIL!,
        env.OUTSIDER_EMAIL!,
      ]);
    });
  }, 240_000);

  it("recovers fixtures left by SIGKILL using the printed marker", async () => {
    await withDatabase(async (db) => {
      const before = await rowCounts(db);
      const env = proofEnv();
      const killed = await interruptProof("SIGKILL", env);
      expect(killed.code).not.toBe(0);
      const marker = markerFrom(killed.output);
      const cleanup = spawnSync(
        "node",
        ["deploy/checks/rls-proof.mjs", "--cleanup", marker],
        {
          cwd: root,
          encoding: "utf8",
          timeout: 180_000,
          env,
        },
      );
      expect(cleanup.status, cleanup.stdout + cleanup.stderr).toBe(0);
      expect(cleanup.stdout).toContain(`Cleanup ${marker}:`);
      expect(await rowCounts(db)).toEqual(before);
      await expectNoFixtures(db, marker, [
        env.MEMBER_EMAIL!,
        env.MEMBER_B_EMAIL!,
        env.OUTSIDER_EMAIL!,
      ]);
    });
  }, 240_000);
});
