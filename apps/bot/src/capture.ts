import { z } from "zod";
import {
  startConversation,
  type ConversationDeps,
  type ConversationState,
} from "./conversation.js";
import type { InternalRouteHandler } from "./server.js";

export const CAPTURE_DRAFT_PATH = "/internal/v1/capture-draft";

function isCalendarDate(value: string): boolean {
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
}

const captureRequestSchema = z
  .object({
    version: z.literal(1),
    requestId: z.string().uuid(),
    scopeKey: z.string().uuid(),
    actorUserId: z.string().uuid(),
    today: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .refine(isCalendarDate),
    text: z.string().trim().min(1).max(500),
  })
  .strict();

type CaptureCandidate = {
  categoryId: string;
  subcategoryId?: string;
  explanation: string;
};

export type CaptureDraftResult =
  | { ok: false; error: "non_financial" | "unsupported_intent" }
  | {
      ok: true;
      intent: "plain" | "card_installment";
      draft: {
        description: string;
        amountCents?: number;
        date: string;
        kind: "expense" | "income";
        categoryId?: string;
        subcategoryId?: string;
        accountId?: string;
        creditCardId?: string;
        responsibleUserId?: string;
        installmentCount: number;
        candidates: CaptureCandidate[];
        explanation: string;
        needsReview: boolean;
      };
    };

export type CaptureRateLimiter = {
  acquire(householdId: string): (() => void) | null;
};

export function createCaptureRateLimiter(
  opts: {
    perMinute?: number;
    concurrent?: number;
    now?: () => number;
  } = {},
): CaptureRateLimiter {
  const perMinute = opts.perMinute ?? 20;
  const concurrent = opts.concurrent ?? 2;
  const now = opts.now ?? Date.now;
  const households = new Map<string, { calls: number[]; active: number }>();
  return {
    acquire(householdId) {
      const at = now();
      // Expire idle household entries as well as their rolling-window calls.
      for (const [id, entry] of households) {
        entry.calls = entry.calls.filter((call) => call > at - 60_000);
        if (entry.active === 0 && entry.calls.length === 0)
          households.delete(id);
      }
      const entry = households.get(householdId) ?? { calls: [], active: 0 };
      if (entry.calls.length >= perMinute || entry.active >= concurrent)
        return null;
      entry.calls.push(at);
      entry.active++;
      households.set(householdId, entry);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        entry.active--;
      };
    },
  };
}

/** Project only editable transaction fields; never expose conversation metadata. */
export function toCaptureDraft(
  state: ConversationState,
  today: string,
): CaptureDraftResult {
  if (state.status === "cancelled")
    return { ok: false, error: "non_financial" };
  if (
    state.obligationDraft !== undefined ||
    state.cardBillDraft !== undefined ||
    state.status === "awaiting_mark_paid_choice" ||
    state.markPaidCandidates !== undefined ||
    state.markPaidAmountCents !== undefined ||
    state.markPaidAccountId !== undefined ||
    state.markPaidPaidOn !== undefined
  )
    return { ok: false, error: "unsupported_intent" };

  const installment = state.installmentDraft;
  if (
    installment === undefined &&
    state.status !== "awaiting_confirmation" &&
    state.status !== "needs_amount" &&
    state.status !== "awaiting_payment_choice"
  ) {
    return { ok: false, error: "unsupported_intent" };
  }
  if (
    installment !== undefined &&
    (!Number.isInteger(installment.installmentCount) ||
      (installment.installmentCount ?? 0) < 2)
  ) {
    return { ok: false, error: "unsupported_intent" };
  }

  const source = installment ?? state.draft;
  const kind = installment !== undefined ? "expense" : state.draft.kind;
  if (kind !== "expense" && kind !== "income")
    return { ok: false, error: "unsupported_intent" };
  const explanation = source.categoryExplanation ?? "";
  const candidates: CaptureCandidate[] =
    kind === "income"
      ? []
      : (state.categoryCandidates?.slice(0, 3).map((candidate) => ({
          categoryId: candidate.categoryId,
          ...(candidate.subcategoryId === undefined
            ? {}
            : { subcategoryId: candidate.subcategoryId }),
          explanation: candidate.explanation,
        })) ??
        (source.categoryId === undefined
          ? []
          : [
              {
                categoryId: source.categoryId,
                ...(source.subcategoryId === undefined
                  ? {}
                  : { subcategoryId: source.subcategoryId }),
                explanation,
              },
            ]));
  const amountCents =
    installment !== undefined
      ? installment.totalCents
      : state.draft.amountCents;
  const paymentChoice =
    state.status === "awaiting_payment_choice" && installment === undefined;
  const accountId =
    installment === undefined && !paymentChoice
      ? state.draft.accountId
      : undefined;
  const creditCardId = paymentChoice ? undefined : source.cardId;
  return {
    ok: true,
    intent: installment === undefined ? "plain" : "card_installment",
    draft: {
      description: source.description,
      ...(Number.isInteger(amountCents) && (amountCents ?? 0) > 0
        ? { amountCents }
        : {}),
      date:
        (installment === undefined
          ? state.draft.occurredOn
          : installment.purchasedOn) || today,
      kind,
      ...(kind === "expense" && source.categoryId !== undefined
        ? { categoryId: source.categoryId }
        : {}),
      ...(kind === "expense" && source.subcategoryId !== undefined
        ? { subcategoryId: source.subcategoryId }
        : {}),
      ...(accountId === undefined ? {} : { accountId }),
      ...(creditCardId === undefined ? {} : { creditCardId }),
      ...(source.responsibleUserId === undefined
        ? {}
        : { responsibleUserId: source.responsibleUserId }),
      installmentCount:
        installment === undefined ? 1 : installment.installmentCount!,
      candidates,
      explanation,
      // ConversationState currently has no category-conflict signal.
      needsReview: false,
    },
  };
}

function readOnlyDeps(
  deps: ConversationDeps,
  onObligationAttempt: () => void,
): ConversationDeps {
  const readOnly = { ...deps };
  for (const name of [
    "createCategory",
    "restoreCategory",
    "createSubcategory",
    "restoreSubcategory",
    "seedCategorizationMemory",
    "createObligation",
    "createInstallmentPurchase",
    "settleCardBill",
    "reconcileLegacyCardBillPayment",
  ] as const)
    delete readOnly[name];
  // Stub, not removal: conversation.ts only settles an obligation when this dep
  // exists, so the attempt itself is the signal for an unsupported intent.
  readOnly.materializeObligationPayment = async () => {
    onObligationAttempt();
    throw new Error("Capture is read-only");
  };
  readOnly.createTransaction = async () => {
    throw new Error("Capture is read-only");
  };
  readOnly.logInteraction = async () => undefined;
  return readOnly;
}

function filterCategory<
  T extends { categoryId?: string; subcategoryId?: string },
>(value: T, deps: ConversationDeps): T {
  if (
    !deps.catalog.categories.some(
      (category) => category.id === value.categoryId,
    )
  ) {
    delete value.categoryId;
  }
  if (
    !deps.catalog.subcategories.some(
      (subcategory) =>
        subcategory.id === value.subcategoryId &&
        subcategory.categoryId === value.categoryId,
    )
  )
    delete value.subcategoryId;
  return value;
}

export function createCaptureDraftHandler(deps: {
  buildCaptureDeps: (actor: {
    userId: string;
    householdId: string;
  }) => Promise<ConversationDeps>;
  limiter: CaptureRateLimiter;
  log: (event: string, fields: Record<string, unknown>) => void;
}): InternalRouteHandler {
  return async (json, actor) => {
    const parsed = captureRequestSchema.safeParse(json);
    if (
      !parsed.success ||
      parsed.data.actorUserId !== actor.userId ||
      parsed.data.scopeKey !== actor.householdId
    ) {
      return { status: 400, body: { ok: false, error: "invalid_request" } };
    }
    const request = parsed.data;
    const release = deps.limiter.acquire(actor.householdId);
    if (release === null)
      return { status: 429, body: { ok: false, error: "rate_limited" } };
    let obligationAttempted = false;
    const unsupportedIntent = {
      status: 422,
      body: { ok: false, error: "unsupported_intent" },
    } as const;
    try {
      const conversationDeps = readOnlyDeps(
        await deps.buildCaptureDeps(actor),
        () => {
          obligationAttempted = true;
        },
      );
      const { state } = await startConversation(
        { text: request.text, fromUserId: actor.userId, inputKind: "text" },
        conversationDeps,
        { today: request.today },
      );
      if (obligationAttempted) return unsupportedIntent;
      // Validate the entire ranked list before the mapper takes the top three.
      const checkedState: ConversationState = {
        ...state,
        categoryCandidates: state.categoryCandidates?.filter((candidate) =>
          conversationDeps.catalog.categories.some(
            (category) => category.id === candidate.categoryId,
          ),
        ),
      };
      const result = toCaptureDraft(checkedState, request.today);
      if (!result.ok) return { status: 422, body: result };
      const draft = filterCategory(result.draft, conversationDeps);
      draft.candidates = draft.candidates
        .filter((candidate) =>
          conversationDeps.catalog.categories.some(
            (category) => category.id === candidate.categoryId,
          ),
        )
        .map((candidate) => filterCategory(candidate, conversationDeps));
      if (
        !conversationDeps
          .listActiveAccounts?.()
          .some((account) => account.id === draft.accountId)
      )
        delete draft.accountId;
      if (
        !conversationDeps
          .listActiveCards?.()
          .some((card) => card.id === draft.creditCardId)
      )
        delete draft.creditCardId;
      if (
        !conversationDeps
          .listActiveMembers?.()
          .some((member) => member.userId === draft.responsibleUserId)
      )
        delete draft.responsibleUserId;
      if (draft.needsReview) {
        delete draft.categoryId;
        delete draft.subcategoryId;
      }
      return { status: 200, body: result };
    } catch (error) {
      if (obligationAttempted) return unsupportedIntent;
      deps.log("capture_draft_unavailable", {
        requestId: request.requestId,
        error,
      });
      return { status: 503, body: { ok: false, error: "unavailable" } };
    } finally {
      release();
    }
  };
}
