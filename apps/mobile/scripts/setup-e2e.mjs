/** Configure only the isolated local Supabase stack. Never accepts a remote URL. */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
const s = JSON.parse(
  readFileSync(
    process.env.CASA_LOCAL_STATUS ?? "/private/tmp/casa-local-status.json",
    "utf8",
  ),
);
assert.equal(s.API_URL, "http://127.0.0.1:55321");
const email = "mobile-e2e@example.test";
const headers = {
  apikey: s.SERVICE_ROLE_KEY,
  Authorization: `Bearer ${s.SERVICE_ROLE_KEY}`,
  "Content-Type": "application/json",
};
const users = await fetch(s.API_URL + "/auth/v1/admin/users", { headers }).then(
  (r) => r.json(),
);
if (!users.users?.some((u) => u.email === email)) {
  const r = await fetch(s.API_URL + "/auth/v1/admin/users", {
    method: "POST",
    headers,
    body: JSON.stringify({
      email,
      password: "CasaLocalTest-2026!",
      email_confirm: true,
    }),
  });
  assert.equal(r.status, 200, "Could not create isolated test user");
}
execFileSync(
  "docker",
  [
    "exec",
    "supabase_db_family-finance-mobile",
    "psql",
    "-U",
    "postgres",
    "-d",
    "postgres",
    "-v",
    "ON_ERROR_STOP=1",
    "-c",
    `insert into allowed_emails(email) values ('${email}') on conflict do nothing`,
  ],
  { stdio: "ignore" },
);
function writeLocal(relative, text) {
  const p = new URL(relative, import.meta.url);
  if (existsSync(p))
    assert.ok(
      readFileSync(p, "utf8").includes("http://127.0.0.1:55321"),
      "Refusing to overwrite non-test environment",
    );
  writeFileSync(p, text, { mode: 0o600 });
}
writeLocal(
  "../../web/.env.local",
  `NEXT_PUBLIC_SUPABASE_URL=${s.API_URL}\nNEXT_PUBLIC_SUPABASE_ANON_KEY=${s.ANON_KEY}\nAUTHORIZED_EMAILS=${email}\nNEXT_PUBLIC_SITE_URL=http://127.0.0.1:8087\n`,
);
writeLocal(
  "../.env.local",
  `EXPO_PUBLIC_API_URL=http://127.0.0.1:8087\nEXPO_PUBLIC_SUPABASE_URL=${s.API_URL}\nEXPO_PUBLIC_SUPABASE_ANON_KEY=${s.ANON_KEY}\n`,
);
console.log("Isolated test account and local environment are ready.");
