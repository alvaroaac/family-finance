import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(
    process.cwd(),
    "../../supabase/migrations/0018_obligation_payment_account_override.sql",
  ),
  "utf8",
);

describe("obligation payment account override migration", () => {
  it("uses an explicit account while preserving the template default", () => {
    expect(migration).toContain("target_account_id uuid");
    expect(migration).toContain(
      "effective_account_id := coalesce(\n    target_account_id,\n    obligation.account_id",
    );
    expect(migration).toContain("household_id = obligation.household_id");
  });

  it("keeps the four-argument RPC as a default-account compatibility wrapper", () => {
    expect(migration).toContain(
      "materialize_obligation_payment(uuid, text, date, bigint, uuid)",
    );
    expect(migration).toContain("target_amount_cents,\n    null");
    expect(migration).toContain("from anon");
  });
});
