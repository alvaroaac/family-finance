# Manual Transaction Entry + Payment/Amount Edit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the household manually add a transaction (expense or income) from the web app, and edit an existing transaction's amount and payment instrument (account↔card).

**Architecture:** Extend `TransactionPatch`/`transactionUpdateFromPatch` in packages/db (payment swap = one atomic UPDATE touching both columns, parcela guard mirrors the delete guard). New `createManualTransaction` server action validates via the shared domain `createTransactionDraft`. UI: an inline collapsible "Novo lançamento" panel on /transactions (opened by `?novo=1`; dashboard button links there) + amount/payment controls in the existing edit row.

**Tech Stack:** Next.js App Router server actions, `@family-finance/domain` (`createTransactionDraft`, `brl`), `@family-finance/db` repos, vitest with the existing fake-supabase store, ff-* design-system primitives.

**Spec:** `docs/superpowers/specs/2026-07-03-manual-transaction-entry-and-payment-edit-design.md`

## Global Constraints

- All user-facing copy in pt-BR, warm/intimate register (match existing strings).
- TDD: every task writes its failing test first and watches it fail.
- Design firewall: files under `apps/web/components/ui/` may NOT import `@family-finance/*`, `lib/`, `app/` (enforced by `ui-firewall.test.ts`) — the new form lives in `app/(app)/transactions/`, NOT in `components/ui/`.
- Transactions DB CHECK: exactly one of `account_id`/`credit_card_id` non-null — a payment swap must set both columns in the same UPDATE.
- Income entries pay from an ACCOUNT only (UI hides cards AND the action enforces it).
- `kind` editing, transfers, and parcelado-in-form are OUT of scope.
- Full gate before finishing: `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm --filter @family-finance/web lint`.

---

### Task 1: packages/db — amount + payment in TransactionPatch, parcela guard

**Files:**
- Modify: `packages/db/src/repositories.ts:1510-1585` (`TransactionPatch`, `transactionUpdateFromPatch`, `updateTransaction`)
- Test: `packages/db/src/repositories.test.ts` (extend the existing `describe("transactionUpdateFromPatch")` at ~line 439)

**Interfaces:**
- Consumes: existing `TransactionPatch`, `transactionUpdateFromPatch(patch): Partial<TransactionInsert>`, `updateTransaction(client, householdId, transactionId, patch)`.
- Produces (later tasks rely on these exact shapes):
  ```ts
  export type TransactionPatch = {
    categoryId?: string | null;
    subcategoryId?: string | null;
    description?: string;
    responsibility?: { scope: "household" } | { scope: "user"; userId: string };
    occurredOn?: string;
    amountCents?: number;                                  // NEW: integer > 0
    payment?:                                              // NEW
      | { type: "account"; accountId: string }
      | { type: "card"; creditCardId: string };
  };
  ```
  `updateTransaction` throws pt-BR `Error("Parcelas são gerenciadas pelo grupo do parcelamento — edite o parcelamento, não a parcela avulsa.")` when the row has `installment_id` and the patch touches `amountCents` or `payment`.

- [ ] **Step 1: Write the failing tests**

In `packages/db/src/repositories.test.ts`, inside the existing `describe("transactionUpdateFromPatch", ...)` add:

```ts
  it("maps amountCents and rejects non-positive or non-integer values", () => {
    expect(transactionUpdateFromPatch({ amountCents: 4590 })).toEqual({
      amount_cents: 4590,
    });
    for (const bad of [0, -100, 12.5]) {
      expect(() => transactionUpdateFromPatch({ amountCents: bad })).toThrow(
        /valor/i,
      );
    }
  });

  it("maps a payment swap to BOTH columns in one update (account and card)", () => {
    expect(
      transactionUpdateFromPatch({
        payment: { type: "card", creditCardId: "card-1" },
      }),
    ).toEqual({ credit_card_id: "card-1", account_id: null });
    expect(
      transactionUpdateFromPatch({
        payment: { type: "account", accountId: "acct-1" },
      }),
    ).toEqual({ account_id: "acct-1", credit_card_id: null });
  });

  it("rejects a payment patch with an empty id", () => {
    expect(() =>
      transactionUpdateFromPatch({ payment: { type: "account", accountId: "" } }),
    ).toThrow(/conta/i);
    expect(() =>
      transactionUpdateFromPatch({ payment: { type: "card", creditCardId: "" } }),
    ).toThrow(/cartão/i);
  });
```

Then, next to the existing `updateTransaction`/`deleteTransaction` tests (search the file for `describe("updateTransaction"` or the delete-guard test; follow the file's fake-client pattern), add a parcela-guard suite. The fake client must answer the `select("installment_id")` lookup; reuse/extend the same fake used by the delete-guard test:

```ts
  it("refuses amount/payment edits on a parcela row (installment_id set), pt-BR", async () => {
    const client = fakeClientWithRow({ installment_id: "inst-1" }); // same helper style as the delete-guard test
    await expect(
      updateTransaction(client, "house-1", "tx-1", { amountCents: 1000 }),
    ).rejects.toThrow(/parcelamento/i);
    await expect(
      updateTransaction(client, "house-1", "tx-1", {
        payment: { type: "card", creditCardId: "card-1" },
      }),
    ).rejects.toThrow(/parcelamento/i);
  });

  it("still allows description/category edits on a parcela row", async () => {
    const client = fakeClientWithRow({ installment_id: "inst-1" });
    await expect(
      updateTransaction(client, "house-1", "tx-1", { description: "Café" }),
    ).resolves.toBeUndefined();
  });
```

(If no `updateTransaction` describe/fake exists yet, create one mirroring the delete-guard test's fake exactly — same chain: `.from().select().eq().eq().maybeSingle()` for the lookup, `.from().update().eq().eq()` for the write.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @family-finance/db test`
Expected: FAIL — new keys are excess/unknown on `TransactionPatch` (TS via vitest still runs; assertions fail: `amount_cents` missing from output, no throw on parcela).

- [ ] **Step 3: Implement**

In `packages/db/src/repositories.ts`:

Extend the type (line ~1510):

```ts
export type TransactionPatch = {
  categoryId?: string | null;
  subcategoryId?: string | null;
  description?: string;
  responsibility?: { scope: "household" } | { scope: "user"; userId: string };
  occurredOn?: string; // ISO date (YYYY-MM-DD)
  /** Integer cents > 0. Parcela rows refuse this (managed via the group). */
  amountCents?: number;
  /**
   * Swap the payment instrument. Maps to BOTH columns in one UPDATE so the
   * DB CHECK (exactly one of account/card) can never be violated mid-edit.
   * Parcela rows refuse this (managed via the group).
   */
  payment?:
    | { type: "account"; accountId: string }
    | { type: "card"; creditCardId: string };
};
```

In `transactionUpdateFromPatch`, before the `return update;`:

```ts
  if (patch.amountCents !== undefined) {
    if (!Number.isInteger(patch.amountCents) || patch.amountCents <= 0) {
      throw new Error("O valor precisa ser maior que zero.");
    }
    update.amount_cents = patch.amountCents;
  }
  if (patch.payment !== undefined) {
    if (patch.payment.type === "account") {
      if (patch.payment.accountId === "") {
        throw new Error("Escolha a conta do lançamento.");
      }
      update.account_id = patch.payment.accountId;
      update.credit_card_id = null;
    } else {
      if (patch.payment.creditCardId === "") {
        throw new Error("Escolha o cartão do lançamento.");
      }
      update.credit_card_id = patch.payment.creditCardId;
      update.account_id = null;
    }
  }
```

In `updateTransaction`, after building `update` and the empty-patch early return, add the guard BEFORE the write (mirror `deleteTransaction`'s lookup):

```ts
  if (patch.amountCents !== undefined || patch.payment !== undefined) {
    const { data, error: lookupError } = await client
      .from("transactions")
      .select("installment_id")
      .eq("household_id", householdId)
      .eq("id", transactionId)
      .maybeSingle();
    if (lookupError !== null) {
      throw new Error(`updateTransaction lookup failed: ${lookupError.message}`);
    }
    if (data !== null && data.installment_id !== null) {
      throw new Error(
        "Parcelas são gerenciadas pelo grupo do parcelamento — edite o parcelamento, não a parcela avulsa.",
      );
    }
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm --filter @family-finance/db test && pnpm --filter @family-finance/db typecheck`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/repositories.ts packages/db/src/repositories.test.ts
git commit -m "feat(db): amount + payment-instrument edits in TransactionPatch, parcela-guarded"
```

---

### Task 2: web — createManualTransaction action + form-data mapping

**Files:**
- Modify: `apps/web/app/(app)/transactions/actions.ts` (new action)
- Modify: `apps/web/app/(app)/transactions/filters.ts` (extend `transactionPatchFromFormData` with amount + payment keys; new `manualEntryFromFormData` helper)
- Test: `apps/web/integration/transactions-page.test.ts` (follow its existing fake-supabase + action-call pattern)

**Interfaces:**
- Consumes: Task 1's `TransactionPatch` (`amountCents`, `payment`); domain `createTransactionDraft`, `brl`; db `createTransaction`; `parseReaisToCents` from `apps/web/lib/format.ts` (`(value: string) => number | null`, pt-BR + dot-decimal, `null` on garbage, 0 allowed — callers reject 0).
- Produces:
  ```ts
  // filters.ts
  export type ManualEntryInput = {
    kind: "expense" | "income";
    amountCents: number;
    description: string;
    occurredOn: string;                       // YYYY-MM-DD
    categoryId?: string;
    subcategoryId?: string;
    payment: { type: "account"; accountId: string }
           | { type: "card"; creditCardId: string };
    responsible: string;                      // "household" | member userId
  };
  export function manualEntryFromFormData(formData: FormData): ManualEntryInput; // throws pt-BR Error on bad input
  // actions.ts
  export async function createManualTransactionAction(
    formData: FormData,
  ): Promise<TransactionActionResult>;        // { ok, error? }
  ```
  Form field names (Task 3 must use exactly these): `kind`, `amount` (pt-BR string), `description`, `occurredOn`, `categoryId`, `subcategoryId`, `payment` (encoded `account:<id>` or `card:<id>`), `responsible`.
  Edit-row extra field names for `transactionPatchFromFormData`: `amount` (pt-BR string) and `payment` (same `account:`/`card:` encoding).

- [ ] **Step 1: Write the failing tests**

In `apps/web/integration/transactions-page.test.ts` (import `manualEntryFromFormData` from the page's `filters`, and follow the file's existing style for fakes):

```ts
describe("manualEntryFromFormData", () => {
  function form(entries: Record<string, string>): FormData {
    const fd = new FormData();
    for (const [k, v] of Object.entries(entries)) fd.set(k, v);
    return fd;
  }
  const base = {
    kind: "expense",
    amount: "56,13",
    description: "OpenAI",
    occurredOn: "2026-07-04",
    payment: "account:acct-1",
    responsible: "household",
  };

  it("parses a pt-BR amount into cents and decodes the payment", () => {
    const input = manualEntryFromFormData(form(base));
    expect(input.amountCents).toBe(5613);
    expect(input.payment).toEqual({ type: "account", accountId: "acct-1" });
    expect(input.kind).toBe("expense");
  });

  it("decodes a card payment", () => {
    const input = manualEntryFromFormData(form({ ...base, payment: "card:card-1" }));
    expect(input.payment).toEqual({ type: "card", creditCardId: "card-1" });
  });

  it("rejects a non-positive or unparseable amount in pt-BR", () => {
    expect(() => manualEntryFromFormData(form({ ...base, amount: "0" }))).toThrow(/valor/i);
    expect(() => manualEntryFromFormData(form({ ...base, amount: "abc" }))).toThrow(/valor/i);
  });

  it("rejects income paid by card", () => {
    expect(() =>
      manualEntryFromFormData(form({ ...base, kind: "income", payment: "card:card-1" })),
    ).toThrow(/entrada.*conta/i);
  });

  it("maps responsible member and casa", () => {
    expect(manualEntryFromFormData(form(base)).responsible).toBe("household");
    expect(
      manualEntryFromFormData(form({ ...base, responsible: "user-karol" })).responsible,
    ).toBe("user-karol");
  });
});

describe("transactionPatchFromFormData: amount + payment", () => {
  it("parses an edited amount (pt-BR) into amountCents", () => {
    const fd = new FormData();
    fd.set("amount", "45,90");
    expect(transactionPatchFromFormData(fd).amountCents).toBe(4590);
  });

  it("throws pt-BR on an unparseable amount", () => {
    const fd = new FormData();
    fd.set("amount", "quarenta");
    expect(() => transactionPatchFromFormData(fd)).toThrow(/valor/i);
  });

  it("decodes payment account:/card: values", () => {
    const fd = new FormData();
    fd.set("payment", "card:card-9");
    expect(transactionPatchFromFormData(fd).payment).toEqual({
      type: "card",
      creditCardId: "card-9",
    });
  });
});
```

Also add an end-to-end action test using the file's existing fake-supabase pattern (persisted row check) IF the file already tests `updateTransactionAction` that way; otherwise the two pure suites above are the test surface for this task and the action's happy path is covered in the existing `mvp-flow` style during Task 5's gate. (Do not invent a new fake pattern here.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm --filter @family-finance/web test -- integration/transactions-page.test.ts`
Expected: FAIL — `manualEntryFromFormData` not exported; `transactionPatchFromFormData` returns no `amountCents`/`payment`.

- [ ] **Step 3: Implement filters.ts**

Append to `apps/web/app/(app)/transactions/filters.ts`:

```ts
import { parseReaisToCents } from "../../../lib/format";

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export type ManualEntryInput = {
  kind: "expense" | "income";
  amountCents: number;
  description: string;
  occurredOn: string;
  categoryId?: string;
  subcategoryId?: string;
  payment:
    | { type: "account"; accountId: string }
    | { type: "card"; creditCardId: string };
  responsible: string;
};

/** Decode the form's "account:<id>" / "card:<id>" payment value. */
function decodePayment(
  raw: string,
): { type: "account"; accountId: string } | { type: "card"; creditCardId: string } {
  const [kind, id] = [raw.slice(0, raw.indexOf(":")), raw.slice(raw.indexOf(":") + 1)];
  if (kind === "account" && id !== "") return { type: "account", accountId: id };
  if (kind === "card" && id !== "") return { type: "card", creditCardId: id };
  throw new Error("Escolha a conta ou o cartão do lançamento.");
}

/** Parse a required pt-BR amount into positive integer cents. */
function requirePositiveCents(raw: string): number {
  const cents = parseReaisToCents(raw);
  if (cents === null || cents <= 0) {
    throw new Error('Não entendi o valor — use algo como "56,13".');
  }
  return cents;
}

/**
 * Translate the "Novo lançamento" FormData into a validated manual-entry
 * input. Throws pt-BR errors the action surfaces to the household as-is.
 */
export function manualEntryFromFormData(formData: FormData): ManualEntryInput {
  const kindRaw = formData.get("kind");
  const kind = kindRaw === "income" ? "income" : "expense";

  const amountCents = requirePositiveCents(String(formData.get("amount") ?? ""));

  const description = String(formData.get("description") ?? "").trim();
  if (description === "") {
    throw new Error("A descrição não pode ficar vazia.");
  }

  const occurredOn = String(formData.get("occurredOn") ?? "");
  if (!ISO_DATE_RE.test(occurredOn)) {
    throw new Error("Data inválida — use o formato AAAA-MM-DD.");
  }

  const payment = decodePayment(String(formData.get("payment") ?? ""));
  if (kind === "income" && payment.type === "card") {
    throw new Error("Entrada é sempre numa conta — escolha uma conta.");
  }

  const categoryId = String(formData.get("categoryId") ?? "");
  const subcategoryId = String(formData.get("subcategoryId") ?? "");
  const responsible = String(formData.get("responsible") ?? "household");

  return {
    kind,
    amountCents,
    description,
    occurredOn,
    ...(categoryId !== "" ? { categoryId } : {}),
    ...(subcategoryId !== "" ? { subcategoryId } : {}),
    payment,
    responsible: responsible === "" ? "household" : responsible,
  };
}
```

And extend `transactionPatchFromFormData` (before its `return patch;`):

```ts
  const amount = formData.get("amount");
  if (typeof amount === "string") {
    patch.amountCents = requirePositiveCents(amount);
  }

  const payment = formData.get("payment");
  if (typeof payment === "string" && payment !== "") {
    patch.payment = decodePayment(payment);
  }
```

- [ ] **Step 4: Implement the action**

In `apps/web/app/(app)/transactions/actions.ts` add (and update the module docblock's "Amount, kind and payment source are NOT editable" sentence — amount/payment now ARE, kind is not):

```ts
import { brl, createTransactionDraft } from "@family-finance/domain";
import { createTransaction } from "@family-finance/db";

import { manualEntryFromFormData } from "./filters";

/**
 * Create one manual transaction (despesa ou entrada) from the "Novo
 * lançamento" form. Validation runs through the shared domain
 * `createTransactionDraft` — the exact same choke point the bot and the
 * import flow use — and the income-needs-account rule is enforced here
 * server-side, not only in the UI.
 */
export async function createManualTransactionAction(
  formData: FormData,
): Promise<TransactionActionResult> {
  try {
    const { householdId, client } = await authedHousehold();
    const input = manualEntryFromFormData(formData);

    const {
      data: { user },
    } = await client.auth.getUser();
    if (user === null) {
      return { ok: false, error: "Sessão inválida. Faça login novamente." };
    }

    const draftResult = createTransactionDraft({
      householdId,
      kind: input.kind,
      amount: brl(input.amountCents),
      occurredOn: input.occurredOn,
      description: input.description,
      createdByUserId: user.id,
      payment: input.payment,
      responsibleUserId:
        input.responsible === "household" ? undefined : input.responsible,
      category:
        input.categoryId !== undefined
          ? { categoryId: input.categoryId, subcategoryId: input.subcategoryId }
          : undefined,
    });
    if (!draftResult.ok) {
      return {
        ok: false,
        error: draftResult.errors.map((e) => e.message).join(" "),
      };
    }

    await createTransaction(client, draftResult.value);
    revalidatePath("/transactions");
    revalidatePath("/dashboard");
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof Error
          ? error.message
          : "Não foi possível salvar o lançamento.",
    };
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @family-finance/web test -- integration/transactions-page.test.ts && pnpm --filter @family-finance/web typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add "apps/web/app/(app)/transactions/actions.ts" "apps/web/app/(app)/transactions/filters.ts" apps/web/integration/transactions-page.test.ts
git commit -m "feat(web): createManualTransaction action + amount/payment form mapping"
```

---

### Task 3: web — "Novo lançamento" panel + page wiring + dashboard button

**Files:**
- Create: `apps/web/app/(app)/transactions/new-transaction-form.tsx` (client component)
- Modify: `apps/web/app/(app)/transactions/page.tsx` (render the form; read `novo` param; pass accounts/cards/categories/subcategories/responsibles; `PageTitle` gains an action button)
- Modify: `apps/web/app/(app)/dashboard/page.tsx` (~line 115: `PageTitle` gains `actions={<Link className="ff-btn ff-btn--primary" href="/transactions?novo=1">+ Lançamento</Link>}`)
- Test: `apps/web/integration/transactions-page.test.ts` (render test via `renderToStaticMarkup`, same pattern as `ui-primitives.test.ts`)

**Interfaces:**
- Consumes: `createManualTransactionAction(formData): Promise<TransactionActionResult>` (Task 2); field names `kind`, `amount`, `description`, `occurredOn`, `categoryId`, `subcategoryId`, `payment` (`account:<id>`/`card:<id>`), `responsible`; option types `CategoryOption`, `SubcategoryOption`, `ResponsibleOption`, `PaymentOption` from `transactions-table.tsx`; ff primitives `Card`, `Field`, `Input`, `Select`, `Button`, `useToast`; `parseReaisToCents` for client-side pre-check.
- Produces: `export function NewTransactionForm(props: { accounts: PaymentOption[]; cards: PaymentOption[]; categories: CategoryOption[]; subcategories: SubcategoryOption[]; responsibles: ResponsibleOption[]; initiallyOpen: boolean }): ReactElement`.

- [ ] **Step 1: Write the failing render test**

In `apps/web/integration/transactions-page.test.ts`:

The integration test files are `.ts` (no JSX) — render with `createElement`, exactly like `ui-primitives.test.ts` does:

```ts
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NewTransactionForm } from "../app/(app)/transactions/new-transaction-form";

describe("NewTransactionForm", () => {
  const props = {
    accounts: [{ id: "acct-1", name: "Conta Corrente" }],
    cards: [{ id: "card-1", name: "Nubank" }],
    categories: [{ id: "cat-1", name: "Alimentação" }],
    subcategories: [{ id: "sub-1", categoryId: "cat-1", name: "Mercado" }],
    responsibles: [
      { value: "household", label: "Casa" },
      { value: "user-alvaro", label: "Alvaro" },
    ],
    initiallyOpen: true,
  };

  it("renders the open panel with every field and both payment options", () => {
    const html = renderToStaticMarkup(createElement(NewTransactionForm, props));
    expect(html).toContain("Novo lançamento");
    expect(html).toContain('name="amount"');
    expect(html).toContain('name="description"');
    expect(html).toContain('name="occurredOn"');
    expect(html).toContain('value="account:acct-1"');
    expect(html).toContain('value="card:card-1"');
    expect(html).toContain("Conta: Conta Corrente");
    expect(html).toContain("Cartão: Nubank");
  });

  it("starts collapsed (button only) when initiallyOpen is false", () => {
    const html = renderToStaticMarkup(
      createElement(NewTransactionForm, { ...props, initiallyOpen: false }),
    );
    expect(html).toContain("+ Lançamento");
    expect(html).not.toContain('name="amount"');
  });
});
```

Caveat: `NewTransactionForm` is a client component using `useToast` — if the toast context provider is required for render, wrap with the same provider `toast.test.ts` uses (check that file's pattern) or render inside the provider via `createElement(ToastProvider, null, createElement(NewTransactionForm, props))`.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @family-finance/web test -- integration/transactions-page.test.ts`
Expected: FAIL — module `new-transaction-form` does not exist.

- [ ] **Step 3: Implement the form component**

Create `apps/web/app/(app)/transactions/new-transaction-form.tsx`:

```tsx
"use client";

import { useState, useTransition } from "react";

import { Button, Card, Field, Input, Select, useToast } from "../../../components/ui";
import { parseReaisToCents } from "../../../lib/format";
import { createManualTransactionAction } from "./actions";
import type {
  CategoryOption,
  PaymentOption,
  ResponsibleOption,
  SubcategoryOption,
} from "./transactions-table";

/**
 * Inline "Novo lançamento" panel for /transactions (spec 2026-07-03): manual
 * expense/income entry. Collapsed by default; `?novo=1` (dashboard button)
 * renders it open. Client-side pre-checks give instant pt-BR feedback, but
 * the server action re-validates everything through the domain draft.
 */

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export function NewTransactionForm({
  accounts,
  cards,
  categories,
  subcategories,
  responsibles,
  initiallyOpen,
}: {
  accounts: PaymentOption[];
  cards: PaymentOption[];
  categories: CategoryOption[];
  subcategories: SubcategoryOption[];
  responsibles: ResponsibleOption[];
  initiallyOpen: boolean;
}) {
  const toast = useToast();
  const [open, setOpen] = useState(initiallyOpen);
  const [isSaving, startTransition] = useTransition();
  const [kind, setKind] = useState<"expense" | "income">("expense");
  const [amount, setAmount] = useState("");
  const [description, setDescription] = useState("");
  const [occurredOn, setOccurredOn] = useState(todayIso());
  const [categoryId, setCategoryId] = useState("");
  const [subcategoryId, setSubcategoryId] = useState("");
  const [payment, setPayment] = useState(
    accounts[0] !== undefined ? `account:${accounts[0].id}` : "",
  );
  const [responsible, setResponsible] = useState("household");
  const [fieldError, setFieldError] = useState<string | null>(null);

  const paymentOptions = [
    ...accounts.map((a) => ({ value: `account:${a.id}`, label: `Conta: ${a.name}` })),
    // Entrada é sempre numa conta — cartões saem da lista.
    ...(kind === "expense"
      ? cards.map((c) => ({ value: `card:${c.id}`, label: `Cartão: ${c.name}` }))
      : []),
  ];
  const visibleSubcategories = subcategories.filter(
    (s) => s.categoryId === categoryId,
  );

  function reset() {
    setKind("expense");
    setAmount("");
    setDescription("");
    setOccurredOn(todayIso());
    setCategoryId("");
    setSubcategoryId("");
    setPayment(accounts[0] !== undefined ? `account:${accounts[0].id}` : "");
    setResponsible("household");
    setFieldError(null);
  }

  function save() {
    const cents = parseReaisToCents(amount);
    if (cents === null || cents <= 0) {
      setFieldError('Não entendi o valor — use algo como "56,13".');
      return;
    }
    if (description.trim() === "") {
      setFieldError("A descrição não pode ficar vazia.");
      return;
    }
    if (payment === "") {
      setFieldError("Escolha a conta ou o cartão do lançamento.");
      return;
    }
    setFieldError(null);
    startTransition(async () => {
      const formData = new FormData();
      formData.set("kind", kind);
      formData.set("amount", amount);
      formData.set("description", description);
      formData.set("occurredOn", occurredOn);
      formData.set("categoryId", categoryId);
      formData.set("subcategoryId", subcategoryId);
      formData.set("payment", payment);
      formData.set("responsible", responsible);
      const result = await createManualTransactionAction(formData);
      if (!result.ok) {
        const message = result.error ?? "Não foi possível salvar o lançamento.";
        setFieldError(message);
        toast.error(message);
      } else {
        toast.success("Lançamento salvo.");
        reset();
        setOpen(false);
      }
    });
  }

  if (!open) {
    return (
      <div style={{ marginTop: 16 }}>
        <Button variant="primary" type="button" onClick={() => setOpen(true)}>
          + Lançamento
        </Button>
      </div>
    );
  }

  return (
    <Card style={{ marginTop: 16 }}>
      <h2 className="ff-card__title">Novo lançamento</h2>

      <div className="ff-form-grid">
        <Field label="Tipo">
          <Select
            value={kind}
            aria-label="Tipo"
            onChange={(e) => {
              const next = e.target.value === "income" ? "income" : "expense";
              setKind(next);
              // Entrada não pode ficar apontando pra um cartão.
              if (next === "income" && payment.startsWith("card:")) {
                setPayment(accounts[0] !== undefined ? `account:${accounts[0].id}` : "");
              }
            }}
          >
            <option value="expense">Despesa</option>
            <option value="income">Entrada</option>
          </Select>
        </Field>

        <Field label="Valor (R$)">
          <Input
            name="amount"
            value={amount}
            placeholder="56,13"
            inputMode="decimal"
            onChange={(e) => setAmount(e.target.value)}
          />
        </Field>

        <Field label="Descrição">
          <Input
            name="description"
            value={description}
            placeholder="ex.: mercado"
            onChange={(e) => setDescription(e.target.value)}
          />
        </Field>

        <Field label="Data">
          <Input
            type="date"
            name="occurredOn"
            value={occurredOn}
            onChange={(e) => setOccurredOn(e.target.value)}
          />
        </Field>

        <Field label="Categoria">
          <Select
            name="categoryId"
            value={categoryId}
            onChange={(e) => {
              setCategoryId(e.target.value);
              setSubcategoryId("");
            }}
          >
            <option value="">— sem categoria —</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="Subcategoria">
          <Select
            name="subcategoryId"
            value={subcategoryId}
            disabled={categoryId === ""}
            onChange={(e) => setSubcategoryId(e.target.value)}
          >
            <option value="">—</option>
            {visibleSubcategories.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="Pagamento">
          <Select
            name="payment"
            value={payment}
            onChange={(e) => setPayment(e.target.value)}
          >
            {paymentOptions.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="Responsável">
          <Select
            name="responsible"
            value={responsible}
            onChange={(e) => setResponsible(e.target.value)}
          >
            {responsibles.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      {fieldError !== null ? (
        <div role="alert" className="ff-alert ff-alert--negative" style={{ marginTop: 12 }}>
          {fieldError}
        </div>
      ) : null}

      <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
        <Button variant="primary" type="button" disabled={isSaving} onClick={save}>
          Salvar lançamento
        </Button>
        <Button variant="ghost" type="button" onClick={() => setOpen(false)}>
          Cancelar
        </Button>
      </div>
    </Card>
  );
}
```

Note on `ff-form-grid`: if this utility class does not exist in `components/ui/ui.css`, add it there (pure CSS — allowed by the firewall):

```css
.ff-form-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: 12px;
  margin-top: 12px;
}
```

Note on `Card`: if `Card` does not accept a `style` prop, wrap it in a `<div style={{ marginTop: 16 }}>` instead — do not modify the primitive.

Note on responsável default: the page cannot cheaply know which MEMBER the session user is (auth exposes email only), so the widget defaults to "Casa" as first option — spec's "default: logged-in member" is satisfied when trivial, otherwise skipped; do NOT add a new query for it. Mention in the PR notes.

- [ ] **Step 4: Wire the page + dashboard**

In `apps/web/app/(app)/transactions/page.tsx`:
- Import: `import { NewTransactionForm } from "./new-transaction-form";`
- After `const params = await searchParams;` add: `const novo = params.novo === "1";` (accept `string | string[]`: use the file's `first()` helper via `parseTransactionsSearchParams`? No — `first` is not exported; inline: `const novoRaw = params.novo; const novo = (Array.isArray(novoRaw) ? novoRaw[0] : novoRaw) === "1";`)
- Render between the load-error alert and the filter bar:

```tsx
      <NewTransactionForm
        accounts={accounts}
        cards={cards}
        categories={categories}
        subcategories={subcategories}
        responsibles={responsibles}
        initiallyOpen={novo}
      />
```

In `apps/web/app/(app)/dashboard/page.tsx`, add `import Link from "next/link";` (if absent) and change the `PageTitle` (~line 115) to:

```tsx
      <PageTitle
        kicker={`Nossa casa · ${formatMonthLabel(month)}`}
        title="O mês inteiro, de uma vez"
        lead="Quanto entrou, quanto sobrou, a pressão dos cartões e as caixinhas."
        actions={
          <Link className="ff-btn ff-btn--primary" href="/transactions?novo=1">
            + Lançamento
          </Link>
        }
      />
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @family-finance/web test && pnpm --filter @family-finance/web typecheck && pnpm --filter @family-finance/web build`
Expected: all PASS (build catches server/client boundary mistakes).

- [ ] **Step 6: Commit**

```bash
git add "apps/web/app/(app)/transactions/new-transaction-form.tsx" "apps/web/app/(app)/transactions/page.tsx" "apps/web/app/(app)/dashboard/page.tsx" apps/web/components/ui/ui.css apps/web/integration/transactions-page.test.ts
git commit -m "feat(web): manual transaction entry panel + dashboard shortcut"
```

---

### Task 4: web — amount + payment in the edit row

**Files:**
- Modify: `apps/web/app/(app)/transactions/transactions-table.tsx`
- Test: `apps/web/integration/transactions-page.test.ts`

**Interfaces:**
- Consumes: `patchRow(transactionId, fields)` already posts arbitrary `fields` to `updateTransactionAction`; Task 2's form-data keys `amount` (pt-BR string) and `payment` (`account:<id>`/`card:<id>`); `row.installmentId` (`string | null`), `row.kind`, `row.accountId`, `row.creditCardId` on `TransactionListItem`.
- Produces: UI only — no new exports.

- [ ] **Step 1: Write the failing render test**

In `apps/web/integration/transactions-page.test.ts` — render `TransactionsTable` via `createElement` (the file is `.ts`, no JSX; wrap in the toast provider if `useToast` requires it, same as Task 3's caveat). Build one fake row matching `TransactionListItem` (import the type from `@family-finance/db` and satisfy it fully — copy a literal from any existing usage in the integration tests if present):

```ts
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TransactionsTable } from "../app/(app)/transactions/transactions-table";

function renderTable(overrides: { installmentId: string | null; kind: "expense" | "income" }): string {
  const row = {
    id: "tx-1",
    description: "Mercado",
    occurredOn: "2026-07-04",
    amount: { currency: "BRL" as const, cents: 5613 },
    kind: overrides.kind,
    categoryId: null,
    subcategoryId: null,
    responsibilityScope: "household" as const,
    responsibleUserId: null,
    accountId: overrides.installmentId === null ? "acct-1" : null,
    creditCardId: overrides.installmentId === null ? null : "card-1",
    installmentId: overrides.installmentId,
    // ...fill any remaining required TransactionListItem fields with nulls —
    // typecheck will list them; do NOT cast to any.
  };
  return renderToStaticMarkup(
    createElement(TransactionsTable, {
      rows: [row as never],
      categories: [],
      subcategories: [],
      responsibles: [{ value: "household", label: "Casa" }],
      accounts: [{ id: "acct-1", name: "Conta Corrente" }],
      cards: [{ id: "card-1", name: "Nubank" }],
    }),
  );
}

describe("TransactionsTable: payment select", () => {
  it("renders a payment select for a normal row with account and card options", () => {
    const html = renderTable({ installmentId: null, kind: "expense" });
    expect(html).toContain('aria-label="Pagamento"');
    expect(html).toContain('value="account:acct-1"');
    expect(html).toContain('value="card:card-1"');
  });

  it("shows plain text (no select) for a parcela row", () => {
    const html = renderTable({ installmentId: "inst-1", kind: "expense" });
    expect(html).not.toContain('aria-label="Pagamento"');
  });

  it("offers only accounts for an income row", () => {
    const html = renderTable({ installmentId: null, kind: "income" });
    expect(html).toContain('value="account:acct-1"');
    expect(html).not.toContain('value="card:card-1"');
  });
});
```

(The `row as never` cast is a placeholder for the reader: replace it by satisfying the full `TransactionListItem` type — the typecheck run in Step 4 enforces this.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @family-finance/web test -- integration/transactions-page.test.ts`
Expected: FAIL — no `aria-label="Pagamento"` select exists.

- [ ] **Step 3: Implement**

In `transactions-table.tsx`:

1. Replace the read-only `paymentName(row)` cell (desktop column 3, line ~396, and reuse in the mobile expanded panel) with a select for non-parcela rows:

```tsx
  function paymentSelect(row: TransactionListItem, compact: boolean) {
    if (row.installmentId !== null) {
      // Parcelas: payment is managed via the installment group.
      return <span className="ff-dim">{paymentName(row)}</span>;
    }
    const value =
      row.creditCardId !== null
        ? `card:${row.creditCardId}`
        : row.accountId !== null
          ? `account:${row.accountId}`
          : "";
    return (
      <Select
        className={compact ? "ff-select--compact" : undefined}
        value={value}
        aria-label="Pagamento"
        onChange={(e) => patchRow(row.id, { payment: e.target.value })}
      >
        {accounts.map((a) => (
          <option key={a.id} value={`account:${a.id}`}>
            Conta: {a.name}
          </option>
        ))}
        {row.kind === "expense"
          ? cards.map((c) => (
              <option key={c.id} value={`card:${c.id}`}>
                Cartão: {c.name}
              </option>
            ))
          : null}
      </Select>
    );
  }
```

Desktop row: replace the `paymentName` `<span>` cell with `<span>{paymentSelect(row, true)}</span>`. Mobile expanded panel: add `{paymentSelect(row, false)}` alongside the other selects.

2. Amount edit: mirror the description pattern with its own state pair:

```tsx
  const [editingAmountId, setEditingAmountId] = useState<string | null>(null);
  const [amountDraft, setAmountDraft] = useState("");

  function commitAmount(row: TransactionListItem) {
    setEditingAmountId(null);
    const trimmed = amountDraft.trim();
    if (trimmed === "") return;
    // Server re-validates; this just posts the pt-BR string.
    patchRow(row.id, { amount: trimmed });
  }

  function amountCell(row: TransactionListItem, amount: { text: string; className: string }) {
    if (row.installmentId === null && editingAmountId === row.id) {
      return (
        <Input
          className="ff-input--compact ff-input--editing"
          value={amountDraft}
          autoFocus
          inputMode="decimal"
          aria-label="Editar valor"
          onChange={(e) => setAmountDraft(e.target.value)}
          onBlur={() => commitAmount(row)}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
            else if (e.key === "Escape") setEditingAmountId(null);
          }}
        />
      );
    }
    return (
      <button
        type="button"
        className={`ff-num ${amount.className}`}
        title={row.installmentId === null ? "Clique para editar o valor" : "Valor de parcela — edite o parcelamento"}
        disabled={row.installmentId !== null}
        style={{
          background: "none",
          border: "none",
          padding: 0,
          font: "inherit",
          fontWeight: 600,
          cursor: row.installmentId === null ? "text" : "default",
          textAlign: "right",
          whiteSpace: "nowrap",
        }}
        onClick={() => {
          if (row.installmentId !== null) return;
          setEditingAmountId(row.id);
          setAmountDraft((row.amount.cents / 100).toFixed(2).replace(".", ","));
        }}
      >
        {amount.text}
      </button>
    );
  }
```

Desktop row: replace the amount `<span>` (line ~401-410) with `<span style={{ textAlign: "right" }}>{amountCell(row, amount)}</span>`. Mobile: replace the `ff-txrow__amount` span content with `{amountCell(row, amount)}`.

3. Update the module docblock: amount/payment are now editable (kind is not; parcelas stay read-only for both).

- [ ] **Step 4: Run tests + full web suite**

Run: `pnpm --filter @family-finance/web test && pnpm --filter @family-finance/web typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add "apps/web/app/(app)/transactions/transactions-table.tsx" apps/web/integration/transactions-page.test.ts
git commit -m "feat(web): inline amount + payment-instrument editing on /transactions"
```

---

### Task 5: Full gate + docs

**Files:**
- Modify: `thoughts/notes/PROGRESS.md` (session entry + current state)
- Possibly touched: none (verification only)

**Interfaces:** none.

- [ ] **Step 1: Run the whole-repo gate**

```bash
pnpm typecheck && pnpm test && pnpm build && pnpm --filter @family-finance/web lint
```
Expected: 12/12 typecheck tasks, all test suites green, both builds green, lint clean (one pre-existing toast-timers warning is OK).

- [ ] **Step 2: Manual smoke against the local stack (if running)**

If the local Supabase + dev server are up: create one expense via the new form, one income, convert an account expense to a card, confirm a parcela row shows no payment select. If the stack is down, note it and rely on the test gate.

- [ ] **Step 3: Update PROGRESS.md and commit**

Append a session entry (what shipped, gotchas) and update the trailing Current state block.

```bash
git add thoughts/notes/PROGRESS.md
git commit -m "docs(thoughts): progress log — manual entry + payment edit shipped"
```
