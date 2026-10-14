import { z } from "zod";

export const LIMITS = {
  entries: 10_000,
  append: 200,
  page: 100,
  match_candidates: 50,
  edit_targets: 500,
  request_bytes: 2 * 1024 * 1024,
} as const;
export const SCOPES = [
  "finance:context:read",
  "imports:read",
  "imports:prepare",
  "imports:commit",
] as const;
export type Scope = (typeof SCOPES)[number];
const text = z.string().max(1000);
const id = z.string().uuid();
const clientId = z.string().min(1).max(100);
export const targetSchema = z
  .object({ type: z.enum(["account", "card"]), id })
  .strict();
export const installmentSchema = z
  .object({
    number: z.number().int().nullable().optional(),
    count: z.number().int().nullable().optional(),
    purchased_on: z.string().max(30).nullable().optional(),
    total_amount_cents: z.number().int().safe().nullable().optional(),
    inferred: z.boolean().default(false),
    inference_accepted: z.boolean().default(false),
    existing_group_id: id.nullable().optional(),
  })
  .strict();
export const fieldsSchema = z
  .object({
    occurred_on: z.string().max(30).nullable().optional(),
    amount_cents: z.number().int().safe().nullable().optional(),
    currency: z.string().max(10).nullable().optional(),
    kind: z
      .enum([
        "expense",
        "income",
        "refund",
        "card_payment",
        "transfer",
        "unknown",
      ])
      .default("unknown"),
    posting_status: z.enum(["posted", "pending", "unknown"]).default("unknown"),
    target: targetSchema.nullable().optional(),
    responsible_user_id: id.nullable().optional(),
    purchase_description: text.nullable().optional(),
    installment: installmentSchema.nullable().optional(),
  })
  .strict();
export const sourceSchema = z
  .object({
    client_source_id: clientId,
    type: z.enum([
      "browser_statement",
      "pdf",
      "csv",
      "ofx",
      "spreadsheet",
      "image",
      "pasted_text",
      "manual",
    ]),
    coverage: z.enum(["complete", "partial", "unknown"]),
    label: text.optional(),
    institution: z.string().max(100).optional(),
    namespace: z
      .string()
      .regex(/^[a-z0-9][a-z0-9._-]{1,49}:[a-z0-9][a-z0-9._-]{1,49}$/i)
      .optional(),
    period_start: z.string().max(30).optional(),
    period_end: z.string().max(30).optional(),
    reference_month: z.string().max(7).optional(),
    filename: z.string().max(255).optional(),
    captured_at: z.string().datetime().optional(),
    comparable_total_cents: z.number().int().safe().nullable().optional(),
    default_target: targetSchema.nullable().optional(),
  })
  .strict();
export const entrySchema = z
  .object({
    client_row_id: clientId,
    client_source_id: clientId,
    observed: z
      .object({
        description_original: text,
        evidence_text: z.string().max(2000).optional(),
        locator: z.string().max(500).optional(),
        source_category: z.string().max(200).optional(),
        provider_reference: z
          .object({
            id: z.string().max(200),
            institution: z.string().max(100),
            origin: z.literal("agent"),
          })
          .strict()
          .optional(),
      })
      .strict(),
    proposed: fieldsSchema,
    agent_category_suggestion: z
      .object({
        category_id: id,
        subcategory_id: id.nullable().optional(),
        explanation: text,
      })
      .strict()
      .optional(),
    uncertainties: z
      .array(
        z
          .object({
            field: z.string().max(100),
            code: z.string().max(100),
            explanation: text,
            locator: z.string().max(500).optional(),
          })
          .strict(),
      )
      .max(30)
      .default([]),
  })
  .strict();
const rowIds = z.array(id).min(1).max(LIMITS.edit_targets);
export const changeSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("set_fields"),
      row_ids: rowIds,
      fields: fieldsSchema.partial(),
      reason: text.min(1),
    })
    .strict(),
  z
    .object({
      action: z.literal("set_category"),
      row_ids: rowIds,
      category_id: id,
      subcategory_id: id.nullable().optional(),
    })
    .strict(),
  z.object({ action: z.literal("clear_category"), row_ids: rowIds }).strict(),
  z
    .object({ action: z.literal("reset_category_to_auto"), row_ids: rowIds })
    .strict(),
  z
    .object({
      action: z.literal("set_included"),
      row_ids: rowIds,
      included: z.boolean(),
      reason: text.min(1),
    })
    .strict(),
  z
    .object({
      action: z.literal("resolve_match"),
      row_ids: rowIds,
      decision: z.enum(["keep_existing", "import_separate", "unresolved"]),
      candidate_id: id.nullable().optional(),
      reason: z.string().min(5).max(200),
    })
    .strict(),
  z
    .object({
      action: z.literal("set_learning"),
      row_ids: rowIds,
      merchant: z.boolean(),
      source_category: z.boolean().default(false),
    })
    .strict(),
]);
const mutation = {
  idempotency_key: z.string().min(8).max(200),
  expected_revision: z.number().int().min(1),
};
const draftMutation = { ...mutation, import_id: id };
export const toolSchemas = {
  get_import_context: z.object({}).strict(),
  create_import: z
    .object({
      schema_version: z.literal("1"),
      idempotency_key: mutation.idempotency_key,
      sources: z.array(sourceSchema).min(1).max(200),
      entries: z.array(entrySchema).max(LIMITS.append),
    })
    .strict(),
  append_import_entries: z
    .object({
      ...draftMutation,
      sources: z.array(sourceSchema).max(200).default([]),
      entries: z.array(entrySchema).max(LIMITS.append),
    })
    .strict(),
  prepare_import: z.object(draftMutation).strict(),
  get_import: z.object({ import_id: id }).strict(),
  get_import_rows: z
    .object({
      import_id: id,
      expected_revision: mutation.expected_revision,
      cursor: z.string().max(200).optional(),
      limit: z.number().int().min(1).max(LIMITS.page).default(100),
      included: z.boolean().optional(),
      issues_only: z.boolean().default(false),
    })
    .strict(),
  update_import: z
    .object({
      ...draftMutation,
      changes: z.array(changeSchema).max(100).default([]),
      source_changes: z
        .array(
          z
            .object({
              client_source_id: clientId,
              coverage: z.enum(["complete", "partial", "unknown"]),
            })
            .strict(),
        )
        .max(200)
        .default([]),
    })
    .strict(),
  categorize_import: z.object(draftMutation).strict(),
  request_import_confirmation: z.object(draftMutation).strict(),
  confirm_import: z.object(draftMutation).strict(),
  renew_import: z.object(draftMutation).strict(),
  cancel_import: z.object(draftMutation).strict(),
} as const;
export type ToolName = keyof typeof toolSchemas;
export type Source = z.infer<typeof sourceSchema>;
export type Entry = z.infer<typeof entrySchema>;
export type Fields = z.infer<typeof fieldsSchema>;
export type Change = z.infer<typeof changeSchema>;
export type Target = z.infer<typeof targetSchema>;
export type Issue = {
  code: string;
  field?: string;
  message: string;
  blocking: boolean;
};
export type Candidate = {
  id: string;
  type: "transaction" | "installment_group" | "draft_row";
  description: string;
  occurred_on: string;
  amount_cents: number;
  exact: boolean;
  updated_at?: string;
};
export type DraftRow = Entry & {
  extraction_origin: "agent";
  id: string;
  included: boolean;
  inclusion_explicit: boolean;
  exclusion_reason: string | null;
  category_id: string | null;
  subcategory_id: string | null;
  category_explicit: boolean;
  category_source: string;
  category_explanation: string | null;
  match: {
    decision: "keep_existing" | "import_separate" | "unresolved";
    candidate_id?: string | null;
    reason?: string;
    signature?: string;
  };
  candidates: Candidate[];
  issues: Issue[];
  learning: { merchant: boolean; source_category: boolean };
};
export type Draft = {
  id: string;
  lineage_id: string;
  household_id: string;
  user_id: string;
  revision: number;
  state: "collecting" | "review" | "committed" | "cancelled" | "expired";
  created_at: string;
  collection_expires_at: string;
  review_expires_at: string | null;
  sources: Source[];
  rows: DraftRow[];
  warnings: string[];
  receipt: Record<string, unknown> | null;
};
export type Catalog = {
  household_id: string;
  accounts: { id: string; name: string }[];
  cards: { id: string; name: string; closing_day: number | null }[];
  members: { user_id: string; display_name: string | null }[];
  categories: { id: string; name: string; kind: string; is_active: boolean }[];
  subcategories: {
    id: string;
    category_id: string;
    name: string;
    is_active: boolean;
  }[];
};
export class ImportError extends Error {
  constructor(
    public code: string,
    message: string,
    public details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ImportError";
  }
}
export function parseTool<N extends ToolName>(
  name: N,
  value: unknown,
): z.infer<(typeof toolSchemas)[N]> {
  if (
    name === "create_import" &&
    value &&
    typeof value === "object" &&
    "schema_version" in value &&
    value.schema_version !== "1"
  )
    throw new ImportError(
      "UNSUPPORTED_SCHEMA",
      "Only structured schema version 1 is supported.",
    );
  const result = toolSchemas[name].safeParse(value);
  if (!result.success)
    throw new ImportError(
      "INVALID_REQUEST",
      "Request does not match the import contract.",
      {
        fields: result.error.issues.map((i) => ({
          path: i.path,
          code: i.code,
        })),
      },
    );
  return result.data as z.infer<(typeof toolSchemas)[N]>;
}
export function scopeFor(name: ToolName): Scope {
  return name === "get_import_context"
    ? "finance:context:read"
    : name.startsWith("get_")
      ? "imports:read"
      : name === "confirm_import" || name === "request_import_confirmation"
        ? "imports:commit"
        : "imports:prepare";
}
