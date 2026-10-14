#!/usr/bin/env node
// Synthetic local-only OAuth + browser + MCP proof. Never targets production.
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { readFileSync, mkdirSync } from "node:fs";
import assert from "node:assert/strict";
const require = createRequire(
  new URL("../apps/web/package.json", import.meta.url),
);
const { createClient } = require("@supabase/supabase-js");
const { createServerClient } = require("@supabase/ssr");
const { Pool } = require("pg");
const { chromium } = require("@playwright/test");
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const {
  StreamableHTTPClientTransport,
} = require("@modelcontextprotocol/sdk/client/streamableHttp.js");
const env = Object.fromEntries(
  readFileSync(new URL("../.agent-import-test.env", import.meta.url), "utf8")
    .split("\n")
    .filter((l) => /^\w+=/.test(l))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i), l.slice(i + 1).replace(/^"|"$/g, "")];
    }),
);
assert.equal(env.API_URL, "http://127.0.0.1:57421");
const origin = "http://127.0.0.1:3147";
const auth = env.API_URL + "/auth/v1";
const admin = createClient(env.API_URL, env.SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const db = new Pool({ connectionString: env.DB_URL });
const suffix = randomUUID(),
  email = `agent-proof-${suffix}@example.test`,
  password = randomBytes(24).toString("base64url");
let browser, client;
const callbackServer = createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "text/html" });
  res.end("<h1>Connected</h1>");
});
await new Promise((resolve) =>
  callbackServer.listen(3148, "127.0.0.1", resolve),
);
try {
  const created = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  assert.ifError(created.error);
  const user = created.data.user.id;
  const household = randomUUID(),
    account = randomUUID(),
    category = randomUUID();
  await db.query(
    "insert into households(id,name) values($1,'MCP synthetic proof')",
    [household],
  );
  await db.query(
    "insert into household_members(household_id,user_id,role,is_active) values($1,$2,'owner',true)",
    [household, user],
  );
  await db.query(
    "insert into accounts(id,household_id,kind,name) values($1,$2,'checking','Conta de teste')",
    [account, household],
  );
  await db.query(
    "insert into categories(id,household_id,name,kind) values($1,$2,'Transporte','expense')",
    [category, household],
  );
  const cookies = [];
  const sessionClient = createServerClient(env.API_URL, env.ANON_KEY, {
    cookies: { getAll: () => [], setAll: (items) => cookies.push(...items) },
  });
  const login = await sessionClient.auth.signInWithPassword({
    email,
    password,
  });
  assert.ifError(login.error);
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  await context.addCookies(
    cookies.map((c) => ({
      name: c.name,
      value: c.value,
      url: origin,
      httpOnly: false,
      sameSite: "Lax",
    })),
  );
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  page.setDefaultNavigationTimeout(15000);
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const discovery = await fetch(
    auth + "/.well-known/oauth-authorization-server",
  );
  assert.equal(discovery.status, 200);
  const metadata = await discovery.json();
  const registration = await fetch(metadata.registration_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_name: "Family Finance synthetic MCP proof",
      redirect_uris: ["http://127.0.0.1:3148/callback"],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  const registered = await registration.json();
  assert.ok(registered.client_id, JSON.stringify(registered));
  const verifier = randomBytes(32).toString("base64url"),
    challenge = createHash("sha256").update(verifier).digest("base64url"),
    state = randomUUID();
  const authorize = new URL(metadata.authorization_endpoint);
  Object.entries({
    client_id: registered.client_id,
    redirect_uri: "http://127.0.0.1:3148/callback",
    response_type: "code",
    scope: "openid",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: origin + "/mcp",
  }).forEach(([k, v]) => authorize.searchParams.set(k, v));
  await page.goto(authorize.toString());
  await page
    .getByRole("heading", { name: "Conectar ao Family Finance" })
    .waitFor();
  await page.getByRole("button", { name: "Permitir acesso" }).click();
  console.log(
    "Consent destination:",
    new URL(page.url()).origin + new URL(page.url()).pathname,
  );
  await page.waitForURL("http://127.0.0.1:3148/callback**");
  const callback = new URL(page.url());
  assert.equal(callback.searchParams.get("state"), state);
  assert.ok(callback.searchParams.get("code"));
  const tokenResponse = await fetch(metadata.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: registered.client_id,
      redirect_uri: "http://127.0.0.1:3148/callback",
      code: callback.searchParams.get("code"),
      code_verifier: verifier,
    }),
  });
  const tokens = await tokenResponse.json();
  assert.ok(tokens.access_token, JSON.stringify(tokens));
  const claims = JSON.parse(
    Buffer.from(tokens.access_token.split(".")[1], "base64url"),
  );
  assert.equal(claims.sub, user);
  assert.ok(
    claims.aud.includes(origin + "/mcp"),
    "OAuth resource audience missing",
  );
  console.log(
    "PASS OAuth authorization-code flow, S256 PKCE, browser consent, existing user identity and resource audience",
  );
  const direct = await fetch(env.API_URL + "/rest/v1/accounts?select=id", {
    headers: {
      apikey: env.ANON_KEY,
      Authorization: `Bearer ${tokens.access_token}`,
    },
  });
  assert.equal(direct.status, 403, "OAuth token bypassed scoped import API");
  console.log("PASS OAuth token cannot use direct financial REST access");
  const apiContext = await fetch(origin + "/api/v1/import-context", {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  });
  assert.equal(apiContext.status, 200);
  assert.equal((await apiContext.json()).household_id, household);
  const missing = await fetch(origin + "/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(missing.status, 401);
  assert.ok(
    missing.headers
      .get("www-authenticate")
      ?.includes("oauth-protected-resource"),
  );
  const wrongResource = await fetch(origin + "/api/v1/import-context", {
    headers: { Authorization: `Bearer ${login.data.session.access_token}` },
  });
  assert.equal(wrongResource.status, 401);
  const metadataResponse = await fetch(
    origin + "/.well-known/oauth-protected-resource/mcp",
  );
  assert.equal(metadataResponse.status, 200);
  assert.equal((await metadataResponse.json()).resource, origin + "/mcp");
  console.log(
    "PASS shared HTTP context, protected-resource discovery, missing-token challenge and first-party-token audience rejection",
  );

  client = new Client({ name: "synthetic-import-proof", version: "1" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(origin + "/mcp"), {
      requestInit: {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      },
    }),
  );
  const tools = await client.listTools();
  assert.equal(tools.tools.length, 12);
  const call = async (name, args) => {
    const response = await client.callTool({ name, arguments: args });
    return response.structuredContent ?? JSON.parse(response.content[0].text);
  };
  const ctx = await call("get_import_context", {});
  assert.equal(ctx.household_id, household);
  const payload = {
    schema_version: "1",
    sources: [
      {
        client_source_id: "visible-statement",
        type: "browser_statement",
        label: "Extrato sintético visível",
        coverage: "partial",
        default_target: { type: "account", id: account },
      },
    ],
    entries: [
      {
        client_row_id: "ride-1",
        client_source_id: "visible-statement",
        observed: {
          description_original: "UBER TRIP",
          evidence_text: "10/10 UBER TRIP R$ 35,90",
          locator: "Visible list item 1",
        },
        proposed: {
          occurred_on: "2026-10-10",
          amount_cents: 3590,
          currency: "BRL",
          kind: "expense",
          posting_status: "posted",
        },
        uncertainties: [],
      },
    ],
  };
  let d = await call("create_import", {
    ...payload,
    idempotency_key: randomUUID(),
  });
  assert.ok(d.import_id, JSON.stringify(d));
  const mutate = async (name, extra = {}) => {
    d = await call(name, {
      import_id: d.import_id,
      expected_revision: d.revision,
      idempotency_key: randomUUID(),
      ...extra,
    });
    assert.ok(!d.error, JSON.stringify(d));
    return d;
  };
  await mutate("prepare_import");
  assert.equal(d.can_confirm, true);
  const rows = await call("get_import_rows", {
    import_id: d.import_id,
    expected_revision: d.revision,
  });
  const row = rows.rows[0];
  await mutate("update_import", {
    changes: [
      { action: "set_category", row_ids: [row.id], category_id: category },
    ],
  });
  await mutate("update_import", {
    changes: [
      {
        action: "set_fields",
        row_ids: [row.id],
        fields: { purchase_description: "Corrida para casa" },
        reason: "User clarified purchase description",
      },
      { action: "set_learning", row_ids: [row.id], merchant: true },
    ],
  });
  const confirmation = await call("request_import_confirmation", {
    import_id: d.import_id,
    expected_revision: d.revision,
    idempotency_key: randomUUID(),
  });
  await page.goto(confirmation.review_url);
  await page.getByRole("heading", { name: "Revisar importação" }).waitFor();
  const blocked = await call("confirm_import", {
    import_id: d.import_id,
    expected_revision: d.revision,
    idempotency_key: randomUUID(),
  });
  assert.equal(blocked.error.code, "APPROVAL_REQUIRED");
  mkdirSync(new URL("../artifacts/agent-import/", import.meta.url), {
    recursive: true,
  });
  await page.screenshot({
    path: new URL("../artifacts/agent-import/review.png", import.meta.url)
      .pathname,
    fullPage: true,
  });
  await page.getByRole("checkbox").check();
  const approvalResponse = page.waitForResponse((r) =>
    r.url().endsWith("/approval"),
  );
  await page.getByRole("button", { name: /Aprovar revisão/ }).click();
  const approved = await approvalResponse;
  assert.equal(
    approved.status(),
    303,
    approved.status() === 303 ? "" : await approved.text(),
  );
  await page.waitForURL("**?approved=1");
  await mutate("confirm_import");
  assert.equal(d.state, "committed");
  assert.equal(d.receipt.transaction_ids.length, 1);
  const financial = await db.query(
    "select description,amount_cents from transactions where id=$1",
    [d.receipt.transaction_ids[0]],
  );
  assert.equal(financial.rows[0].description, "Corrida para casa");
  assert.equal(Number(financial.rows[0].amount_cents), 3590);
  const evidence = await db.query(
    "select description from import_rows where transaction_id=$1",
    [d.receipt.transaction_ids[0]],
  );
  assert.equal(evidence.rows[0].description, "UBER TRIP");
  console.log(
    "PASS twelve MCP tools, context, browser-source intake, API categorization, two edit rounds, read-only review GET, approval, atomic commit, edited purchase label and original evidence",
  );
  let repeat = await call("create_import", {
    ...payload,
    idempotency_key: randomUUID(),
  });
  repeat = await call("prepare_import", {
    import_id: repeat.import_id,
    expected_revision: repeat.revision,
    idempotency_key: randomUUID(),
  });
  assert.equal(repeat.can_confirm, false);
  assert.equal(repeat.counts.selected, 0);
  console.log(
    "PASS repeat import finds overlap despite new draft identity and edited purchase label",
  );
  await page.goto(origin + "/oauth/connections");
  await page.getByRole("button", { name: "Revogar acesso" }).click();
  await page.waitForURL("**/oauth/connections");
  const revoked = await call("get_import_context", {});
  assert.equal(revoked.error.code, "SCOPE_REQUIRED");
  console.log("PASS browser revocation prevents subsequent MCP calls");
  assert.deepEqual(errors, []);
  console.log("PASS no browser page errors");
} finally {
  if (client) await client.close();
  if (browser) await browser.close();
  await db.end();
  await new Promise((resolve) => callbackServer.close(resolve));
}
