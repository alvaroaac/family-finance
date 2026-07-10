import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(
    process.cwd(),
    "../../supabase/migrations/0016_import_reliability.sql",
  ),
  "utf8",
);

describe("import reliability migration contract", () => {
  it("has independent request replay and source-item uniqueness barriers", () => {
    expect(migration).toContain("unique (household_id, request_key)");
    expect(migration).toContain("import_item_claims_identity_uniq");
    expect(migration).toContain(
      "on conflict (household_id, request_key) do nothing",
    );
    expect(migration).toContain("on conflict do nothing");
    expect(migration).toContain("request key reused with different payload");
  });

  it("persists flat and installment artifacts inside the same RPC body", () => {
    expect(migration).toContain("create or replace function confirm_import_v2");
    expect(migration).toContain("insert into transactions");
    expect(migration).toContain("insert into installment_groups");
    expect(migration).toContain("insert into installments");
    expect(migration).toContain("installments do not match group total/count");
  });

  it("derives counts and duplicate_existing in the database", () => {
    expect(migration).toContain("item_disposition := 'duplicate_existing'");
    expect(migration).toContain("duplicate_existing is server-derived");
    expect(migration).toMatch(
      /total_rows = imported_count \+ duplicate_count \+ error_count \+ excluded_count/,
    );
    expect(migration).toContain("duplicate_rows = duplicate_count");
  });

  it("keeps claim writes behind RLS and an authenticated-only RPC", () => {
    expect(migration).toContain(
      "alter table import_item_claims enable row level security",
    );
    expect(migration).toContain(
      "for select using (is_household_member(household_id))",
    );
    expect(migration).toContain(
      "revoke all on function confirm_import_v2(jsonb, jsonb) from anon",
    );
    expect(migration).toContain(
      "grant execute on function confirm_import_v2(jsonb, jsonb) to authenticated",
    );
  });

  it("persists explicit direction-scoped learning in the confirmation transaction", () => {
    expect(migration).toContain(
      "create table if not exists source_category_mappings",
    );
    expect(migration).toContain(
      "unique (household_id, source, normalized_label, row_kind)",
    );
    expect(migration).toContain(
      "add column if not exists row_kind transaction_kind",
    );
    expect(migration).toContain("add column if not exists suppress boolean");
    expect(migration).toContain("item -> 'learning'");
    expect(migration).toContain("insert into categorization_memory");
  });

  it("requires an auditable reason for explicit duplicate overrides", () => {
    expect(migration).toContain(
      "add column if not exists override_reason text",
    );
    expect(migration).toContain(
      "override token, claim, and reason must be supplied together",
    );
    expect(migration).toContain("import_rows_override_reason_shape");
  });

  it("persists normalized identity and bounds paid fallback per preview/day", () => {
    expect(migration).toContain("normalized_fingerprint");
    expect(migration).toContain("create table if not exists import_ai_usage");
    expect(migration).toContain(
      "create table if not exists import_ai_daily_usage",
    );
    expect(migration).toContain("reserve_import_ai_paid_items");
  });

  it("rejects irreconcilable learning commands", () => {
    expect(migration).toContain(
      "confirm_import_v2: conflicting learning commands",
    );
  });
});
