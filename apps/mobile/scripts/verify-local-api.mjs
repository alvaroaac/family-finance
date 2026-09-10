/** Real HTTP/Auth/Postgres regression checks. Restricted to the isolated local stack. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
const config = JSON.parse(
  readFileSync(
    process.env.CASA_LOCAL_STATUS ?? "/private/tmp/casa-local-status.json",
    "utf8",
  ),
);
assert.equal(config.API_URL, "http://127.0.0.1:55321");
const base = "http://127.0.0.1:3109/api/mobile/v1/";
const login = await fetch(
  config.API_URL + "/auth/v1/token?grant_type=password",
  {
    method: "POST",
    headers: { apikey: config.ANON_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({
      email: "mobile-e2e@example.test",
      password: "CasaLocalTest-2026!",
    }),
  },
);
assert.equal(login.status, 200);
const { access_token: token } = await login.json();
let checks = 0;
async function request(path, body, status = 200, extra = {}) {
  const r = await fetch(base + path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...extra,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await r.json();
  assert.equal(r.status, status, `${path}: ${JSON.stringify(data)}`);
  checks++;
  return data;
}
const action = (action, fields) => request("actions", { action, fields });
assert.equal((await fetch(base + "bootstrap")).status, 401);
checks++;
await request("bootstrap", undefined, 403, { "x-household-id": randomUUID() });
const before = await request("bootstrap");
const account = before.catalog.accounts[0],
  category = before.catalog.categories.find((c) => c.name === "Alimentação");
assert.ok(account && category, "Run the UI setup flow first.");
const id = randomUUID();
const entry = {
  id,
  description: "API retry regression " + id,
  amountCents: 1234,
  kind: "expense",
  date: before.today,
  categoryId: category.id,
  subcategoryId: null,
  accountId: account.id,
  creditCardId: null,
  responsibleUserId: null,
  installmentCount: 1,
};
await request("entries", entry);
await request("entries", entry);
let state = await request("bootstrap");
assert.equal(state.entries.filter((e) => e.id === id).length, 1);
checks++;
await request("entries", { ...entry, amountCents: 9999 }, 409);
await request(
  "entries",
  { ...entry, id: randomUUID(), accountId: randomUUID() },
  422,
);
await request("entries", { ...entry, id: randomUUID(), amountCents: -1 }, 422);
await action("transactions.delete", { transactionId: id });
state = await request("bootstrap");
assert.ok(!state.entries.some((e) => e.id === id));
assert.equal(state.spentCents, before.spentCents);
checks++;
const purchase = state.entries.find(
  (e) => e.description === "Notebook E2E · 1/3",
);
assert.equal(purchase?.amountCents, 40000);
assert.match(purchase.date, /^\d{4}-\d{2}-\d{2}$/);
checks++;
const next = new Date(before.today.slice(0, 7) + "-01T12:00:00Z");
next.setUTCMonth(next.getUTCMonth() + 1);
const nextState = await request(
  "bootstrap?month=" + next.toISOString().slice(0, 7),
);
assert.equal(
  nextState.entries.find((e) => e.description === "Notebook E2E · 2/3")
    ?.amountCents,
  40000,
);
checks++;
const rentName = `API commitment regression ${randomUUID()}`;
await action("obligations.create", {
  description: rentName,
  amount: "1000",
  startMonth: state.month,
  dueDay: "10",
  accountId: account.id,
  categoryId: category.id,
});
state = await request("bootstrap");
const rent = state.resources.obligations.find(
  (o) => o.description === rentName,
);
assert.equal(rent.amount_cents, 100000);
assert.equal(rent.due_day, 10);
assert.equal(rent.paidThisMonth, false);
checks++;
await action("obligations.pay", {
  obligationId: rent.id,
  month: state.month,
  amount: "980",
});
await action("obligations.pay", {
  obligationId: rent.id,
  month: state.month,
  amount: "980",
});
state = await request("bootstrap");
const payments = state.entries.filter((e) => e.description === rentName);
assert.equal(payments.length, 1);
assert.equal(payments[0].amountCents, 98000);
assert.equal(
  state.resources.obligations.find((o) => o.id === rent.id).paidThisMonth,
  true,
);
checks++;
await action("obligations.cancel", { obligationId: rent.id });
state = await request("bootstrap");
assert.ok(!state.resources.obligations.some((o) => o.id === rent.id));
assert.ok(state.entries.some((e) => e.id === payments[0].id));
checks++;
await action("transactions.delete", { transactionId: payments[0].id });
assert.ok(
  state.entries.some(
    (e) =>
      e.kind === "transfer" && e.description.startsWith("Fatura Cartão E2E"),
  ),
);
checks++;
const suggestion = await request("draft", { text: "Gastei 42 no mercado" });
assert.equal(suggestion.amountCents, 4200);
assert.equal(suggestion.categoryId, category.id);
checks++;
const projection = await request("projection");
assert.equal(projection.length, 6);
assert.equal(projection[0].outflowCents, 0);
assert.equal(projection[1].outflowCents, 40000);
checks++;
for (const theme of ["esmeralda", "salvia"]) {
  const tokens = await request("design-system?theme=" + theme);
  assert.ok(tokens);
}
const marker = randomUUID().slice(0, 8);
for (const [resource, prefix, idKey] of [
  ["accounts", "accounts", "accountId"],
  ["cards", "cards", "cardId"],
]) {
  const name = `API ${prefix} ${marker}`;
  const fields =
    prefix === "accounts"
      ? { name, kind: "checking" }
      : { name, closingDay: "15", dueDay: "22" };
  await action(`${prefix}.create`, fields);
  state = await request("bootstrap");
  const item = state.resources[resource].find((r) => r.name === name);
  assert.ok(item);
  checks++;
  await action(`${prefix}.update`, {
    ...fields,
    [idKey]: item.id,
    name: name + " edited",
  });
  state = await request("bootstrap");
  assert.equal(
    state.resources[resource].find((r) => r.id === item.id).name,
    name + " edited",
  );
  checks++;
  await action(`${prefix}.delete`, { [idKey]: item.id });
  state = await request("bootstrap");
  assert.ok(!state.resources[resource].some((r) => r.id === item.id));
  checks++;
}
const emptyBucket = state.resources.buckets.find((b) => b.slug === "filhos");
assert.equal(
  emptyBucket.balance_cents,
  0,
  "The investment CRUD check requires the untouched local Filhos seed bucket.",
);
await action("investments.delete", { bucketId: emptyBucket.id });
await action("investments.create", {
  slug: "filhos",
  name: `API bucket ${marker}`,
});
state = await request("bootstrap");
const bucket = state.resources.buckets.find((b) => b.slug === "filhos");
assert.ok(bucket);
checks++;
await action("investments.balance", { bucketId: bucket.id, balance: "345.67" });
await action("investments.update", { bucketId: bucket.id, name: "Filhos E2E" });
state = await request("bootstrap");
const updatedBucket = state.resources.buckets.find((b) => b.id === bucket.id);
assert.equal(updatedBucket.balance_cents, 34567);
assert.equal(updatedBucket.name, "Filhos E2E");
checks++;
await action("investments.balance", { bucketId: bucket.id, balance: "0" });
await action("investments.update", {
  bucketId: bucket.id,
  name: emptyBucket.name,
});
console.log(
  `${checks} real API regression checks passed (local Auth + Postgres, no mocks).`,
);
