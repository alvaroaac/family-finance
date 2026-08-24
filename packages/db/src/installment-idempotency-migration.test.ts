import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(
    process.cwd(),
    "../../supabase/migrations/0019_installment_purchase_idempotency.sql",
  ),
  "utf8",
);

describe("installment purchase idempotency migration", () => {
  it("claims one caller key per household and replays the existing group", () => {
    expect(migration).toContain(
      "on installment_groups (household_id, idempotency_key)",
    );
    expect(migration).toContain("on conflict (household_id, idempotency_key)");
    expect(migration).toContain(
      "idempotency key reused with different payload",
    );
    expect(migration).toContain(
      "idempotency key reused with different installments payload",
    );
    expect(migration).toContain(
      "where existing.installment_group_id = inserted_group.id",
    );
  });

  it("keeps the RPC authenticated-only and household-scoped", () => {
    expect(migration).toContain(
      "coalesce(auth.role(), '') <> 'service_role'",
    );
    expect(migration).toContain("not is_household_member(target_household_id)");
    expect(migration).toContain(
      "revoke all on function create_installment_purchase(jsonb, jsonb) from anon",
    );
    expect(migration).toContain("to authenticated, service_role");
  });
});
