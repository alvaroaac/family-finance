import { randomBytes, randomUUID } from "node:crypto";
import {
  brl,
  createInstallmentPlan,
  createTransactionDraft,
} from "@family-finance/domain";
import {
  normalizeMerchantKey,
  normalizeSourceCategoryLabel,
  MERCHANT_KEY_VERSION,
} from "@family-finance/categorization";
import {
  installmentGroupInsertFromPlan,
  installmentInsertPayloadsFromPlan,
  transactionInsertFromDraft,
  type AgentImportDatabase,
  type ConfirmImportV2Item,
  type InstallmentGroupRow,
} from "@family-finance/db";
import {
  ImportError,
  LIMITS,
  SCOPES,
  parseTool,
  scopeFor,
  type ToolName,
  type Draft,
  type DraftRow,
  type Candidate,
  type Catalog,
} from "./contracts.js";
import {
  append,
  applyChanges,
  assertEditable,
  canonical,
  expiresAt,
  hash,
  isDate,
  RECOVERY_MS,
  REVIEW_MS,
  review,
  summary,
  validateReferences,
  type ReviewEvidence,
} from "./review.js";

export type Suggestion = {
  row_id: string;
  category_id: string;
  subcategory_id?: string | null;
  explanation: string;
  confidence: number;
};
export type ServiceOptions = {
  origin: string;
  now?: () => number;
  suggest?: (draft: Draft, catalog: Catalog) => Promise<Suggestion[]>;
};
function inputFor<N extends ToolName>(n: N, input: unknown) {
  return parseTool(n, input);
}
export async function loadEvidence(
  db: AgentImportDatabase,
  d: Draft,
): Promise<ReviewEvidence & { groups: InstallmentGroupRow[] }> {
  const catalog = await db.catalog();
  const memory = await db.memory();
  const mappings = await db.mappings();
  const targets = d.rows
    .filter(
      (r) =>
        isDate(r.proposed.occurred_on) &&
        r.proposed.target &&
        Number.isSafeInteger(r.proposed.amount_cents),
    )
    .map((r) => ({
      target_id: r.proposed.target!.id,
      occurred_on: r.proposed.occurred_on,
      amount_cents: r.proposed.amount_cents,
      installment_count: r.proposed.installment?.count ?? null,
    }));
  const inventory = await db.candidates(targets);
  const transactionIndex = new Map<string, typeof inventory.transactions>();
  const transactionKey = (
    targetId: string,
    kind: string,
    date: string,
    amount: number,
    merchant: string,
  ) => canonical([targetId, kind, date, amount, merchant]);
  for (const t of inventory.transactions) {
    const key = transactionKey(
      `${t.account_id ? "account" : "card"}:${t.account_id ?? t.credit_card_id}`,
      t.kind,
      String(t.occurred_on).slice(0, 10),
      Number(t.amount_cents),
      normalizeMerchantKey(t.source_description),
    );
    const list = transactionIndex.get(key) ?? [];
    list.push(t);
    transactionIndex.set(key, list);
  }
  return {
    catalog,
    mappings,
    groups: inventory.groups,
    memory: memory
      .filter((m) => m.created_by_user_id !== null)
      .map((m) => ({
        id: m.id,
        householdId: m.household_id,
        pattern: m.pattern,
        categoryId: m.category_id,
        subcategoryId: m.subcategory_id,
        confidence: m.confidence,
        explanation: m.explanation,
        isActive: m.is_active,
        matchKind: m.match_kind ?? undefined,
        rowKind: m.row_kind,
        normalizerVersion: m.normalizer_version ?? undefined,
      })),
    candidates: (r: DraftRow): Candidate[] => {
      const p = r.proposed;
      const merchant = normalizeMerchantKey(r.observed.description_original);
      const matches: Candidate[] = (
        transactionIndex.get(
          transactionKey(
            `${p.target?.type}:${p.target?.id}`,
            p.kind === "refund" ? "income" : p.kind,
            p.occurred_on ?? "",
            p.amount_cents ?? 0,
            merchant,
          ),
        ) ?? []
      ).map((t) => ({
        id: t.id,
        type: "transaction",
        description: t.description,
        occurred_on: String(t.occurred_on).slice(0, 10),
        amount_cents: Number(t.amount_cents),
        exact: false,
        updated_at: String(t.updated_at),
      }));
      if (p.installment)
        matches.push(
          ...inventory.groups
            .filter(
              (g) =>
                g.credit_card_id === p.target?.id &&
                g.installment_count === p.installment?.count &&
                normalizeMerchantKey(g.description) === merchant &&
                Math.abs(
                  Number(g.total_amount_cents) / g.installment_count -
                    (p.amount_cents ?? 0),
                ) <= 1,
            )
            .map((g) => ({
              id: g.id,
              type: "installment_group" as const,
              description: g.description,
              occurred_on: String(g.purchased_on).slice(0, 10),
              amount_cents: Number(g.total_amount_cents),
              exact: false,
              updated_at: String(g.updated_at),
            })),
        );
      return matches;
    },
  };
}
export function snapshotHash(d: Draft): string {
  return hash({
    id: d.id,
    lineage: d.lineage_id,
    revision: d.revision,
    sources: d.sources,
    rows: d.rows,
  });
}
async function persist(db: AgentImportDatabase, d: Draft): Promise<void> {
  await db.saveDraft(d, new Date(expiresAt(d)).toISOString());
}
function requireRevision(d: Draft, revision: number): void {
  if (d.revision !== revision)
    throw new ImportError(
      "REVISION_CONFLICT",
      "Fetch the current draft and reapply intended edits.",
      { current_revision: d.revision },
    );
}
async function load(db: AgentImportDatabase, id: string): Promise<Draft> {
  const d = await db.loadDraft<Draft>(id);
  if (!d) throw new ImportError("NOT_FOUND", "Import not found.");
  return d;
}
export async function executeImport(
  db: AgentImportDatabase,
  name: ToolName,
  raw: unknown,
  options: ServiceOptions,
): Promise<Record<string, unknown>> {
  const input = parseTool(name, raw);
  const now = (options.now ?? Date.now)();
  const scopes = db.identity.browser ? [...SCOPES] : await db.scopes();
  if (!scopes.includes(scopeFor(name)))
    throw new ImportError(
      "SCOPE_REQUIRED",
      "Reconnect and grant the required import permission.",
    );
  // One household lock serializes review/commit with every other agent import.
  // The existing claim RPC provides a second persistence identity boundary.
  await db.lock("agent-import");
  if (name === "get_import_context")
    return {
      ...(await db.catalog()),
      schema_version: "1",
      limits: LIMITS,
      scopes,
      capabilities: {
        currency: "BRL",
        confirmation: "authenticated_review_link",
        recovery_hours: 24,
        review_minutes: 30,
        original_file_storage: false,
      },
    };
  if (name === "get_import" || name === "get_import_rows") {
    const d = await load(db, (input as { import_id: string }).import_id);
    if (d.state !== "committed" && expiresAt(d) + RECOVERY_MS <= now) {
      d.rows = [];
      d.sources = [];
      d.warnings = [];
      d.state = "expired";
    }
    if (name === "get_import") return summary(d, now);
    const query = inputFor("get_import_rows", raw);
    requireRevision(d, query.expected_revision);
    let offset = 0;
    if (query.cursor) {
      const parsed = /^(\d+):(\d+):([a-f0-9]{64})$/.exec(query.cursor);
      if (
        !parsed ||
        Number(parsed[1]) !== d.revision ||
        parsed[3] !== hash([d.id, query.included, query.issues_only])
      )
        throw new ImportError(
          "REVISION_CONFLICT",
          "Restart pagination for the current revision.",
        );
      offset = Number(parsed[2]);
    }
    const rows = d.rows.filter(
      (r) =>
        (query.included === undefined || r.included === query.included) &&
        (!query.issues_only || r.issues.length > 0),
    );
    return {
      import_id: d.id,
      revision: d.revision,
      rows: rows.slice(offset, offset + query.limit),
      total: rows.length,
      next_cursor:
        offset + query.limit < rows.length
          ? `${d.revision}:${offset + query.limit}:${hash([d.id, query.included, query.issues_only])}`
          : null,
    };
  }
  await db.cleanup();
  const mut = input as {
    idempotency_key: string;
    import_id?: string;
    expected_revision?: number;
  };
  const opKey = `${name}:${mut.import_id ?? "create"}:${mut.idempotency_key}`;
  const requestHash = hash(input);
  const replay = await db.operation(opKey);
  if (replay) {
    if (replay.request_hash !== requestHash)
      throw new ImportError(
        "IDEMPOTENCY_CONFLICT",
        "This request key was already used with different content.",
      );
    return {
      ...(replay.result as Record<string, unknown>),
      replayed: true,
      recovery_action:
        "Fetch current import state before editing; this response reflects the original operation.",
    };
  }
  let d: Draft;
  let result: Record<string, unknown>;
  let changedIds: string[] = [];
  if (name === "create_import") {
    const create = inputFor("create_import", raw);
    const id = randomUUID();
    d = {
      id,
      lineage_id: id,
      household_id: db.householdId,
      user_id: db.identity.userId,
      revision: 1,
      state: "collecting",
      created_at: new Date(now).toISOString(),
      collection_expires_at: new Date(now + REVIEW_MS).toISOString(),
      review_expires_at: null,
      sources: [],
      rows: [],
      warnings: [],
      receipt: null,
    };
    changedIds = append(d, create.sources, create.entries);
    const catalog = await db.catalog();
    for (const r of d.rows) {
      validateReferences(r, catalog);
    }
    await db.createLineage(id);
    await persist(db, d);
    result = {
      ...summary(d, now),
      row_ids: d.rows.map((r) => ({
        client_row_id: r.client_row_id,
        row_id: r.id,
      })),
    };
  } else {
    d = await load(db, mut.import_id!);
    const committedId = await db.lineage(d.lineage_id);
    if (name === "confirm_import" && d.state === "committed")
      return { ...summary(d, now), replayed: true };
    requireRevision(d, mut.expected_revision!);
    if (name === "renew_import") {
      if (d.state === "committed" || d.state === "cancelled" || committedId)
        throw new ImportError(
          "INVALID_REQUEST",
          "This lineage cannot be renewed.",
        );
      if (
        now < expiresAt(d) ||
        now > expiresAt(d) + RECOVERY_MS ||
        !d.rows.length
      )
        throw new ImportError(
          "DRAFT_EXPIRED",
          "Recovery is unavailable or the draft has not expired.",
        );
      d = structuredClone(d);
      d.id = randomUUID();
      d.revision = 1;
      d.state = "review";
      d.created_at = new Date(now).toISOString();
      d.collection_expires_at = new Date(now + REVIEW_MS).toISOString();
      d.review_expires_at = d.collection_expires_at;
      review(d, await loadEvidence(db, d));
      await persist(db, d);
      result = summary(d, now);
    } else {
      assertEditable(d, now);
      if (committedId)
        throw new ImportError(
          "INVALID_REQUEST",
          "Another generation already committed.",
        );
      if (name === "request_import_confirmation") {
        if (!summary(d, now).can_confirm)
          throw new ImportError(
            "VALIDATION_REQUIRED",
            "Prepare the draft and resolve included-row issues.",
          );
        const challenge = randomBytes(32).toString("base64url");
        await db.challenge(
          d.id,
          d.revision,
          snapshotHash(d),
          hash(challenge),
          new Date(expiresAt(d)).toISOString(),
        );
        result = {
          ...summary(d, now),
          review_url: `${options.origin}/imports/agent/${d.id}?challenge=${challenge}`,
          approval_required: true,
        };
      } else if (name === "confirm_import") {
        result = await commit(db, d, options, now);
      } else {
        const before = structuredClone(d);
        if (name === "cancel_import") {
          await db.scrubDraft(d.id);
          d.state = "cancelled";
          d.rows = [];
          d.sources = [];
          d.warnings = [];
        } else if (name === "append_import_entries") {
          const a = inputFor("append_import_entries", raw);
          changedIds = append(d, a.sources, a.entries);
          const catalog = await db.catalog();
          for (const row of d.rows) {
            validateReferences(row, catalog);
          }
        } else {
          const evidence = await loadEvidence(db, d);
          if (name === "update_import") {
            const patch = inputFor("update_import", raw);
            if (!patch.changes.length && !patch.source_changes.length)
              throw new ImportError(
                "INVALID_REQUEST",
                "Provide at least one change.",
              );
            changedIds = applyChanges(d, patch.changes, evidence.catalog);
            const seen = new Set<string>();
            for (const change of patch.source_changes) {
              if (seen.has(change.client_source_id))
                throw new ImportError(
                  "INVALID_REQUEST",
                  "Conflicting source coverage edits.",
                );
              seen.add(change.client_source_id);
              const source = d.sources.find(
                (s) => s.client_source_id === change.client_source_id,
              );
              if (!source)
                throw new ImportError("NOT_FOUND", "Source not found.");
              source.coverage = change.coverage;
            }
          }
          if (name === "prepare_import") {
            d.state = "review";
            d.review_expires_at ??= new Date(now + REVIEW_MS).toISOString();
          }
          review(d, await loadEvidence(db, d));
          if (name === "categorize_import") {
            if (d.state !== "review")
              throw new ImportError(
                "VALIDATION_REQUIRED",
                "Prepare the draft before categorizing.",
              );
            try {
              if (!options.suggest)
                d.warnings.push(
                  "AI suggestions are unavailable; manual review remains available.",
                );
              else {
                const suggestions = await options.suggest(
                  structuredClone(d),
                  evidence.catalog,
                );
                for (const s of suggestions) {
                  const r = d.rows.find((r) => r.id === s.row_id);
                  if (
                    !r ||
                    r.category_explicit ||
                    r.category_id ||
                    r.category_source !== "uncategorized" ||
                    r.proposed.kind !== "expense" ||
                    r.issues.some((i) => i.code === "MEMORY_CONFLICT")
                  )
                    continue;
                  if (
                    !evidence.catalog.categories.some(
                      (c) =>
                        c.id === s.category_id &&
                        c.kind === "expense" &&
                        c.is_active,
                    ) ||
                    (s.subcategory_id &&
                      !evidence.catalog.subcategories.some(
                        (c) =>
                          c.id === s.subcategory_id &&
                          c.category_id === s.category_id &&
                          c.is_active,
                      ))
                  )
                    continue;
                  r.category_id = s.category_id;
                  r.subcategory_id = s.subcategory_id ?? null;
                  r.category_source = "ai";
                  r.category_explanation = s.explanation;
                  r.issues.push({
                    code: "AI_SUGGESTION",
                    message: `Review suggested category (${Math.round(s.confidence * 100)}% confidence).`,
                    blocking: false,
                  });
                  changedIds.push(r.id);
                }
              }
            } catch {
              d.warnings.push(
                "AI suggestions failed; manual review remains available.",
              );
            }
          }
        }
        d.revision++;
        await db.invalidateApproval(d.id);
        await persist(db, d);
        const changed = d.rows
          .filter(
            (r) =>
              canonical(r) !==
              canonical(before.rows.find((b) => b.id === r.id)),
          )
          .map((r) => ({
            row_id: r.id,
            before: before.rows.find((b) => b.id === r.id) ?? null,
            after: r,
          }));
        if (name !== "cancel_import")
          await db.event(d.id, d.revision, {
            operation: name,
            changes: changed.slice(0, LIMITS.edit_targets),
            removed_rows: before.rows.length - d.rows.length,
            ...(name === "update_import"
              ? { requested_changes: inputFor("update_import", raw) }
              : {}),
          });
        result = {
          ...summary(d, now),
          changed_row_ids: [
            ...new Set([...changedIds, ...changed.map((c) => c.row_id)]),
          ],
          changes: changed.slice(0, LIMITS.edit_targets),
          previous_totals: summary(before, now).totals,
        };
      }
    }
  }
  await db.recordOperation(opKey, requestHash, result);
  return result;
}
export async function approveImport(
  db: AgentImportDatabase,
  id: string,
  revision: number,
  challenge: string,
  options: ServiceOptions,
): Promise<Record<string, unknown>> {
  if (!db.identity.browser)
    throw new ImportError(
      "AUTH_REQUIRED",
      "Use the authenticated review page.",
    );
  await db.lock("agent-import");
  const d = await load(db, id);
  const now = (options.now ?? Date.now)();
  assertEditable(d, now);
  requireRevision(d, revision);
  const a = await db.approval(id);
  if (
    !a ||
    a.revision !== revision ||
    a.challenge_hash !== hash(challenge) ||
    a.payload_hash !== snapshotHash(d) ||
    a.expires_at.getTime() <= now ||
    a.consumed_at
  )
    throw new ImportError(
      "APPROVAL_REQUIRED",
      "Request a new confirmation link.",
    );
  if (!summary(d, now).can_confirm)
    throw new ImportError("VALIDATION_REQUIRED", "Resolve the review issues.");
  await db.approve(id);
  return { ...summary(d, now), approved: true };
}
async function commit(
  db: AgentImportDatabase,
  d: Draft,
  options: ServiceOptions,
  now: number,
): Promise<Record<string, unknown>> {
  const a = await db.approval(d.id);
  if (
    !a?.approved_at ||
    a.consumed_at ||
    a.revision !== d.revision ||
    a.payload_hash !== snapshotHash(d) ||
    a.expires_at.getTime() <= now
  )
    throw new ImportError(
      "APPROVAL_REQUIRED",
      "Approve this exact revision on the review page.",
    );
  if (!summary(d, now).can_confirm)
    throw new ImportError(
      "VALIDATION_REQUIRED",
      "Resolve included-row validation issues.",
    );
  await db.lockFinancialWrites();
  const reviewed = structuredClone(d);
  const evidence = await loadEvidence(db, d);
  review(d, evidence);
  // AI choices remain the reviewed choices when deterministic inputs did not change.
  for (const r of d.rows) {
    const old = reviewed.rows.find((x) => x.id === r.id)!;
    if (
      old.category_source === "ai" &&
      r.category_source === "uncategorized" &&
      !r.category_explicit
    ) {
      r.category_id = old.category_id;
      r.subcategory_id = old.subcategory_id;
      r.category_source = old.category_source;
      r.category_explanation = old.category_explanation;
      r.issues.push(...old.issues.filter((i) => i.code === "AI_SUGGESTION"));
    }
  }
  if (snapshotHash(d) !== snapshotHash(reviewed)) {
    d.revision++;
    await db.invalidateApproval(d.id);
    await persist(db, d);
    return {
      error: {
        code: "REVIEW_CHANGED",
        message:
          "Catalog or duplicate candidates changed. Review the refreshed draft and approve again.",
      },
      ...summary(d, now),
    };
  }
  const occurrences = new Map<string, number>();
  const items: ConfirmImportV2Item[] = [];
  for (const [index, r] of d.rows.entries()) {
    const p = r.proposed;
    const audit = {
      household_id: db.householdId,
      source_line: index + 1,
      occurred_on: isDate(p.occurred_on) ? p.occurred_on : null,
      amount_cents: p.amount_cents,
      description: r.observed.description_original,
      category_source: r.category_source,
      category_accepted: r.category_explicit,
      category_changed: r.category_explicit,
      observed_installment_number: p.installment?.number,
      observed_installment_count: p.installment?.count,
    };
    if (!r.included) {
      items.push({ ...audit, disposition: "excluded" });
      continue;
    }
    const base = hash([
      db.householdId,
      p.target,
      p.occurred_on,
      p.amount_cents,
      p.kind,
      normalizeMerchantKey(r.observed.description_original),
    ]);
    const occurrence = (occurrences.get(base) ?? 0) + 1;
    occurrences.set(base, occurrence);
    const claims = await db.claims(base, occurrence);
    const claim = claims[0];
    if (
      claim &&
      r.match.decision !== "import_separate" &&
      !p.installment?.existing_group_id
    ) {
      d.revision++;
      r.match = { decision: "unresolved" };
      review(d, evidence);
      await db.invalidateApproval(d.id);
      await persist(db, d);
      return {
        error: {
          code: "REVIEW_CHANGED",
          message: "A matching import claim appeared. Review again.",
        },
        ...summary(d, now),
      };
    }
    const learning = r.learning.merchant
      ? {
          merchant_memory: {
            row_kind:
              p.kind === "income" ? ("income" as const) : ("expense" as const),
            category_id: r.category_id,
            subcategory_id: r.subcategory_id,
            suppress: r.category_id === null,
            pattern: normalizeMerchantKey(r.observed.description_original),
            confidence: 1,
            explanation: "Explicitly confirmed through agent import review.",
            match_kind: "merchant_exact" as const,
            normalizer_version: MERCHANT_KEY_VERSION,
          },
        }
      : undefined;
    const identity = {
      fingerprint_version: 1,
      base_fingerprint: base,
      occurrence_no: occurrence,
      ...(claim && r.match.decision === "import_separate"
        ? {
            override_token: r.id,
            override_of_claim_id: claim.id,
            override_reason: r.match.reason,
          }
        : {}),
      learning,
    };
    if (p.installment) {
      const i = p.installment;
      const existing = evidence.groups.find(
        (g) => g.id === i.existing_group_id,
      );
      const plan = createInstallmentPlan({
        householdId: db.householdId,
        creditCardId: p.target!.id,
        description: r.observed.description_original,
        totalAmount: brl(
          Number(existing?.total_amount_cents ?? i.total_amount_cents),
        ),
        installmentCount: i.count!,
        purchasedOn: existing
          ? String(existing.purchased_on).slice(0, 10)
          : i.purchased_on!,
        createdByUserId: d.user_id,
        responsibleUserId: p.responsible_user_id ?? undefined,
        category: {
          categoryId: r.category_id ?? undefined,
          subcategoryId: r.subcategory_id ?? undefined,
        },
        closingDay:
          evidence.catalog.cards.find((c) => c.id === p.target!.id)
            ?.closing_day ?? undefined,
      });
      if (!plan.ok)
        throw new ImportError(
          "VALIDATION_REQUIRED",
          "Invalid installment schedule.",
          { row_ids: [r.id], issues: plan.errors },
        );
      items.push({
        ...audit,
        ...identity,
        disposition: "imported",
        installment_group: {
          ...installmentGroupInsertFromPlan(plan.value, {
            idempotencyKey: r.id,
          }),
          purchase_description: p.purchase_description,
        },
        installments: existing
          ? []
          : installmentInsertPayloadsFromPlan(plan.value),
        ...(existing
          ? {
              existing_installment_group_id: existing.id,
              expected_group_updated_at: String(existing.updated_at),
              observed_due_month: p.occurred_on!.slice(0, 7),
            }
          : {}),
      });
    } else {
      const tx = createTransactionDraft({
        householdId: db.householdId,
        kind: p.kind === "refund" ? "income" : (p.kind as "income" | "expense"),
        amount: brl(p.amount_cents!),
        occurredOn: p.occurred_on!,
        description: p.purchase_description ?? r.observed.description_original,
        createdByUserId: d.user_id,
        payment:
          p.target!.type === "card"
            ? { type: "card", creditCardId: p.target!.id }
            : { type: "account", accountId: p.target!.id },
        responsibleUserId: p.responsible_user_id ?? undefined,
        category: {
          categoryId: r.category_id ?? undefined,
          subcategoryId: r.subcategory_id ?? undefined,
        },
      });
      if (!tx.ok)
        throw new ImportError("VALIDATION_REQUIRED", "Invalid transaction.", {
          row_ids: [r.id],
          issues: tx.errors,
        });
      items.push({
        ...audit,
        ...identity,
        disposition: "imported",
        transaction: transactionInsertFromDraft(tx.value),
      });
    }
  }
  const committed = await db.confirm(
    {
      household_id: db.householdId,
      created_by_user_id: d.user_id,
      source: "agent_structured",
      request_key: d.lineage_id,
      payload_fingerprint: snapshotHash(d),
      parser_version: "structured-v1",
    },
    items,
  );
  for (const r of d.rows.filter(
    (r) => r.included && r.learning.source_category,
  )) {
    const source = d.sources.find(
      (s) => s.client_source_id === r.client_source_id,
    )!;
    await db.learnSource({
      namespace: source.namespace!,
      normalized_label: normalizeSourceCategoryLabel(
        r.observed.source_category!,
      ),
      row_kind: r.proposed.kind === "income" ? "income" : "expense",
      category_id: r.category_id,
      subcategory_id: r.subcategory_id,
      suppress: r.category_id === null,
    });
  }
  const artifacts = await db.artifacts(committed.batch.id);
  d.state = "committed";
  d.receipt = {
    batch_id: committed.batch.id,
    committed_revision: d.revision,
    committed_at: new Date(now).toISOString(),
    actor: d.user_id,
    sources: d.sources,
    totals: summary(d, now).totals,
    transaction_ids: artifacts.transactions.map((t) => t.id),
    installment_group_ids: artifacts.groups.map((g) => g.id),
    dispositions: d.rows.map((r) => ({
      row_id: r.id,
      included: r.included,
      decision: r.match.decision,
      source_id: r.client_source_id,
      exclusion_reason: r.included
        ? null
        : (r.exclusion_reason ??
          r.match.reason ??
          r.issues.map((i) => i.message).join(" ")),
      issues: r.issues,
    })),
    learning_count: d.rows.filter(
      (r) => r.included && (r.learning.merchant || r.learning.source_category),
    ).length,
    link: `${options.origin}/imports/${committed.batch.id}`,
    counts: committed,
  };
  await db.commitLineage(d.lineage_id, d.id);
  await persist(db, d);
  return summary(d, now);
}
