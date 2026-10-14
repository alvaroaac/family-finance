import { brl, createInstallmentPlan } from "@family-finance/domain";
import { createHash, randomUUID } from "node:crypto";
import {
  planCategorizationBatch,
  matchMemory,
  normalizeMerchantKey,
  normalizeSourceCategoryLabel,
  type CategorizationMemoryEntry,
} from "@family-finance/categorization";
import {
  ImportError,
  LIMITS,
  type Draft,
  type DraftRow,
  type Entry,
  type Source,
  type Catalog,
  type Change,
  type Candidate,
} from "./contracts.js";

export const REVIEW_MS = 30 * 60 * 1000;
export const RECOVERY_MS = 24 * 60 * 60 * 1000;
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
export function hash(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}
export function expiresAt(d: Draft): number {
  return Date.parse(d.review_expires_at ?? d.collection_expires_at);
}
export function assertEditable(d: Draft, now: number): void {
  if (d.state === "committed" || d.state === "cancelled")
    throw new ImportError("INVALID_REQUEST", "This draft is immutable.");
  if (expiresAt(d) <= now)
    throw new ImportError(
      "DRAFT_EXPIRED",
      "Renew the expired draft before making changes.",
    );
}
export function isDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    return false;
  if (Number(value.slice(0, 4)) < 100) return false;
  const date = new Date(value + "T12:00:00Z");
  return (
    Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
  );
}
export function append(
  d: Draft,
  sources: Source[],
  entries: Entry[],
): string[] {
  const newSources = new Map(d.sources.map((s) => [s.client_source_id, s]));
  for (const source of sources) {
    const old = newSources.get(source.client_source_id);
    if (old && canonical(old) !== canonical(source))
      throw new ImportError(
        "IDEMPOTENCY_CONFLICT",
        "Source ID was reused with different content.",
      );
    newSources.set(source.client_source_id, source);
  }
  if (newSources.size > 200)
    throw new ImportError("LIMIT_EXCEEDED", "At most 200 sources are allowed.");
  const newRows = new Map(d.rows.map((r) => [r.client_row_id, r]));
  const added: string[] = [];
  for (const e of entries) {
    if (!newSources.has(e.client_source_id))
      throw new ImportError("INVALID_REQUEST", "Unknown source reference.");
    const old = newRows.get(e.client_row_id);
    if (old) {
      if (
        canonical(old.observed) !== canonical(e.observed) ||
        old.client_source_id !== e.client_source_id
      )
        throw new ImportError(
          "IDEMPOTENCY_CONFLICT",
          "Row ID was reused with different evidence.",
        );
      continue;
    }
    const row: DraftRow = {
      ...e,
      extraction_origin: "agent",
      id: randomUUID(),
      proposed: {
        ...e.proposed,
        target:
          e.proposed.target === undefined
            ? (newSources.get(e.client_source_id)?.default_target ?? null)
            : e.proposed.target,
      },
      included: false,
      inclusion_explicit: false,
      exclusion_reason: null,
      category_id: null,
      subcategory_id: null,
      category_explicit: false,
      category_source: "uncategorized",
      category_explanation: null,
      match: { decision: "unresolved" },
      candidates: [],
      issues: [],
      learning: { merchant: false, source_category: false },
    };
    newRows.set(e.client_row_id, row);
    added.push(row.id);
  }
  if (newRows.size > LIMITS.entries)
    throw new ImportError("LIMIT_EXCEEDED", "Draft exceeds 10,000 entries.");
  d.sources = [...newSources.values()];
  d.rows = [...newRows.values()];
  d.state = "collecting";
  return added;
}
export function validateReferences(row: DraftRow, catalog: Catalog): void {
  const p = row.proposed;
  const target = p.target;
  if (
    target &&
    !(target.type === "card" ? catalog.cards : catalog.accounts).some(
      (x) => x.id === target.id,
    )
  )
    throw new ImportError("NOT_FOUND", "Instrument not found.", {
      row_ids: [row.id],
    });
  if (
    p.responsible_user_id &&
    !catalog.members.some((x) => x.user_id === p.responsible_user_id)
  )
    throw new ImportError("NOT_FOUND", "Responsible member not found.", {
      row_ids: [row.id],
    });
  if (
    row.category_id &&
    !catalog.categories.some((x) => x.id === row.category_id && x.is_active)
  )
    throw new ImportError("NOT_FOUND", "Category not found.", {
      row_ids: [row.id],
    });
  if (
    row.subcategory_id &&
    !catalog.subcategories.some(
      (x) =>
        x.id === row.subcategory_id &&
        x.category_id === row.category_id &&
        x.is_active,
    )
  )
    throw new ImportError("NOT_FOUND", "Subcategory not found.", {
      row_ids: [row.id],
    });
}
export type Mapping = {
  namespace: string;
  normalized_label: string;
  row_kind: string;
  category_id: string | null;
  subcategory_id: string | null;
  suppress: boolean;
};
export type ReviewEvidence = {
  groups?: {
    id: string;
    total_amount_cents: number;
    purchased_on: string;
    updated_at: string;
    category_id: string | null;
    subcategory_id: string | null;
    responsible_user_id: string | null;
    purchase_description?: string | null;
  }[];
  catalog: Catalog;
  memory: CategorizationMemoryEntry[];
  mappings: Mapping[];
  candidates: (row: DraftRow) => Candidate[];
};
function financialSignature(r: DraftRow): unknown {
  const p = r.proposed;
  return [
    p.occurred_on,
    p.amount_cents,
    p.kind,
    p.target,
    p.installment,
    r.candidates.map((c) => [c.id, c.updated_at, c.exact]),
  ];
}
export function review(d: Draft, evidence: ReviewEvidence): void {
  const { catalog, memory } = evidence;
  d.warnings = [];
  const peerKey = (r: DraftRow) =>
    canonical([
      r.proposed.target,
      r.proposed.occurred_on,
      r.proposed.amount_cents,
      r.proposed.kind,
      normalizeMerchantKey(r.observed.description_original),
    ]);
  const peers = new Map<string, DraftRow[]>();
  for (const row of d.rows) {
    if (row.inclusion_explicit && !row.included) continue;
    const key = peerKey(row);
    const list = peers.get(key) ?? [];
    list.push(row);
    peers.set(key, list);
  }
  for (const r of d.rows) {
    validateReferences(r, catalog);
    r.issues = [];
    const p = r.proposed;
    const issue = (
      code: string,
      field: string,
      message: string,
      blocking = true,
    ) => r.issues.push({ code, field, message, blocking });
    if (!(p.purchase_description ?? r.observed.description_original).trim())
      issue(
        "DESCRIPTION_REQUIRED",
        "purchase_description",
        "Provide a readable purchase description.",
      );
    if (
      p.installment &&
      ((p.purchase_description?.trim().length ?? 0) > 200 ||
        p.purchase_description?.trim() === "" ||
        r.observed.description_original.length > 200)
    )
      issue(
        "DESCRIPTION_LIMIT",
        "purchase_description",
        "Installment descriptions must contain 1 to 200 characters.",
      );
    if (
      r.learning.merchant &&
      (!normalizeMerchantKey(r.observed.description_original) ||
        normalizeMerchantKey(r.observed.description_original).length > 200)
    )
      issue(
        "LEARNING_EVIDENCE_REQUIRED",
        "learning",
        "Merchant learning requires a usable original descriptor of at most 200 characters.",
      );
    if (!isDate(p.occurred_on))
      issue(
        "DATE_REQUIRED",
        "occurred_on",
        "Provide a real date including the year.",
      );
    if (!Number.isSafeInteger(p.amount_cents) || (p.amount_cents ?? 0) <= 0)
      issue(
        "AMOUNT_REQUIRED",
        "amount_cents",
        "Provide a positive amount in integer cents.",
      );
    if (p.currency !== "BRL")
      issue("CURRENCY_REQUIRED", "currency", "Only BRL is supported.");
    if (!p.target)
      issue("TARGET_REQUIRED", "target", "Choose an existing account or card.");
    if (p.posting_status !== "posted")
      issue(
        "NOT_POSTED",
        "posting_status",
        "Pending or unknown entries cannot be booked.",
      );
    if (["card_payment", "transfer", "unknown"].includes(p.kind))
      issue(
        "UNSUPPORTED_KIND",
        "kind",
        "This financial operation cannot be booked through imports.",
      );
    if (
      (p.kind === "refund" && p.target?.type !== "card") ||
      (p.kind === "income" && p.target?.type === "card")
    )
      issue(
        "UNSUPPORTED_KIND",
        "kind",
        "Use the supported card refund or account income semantics.",
      );
    for (const u of r.uncertainties) issue(u.code, u.field, u.explanation);
    const i = p.installment;
    if (i) {
      if (p.target?.type !== "card" || p.kind !== "expense")
        issue(
          "INSTALLMENT_INVALID",
          "installment",
          "Installments require an expense on a card.",
        );
      if (
        !i.count ||
        i.count < 2 ||
        i.count > 120 ||
        !i.number ||
        i.number < 1 ||
        i.number > i.count
      )
        issue(
          "INSTALLMENT_INVALID",
          "installment",
          "Review the installment position and count.",
        );
      if (
        !i.existing_group_id &&
        (!isDate(i.purchased_on) ||
          !Number.isSafeInteger(i.total_amount_cents) ||
          (i.total_amount_cents ?? 0) <= 0)
      )
        issue(
          "INSTALLMENT_TOTAL_REQUIRED",
          "installment",
          "Review purchase date and exact total.",
        );
      if (i.inferred && !i.inference_accepted)
        issue(
          "INFERENCE_ACCEPTANCE_REQUIRED",
          "installment",
          "Explicitly accept the inferred purchase information.",
        );
      if (
        !i.existing_group_id &&
        i.total_amount_cents &&
        isDate(i.purchased_on) &&
        i.count &&
        p.target?.type === "card"
      ) {
        const plan = createInstallmentPlan({
          householdId: d.household_id,
          creditCardId: p.target.id,
          description: r.observed.description_original,
          totalAmount: brl(i.total_amount_cents),
          installmentCount: i.count,
          purchasedOn: i.purchased_on,
          createdByUserId: d.user_id,
          closingDay:
            catalog.cards.find((c) => c.id === p.target!.id)?.closing_day ??
            undefined,
        });
        if (!plan.ok)
          issue(
            "INSTALLMENT_INVALID",
            "installment",
            "The approved total cannot generate a valid installment schedule.",
          );
        else if (
          plan.value.installments[(i.number ?? 1) - 1]?.amount.cents !==
          p.amount_cents
        )
          issue(
            "INSTALLMENT_AMOUNT_MISMATCH",
            "installment",
            "The observed installment differs from the generated schedule. Review total and position.",
          );
      }
    }
    const existingCandidates = evidence.candidates(r);
    const peerCandidates = p.target ? (peers.get(peerKey(r)) ?? []) : [];
    const candidateCount =
      existingCandidates.length +
      peerCandidates.length -
      (peerCandidates.some((other) => other.id === r.id) ? 1 : 0);
    if (candidateCount > LIMITS.match_candidates)
      issue(
        "CANDIDATE_LIMIT",
        "match",
        `${candidateCount} possible matches exceed the ${LIMITS.match_candidates}-candidate review limit. Exclude repeated source rows or narrow the intake.`,
      );
    r.candidates = existingCandidates.slice(0, LIMITS.match_candidates);
    for (const other of peerCandidates) {
      if (r.candidates.length >= LIMITS.match_candidates) break;
      if (other.id !== r.id)
        r.candidates.push({
          id: other.id,
          type: "draft_row",
          description: other.observed.description_original,
          occurred_on: p.occurred_on ?? "",
          amount_cents: p.amount_cents ?? 0,
          exact: false,
        });
    }
    r.candidates.sort((a, b) => a.id.localeCompare(b.id));
    const signature = hash(financialSignature(r));
    if (r.match.signature && r.match.signature !== signature)
      r.match = { decision: "unresolved" };
    r.match.signature = signature;
    if (
      i?.existing_group_id &&
      !r.candidates.some(
        (c) => c.id === i.existing_group_id && c.type === "installment_group",
      )
    )
      issue(
        "MATCH_REQUIRED",
        "installment",
        "Select a compatible existing installment group.",
      );
    if (r.candidates.length && !i?.existing_group_id) {
      if (r.match.decision === "unresolved")
        issue(
          "MATCH_REQUIRED",
          "match",
          "Review possible duplicates before inclusion.",
        );
      if (
        r.match.decision === "import_separate" &&
        r.candidates.some((c) => c.exact)
      )
        issue(
          "EXACT_DUPLICATE",
          "match",
          "An exact claim cannot be imported again.",
        );
      if (
        r.match.candidate_id &&
        !r.candidates.some((c) => c.id === r.match.candidate_id)
      )
        issue(
          "MATCH_REQUIRED",
          "match",
          "The selected candidate is no longer available.",
        );
    }
    if (r.match.decision === "keep_existing") r.included = false;
    if (!r.category_explicit && !i?.existing_group_id) {
      r.category_id = null;
      r.subcategory_id = null;
      r.category_source = "uncategorized";
      r.category_explanation = null;
      const kind = p.kind === "income" ? "income" : "expense";
      const description =
        p.purchase_description ?? r.observed.description_original;
      const context = {
        householdId: d.household_id,
        description,
        kind,
      } as const;
      const matches = memory.filter((m) => matchMemory(context, [m]) !== null);
      const best = matchMemory(context, matches);
      const equals = best
        ? matches.filter(
            (m) =>
              m.pattern.length === best.pattern.length &&
              (m.matchKind ?? "description_contains") ===
                (best.matchKind ?? "description_contains"),
          )
        : [];
      const conflict =
        new Set(
          equals.map(
            (m) =>
              `${m.categoryId}:${m.subcategoryId}:${m.matchKind === "suppress"}`,
          ),
        ).size > 1;
      if (conflict) {
        issue(
          "MEMORY_CONFLICT",
          "category",
          "Conflicting confirmed memories need an explicit category choice.",
        );
      } else {
        const plan = planCategorizationBatch(
          [
            {
              rowKey: r.id,
              householdId: d.household_id,
              description,
              kind,
              amountCents: p.amount_cents ?? undefined,
              occurredOn: p.occurred_on ?? undefined,
            },
          ],
          {
            catalog: {
              householdId: d.household_id,
              categories: catalog.categories.filter(
                (c) => c.is_active && c.kind === kind,
              ),
              subcategories: catalog.subcategories
                .filter((c) => c.is_active)
                .map((c) => ({
                  id: c.id,
                  categoryId: c.category_id,
                  name: c.name,
                })),
            },
            memoryEntries: memory,
            maxAiSignatures: 0,
          },
        ).rows[0];
        if (plan?.selection) {
          r.category_id = plan.selection.categoryId;
          r.subcategory_id = plan.selection.subcategoryId ?? null;
          r.category_source = plan.selection.source;
          r.category_explanation = plan.candidates[0]?.explanation ?? null;
        } else if (plan?.status === "suppressed") {
          r.category_source = "memory";
          r.category_explanation = plan.suppressionExplanation ?? null;
        }
        const source = d.sources.find(
          (s) => s.client_source_id === r.client_source_id,
        )!;
        if (!best && source.namespace && r.observed.source_category) {
          const mappings = evidence.mappings.filter(
            (m) =>
              m.namespace === source.namespace &&
              m.row_kind === kind &&
              m.normalized_label ===
                normalizeSourceCategoryLabel(r.observed.source_category!),
          );
          if (
            new Set(
              mappings.map(
                (m) => `${m.category_id}:${m.subcategory_id}:${m.suppress}`,
              ),
            ).size > 1
          )
            issue(
              "MEMORY_CONFLICT",
              "category",
              "Conflicting source mappings need review.",
            );
          else if (mappings[0]) {
            r.category_id = mappings[0].suppress
              ? null
              : mappings[0].category_id;
            r.subcategory_id = mappings[0].suppress
              ? null
              : mappings[0].subcategory_id;
            r.category_source = "source_mapping";
          }
        }
      }
    }
    if (
      r.category_id &&
      !catalog.categories.some(
        (c) =>
          c.id === r.category_id &&
          c.kind === (p.kind === "income" ? "income" : "expense") &&
          c.is_active,
      )
    )
      issue(
        "CATEGORY_KIND",
        "category",
        "Choose a category compatible with this entry.",
      );
    if (
      r.subcategory_id &&
      !catalog.subcategories.some(
        (c) =>
          c.id === r.subcategory_id &&
          c.category_id === r.category_id &&
          c.is_active,
      )
    )
      issue(
        "SUBCATEGORY_INVALID",
        "category",
        "Review the subcategory selection.",
      );
    const linked = i?.existing_group_id
      ? evidence.groups?.find((g) => g.id === i.existing_group_id)
      : undefined;
    if (linked && i) {
      if (
        (r.category_explicit &&
          (r.category_id !== linked.category_id ||
            r.subcategory_id !== linked.subcategory_id)) ||
        (p.purchase_description !== undefined &&
          p.purchase_description !== (linked.purchase_description ?? null)) ||
        (p.responsible_user_id !== undefined &&
          p.responsible_user_id !== linked.responsible_user_id)
      )
        issue(
          "EXISTING_PURCHASE_UNCHANGED",
          "installment",
          "Linking a recorded purchase cannot change its category, description or responsibility. Edit that purchase separately.",
        );
      r.category_id = linked.category_id;
      r.subcategory_id = linked.subcategory_id;
      r.category_source = "existing_group";
      p.purchase_description = linked.purchase_description ?? null;
      p.responsible_user_id = linked.responsible_user_id;
      if (
        i.total_amount_cents != null &&
        i.total_amount_cents !== Number(linked.total_amount_cents)
      )
        issue(
          "EXISTING_PURCHASE_UNCHANGED",
          "installment",
          "The existing purchase total differs from the proposed total.",
        );
      i.total_amount_cents = Number(linked.total_amount_cents);
      i.purchased_on = String(linked.purchased_on).slice(0, 10);
    }
    if (
      r.learning.source_category &&
      (!d.sources.find((s) => s.client_source_id === r.client_source_id)
        ?.namespace ||
        !r.observed.source_category)
    )
      issue(
        "NAMESPACE_REQUIRED",
        "learning",
        "Source learning requires a known institution/format namespace and source label.",
      );
    if (
      (r.learning.merchant || r.learning.source_category) &&
      !r.category_explicit
    )
      issue(
        "LEARNING_CHOICE_REQUIRED",
        "learning",
        "Choose the category explicitly before teaching it.",
      );
    r.match.signature = hash(financialSignature(r));
    if (!r.inclusion_explicit)
      r.included =
        r.issues.every((x) => !x.blocking) &&
        r.match.decision !== "keep_existing";
  }
  const learning = new Map<string, string>();
  for (const r of d.rows.filter((r) => r.included)) {
    const key = `${r.proposed.kind}:${normalizeMerchantKey(r.observed.description_original)}`;
    const value = `${r.category_id}:${r.subcategory_id}`;
    if (r.learning.source_category) {
      const source = d.sources.find(
        (s) => s.client_source_id === r.client_source_id,
      );
      const sourceKey = `source:${source?.namespace}:${r.proposed.kind}:${normalizeSourceCategoryLabel(r.observed.source_category ?? "")}`;
      if (learning.has(sourceKey) && learning.get(sourceKey) !== value)
        r.issues.push({
          code: "LEARNING_CONFLICT",
          message: "Conflicting source category teaching choices.",
          blocking: true,
        });
      learning.set(sourceKey, value);
    }
    if (r.learning.merchant) {
      if (learning.has(key) && learning.get(key) !== value)
        r.issues.push({
          code: "LEARNING_CONFLICT",
          message: "Conflicting merchant teaching choices.",
          blocking: true,
        });
      learning.set(key, value);
    }
  }
  for (const s of d.sources) {
    if (s.coverage !== "complete")
      d.warnings.push(
        `${s.label ?? s.client_source_id}: ${s.coverage === "partial" ? "fonte parcial" : "abrangência desconhecida"}.`,
      );
    if (s.comparable_total_cents != null) {
      const total = d.rows
        .filter((r) => r.client_source_id === s.client_source_id)
        .reduce(
          (n, r) =>
            n +
            (r.proposed.amount_cents ?? 0) *
              (r.proposed.kind === "refund" || r.proposed.kind === "income"
                ? -1
                : 1),
          0,
        );
      if (total !== s.comparable_total_cents)
        d.warnings.push(
          `${s.label ?? s.client_source_id}: extracted subtotal differs from the comparable source total.`,
        );
    }
  }
}
export function applyChanges(
  d: Draft,
  changes: Change[],
  catalog: Catalog,
): string[] {
  const count = changes.reduce((n, c) => n + c.row_ids.length, 0);
  if (count > LIMITS.edit_targets)
    throw new ImportError("LIMIT_EXCEEDED", "Edit exceeds 500 row targets.");
  const touched = new Map<string, Set<string>>();
  for (const c of changes)
    for (const id of c.row_ids) {
      const r = d.rows.find((r) => r.id === id);
      if (!r) throw new ImportError("NOT_FOUND", "Row not found.");
      const keys =
        c.action === "set_fields"
          ? Object.keys(c.fields)
          : [c.action.includes("category") ? "category" : c.action];
      const used = touched.get(id) ?? new Set<string>();
      if (keys.some((k) => used.has(k)))
        throw new ImportError(
          "INVALID_REQUEST",
          "Conflicting actions on the same field.",
          { row_ids: [id] },
        );
      keys.forEach((k) => used.add(k));
      touched.set(id, used);
      if (c.action === "set_fields") {
        if ("purchase_description" in c.fields) {
          r.category_source = "uncategorized";
          r.learning = { merchant: false, source_category: false };
        }
        r.proposed = { ...r.proposed, ...c.fields };
        r.uncertainties = r.uncertainties.filter(
          (u) =>
            !Object.keys(c.fields).some(
              (k) => u.field === k || u.field === `proposed.${k}`,
            ),
        );
        if (
          keys.some((k) =>
            [
              "amount_cents",
              "occurred_on",
              "target",
              "kind",
              "installment",
              "posting_status",
            ].includes(k),
          )
        )
          r.match = { decision: "unresolved" };
      } else if (c.action === "set_category") {
        r.category_id = c.category_id;
        r.subcategory_id = c.subcategory_id ?? null;
        r.category_explicit = true;
        r.category_source = "user";
      } else if (c.action === "clear_category") {
        r.category_id = null;
        r.subcategory_id = null;
        r.category_explicit = true;
        r.category_source = "user";
      } else if (c.action === "reset_category_to_auto") {
        r.category_explicit = false;
        r.learning = { merchant: false, source_category: false };
      } else if (c.action === "set_included") {
        r.included = c.included;
        r.exclusion_reason = c.included ? null : c.reason;
        r.inclusion_explicit = true;
      } else if (c.action === "resolve_match") {
        r.match = {
          decision: c.decision,
          candidate_id: c.candidate_id,
          reason: c.reason,
          signature: r.match.signature,
        };
        if (c.decision === "keep_existing") {
          r.included = false;
          r.inclusion_explicit = true;
        }
      } else if (c.action === "set_learning")
        r.learning = {
          merchant: c.merchant,
          source_category: c.source_category,
        };
      validateReferences(r, catalog);
    }
  return [...touched.keys()];
}
export function summary(d: Draft, now = Date.now()): Record<string, unknown> {
  const expired =
    !["committed", "cancelled"].includes(d.state) && expiresAt(d) <= now;
  const selected = d.rows.filter((r) => r.included);
  const totals: Record<
    string,
    { outflow_cents: number; inflow_cents: number }
  > = {};
  for (const r of selected) {
    const target = r.proposed.target;
    if (!target) continue;
    const t = totals[`${target.type}:${target.id}`] ?? {
      outflow_cents: 0,
      inflow_cents: 0,
    };
    const amount = r.proposed.amount_cents;
    if (Number.isSafeInteger(amount) && amount! > 0) {
      if (["income", "refund"].includes(r.proposed.kind))
        t.inflow_cents += amount!;
      else t.outflow_cents += amount!;
    }
    if (
      !Number.isSafeInteger(t.inflow_cents) ||
      !Number.isSafeInteger(t.outflow_cents)
    )
      throw new ImportError(
        "LIMIT_EXCEEDED",
        "Selected totals exceed the safe integer cents limit.",
      );
    totals[`${target.type}:${target.id}`] = t;
  }
  const blocking = selected.reduce(
    (n, r) => n + r.issues.filter((i) => i.blocking).length,
    0,
  );
  return {
    import_id: d.id,
    lineage_id: d.lineage_id,
    revision: d.revision,
    state: expired ? "expired" : d.state,
    expires_at: new Date(expiresAt(d)).toISOString(),
    sources: d.sources,
    counts: {
      total: d.rows.length,
      selected: selected.length,
      excluded: d.rows.length - selected.length,
      rows_with_issues: d.rows.filter((r) => r.issues.length).length,
    },
    totals,
    blocking_issues: blocking,
    can_confirm:
      d.state === "review" && !expired && selected.length > 0 && blocking === 0,
    warnings: d.warnings,
    learning_count: selected.filter(
      (r) => r.learning.merchant || r.learning.source_category,
    ).length,
    receipt: d.receipt,
  };
}
