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
 *   (e) every catalog-discovered household table and public SECURITY DEFINER
 *       function has an isolation case against a separate throwaway household;
 *       unknown tables or functions fail closed by name;
 *   (f) inactive members, unprotected tables, household theme, and composite
 *       foreign keys do not expose or change the other household's data.
 *
 * Config via env (all required):
 *   SUPABASE_URL          e.g. http://localhost:54321 or the VPS HTTPS URL
 *   SUPABASE_ANON_KEY     anon JWT (what browsers use)
 *   SERVICE_ROLE_KEY      service-role JWT — used for test setup, direct
 *                         fixture inspection, and teardown
 *   DATABASE_URL          Postgres connection for catalog discovery
 *   MEMBER_EMAIL / MEMBER_PASSWORD       test member credentials
 *   MEMBER_B_EMAIL / MEMBER_B_PASSWORD   second-household member credentials
 *   OUTSIDER_EMAIL / OUTSIDER_PASSWORD   test outsider credentials
 *
 * Use throwaway emails that are NOT in `allowed_emails` — the script inserts
 * the member's household_members row itself and deletes both users at the end.
 *
 * Run from the repo root after `pnpm install` (resolves @supabase/supabase-js
 * out of packages/db):
 *
 *   SUPABASE_URL=... SUPABASE_ANON_KEY=... SERVICE_ROLE_KEY=... \
 *   DATABASE_URL=... \
 *   MEMBER_EMAIL=rls-proof.member@example.com MEMBER_PASSWORD=... \
 *   MEMBER_B_EMAIL=rls-proof.member-b@example.com MEMBER_B_PASSWORD=... \
 *   OUTSIDER_EMAIL=rls-proof.outsider@example.com OUTSIDER_PASSWORD=... \
 *   node deploy/checks/rls-proof.mjs
 *
 * If a run is killed before teardown, copy the marker printed on its first
 * line and run `node deploy/checks/rls-proof.mjs --cleanup <marker>` with
 * SUPABASE_URL, SERVICE_ROLE_KEY, and DATABASE_URL. Recovery reports removals.
 *
 * Prints PASS/FAIL per check; exits non-zero if ANY check fails.
 */

import { createRequire } from "node:module";
import { createHash, randomUUID } from "node:crypto";

// This file lives outside the pnpm workspaces. Resolve supabase-js through
// packages/db and the root pg development dependency through Node resolution.
const require = createRequire(
  new URL("../../packages/db/package.json", import.meta.url),
);
const { createClient } = require("@supabase/supabase-js");
const { Client } = require("pg");
const cleanupMarker = process.argv[2] === "--cleanup" ? process.argv[3] : null;
if (
  process.argv.length > 2 &&
  (!cleanupMarker || !/^rls-proof-[0-9a-f-]{36}$/.test(cleanupMarker))
) {
  throw new Error("Usage: rls-proof.mjs [--cleanup rls-proof-<uuid>]");
}

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
const SUPABASE_ANON_KEY = cleanupMarker
  ? null
  : requiredEnv("SUPABASE_ANON_KEY");
const SERVICE_ROLE_KEY = requiredEnv("SERVICE_ROLE_KEY");
const DATABASE_URL = requiredEnv("DATABASE_URL");
const MEMBER_EMAIL = cleanupMarker ? null : requiredEnv("MEMBER_EMAIL");
const MEMBER_PASSWORD = cleanupMarker ? null : requiredEnv("MEMBER_PASSWORD");
const MEMBER_B_EMAIL = cleanupMarker ? null : requiredEnv("MEMBER_B_EMAIL");
const MEMBER_B_PASSWORD = cleanupMarker
  ? null
  : requiredEnv("MEMBER_B_PASSWORD");
const OUTSIDER_EMAIL = cleanupMarker ? null : requiredEnv("OUTSIDER_EMAIL");
const OUTSIDER_PASSWORD = cleanupMarker
  ? null
  : requiredEnv("OUTSIDER_PASSWORD");

// Unique marker so fixtures never collide with real data and teardown is safe.
const MARKER = cleanupMarker ?? `rls-proof-${randomUUID()}`;

function fixtureId(table, index = 0) {
  const hex = createHash("sha256")
    .update(`${MARKER}:${table}:${index}`)
    .digest("hex")
    .slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20)}`;
}

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
  memberBUserId: null,
  inactiveUserId: null,
  outsiderUserId: null,
  householdBId: null,
  householdAId: null,
  fixtureRows: [],
  extraUserIds: [],
  bRows: {},
  accountId: null,
  creditCardId: null,
  categoryId: null,
  transactionId: null,
  membershipInserted: false,
};
const fixtureCounts = new Map();

const database = new Client({ connectionString: DATABASE_URL });

const TABLE_FIXTURES = {
  household_members: true,
  accounts: true,
  investment_buckets: true,
  credit_cards: true,
  card_bill_closures: true,
  categories: true,
  subcategories: true,
  installment_groups: true,
  installments: true,
  transactions: true,
  import_batches: true,
  import_rows: true,
  categorization_memory: true,
  bot_interactions: true,
  obligations: true,
  source_category_mappings: true,
  import_item_claims: true,
  import_ai_usage: true,
  import_ai_daily_usage: true,
  import_transaction_replacements: true,
  allowed_emails: true,
  bot_conversations: true,
};

const RPC_CASES = new Set([
  "claim_import_suggestion_nonce(text,timestamp with time zone)",
  "confirm_import(jsonb,jsonb)",
  "confirm_import_v2(jsonb,jsonb)",
  "confirm_import_with_replacements(jsonb,jsonb)",
  "create_installment_purchase(jsonb,jsonb)",
  "is_household_member(uuid)",
  "card_bill_is_closed(uuid,text)",
  "reconcile_legacy_card_bill_payment(uuid,uuid,uuid,text,bigint,date,uuid)",
  "materialize_obligation_payment(uuid,text,date)",
  "materialize_obligation_payment(uuid,text,date,bigint)",
  "materialize_obligation_payment(uuid,text,date,bigint,uuid)",
  "merge_category(uuid,uuid,uuid)",
  "record_import_ai_paid_result(uuid,uuid,text,text,text,integer,integer)",
  "reserve_import_ai_paid_items(uuid,uuid,uuid,integer,integer,uuid)",
  "resolve_telegram_member(bigint)",
  "create_telegram_link_code()",
  "redeem_telegram_link_code(text,bigint)",
  "discard_telegram_link_code(text)",
  "unlink_telegram()",
  "settle_card_bill(uuid,uuid,uuid,text,bigint,date,uuid,text)",
  "update_installment_group_category(uuid,uuid,jsonb)",
]);
const TRIGGER_CASES = new Set([
  "provision_household_member()",
  "provision_on_allowlist()",
]);

async function catalog() {
  const tables = await database.query(`
    select c.relname as name
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
    join pg_attribute a on a.attrelid = c.oid and a.attname = 'household_id'
      and not a.attisdropped
    where n.nspname = 'public' and c.relkind in ('r', 'p')
    order by c.relname
  `);
  const foreignKeys = await database.query(`
    select n.nspname as schema, c.relname as name, a.attname as column
    from pg_constraint fk
    join pg_class c on c.oid = fk.conrelid
    join pg_namespace n on n.oid = c.relnamespace
    join lateral unnest(fk.conkey, fk.confkey) as pair(source_att, target_att) on true
    join pg_attribute a on a.attrelid = c.oid and a.attnum = pair.source_att
    join pg_attribute target on target.attrelid = fk.confrelid and target.attnum = pair.target_att
    where fk.contype = 'f' and fk.confrelid = 'public.households'::regclass
      and target.attname = 'id' and n.nspname = 'public'
    order by n.nspname, c.relname, a.attname
  `);
  const views = await database.query(`
    select c.relname as name from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('v', 'm')
    order by c.relname
  `);
  const functions = await database.query(`
    select p.proname as name,
      p.prorettype = 'trigger'::regtype as trigger,
      p.proname || '(' || coalesce((
        select string_agg(format_type(p.proargtypes[i], null), ',' order by i)
        from generate_series(0, p.pronargs - 1) as i
      ), '') || ')' as signature
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prosecdef
    order by signature
  `);
  return {
    tables: tables.rows.map((row) => row.name),
    foreignKeys: foreignKeys.rows,
    views: views.rows.map((row) => row.name),
    functions: functions.rows,
  };
}

async function fixture(table, values, key = "id") {
  const index = fixtureCounts.get(table) ?? 0;
  fixtureCounts.set(table, index + 1);
  const payload =
    key === "id" ? { id: fixtureId(table, index), ...values } : values;
  const { data, error } = await admin
    .from(table)
    .insert(payload)
    .select("*")
    .single();
  if (error) throw new Error(`${table} fixture failed: ${error.message}`);
  const keys = Array.isArray(key) ? key : [key];
  created.fixtureRows.push({
    table,
    keys: Object.fromEntries(keys.map((name) => [name, data[name]])),
  });
  created.bRows[table] = data;
  return data;
}

async function createUser(email, password, role = "fixture") {
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { rls_proof_marker: MARKER, rls_proof_role: role },
  });
  if (error) throw new Error(`createUser(${email}) failed: ${error.message}`);
  return data.user.id;
}

async function setup() {
  // Use an existing household as A; the proof creates B independently.
  const { data: household, error: hhError } = await admin
    .from("households")
    .select("id")
    .order("id")
    .limit(1)
    .single();
  if (hhError) throw new Error(`household lookup failed: ${hhError.message}`);
  const householdId = household.id;
  created.householdAId = householdId;

  created.memberUserId = await createUser(
    MEMBER_EMAIL,
    MEMBER_PASSWORD,
    "memberA",
  );
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
    .insert({
      household_id: householdId,
      kind: "checking",
      name: `${MARKER} account`,
    })
    .select("id")
    .single();
  if (accError) throw new Error(`account insert failed: ${accError.message}`);
  created.accountId = account.id;

  const { data: card, error: cardError } = await admin
    .from("credit_cards")
    .insert({
      household_id: householdId,
      name: `${MARKER} card`,
      closing_day: 5,
      due_day: 12,
    })
    .select("id")
    .single();
  if (cardError) throw new Error(`card insert failed: ${cardError.message}`);
  created.creditCardId = card.id;

  const { data: category, error: catError } = await admin
    .from("categories")
    .insert({
      household_id: householdId,
      name: `${MARKER} category`,
      is_active: true,
    })
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

async function setupHouseholdB() {
  const household = await fixture("households", {
    name: `${MARKER} household B`,
    theme: { base: "salvia", overrides: { "--ff-accent": "#123456" } },
  });
  const householdId = household.id;
  created.householdBId = householdId;
  created.memberBUserId = await createUser(MEMBER_B_EMAIL, MEMBER_B_PASSWORD);
  created.inactiveUserId = await createUser(
    `${MARKER}@example.test`,
    MEMBER_B_PASSWORD,
  );
  const member = await fixture("household_members", {
    household_id: householdId,
    user_id: created.memberBUserId,
    role: "member",
    is_active: true,
    telegram_user_id: Number(`9${Date.now()}`),
  });
  created.bTelegramId = member.telegram_user_id;
  await fixture("household_members", {
    household_id: householdId,
    user_id: created.inactiveUserId,
    role: "member",
    is_active: false,
  });
  const account = await fixture("accounts", {
    household_id: householdId,
    kind: "checking",
    name: `${MARKER} B account`,
  });
  await fixture("investment_buckets", {
    household_id: householdId,
    slug: `proof_${randomUUID().replaceAll("-", "")}`,
    name: `${MARKER} B bucket`,
  });
  const card = await fixture("credit_cards", {
    household_id: householdId,
    name: `${MARKER} B card`,
    closing_day: 5,
    due_day: 12,
  });
  await fixture("card_bill_closures", {
    household_id: householdId,
    credit_card_id: card.id,
    bill_month: "2026-01",
    state: "closed",
    total_override_cents: 100,
    updated_by_user_id: created.memberBUserId,
  });
  const category = await fixture("categories", {
    household_id: householdId,
    name: `${MARKER} B category`,
    kind: "expense",
  });
  const subcategory = await fixture("subcategories", {
    household_id: householdId,
    category_id: category.id,
    name: `${MARKER} B subcategory`,
  });
  const batch = await fixture("import_batches", {
    household_id: householdId,
    source: "nubank_csv",
    status: "confirmed",
    total_rows: 1,
    imported_rows: 1,
    duplicate_rows: 0,
    error_rows: 0,
    notes: MARKER,
    created_by_user_id: created.memberBUserId,
  });
  const group = await fixture("installment_groups", {
    household_id: householdId,
    credit_card_id: card.id,
    description: `${MARKER} B group`,
    total_amount_cents: 100,
    installment_count: 1,
    purchased_on: "2026-01-01",
    category_id: category.id,
    subcategory_id: subcategory.id,
    responsibility_scope: "household",
    created_by_user_id: created.memberBUserId,
  });
  await fixture("installments", {
    household_id: householdId,
    installment_group_id: group.id,
    credit_card_id: card.id,
    number: 1,
    installment_count: 1,
    amount_cents: 100,
    due_month: "2026-02",
    description: `${MARKER} B installment`,
    category_id: category.id,
    subcategory_id: subcategory.id,
    responsibility_scope: "household",
    created_by_user_id: created.memberBUserId,
  });
  const transaction = await fixture("transactions", {
    household_id: householdId,
    kind: "expense",
    amount_cents: 100,
    occurred_on: "2026-01-01",
    description: `${MARKER} B transaction`,
    category_id: category.id,
    subcategory_id: subcategory.id,
    account_id: account.id,
    created_by_user_id: created.memberBUserId,
  });
  await fixture("import_rows", {
    household_id: householdId,
    import_batch_id: batch.id,
    source_line: 1,
    occurred_on: "2026-01-01",
    amount_cents: 100,
    description: `${MARKER} B import row`,
    transaction_id: transaction.id,
  });
  await fixture("import_item_claims", {
    household_id: householdId,
    source: "nubank_csv",
    fingerprint_version: 1,
    base_fingerprint: "a".repeat(64),
    occurrence_no: 1,
    artifact_kind: "transaction",
    import_batch_id: batch.id,
    transaction_id: transaction.id,
  });
  await fixture(
    "import_transaction_replacements",
    {
      original_transaction_id: fixtureId("import_transaction_replacements"),
      household_id: householdId,
      import_batch_id: batch.id,
      installment_group_id: group.id,
      original_record: { description: MARKER },
      replaced_by: created.memberBUserId,
    },
    "original_transaction_id",
  );
  await fixture("categorization_memory", {
    household_id: householdId,
    pattern: `${MARKER} B pattern`,
    category_id: category.id,
    confidence: 1,
    explanation: MARKER,
    row_kind: "expense",
  });
  await fixture("bot_interactions", {
    household_id: householdId,
    channel: "telegram",
    input_kind: "text",
    message_text: MARKER,
    user_id: created.memberBUserId,
    transaction_id: transaction.id,
  });
  await fixture("obligations", {
    household_id: householdId,
    description: `${MARKER} B obligation`,
    amount_cents: 100,
    start_month: "2026-01",
    term_months: 2,
    due_day: 5,
    account_id: account.id,
    created_by_user_id: created.memberBUserId,
  });
  await fixture("source_category_mappings", {
    household_id: householdId,
    source: "nubank_csv",
    normalized_label: `${MARKER} B label`,
    row_kind: "expense",
    category_id: category.id,
    created_by_user_id: created.memberBUserId,
  });
  await fixture("import_ai_usage", {
    household_id: householdId,
    budget_key: randomUUID(),
    request_key: randomUUID(),
    paid_items_reserved: 1,
    created_by_user_id: created.memberBUserId,
  });
  await fixture(
    "import_ai_daily_usage",
    {
      household_id: householdId,
      usage_date: "2026-01-01",
      paid_items_reserved: 1,
    },
    ["household_id", "usage_date"],
  );
  await fixture(
    "allowed_emails",
    {
      household_id: householdId,
      email: `${MARKER}-allowed@example.test`,
    },
    "email",
  );
  await fixture(
    "bot_conversations",
    {
      household_id: householdId,
      chat_id: Number(`8${Date.now()}`),
      telegram_user_id: created.bTelegramId,
      state: { marker: MARKER },
    },
    ["chat_id", "telegram_user_id"],
  );
  await fixture(
    "import_suggestion_nonces",
    {
      nonce: `${MARKER}-nonce`,
      expires_at: "2030-01-01T00:00:00Z",
    },
    "nonce",
  );
  return householdId;
}

async function teardown() {
  // Reverse fixture order removes only rows inserted by this run.
  for (const { table, keys } of created.fixtureRows.reverse()) {
    let query = admin.from(table).delete();
    for (const [key, value] of Object.entries(keys))
      query = query.eq(key, value);
    const { error } = await query;
    if (error) record(`cleanup ${table}`, false, error.message);
  }
  created.fixtureRows = [];
  const { error: markedEmailError } = await admin
    .from("allowed_emails")
    .delete()
    .like("email", `${MARKER}%`);
  if (markedEmailError)
    record("cleanup marked email", false, markedEmailError.message);

  // A's RPC checks can generate rows. Match the run marker or a fixture ID.
  const steps = [
    () =>
      created.transactionId &&
      admin.from("transactions").delete().eq("id", created.transactionId),
    () =>
      created.memberUserId &&
      admin
        .from("transactions")
        .delete()
        .eq("created_by_user_id", created.memberUserId)
        .like("description", `${MARKER}%`),
    () =>
      created.creditCardId &&
      admin
        .from("transactions")
        .delete()
        .eq("credit_card_id", created.creditCardId),
    () =>
      created.memberUserId &&
      admin
        .from("import_rows")
        .delete()
        .like("description", `${MARKER}%`)
        .eq("household_id", created.householdAId),
    () =>
      created.memberUserId &&
      admin
        .from("import_batches")
        .delete()
        .eq("created_by_user_id", created.memberUserId)
        .eq("notes", MARKER),
    () =>
      created.memberUserId &&
      admin
        .from("installments")
        .delete()
        .eq("created_by_user_id", created.memberUserId)
        .like("description", `${MARKER}%`),
    () =>
      admin
        .from("installment_groups")
        .delete()
        .eq("created_by_user_id", created.memberUserId)
        .like("description", `${MARKER}%`),
    () =>
      created.memberUserId &&
      admin
        .from("obligations")
        .delete()
        .eq("created_by_user_id", created.memberUserId)
        .like("description", `${MARKER}%`),
    () =>
      created.categoryId &&
      admin.from("categories").delete().eq("id", created.categoryId),
    () =>
      created.creditCardId &&
      admin.from("credit_cards").delete().eq("id", created.creditCardId),
    () =>
      created.accountId &&
      admin.from("accounts").delete().eq("id", created.accountId),
    () =>
      created.membershipInserted &&
      admin
        .from("household_members")
        .delete()
        .eq("user_id", created.memberUserId),
  ];
  for (const step of steps) {
    const op = step();
    if (!op) continue;
    const { error } = await op;
    if (error) record("cleanup A fixture", false, error.message);
  }
  for (const userId of [
    created.memberUserId,
    created.memberBUserId,
    created.inactiveUserId,
    created.outsiderUserId,
    ...created.extraUserIds,
  ]) {
    if (!userId) continue;
    const { error } = await admin.auth.admin.deleteUser(userId);
    if (error) record("cleanup auth user", false, error.message);
  }
}

const RECOVERY_B_TABLES = [
  "bot_conversations",
  "allowed_emails",
  "import_ai_daily_usage",
  "import_ai_usage",
  "source_category_mappings",
  "obligations",
  "bot_interactions",
  "categorization_memory",
  "import_transaction_replacements",
  "import_item_claims",
  "import_rows",
  "transactions",
  "installments",
  "installment_groups",
  "import_batches",
  "subcategories",
  "categories",
  "credit_cards",
  "investment_buckets",
  "accounts",
  "household_members",
];

async function recover(marker) {
  await database.connect();
  try {
    const household = await database.query(
      "select id from public.households where name = $1",
      [`${marker} household B`],
    );
    const householdId = household.rows[0]?.id ?? null;
    const users = await database.query(
      "select id, raw_user_meta_data ->> 'rls_proof_role' as role from auth.users where raw_user_meta_data ->> 'rls_proof_marker' = $1 or email = $2",
      [marker, `${marker}-signup@example.test`],
    );
    const userIds = users.rows.map((row) => row.id);
    const aUser = users.rows.find((row) => row.role === "memberA");
    const aUserId = aUser?.id ?? null;
    const aCard = await database.query(
      "select id from public.credit_cards where name = $1",
      [`${marker} card`],
    );
    const cardId = aCard.rows[0]?.id ?? null;
    const removed = [];
    async function del(table, predicate, values) {
      const result = await database.query(
        `delete from public.${table} where ${predicate}`,
        values,
      );
      if (result.rowCount) removed.push(`${table}: ${result.rowCount}`);
    }
    await del("import_suggestion_nonces", "nonce = $1", [`${marker}-nonce`]);
    if (aUserId) {
      await del(
        "import_item_claims",
        "import_batch_id in (select id from public.import_batches where created_by_user_id = $1 and notes = $2)",
        [aUserId, marker],
      );
      await del(
        "import_rows",
        "import_batch_id in (select id from public.import_batches where created_by_user_id = $1 and notes = $2)",
        [aUserId, marker],
      );
      await del(
        "transactions",
        "created_by_user_id = $1 and description like $2",
        [aUserId, `${marker}%`],
      );
      await del(
        "installments",
        "created_by_user_id = $1 and description like $2",
        [aUserId, `${marker}%`],
      );
      await del(
        "installment_groups",
        "created_by_user_id = $1 and description like $2",
        [aUserId, `${marker}%`],
      );
      await del("import_batches", "created_by_user_id = $1 and notes = $2", [
        aUserId,
        marker,
      ]);
      await del(
        "obligations",
        "created_by_user_id = $1 and description like $2",
        [aUserId, `${marker}%`],
      );
    }
    if (cardId) await del("transactions", "credit_card_id = $1", [cardId]);
    await del("categories", "name = $1", [`${marker} category`]);
    await del("credit_cards", "name = $1", [`${marker} card`]);
    await del("accounts", "name = $1", [`${marker} account`]);
    if (householdId) {
      for (const table of RECOVERY_B_TABLES) {
        if (table === "allowed_emails") {
          await del(table, "household_id = $1 and email like $2", [
            householdId,
            `${marker}%`,
          ]);
        } else if (table === "import_ai_daily_usage") {
          await del(
            table,
            "household_id = $1 and usage_date = date '2026-01-01'",
            [householdId],
          );
        } else if (table === "import_transaction_replacements") {
          await del(
            table,
            "household_id = $1 and original_transaction_id = $2",
            [householdId, fixtureId(table)],
          );
        } else if (table === "bot_conversations") {
          await del(table, "household_id = $1 and state ->> 'marker' = $2", [
            householdId,
            marker,
          ]);
        } else if (table === "household_members") {
          await del(table, "household_id = $1 and id = any($2::uuid[])", [
            householdId,
            [fixtureId(table), fixtureId(table, 1)],
          ]);
        } else {
          await del(table, "household_id = $1 and id = $2", [
            householdId,
            fixtureId(table),
          ]);
        }
      }
      await del("households", "id = $1 and name = $2", [
        householdId,
        `${marker} household B`,
      ]);
    }
    if (userIds.length) {
      await del("household_members", "user_id = any($1::uuid[])", [userIds]);
    }
    for (const userId of userIds) {
      const { error } = await admin.auth.admin.deleteUser(userId);
      if (error) throw new Error(`auth user cleanup: ${error.message}`);
    }
    if (userIds.length) removed.push(`auth users: ${userIds.length}`);
    console.log(`Cleanup ${marker}: ${removed.join(", ") || "nothing found"}`);
  } finally {
    await database.end();
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
    await admin
      .from("transactions")
      .delete()
      .like("description", `${MARKER} outsider%`);
  }
}

async function checkCatalogCoverage({ tables, foreignKeys, views, functions }) {
  let complete = true;
  for (const table of tables) {
    const hasFixture = Boolean(TABLE_FIXTURES[table] && created.bRows[table]);
    record(
      `fixture coverage ${table}`,
      hasFixture,
      TABLE_FIXTURES[table] ? "fixture present" : `missing fixture: ${table}`,
    );
    complete &&= hasFixture;
  }
  for (const { schema, name, column } of foreignKeys) {
    const hasCase = column === "household_id" && Boolean(TABLE_FIXTURES[name]);
    record(`household FK coverage ${schema}.${name}.${column}`, hasCase);
    complete &&= hasCase;
  }
  for (const name of views) {
    record(`view coverage public.${name}`, false, `missing case: ${name}`);
    complete = false;
  }
  for (const { name, signature, trigger } of functions) {
    const hasCase = (trigger ? TRIGGER_CASES : RPC_CASES).has(signature);
    record(
      `${trigger ? "trigger" : "RPC"} case coverage ${signature}`,
      hasCase,
      hasCase ? "case present" : `missing case: ${name}`,
    );
    complete &&= hasCase;
  }
  return complete;
}

async function checkApiSchemas(member) {
  const session = await member.auth.getSession();
  const token = session.data.session?.access_token;
  if (!token) throw new Error("member session has no access token");
  for (const schema of ["auth", "family_finance_migrations"]) {
    const response = await fetch(
      `${SUPABASE_URL}/rest/v1/households?select=id`,
      {
        headers: {
          apikey: SUPABASE_ANON_KEY,
          Authorization: `Bearer ${token}`,
          "Accept-Profile": schema,
        },
      },
    );
    record(`PostgREST rejects ${schema} schema`, !response.ok);
  }
}

async function snapshotB(tables) {
  const rows = {};
  for (const table of tables) {
    const result = await database.query(
      `select coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text), '[]'::jsonb)::text as value
       from public."${table}" t where household_id = $1`,
      [created.householdBId],
    );
    rows[table] = result.rows[0].value;
  }
  const household = await database.query(
    "select to_jsonb(h)::text as value from public.households h where id = $1",
    [created.householdBId],
  );
  rows.households = household.rows[0]?.value;
  const nonce = await database.query(
    "select to_jsonb(n)::text as value from public.import_suggestion_nonces n where nonce = $1",
    [`${MARKER}-nonce`],
  );
  rows.import_suggestion_nonces = nonce.rows[0]?.value;
  return rows;
}

function deniedWrite(result) {
  return (
    Boolean(result.error) &&
    /row-level security|permission denied|42501/i.test(result.error.message)
  );
}

const UPDATE_COLUMNS = {
  household_members: "is_active",
  accounts: "name",
  investment_buckets: "name",
  credit_cards: "name",
  card_bill_closures: "total_override_cents",
  categories: "name",
  subcategories: "name",
  installment_groups: "description",
  installments: "description",
  transactions: "description",
  import_batches: "notes",
  import_rows: "description",
  categorization_memory: "explanation",
  bot_interactions: "message_text",
  obligations: "description",
  source_category_mappings: "normalized_label",
  import_item_claims: "occurrence_no",
  import_ai_usage: "paid_items_reserved",
  import_ai_daily_usage: "paid_items_reserved",
  import_transaction_replacements: "original_record",
  allowed_emails: "email",
  bot_conversations: "state",
  import_suggestion_nonces: "expires_at",
};

function sentinelFor(value) {
  if (typeof value === "boolean") return !value;
  if (typeof value === "number") return value + 1;
  if (typeof value === "object") return { proof_sentinel: MARKER };
  return `${MARKER} sentinel`;
}

async function fixtureValue(table, column) {
  const fixture = [...created.fixtureRows]
    .reverse()
    .find((row) => row.table === table);
  if (!fixture) throw new Error(`missing tracked fixture for ${table}`);
  let query = admin.from(table).select(column);
  for (const [key, value] of Object.entries(fixture.keys))
    query = query.eq(key, value);
  const { data, error } = await query.single();
  if (error) throw new Error(`privileged read ${table}: ${error.message}`);
  return data[column];
}

function fixtureFilter(query, table) {
  const fixture = [...created.fixtureRows]
    .reverse()
    .find((row) => row.table === table);
  if (!fixture) throw new Error(`missing tracked fixture for ${table}`);
  for (const [key, value] of Object.entries(fixture.keys))
    query = query.eq(key, value);
  return query;
}

async function checkCrossHouseholdTables(member, inactive, tables) {
  const before = await snapshotB(tables);
  for (const table of tables) {
    const column = UPDATE_COLUMNS[table];
    if (!column) throw new Error(`missing update sentinel for ${table}`);
    const original = await fixtureValue(table, column);
    for (const [label, client] of [
      ["member A", member],
      ["inactive member", inactive],
    ]) {
      const read = await client
        .from(table)
        .select("*")
        .eq("household_id", created.householdBId);
      record(
        `${label} SELECT B ${table} zero rows`,
        !read.error && read.data?.length === 0,
        read.error?.message ?? `${read.data?.length ?? 0} row(s)`,
      );
      const insert = await client
        .from(table)
        .insert({ household_id: created.householdBId });
      record(
        `${label} INSERT B ${table} denied`,
        deniedWrite(insert),
        insert.error?.message ?? "insert unexpectedly succeeded",
      );
      const update = await fixtureFilter(
        client.from(table).update({ [column]: sentinelFor(original) }),
        table,
      ).select("*");
      record(
        `${label} UPDATE B ${table} zero rows`,
        (deniedWrite(update) || (!update.error && update.data?.length === 0)) &&
          JSON.stringify(await fixtureValue(table, column)) ===
            JSON.stringify(original),
        update.error?.message ?? `${update.data?.length ?? 0} row(s)`,
      );
      const deletion = await fixtureFilter(
        client.from(table).delete(),
        table,
      ).select("*");
      record(
        `${label} DELETE B ${table} zero rows`,
        (deniedWrite(deletion) ||
          (!deletion.error && deletion.data?.length === 0)) &&
          JSON.stringify(await fixtureValue(table, column)) ===
            JSON.stringify(original),
        deletion.error?.message ?? `${deletion.data?.length ?? 0} row(s)`,
      );
    }
    const after = await snapshotB([table]);
    record(`B ${table} unchanged`, after[table] === before[table]);
  }
}

async function checkMemberBReads(memberB, tables) {
  for (const table of tables) {
    if (["allowed_emails", "bot_conversations"].includes(table)) continue;
    const result = await memberB
      .from(table)
      .select("*")
      .eq("household_id", created.householdBId);
    record(
      `active member B SELECT ${table} sees B fixture`,
      !result.error && result.data?.length > 0,
      result.error?.message ?? `${result.data?.length ?? 0} row(s)`,
    );
  }
  const household = await memberB
    .from("households")
    .select("id,theme")
    .eq("id", created.householdBId)
    .single();
  record(
    "active member B sees own theme",
    !household.error &&
      household.data?.theme?.overrides?.["--ff-accent"] === "#123456",
    household.error?.message ?? "theme read",
  );
}

async function checkHouseholdVisibility(member) {
  const households = await member.from("households").select("id,theme");
  record(
    "households theme B invisible to A",
    !households.error &&
      households.data?.length === 1 &&
      households.data[0].id === created.householdAId,
    households.error?.message ?? `${households.data?.length ?? 0} row(s)`,
  );
  const members = await member
    .from("household_members")
    .select("household_id,user_id");
  record(
    "household_members only A household visible",
    !members.error &&
      members.data?.some((row) => row.user_id === created.memberUserId) &&
      members.data.every((row) => row.household_id === created.householdAId),
    members.error?.message ?? `${members.data?.length ?? 0} row(s)`,
  );
  const update = await member
    .from("households")
    .update({ theme: { base: "esmeralda" } })
    .eq("id", created.householdBId)
    .select("id");
  record(
    "households theme B cannot be updated by A",
    deniedWrite(update) || (!update.error && update.data?.length === 0),
    update.error?.message ?? `${update.data?.length ?? 0} row(s)`,
  );
}

async function checkInactiveHouseholdVisibility(inactive) {
  const households = await inactive.from("households").select("id,theme");
  record(
    "inactive member cannot read households theme B",
    !households.error && households.data?.length === 0,
    households.error?.message ?? `${households.data?.length ?? 0} row(s)`,
  );
  const update = await inactive
    .from("households")
    .update({ theme: { base: "esmeralda" } })
    .eq("id", created.householdBId)
    .select("id");
  record(
    "inactive member cannot update households theme B",
    deniedWrite(update) || (!update.error && update.data?.length === 0),
    update.error?.message ?? `${update.data?.length ?? 0} row(s)`,
  );
}

async function checkNoPolicyTables(member, outsider) {
  for (const table of [
    "bot_conversations",
    "allowed_emails",
    "import_suggestion_nonces",
  ]) {
    const column = UPDATE_COLUMNS[table];
    const original = await fixtureValue(table, column);
    for (const [label, client] of [
      ["A", member],
      ["outsider", outsider],
    ]) {
      const read = await client.from(table).select("*");
      record(
        `no-policy ${table} ${label} reads zero`,
        deniedWrite(read) || (!read.error && read.data?.length === 0),
        read.error?.message ?? `${read.data?.length ?? 0} row(s)`,
      );
      const payload =
        table === "import_suggestion_nonces"
          ? {
              nonce: `${MARKER}-${label}-attempt`,
              expires_at: "2030-01-01T00:00:00Z",
            }
          : table === "allowed_emails"
            ? {
                household_id: created.householdBId,
                email: `${MARKER}-${label}-attempt@example.test`,
              }
            : {
                household_id: created.householdBId,
                chat_id: Number(`7${Date.now()}`),
                telegram_user_id: created.bTelegramId,
                state: {},
              };
      const write = await client.from(table).insert(payload);
      record(
        `no-policy ${table} ${label} cannot write`,
        deniedWrite(write),
        write.error?.message ?? "insert unexpectedly succeeded",
      );
      const key =
        table === "import_suggestion_nonces"
          ? "nonce"
          : table === "allowed_emails"
            ? "email"
            : "chat_id";
      const value =
        table === "import_suggestion_nonces"
          ? `${MARKER}-nonce`
          : table === "allowed_emails"
            ? created.bRows.allowed_emails.email
            : created.bRows.bot_conversations.chat_id;
      const update = await client
        .from(table)
        .update({ [column]: sentinelFor(original) })
        .eq(key, value)
        .select("*");
      record(
        `no-policy ${table} ${label} cannot update`,
        (deniedWrite(update) || (!update.error && update.data?.length === 0)) &&
          JSON.stringify(await fixtureValue(table, column)) ===
            JSON.stringify(original),
        update.error?.message ?? `${update.data?.length ?? 0} row(s)`,
      );
      const deletion = await client
        .from(table)
        .delete()
        .eq(key, value)
        .select("*");
      record(
        `no-policy ${table} ${label} cannot delete`,
        (deniedWrite(deletion) ||
          (!deletion.error && deletion.data?.length === 0)) &&
          JSON.stringify(await fixtureValue(table, column)) ===
            JSON.stringify(original),
        deletion.error?.message ?? `${deletion.data?.length ?? 0} row(s)`,
      );
      if (!write.error) {
        await admin.from(table).delete().eq(key, payload[key]);
      }
    }
  }
}

async function checkCompositeForeignKeys(member) {
  const b = created.bRows;
  const base = {
    household_id: created.householdAId,
    kind: "expense",
    amount_cents: 100,
    occurred_on: "2026-01-01",
    description: `${MARKER} composite FK attempt`,
    created_by_user_id: created.memberUserId,
  };
  const cases = {
    category: { account_id: created.accountId, category_id: b.categories.id },
    account: { account_id: b.accounts.id },
    card: { credit_card_id: b.credit_cards.id },
    subcategory: {
      account_id: created.accountId,
      category_id: created.categoryId,
      subcategory_id: b.subcategories.id,
    },
  };
  for (const [name, refs] of Object.entries(cases)) {
    const result = await member
      .from("transactions")
      .insert({ ...base, ...refs });
    record(
      `composite FK ${name} rejects B reference`,
      Boolean(result.error) && /foreign key|23503/i.test(result.error.message),
      result.error?.message ?? "insert unexpectedly succeeded",
    );
  }
}

function rpcArguments(signature) {
  const b = created.bRows;
  const householdId = created.householdBId;
  const importBatch = {
    household_id: householdId,
    source: "nubank_csv",
    status: "confirmed",
    total_rows: 0,
    imported_rows: 0,
    duplicate_rows: 0,
    error_rows: 0,
    notes: MARKER,
    created_by_user_id: created.memberUserId,
  };
  const payment = {
    target_obligation_id: b.obligations.id,
    target_month: "2026-02",
    paid_on: null,
  };
  const cases = {
    "claim_import_suggestion_nonce(text,timestamp with time zone)": {
      target_nonce: `${MARKER}-nonce`,
      target_expires_at: "2030-01-01T00:00:00Z",
    },
    "confirm_import(jsonb,jsonb)": {
      batch_payload: importBatch,
      rows_payload: [],
    },
    "confirm_import_v2(jsonb,jsonb)": {
      batch_payload: importBatch,
      items_payload: [],
    },
    "confirm_import_with_replacements(jsonb,jsonb)": {
      batch_payload: importBatch,
      items_payload: [],
    },
    "create_installment_purchase(jsonb,jsonb)": {
      group_payload: {
        household_id: householdId,
        credit_card_id: b.credit_cards.id,
        description: MARKER,
        total_amount_cents: 100,
        installment_count: 1,
        purchased_on: "2026-01-01",
        created_by_user_id: created.memberUserId,
      },
      installments_payload: [],
    },
    "is_household_member(uuid)": { target_household_id: householdId },
    "materialize_obligation_payment(uuid,text,date)": payment,
    "materialize_obligation_payment(uuid,text,date,bigint)": {
      ...payment,
      target_amount_cents: 100,
    },
    "materialize_obligation_payment(uuid,text,date,bigint,uuid)": {
      ...payment,
      target_amount_cents: 100,
      target_account_id: b.accounts.id,
    },
    "merge_category(uuid,uuid,uuid)": {
      target_household_id: householdId,
      source_category_id: b.categories.id,
      target_category_id: b.categories.id,
    },
    "record_import_ai_paid_result(uuid,uuid,text,text,text,integer,integer)": {
      target_household_id: householdId,
      target_attempt_key: b.import_ai_usage.request_key,
      target_provider: "openai",
      target_model: "proof",
      target_outcome: "success",
      target_resolved_items: 1,
      target_latency_ms: 1,
    },
    "reserve_import_ai_paid_items(uuid,uuid,uuid,integer,integer,uuid)": {
      target_household_id: householdId,
      target_budget_key: randomUUID(),
      target_attempt_key: randomUUID(),
      requested_items: 1,
      preview_max_items: 1,
      target_created_by_user_id: created.memberUserId,
    },
    "resolve_telegram_member(bigint)": {
      p_telegram_user_id: created.bTelegramId,
    },
    "create_telegram_link_code()": {},
    "redeem_telegram_link_code(text,bigint)": {
      p_code: "INVALID32",
      p_telegram_user_id: created.bTelegramId,
    },
    "discard_telegram_link_code(text)": { p_code: "INVALID32" },
    "unlink_telegram()": {},
    "settle_card_bill(uuid,uuid,uuid,text,bigint,date,uuid,text)": {
      target_household_id: householdId,
      target_credit_card_id: b.credit_cards.id,
      target_account_id: b.accounts.id,
      target_bill_month: "2026-03",
      target_amount_cents: 100,
      target_paid_on: "2026-03-01",
      target_created_by_user_id: created.memberUserId,
      target_idempotency_key: randomUUID(),
    },
    "card_bill_is_closed(uuid,text)": {
      target_credit_card_id: b.credit_cards.id,
      target_month: "2026-01",
    },
    "reconcile_legacy_card_bill_payment(uuid,uuid,uuid,text,bigint,date,uuid)":
      {
        target_household_id: householdId,
        target_credit_card_id: b.credit_cards.id,
        target_account_id: b.accounts.id,
        target_bill_month: "2026-01",
        target_amount_cents: 100,
        target_paid_on: "2026-01-01",
        target_created_by_user_id: created.memberUserId,
      },
    "update_installment_group_category(uuid,uuid,jsonb)": {
      target_household_id: householdId,
      target_group_id: b.installment_groups.id,
      category_patch: {
        category_id: b.categories.id,
        subcategory_id: b.subcategories.id,
      },
    },
  };
  return cases[signature];
}

async function checkDefinerFunctions(member, functions, tables) {
  const forbidden = new Set([created.householdBId]);
  for (const row of Object.values(created.bRows)) {
    for (const [key, value] of Object.entries(row)) {
      if ((key === "id" || key.endsWith("_id")) && value != null)
        forbidden.add(String(value));
    }
  }
  for (const fixture of created.fixtureRows) {
    for (const value of Object.values(fixture.keys)) {
      if (value != null) forbidden.add(String(value));
    }
  }
  for (const { name, signature, trigger } of functions) {
    if (trigger) continue;
    if (!RPC_CASES.has(signature)) continue;
    const before = await snapshotB(tables);
    const result = await member.rpc(name, rpcArguments(signature));
    const after = await snapshotB(tables);
    const unchanged = JSON.stringify(after) === JSON.stringify(before);
    const response = JSON.stringify(result.data);
    const noBIdentifiers = [...forbidden].every(
      (id) => !response?.includes(id),
    );
    const safeResult =
      signature === "is_household_member(uuid)"
        ? result.data === false
        : signature === "resolve_telegram_member(bigint)" ||
            signature === "redeem_telegram_link_code(text,bigint)" ||
            signature === "discard_telegram_link_code(text)"
          ? Boolean(result.error)
          : Boolean(result.error) || noBIdentifiers;
    record(
      `SECURITY DEFINER ${signature} cannot affect B`,
      unchanged && safeResult,
      result.error?.message ?? (unchanged ? "B unchanged" : "B changed"),
    );
  }
}

async function membershipRows(userId) {
  const { rows } = await database.query(
    "select household_id::text, user_id::text, is_active from public.household_members where user_id = $1 order by household_id",
    [userId],
  );
  return rows;
}

async function checkProvisionTriggers() {
  const email = `${MARKER}-trigger@example.test`;
  await fixture(
    "allowed_emails",
    {
      household_id: created.householdBId,
      email,
    },
    "email",
  );
  const userId = await createUser(email, MEMBER_B_PASSWORD);
  created.extraUserIds.push(userId);
  const provisioned = await membershipRows(userId);
  record(
    "trigger provision_household_member puts new allowlisted user in B only",
    provisioned.length === 1 &&
      provisioned[0].household_id === created.householdBId &&
      provisioned[0].user_id === userId,
  );
  const before = await membershipRows(created.memberUserId);
  const bad = await admin.from("allowed_emails").insert({
    household_id: created.householdBId,
    email: MEMBER_EMAIL,
  });
  if (!bad.error) {
    created.fixtureRows.push({
      table: "allowed_emails",
      keys: { email: MEMBER_EMAIL },
    });
  }
  const after = await membershipRows(created.memberUserId);
  record(
    "trigger provision_on_allowlist rejects existing A member for B",
    Boolean(bad.error) &&
      JSON.stringify(after) === JSON.stringify(before) &&
      before.length === 1 &&
      before[0].household_id === created.householdAId,
    bad.error?.message ?? "allowlist unexpectedly succeeded",
  );
}

async function checkPublicSignup() {
  const email = `${MARKER}-signup@example.test`;
  await fixture(
    "allowed_emails",
    {
      email,
      household_id: created.householdBId,
    },
    "email",
  );
  const signup = await anonClient().auth.signUp({
    email,
    password: `Proof-${randomUUID()}!`,
  });
  const users = await database.query(
    "select id from auth.users where email = $1",
    [email],
  );
  const userId = users.rows[0]?.id;
  if (userId) created.extraUserIds.push(userId);
  const membership = userId ? await membershipRows(userId) : [];
  record(
    "public email signup does not yield a session or a membership",
    (Boolean(signup.error) || signup.data.session === null) &&
      membership.length === 0,
    signup.error?.message,
  );
}

async function checkMemberColumnGrants(member) {
  const own = await admin
    .from("household_members")
    .select("*")
    .eq("user_id", created.memberUserId)
    .single();
  if (own.error) throw own.error;
  const other = created.bRows.household_members;
  for (const row of [own.data, other]) {
    for (const column of [
      "telegram_user_id",
      "telegram_username",
      "is_active",
      "role",
      "user_id",
      "household_id",
    ]) {
      const result = await member
        .from("household_members")
        .update({ [column]: row[column] })
        .eq("id", row.id)
        .select("id");
      record(
        `member cannot update ${column} on ${row.id === own.data.id ? "own" : "other"} row`,
        result.error?.code === "42501",
        result.error?.message ?? "update unexpectedly succeeded",
      );
    }
  }
  const ownName = await member
    .from("household_members")
    .update({ display_name: `${MARKER} display` })
    .eq("id", own.data.id)
    .select("display_name");
  record(
    "member can update display_name in own household",
    !ownName.error && ownName.data?.[0]?.display_name === `${MARKER} display`,
  );
  const otherName = await member
    .from("household_members")
    .update({ display_name: `${MARKER} other` })
    .eq("id", other.id)
    .select("id");
  record(
    "member cannot update display_name in another household",
    !otherName.error && otherName.data?.length === 0,
  );
}

async function checkTelegramLinks(member, outsider) {
  const anon = anonClient();
  const noCode = await anon.rpc("create_telegram_link_code");
  record(
    "anon cannot create Telegram link code",
    noCode.error?.code === "42501",
  );
  const outsiderCode = await outsider.rpc("create_telegram_link_code");
  record(
    "outsider cannot create Telegram link code",
    outsiderCode.error?.code === "42501",
  );
  for (const client of [anon, member]) {
    for (const [name, args] of [
      [
        "redeem_telegram_link_code",
        { p_code: "INVALID32", p_telegram_user_id: 1 },
      ],
      ["discard_telegram_link_code", { p_code: "INVALID32" }],
      ["resolve_telegram_member", { p_telegram_user_id: 1 }],
    ]) {
      const result = await client.rpc(name, args);
      record(
        `${client === anon ? "anon" : "member"} cannot execute ${name}`,
        result.error?.code === "42501",
      );
    }
  }
  const first = await member.rpc("create_telegram_link_code");
  if (first.error) throw first.error;
  const second = await member.rpc("create_telegram_link_code");
  if (second.error) throw second.error;
  const id = created.bTelegramId + 10;
  const old = await admin.rpc("redeem_telegram_link_code", {
    p_code: first.data,
    p_telegram_user_id: id,
  });
  record(
    "creating a second code invalidates the first",
    !old.error && old.data?.length === 0,
  );
  const claimed = await admin.rpc("redeem_telegram_link_code", {
    p_code: second.data,
    p_telegram_user_id: created.bTelegramId,
  });
  record(
    "already linked Telegram id cannot be claimed",
    !claimed.error && claimed.data?.length === 0,
  );
  const rejectedReplay = await admin.rpc("redeem_telegram_link_code", {
    p_code: second.data,
    p_telegram_user_id: id,
  });
  record(
    "rejected Telegram link code cannot be reused",
    !rejectedReplay.error && rejectedReplay.data?.length === 0,
  );
  const discarded = await member.rpc("create_telegram_link_code");
  if (discarded.error) throw discarded.error;
  const discardResult = await admin.rpc("discard_telegram_link_code", {
    p_code: ` ${discarded.data.toLowerCase()} `,
  });
  const discardedReplay = await admin.rpc("redeem_telegram_link_code", {
    p_code: discarded.data,
    p_telegram_user_id: id,
  });
  record(
    "discarded Telegram link code cannot be redeemed",
    !discardResult.error &&
      !discardedReplay.error &&
      discardedReplay.data?.length === 0,
  );
  const fresh = await member.rpc("create_telegram_link_code");
  if (fresh.error) throw fresh.error;
  const valid = await admin.rpc("redeem_telegram_link_code", {
    p_code: fresh.data,
    p_telegram_user_id: id,
  });
  record(
    "valid code binds its creating member",
    !valid.error && valid.data?.[0]?.user_id === created.memberUserId,
  );
  const replay = await admin.rpc("redeem_telegram_link_code", {
    p_code: fresh.data,
    p_telegram_user_id: id + 1,
  });
  record(
    "Telegram link code cannot be redeemed twice",
    !replay.error && replay.data?.length === 0,
  );
  const expiring = await member.rpc("create_telegram_link_code");
  if (expiring.error) throw expiring.error;
  const expiredHash = createHash("sha256").update(expiring.data).digest("hex");
  await admin
    .from("telegram_link_codes")
    .update({ expires_at: "2000-01-01T00:00:00Z" })
    .eq("code_hash", expiredHash);
  const expired = await admin.rpc("redeem_telegram_link_code", {
    p_code: expiring.data,
    p_telegram_user_id: id + 1,
  });
  record(
    "expired Telegram link code binds nothing",
    !expired.error && expired.data?.length === 0,
  );
  const unlinked = await member.rpc("unlink_telegram");
  const aLink = await admin
    .from("household_members")
    .select("telegram_user_id")
    .eq("user_id", created.memberUserId)
    .single();
  const bLink = await admin
    .from("household_members")
    .select("telegram_user_id")
    .eq("user_id", created.memberBUserId)
    .single();
  record(
    "unlink_telegram clears only caller's row",
    !unlinked.error &&
      aLink.data?.telegram_user_id === null &&
      bLink.data?.telegram_user_id === created.bTelegramId,
  );
  for (const client of [anon, member]) {
    const read = await client.from("telegram_link_codes").select("*");
    const write = await client.from("telegram_link_codes").insert({
      member_id: created.bRows.household_members.id,
      code_hash: `${MARKER}-forged`,
      expires_at: "2030-01-01T00:00:00Z",
    });
    const update = await client
      .from("telegram_link_codes")
      .update({ expires_at: "2030-01-01T00:00:00Z" })
      .eq("member_id", created.bRows.household_members.id);
    const deletion = await client
      .from("telegram_link_codes")
      .delete()
      .eq("member_id", created.bRows.household_members.id);
    record(
      `${client === anon ? "anon" : "member"} cannot read or write telegram_link_codes`,
      (read.error?.code === "42501" || read.data?.length === 0) &&
        write.error?.code === "42501" &&
        update.error?.code === "42501" &&
        deletion.error?.code === "42501",
    );
  }
}

async function checkTelegramResolution() {
  const found = await admin.rpc("resolve_telegram_member", {
    p_telegram_user_id: created.bTelegramId,
  });
  record(
    "service role resolves B Telegram id to B membership",
    !found.error &&
      found.data?.length === 1 &&
      found.data[0].household_id === created.householdBId &&
      found.data[0].user_id === created.memberBUserId,
    found.error?.message,
  );
  const inactiveId = created.bTelegramId + 1;
  const inactive = await admin
    .from("household_members")
    .update({ telegram_user_id: inactiveId })
    .eq("user_id", created.inactiveUserId);
  if (inactive.error) throw new Error(inactive.error.message);
  const missing = await admin.rpc("resolve_telegram_member", {
    p_telegram_user_id: inactiveId,
  });
  record(
    "service role cannot resolve inactive Telegram member",
    !missing.error && Array.isArray(missing.data) && missing.data.length === 0,
    missing.error?.message,
  );
  const unknown = await admin.rpc("resolve_telegram_member", {
    p_telegram_user_id: inactiveId + 1,
  });
  record(
    "service role cannot resolve an unknown Telegram id",
    !unknown.error && Array.isArray(unknown.data) && unknown.data.length === 0,
    unknown.error?.message,
  );
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
      admin
        .from("import_batches")
        .select("id")
        .eq("household_id", householdId)
        .like("notes", `${MARKER}%`),
      admin
        .from("transactions")
        .select("id")
        .eq("household_id", householdId)
        .like("description", `${MARKER} import%`),
      admin
        .from("import_rows")
        .select("id")
        .eq("household_id", householdId)
        .like("description", `${MARKER} import%`),
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
      {
        ...parcelBase,
        household_id: householdId,
        number: 1,
        amount_cents: 10000,
        due_month: "2026-02",
      },
      // Invalid parcel: number > installment_count violates the CHECK → the
      // whole RPC must roll back, leaving no orphan group.
      {
        ...parcelBase,
        household_id: householdId,
        number: 3,
        amount_cents: 10000,
        due_month: "2026-03",
      },
    ],
  });
  record(
    "(d3) create_installment_purchase invalid parcel errors",
    Boolean(error),
    error ? error.message : "rpc unexpectedly succeeded",
  );

  const [{ data: groups }, { data: parcels }] = await Promise.all([
    admin
      .from("installment_groups")
      .select("id")
      .eq("household_id", householdId)
      .like("description", `${MARKER}%`),
    admin
      .from("installments")
      .select("id")
      .eq("household_id", householdId)
      .like("description", `${MARKER}%`),
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

/**
 * (e) The public `anon` role must NOT be able to EXECUTE any SECURITY DEFINER
 * RPC. The Supabase stack grants EXECUTE to anon by default; migration 0012
 * revokes it. This is the regression gate for that hole — an unauthenticated
 * anon client calling each RPC must fail at the permission layer (Postgres
 * error 42501, surfaced by PostgREST), NOT reach the function body.
 */
async function checkAnonCannotExecuteRpcs(householdId) {
  const anon = anonClient();
  const rpcs = [
    [
      "materialize_obligation_payment",
      {
        target_obligation_id: "ffffffff-ffff-ffff-ffff-ffffffffffff",
        target_month: "2026-01",
        paid_on: null,
        target_amount_cents: null,
        target_account_id: null,
      },
    ],
    [
      "merge_category",
      {
        target_household_id: householdId,
        source_category_id: created.categoryId,
        target_category_id: "ffffffff-ffff-ffff-ffff-ffffffffffff",
      },
    ],
    [
      "create_installment_purchase",
      { group_payload: {}, installments_payload: [] },
    ],
    ["confirm_import", { batch_payload: {}, rows_payload: [] }],
    [
      "settle_card_bill",
      {
        target_household_id: "ffffffff-ffff-ffff-ffff-ffffffffffff",
        target_credit_card_id: "ffffffff-ffff-ffff-ffff-ffffffffffff",
        target_account_id: "ffffffff-ffff-ffff-ffff-ffffffffffff",
        target_bill_month: "2026-01",
        target_amount_cents: 100,
        target_paid_on: "2026-01-01",
        target_created_by_user_id: "ffffffff-ffff-ffff-ffff-ffffffffffff",
        target_idempotency_key: randomUUID(),
      },
    ],
  ];
  for (const [name, args] of rpcs) {
    const { error } = await anon.rpc(name, args);
    // Any error that denies execution is a pass; a permission error is the
    // expected shape. A SUCCESS (or a body-level validation error, which means
    // the body RAN) is a fail — anon reached the function.
    const denied =
      Boolean(error) &&
      /permission denied|not allowed|42501/i.test(error.message);
    record(
      `(e) anon cannot EXECUTE ${name}`,
      denied,
      error ? `denied: ${error.message}` : "anon reached the RPC (NOT denied)",
    );
  }
}

/**
 * (f) Obligations RPC: a member can materialize a month once (idempotent
 * repeat is a no-op), and a month outside the obligation's [start, term-end]
 * window is rejected. Uses a throwaway obligation, cleaned up here.
 */
async function checkObligationMaterialization(member, householdId) {
  const { data: ob, error: obErr } = await admin
    .from("obligations")
    .insert({
      household_id: householdId,
      description: `${MARKER} obligation`,
      amount_cents: 71044,
      start_month: "2026-01",
      term_months: 12,
      due_day: 5,
      account_id: created.accountId,
      created_by_user_id: created.memberUserId,
    })
    .select("id")
    .single();
  if (obErr) {
    record("(f) obligations fixture created", false, obErr.message);
    return;
  }

  const first = await member.rpc("materialize_obligation_payment", {
    target_obligation_id: ob.id,
    target_month: "2026-03",
    paid_on: null,
    target_amount_cents: null,
    target_account_id: null,
  });
  record(
    "(f1) member materializes an in-window month",
    !first.error && first.data && first.data.already_paid === false,
    first.error
      ? first.error.message
      : `already_paid=${first.data?.already_paid}`,
  );

  const repeat = await member.rpc("materialize_obligation_payment", {
    target_obligation_id: ob.id,
    target_month: "2026-03",
    paid_on: null,
    target_amount_cents: null,
    target_account_id: null,
  });
  record(
    "(f2) repeat is idempotent (already_paid=true, no double row)",
    !repeat.error && repeat.data && repeat.data.already_paid === true,
    repeat.error
      ? repeat.error.message
      : `already_paid=${repeat.data?.already_paid}`,
  );

  const outOfWindow = await member.rpc("materialize_obligation_payment", {
    target_obligation_id: ob.id,
    target_month: "2030-01",
    paid_on: null,
    target_amount_cents: null,
    target_account_id: null,
  });
  record(
    "(f3) month after the term is rejected",
    Boolean(outOfWindow.error) &&
      /month .* is after the .*term/i.test(outOfWindow.error.message),
    outOfWindow.error ? outOfWindow.error.message : "unexpectedly accepted",
  );

  for (const payload of [
    { target_obligation_id: ob.id, target_month: "2026-04" },
    {
      target_obligation_id: ob.id,
      target_month: "2026-05",
      paid_on: "2026-05-12",
    },
  ]) {
    const legacy = await member.rpc("materialize_obligation_payment", payload);
    record(
      `(f4) legacy ${Object.keys(payload).length}-key RPC retains template defaults`,
      !legacy.error &&
        legacy.data?.transaction?.amount_cents === 71044 &&
        legacy.data?.transaction?.account_id === created.accountId &&
        legacy.data?.transaction?.occurred_on ===
          (payload.paid_on ?? "2026-04-05"),
      legacy.error ? legacy.error.message : JSON.stringify(legacy.data),
    );
  }

  // Cleanup: the materialized transaction + the obligation.
  await admin.from("transactions").delete().eq("obligation_id", ob.id);
  await admin.from("obligations").delete().eq("id", ob.id);
}

/**
 * (g) Card-bill settlement RPC: member success and idempotency, null-uid
 * service-role denial under migration 202610080003, outsider denial, and instrument
 * constraints.
 */
async function checkCardBillSettlement(member, householdId) {
  // (g1) member settles the bill for the fixture card+account.
  const paymentArgs = {
    target_household_id: householdId,
    target_credit_card_id: created.creditCardId,
    target_account_id: created.accountId,
    target_bill_month: "2026-04",
    target_amount_cents: 123456,
    target_paid_on: "2026-04-10",
    target_created_by_user_id: created.memberUserId,
    target_idempotency_key: randomUUID(),
  };
  const first = await member.rpc("settle_card_bill", paymentArgs);
  record(
    "(g1) member settles a card bill (replayed=false)",
    !first.error && first.data && first.data.replayed === false,
    first.error ? first.error.message : `replayed=${first.data?.replayed}`,
  );
  record(
    "(g1b) settle row carries BOTH instruments + bill_month",
    !first.error &&
      first.data?.transaction?.account_id === created.accountId &&
      first.data?.transaction?.credit_card_id === created.creditCardId &&
      first.data?.transaction?.bill_month === "2026-04" &&
      first.data?.transaction?.kind === "transfer",
  );

  // (g2) repeat is idempotent.
  const repeat = await member.rpc("settle_card_bill", paymentArgs);
  record(
    "(g2) repeat settle is idempotent (replayed=true)",
    !repeat.error &&
      repeat.data?.replayed === true &&
      Boolean(first.data?.transaction?.id) &&
      repeat.data?.transaction?.id === first.data.transaction.id,
    repeat.error ? repeat.error.message : `replayed=${repeat.data?.replayed}`,
  );

  // (g3) Business writes require a member JWT, including the bot.
  const svc = await admin.rpc("settle_card_bill", {
    target_household_id: householdId,
    target_credit_card_id: created.creditCardId,
    target_account_id: created.accountId,
    target_bill_month: "2026-04",
    target_amount_cents: 123456,
    target_paid_on: "2026-04-10",
    target_created_by_user_id: created.memberUserId,
    target_idempotency_key: randomUUID(),
  });
  record(
    "(g3) service-role null-uid settlement denied",
    Boolean(svc.error),
    svc.error ? svc.error.message : "",
  );

  // (g4) outsider gets 'not found' (0011-style probe resistance).
  const outsider = await signIn(OUTSIDER_EMAIL, OUTSIDER_PASSWORD);
  const foreign = await outsider.rpc("settle_card_bill", {
    target_household_id: householdId,
    target_credit_card_id: created.creditCardId,
    target_account_id: created.accountId,
    target_bill_month: "2026-06",
    target_amount_cents: 123456,
    target_paid_on: "2026-06-10",
    target_created_by_user_id: created.memberUserId,
    target_idempotency_key: randomUUID(),
  });
  const g4Ok =
    Boolean(foreign.error) && /not found/i.test(foreign.error.message);
  record(
    "(g4) outsider settle rejected as not-found",
    g4Ok,
    foreign.error ? foreign.error.message : "rpc unexpectedly succeeded",
  );
  await outsider.auth.signOut();

  // (g5) constraint matrix via admin direct inserts.
  const { error: bothOnExpenseError } = await admin
    .from("transactions")
    .insert({
      household_id: householdId,
      kind: "expense",
      amount_cents: 100,
      occurred_on: "2026-04-01",
      description: `${MARKER} g5 expense both instruments`,
      account_id: created.accountId,
      credit_card_id: created.creditCardId,
      created_by_user_id: created.memberUserId,
    });
  record(
    "(g5a) expense with BOTH instruments violates the CHECK",
    Boolean(bothOnExpenseError),
    bothOnExpenseError
      ? bothOnExpenseError.message
      : "insert unexpectedly succeeded",
  );

  const { error: transferBillMonthSingleError } = await admin
    .from("transactions")
    .insert({
      household_id: householdId,
      kind: "transfer",
      amount_cents: 100,
      occurred_on: "2026-04-01",
      description: `${MARKER} g5 transfer bill_month single instrument`,
      account_id: created.accountId,
      credit_card_id: null,
      bill_month: "2026-07",
      created_by_user_id: created.memberUserId,
    });
  record(
    "(g5b) transfer with bill_month + only account_id violates the CHECK",
    Boolean(transferBillMonthSingleError),
    transferBillMonthSingleError
      ? transferBillMonthSingleError.message
      : "insert unexpectedly succeeded",
  );

  const { data: plainTransfer, error: plainTransferError } = await admin
    .from("transactions")
    .insert({
      household_id: householdId,
      kind: "transfer",
      amount_cents: 100,
      occurred_on: "2026-04-01",
      description: `${MARKER} g5 plain transfer`,
      account_id: created.accountId,
      credit_card_id: null,
      bill_month: null,
      created_by_user_id: created.memberUserId,
    })
    .select("id")
    .single();
  record(
    "(g5c) plain transfer (bill_month null) with only account_id is accepted",
    !plainTransferError,
    plainTransferError ? plainTransferError.message : "",
  );
  if (plainTransfer?.id) {
    await admin.from("transactions").delete().eq("id", plainTransfer.id);
  }

  // (g6) The installment RPC has the same authenticated-member gate.
  const groupPayload = {
    household_id: householdId,
    credit_card_id: created.creditCardId,
    description: `${MARKER} g6 parcelado`,
    total_amount_cents: 10000,
    installment_count: 1,
    purchased_on: "2026-04-01",
    category_id: null,
    subcategory_id: null,
    responsibility_scope: "household",
    responsible_user_id: null,
    created_by_user_id: created.memberUserId,
  };
  const installmentsPayload = [
    {
      household_id: householdId,
      credit_card_id: created.creditCardId,
      number: 1,
      installment_count: 1,
      amount_cents: 10000,
      due_month: "2026-04",
      description: `${MARKER} g6 parcelado`,
      category_id: null,
      subcategory_id: null,
      responsibility_scope: "household",
      responsible_user_id: null,
      created_by_user_id: created.memberUserId,
    },
  ];
  const g6 = await admin.rpc("create_installment_purchase", {
    group_payload: groupPayload,
    installments_payload: installmentsPayload,
  });
  record(
    "(g6) service-role null-uid installment creation denied",
    Boolean(g6.error),
    g6.error ? g6.error.message : "",
  );
  if (g6.data?.group?.id) {
    // Cascade removes the parcels.
    await admin.from("installment_groups").delete().eq("id", g6.data.group.id);
  }

  // Cleanup: delete the settle transfers — scoped to the fixture card so a
  // VPS run never touches the household's real "fatura paga" rows (their
  // description is RPC-derived, so they escape the MARKER-based teardown).
  // Must run BEFORE any teardown step that deletes the fixture card itself,
  // since transactions.credit_card_id is ON DELETE RESTRICT.
  await admin
    .from("transactions")
    .delete()
    .eq("credit_card_id", created.creditCardId)
    .not("bill_month", "is", null);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  if (cleanupMarker) {
    await recover(cleanupMarker);
    return;
  }
  console.log(`RLS proof against ${SUPABASE_URL} (marker: ${MARKER})`);
  let interrupted = false;
  for (const signal of ["SIGINT", "SIGTERM"])
    process.once(signal, () => {
      interrupted = true;
      record(
        `${signal} interrupted proof`,
        false,
        "cleanup follows in finally",
      );
    });
  try {
    await database.connect();
    const householdId = await setup();
    await setupHouseholdB();
    const matchingDatabase = await database.query(
      "select id from public.households where id = $1",
      [created.householdBId],
    );
    if (matchingDatabase.rowCount !== 1) {
      throw new Error(
        "DATABASE_URL and SUPABASE_URL point to different databases",
      );
    }
    const discovered = await catalog();
    const complete = await checkCatalogCoverage(discovered);
    if (!complete)
      throw new Error("catalog has a table or function without a proof case");
    if (interrupted) throw new Error("interrupted by signal");
    const member = await signIn(MEMBER_EMAIL, MEMBER_PASSWORD);
    const memberB = await signIn(MEMBER_B_EMAIL, MEMBER_B_PASSWORD);
    const outsider = await signIn(OUTSIDER_EMAIL, OUTSIDER_PASSWORD);
    const inactive = await signIn(`${MARKER}@example.test`, MEMBER_B_PASSWORD);

    await checkApiSchemas(member);
    await checkMemberReads(member);
    await checkOutsiderReads(outsider);
    await checkOutsiderInsert(outsider, householdId);
    await checkMemberBReads(memberB, discovered.tables);
    await checkCrossHouseholdTables(member, inactive, discovered.tables);
    await checkHouseholdVisibility(member);
    await checkInactiveHouseholdVisibility(inactive);
    await checkNoPolicyTables(member, outsider);
    await checkMemberColumnGrants(member);
    await checkCompositeForeignKeys(member);
    await checkDefinerFunctions(
      member,
      discovered.functions,
      discovered.tables,
    );
    await checkTelegramResolution();
    await checkTelegramLinks(member, outsider);
    await checkProvisionTriggers();
    await checkPublicSignup();
    await checkMergeCategoryRollback(member, householdId);
    await checkConfirmImportRollback(member, householdId);
    await checkInstallmentRollback(member, householdId);
    await checkAnonCannotExecuteRpcs(householdId);
    await checkObligationMaterialization(member, householdId);
    await checkCardBillSettlement(member, householdId);

    await member.auth.signOut();
    await memberB.auth.signOut();
    await outsider.auth.signOut();
    await inactive.auth.signOut();
  } catch (error) {
    console.error(`Unexpected failure while running checks: ${error.message}`);
    record("harness completed all checks", false, error.message);
  } finally {
    await teardown();
    if (database._connected) await database.end();
  }

  const failed = results.filter((result) => !result.ok);
  console.log(
    `\n${results.length - failed.length}/${results.length} checks passed`,
  );
  process.exitCode = failed.length === 0 ? 0 : 1;
}

main();
