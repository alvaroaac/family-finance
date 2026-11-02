"use server";

import { createHash } from "node:crypto";

import { z } from "zod";

import {
  findHouseholdIdForCurrentUser,
  listAccounts,
  listAllCategories,
  listAllSubcategories,
  listCreditCards,
  listHouseholdMembers,
} from "@family-finance/db";
import { currentHouseholdDate } from "@family-finance/domain";

import { postToBot } from "../../../lib/bot-client";
import { captureMessage, type CaptureMessage } from "../../../lib/capture-copy";
import type { TransactionFieldOptions } from "../../../components/transaction-fields";

/**
 * Server actions behind the quick-capture sheet. Each one signs the request
 * with the acting member and the household resolved from the SESSION (never
 * from client input) and posts it to the bot over the HMAC channel. The web
 * holds no AI keys; raw bot errors are logged here and never returned.
 */

export type { CaptureMessage };

const DRAFT_PATH = "/internal/v1/capture-draft";
const TRANSCRIBE_PATH = "/internal/v1/capture-transcribe";
const MAX_DRAFT_TEXT_LENGTH = 500;
const MAX_AUDIO_BYTES = 1024 * 1024;
const ALLOWED_AUDIO_TYPES = [
  "audio/webm",
  "audio/mp4",
  "audio/mpeg",
  "audio/ogg",
];

const idSchema = z.string().uuid();

const captureDraftSchema = z.object({
  description: z.string(),
  amountCents: z.number().int().positive().optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  kind: z.enum(["expense", "income"]),
  categoryId: idSchema.optional(),
  subcategoryId: idSchema.optional(),
  accountId: idSchema.optional(),
  creditCardId: idSchema.optional(),
  responsibleUserId: idSchema.optional(),
  installmentCount: z.number().int().min(1),
  candidates: z
    .array(
      z.object({
        categoryId: idSchema,
        subcategoryId: idSchema.optional(),
        explanation: z.string(),
      }),
    )
    .max(3),
  explanation: z.string(),
  needsReview: z.boolean(),
});

export type CaptureDraft = z.infer<typeof captureDraftSchema>;

const draftResponseSchema = z.object({
  ok: z.literal(true),
  intent: z.enum(["plain", "card_installment"]),
  draft: captureDraftSchema,
});

const transcribeResponseSchema = z.object({
  ok: z.literal(true),
  text: z.string().min(1),
});

const botErrorSchema = z.object({
  ok: z.literal(false),
  error: z.enum([
    "invalid_request",
    "non_financial",
    "unsupported_intent",
    "rate_limited",
    "unavailable",
  ]),
});

type BotError = z.infer<typeof botErrorSchema>["error"];
type BotOutcome = { ok: true; json: unknown } | { ok: false; error: BotError };

type ServerSupabaseClient = Awaited<
  ReturnType<typeof import("../../../lib/supabase").createServerSupabaseClient>
>;

type Actor = {
  client: ServerSupabaseClient;
  householdId: string;
  userId: string;
};

async function resolveActor(): Promise<Actor | null> {
  const { createServerSupabaseClient } = await import("../../../lib/supabase");
  const client = await createServerSupabaseClient();
  const householdId = await findHouseholdIdForCurrentUser(client);
  if (householdId === null) return null;
  const {
    data: { user },
  } = await client.auth.getUser();
  return user === null ? null : { client, householdId, userId: user.id };
}

async function resolveActorOrNull(): Promise<Actor | null> {
  try {
    return await resolveActor();
  } catch (error) {
    console.error("[web] capture actor lookup failed:", error);
    return null;
  }
}

/** Posts a signed request; anything but a well-formed bot answer is `unavailable`. */
async function callBot(
  path: string,
  actor: Actor,
  fields: Record<string, unknown>,
): Promise<BotOutcome> {
  const response = await postToBot(path, {
    version: 1,
    requestId: crypto.randomUUID(),
    scopeKey: actor.householdId,
    actorUserId: actor.userId,
    ...fields,
  });
  if (!response.ok) {
    console.error(`[web] ${path} not reached:`, response.reason);
    return { ok: false, error: "unavailable" };
  }
  if (response.status === 200) return { ok: true, json: response.json };
  const failure = botErrorSchema.safeParse(response.json);
  console.error(`[web] ${path} failed:`, response.status, response.json);
  return {
    ok: false,
    error:
      failure.success && response.status < 500
        ? failure.data.error
        : "unavailable",
  };
}

function failure(code: Parameters<typeof captureMessage>[0]) {
  return { ok: false, message: captureMessage(code) } as const;
}

export async function suggestCaptureDraftAction(
  text: string,
): Promise<
  | { ok: true; intent: "plain" | "card_installment"; draft: CaptureDraft }
  | { ok: false; message: CaptureMessage }
> {
  const trimmed = typeof text === "string" ? text.trim() : "";
  if (trimmed === "" || trimmed.length > MAX_DRAFT_TEXT_LENGTH) {
    return failure("non_financial");
  }

  const actor = await resolveActorOrNull();
  if (actor === null) return failure("unavailable");

  const outcome = await callBot(DRAFT_PATH, actor, {
    today: currentHouseholdDate(),
    text: trimmed,
  });
  if (!outcome.ok) {
    return failure(
      outcome.error === "invalid_request" ? "unavailable" : outcome.error,
    );
  }
  const parsed = draftResponseSchema.safeParse(outcome.json);
  if (!parsed.success) {
    console.error("[web] capture-draft malformed body:", parsed.error.message);
    return failure("unavailable");
  }
  return { ok: true, intent: parsed.data.intent, draft: parsed.data.draft };
}

/** Browsers send parameters ("audio/webm;codecs=opus"); the bot takes exact types. */
function baseAudioType(mimeType: FormDataEntryValue | null): string | null {
  if (typeof mimeType !== "string") return null;
  const base = (mimeType.split(";")[0] ?? "").trim().toLowerCase();
  return ALLOWED_AUDIO_TYPES.includes(base) ? base : null;
}

export async function transcribeCaptureAudioAction(
  formData: FormData,
): Promise<
  { ok: true; text: string } | { ok: false; message: CaptureMessage }
> {
  const actor = await resolveActorOrNull();
  if (actor === null) return failure("unavailable");

  const audio = formData.get("audio");
  const mimeType = baseAudioType(formData.get("mimeType"));
  if (
    !(audio instanceof Blob) ||
    mimeType === null ||
    audio.size > MAX_AUDIO_BYTES
  ) {
    return failure("transcribe_failed");
  }

  const outcome = await callBot(TRANSCRIBE_PATH, actor, {
    mimeType,
    audioBase64: Buffer.from(await audio.arrayBuffer()).toString("base64"),
  });
  if (!outcome.ok) {
    return outcome.error === "unavailable" || outcome.error === "rate_limited"
      ? failure(outcome.error)
      : failure("transcribe_failed");
  }
  const parsed = transcribeResponseSchema.safeParse(outcome.json);
  if (!parsed.success) {
    console.error(
      "[web] capture-transcribe malformed body:",
      parsed.error.message,
    );
    return failure("unavailable");
  }
  return { ok: true, text: parsed.data.text };
}

/**
 * Hash of the payload in a fixed order: rows are sorted by name only, so tied
 * names (an "Outros" under two categories) may swap between calls and must
 * not read as a change.
 */
function optionsVersion(payload: {
  options: TransactionFieldOptions;
  defaultResponsible: string;
}): string {
  const byId = <T extends { id: string }>(rows: T[]) =>
    [...rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const { options } = payload;
  const canonical = {
    ...payload,
    options: {
      accounts: byId(options.accounts),
      cards: byId(options.cards),
      categories: byId(options.categories),
      subcategories: byId(options.subcategories),
      responsibles: options.responsibles,
    },
  };
  return createHash("sha256")
    .update(JSON.stringify(canonical))
    .digest("base64url")
    .slice(0, 22);
}

export type CaptureOptionsResult =
  | { unchanged: true; version: string }
  | {
      unchanged: false;
      version: string;
      options: TransactionFieldOptions;
      defaultResponsible: string;
    };

/**
 * The sheet's form options, ETag-style: `version` is a hash of the payload.
 * When the caller already holds `knownVersion`, only `{ unchanged: true }`
 * goes back, so a check costs the client almost nothing. The queries still
 * run: the tables keep no reliable change marker to skip them with.
 */
export async function loadCaptureOptionsAction(
  knownVersion?: string,
): Promise<CaptureOptionsResult> {
  const actor = await resolveActor();
  if (actor === null)
    throw new Error("Nenhuma casa ativa para o usuário atual.");
  const { client, householdId } = actor;

  const [accounts, cards, categories, subcategories, members] =
    await Promise.all([
      listAccounts(client, householdId),
      listCreditCards(client, householdId),
      listAllCategories(client, householdId),
      listAllSubcategories(client, householdId),
      listHouseholdMembers(client, householdId),
    ]);

  const payload = {
    options: {
      accounts: accounts.map((a) => ({ id: a.id, name: a.name })),
      cards: cards.map((c) => ({ id: c.id, name: c.name })),
      categories: categories.map((c) => ({
        id: c.id,
        name: c.name,
        kind: c.kind,
      })),
      subcategories: subcategories.map((s) => ({
        id: s.id,
        categoryId: s.category_id,
        name: s.name,
      })),
      responsibles: [
        { value: "household", label: "Casa" },
        ...members.map((m) => ({
          value: m.userId,
          label: m.displayName ?? "Membro",
        })),
      ],
    },
    defaultResponsible: "household",
  };
  const version = optionsVersion(payload);
  if (version === knownVersion) return { unchanged: true, version };
  return { unchanged: false, version, ...payload };
}
