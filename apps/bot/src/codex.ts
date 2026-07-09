import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

import { z } from "zod";

import type { InterpretedIntent, MessageClassifier } from "./interpret.js";
import type { AiCompletionClient } from "@family-finance/categorization";

export type CodexRunRequest = {
  prompt: string;
  schemaPath: string;
  outputPath: string;
  cwd: string;
  codexHome: string;
  model: string;
  timeoutMs: number;
  maxOutputBytes: number;
};

export type CodexRunResult = {
  exitCode: number | null;
  timedOut: boolean;
  stderr: string;
  errorCode?: string;
};

export type CodexProcessRunner = (
  request: CodexRunRequest,
) => Promise<CodexRunResult>;

export const CODEX_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "action",
    "intent",
    "description",
    "merchant",
    "item",
    "amount_cents",
    "monthly_amount_cents",
    "per_installment_cents",
    "installment_count",
    "occurred_on",
    "start_month",
    "due_day",
    "card_id",
    "card_name",
    "mark_paid_target",
    "category_hint",
    "category_candidates",
    "proposed_taxonomy_change",
  ],
  properties: {
    action: { const: "interpret_only" },
    intent: {
      enum: [
        "plain",
        "obligation",
        "card_installment",
        "mark_paid",
        "non_financial",
      ],
    },
    description: { type: ["string", "null"] },
    merchant: { type: ["string", "null"] },
    item: { type: ["string", "null"] },
    amount_cents: { type: ["integer", "null"], minimum: 1 },
    monthly_amount_cents: { type: ["integer", "null"], minimum: 1 },
    per_installment_cents: { type: ["integer", "null"], minimum: 1 },
    installment_count: { type: ["integer", "null"], minimum: 1 },
    occurred_on: { type: ["string", "null"] },
    start_month: { type: ["string", "null"] },
    due_day: { type: ["integer", "null"], minimum: 1, maximum: 28 },
    card_id: { type: ["string", "null"] },
    card_name: { type: ["string", "null"] },
    mark_paid_target: { enum: ["card", "obligation", null] },
    category_hint: { type: ["string", "null"] },
    category_candidates: {
      type: "array",
      maxItems: 3,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["category", "subcategory", "confidence", "explanation"],
        properties: {
          category: { type: "string" },
          subcategory: { type: ["string", "null"] },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          explanation: { type: "string" },
        },
      },
    },
    proposed_taxonomy_change: {
      anyOf: [
        { type: "null" },
        {
          type: "object",
          additionalProperties: false,
          required: ["kind", "category", "subcategory"],
          properties: {
            kind: { enum: ["category", "subcategory"] },
            category: { type: "string" },
            subcategory: { type: ["string", "null"] },
          },
        },
      ],
    },
  },
} as const;

const candidateSchema = z
  .object({
    category: z.string().min(1),
    subcategory: z.string().nullable(),
    confidence: z.number().min(0).max(1),
    explanation: z.string(),
  })
  .strict();

const resultSchema = z
  .object({
    action: z.literal("interpret_only"),
    intent: z.enum([
      "plain",
      "obligation",
      "card_installment",
      "mark_paid",
      "non_financial",
    ]),
    description: z.string().min(1).nullable(),
    merchant: z.string().min(1).nullable(),
    item: z.string().min(1).nullable(),
    amount_cents: z.number().int().positive().nullable(),
    monthly_amount_cents: z.number().int().positive().nullable(),
    per_installment_cents: z.number().int().positive().nullable(),
    installment_count: z.number().int().positive().nullable(),
    occurred_on: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable(),
    start_month: z
      .string()
      .regex(/^\d{4}-(0[1-9]|1[0-2])$/)
      .nullable(),
    due_day: z.number().int().min(1).max(28).nullable(),
    card_id: z.string().nullable(),
    card_name: z.string().nullable(),
    mark_paid_target: z.enum(["card", "obligation"]).nullable(),
    category_hint: z.string().nullable(),
    category_candidates: z.array(candidateSchema).max(3),
    proposed_taxonomy_change: z
      .object({
        kind: z.enum(["category", "subcategory"]),
        category: z.string().min(1),
        subcategory: z.string().nullable(),
      })
      .strict()
      .nullable(),
  })
  .strict();

export function buildCodexPrompt(
  text: string,
  options: Parameters<MessageClassifier>[1],
): string {
  return [
    "Você é um interpretador financeiro pt-BR. Ação obrigatória: interpret_only.",
    "Nunca escreva, execute ações ou invente dados. Retorne somente o JSON do schema.",
    "Menção a cartão sem parcelas é plain. Parcelamento no cartão é card_installment.",
    '"72x de 710,44" para financiamento/conta recorrente é obligation com valor mensal 71044.',
    "Use apenas cartões conhecidos e categorias/subcategorias existentes.",
    "Retorne até 3 categorias existentes ranqueadas. Nova categoria/subcategoria fica apenas proposta pendente.",
    "Separe merchant e item; description deve priorizar o item quando mencionado, senão o merchant/serviço.",
    `Hoje: ${options.today}`,
    `Mensagem: ${JSON.stringify(text)}`,
    `Parser hints: ${JSON.stringify(options.parserHints ?? {})}`,
    `Cartões conhecidos: ${JSON.stringify(options.knownCards ?? [])}`,
    `Catálogo: ${JSON.stringify(options.catalog ?? { categories: [], subcategories: [] })}`,
    `Aliases de estabelecimentos: ${JSON.stringify(options.merchantAliases ?? {})}`,
  ].join("\n");
}

export function buildCodexExecArgs(request: CodexRunRequest): string[] {
  return [
    "exec",
    "--ephemeral",
    "--ignore-user-config",
    "--ignore-rules",
    "--strict-config",
    "--skip-git-repo-check",
    "-c",
    'web_search="disabled"',
    ...[
      "shell_tool",
      "unified_exec",
      "code_mode_host",
      "apps",
      "browser_use",
      "browser_use_external",
      "browser_use_full_cdp_access",
      "computer_use",
      "in_app_browser",
      "multi_agent",
      "image_generation",
      "shell_zsh_fork",
      "unified_exec_zsh_fork",
      "js_repl",
      "js_repl_tools_only",
      "enable_mcp_apps",
      "tool_call_mcp_elicitation",
      "request_permissions_tool",
      "remote_plugin",
      "plugin_sharing",
      "skill_mcp_dependency_install",
      "network_proxy",
      "plugins",
      "auth_elicitation",
      "artifact",
      "chronicle",
      "code_mode",
      "code_mode_only",
      "deferred_executor",
      "enable_fanout",
      "goals",
      "hooks",
      "memories",
      "shell_snapshot",
      "tool_suggest",
      "workspace_dependencies",
      "multi_agent_v2",
    ].flatMap((feature) => ["--disable", feature]),
    "--sandbox",
    "read-only",
    "--model",
    request.model,
    "--cd",
    request.cwd,
    "--output-schema",
    request.schemaPath,
    "--output-last-message",
    request.outputPath,
    "--color",
    "never",
    "--json",
    "-",
  ];
}

export function createNodeCodexRunner(binary = "codex"): CodexProcessRunner {
  return async (request) =>
    new Promise((resolve) => {
      const args = buildCodexExecArgs(request);
      const child = spawn(binary, args, {
        cwd: request.cwd,
        env: {
          PATH: process.env.PATH ?? "",
          CODEX_HOME: request.codexHome,
          HOME: request.codexHome,
          LANG: "C.UTF-8",
        },
        stdio: ["pipe", "pipe", "pipe"],
        detached: process.platform !== "win32",
      });
      let stderr = "";
      let stdout = "";
      let exceeded = false;
      child.stderr.on("data", (chunk: Buffer) => {
        if (stderr.length < request.maxOutputBytes) stderr += chunk.toString();
        if (stderr.length >= request.maxOutputBytes) {
          exceeded = true;
          if (child.pid && process.platform !== "win32") {
            try {
              process.kill(-child.pid, "SIGKILL");
            } catch {
              child.kill("SIGKILL");
            }
          } else child.kill("SIGKILL");
        }
      });
      child.stdout.on("data", (chunk: Buffer) => {
        if (stdout.length < request.maxOutputBytes) stdout += chunk.toString();
        if (stdout.length >= request.maxOutputBytes) {
          exceeded = true;
          killGroup();
        }
      });
      const killGroup = () => {
        if (child.pid && process.platform !== "win32") {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            child.kill("SIGKILL");
          }
        } else child.kill("SIGKILL");
      };
      const timer = setTimeout(killGroup, request.timeoutMs);
      child.on("error", (error: NodeJS.ErrnoException) => {
        clearTimeout(timer);
        resolve({
          exitCode: null,
          timedOut: false,
          stderr,
          errorCode: error.code,
        });
      });
      child.stdin.on("error", (error: NodeJS.ErrnoException) => {
        killGroup();
        resolve({
          exitCode: null,
          timedOut: false,
          stderr,
          errorCode: error.code ?? "STDIN_ERROR",
        });
      });
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        let auditError: string | undefined;
        try {
          for (const line of stdout.split(/\r?\n/).filter(Boolean)) {
            const event = JSON.parse(line) as {
              type?: string;
              item?: { type?: string };
            };
            const allowed =
              event.type === "thread.started" ||
              event.type === "turn.started" ||
              event.type === "turn.completed" ||
              (event.type === "item.completed" &&
                event.item?.type === "agent_message");
            if (!allowed) throw new Error("unexpected Codex event");
          }
        } catch {
          auditError = "UNEXPECTED_CODEX_EVENT";
        }
        resolve({
          exitCode: code,
          timedOut: signal === "SIGKILL" && !exceeded,
          stderr: exceeded ? "bounded_output_exceeded" : stderr,
          errorCode: auditError,
        });
      });
      child.stdin.end(request.prompt);
    });
}

function normalized(value: string): string {
  return value.normalize("NFD").replace(/\p{M}/gu, "").trim().toLowerCase();
}

function isCalendarDate(value: string): boolean {
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year as number, (month as number) - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() + 1 === month &&
    date.getUTCDate() === day
  );
}

function mapResult(
  data: z.infer<typeof resultSchema>,
  options: Parameters<MessageClassifier>[1],
): InterpretedIntent | null {
  if (data.intent === "non_financial") return { intent: "non_financial" };
  if (data.description === null) return null;
  const knownCard =
    data.card_id === null
      ? undefined
      : options.knownCards?.find((card) => card.id === data.card_id);
  if (data.card_id !== null && knownCard === undefined) return null;
  if (
    data.card_name !== null &&
    (!knownCard || normalized(data.card_name) !== normalized(knownCard.name))
  ) {
    throw new Error("card id/name mismatch");
  }
  if (data.occurred_on !== null && !isCalendarDate(data.occurred_on)) {
    throw new Error("invalid calendar date");
  }
  if (
    data.intent === "plain" &&
    (data.installment_count !== null || data.per_installment_cents !== null)
  ) {
    throw new Error("plain intent carried installment fields");
  }
  if (
    data.intent === "card_installment" &&
    (data.installment_count === null ||
      data.installment_count < 2 ||
      (data.amount_cents === null) === (data.per_installment_cents === null))
  ) {
    throw new Error("invalid installment semantics");
  }
  if (data.intent === "obligation" && data.monthly_amount_cents === null) {
    throw new Error("obligation missing monthly amount");
  }
  if (data.intent === "mark_paid" && data.mark_paid_target === null) {
    throw new Error("mark_paid missing target");
  }
  const candidateKeys = data.category_candidates.map(
    (candidate) =>
      `${normalized(candidate.category)}|${normalized(candidate.subcategory ?? "")}`,
  );
  if (new Set(candidateKeys).size !== candidateKeys.length) {
    throw new Error("duplicate category candidates");
  }
  const categoryCandidates = data.category_candidates.map((candidate) => {
    const category = options.catalog?.categories.find(
      (item) => normalized(item.name) === normalized(candidate.category),
    );
    if (!category) throw new Error("unknown category candidate");
    if (candidate.subcategory !== null) {
      const subcategory = options.catalog?.subcategories.find(
        (item) =>
          item.categoryId === category.id &&
          normalized(item.name) === normalized(candidate.subcategory as string),
      );
      if (!subcategory) throw new Error("invalid subcategory parent");
    }
    return {
      categoryName: category.name,
      subcategoryName: candidate.subcategory ?? undefined,
      confidence: candidate.confidence,
      explanation: candidate.explanation,
    };
  });
  const proposal = data.proposed_taxonomy_change;
  if (proposal?.kind === "category") {
    const duplicate = options.catalog?.categories.some(
      (category) => normalized(category.name) === normalized(proposal.category),
    );
    if (duplicate) throw new Error("duplicate category proposal");
  }
  if (proposal?.kind === "subcategory") {
    const parent = options.catalog?.categories.find(
      (category) => normalized(category.name) === normalized(proposal.category),
    );
    if (!parent || proposal.subcategory === null) {
      throw new Error("invalid subcategory proposal parent");
    }
    const duplicate = options.catalog?.subcategories.some(
      (subcategory) =>
        subcategory.categoryId === parent.id &&
        normalized(subcategory.name) ===
          normalized(proposal.subcategory as string),
    );
    if (duplicate) throw new Error("duplicate subcategory proposal");
  }
  const common = {
    categoryHint: data.category_hint ?? data.category_candidates[0]?.category,
    categoryCandidates,
    unifiedPrimary: true,
    proposedCategoryName:
      proposal?.kind === "category" ? proposal.category : undefined,
    proposedSubcategory:
      proposal?.kind === "subcategory" && proposal.subcategory
        ? {
            categoryName: proposal.category,
            subcategoryName: proposal.subcategory,
          }
        : undefined,
  };
  if (data.intent === "plain") {
    return {
      intent: "plain",
      expense: {
        description: data.description,
        amountCents: data.amount_cents ?? undefined,
        occurredOn: data.occurred_on ?? undefined,
        cardKeyword: knownCard?.name,
        ...common,
      },
    };
  }
  if (data.intent === "obligation") {
    return {
      intent: "obligation",
      obligation: {
        description: data.description,
        monthlyAmountCents:
          data.monthly_amount_cents ?? data.amount_cents ?? undefined,
        termMonths: data.installment_count ?? undefined,
        startMonth: data.start_month ?? undefined,
        dueDay: data.due_day ?? undefined,
        categoryHint: common.categoryHint,
        unifiedPrimary: true,
        categoryCandidates: common.categoryCandidates,
        proposedCategoryName: common.proposedCategoryName,
        proposedSubcategory: common.proposedSubcategory,
      },
    };
  }
  if (data.intent === "card_installment") {
    return {
      intent: "card_installment",
      purchase: {
        description: data.description,
        totalCents: data.amount_cents ?? undefined,
        perInstallmentCents: data.per_installment_cents ?? undefined,
        installmentCount: data.installment_count ?? undefined,
        purchasedOn: data.occurred_on ?? undefined,
        cardKeyword: knownCard?.name,
        categoryHint: common.categoryHint,
        unifiedPrimary: true,
        categoryCandidates: common.categoryCandidates,
        proposedCategoryName: common.proposedCategoryName,
        proposedSubcategory: common.proposedSubcategory,
      },
    };
  }
  if (data.mark_paid_target === null) return null;
  return {
    intent: "mark_paid",
    target: data.mark_paid_target,
    keyword: data.card_name ?? data.description,
    amountCents: data.amount_cents ?? undefined,
  };
}

export function createCodexMessageClassifier(args: {
  enabled: boolean;
  model: string;
  timeoutMs: number;
  codexHome: string;
  runner?: CodexProcessRunner;
  telemetry?: (event: Record<string, unknown>) => void;
}): MessageClassifier {
  const runner = args.runner ?? createNodeCodexRunner();
  let active = 0;
  let consecutiveFailures = 0;
  let circuitOpenUntil = 0;
  const noteFailure = () => {
    consecutiveFailures += 1;
    if (consecutiveFailures >= 3) circuitOpenUntil = Date.now() + 60_000;
  };
  return async (text, options) => {
    if (!args.enabled) return null;
    if (active >= 2 || Date.now() < circuitOpenUntil) {
      args.telemetry?.({
        type: "ai_call",
        provider: "codex",
        role: "primary",
        outcome: active >= 2 ? "saturated" : "circuit_open",
      });
      return null;
    }
    active += 1;
    let temp: string | undefined;
    const started = Date.now();
    try {
      temp = await mkdtemp(join(tmpdir(), "family-finance-codex-"));
      const cwd = join(temp, "empty");
      const schemaPath = join(temp, "schema.json");
      const outputPath = join(temp, "output.json");
      await Promise.all([
        mkdir(cwd),
        mkdir(args.codexHome, { recursive: true }),
        writeFile(schemaPath, JSON.stringify(CODEX_OUTPUT_SCHEMA), "utf8"),
      ]);
      const result = await runner({
        prompt: buildCodexPrompt(text, options),
        schemaPath,
        outputPath,
        cwd,
        codexHome: args.codexHome,
        model: args.model,
        timeoutMs: args.timeoutMs,
        maxOutputBytes: 64 * 1024,
      });
      if (result.exitCode !== 0 || result.timedOut || result.errorCode) {
        noteFailure();
        args.telemetry?.({
          type: "ai_call",
          provider: "codex",
          role: "primary",
          outcome: result.timedOut ? "timeout" : "fallback",
          latencyMs: Date.now() - started,
        });
        return null;
      }
      if ((await stat(outputPath)).size > 64 * 1024) {
        throw new Error("Codex output file exceeded limit");
      }
      const parsed = resultSchema.safeParse(
        JSON.parse(await readFile(outputPath, "utf8")),
      );
      if (!parsed.success) {
        noteFailure();
        args.telemetry?.({
          type: "ai_call",
          provider: "codex",
          role: "primary",
          outcome: "invalid_schema",
          latencyMs: Date.now() - started,
        });
        return null;
      }
      const mapped = mapResult(parsed.data, options);
      args.telemetry?.({
        type: "ai_call",
        provider: "codex",
        role: "primary",
        outcome: "success",
        latencyMs: Date.now() - started,
      });
      consecutiveFailures = 0;
      circuitOpenUntil = 0;
      return mapped;
    } catch {
      noteFailure();
      args.telemetry?.({
        type: "ai_call",
        provider: "codex",
        role: "primary",
        outcome: "fallback",
        latencyMs: Date.now() - started,
      });
      return null;
    } finally {
      active -= 1;
      if (temp) {
        await rm(temp, { recursive: true, force: true }).catch(() => undefined);
      }
    }
  };
}

/** One unified Anthropic completion used only after a Codex failure. */
export function createUnifiedAnthropicMessageClassifier(
  client: AiCompletionClient,
): MessageClassifier {
  return async (text, options) => {
    try {
      const reply = await client.complete(buildCodexPrompt(text, options), {
        label: "codex_fallback",
      });
      if (!reply) return null;
      const start = reply.indexOf("{");
      const end = reply.lastIndexOf("}");
      if (start < 0 || end < start) return null;
      const parsed = resultSchema.safeParse(
        JSON.parse(reply.slice(start, end + 1)),
      );
      return parsed.success ? mapResult(parsed.data, options) : null;
    } catch {
      return null;
    }
  };
}

export function withClassifierFallback(
  primary: MessageClassifier | undefined,
  fallback: MessageClassifier | undefined,
  telemetry: (event: Record<string, unknown>) => void = (event) =>
    console.log(JSON.stringify(event)),
): MessageClassifier | undefined {
  if (!primary) return fallback;
  return async (text, options) => {
    const result = await primary(text, options).catch(() => null);
    if (result !== null || !fallback) return result;
    telemetry({
      type: "ai_fallback",
      from: "codex",
      to: "anthropic",
      role: "fallback",
    });
    return fallback(text, options);
  };
}
