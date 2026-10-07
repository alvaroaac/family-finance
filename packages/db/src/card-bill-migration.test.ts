import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(
  resolve(
    process.cwd(),
    "../../supabase/migrations/202610070000_card_bill_closing_and_payments.sql",
  ),
  "utf8",
);

describe("card bill closing and payments migration", () => {
  it("removes the legacy settlement overload and one-payment limit", () => {
    expect(migration).toContain(
      "drop function if exists settle_card_bill(uuid, uuid, uuid, text, bigint, date, uuid)",
    );
    expect(migration).toContain(
      "drop index if exists transactions_card_bill_month_uniq",
    );
    expect(migration).toContain("target_idempotency_key text");
  });

  it("claims household-scoped keys and rejects mismatched replays", () => {
    expect(migration).toContain(
      "create unique index if not exists transactions_idempotency_key_uniq",
    );
    expect(migration).toContain(
      "on transactions (household_id, idempotency_key)",
    );
    expect(migration).toContain("where idempotency_key is not null");
    expect(migration).toContain("on conflict (household_id, idempotency_key)");
    expect(migration).toContain(
      "idempotency key reused with a different payment",
    );
    expect(migration).toContain("'replayed', true");
    expect(migration).toContain("'replayed', false");
  });

  it("uses the 0019 gate and locks execution grants", () => {
    expect(migration).toContain("coalesce(auth.role(), '') <> 'service_role'");
    expect(migration).toContain("not is_household_member(target_household_id)");
    const signature =
      "settle_card_bill(uuid, uuid, uuid, text, bigint, date, uuid, text)";
    expect(migration).toContain(
      `revoke all on function ${signature} from public`,
    );
    expect(migration).toContain(
      `revoke all on function ${signature} from anon`,
    );
    expect(migration).toContain("to authenticated, service_role");
  });

  it("stores attribution and household-scoped closure overrides", () => {
    expect(migration).toContain(
      "create table if not exists card_bill_closures",
    );
    expect(migration).toContain(
      "references credit_cards (household_id, id) on delete restrict",
    );
    expect(migration).toContain(
      "check (state = 'closed' or total_override_cents is null)",
    );
    expect(migration).toContain(
      "alter table card_bill_closures enable row level security",
    );
    expect(migration).toContain("before insert or update on transactions");
    expect(migration).toContain("old.invoice_month");
    expect(migration).toContain("new.import_batch_id is null");
    expect(migration).toContain(
      "(now() at time zone 'America/Sao_Paulo')::date",
    );
  });

  it("leaves installment and import RPCs unchanged", () => {
    expect(migration).not.toMatch(
      /create\s+or\s+replace\s+function\s+create_installment_purchase/i,
    );
    expect(migration).not.toMatch(
      /create\s+or\s+replace\s+function\s+confirm_import/i,
    );
  });
});
