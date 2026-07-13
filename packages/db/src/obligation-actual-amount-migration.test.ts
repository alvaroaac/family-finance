import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(
    process.cwd(),
    "../../supabase/migrations/0017_obligation_actual_amount.sql",
  ),
  "utf8",
);

describe("obligation actual amount migration", () => {
  it("keeps the forecast as fallback and validates an actual override", () => {
    expect(migration).toContain("target_amount_cents bigint");
    expect(migration).toContain(
      "effective_amount_cents := coalesce(\n    target_amount_cents,\n    obligation.amount_cents",
    );
    expect(migration).toContain("actual amount must be positive");
  });

  it("preserves monthly idempotency and locks down the overload", () => {
    expect(migration).toContain(
      "on conflict (obligation_id, obligation_month)",
    );
    expect(migration).toContain(
      "materialize_obligation_payment(uuid, text, date, bigint)",
    );
    expect(migration).toContain("from anon");
  });
});
