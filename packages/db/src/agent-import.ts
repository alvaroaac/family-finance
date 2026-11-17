import { Pool, types, type PoolClient, type QueryResultRow } from "pg";
import type {
  AccountRow,
  CreditCardRow,
  HouseholdMemberRow,
  CategoryRow,
  SubcategoryRow,
  CategorizationMemoryRow,
  TransactionRow,
  InstallmentGroupRow,
  ImportItemClaimRow,
  ConfirmImportV2BatchPayload,
  ConfirmImportV2Item,
  ConfirmImportV2Result,
} from "./types.js";

export type AgentIdentity = {
  userId: string;
  clientId: string;
  browser: boolean;
};
export class AgentImportDatabase {
  constructor(
    private db: PoolClient,
    public identity: AgentIdentity,
    public householdId: string,
  ) {}
  private async rows<T extends QueryResultRow>(
    sql: string,
    values: unknown[] = [],
  ): Promise<T[]> {
    return (await this.db.query<T>(sql, values)).rows;
  }
  async lock(key: string): Promise<void> {
    await this.db.query(
      "select pg_advisory_xact_lock(hashtextextended($1,0))",
      [`${this.householdId}:${key}`],
    );
  }
  async lockFinancialWrites(): Promise<void> {
    await this.db.query(
      "lock table transactions,installment_groups,installments,import_item_claims in share row exclusive mode",
    );
  }
  async catalog() {
    const h = this.householdId;
    return {
      household_id: h,
      accounts: await this.rows<Pick<AccountRow, "id" | "name">>(
        "select id,name from accounts where household_id=$1 order by name for share",
        [h],
      ),
      cards: await this.rows<
        Pick<CreditCardRow, "id" | "name" | "closing_day">
      >(
        "select id,name,closing_day from credit_cards where household_id=$1 order by name for share",
        [h],
      ),
      members: await this.rows<
        Pick<HouseholdMemberRow, "user_id" | "display_name">
      >(
        "select user_id,display_name from household_members where household_id=$1 and is_active for share",
        [h],
      ),
      categories: await this.rows<CategoryRow>(
        "select * from categories where household_id=$1 and is_active for share",
        [h],
      ),
      subcategories: await this.rows<SubcategoryRow>(
        "select * from subcategories where household_id=$1 and is_active for share",
        [h],
      ),
    };
  }
  async memory() {
    return this.rows<CategorizationMemoryRow>(
      "select * from categorization_memory where household_id=$1 and is_active",
      [this.householdId],
    );
  }
  async mappings() {
    return this.rows<{
      namespace: string;
      normalized_label: string;
      row_kind: string;
      category_id: string | null;
      subcategory_id: string | null;
      suppress: boolean;
    }>("select * from agent_import.source_mappings where household_id=$1", [
      this.householdId,
    ]);
  }
  async candidates(targets: unknown) {
    const values = [this.householdId, JSON.stringify(targets)];
    const transactions = await this.rows<
      TransactionRow & { source_description: string }
    >(
      `select distinct t.*,t.updated_at::text as updated_at,coalesce((select ir.description from import_rows ir where ir.transaction_id=t.id and ir.household_id=t.household_id and ir.description is not null limit 1),t.description) as source_description from transactions t join jsonb_to_recordset($2::jsonb) as r(target_id uuid, occurred_on date, amount_cents bigint) on (t.account_id=r.target_id or t.credit_card_id=r.target_id) and t.occurred_on=r.occurred_on and t.amount_cents=r.amount_cents where t.household_id=$1`,
      values,
    );
    const groups = await this.rows<InstallmentGroupRow>(
      `select distinct g.*,g.updated_at::text as updated_at from installment_groups g join jsonb_to_recordset($2::jsonb) as r(target_id uuid, installment_count integer) on g.credit_card_id=r.target_id and g.installment_count=r.installment_count where g.household_id=$1`,
      values,
    );
    return { transactions, groups };
  }
  async scopes(): Promise<string[]> {
    const rows = await this.rows<{ scopes: string[] }>(
      "select scopes from agent_import.client_grants where household_id=$1 and user_id=$2 and client_id=$3 and revoked_at is null for share",
      [this.householdId, this.identity.userId, this.identity.clientId],
    );
    return rows[0]?.scopes ?? [];
  }
  async grant(scopes: string[]): Promise<void> {
    if (!this.identity.browser) throw new Error("Browser session required");
    await this.db.query(
      `insert into agent_import.client_grants(household_id,user_id,client_id,scopes) values($1,$2,$3,$4) on conflict(household_id,user_id,client_id) do update set scopes=excluded.scopes,revoked_at=null`,
      [this.householdId, this.identity.userId, this.identity.clientId, scopes],
    );
  }
  async revoke(clientId: string): Promise<void> {
    if (!this.identity.browser) throw new Error("Browser session required");
    await this.db.query(
      "update agent_import.client_grants set revoked_at=now() where household_id=$1 and user_id=$2 and client_id=$3",
      [this.householdId, this.identity.userId, clientId],
    );
  }
  async grants() {
    return this.rows<{
      client_id: string;
      scopes: string[];
      revoked_at: string | null;
    }>(
      "select client_id,scopes,revoked_at from agent_import.client_grants where household_id=$1 and user_id=$2",
      [this.householdId, this.identity.userId],
    );
  }
  async operation(
    key: string,
  ): Promise<{ request_hash: string; result: unknown } | null> {
    const r = await this.rows<{ request_hash: string; result: unknown }>(
      "select request_hash,result from agent_import.operations where household_id=$1 and user_id=$2 and operation_key=$3",
      [this.householdId, this.identity.userId, key],
    );
    return r[0] ?? null;
  }
  async recordOperation(
    key: string,
    hash: string,
    result: unknown,
  ): Promise<void> {
    await this.db.query(
      "insert into agent_import.operations(household_id,user_id,operation_key,request_hash,result) values($1,$2,$3,$4,$5)",
      [
        this.householdId,
        this.identity.userId,
        key,
        hash,
        JSON.stringify(result),
      ],
    );
  }
  async loadDraft<T>(id: string): Promise<T | null> {
    const rows = await this.rows<{ payload: T }>(
      "select payload from agent_import.drafts where id=$1 and household_id=$2 and user_id=$3 for update",
      [id, this.householdId, this.identity.userId],
    );
    return rows[0]?.payload ?? null;
  }
  async createLineage(id: string): Promise<void> {
    await this.db.query(
      "insert into agent_import.lineages(id,household_id,user_id) values($1,$2,$3)",
      [id, this.householdId, this.identity.userId],
    );
  }
  async lineage(id: string): Promise<string | null> {
    const r = await this.rows<{ committed_draft_id: string | null }>(
      "select committed_draft_id from agent_import.lineages where id=$1 and household_id=$2 and user_id=$3 for update",
      [id, this.householdId, this.identity.userId],
    );
    if (!r[0]) throw new Error("Lineage unavailable");
    return r[0].committed_draft_id;
  }
  async saveDraft(
    d: { id: string; lineage_id: string; revision: number; state: string },
    expires: string,
  ): Promise<void> {
    await this.db.query(
      `insert into agent_import.drafts(id,lineage_id,household_id,user_id,revision,state,expires_at,payload) values($1,$2,$3,$4,$5,$6,$7,$8) on conflict(id) do update set revision=excluded.revision,state=excluded.state,expires_at=excluded.expires_at,payload=excluded.payload,updated_at=now()`,
      [
        d.id,
        d.lineage_id,
        this.householdId,
        this.identity.userId,
        d.revision,
        d.state,
        expires,
        JSON.stringify(d),
      ],
    );
  }
  async event(id: string, revision: number, changes: unknown): Promise<void> {
    await this.db.query(
      "insert into agent_import.events(draft_id,household_id,user_id,revision,client_id,changes) values($1,$2,$3,$4,$5,$6)",
      [
        id,
        this.householdId,
        this.identity.userId,
        revision,
        this.identity.clientId,
        JSON.stringify(changes),
      ],
    );
  }
  async invalidateApproval(id: string): Promise<void> {
    await this.db.query(
      "delete from agent_import.approvals where draft_id=$1",
      [id],
    );
  }
  async challenge(
    id: string,
    revision: number,
    hash: string,
    challengeHash: string,
    expires: string,
  ): Promise<void> {
    await this.db.query(
      `insert into agent_import.approvals(draft_id,household_id,user_id,revision,payload_hash,challenge_hash,expires_at) values($1,$2,$3,$4,$5,$6,$7) on conflict(draft_id) do update set revision=excluded.revision,payload_hash=excluded.payload_hash,challenge_hash=excluded.challenge_hash,expires_at=excluded.expires_at,approved_at=null,consumed_at=null`,
      [
        id,
        this.householdId,
        this.identity.userId,
        revision,
        hash,
        challengeHash,
        expires,
      ],
    );
  }
  async approval(id: string) {
    const r = await this.rows<{
      revision: number;
      payload_hash: string;
      challenge_hash: string;
      expires_at: Date;
      approved_at: Date | null;
      consumed_at: Date | null;
    }>(
      "select * from agent_import.approvals where draft_id=$1 and user_id=$2 for update",
      [id, this.identity.userId],
    );
    return r[0] ?? null;
  }
  async approve(id: string): Promise<void> {
    if (!this.identity.browser) throw new Error("Browser session required");
    await this.db.query(
      "update agent_import.approvals set approved_at=now() where draft_id=$1",
      [id],
    );
  }
  async commitLineage(lineageId: string, draftId: string): Promise<void> {
    await this.db.query(
      "update agent_import.lineages set committed_draft_id=$2 where id=$1 and committed_draft_id is null",
      [lineageId, draftId],
    );
    await this.db.query(
      "update agent_import.approvals set consumed_at=now() where draft_id=$1",
      [draftId],
    );
  }
  async claims(base: string, occurrence: number) {
    return this.rows<ImportItemClaimRow>(
      "select * from import_item_claims where household_id=$1 and source='agent_structured' and fingerprint_version=1 and base_fingerprint=$2 and occurrence_no=$3 and override_token is null",
      [this.householdId, base, occurrence],
    );
  }
  async confirm(
    batch: ConfirmImportV2BatchPayload,
    items: ConfirmImportV2Item[],
  ): Promise<ConfirmImportV2Result> {
    const r = await this.rows<{ result: ConfirmImportV2Result }>(
      "select confirm_import_v2($1::jsonb,$2::jsonb) as result",
      [JSON.stringify(batch), JSON.stringify(items)],
    );
    return r[0]!.result;
  }
  async artifacts(batchId: string) {
    return {
      transactions: await this.rows<{ id: string }>(
        "select id from transactions where import_batch_id=$1 and household_id=$2",
        [batchId, this.householdId],
      ),
      groups: await this.rows<{ id: string }>(
        "select distinct installment_group_id as id from import_rows where import_batch_id=$1 and household_id=$2 and installment_group_id is not null",
        [batchId, this.householdId],
      ),
    };
  }
  async learnSource(mapping: {
    namespace: string;
    normalized_label: string;
    row_kind: string;
    category_id: string | null;
    subcategory_id: string | null;
    suppress: boolean;
  }): Promise<void> {
    await this.db.query(
      `insert into agent_import.source_mappings(household_id,namespace,normalized_label,row_kind,category_id,subcategory_id,suppress) values($1,$2,$3,$4,$5,$6,$7) on conflict(household_id,namespace,normalized_label,row_kind) do update set category_id=excluded.category_id,subcategory_id=excluded.subcategory_id,suppress=excluded.suppress`,
      [
        this.householdId,
        mapping.namespace,
        mapping.normalized_label,
        mapping.row_kind,
        mapping.category_id,
        mapping.subcategory_id,
        mapping.suppress,
      ],
    );
  }
  async scrubDraft(id: string): Promise<void> {
    await this.db.query("delete from agent_import.events where draft_id=$1", [
      id,
    ]);
    await this.db.query(
      "update agent_import.operations set result=jsonb_build_object('import_id',$1::text,'state','cancelled','payload_removed',true) where result->>'import_id'=$1",
      [id],
    );
  }
  async cleanup(): Promise<void> {
    // Owner-scoped opportunistic cleanup complements the documented scheduled job.
    await this.db.query(
      `update agent_import.operations o set result=jsonb_build_object('import_id',d.id,'state',case when d.state='cancelled' then 'cancelled' else 'expired' end,'payload_removed',true) from agent_import.drafts d where o.result->>'import_id'=d.id::text and (d.state='cancelled' or (d.state<>'committed' and d.expires_at<now()-interval '24 hours'))`,
    );
    await this.db.query(
      `delete from agent_import.events where draft_id in(select id from agent_import.drafts where state='cancelled' or (state<>'committed' and expires_at<now()-interval '24 hours'))`,
    );
    await this.db.query(
      `delete from agent_import.approvals where expires_at<now()`,
    );
    await this.db.query(
      `update agent_import.drafts set state='expired',payload=payload||'{"state":"expired","rows":[],"sources":[],"warnings":[]}'::jsonb where state not in ('committed','cancelled') and expires_at<now()-interval '24 hours'`,
    );
  }
}
export function createAgentImportPool(connectionString: string): Pool {
  return new Pool({
    connectionString,
    max: 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
    types: {
      getTypeParser: (oid: number, format?: "text" | "binary") =>
        oid === 1082
          ? (value: string) => value
          : types.getTypeParser(oid, format),
    },
  });
}
export async function withAgentImportTransaction<T>(
  pool: Pool,
  identity: AgentIdentity,
  fn: (db: AgentImportDatabase) => Promise<T>,
): Promise<T> {
  const db = await pool.connect();
  try {
    await db.query("begin");
    const role = await db.query<{
      rolname: string;
      rolsuper: boolean;
      rolbypassrls: boolean;
    }>(
      "select rolname,rolsuper,rolbypassrls from pg_roles where rolname=current_user",
    );
    if (
      role.rows[0]?.rolname !== "ff_import_app" ||
      role.rows[0].rolsuper ||
      role.rows[0].rolbypassrls
    )
      throw new Error(
        "Import database must use the ff_import_app role without BYPASSRLS",
      );
    await db.query(
      "select set_config('request.jwt.claims',$1,true),set_config('statement_timeout','15000',true),set_config('lock_timeout','5000',true)",
      [
        JSON.stringify({
          sub: identity.userId,
          role: "authenticated",
          client_id: identity.browser ? undefined : identity.clientId,
        }),
      ],
    );
    const memberships = await db.query<{ household_id: string }>(
      "select household_id from household_members where user_id=$1 and is_active for share",
      [identity.userId],
    );
    if (memberships.rows.length !== 1)
      throw Object.assign(
        new Error("Exactly one active membership is required"),
        { code: "MEMBERSHIP_REQUIRED" },
      );
    const result = await fn(
      new AgentImportDatabase(db, identity, memberships.rows[0]!.household_id),
    );
    await db.query("commit");
    return result;
  } catch (e) {
    await db.query("rollback");
    throw e;
  } finally {
    db.release();
  }
}
