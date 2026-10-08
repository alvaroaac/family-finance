/** Two actual transactions: each order must provision once despite invisible rows. */
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as pause } from "node:timers/promises";

const [container, database] = process.argv.slice(2);
if (!container || !database)
  throw new Error("Expected disposable container/database");
const args = [
  "exec",
  "-i",
  container,
  "psql",
  "-X",
  "-v",
  "ON_ERROR_STOP=1",
  "-U",
  "postgres",
  "-d",
  database,
  "-At",
];
const query = (sql) =>
  execFileSync("docker", [...args, "-c", sql], { encoding: "utf8" }).trim();

function writer(sql, label, hold) {
  const child = spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  let done = false;
  let readySeen = false;
  let markReady;
  let rejectReady;
  const ready = new Promise((resolve, reject) => {
    markReady = resolve;
    rejectReady = reject;
  });
  // Only held writers need the readiness promise.
  ready.catch(() => {});
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    if (!readySeen && stdout.includes("identity-race-ready")) {
      readySeen = true;
      markReady();
    }
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const finished = new Promise((resolve) => {
    child.on("error", (error) => {
      rejectReady(error);
      resolve({ code: -1, stderr: String(error) });
    });
    child.on("close", (code) => {
      done = true;
      if (!readySeen)
        rejectReady(new Error(`${label}: ${stderr || "closed before ready"}`));
      resolve({ code, stderr });
    });
  });
  child.stdin.write(
    `begin; set statement_timeout='30s'; set application_name='${label}'; ${sql};\n`,
  );
  if (hold) child.stdin.write("select 'identity-race-ready';\n");
  else child.stdin.end("commit;\n");
  return {
    child,
    ready,
    finished,
    get done() {
      return done;
    },
  };
}

for (const existing of [true, false]) {
  for (const authFirst of [true, false]) {
    const id = randomUUID();
    const email = `provision-race-${id}@example.test`;
    const label = `identity-race-${id}`;
    const home = "00000000-0000-0000-0000-000000000001";
    if (existing) {
      query(`insert into auth.users(id,email) values ('${id}','${email}')`);
      if (
        query(
          `select count(*) from household_members where user_id='${id}'`,
        ) !== "0"
      ) {
        throw new Error("Unconfirmed identity was provisioned before the race");
      }
    }
    const authSql = existing
      ? `update auth.users set email_confirmed_at=now() where id='${id}'`
      : `insert into auth.users(id,email,email_confirmed_at) values ('${id}','${email}',now())`;
    // Mixed case proves the shared lock follows the matching rule.
    const allowSql = `insert into allowed_emails(email,household_id) values ('${email.toUpperCase()}','${home}')`;
    const owner = writer(
      authFirst ? authSql : allowSql,
      `${label}-owner`,
      true,
    );
    let waiter;
    try {
      await owner.ready;
      waiter = writer(authFirst ? allowSql : authSql, `${label}-waiter`, false);
      let blocked = false;
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline && !waiter.done) {
        if (
          query(
            `select count(*) from pg_stat_activity where application_name='${label}-waiter' and wait_event_type='Lock' and wait_event='advisory'`,
          ) === "1"
        ) {
          blocked = true;
          break;
        }
        await pause(25);
      }
      owner.child.stdin.end("commit;\n");
      const results = await Promise.all([owner.finished, waiter.finished]);
      for (const result of results) {
        if (result.code !== 0)
          throw new Error(`Concurrent provisioning failed: ${result.stderr}`);
      }
      const count = query(
        `select count(*) from household_members where user_id='${id}' and household_id='${home}'`,
      );
      if (count !== "1")
        throw new Error(
          `${existing ? "confirmation" : "new signup"}/${authFirst ? "auth first" : "allowlist first"}: expected exactly one membership, got ${count}`,
        );
      if (!blocked)
        throw new Error(
          "Concurrent provisioning did not wait on the shared email lock",
        );
      query(
        `update auth.users set email_confirmed_at=now()+interval '1 second' where id='${id}'`,
      );
      if (
        query(
          `select count(*) from household_members where user_id='${id}'`,
        ) !== "1"
      ) {
        throw new Error("Repeated confirmation changed membership cardinality");
      }
    } finally {
      if (!owner.child.stdin.writableEnded)
        owner.child.stdin.end("rollback;\n");
      await owner.finished;
      if (waiter) await waiter.finished;
      query(
        `delete from allowed_emails where lower(email)='${email}'; delete from household_members where user_id='${id}'; delete from auth.users where id='${id}'`,
      );
    }
  }
}
console.log(
  "confirmed identity/allowlist concurrency passed in all four orders",
);
