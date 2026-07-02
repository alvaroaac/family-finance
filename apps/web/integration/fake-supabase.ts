/**
 * In-memory fake of the subset of the Supabase JS client that the
 * `@family-finance/db` repositories actually use.
 *
 * Task 11 proves the MVP story end-to-end OFFLINE: the REAL repository functions
 * (createTransaction, getMonthlySummary, getCardPressure, ...) run unchanged
 * against this fake, so the dashboard numbers are computed by the same code path
 * production uses — only the network/Postgres edge is replaced by an in-memory
 * store. There are NO live network calls.
 *
 * Scope (intentionally minimal — only what the repositories call):
 *   from(table)
 *     .select(cols, { count: "exact" }?) | .insert(payload) | .update(changes)
 *     .delete()
 *     .eq / .neq / .gte / .lte / .is / .not(col, "is", null) / .ilike
 *     .order(col, { ascending }) | .limit(n) | .range(from, to)
 *     .single() | .maybeSingle()
 * A query builder is a PromiseLike resolving to `{ data, error }`, matching the
 * Supabase contract the repositories destructure.
 *
 * This is a TEST fake. It does NOT enforce RLS (the real schema does); the test
 * always passes the correct household_id, so household scoping is still
 * exercised through the repositories' explicit `.eq("household_id", ...)`.
 */

type Row = Record<string, unknown>;

type Result<T> = {
  data: T;
  error: { message: string } | null;
  /** Present when the query asked for `{ count: "exact" }` (else null). */
  count?: number | null;
};

type Filter =
  | { op: "eq"; column: string; value: unknown }
  | { op: "neq"; column: string; value: unknown }
  | { op: "gte"; column: string; value: unknown }
  | { op: "lte"; column: string; value: unknown }
  | { op: "is"; column: string; value: null }
  | { op: "not-is-null"; column: string }
  | { op: "ilike"; column: string; pattern: string };

/**
 * Compile a SQL LIKE/ILIKE pattern (with `\` escapes) into a case-insensitive
 * anchored RegExp, mirroring Postgres semantics: `%` = any run, `_` = any one
 * character, `\%`/`\_`/`\\` = the literal character.
 */
function ilikePatternToRegExp(pattern: string): RegExp {
  let regex = "";
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i] as string;
    if (ch === "\\" && i + 1 < pattern.length) {
      regex += (pattern[i + 1] as string).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      i += 2;
      continue;
    }
    if (ch === "%") {
      regex += "[\\s\\S]*";
    } else if (ch === "_") {
      regex += "[\\s\\S]";
    } else {
      regex += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
    i += 1;
  }
  return new RegExp(`^${regex}$`, "i");
}

type Order = { column: string; ascending: boolean };

/** A tiny auto-incrementing id generator so inserted rows get stable ids. */
function makeIdFactory(): () => string {
  let n = 0;
  return () => {
    n += 1;
    return `row-${String(n).padStart(6, "0")}`;
  };
}

export type FakeDatabaseSeed = {
  [table: string]: Row[];
};

export class FakeSupabaseStore {
  readonly tables: Map<string, Row[]> = new Map();
  private readonly nextId = makeIdFactory();

  constructor(seed: FakeDatabaseSeed = {}) {
    for (const [table, rows] of Object.entries(seed)) {
      this.tables.set(
        table,
        rows.map((r) => ({ ...r })),
      );
    }
  }

  table(name: string): Row[] {
    let rows = this.tables.get(name);
    if (rows === undefined) {
      rows = [];
      this.tables.set(name, rows);
    }
    return rows;
  }

  /** Assign an id + timestamps to a freshly inserted row (mimics DB defaults). */
  materialize(payload: Row): Row {
    const now = new Date().toISOString();
    const row: Row = { ...payload };
    if (row.id === undefined) {
      row.id = this.nextId();
    }
    if (row.created_at === undefined) {
      row.created_at = now;
    }
    if (row.updated_at === undefined) {
      row.updated_at = now;
    }
    return row;
  }
}

type Mutation =
  | { kind: "select" }
  | { kind: "insert"; rows: Row[] }
  | { kind: "update"; changes: Row }
  | { kind: "delete" };

class QueryBuilder<T> implements PromiseLike<Result<T>> {
  private filters: Filter[] = [];
  private orders: Order[] = [];
  private limitCount: number | null = null;
  private rangeBounds: { from: number; to: number } | null = null;
  private countMode: "exact" | null = null;
  private filteredCount: number | null = null;
  private mutation: Mutation = { kind: "select" };
  private returnsRows = false;
  private shape: "many" | "single" | "maybe" = "many";

  constructor(
    private readonly store: FakeSupabaseStore,
    private readonly tableName: string,
  ) {}

  select(_columns?: string, options?: { count?: "exact" }): this {
    // After insert/update the caller chains .select() to get the rows back.
    this.returnsRows = true;
    this.countMode = options?.count ?? null;
    return this;
  }

  insert(payload: Row | Row[]): this {
    const rows = Array.isArray(payload) ? payload : [payload];
    this.mutation = { kind: "insert", rows };
    return this;
  }

  update(changes: Row): this {
    this.mutation = { kind: "update", changes };
    return this;
  }

  delete(): this {
    this.mutation = { kind: "delete" };
    return this;
  }

  eq(column: string, value: unknown): this {
    this.filters.push({ op: "eq", column, value });
    return this;
  }

  neq(column: string, value: unknown): this {
    this.filters.push({ op: "neq", column, value });
    return this;
  }

  gte(column: string, value: unknown): this {
    this.filters.push({ op: "gte", column, value });
    return this;
  }

  lte(column: string, value: unknown): this {
    this.filters.push({ op: "lte", column, value });
    return this;
  }

  is(column: string, value: null): this {
    this.filters.push({ op: "is", column, value });
    return this;
  }

  ilike(column: string, pattern: string): this {
    this.filters.push({ op: "ilike", column, pattern });
    return this;
  }

  not(column: string, operator: string, value: unknown): this {
    // The repositories only use `.not("credit_card_id", "is", null)`.
    if (operator === "is" && value === null) {
      this.filters.push({ op: "not-is-null", column });
      return this;
    }
    throw new Error(`fake-supabase: unsupported .not(${operator})`);
  }

  order(column: string, options?: { ascending?: boolean }): this {
    this.orders.push({ column, ascending: options?.ascending ?? true });
    return this;
  }

  limit(count: number): this {
    this.limitCount = count;
    return this;
  }

  range(from: number, to: number): this {
    this.rangeBounds = { from, to };
    return this;
  }

  single(): this {
    this.shape = "single";
    return this;
  }

  maybeSingle(): this {
    this.shape = "maybe";
    return this;
  }

  private matches(row: Row): boolean {
    return this.filters.every((f) => {
      const cell = row[f.column];
      switch (f.op) {
        case "eq":
          return cell === f.value;
        case "neq":
          return cell !== f.value;
        case "gte":
          return (cell as string | number) >= (f.value as string | number);
        case "lte":
          return (cell as string | number) <= (f.value as string | number);
        case "is":
          return cell === null || cell === undefined;
        case "not-is-null":
          return cell !== null && cell !== undefined;
        case "ilike":
          return (
            typeof cell === "string" && ilikePatternToRegExp(f.pattern).test(cell)
          );
        default:
          return true;
      }
    });
  }

  private applyOrder(rows: Row[]): Row[] {
    if (this.orders.length === 0) {
      return rows;
    }
    const sorted = [...rows];
    sorted.sort((a, b) => {
      for (const o of this.orders) {
        const av = a[o.column] as string | number | null;
        const bv = b[o.column] as string | number | null;
        if (av === bv) continue;
        if (av === null || av === undefined) return o.ascending ? -1 : 1;
        if (bv === null || bv === undefined) return o.ascending ? 1 : -1;
        const cmp = av < bv ? -1 : 1;
        return o.ascending ? cmp : -cmp;
      }
      return 0;
    });
    return sorted;
  }

  private execute(): Result<unknown> {
    const rows = this.store.table(this.tableName);

    if (this.mutation.kind === "insert") {
      const inserted = this.mutation.rows.map((r) => {
        const row = this.store.materialize(r);
        rows.push(row);
        return row;
      });
      return this.shapeResult(inserted);
    }

    if (this.mutation.kind === "update") {
      const changes = this.mutation.changes;
      const affected: Row[] = [];
      for (const row of rows) {
        if (this.matches(row)) {
          Object.assign(row, changes, {
            updated_at: new Date().toISOString(),
          });
          affected.push(row);
        }
      }
      return this.shapeResult(affected);
    }

    if (this.mutation.kind === "delete") {
      const kept: Row[] = [];
      const removed: Row[] = [];
      for (const row of rows) {
        if (this.matches(row)) {
          removed.push(row);
        } else {
          kept.push(row);
        }
      }
      this.store.tables.set(this.tableName, kept);
      return this.shapeResult(removed);
    }

    // select
    let result = rows.filter((r) => this.matches(r));
    result = this.applyOrder(result);
    // Exact count = filtered rows BEFORE pagination, matching PostgREST.
    this.filteredCount = result.length;
    if (this.rangeBounds !== null) {
      result = result.slice(this.rangeBounds.from, this.rangeBounds.to + 1);
    }
    if (this.limitCount !== null) {
      result = result.slice(0, this.limitCount);
    }
    return this.shapeResult(result.map((r) => ({ ...r })));
  }

  private shapeResult(rows: Row[]): Result<unknown> {
    const count = this.countMode === "exact" ? this.filteredCount : null;
    if (this.shape === "single") {
      const first = rows[0];
      if (first === undefined) {
        return { data: null, error: { message: "no rows returned" }, count };
      }
      return { data: first, error: null, count };
    }
    if (this.shape === "maybe") {
      return { data: rows[0] ?? null, error: null, count };
    }
    if (!this.returnsRows && this.mutation.kind !== "select") {
      // A mutation without .select() returns no data (e.g. update/delete).
      return { data: null, error: null, count };
    }
    return { data: rows, error: null, count };
  }

  then<TResult1 = Result<T>, TResult2 = never>(
    onfulfilled?:
      | ((value: Result<T>) => TResult1 | PromiseLike<TResult1>)
      | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    try {
      const result = this.execute() as Result<T>;
      return Promise.resolve(result).then(onfulfilled, onrejected);
    } catch (error) {
      return Promise.reject(error).then(onfulfilled, onrejected) as never;
    }
  }
}

/**
 * JS stand-in for the `create_installment_purchase` plpgsql function
 * (supabase/migrations/0002_create_installment_purchase.sql). The REAL atomicity
 * guarantee is proven separately against Docker Postgres by the verifier; here we
 * only reproduce the happy-path DATA SHAPE so the repository's `.rpc()` call path
 * persists and returns rows exactly as the SQL function would: insert the group,
 * then every parcel linked to the inserted group's id, and return
 * `{ group, installments }`. Inserts go through `store.materialize`, so later
 * reads over the fake (getCardPressure, findUpcomingInstallments) see the rows.
 */
function createInstallmentPurchaseRpc(
  store: FakeSupabaseStore,
  args: { group_payload: Row; installments_payload: Row[] },
): Result<{ group: Row; installments: Row[] }> {
  const group = store.materialize({ ...args.group_payload });
  store.table("installment_groups").push(group);

  const installments = args.installments_payload.map((parcel) => {
    const row = store.materialize({
      ...parcel,
      // The SQL function fills installment_group_id + household_id from the
      // freshly inserted group; mirror that here.
      household_id: group.household_id,
      installment_group_id: group.id,
    });
    store.table("installments").push(row);
    return row;
  });

  return { data: { group, installments }, error: null };
}

/**
 * JS stand-in for the `confirm_import` plpgsql function
 * (supabase/migrations/0004_confirm_import.sql). The REAL atomicity guarantee and
 * the import_rows audit trail are proven separately against Docker Postgres by the
 * verifier; here we only reproduce the happy-path DATA EFFECT so the repository's
 * `.rpc()` call path persists rows exactly as the SQL function would: insert the
 * import_batch, then walk the rows IN ORDER — for each row that carries a
 * `transaction`, insert it linked to the batch (import_batch_id) and count it; for
 * every row, insert an import_rows audit record linked to the batch and to the
 * produced transaction id (null for audit-only rows). Inserts go through
 * `store.materialize`, so later reads over the fake (getMonthlySummary,
 * findRecentTransactions, ...) see the imported transactions. Returns the same
 * `{ batch, imported_rows }` summary the SQL function returns.
 */
function confirmImportRpc(
  store: FakeSupabaseStore,
  args: { batch_payload: Row; rows_payload: Row[] },
): Result<{ batch: Row; imported_rows: number }> {
  const batch = store.materialize({ ...args.batch_payload });
  store.table("import_batches").push(batch);

  let importedRows = 0;
  for (const entry of args.rows_payload) {
    const txPayload = entry.transaction as Row | null | undefined;
    let transactionId: string | null = null;

    if (txPayload != null) {
      // The SQL function fills import_batch_id from the freshly inserted batch.
      const tx = store.materialize({
        ...txPayload,
        import_batch_id: batch.id,
      });
      store.table("transactions").push(tx);
      transactionId = tx.id as string;
      importedRows += 1;
    }

    const auditRow = store.materialize({
      household_id: batch.household_id,
      import_batch_id: batch.id,
      source_line: entry.source_line ?? null,
      occurred_on: entry.occurred_on ?? null,
      amount_cents: entry.amount_cents ?? null,
      description: entry.description ?? null,
      error_message: entry.error_message ?? null,
      is_duplicate: entry.is_duplicate ?? false,
      transaction_id: transactionId,
    });
    store.table("import_rows").push(auditRow);
  }

  return { data: { batch, imported_rows: importedRows }, error: null };
}

/**
 * JS stand-in for the `merge_category` plpgsql function
 * (supabase/migrations/0003_merge_category.sql). The REAL atomicity guarantee is
 * proven separately against Docker Postgres by the verifier; here we only
 * reproduce the happy-path DATA EFFECT so the repository's `.rpc()` call path
 * mutates the store exactly as the SQL function would: re-point every row that
 * referenced the source category onto the target across the five household-scoped
 * tables, then archive the source category (is_active = false). Returns the same
 * `{ source, moved }` summary shape so callers can assert the merge happened.
 */
function mergeCategoryRpc(
  store: FakeSupabaseStore,
  args: {
    target_household_id: string;
    source_category_id: string;
    target_category_id: string;
  },
): Result<Row> {
  const { target_household_id, source_category_id, target_category_id } = args;

  // Re-point a household-scoped table's source rows onto the target; return the
  // count moved, matching the SQL function's `get diagnostics ... row_count`.
  const repoint = (table: string): number => {
    let moved = 0;
    for (const row of store.table(table)) {
      if (
        row.household_id === target_household_id &&
        row.category_id === source_category_id
      ) {
        row.category_id = target_category_id;
        moved += 1;
      }
    }
    return moved;
  };

  const moved = {
    transactions: repoint("transactions"),
    installment_groups: repoint("installment_groups"),
    installments: repoint("installments"),
    subcategories: repoint("subcategories"),
    categorization_memory: repoint("categorization_memory"),
  };

  // Archive the now-empty source category and return its updated row.
  let source: Row | null = null;
  for (const row of store.table("categories")) {
    if (
      row.household_id === target_household_id &&
      row.id === source_category_id
    ) {
      row.is_active = false;
      source = row;
    }
  }

  return { data: { source, moved }, error: null };
}

/**
 * Build a fake Supabase client. The returned object is structurally compatible
 * with the `AppSupabaseClient` surface the repositories use (`.from(table)...`
 * and `.rpc(name, args)`). We deliberately cast at the call site in the test to
 * keep this fake free of the full generated Supabase generic types.
 */
export function createFakeSupabaseClient(store: FakeSupabaseStore): {
  from(table: string): QueryBuilder<unknown>;
  rpc(name: string, args: Record<string, unknown>): Promise<Result<unknown>>;
} {
  return {
    from(table: string): QueryBuilder<unknown> {
      return new QueryBuilder(store, table);
    },
    rpc(name: string, args: Record<string, unknown>): Promise<Result<unknown>> {
      if (name === "create_installment_purchase") {
        return Promise.resolve(
          createInstallmentPurchaseRpc(
            store,
            args as {
              group_payload: Row;
              installments_payload: Row[];
            },
          ),
        );
      }
      if (name === "confirm_import") {
        return Promise.resolve(
          confirmImportRpc(
            store,
            args as {
              batch_payload: Row;
              rows_payload: Row[];
            },
          ),
        );
      }
      if (name === "merge_category") {
        return Promise.resolve(
          mergeCategoryRpc(
            store,
            args as {
              target_household_id: string;
              source_category_id: string;
              target_category_id: string;
            },
          ),
        );
      }
      throw new Error(`fake-supabase: unsupported .rpc(${name})`);
    },
  };
}
