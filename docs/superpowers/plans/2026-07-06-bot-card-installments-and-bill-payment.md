# Bot card installments + card-bill payment (PR-2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The bot persists "notebook 3600 em 12x no nubank" as a real installment plan and settles "nubank pago" as a single two-instrument `transfer` row with `bill_month`, replacing both "em breve" dead ends.

**Architecture:** Migration 0015 adds `bill_month` + a narrowed instrument CHECK + a `settle_card_bill` RPC (0011 gate + ON CONFLICT idempotency) and re-gates `create_installment_purchase` for the bot's null-uid service-role client. The bot gains two conversation flows mirroring the obligation flow (`awaiting_installment_confirmation`, `awaiting_card_bill_confirmation`), a `cd:<uuid>` card-picker grid, and new `ConversationDeps` wired in `buildDeps`. Web gets read-side only: a transfer-row payment guard and a "paga ✅" marker on /resumo.

**Tech Stack:** TypeScript strict ESM monorepo (pnpm), Supabase (Postgres + plpgsql SECURITY DEFINER RPCs), zod, vitest. Bot is dependency-light `node:http` — no framework.

**Spec:** `docs/superpowers/specs/2026-07-06-bot-card-installments-and-bill-payment-design.md` (approved).

## Global Constraints

- **pt-BR for ALL user-facing bot copy.** No new npm deps in `apps/bot`.
- **Migrations applied with `supabase migration up` ONLY — NEVER `supabase db reset`** (live walkthrough data on the local stack).
- **Typed/tapped parity:** every button token funnels into the same transition function as its typed command (buttons design rule).
- **Callback data ≤ 64 bytes, ids only** — never user-typed names (`keyboards.ts` convention, tested).
- **Save-before-send:** conversation state is persisted via `store.save` BEFORE any Telegram network call that could throw (`index.ts` pattern; regression `86e9e6a`).
- **`thoughts/` and `memory/` are never staged in commits.**
- **Branch:** create `feat/bot-card-bills` off `feat/bot-inline-buttons` @ `b177bbc` before Task 1. Do not push `feat/family-finance-mvp`; do not touch PR #6.
- Bill payment settles the **current calendar month** (`today.slice(0, 7)`), mirroring `mark_paid{obligation}`. No month override via bot.
- The bot never invents amounts: computed bill default is shown in the confirmation and requires explicit confirm.
- Each task ends green: `pnpm typecheck` + the touched package's tests, then commit.

## File Structure

| File | Change |
|---|---|
| `supabase/migrations/0015_card_bill_payments.sql` | Create — column, CHECKs, index, `settle_card_bill`, re-gate `create_installment_purchase`, grants |
| `deploy/checks/rls-proof.mjs` | Modify — new check functions + anon RPC list |
| `packages/domain/src/transactions.ts` | Modify — `createCardBillSettlement` + types |
| `packages/domain/src/transactions.test.ts` | Modify — validation matrix |
| `packages/db/src/types.ts` | Modify — `TransactionRow.bill_month`, `settle_card_bill` in `Functions`, `SettleCardBillResult` |
| `packages/db/src/repositories.ts` | Modify — `settleCardBill`, `findCardBillSettlements`, transfer guard in `updateTransaction` |
| `packages/db/src/repositories.test.ts` | Modify — new repo tests |
| `apps/web/integration/fake-supabase.ts` | Modify — `settle_card_bill` rpc branch; `credit_cards` fixtures as needed |
| `apps/bot/src/interpret.ts` | Modify — `card_installment` payload, `mark_paid` amount, prompt |
| `apps/bot/src/interpret.test.ts` | Modify — extraction tests |
| `apps/bot/src/keyboards.ts` | Modify — `CARD_TOKEN_PREFIX` + `cardGridKeyboard` |
| `apps/bot/src/keyboards.test.ts` | Modify — grid shape + 64-byte tests |
| `apps/bot/src/conversation.ts` | Modify — both flows, statuses, callback branches |
| `apps/bot/src/replies.ts` | Modify — new message builders |
| `apps/bot/src/conversation-installments.test.ts` | Create — installment flow tests |
| `apps/bot/src/conversation-card-bill.test.ts` | Create — bill flow tests |
| `apps/bot/src/conversation-obligations.test.ts` | Modify — delete the two "em breve" deferred-path tests |
| `apps/bot/src/index.ts` | Modify — `buildDeps` wiring |
| `apps/bot/src/bot.test.ts` | Modify — end-to-end webhook flow (Task 8) |
| `apps/web/app/(app)/transactions/transactions-table.tsx` | Modify — transfer rows lose the payment select |
| `apps/web/app/(app)/resumo/queries.ts` + `page.tsx` | Modify — settled marker |

---

### Task 1: Migration 0015 + RLS proof

**Files:**
- Create: `supabase/migrations/0015_card_bill_payments.sql`
- Modify: `deploy/checks/rls-proof.mjs`

**Interfaces:**
- Consumes: 0001 `transactions` table (unnamed instrument CHECK), 0002 `create_installment_purchase(jsonb, jsonb)`, 0011 gate pattern + `materialize_obligation_payment` ON CONFLICT idempotency, 0012 grant loop.
- Produces: `settle_card_bill(target_household_id uuid, target_credit_card_id uuid, target_account_id uuid, target_bill_month text, target_amount_cents bigint, target_paid_on date, target_created_by_user_id uuid) returns jsonb` → `{"transaction": <transactions row>, "already_paid": boolean}`; `transactions.bill_month text` column; re-gated `create_installment_purchase` callable with `auth.uid()` null.

- [ ] **Step 0: Create the working branch**

```bash
cd /Users/alvarocarvalho/desenv/personal/alvaro-e-karol/family-finance
git checkout -b feat/bot-card-bills   # from feat/bot-inline-buttons @ b177bbc
```

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/0015_card_bill_payments.sql`:

```sql
-- 0015_card_bill_payments.sql
-- PR-2: card-bill payment = ONE kind='transfer' row carrying BOTH instruments
-- (account = source, credit card = destination) + bill_month as the settled
-- marker. Also re-gates create_installment_purchase (0002) to the 0011 gate
-- pattern so the bot's null-uid service-role client can persist installments
-- (0012 granted service_role EXECUTE, but 0002's body gate rejects null uid).
-- Every statement is guarded so the migration is re-runnable.

-- --- transactions.bill_month ------------------------------------------------
do $$ begin
  alter table transactions add column bill_month text;
exception when duplicate_column then null; end $$;

do $$ begin
  alter table transactions add constraint transactions_bill_month_format_check
    check (bill_month is null or bill_month ~ '^[0-9]{4}-(0[1-9]|1[0-2])$');
exception when duplicate_object then null; end $$;

-- bill_month only makes sense on the settle transfer row.
do $$ begin
  alter table transactions add constraint transactions_bill_month_kind_check
    check (bill_month is null or kind = 'transfer');
exception when duplicate_object then null; end $$;

-- --- Narrowed instrument check ----------------------------------------------
-- 0001's exactly-one-instrument CHECK was declared inline and unnamed, so we
-- locate it by definition (the only CHECK mentioning both instrument columns)
-- and drop it before adding the named, narrowed replacement.
do $$
declare cname text;
begin
  select c.conname into cname
  from pg_constraint c
  where c.conrelid = 'transactions'::regclass
    and c.contype = 'c'
    and pg_get_constraintdef(c.oid) like '%account_id%'
    and pg_get_constraintdef(c.oid) like '%credit_card_id%'
    and pg_get_constraintdef(c.oid) not like '%bill_month%';
  if cname is not null then
    execute format('alter table transactions drop constraint %I', cname);
  end if;
end $$;

-- expense/income → exactly one instrument (as before).
-- transfer + bill_month → BOTH (a card-bill payment).
-- transfer without bill_month (caixinha) → exactly one, as before.
do $$ begin
  alter table transactions add constraint transactions_payment_instrument_check
    check (
      case
        when kind = 'transfer' and bill_month is not null
          then account_id is not null and credit_card_id is not null
        else
          (account_id is not null and credit_card_id is null)
          or (account_id is null and credit_card_id is not null)
      end
    );
exception when duplicate_object then null; end $$;

-- A card's bill is settled at most once per month (idempotency backbone of
-- settle_card_bill, mirroring transactions_obligation_month_uniq).
create unique index if not exists transactions_card_bill_month_uniq
  on transactions (credit_card_id, bill_month)
  where kind = 'transfer' and bill_month is not null;

-- --- settle_card_bill ---------------------------------------------------------
create or replace function settle_card_bill(
  target_household_id uuid,
  target_credit_card_id uuid,
  target_account_id uuid,
  target_bill_month text,
  target_amount_cents bigint,
  target_paid_on date,
  target_created_by_user_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  card credit_cards;
  member_ok boolean;
  month_start date;
  inserted transactions;
  existing transactions;
  already_paid boolean := false;
begin
  if target_bill_month is null
     or target_bill_month !~ '^\d{4}-(0[1-9]|1[0-2])$' then
    raise exception 'settle_card_bill: invalid month %', target_bill_month
      using errcode = '22023';
  end if;
  if target_amount_cents is null or target_amount_cents <= 0 then
    raise exception 'settle_card_bill: invalid amount'
      using errcode = '22023';
  end if;

  select * into card
  from credit_cards
  where id = target_credit_card_id
    and household_id = target_household_id;

  -- 0011 gate: SECURITY DEFINER skips RLS, so re-assert membership. The bot's
  -- service-role client has auth.uid() null and passes; an authenticated
  -- non-member gets the SAME 'not found' as a nonexistent id (no probing).
  if card.id is null
     or (auth.uid() is not null
         and not is_household_member(target_household_id)) then
    raise exception 'settle_card_bill: card % not found', target_credit_card_id
      using errcode = '22023';
  end if;

  -- The bot path cannot derive the creator from auth.uid(); the claimed
  -- created_by must be an active member of the target household.
  select exists (
    select 1 from household_members
    where household_id = target_household_id
      and user_id = target_created_by_user_id
      and is_active
  ) into member_ok;
  if not member_ok then
    raise exception 'settle_card_bill: created_by is not an active member'
      using errcode = '22023';
  end if;

  month_start := to_date(target_bill_month || '-01', 'YYYY-MM-DD');

  -- The composite household FKs (0013) enforce that both instruments belong
  -- to target_household_id. The account is validated there, not re-queried.
  insert into transactions (
    household_id, kind, amount_cents, occurred_on, description,
    account_id, credit_card_id,
    responsibility_scope, responsible_user_id, created_by_user_id, bill_month
  )
  values (
    target_household_id, 'transfer', target_amount_cents,
    coalesce(target_paid_on, current_date),
    'Fatura ' || card.name || ' — ' || to_char(month_start, 'MM/YYYY'),
    target_account_id, target_credit_card_id,
    'household', null,
    coalesce(auth.uid(), target_created_by_user_id),
    target_bill_month
  )
  on conflict (credit_card_id, bill_month)
    where kind = 'transfer' and bill_month is not null
    do nothing
  returning * into inserted;

  if inserted.id is null then
    -- Unique index hit: this card+month is already settled. Idempotent no-op.
    already_paid := true;
    select * into existing
    from transactions
    where credit_card_id = target_credit_card_id
      and bill_month = target_bill_month
      and kind = 'transfer';
    return jsonb_build_object(
      'transaction', to_jsonb(existing),
      'already_paid', already_paid
    );
  end if;

  return jsonb_build_object(
    'transaction', to_jsonb(inserted),
    'already_paid', already_paid
  );
end;
$$;

-- Full 0012 hardening in the same migration (Supabase default privileges
-- auto-grant EXECUTE to anon on new functions).
revoke all on function settle_card_bill(uuid, uuid, uuid, text, bigint, date, uuid) from public;
do $$ begin
  revoke all on function settle_card_bill(uuid, uuid, uuid, text, bigint, date, uuid) from anon;
exception when undefined_object then null; end $$;
do $$ begin
  grant execute on function settle_card_bill(uuid, uuid, uuid, text, bigint, date, uuid)
    to authenticated;
exception when undefined_object then null; end $$;
do $$ begin
  grant execute on function settle_card_bill(uuid, uuid, uuid, text, bigint, date, uuid)
    to service_role;
exception when undefined_object then null; end $$;

-- --- Re-gate create_installment_purchase (2a) --------------------------------
-- Copy the FULL body from 0002_create_installment_purchase.sql verbatim and
-- change ONLY the membership gate to the 0011 pattern below (plus its comment).
-- Safe post-0012: anon/public EXECUTE is revoked, so the only null-uid caller
-- that can reach the body is service_role — exactly the bot. The web
-- (authenticated) path is unchanged.
--
--   if target_household_id is null
--      or (auth.uid() is not null
--          and not is_household_member(target_household_id)) then
--     raise exception 'create_installment_purchase: not a member of household %',
--       target_household_id
--       using errcode = '42501';
--   end if;
--
-- (create or replace function create_installment_purchase(...) ... — full body here)
```

The final block is written out in full by copying `supabase/migrations/0002_create_installment_purchase.sql:28-165` and replacing the gate `if target_household_id is null or not is_household_member(target_household_id) then` with the 0011 pattern shown in the comment. Do NOT repeat 0002's trailing revoke/grant block — 0012 already governs its grants.

- [ ] **Step 2: Apply to the local stack**

```bash
supabase migration up
```
Expected: `Applying migration 0015_card_bill_payments.sql...` with no error. If the stack is down, `supabase start` first (never `db reset`).

- [ ] **Step 3: Extend `deploy/checks/rls-proof.mjs`**

Three additions (follow the file's `record(name, ok, detail)` idiom):

1. In `checkAnonCannotExecuteRpcs`, add to the `rpcs` array: `settle_card_bill` (args object with the seven `target_*` keys, any placeholder uuids/values) — anon must get a permission error, mirroring the existing four entries.

2. New `checkCardBillSettlement(member, householdId)` called from `main()` after `checkObligationMaterialization`:

```js
async function checkCardBillSettlement(member, householdId) {
  // (g1) member settles the bill for the fixture card+account.
  const first = await member.rpc("settle_card_bill", {
    target_household_id: householdId,
    target_credit_card_id: created.cardId,
    target_account_id: created.accountId,
    target_bill_month: "2026-04",
    target_amount_cents: 123456,
    target_paid_on: "2026-04-10",
    target_created_by_user_id: created.memberUserId,
  });
  record(
    "(g1) member settles a card bill (already_paid=false)",
    !first.error && first.data && first.data.already_paid === false,
    first.error ? first.error.message : `already_paid=${first.data?.already_paid}`,
  );
  record(
    "(g1b) settle row carries BOTH instruments + bill_month",
    !first.error &&
      first.data?.transaction?.account_id === created.accountId &&
      first.data?.transaction?.credit_card_id === created.cardId &&
      first.data?.transaction?.bill_month === "2026-04" &&
      first.data?.transaction?.kind === "transfer",
  );

  // (g2) repeat is idempotent.
  const repeat = await member.rpc("settle_card_bill", { /* same args */ });
  record(
    "(g2) repeat settle is idempotent (already_paid=true)",
    !repeat.error && repeat.data && repeat.data.already_paid === true,
    repeat.error ? repeat.error.message : `already_paid=${repeat.data?.already_paid}`,
  );

  // (g3) service-role (auth.uid() null — the bot path) settles another month.
  const svc = await admin.rpc("settle_card_bill", {
    /* same args but target_bill_month: "2026-05" */
  });
  record(
    "(g3) service-role null-uid path settles (bot)",
    !svc.error && svc.data && svc.data.already_paid === false,
    svc.error ? svc.error.message : "",
  );

  // (g4) outsider gets 'not found' (0011-style probe resistance).
  const outsider = await signIn(OUTSIDER_EMAIL, OUTSIDER_PASSWORD); // reuse the file's outsider client if already built
  const foreign = await outsider.rpc("settle_card_bill", { /* same args, month 2026-06 */ });
  record("(g4) outsider settle rejected as not-found", Boolean(foreign.error));

  // (g5) constraint matrix via admin direct inserts (each must FAIL/PASS):
  //   expense with both instruments → CHECK violation
  //   transfer with bill_month + only account_id → CHECK violation
  //   plain transfer (bill_month null) with only account_id → accepted
  // Insert minimal rows with created.accountId/created.cardId; assert
  // Boolean(error) / !error respectively; delete the accepted row after.

  // (g6) service-role null-uid create_installment_purchase now passes the
  // re-gated body: admin.rpc("create_installment_purchase", { group_payload,
  // installments_payload }) with a minimal 1-parcel payload for the fixture
  // card; assert !error; then delete the created group (cascade removes parcels).

  // Cleanup: delete the settle transfers.
  await admin.from("transactions").delete().not("bill_month", "is", null);
}
```

The g5/g6 comments are implemented as real inserts/asserts — payload fields exactly match `InstallmentGroupInsertPayload`/`InstallmentInsertPayload` (see `packages/db/src/types.ts:348-377`) with `created.memberUserId` as creator and `due_month: "2026-04"`. If the fixture set (`created`) has no credit card, add one in `setup()` mirroring how `created.accountId` is made, and delete it in teardown.

- [ ] **Step 4: Run the proof**

```bash
node deploy/checks/rls-proof.mjs
```
Expected: all checks PASS (prior count + the new g-series), exit 0.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0015_card_bill_payments.sql deploy/checks/rls-proof.mjs
git commit -m "feat(db): card-bill settle RPC, bill_month, narrowed instrument check (0015)"
```

---

### Task 2: Domain — `createCardBillSettlement`

**Files:**
- Modify: `packages/domain/src/transactions.ts`, `packages/domain/src/index.ts` (export)
- Test: `packages/domain/src/transactions.test.ts`

**Interfaces:**
- Consumes: existing `ValidationError`/`DomainResult` shapes (`packages/domain/src/transactions.ts:71-84`), `zod`.
- Produces: `CardBillSettlementInput`, `CardBillSettlementDraft`, `createCardBillSettlement(input: CardBillSettlementInput): DomainResult<CardBillSettlementDraft>` — consumed by `settleCardBill` (Task 3) and the bot confirm path (Task 6).

**Documented deviation from the spec:** the spec's validation list includes "description non-empty", but its RPC arg list has no description — the RPC derives `Fatura <card> — MM/YYYY` from the card row. The draft therefore has NO description field; the RPC is the single source of the description.

- [ ] **Step 1: Write the failing tests**

Append to `packages/domain/src/transactions.test.ts`:

```ts
describe("createCardBillSettlement", () => {
  const valid = {
    householdId: "house-1",
    creditCardId: "card-1",
    accountId: "acct-1",
    billMonth: "2026-07",
    amountCents: 235000,
    paidOn: "2026-07-06",
    createdByUserId: "user-1",
  };

  it("accepts a valid settlement", () => {
    const result = createCardBillSettlement(valid);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toEqual(valid);
  });

  it.each([
    ["amountCents", { ...valid, amountCents: 0 }],
    ["amountCents", { ...valid, amountCents: -100 }],
    ["billMonth", { ...valid, billMonth: "2026-13" }],
    ["billMonth", { ...valid, billMonth: "07/2026" }],
    ["creditCardId", { ...valid, creditCardId: "" }],
    ["accountId", { ...valid, accountId: "" }],
    ["householdId", { ...valid, householdId: "" }],
    ["createdByUserId", { ...valid, createdByUserId: "" }],
    ["paidOn", { ...valid, paidOn: "06/07/2026" }],
  ])("rejects invalid %s", (field, input) => {
    const result = createCardBillSettlement(input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]?.field).toContain(field);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @family-finance/domain test`
Expected: FAIL — `createCardBillSettlement is not defined`.

- [ ] **Step 3: Implement**

In `packages/domain/src/transactions.ts` (bottom, near `isCardPayment`):

```ts
const cardBillSettlementSchema = z.object({
  householdId: z.string().min(1),
  creditCardId: z.string().min(1),
  accountId: z.string().min(1),
  billMonth: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
  amountCents: z.number().int().positive(),
  paidOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  createdByUserId: z.string().min(1),
});

export type CardBillSettlementInput = z.input<typeof cardBillSettlementSchema>;

/**
 * A validated card-bill settlement: ONE kind='transfer' row with BOTH
 * instruments (account = source, card = destination) + bill_month as the
 * settled marker. The settle_card_bill RPC derives the row's description
 * from the card name — the draft intentionally has none.
 */
export type CardBillSettlementDraft = z.output<typeof cardBillSettlementSchema>;

export function createCardBillSettlement(
  input: CardBillSettlementInput,
): DomainResult<CardBillSettlementDraft> {
  const parsed = cardBillSettlementSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((issue) => ({
        field: issue.path.join(".") || "root",
        code: issue.code,
        message: issue.message,
      })),
    };
  }
  return { ok: true, value: parsed.data };
}
```

Export the three names from `packages/domain/src/index.ts` alongside the existing transactions exports.

- [ ] **Step 4: Verify pass** — `pnpm --filter @family-finance/domain test` → PASS. Also `pnpm --filter @family-finance/domain typecheck`.

- [ ] **Step 5: Commit**

```bash
git add packages/domain/src/transactions.ts packages/domain/src/transactions.test.ts packages/domain/src/index.ts
git commit -m "feat(domain): createCardBillSettlement draft builder"
```

---

### Task 3: db — `settleCardBill`, `findCardBillSettlements`, transfer guard, fake RPC

**Files:**
- Modify: `packages/db/src/types.ts`, `packages/db/src/repositories.ts`, `packages/db/src/index.ts` (exports)
- Modify: `apps/web/integration/fake-supabase.ts`
- Test: `packages/db/src/repositories.test.ts`

**Interfaces:**
- Consumes: `CardBillSettlementDraft` (Task 2), `settle_card_bill` RPC (Task 1), existing `materializeObligationPayment` skeleton (`repositories.ts:2292-2305`), `updateTransaction` guard block (`repositories.ts:1682-1705`).
- Produces:
  - `TransactionRow.bill_month: string | null` (types.ts)
  - `SettleCardBillResult = { transaction: TransactionRow; already_paid: boolean }`
  - `settleCardBill(client: AppSupabaseClient, draft: CardBillSettlementDraft): Promise<SettleCardBillResult>`
  - `CardBillSettlement = { creditCardId: string; amountCents: number; paidOn: string }`
  - `findCardBillSettlements(client: AppSupabaseClient, householdId: string, month: string): Promise<CardBillSettlement[]>`
  - `updateTransaction` throws pt-BR on `payment` patches to `kind === "transfer"` rows.
  - fake-supabase `.rpc("settle_card_bill", args)` branch.

- [ ] **Step 1: Failing tests** — append to `packages/db/src/repositories.test.ts` using the file's existing `createRecordingClient`/`fakeClientWithRow` helpers:

```ts
describe("settleCardBill", () => {
  it("calls the RPC with snake_case target args and returns the result", async () => {
    const result = {
      transaction: { id: "tx-1", bill_month: "2026-07" },
      already_paid: false,
    };
    const calls: Array<{ name: string; args: unknown }> = [];
    const client = {
      rpc: async (name: string, args: unknown) => {
        calls.push({ name, args });
        return { data: result, error: null };
      },
    } as unknown as AppSupabaseClient;

    const out = await settleCardBill(client, {
      householdId: "house-1",
      creditCardId: "card-1",
      accountId: "acct-1",
      billMonth: "2026-07",
      amountCents: 235000,
      paidOn: "2026-07-06",
      createdByUserId: "user-1",
    });
    expect(out).toEqual(result);
    expect(calls[0]).toEqual({
      name: "settle_card_bill",
      args: {
        target_household_id: "house-1",
        target_credit_card_id: "card-1",
        target_account_id: "acct-1",
        target_bill_month: "2026-07",
        target_amount_cents: 235000,
        target_paid_on: "2026-07-06",
        target_created_by_user_id: "user-1",
      },
    });
  });

  it("throws on RPC error", async () => {
    const client = {
      rpc: async () => ({ data: null, error: { message: "boom" } }),
    } as unknown as AppSupabaseClient;
    await expect(
      settleCardBill(client, { /* same valid draft */ }),
    ).rejects.toThrow("settleCardBill failed: boom");
  });
});
```

Plus:
- `findCardBillSettlements` — recording client asserting the query chain `.from("transactions").select("credit_card_id, amount_cents, occurred_on").eq("household_id", …).eq("kind", "transfer").eq("bill_month", "2026-07")` and the mapped `{ creditCardId, amountCents, paidOn }` result.
- `updateTransaction` transfer guard — `fakeClientWithRow`-style client returning `{ installment_id: null, kind: "transfer" }` from the lookup; `updateTransaction(client, "house-1", "tx-1", { payment: { type: "account", accountId: "a2" } })` rejects with the pt-BR message below; an `amountCents`-only patch on the same row does NOT throw (amount edits stay allowed per spec §3).

- [ ] **Step 2: Verify RED** — `pnpm --filter @family-finance/db test` fails on the new describes.

- [ ] **Step 3: Implement**

`packages/db/src/types.ts`:
- `TransactionRow` gains `bill_month: string | null;` (after `obligation_month`, with a `/** Set on the kind='transfer' card-bill settle row (migration 0015). */` doc line).
- `Functions` map gains:

```ts
settle_card_bill: {
  Args: {
    target_household_id: string;
    target_credit_card_id: string;
    target_account_id: string;
    target_bill_month: string;
    target_amount_cents: number;
    target_paid_on: string;
    target_created_by_user_id: string;
  };
  Returns: unknown;
};
```

(match the exact shape style of the neighboring `materialize_obligation_payment` entry)

- `SettleCardBillResult` next to `MaterializeObligationPaymentResult`:

```ts
export type SettleCardBillResult = {
  transaction: TransactionRow;
  already_paid: boolean;
};
```

`packages/db/src/repositories.ts` (next to `materializeObligationPayment`):

```ts
import type { CardBillSettlementDraft } from "@family-finance/domain";

/** Settle a card's bill for a month via the settle_card_bill RPC (0015). */
export async function settleCardBill(
  client: AppSupabaseClient,
  draft: CardBillSettlementDraft,
): Promise<SettleCardBillResult> {
  const { data, error } = await client.rpc("settle_card_bill", {
    target_household_id: draft.householdId,
    target_credit_card_id: draft.creditCardId,
    target_account_id: draft.accountId,
    target_bill_month: draft.billMonth,
    target_amount_cents: draft.amountCents,
    target_paid_on: draft.paidOn,
    target_created_by_user_id: draft.createdByUserId,
  });
  if (error !== null) {
    throw new Error(`settleCardBill failed: ${error.message}`);
  }
  return data as SettleCardBillResult;
}

export type CardBillSettlement = {
  creditCardId: string;
  amountCents: number;
  paidOn: string;
};

/** Settled card bills for a month (the kind='transfer' rows with bill_month). */
export async function findCardBillSettlements(
  client: AppSupabaseClient,
  householdId: string,
  month: string,
): Promise<CardBillSettlement[]> {
  const { data, error } = await client
    .from("transactions")
    .select("credit_card_id, amount_cents, occurred_on")
    .eq("household_id", householdId)
    .eq("kind", "transfer")
    .eq("bill_month", month);
  if (error !== null) {
    throw new Error(`findCardBillSettlements failed: ${error.message}`);
  }
  const rows = (data ?? []) as Array<
    Pick<TransactionRow, "credit_card_id" | "amount_cents" | "occurred_on">
  >;
  return rows.map((row) => ({
    creditCardId: row.credit_card_id as string,
    amountCents: row.amount_cents,
    paidOn: row.occurred_on,
  }));
}
```

Transfer guard — inside `updateTransaction`'s existing gated lookup block (`repositories.ts:1682-1705`), after the parcela guard and before the income/card guard:

```ts
    if (
      data !== null &&
      data.kind === "transfer" &&
      patch.payment !== undefined
    ) {
      throw new Error(
        "Transferência tem conta e cartão fixos — para desfazer um pagamento de fatura, exclua a linha.",
      );
    }
```

Export `settleCardBill`, `findCardBillSettlements`, `CardBillSettlement`, `SettleCardBillResult` from `packages/db/src/index.ts`.

`apps/web/integration/fake-supabase.ts` — fifth `.rpc` branch mirroring `materializeObligationPaymentRpc`:

```ts
function settleCardBillRpc(
  store: FakeSupabaseStore,
  args: {
    target_household_id: string;
    target_credit_card_id: string;
    target_account_id: string;
    target_bill_month: string;
    target_amount_cents: number;
    target_paid_on: string | null;
    target_created_by_user_id: string;
  },
): Result<Row> {
  const card = store
    .table("credit_cards")
    .find(
      (r) =>
        r.id === args.target_credit_card_id &&
        r.household_id === args.target_household_id,
    );
  if (card === undefined) {
    return {
      data: null as unknown as Row,
      error: { message: `card ${args.target_credit_card_id} not found` },
    };
  }
  const existing = store
    .table("transactions")
    .find(
      (r) =>
        r.kind === "transfer" &&
        r.credit_card_id === args.target_credit_card_id &&
        r.bill_month === args.target_bill_month,
    );
  if (existing !== undefined) {
    return { data: { transaction: existing, already_paid: true }, error: null };
  }
  const month = args.target_bill_month;
  const tx = store.materialize({
    household_id: args.target_household_id,
    kind: "transfer",
    amount_cents: args.target_amount_cents,
    occurred_on: args.target_paid_on ?? `${month}-01`,
    description: `Fatura ${String(card.name)} — ${month.slice(5, 7)}/${month.slice(0, 4)}`,
    category_id: null,
    subcategory_id: null,
    account_id: args.target_account_id,
    credit_card_id: args.target_credit_card_id,
    installment_id: null,
    responsibility_scope: "household",
    responsible_user_id: null,
    created_by_user_id: args.target_created_by_user_id,
    import_batch_id: null,
    obligation_id: null,
    obligation_month: null,
    bill_month: month,
  });
  store.table("transactions").push(tx);
  return { data: { transaction: tx, already_paid: false }, error: null };
}
```

and in the `rpc(name, args)` dispatcher add `if (name === "settle_card_bill") { … }` before the throw.

- [ ] **Step 4: Verify green** — `pnpm --filter @family-finance/db test && pnpm --filter @family-finance/db typecheck`, plus `pnpm --filter @family-finance/web test` (fake-store file compiles, no behavior change yet).

- [ ] **Step 5: Commit**

```bash
git add packages/db apps/web/integration/fake-supabase.ts
git commit -m "feat(db): settleCardBill + findCardBillSettlements + transfer payment guard"
```

---

### Task 4: Classifier — installment payload + mark_paid amount

**Files:**
- Modify: `apps/bot/src/interpret.ts`
- Test: `apps/bot/src/interpret.test.ts`

**Interfaces:**
- Consumes: existing `classifiedReplySchema` discriminated union, `buildClassifierPrompt`, `createMessageClassifier` (`interpret.ts:128-279`).
- Produces (used by Tasks 5/6):

```ts
export type InterpretedCardPurchase = {
  description: string;
  totalCents?: number;
  perInstallmentCents?: number;
  installmentCount?: number;
  purchasedOn?: string;
  cardKeyword?: string;
  categoryHint?: string;
};

export type InterpretedIntent =
  | { intent: "plain"; expense: InterpretedExpense }
  | { intent: "obligation"; obligation: InterpretedObligation }
  | { intent: "card_installment"; purchase: InterpretedCardPurchase }
  | {
      intent: "mark_paid";
      target: "obligation" | "card";
      keyword: string;
      amountCents?: number;
    };
```

- [ ] **Step 1: Failing tests** — in `interpret.test.ts`, with the existing mocked-`AiCompletionClient` pattern:

```ts
it("extracts a card_installment payload (total form)", async () => {
  const classify = createMessageClassifier(
    clientReplying(
      '{"intent":"card_installment","purchase":{"description":"Notebook","total_cents":360000,"per_installment_cents":null,"installment_count":12,"purchased_on":null,"card_keyword":"nubank","category_hint":null}}',
    ),
  );
  const out = await classify("notebook 3600 em 12x no nubank", { today: TODAY });
  expect(out).toEqual({
    intent: "card_installment",
    purchase: {
      description: "Notebook",
      totalCents: 360000,
      installmentCount: 12,
      cardKeyword: "nubank",
    },
  });
});

it("extracts the per-installment form", async () => { /* per_installment_cents: 30000, total null */ });
it("tolerates a missing installment_count", async () => { /* installment_count: null → field absent */ });
it("rejects a bare {intent:'card_installment'} (old shape) → null", async () => { /* classifier returns null */ });
it("extracts mark_paid card with a trailing amount", async () => {
  /* '{"intent":"mark_paid","target":"card","keyword":"nubank","amount_cents":235000}'
     → { intent: "mark_paid", target: "card", keyword: "nubank", amountCents: 235000 } */
});
it("mark_paid amount_cents omitted → amountCents absent", async () => { /* ... */ });
```

Prompt tests (mirroring existing `buildClassifierPrompt` assertions): the prompt string contains the new `card_installment` JSON format line, the wording rule `"12x de 300"`/`"3600 em 12x"`, and the `mark_paid` `amount_cents` rule.

- [ ] **Step 2: RED** — `pnpm --filter @family-finance/bot test -- interpret` fails.

- [ ] **Step 3: Implement**

zod additions:

```ts
const cardInstallmentPayloadSchema = z.object({
  description: z.string().min(1),
  total_cents: z.number().int().positive().nullish(),
  per_installment_cents: z.number().int().positive().nullish(),
  installment_count: z.number().int().positive().nullish(),
  purchased_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullish(),
  card_keyword: z.string().min(1).nullish(),
  category_hint: z.string().min(1).nullish(),
});
```

Union branches become:

```ts
  z.object({
    intent: z.literal("card_installment"),
    purchase: cardInstallmentPayloadSchema,
  }),
  z.object({
    intent: z.literal("mark_paid"),
    target: z.enum(["obligation", "card"]),
    keyword: z.string().min(1),
    amount_cents: z.number().int().positive().nullish(),
  }),
```

Switch cases map snake→camel dropping nullish fields (same `?? undefined` style as the `plain`/`obligation` branches).

Prompt changes in `buildClassifierPrompt`:
- Replace the format line `'{"intent": "card_installment"}'` with:
  `'{"intent": "card_installment", "purchase": {"description": string, "total_cents": number | null, "per_installment_cents": number | null, "installment_count": number | null, "purchased_on": "YYYY-MM-DD" | null, "card_keyword": string | null, "category_hint": string | null}}'`
- Replace the mark_paid format line with:
  `'{"intent": "mark_paid", "target": "obligation" | "card", "keyword": string, "amount_cents": number | null}'`
- Add rules (after the existing monthly_amount_cents rule):
  - `'- Em card_installment: "12x de 300" e "300 12x" são POR PARCELA (per_installment_cents); "3600 em 12x" é o TOTAL (total_cents). Preencha EXATAMENTE UM dos dois; installment_count é o número de parcelas (12x -> 12), null se não aparecer. card_keyword é o nome do cartão ("no nubank" -> "nubank"); description é só o nome do produto/serviço.'`
  - `'- Em mark_paid com target "card", um número no fim ("nubank pago 2350") vira amount_cents em centavos (235000); null se não houver.'`

- [ ] **Step 4: GREEN** — `pnpm --filter @family-finance/bot test -- interpret && pnpm --filter @family-finance/bot typecheck`. NOTE: `conversation-obligations.test.ts` deferred-path tests may now fail to compile against the new union — if so, update ONLY their fixture literals to the new shape (`{ intent: "card_installment", purchase: {...} }`); their "em breve" behavior assertions still pass until Task 5.

- [ ] **Step 5: Commit**

```bash
git add apps/bot/src/interpret.ts apps/bot/src/interpret.test.ts apps/bot/src/conversation-obligations.test.ts
git commit -m "feat(bot): classifier extracts card installment payload + mark_paid amount"
```

---

### Task 5: Bot installment flow (2a)

**Files:**
- Modify: `apps/bot/src/keyboards.ts`, `apps/bot/src/conversation.ts`, `apps/bot/src/replies.ts`, `apps/bot/src/index.ts`
- Test: Create `apps/bot/src/conversation-installments.test.ts`; modify `apps/bot/src/keyboards.test.ts`, `apps/bot/src/conversation-obligations.test.ts` (delete the card_installment "em breve" test)

**Interfaces:**
- Consumes: `InterpretedCardPurchase` (Task 4); domain `createInstallmentPlan` (`packages/domain/src/installments.ts:138`); db `createInstallmentPurchase(client, plan)` (`repositories.ts:1225`); existing keyboard builders + `TOKENS`, `CATEGORY_TOKEN_PREFIX`; `suggestCategory`/proposal flow; `stripEdgePunctuation`; `normalizeText`; obligation-flow patterns (`applyObligationMessage`, `startClassifiedIntent`).
- Produces:
  - `keyboards.ts`: `export const CARD_TOKEN_PREFIX = "cd:";` and `cardGridKeyboard(cards: Array<{ id: string; name: string }>): InlineKeyboardMarkup` (2 per row, alphabetical — mirror `categoryGridKeyboard` without the trailing new-category button).
  - `conversation.ts`:

```ts
export type InstallmentDraftInProgress = {
  description: string;
  totalCents?: number;
  installmentCount?: number;
  purchasedOn: string;   // ISO date
  cardId?: string;
  categoryId?: string;
  subcategoryId?: string;
  categoryExplanation?: string;
  responsibleUserId?: string;
  createdByUserId: string;
};
```

  - `ConversationStatus` gains `"awaiting_installment_confirmation"`; `ConversationState` gains `installmentDraft?: InstallmentDraftInProgress`.
  - New `ConversationDeps` fields (all optional, following the obligation dep style):

```ts
  listActiveCards?: () => Array<{ id: string; name: string; closingDay?: number }>;
  createInstallmentPurchase?: (plan: InstallmentPlan) => Promise<{ groupId: string }>;
```

**Flow requirements (from the spec, all must be implemented):**

1. **Start** (`startClassifiedIntent`, replacing the `card_installment` "em breve" branch):
   - No active card → terminal refusal: `"Compra parcelada é no cartão — a casa ainda não tem cartão cadastrado. Cadastre um em Cartões no painel."`
   - Normalize amount: `totalCents = purchase.totalCents ?? (purchase.perInstallmentCents !== undefined && purchase.installmentCount !== undefined ? purchase.perInstallmentCents * purchase.installmentCount : undefined)`.
   - Card resolution: `cardKeyword` → token match against active card names using the same normalize/token approach as `obligationKeywordMatch` (extract a shared `keywordMatch(keyword, name)` or reuse it); exactly 1 match → that card. No keyword + exactly 1 active card → auto. Otherwise `cardId` stays undefined and the confirmation reply carries `cardGridKeyboard(cards)` with the question `"Qual cartão?"` appended.
   - `description = stripEdgePunctuation(purchase.description)`; `purchasedOn = purchase.purchasedOn ?? options.today`; `responsibleUserId = input.fromUserId || undefined`.
   - Category: same `suggestCategory` call as the obligation branch (hint appended as ` (${categoryHint})`); `pending_new_category` proposals set `state.proposedCategoryName` and use the proposal keyboard, exactly as the plain-expense flow does.
   - Outcome: `status: "awaiting_installment_confirmation"`, ballast draft, `installmentDraft`, reply = `installmentConfirmationMessage(view)`, keyboard = card grid (no card) / proposal keyboard (proposal) / standard confirm keyboard.
2. **Summary** (`installmentSummaryView` + `replies.ts` builder). Never one line per parcel:
   - First line: `Compra parcelada: <desc> — R$ <total> em <N>× de R$ <per> no <Card> (1ª parcela <mmm/yyyy>)`.
   - `de R$ <per>` only when `totalCents % installmentCount === 0` (exact); otherwise omit just that fragment.
   - `(1ª parcela <mmm/yyyy>)`: call the pure `createInstallmentPlan` with the current draft (+ `closingDay` from `deps.listActiveCards()`); when it returns ok, format `plan.installments[0].dueMonth` with a small `MONTHS_PT_ABBR` helper in replies.ts (`["jan","fev","mar","abr","mai","jun","jul","ago","set","out","nov","dez"]`); when the draft is incomplete, omit the parenthetical.
   - Missing pieces render as pendências: `valor?`, `parcelas?`, `cartão?` lines.
   - Then `• Categoria: …` / `• Responsável: …` (via `deps.memberDisplayName`) / `Sugestão: …` lines + the typed-correction hint: `Confirma? Corrija com "valor 3.700", "parcelas 10", "cartão X", "categoria Y", "data 12/06", ou "cancelar".`
3. **`applyInstallmentMessage`** (dispatched from `applyMessage` on the new status, right beside the `awaiting_obligation_confirmation` branch):
   - `CANCEL_RE` → cancelled.
   - `CONFIRM_RE` → missing `totalCents` → `"Ainda falta o valor. Informe com \"valor 3.600\"."` (stay); missing `installmentCount` → `"Em quantas parcelas? Responda com \"parcelas 12\"."` (stay); missing `cardId` → `"Qual cartão?"` + card grid (stay). All present → **confirm** (below).
   - Corrections (inline regexes, obligation style): `valor X` (total, via `parseExpenseText` amount), `parcelas N` (`/^parcelas?\b\s*(\d{1,3})\s*$/i`, ≥ 2 — reject 0/1 with `"O parcelamento precisa de pelo menos 2 parcelas."`), `cartão X` / `cartao X` (single keyword match else `"Não encontrei o cartão \"X\"."`), `categoria Y` (catalog match, as `parseCorrection` does), `data DD/MM` (purchase date via `parseExpenseText`). Each re-shows the summary via `correctionAppliedMessage`.
   - Anything else → the summary again (help).
4. **Confirm** (shared `confirmInstallment(state, deps, today, messageText)` used by BOTH typed confirm and the `cf` callback):
   - `deps.createInstallmentPurchase` undefined → the obligation-style unavailable message.
   - Build via domain: `createInstallmentPlan({ householdId, creditCardId: cardId, description, totalAmount: { currency: "BRL", cents: totalCents }, installmentCount, purchasedOn, createdByUserId, responsibleUserId, category: categoryId ? { categoryId, subcategoryId } : undefined, closingDay })` where `closingDay` comes from `deps.listActiveCards()` for the chosen card.
   - `!built.ok` → `Não consegui salvar: ${describeValidationError(built.errors[0])}.` (extend `describeValidationError` with `case "installmentCount": return "número de parcelas inválido";` and `case "totalAmount.cents": case "totalAmount": return "valor inválido";`).
   - `await deps.createInstallmentPurchase(built.value)` → `logInteraction` → saved status + `installmentSavedMessage({ description, totalCents, installmentCount, cardName, firstDueMonth })`: `Compra parcelada salva! ✅ <desc> — R$ <total> em <N>× no <Card> (1ª parcela <mmm/yyyy>)`.
5. **`applyCallback`** — new branch for `awaiting_installment_confirmation` (BEFORE the stale fallback; REMOVE nothing from the obligation stale list):
   - `cf` → `confirmInstallment` (parity with typed confirm). `cx` → cancelled.
   - `cd:<uuid>` → card exists in `deps.listActiveCards()` → set `cardId`, re-show summary + standard keyboard; unknown id → `expiredOutcome`.
   - `cats` → category grid; `ct:<uuid>` → set category, re-show summary; `nca`/`nocat` → same semantics as the plain-expense proposal handling (accept creates via `createOrReuseCategory` + assigns; drop clears the proposal) but returning to the installment summary, NOT persisting the purchase.
   - Buttons inherit strip-on-act / stale / double-tap from the webhook layer automatically.
6. **`index.ts` wiring** in `buildDeps` (cards are already loaded at `index.ts:170`):

```ts
    listActiveCards: () =>
      cards.map((card) => ({
        id: card.id,
        name: card.name,
        closingDay:
          card.closing_day !== null &&
          card.closing_day >= 1 &&
          card.closing_day <= 28
            ? card.closing_day
            : undefined,
      })),
    createInstallmentPurchase: async (plan) => {
      const result = await dbCreateInstallmentPurchase(client, plan);
      return { groupId: result.group.id };
    },
```

(`dbCreateInstallmentPurchase` = `createInstallmentPurchase` from `@family-finance/db`, aliased like the other repo imports.)

- [ ] **Step 1: Failing tests** — create `apps/bot/src/conversation-installments.test.ts` modeled on `conversation-obligations.test.ts` (same deps-stub style, classifier stubbed to return the intent directly). Cover at minimum:
  - auto-card (1 active card, no keyword) → summary shows the card + `1ª parcela` month; keyword match picks the right card of 2; ambiguous 2 cards → reply carries `cardGridKeyboard` and no cardId.
  - no active card → refusal, terminal.
  - total form vs per-parcel form normalize to the same total; per-parcel display fragment only when divisible.
  - missing count: confirm → "Em quantas parcelas?"; `parcelas 12` fills it; `parcelas 1` rejected.
  - corrections: `valor 3.700`, `cartão visa`, `categoria Transporte`, `data 12/06` each re-show the summary with the change.
  - confirm persists: deps.createInstallmentPurchase receives a plan whose group.totalAmountCents/installmentCount/creditCardId match, whose installments count matches, and whose first dueMonth reflects closingDay (purchase day AFTER closing day → next month).
  - closingDay shift: card closingDay 5, purchasedOn day 10 → first dueMonth is next month.
  - `cf` callback parity with typed "confirmar" (same save, `ALREADY_SAVED_TOAST` on second tap); `cd:<uuid>` sets the card; stale `cd:` on saved state → expired.
  - keyboards.test.ts: `cardGridKeyboard` 2-per-row shape + 64-byte cap + `cd:` prefix.
  - DELETE the `card_installment` "em breve" test from `conversation-obligations.test.ts`.
- [ ] **Step 2: RED** — `pnpm --filter @family-finance/bot test` fails on the new file.
- [ ] **Step 3: Implement** everything in the Flow requirements above.
- [ ] **Step 4: GREEN** — `pnpm --filter @family-finance/bot test && pnpm --filter @family-finance/bot typecheck`.
- [ ] **Step 5: Commit**

```bash
git add apps/bot/src
git commit -m "feat(bot): card installment entry via conversation flow"
```

---

### Task 6: Bot card-bill payment flow (2b)

**Files:**
- Modify: `apps/bot/src/conversation.ts`, `apps/bot/src/replies.ts`, `apps/bot/src/index.ts`
- Test: Create `apps/bot/src/conversation-card-bill.test.ts`; modify `apps/bot/src/conversation-obligations.test.ts` (delete the mark_paid{card} "em breve" test)

**Interfaces:**
- Consumes: `mark_paid` `amountCents` (Task 4), domain `createCardBillSettlement` (Task 2), db `settleCardBill`/`getCardPressureForCard` (Tasks 1/3), `cardGridKeyboard`/`CARD_TOKEN_PREFIX` (Task 5), `listActiveCards` dep (Task 5), obligation `settleObligation` pattern.
- Produces:
  - `ConversationStatus` gains `"awaiting_card_bill_confirmation"`; `ConversationState` gains `cardBillDraft?: CardBillDraftInProgress`.

```ts
export type CardBillDraftInProgress = {
  cardId?: string;                 // undefined while the picker is open
  overrideAmountCents?: number;    // classifier trailing amount or `valor` correction
  amountCents?: number;            // resolved (override ?? computed) once the card is known
  accountId: string;
  month: string;                   // YYYY-MM, calendar month of the message
  createdByUserId: string;
};
```

  - New `ConversationDeps` fields:

```ts
  getCardBillAmount?: (creditCardId: string, month: string) => Promise<number>;
  settleCardBill?: (draft: CardBillSettlementDraft) => Promise<{ alreadyPaid: boolean }>;
```

**Flow requirements:**

1. **Start** (`startClassifiedIntent`, replacing the `mark_paid`+`target === "card"` "em breve" branch):
   - `matchCards(keyword)` over `deps.listActiveCards()` with the Task-5 keyword matcher. 0 matches → terminal: `Não encontrei o cartão "<keyword>". Cartões da casa: <names alfabético> — ou corrija o nome.` (no card at all → `A casa ainda não tem cartão cadastrado.`).
   - `deps.defaultAccountId === undefined` → terminal: `A casa ainda não tem uma conta cadastrada — crie uma em Contas no painel antes de pagar faturas.`
   - `month = options.today.slice(0, 7)`; `overrideAmountCents = classified.amountCents`.
   - Exactly 1 match → **resolveBillCard** (below). 2+ → state `awaiting_card_bill_confirmation` with `cardId` undefined + `cardGridKeyboard(matches)` + reply `Qual cartão é a fatura?`.
2. **`resolveBillCard(cardId)`** (shared by the 1-match start path, the `cd:` tap, and a typed card-name reply while the picker is open):
   - `deps.getCardBillAmount` undefined → obligation-style unavailable terminal.
   - `computed = await deps.getCardBillAmount(cardId, month)`; `amount = overrideAmountCents ?? computed`.
   - `amount <= 0 or undefined` (computed 0 and no override) → terminal: `Fatura do <Card> está zerada este mês — nada pra pagar. 👍` (nothing written).
   - Else → confirmation state + `cardBillConfirmationMessage`: `Fatura <Card> de <mmm/yyyy> — R$ <amount>. Pagar da conta <Account>?` + hint `Responda "confirmar", corrija com "valor 2.350" ou "conta X", ou "cancelar".` + confirm/cancel keyboard (reuse the standard cf/cx pair; account label via `deps.accountNameById`).
3. **`applyCardBillMessage`** (new `applyMessage` branch):
   - `CANCEL_RE` → cancelled. Picker open (`cardId === undefined`): a message matching exactly one active card name → `resolveBillCard`; otherwise re-ask with the grid.
   - `valor X` → sets `overrideAmountCents` AND `amountCents`, re-shows confirmation. `conta X` → `deps.resolveAccountIdByName` (not found → `Não encontrei a conta "X".`), re-shows confirmation.
   - `CONFIRM_RE` → **confirm** (shared `confirmCardBill` used by typed + `cf` callback):
     - Build `createCardBillSettlement({ householdId, creditCardId: cardId, accountId, billMonth: month, amountCents, paidOn: today, createdByUserId })`; `!ok` → `Não consegui salvar: ${describeValidationError(...)}.` (add `case "billMonth": return "mês inválido";`).
     - `deps.settleCardBill` undefined → unavailable terminal. Call it; catch → `Não consegui registrar o pagamento da fatura do <Card> — tenta de novo em instantes.` (cancelled, mirroring `obligationSettleFailedMessage`).
     - `alreadyPaid: true` → saved status + `A fatura do <Card> de <mmm/yyyy> já estava paga — nada mudou. 👍`.
     - Success → `logInteraction` → saved + `Fatura paga! ✅ <Card> — R$ <amount> (<mmm/yyyy>)`.
4. **`applyCallback`** branch for `awaiting_card_bill_confirmation`: `cf` → `confirmCardBill`; `cx` → cancelled; `cd:<uuid>` (picker open) → `resolveBillCard`; anything else → `expiredOutcome`.
5. **`index.ts` wiring:**

```ts
    getCardBillAmount: async (creditCardId, month) => {
      const pressure = await getCardPressureForCard(
        client,
        householdId,
        creditCardId,
        month,
      );
      return pressure.totalCents;
    },
    settleCardBill: async (draft) => {
      const result = await dbSettleCardBill(client, draft);
      return { alreadyPaid: result.already_paid };
    },
```

- [ ] **Step 1: Failing tests** — `conversation-card-bill.test.ts`: computed amount shown in confirmation (deps.getCardBillAmount stub); trailing-amount override wins over computed; `valor` correction; `conta` correction (found + not-found); zero invoice + no override → zero message, settleCardBill NEVER called; ambiguous 2 cards → grid, then `cd:` pick resolves and computes; typed card name while picker open resolves too; confirm calls deps.settleCardBill with the exact draft (billMonth = today's month, paidOn = today, createdByUserId = sender); alreadyPaid → friendly no-op; settle throws → failure message, state cancelled; cf/cx parity; keyword no-match reply lists card names. Delete the mark_paid{card} "em breve" test in `conversation-obligations.test.ts`.
- [ ] **Step 2: RED** — bot tests fail.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: GREEN** — `pnpm --filter @family-finance/bot test && pnpm --filter @family-finance/bot typecheck`.
- [ ] **Step 5: Commit**

```bash
git add apps/bot/src
git commit -m "feat(bot): card-bill payment (nubank pago) settles via transfer row"
```

---

### Task 7: Web read-side — transfer guard UI + resumo "paga ✅"

**Files:**
- Modify: `apps/web/app/(app)/transactions/transactions-table.tsx`
- Modify: `apps/web/app/(app)/resumo/queries.ts`, `apps/web/app/(app)/resumo/page.tsx`
- Test: the existing render-test files for transactions/resumo (find them under `apps/web` — they render via `renderToStaticMarkup`), extend in place; integration coverage via `apps/web/integration` if a resumo/transactions story exists there.

**Interfaces:**
- Consumes: `findCardBillSettlements` (Task 3), `TransactionListItem.kind`.
- Produces: transfer rows read-only payment; resumo cards gain `settled: boolean`.

- [ ] **Step 1: Failing tests** — (a) transactions table: a `kind: "transfer"` row renders its payment as plain text (no `<select>` with `aria-label="Pagamento"`); (b) resumo: a card with a settlement for the month renders the `paga ✅` badge, one without doesn't.
- [ ] **Step 2: RED.**
- [ ] **Step 3: Implement**

`transactions-table.tsx` — `paymentSelect` first line becomes:

```tsx
    if (row.installmentId !== null || row.kind === "transfer") {
      // Parcelas: managed via the group. Transfers (bill payments): both
      // instruments are fixed — delete the row to undo.
      return <span className="ff-dim">{paymentName(row)}</span>;
    }
```

`resumo/queries.ts` — load settlements once and mark each card:

```tsx
  const settlements = await findCardBillSettlements(client, householdId, month);
  const cards = await Promise.all(
    creditCards.map(async (card) => {
      const pressure = await getCardPressureForCard(client, householdId, card.id, month);
      return {
        id: card.id,
        name: card.name,
        projectedCents: pressure.totalCents,
        settled: settlements.some((s) => s.creditCardId === card.id),
      };
    }),
  );
```

(update the `ResumoData` card type accordingly)

`resumo/page.tsx` — inside the per-card `Card`, next to the name:

```tsx
                    <div className="ff-icard__name">
                      {card.name}
                      {card.settled ? <Badge tone="accent">paga ✅</Badge> : null}
                    </div>
```

(use the Badge tone the transactions page uses for the `parcela` badge; adjust only if a positive tone exists in `components/ui`)

- [ ] **Step 4: GREEN** — `pnpm --filter @family-finance/web test && pnpm --filter @family-finance/web typecheck && pnpm --filter @family-finance/web lint`.
- [ ] **Step 5: Commit**

```bash
git add apps/web
git commit -m "feat(web): transfer rows lock payment edits; resumo shows paid card bills"
```

---

### Task 8: Bot end-to-end integration + full gate

**Files:**
- Modify: `apps/bot/src/bot.test.ts` (or a new `bot-card-flows.test.ts` reusing the `fakeSupabase`/`fakeTelegram` fixtures — prefer the new file, `bot-callbacks.test.ts` sets the precedent for copying fixtures)

**Interfaces:**
- Consumes: everything above; `fakeSupabase` seeded with `credit_cards` rows (`{ id: "card-1", household_id: "house-1", name: "Nubank", closing_day: 5, due_day: 12 }`).

**The fake client for bot tests has no `.rpc`** — extend the local `fakeSupabase` fixture with an `rpc(name, args)` implementing `create_installment_purchase` (push group + parcels into `tables`) and `settle_card_bill` (idempotent on `credit_card_id`+`bill_month`, mirroring the Task-3 fake), so `handleWebhook` runs the REAL repos end-to-end.

- [ ] **Step 1: Write the story test (RED):**
  1. webhook text `"notebook 3600 em 12x no nubank"` (classifier stubbed to the Task-4 intent) → confirmation summary sent; `"confirmar"` → `installment_groups` has 1 group (total 360000, count 12, card-1) and `installments` has 12 rows; first `due_month` respects `closing_day` 5 vs the purchase date.
  2. webhook text `"nubank pago"` (stubbed `mark_paid` card intent) → confirmation shows the computed pressure (seed one direct card expense + the parcels due this month); `"confirmar"` → `transactions` gains ONE row with `kind: "transfer"`, both `account_id` and `credit_card_id`, `bill_month` = current month.
  3. `summarizeMonth` over the month's transactions returns the SAME expense total before and after the settle (transfer excluded — no double count).
  4. Repeat `"nubank pago"` + `"confirmar"` → still one transfer row; reply is the already-paid no-op.
  5. Callback path: re-run story 1 confirming via the `cf` button instead of typed text (parity), double-tap `cf` → `ALREADY_SAVED_TOAST`, no second group.
- [ ] **Step 2: Implement fixture `.rpc` + fix anything the story surfaces; GREEN.**
- [ ] **Step 3: Full repo gate:**

```bash
pnpm typecheck && pnpm test && pnpm --filter @family-finance/web lint && pnpm build
```
Expected: 12/12 typecheck, all suites green (bot was 175 + new, db 60 + new), builds green, lint clean except the pre-existing toast-timers warning.

- [ ] **Step 4: Commit**

```bash
git add apps/bot/src
git commit -m "test(bot): end-to-end card installment + bill payment stories"
```

---

## Self-Review (done at plan time)

- **Spec coverage:** §1 classifier payload → T4; card resolution/grid/refusal, category+proposal, missing count, summary, corrections, confirm via domain+RPC, callback safety → T5; RPC gate fix → T1; §2 migration (column, narrowed check, index, RPC, hardening) → T1; domain builder → T2; repo + `TransactionRow.bill_month` + settled read → T3; dashboard read-side → T7; bot flow 1–4 → T6; §3 transfer exclusion (verified existing), web edit guard → T3+T7, delete-as-undo (no code — guard intentionally absent), idempotency → T1/T6/T8; §4 testing matrix → T1 (RLS/constraints), T2 (domain), T4 (classifier), T5/T6 (conversation), T8 (integration + gate).
- **Known deviation:** draft builder has no `description` (RPC derives it) — spec's two clauses conflicted; the RPC arg list is normative. Flagged in T2.
- **Type consistency:** `CardBillSettlementDraft` produced in T2, consumed by T3 (`settleCardBill`) and T6 (dep signature); `InstallmentPlan` from domain consumed by T5 dep + existing db repo; `listActiveCards` produced in T5, consumed in T6; `CARD_TOKEN_PREFIX`/`cardGridKeyboard` produced in T5, consumed in T6.
