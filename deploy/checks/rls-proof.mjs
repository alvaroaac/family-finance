#!/usr/bin/env node
/**
 * RLS / RPC proof script (spec §4.4 verification gate).
 *
 * Proves, against a RUNNING Supabase stack (local or VPS), that:
 *   (a) a household member SELECTing via the anon key + their session sees the
 *       household's rows on transactions / accounts / credit_cards / categories;
 *   (b) an authenticated OUTSIDER (valid login, no household_members row) sees
 *       ZERO rows on those same tables;
 *   (c) the outsider cannot INSERT into transactions (RLS with-check rejects);
 *   (d) the 3 SECURITY DEFINER RPCs roll back atomically on bad input:
 *       - merge_category with a bogus target id → error, source category stays
 *         active and its transactions keep their category;
 *       - confirm_import where the SECOND row's transaction has amount <= 0 →
 *         error, and NO batch / transactions / import_rows persist (row 1 was
 *         valid — proves all-or-nothing);
 *       - create_installment_purchase with an invalid parcel → error, no
 *         orphan installment_groups row left behind.
 *
 * Config via env (all required):
 *   SUPABASE_URL          e.g. http://localhost:54321 or the VPS HTTPS URL
 *   SUPABASE_ANON_KEY     anon JWT (what browsers use)
 *   SERVICE_ROLE_KEY      service-role JWT — used ONLY for setup/teardown
 *                         (create/delete the two test users + fixtures)
 *   MEMBER_EMAIL / MEMBER_PASSWORD       test member credentials
 *   OUTSIDER_EMAIL / OUTSIDER_PASSWORD   test outsider credentials
 *
 * Use throwaway emails that are NOT in `allowed_emails` — the script inserts
 * the member's household_members row itself and deletes both users at the end.
 *
 * Run from the repo root after `pnpm install` (resolves @supabase/supabase-js
 * out of packages/db):
 *
 *   SUPABASE_URL=... SUPABASE_ANON_KEY=... SERVICE_ROLE_KEY=... \
 *   MEMBER_EMAIL=rls-proof.member@example.com MEMBER_PASSWORD=... \
 *   OUTSIDER_EMAIL=rls-proof.outsider@example.com OUTSIDER_PASSWORD=... \
 *   node deploy/checks/rls-proof.mjs
 *
 * Prints PASS/FAIL per check; exits non-zero if ANY check fails.
 */

import { createRequire } from "node:module";

// This file lives outside the pnpm workspaces, so resolve supabase-js through
// packages/db (which declares it as a dependency).
const require = createRequire(
  new URL("../../packages/db/package.json", import.meta.url),
);
const { createClient } = require("@supabase/supabase-js");

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function requiredEnv(name) {
  const value = process.env[name];
  if (typeof value !== "string" || value.length === 0) {
    console.error(`Missing required env var: ${name}`);
    process.exit(2);
  }
  return value;
}

const SUPABASE_URL = requiredEnv("SUPABASE_URL");
const SUPABASE_ANON_KEY = requiredEnv("SUPABASE_ANON_KEY");
const SERVICE_ROLE_KEY = requiredEnv("SERVICE_ROLE_KEY");
const MEMBER_EMAIL = requiredEnv("MEMBER_EMAIL");
const MEMBER_PASSWORD = requiredEnv("MEMBER_PASSWORD");
const OUTSIDER_EMAIL = requiredEnv("OUTSIDER_EMAIL");
const OUTSIDER_PASSWORD = requiredEnv("OUTSIDER_PASSWORD");

// Unique marker so fixtures never collide with real data and teardown is safe.
const MARKER = `rls-proof-${Date.now()}`;

// ---------------------------------------------------------------------------
// Check harness
// ---------------------------------------------------------------------------

const results = [];

function record(name, ok, detail = "") {
  results.push({ name, ok });
  const status = ok ? "PASS" : "FAIL";
  console.log(`[${status}] ${name}${detail ? ` — ${detail}` : ""}`);
}

// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false },
});

function anonClient() {
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

// ---------------------------------------------------------------------------
// Setup / teardown (service role ONLY here)
// ---------------------------------------------------------------------------

const created = {
  memberUserId: null,
  outsiderUserId: null,
  accountId: null,
  creditCardId: null,
  categoryId: null,
  transactionId: null,
  membershipInserted: false,
};

async function createUser(email, password) {
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error) throw new Error(`createUser(${email}) failed: ${error.message}`);
  return data.user.id;
}

async function setup() {
  // Single-household MVP: the seeded "Casa" household is the target.
  const { data: household, error: hhError } = await admin
    .from("households")
    .select("id")
    .limit(1)
    .single();
  if (hhError) throw new Error(`household lookup failed: ${hhError.message}`);
  const householdId = household.id;

  created.memberUserId = await createUser(MEMBER_EMAIL, MEMBER_PASSWORD);
  created.outsiderUserId = await createUser(OUTSIDER_EMAIL, OUTSIDER_PASSWORD);

  // Member joins the household; the outsider deliberately does NOT.
  const { error: memberError } = await admin.from("household_members").insert({
    household_id: householdId,
    user_id: created.memberUserId,
    role: "member",
    is_active: true,
  });
  if (memberError) {
    throw new Error(`household_members insert failed: ${memberError.message}`);
  }
  created.membershipInserted = true;

  // Fixtures the SELECT checks look for. The transaction references the
  // category so the bogus merge_category target trips the FK and rolls back.
  const { data: account, error: accError } = await admin
    .from("accounts")
    .insert({ household_id: householdId, kind: "checking", name: `${MARKER} account` })
    .select("id")
    .single();
  if (accError) throw new Error(`account insert failed: ${accError.message}`);
  created.accountId = account.id;

  const { data: card, error: cardError } = await admin
    .from("credit_cards")
    .insert({ household_id: householdId, name: `${MARKER} card`, closing_day: 5, due_day: 12 })
    .select("id")
    .single();
  if (cardError) throw new Error(`card insert failed: ${cardError.message}`);
  created.creditCardId = card.id;

  const { data: category, error: catError } = await admin
    .from("categories")
    .insert({ household_id: householdId, name: `${MARKER} category`, is_active: true })
    .select("id")
    .single();
  if (catError) throw new Error(`category insert failed: ${catError.message}`);
  created.categoryId = category.id;

  const { data: tx, error: txError } = await admin
    .from("transactions")
    .insert({
      household_id: householdId,
      kind: "expense",
      amount_cents: 1234,
      occurred_on: "2026-01-15",
      description: `${MARKER} transaction`,
      category_id: created.categoryId,
      account_id: created.accountId,
      created_by_user_id: created.memberUserId,
    })
    .select("id")
    .single();
  if (txError) throw new Error(`transaction insert failed: ${txError.message}`);
  created.transactionId = tx.id;

  return householdId;
}

async function teardown() {
  // Order matters: transactions reference users (on delete restrict).
  const steps = [
    () => created.transactionId &&
      admin.from("transactions").delete().eq("id", created.transactionId),
    () => admin.from("transactions").delete().like("description", `${MARKER}%`),
    () => admin.from("import_rows").delete().like("description", `${MARKER}%`),
    () => admin.from("import_batches").delete().like("notes", `${MARKER}%`),
    () => admin.from("installments").delete().like("description", `${MARKER}%`),
    () => admin.from("installment_groups").delete().like("description", `${MARKER}%`),
    () => created.categoryId &&
      admin.from("categories").delete().eq("id", created.categoryId),
    () => created.creditCardId &&
      admin.from("credit_cards").delete().eq("id", created.creditCardId),
    () => created.accountId &&
      admin.from("accounts").delete().eq("id", created.accountId),
    () => created.membershipInserted &&
      admin.from("household_members").delete().eq("user_id", created.memberUserId),
  ];
  for (const step of steps) {
    const op = step();
    if (!op) continue;
    const { error } = await op;
    if (error) console.error(`teardown warning: ${error.message}`);
  }
  for (const userId of [created.memberUserId, created.outsiderUserId]) {
    if (!userId) continue;
    const { error } = await admin.auth.admin.deleteUser(userId);
    if (error) console.error(`teardown warning (deleteUser): ${error.message}`);
  }
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

async function signIn(email, password) {
  const client = anonClient();
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`signIn(${email}) failed: ${error.message}`);
  return client;
}

const READ_TABLES = ["transactions", "accounts", "credit_cards", "categories"];

async function checkMemberReads(member) {
  for (const table of READ_TABLES) {
    const { data, error } = await member.from(table).select("id").limit(50);
    const ok = !error && Array.isArray(data) && data.length > 0;
    record(
      `(a) member SELECT ${table} sees household rows`,
      ok,
      error ? error.message : `${data?.length ?? 0} row(s)`,
    );
  }
}

async function checkOutsiderReads(outsider) {
  for (const table of READ_TABLES) {
    const { data, error } = await outsider.from(table).select("id").limit(50);
    const ok = !error && Array.isArray(data) && data.length === 0;
    record(
      `(b) outsider SELECT ${table} sees ZERO rows`,
      ok,
      error ? error.message : `${data?.length ?? 0} row(s)`,
    );
  }
}

async function checkOutsiderInsert(outsider, householdId) {
  const { error } = await outsider.from("transactions").insert({
    household_id: householdId,
    kind: "expense",
    amount_cents: 999,
    occurred_on: "2026-01-15",
    description: `${MARKER} outsider attempt`,
    account_id: created.accountId,
    created_by_user_id: created.outsiderUserId,
  });
  record(
    "(c) outsider INSERT into transactions rejected",
    error !== null && error !== undefined,
    error ? `rejected: ${error.message}` : "insert unexpectedly succeeded",
  );
  if (!error) {
    await admin.from("transactions").delete().like("description", `${MARKER} outsider%`);
  }
}

async function checkMergeCategoryRollback(member, householdId) {
  const bogusTarget = "ffffffff-ffff-ffff-ffff-ffffffffffff";
  const { error } = await member.rpc("merge_category", {
    target_household_id: householdId,
    source_category_id: created.categoryId,
    target_category_id: bogusTarget,
  });
  record(
    "(d1) merge_category bogus target errors",
    Boolean(error),
    error ? error.message : "rpc unexpectedly succeeded",
  );

  const { data: cat } = await admin
    .from("categories")
    .select("is_active")
    .eq("id", created.categoryId)
    .single();
  record(
    "(d1) merge_category rollback: source category still active",
    cat?.is_active === true,
    `is_active=${cat?.is_active}`,
  );

  const { data: tx } = await admin
    .from("transactions")
    .select("category_id")
    .eq("id", created.transactionId)
    .single();
  record(
    "(d1) merge_category rollback: transaction keeps its category",
    tx?.category_id === created.categoryId,
  );
}

async function checkConfirmImportRollback(member, householdId) {
  const txBase = {
    household_id: householdId,
    kind: "expense",
    occurred_on: "2026-01-16",
    account_id: created.accountId,
    created_by_user_id: created.memberUserId,
  };
  const { error } = await member.rpc("confirm_import", {
    batch_payload: {
      household_id: householdId,
      source: "nubank_csv",
      status: "confirmed",
      total_rows: 2,
      imported_rows: 2,
      duplicate_rows: 0,
      error_rows: 0,
      notes: `${MARKER} import`,
      created_by_user_id: created.memberUserId,
    },
    rows_payload: [
      {
        household_id: householdId,
        source_line: 1,
        occurred_on: "2026-01-16",
        amount_cents: 5000,
        description: `${MARKER} import row 1`,
        transaction: {
          ...txBase,
          amount_cents: 5000,
          description: `${MARKER} import row 1`,
        },
      },
      {
        household_id: householdId,
        source_line: 2,
        occurred_on: "2026-01-16",
        amount_cents: -100,
        description: `${MARKER} import row 2`,
        transaction: {
          ...txBase,
          // Violates transactions.amount_cents > 0 → must abort EVERYTHING,
          // including row 1's already-inserted transaction and the batch.
          amount_cents: -100,
          description: `${MARKER} import row 2`,
        },
      },
    ],
  });
  record(
    "(d2) confirm_import with amount<=0 row errors",
    Boolean(error),
    error ? error.message : "rpc unexpectedly succeeded",
  );

  const [{ data: batches }, { data: txs }, { data: importRows }] =
    await Promise.all([
      admin.from("import_batches").select("id").like("notes", `${MARKER}%`),
      admin.from("transactions").select("id").like("description", `${MARKER} import%`),
      admin.from("import_rows").select("id").like("description", `${MARKER} import%`),
    ]);
  record(
    "(d2) confirm_import rollback: no import_batches persisted",
    (batches ?? []).length === 0,
    `${(batches ?? []).length} row(s)`,
  );
  record(
    "(d2) confirm_import rollback: no transactions persisted (incl. valid row 1)",
    (txs ?? []).length === 0,
    `${(txs ?? []).length} row(s)`,
  );
  record(
    "(d2) confirm_import rollback: no import_rows persisted",
    (importRows ?? []).length === 0,
    `${(importRows ?? []).length} row(s)`,
  );
}

async function checkInstallmentRollback(member, householdId) {
  const parcelBase = {
    credit_card_id: created.creditCardId,
    installment_count: 2,
    description: `${MARKER} parcelado`,
    responsibility_scope: "household",
    created_by_user_id: created.memberUserId,
  };
  const { error } = await member.rpc("create_installment_purchase", {
    group_payload: {
      household_id: householdId,
      credit_card_id: created.creditCardId,
      description: `${MARKER} parcelado`,
      total_amount_cents: 20000,
      installment_count: 2,
      purchased_on: "2026-01-10",
      responsibility_scope: "household",
      created_by_user_id: created.memberUserId,
    },
    installments_payload: [
      { ...parcelBase, household_id: householdId, number: 1, amount_cents: 10000, due_month: "2026-02" },
      // Invalid parcel: number > installment_count violates the CHECK → the
      // whole RPC must roll back, leaving no orphan group.
      { ...parcelBase, household_id: householdId, number: 3, amount_cents: 10000, due_month: "2026-03" },
    ],
  });
  record(
    "(d3) create_installment_purchase invalid parcel errors",
    Boolean(error),
    error ? error.message : "rpc unexpectedly succeeded",
  );

  const [{ data: groups }, { data: parcels }] = await Promise.all([
    admin.from("installment_groups").select("id").like("description", `${MARKER}%`),
    admin.from("installments").select("id").like("description", `${MARKER}%`),
  ]);
  record(
    "(d3) create_installment_purchase rollback: no orphan installment_groups",
    (groups ?? []).length === 0,
    `${(groups ?? []).length} row(s)`,
  );
  record(
    "(d3) create_installment_purchase rollback: no installments persisted",
    (parcels ?? []).length === 0,
    `${(parcels ?? []).length} row(s)`,
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log(`RLS proof against ${SUPABASE_URL} (marker: ${MARKER})`);
  let householdId;
  try {
    householdId = await setup();
  } catch (error) {
    console.error(`Setup failed: ${error.message}`);
    await teardown();
    process.exit(2);
  }

  try {
    const member = await signIn(MEMBER_EMAIL, MEMBER_PASSWORD);
    const outsider = await signIn(OUTSIDER_EMAIL, OUTSIDER_PASSWORD);

    await checkMemberReads(member);
    await checkOutsiderReads(outsider);
    await checkOutsiderInsert(outsider, householdId);
    await checkMergeCategoryRollback(member, householdId);
    await checkConfirmImportRollback(member, householdId);
    await checkInstallmentRollback(member, householdId);

    await member.auth.signOut();
    await outsider.auth.signOut();
  } catch (error) {
    console.error(`Unexpected failure while running checks: ${error.message}`);
    record("harness completed all checks", false, error.message);
  } finally {
    await teardown();
  }

  const failed = results.filter((result) => !result.ok);
  console.log(
    `\n${results.length - failed.length}/${results.length} checks passed`,
  );
  process.exit(failed.length === 0 ? 0 : 1);
}

main();
