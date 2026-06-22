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
 *     .select(cols) | .insert(payload) | .update(changes) | .delete()
 *     .eq / .neq / .gte / .lte / .is / .not(col, "is", null)
 *     .order(col, { ascending }) | .limit(n)
 *     .single() | .maybeSingle()
 * A query builder is a PromiseLike resolving to `{ data, error }`, matching the
 * Supabase contract the repositories destructure.
 *
 * This is a TEST fake. It does NOT enforce RLS (the real schema does); the test
 * always passes the correct household_id, so household scoping is still
 * exercised through the repositories' explicit `.eq("household_id", ...)`.
 */

type Row = Record<string, unknown>;

type Result<T> = { data: T; error: { message: string } | null };

type Filter =
  | { op: "eq"; column: string; value: unknown }
  | { op: "neq"; column: string; value: unknown }
  | { op: "gte"; column: string; value: unknown }
  | { op: "lte"; column: string; value: unknown }
  | { op: "is"; column: string; value: null }
  | { op: "not-is-null"; column: string };

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
  private mutation: Mutation = { kind: "select" };
  private returnsRows = false;
  private shape: "many" | "single" | "maybe" = "many";

  constructor(
    private readonly store: FakeSupabaseStore,
    private readonly tableName: string,
  ) {}

  select(_columns?: string): this {
    // After insert/update the caller chains .select() to get the rows back.
    this.returnsRows = true;
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
    if (this.limitCount !== null) {
      result = result.slice(0, this.limitCount);
    }
    return this.shapeResult(result.map((r) => ({ ...r })));
  }

  private shapeResult(rows: Row[]): Result<unknown> {
    if (this.shape === "single") {
      const first = rows[0];
      if (first === undefined) {
        return { data: null, error: { message: "no rows returned" } };
      }
      return { data: first, error: null };
    }
    if (this.shape === "maybe") {
      return { data: rows[0] ?? null, error: null };
    }
    if (!this.returnsRows && this.mutation.kind !== "select") {
      // A mutation without .select() returns no data (e.g. update/delete).
      return { data: null, error: null };
    }
    return { data: rows, error: null };
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
 * Build a fake Supabase client. The returned object is structurally compatible
 * with the `AppSupabaseClient` surface the repositories use (`.from(table)...`).
 * We deliberately cast at the call site in the test to keep this fake free of
 * the full generated Supabase generic types.
 */
export function createFakeSupabaseClient(store: FakeSupabaseStore): {
  from(table: string): QueryBuilder<unknown>;
} {
  return {
    from(table: string): QueryBuilder<unknown> {
      return new QueryBuilder(store, table);
    },
  };
}
