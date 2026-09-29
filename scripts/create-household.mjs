#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import pg from "pg";

const usage =
  "Usage: node scripts/create-household.mjs --name <name> --email <email> [--email <email> ...] [--theme <path-to-json>]";
const tokens = new Set([
  "--ff-bg",
  "--ff-surface",
  "--ff-surface-soft",
  "--ff-tint",
  "--ff-ink",
  "--ff-ink-soft",
  "--ff-accent",
  "--ff-accent-hover",
  "--ff-border",
  "--ff-on-accent",
]);

function parseArgs(args) {
  let name;
  let themePath;
  const emails = [];
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(usage);
    if (flag === "--name" && name === undefined) name = value.trim();
    else if (flag === "--email") emails.push(value.trim().toLowerCase());
    else if (flag === "--theme" && themePath === undefined) themePath = value;
    else throw new Error(usage);
  }
  if (!name || emails.length === 0 || emails.some((email) => !email))
    throw new Error(usage);
  return { name, emails: [...new Set(emails)].sort(), themePath };
}

function validateTheme(theme) {
  if (
    !theme ||
    typeof theme !== "object" ||
    Array.isArray(theme) ||
    !["esmeralda", "salvia"].includes(theme.base) ||
    typeof theme.lockBase !== "boolean" ||
    !theme.overrides ||
    typeof theme.overrides !== "object" ||
    Array.isArray(theme.overrides) ||
    Object.keys(theme).some(
      (key) => !["base", "lockBase", "overrides"].includes(key),
    )
  ) {
    throw new Error(
      "Invalid theme document: expected base, lockBase and overrides",
    );
  }
  for (const [token, value] of Object.entries(theme.overrides)) {
    if (
      !tokens.has(token) ||
      typeof value !== "string" ||
      !/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(value)
    ) {
      throw new Error(`Invalid theme override: ${token}`);
    }
  }
  return theme;
}

async function readTheme(themePath) {
  if (!themePath) return { base: "esmeralda", lockBase: false, overrides: {} };
  let theme;
  try {
    theme = JSON.parse(await readFile(themePath, "utf8"));
  } catch (error) {
    throw new Error(`Invalid theme file: ${error.message}`);
  }
  return validateTheme(theme);
}

async function provision(client, name, emails, theme, categories) {
  await client.query("BEGIN");
  try {
    // Serialize requests for the same name; the schema has no name uniqueness constraint.
    await client.query(
      "select pg_advisory_xact_lock(hashtextextended($1, 0))",
      [name],
    );
    const existing = await client.query(
      "select id from households where name = $1",
      [name],
    );
    if (existing.rows.length > 1)
      throw new Error(
        `Household name conflict: ${name} matches multiple households`,
      );
    if (existing.rows.length === 1) {
      const id = existing.rows[0].id;
      const allowed = await client.query(
        "select lower(email) as email from allowed_emails where household_id = $1 order by email",
        [id],
      );
      const current = allowed.rows.map((row) => row.email);
      if (JSON.stringify(current) !== JSON.stringify(emails)) {
        throw new Error(
          `Household name conflict: ${name} already exists with a different email set`,
        );
      }
      await client.query("COMMIT");
      return id;
    }

    const conflicts = await client.query(
      "select email from allowed_emails where lower(email) = any($1::text[])",
      [emails],
    );
    if (conflicts.rows.length > 0) {
      throw new Error(
        `Email conflict: ${conflicts.rows[0].email} is already allowlisted for another household`,
      );
    }

    const inserted = await client.query(
      "insert into households (name, theme) values ($1, $2::jsonb) returning id",
      [name, JSON.stringify(theme)],
    );
    const id = inserted.rows[0].id;
    for (const category of categories) {
      const result = await client.query(
        "insert into categories (household_id, name, kind) values ($1, $2, $3) returning id",
        [id, category.name, category.kind],
      );
      for (const subcategory of category.subcategories) {
        await client.query(
          "insert into subcategories (household_id, category_id, name) values ($1, $2, $3)",
          [id, result.rows[0].id, subcategory],
        );
      }
    }
    for (const email of emails) {
      try {
        await client.query(
          "insert into allowed_emails (email, household_id) values ($1, $2)",
          [email, id],
        );
      } catch (error) {
        if (error.code === "23505")
          throw new Error(
            `Email conflict: ${email} cannot be allowlisted: ${error.message}`,
          );
        throw error;
      }
    }
    await client.query("COMMIT");
    return id;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
    return;
  }
  const theme = await readTheme(args.themePath);
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
  const categories = JSON.parse(
    await readFile(
      new URL("./default-categories.json", import.meta.url),
      "utf8",
    ),
  );
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  try {
    await client.connect();
    const id = await provision(
      client,
      args.name,
      args.emails,
      theme,
      categories,
    );
    console.log(`household_id=${id}`);
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
