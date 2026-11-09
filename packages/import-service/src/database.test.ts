import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import {
  createAgentImportPool,
  withAgentImportTransaction,
  type AgentIdentity,
} from "@family-finance/db";
import { executeImport, approveImport } from "./service.js";
import { type ToolName, type Draft } from "./contracts.js";
const url = process.env.AGENT_IMPORT_TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;
suite("real database agent imports", () => {
  const admin = new Pool({ connectionString: url });
  let app: ReturnType<typeof createAgentImportPool>;
  const user = randomUUID(),
    other = randomUUID(),
    housemate = randomUUID(),
    household = randomUUID(),
    foreignHouse = randomUUID(),
    account = randomUUID(),
    foreignAccount = randomUUID(),
    category = randomUUID();
  const identity: AgentIdentity = {
    userId: user,
    clientId: "test-mcp",
    browser: false,
  };
  const options = { origin: "http://127.0.0.1:3147" };
  const run = (name: ToolName, args: unknown, who = identity) =>
    withAgentImportTransaction(app, who, (db) =>
      executeImport(db, name, args, options),
    );
  const entries = (description = "SYNTHETIC MERCHANT", amount = 8500) => [
    {
      client_row_id: "r1",
      client_source_id: "s1",
      observed: { description_original: description },
      proposed: {
        occurred_on: "2026-10-10",
        amount_cents: amount,
        currency: "BRL",
        kind: "expense",
        posting_status: "posted",
      },
      uncertainties: [],
    },
  ];
  const create = async (description?: string, amount?: number) =>
    run("create_import", {
      schema_version: "1",
      idempotency_key: randomUUID(),
      sources: [
        {
          client_source_id: "s1",
          type: "browser_statement",
          coverage: "partial",
          default_target: { type: "account", id: account },
        },
      ],
      entries: entries(description, amount),
    });
  const mutate = (
    name: ToolName,
    d: Record<string, unknown>,
    extra: Record<string, unknown> = {},
  ) =>
    run(name, {
      import_id: d.import_id,
      expected_revision: d.revision,
      idempotency_key: randomUUID(),
      ...extra,
    });
  const approve = async (d: Record<string, unknown>) => {
    const challenge = await mutate("request_import_confirmation", d);
    const secret = new URL(challenge.review_url as string).searchParams.get(
      "challenge",
    )!;
    await withAgentImportTransaction(
      app,
      { ...identity, browser: true },
      (db) =>
        approveImport(
          db,
          d.import_id as string,
          d.revision as number,
          secret,
          options,
        ),
    );
  };
  beforeAll(async () => {
    const parsed = new URL(url!);
    if (
      parsed.hostname !== "127.0.0.1" ||
      !["57422", "58422"].includes(parsed.port)
    )
      throw new Error("Use only the isolated local agent-import test stack");
    await admin.query(
      "alter role ff_import_app password 'agent-import-local-test-password'",
    );
    app = createAgentImportPool(
      `postgresql://ff_import_app:agent-import-local-test-password@127.0.0.1:${parsed.port}/postgres`,
    );
    await admin.query(
      "insert into households(id,name) values($1,'Agent test'),($2,'Foreign test')",
      [household, foreignHouse],
    );
    for (const u of [user, other, housemate])
      await admin.query(
        "insert into auth.users(id,email,email_confirmed_at) values($1,$2,now())",
        [u, `${u}@example.test`],
      );
    await admin.query(
      "insert into household_members(household_id,user_id,role,is_active) values($1,$2,'owner',true),($3,$4,'owner',true),($1,$5,'member',true)",
      [household, user, foreignHouse, other, housemate],
    );
    await admin.query(
      "insert into accounts(id,household_id,kind,name) values($1,$2,'checking','Test account'),($3,$4,'checking','Foreign account')",
      [account, household, foreignAccount, foreignHouse],
    );
    await admin.query(
      "insert into categories(id,household_id,name,kind) values($1,$2,'Transporte','expense')",
      [category, household],
    );
    for (const u of [user, other, housemate])
      await withAgentImportTransaction(
        app,
        { userId: u, clientId: "test-mcp", browser: true },
        (db) =>
          db.grant([
            "finance:context:read",
            "imports:read",
            "imports:prepare",
            "imports:commit",
          ]),
      );
  }, 30000);
  afterAll(async () => {
    if (app) await app.end();
    await admin.end();
  });
  it("two edit rounds, browser approval, atomic commit, receipt and repeated import", async () => {
    let d = await create();
    d = await mutate("prepare_import", d);
    expect(d.can_confirm).toBe(true);
    const rows = await run("get_import_rows", {
      import_id: d.import_id,
      expected_revision: d.revision,
    });
    const row = (rows.rows as { id: string }[])[0]!;
    d = await mutate("update_import", d, {
      changes: [
        { action: "set_category", row_ids: [row.id], category_id: category },
      ],
    });
    d = await mutate("update_import", d, {
      changes: [
        {
          action: "set_fields",
          row_ids: [row.id],
          fields: { purchase_description: "Corrida para casa" },
          reason: "User description",
        },
        { action: "set_learning", row_ids: [row.id], merchant: true },
      ],
    });
    await expect(mutate("confirm_import", d)).rejects.toMatchObject({
      code: "APPROVAL_REQUIRED",
    });
    await approve(d);
    const committed = await mutate("confirm_import", d);
    expect(committed.state).toBe("committed");
    const count = await admin.query(
      "select count(*)::int as n from transactions where household_id=$1",
      [household],
    );
    expect(count.rows[0].n).toBe(1);
    const retry = await mutate("confirm_import", d);
    expect(retry.replayed).toBe(true);
    expect(retry.receipt).toEqual(committed.receipt);
    let repeated = await create();
    repeated = await mutate("prepare_import", repeated);
    expect(repeated.can_confirm).toBe(false);
    const repeatRows = await run("get_import_rows", {
      import_id: repeated.import_id,
      expected_revision: repeated.revision,
    });
    expect(
      (repeatRows.rows as { candidates: unknown[] }[])[0]!.candidates,
    ).toHaveLength(1);
  });
  it("rejects foreign drafts and other household members, including approval and references", async () => {
    const d = await create("ISOLATION");
    for (const u of [other, housemate])
      await expect(
        run(
          "get_import",
          { import_id: d.import_id },
          { ...identity, userId: u },
        ),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      run("create_import", {
        schema_version: "1",
        idempotency_key: randomUUID(),
        sources: [
          {
            client_source_id: "s1",
            type: "manual",
            coverage: "complete",
            default_target: { type: "account", id: foreignAccount },
          },
        ],
        entries: entries("FOREIGN"),
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
  it("enforces revision compare-and-swap and atomic patch rollback", async () => {
    let d = await create("PATCH");
    d = await mutate("prepare_import", d);
    const old = { ...d };
    const rows = await run("get_import_rows", {
      import_id: d.import_id,
      expected_revision: d.revision,
    });
    const row = (rows.rows as { id: string }[])[0]!;
    await expect(
      mutate("update_import", d, {
        changes: [
          { action: "clear_category", row_ids: [row.id] },
          {
            action: "set_category",
            row_ids: [row.id],
            category_id: foreignAccount,
          },
        ],
      }),
    ).rejects.toBeDefined();
    expect((await run("get_import", { import_id: d.import_id })).revision).toBe(
      d.revision,
    );
    d = await mutate("update_import", d, {
      changes: [{ action: "clear_category", row_ids: [row.id] }],
    });
    await expect(mutate("prepare_import", old)).rejects.toMatchObject({
      code: "REVISION_CONFLICT",
    });
  });
  it("returns one result for a request retry and rejects a changed payload", async () => {
    const key = randomUUID();
    const body = {
      schema_version: "1",
      idempotency_key: key,
      sources: [
        {
          client_source_id: "s1",
          type: "manual",
          coverage: "complete",
          default_target: { type: "account", id: account },
        },
      ],
      entries: entries("REPLAY"),
    };
    const first = await run("create_import", body),
      second = await run("create_import", body);
    expect(second.import_id).toBe(first.import_id);
    expect(second.replayed).toBe(true);
    await expect(
      run("create_import", { ...body, entries: entries("ALTERED") }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });
  it("concurrent overlapping commits require a fresh review for the loser", async () => {
    let a = await create("RACE", 12345),
      b = await create("RACE", 12345);
    a = await mutate("prepare_import", a);
    b = await mutate("prepare_import", b);
    await approve(a);
    await approve(b);
    const results = await Promise.all([
      mutate("confirm_import", a),
      mutate("confirm_import", b),
    ]);
    expect(results.filter((r) => r.state === "committed")).toHaveLength(1);
    expect(results.find((r) => r.state !== "committed")?.error).toMatchObject({
      code: "REVIEW_CHANGED",
    });
    expect(
      (
        await admin.query(
          "select count(*)::int n from transactions where household_id=$1 and description='RACE'",
          [household],
        )
      ).rows[0].n,
    ).toBe(1);
  });
  it("revoked grants and membership prevent subsequent operations", async () => {
    await withAgentImportTransaction(
      app,
      { ...identity, browser: true },
      (db) => db.revoke("test-mcp"),
    );
    await expect(run("get_import_context", {})).rejects.toMatchObject({
      code: "SCOPE_REQUIRED",
    });
    await withAgentImportTransaction(
      app,
      { ...identity, browser: true },
      (db) =>
        db.grant([
          "finance:context:read",
          "imports:read",
          "imports:prepare",
          "imports:commit",
        ]),
    );
    await admin.query(
      "update household_members set is_active=false where user_id=$1",
      [user],
    );
    await expect(run("get_import_context", {})).rejects.toMatchObject({
      code: "MEMBERSHIP_REQUIRED",
    });
    await admin.query(
      "update household_members set is_active=true where user_id=$1",
      [user],
    );
  });
  it("an expired draft renews once per request and its old approval cannot commit", async () => {
    let d = await create("EXPIRED");
    d = await mutate("prepare_import", d);
    await approve(d);
    const expired = new Date(Date.now() - 1000).toISOString();
    await admin.query(
      "update agent_import.drafts set expires_at=$2::timestamptz,payload=jsonb_set(payload,'{review_expires_at}',to_jsonb($2::text)) where id=$1",
      [d.import_id, expired],
    );
    await expect(mutate("confirm_import", d)).rejects.toMatchObject({
      code: "DRAFT_EXPIRED",
    });
    const renewed = await mutate("renew_import", d);
    expect(renewed.import_id).not.toBe(d.import_id);
    expect(renewed.lineage_id).toBe(d.lineage_id);
    expect(renewed.can_confirm).toBe(true);
  });
  it("card refunds retain card-credit polarity and bill payments stay excluded", async () => {
    const card = randomUUID();
    await admin.query(
      "insert into credit_cards(id,household_id,name) values($1,$2,'Refund card')",
      [card, household],
    );
    const body = {
      schema_version: "1",
      idempotency_key: randomUUID(),
      sources: [
        {
          client_source_id: "s1",
          type: "pasted_text",
          coverage: "complete",
          default_target: { type: "card", id: card },
        },
      ],
      entries: [
        {
          ...entries("REFUND", 500)[0],
          proposed: {
            ...entries()[0]!.proposed,
            kind: "refund",
            amount_cents: 500,
          },
        },
        {
          ...entries("PAYMENT", 8000)[0],
          client_row_id: "payment",
          proposed: {
            ...entries()[0]!.proposed,
            kind: "card_payment",
            amount_cents: 8000,
          },
        },
      ],
    };
    let d = await run("create_import", body);
    d = await mutate("prepare_import", d);
    expect(d.counts).toMatchObject({ selected: 1, excluded: 1 });
    await approve(d);
    const result = await mutate("confirm_import", d);
    expect(result.state).toBe("committed");
    const tx = await admin.query(
      "select kind,amount_cents,credit_card_id from transactions where household_id=$1 and credit_card_id=$2",
      [household, card],
    );
    expect(tx.rows).toHaveLength(1);
    expect(tx.rows[0].kind).toBe("income");
    expect(Number(tx.rows[0].amount_cents)).toBe(500);
  });
  it("installment totals require acceptance, sum exactly, and later positions link the same group", async () => {
    const card = randomUUID();
    await admin.query(
      "insert into credit_cards(id,household_id,name) values($1,$2,'Installment card')",
      [card, household],
    );
    const intake = (position: number, date: string) => ({
      schema_version: "1",
      idempotency_key: randomUUID(),
      sources: [
        {
          client_source_id: "s1",
          type: "image",
          coverage: "partial",
          default_target: { type: "card", id: card },
        },
      ],
      entries: [
        {
          ...entries("PARCELADO", 1000)[0],
          proposed: {
            ...entries()[0]!.proposed,
            occurred_on: date,
            amount_cents: 1000,
            installment: {
              number: position,
              count: 3,
              purchased_on: "2026-10-10",
              total_amount_cents: 3000,
              inferred: true,
              inference_accepted: false,
            },
          },
        },
      ],
    });
    let d = await run("create_import", intake(1, "2026-10-10"));
    d = await mutate("prepare_import", d);
    expect(d.can_confirm).toBe(false);
    let rows = await run("get_import_rows", {
      import_id: d.import_id,
      expected_revision: d.revision,
    });
    let row = (rows.rows as { id: string }[])[0]!;
    d = await mutate("update_import", d, {
      changes: [
        {
          action: "set_fields",
          row_ids: [row.id],
          fields: {
            installment: {
              number: 1,
              count: 3,
              purchased_on: "2026-10-10",
              total_amount_cents: 3000,
              inferred: true,
              inference_accepted: true,
            },
          },
          reason: "User accepted the full purchase",
        },
      ],
    });
    expect(d.can_confirm).toBe(true);
    await approve(d);
    const result = await mutate("confirm_import", d);
    expect(result.state).toBe("committed");
    const groups = await admin.query(
      "select id from installment_groups where credit_card_id=$1",
      [card],
    );
    expect(groups.rows).toHaveLength(1);
    const group = groups.rows[0].id;
    expect(
      Number(
        (
          await admin.query(
            "select sum(amount_cents) total from installments where installment_group_id=$1",
            [group],
          )
        ).rows[0].total,
      ),
    ).toBe(3000);
    let later = await run("create_import", intake(2, "2026-11-10"));
    later = await mutate("prepare_import", later);
    rows = await run("get_import_rows", {
      import_id: later.import_id,
      expected_revision: later.revision,
    });
    row = (rows.rows as { id: string }[])[0]!;
    later = await mutate("update_import", later, {
      changes: [
        {
          action: "set_fields",
          row_ids: [row.id],
          fields: {
            installment: {
              number: 2,
              count: 3,
              existing_group_id: group,
              inferred: false,
              inference_accepted: false,
            },
          },
          reason: "Link the existing purchase",
        },
      ],
    });
    expect(later.can_confirm).toBe(true);
    await approve(later);
    expect((await mutate("confirm_import", later)).state).toBe("committed");
    expect(
      (
        await admin.query(
          "select id from installment_groups where credit_card_id=$1",
          [card],
        )
      ).rows,
    ).toHaveLength(1);
  });
  it("a failure after financial persistence rolls back artifacts, learning and approval consumption", async () => {
    let d = await create("ROLLBACK", 7654);
    d = await mutate("prepare_import", d);
    await approve(d);
    await expect(
      withAgentImportTransaction(app, identity, async (db) => {
        const original = db.confirm.bind(db);
        db.confirm = async (...args) => {
          await original(...args);
          throw new Error("Synthetic failure after financial insert");
        };
        return executeImport(
          db,
          "confirm_import",
          {
            import_id: d.import_id,
            expected_revision: d.revision,
            idempotency_key: randomUUID(),
          },
          options,
        );
      }),
    ).rejects.toThrow("Synthetic failure");
    expect(
      (
        await admin.query(
          "select count(*)::int n from transactions where household_id=$1 and description='ROLLBACK'",
          [household],
        )
      ).rows[0].n,
    ).toBe(0);
    expect(
      (
        await admin.query(
          "select consumed_at from agent_import.approvals where draft_id=$1",
          [d.import_id],
        )
      ).rows[0].consumed_at,
    ).toBeNull();
    expect((await mutate("confirm_import", d)).state).toBe("committed");
  });
  it("RLS denies unscoped foreign reads and foreign writes below the service", async () => {
    const conn = await app.connect();
    try {
      await conn.query("begin");
      await conn.query("select set_config('request.jwt.claims',$1,true)", [
        JSON.stringify({ sub: other, role: "authenticated" }),
      ]);
      expect(
        (
          await conn.query(
            "select id from agent_import.drafts where household_id=$1",
            [household],
          )
        ).rows,
      ).toEqual([]);
      await expect(
        conn.query(
          "insert into agent_import.lineages(id,household_id,user_id) values($1,$2,$3)",
          [randomUUID(), household, other],
        ),
      ).rejects.toBeDefined();
      await conn.query("rollback");
    } finally {
      conn.release();
    }
  });
  it("late AI results serialize with edits and never overwrite an explicit uncategorized choice", async () => {
    let d = await create("AI-UNRESOLVED");
    d = await mutate("prepare_import", d);
    const page = await run("get_import_rows", {
      import_id: d.import_id,
      expected_revision: d.revision,
    });
    const row = (page.rows as { id: string }[])[0]!;
    let release!: () => void, started!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reached = new Promise<void>((resolve) => {
      started = resolve;
    });
    const ai = withAgentImportTransaction(app, identity, (db) =>
      executeImport(
        db,
        "categorize_import",
        {
          import_id: d.import_id,
          expected_revision: d.revision,
          idempotency_key: randomUUID(),
        },
        {
          ...options,
          suggest: async () => {
            started();
            await barrier;
            return [
              {
                row_id: row.id,
                category_id: category,
                confidence: 0.9,
                explanation: "Synthetic AI suggestion",
              },
            ];
          },
        },
      ),
    );
    await reached;
    const edit = mutate("update_import", d, {
      changes: [{ action: "clear_category", row_ids: [row.id] }],
    });
    const rejected = expect(edit).rejects.toMatchObject({
      code: "REVISION_CONFLICT",
    });
    release();
    d = await ai;
    await rejected;
    d = await mutate("update_import", d, {
      changes: [{ action: "clear_category", row_ids: [row.id] }],
    });
    d = await withAgentImportTransaction(app, identity, (db) =>
      executeImport(
        db,
        "categorize_import",
        {
          import_id: d.import_id,
          expected_revision: d.revision,
          idempotency_key: randomUUID(),
        },
        {
          ...options,
          suggest: async () => [
            {
              row_id: row.id,
              category_id: category,
              confidence: 0.9,
              explanation: "Must not overwrite",
            },
          ],
        },
      ),
    );
    const after = await run("get_import_rows", {
      import_id: d.import_id,
      expected_revision: d.revision,
    });
    expect(
      (
        after.rows as {
          category_id: string | null;
          category_explicit: boolean;
        }[]
      )[0],
    ).toMatchObject({ category_id: null, category_explicit: true });
  });
  it("cleanup removes expired evidence from drafts, operation responses and events", async () => {
    let d = await create("RECOVERY-RETENTION-SECRET");
    d = await mutate("prepare_import", d);
    const expiry = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    await admin.query(
      "update agent_import.drafts set expires_at=$2::timestamptz,payload=jsonb_set(payload,'{review_expires_at}',to_jsonb($2::text)) where id=$1",
      [d.import_id, expiry],
    );
    await admin.query("select agent_import.prune_expired()");
    const saved = await admin.query(
      "select payload from agent_import.drafts where id=$1",
      [d.import_id],
    );
    expect(saved.rows[0].payload.rows).toEqual([]);
    expect(saved.rows[0].payload.sources).toEqual([]);
    const operations = await admin.query(
      "select result from agent_import.operations where result->>'import_id'=$1",
      [d.import_id],
    );
    expect(JSON.stringify(operations.rows)).not.toContain(
      "RECOVERY-RETENTION-SECRET",
    );
    expect(operations.rows.every((r) => r.result.payload_removed)).toBe(true);
    expect(
      (
        await admin.query(
          "select id from agent_import.events where draft_id=$1",
          [d.import_id],
        )
      ).rows,
    ).toEqual([]);
    await expect(mutate("renew_import", d)).rejects.toMatchObject({
      code: "DRAFT_EXPIRED",
    });
  });
  it("cancellation removes normalized payload", async () => {
    const d = await create("CANCEL");
    const cancelled = await mutate("cancel_import", d);
    expect(cancelled.state).toBe("cancelled");
    const loaded = await withAgentImportTransaction(
      app,
      { ...identity, browser: true },
      (db) => db.loadDraft<Draft>(d.import_id as string),
    );
    expect(loaded?.rows).toEqual([]);
  });
});
