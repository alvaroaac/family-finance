import { parseExpenseText } from "@family-finance/intake/parser";
import {
  createUnifiedCompletionMessageClassifier,
  CODEX_OUTPUT_SCHEMA,
} from "@family-finance/intake/codex";
import {
  createOpenAiCompletionClient,
  createAnthropicCompletionClient,
} from "@family-finance/intake/providers";
import { suggestCategory } from "@family-finance/categorization";
import { currentHouseholdDate } from "@family-finance/domain";
import * as db from "@family-finance/db";
import type { DraftSuggestion } from "@family-finance/mobile-contracts";
import { type MobileContext, MobileError } from "./context";
export async function suggestMobileDraft(
  ctx: MobileContext,
  text: string,
): Promise<DraftSuggestion> {
  const { client, householdId } = ctx;
  const today = currentHouseholdDate();
  const parsed = parseExpenseText(text, { today });
  const [categories, subcategories, accounts, cards, memory] =
    await Promise.all([
      db.listAllCategories(client, householdId),
      db.listAllSubcategories(client, householdId),
      db.listAccounts(client, householdId),
      db.listCreditCards(client, householdId),
      db.listActiveCategorizationMemory(client, householdId),
    ]);
  const catalog = {
    householdId,
    categories: categories.filter((c) => c.is_active),
    subcategories: subcategories
      .filter((s) => s.is_active)
      .map((s) => ({ id: s.id, categoryId: s.category_id, name: s.name })),
  };
  // One paid provider, awaited to its own timeout. No cascading paid calls and no financial-text logging.
  const completion = process.env.OPENAI_API_KEY
    ? createOpenAiCompletionClient({
        apiKey: process.env.OPENAI_API_KEY,
        model: process.env.OPENAI_MODEL ?? "gpt-5-nano",
        outputSchema: CODEX_OUTPUT_SCHEMA,
        timeoutMs: 8000,
        logCall: () => {},
      })
    : process.env.ANTHROPIC_API_KEY
      ? createAnthropicCompletionClient({
          apiKey: process.env.ANTHROPIC_API_KEY,
          model: process.env.ANTHROPIC_MODEL ?? "claude-haiku-4-5",
          timeoutMs: 8000,
          logCall: () => {},
        })
      : null;
  const interpreted = completion
    ? await createUnifiedCompletionMessageClassifier(completion)(text, {
        today,
        knownCards: cards,
        knownAccounts: accounts,
        catalog,
      })
    : null;
  if (interpreted?.intent === "non_financial")
    throw new MobileError(
      422,
      "Descreva um lançamento financeiro para continuar.",
    );
  const detail =
    interpreted?.intent === "plain"
      ? interpreted.expense
      : interpreted?.intent === "card_installment"
        ? interpreted.purchase
        : null;
  const kind = /\b(recebi|sal[aá]rio|receita|freela)\b/i.test(text)
    ? "income"
    : "expense";
  const description = detail?.description ?? parsed.description;
  const amountCents =
    interpreted?.intent === "card_installment"
      ? (interpreted.purchase.totalCents ??
        (interpreted.purchase.perInstallmentCents &&
        interpreted.purchase.installmentCount
          ? interpreted.purchase.perInstallmentCents *
            interpreted.purchase.installmentCount
          : undefined))
      : interpreted?.intent === "plain"
        ? (interpreted.expense.amountCents ?? parsed.amountCents)
        : parsed.amountCents;
  const occurredOn =
    interpreted?.intent === "plain"
      ? (interpreted.expense.occurredOn ?? parsed.occurredOn)
      : interpreted?.intent === "card_installment"
        ? (interpreted.purchase.purchasedOn ?? parsed.occurredOn)
        : parsed.occurredOn;
  const result = await suggestCategory(
    {
      householdId,
      description,
      amountCents,
      occurredOn,
      kind,
    },
    {
      catalog,
      memoryStore: {
        async findActiveByHousehold() {
          return memory.map((m) => ({
            id: m.id,
            householdId: m.household_id,
            pattern: m.pattern,
            categoryId: m.category_id,
            subcategoryId: m.subcategory_id,
            isActive: m.is_active,
            matchKind: m.match_kind ?? undefined,
            rowKind: m.row_kind ?? undefined,
            confidence: m.confidence,
            explanation: m.explanation,
          }));
        },
      },
    },
  );
  const candidates = (
    result.suppressed ? [] : (detail?.categoryCandidates ?? [])
  ).flatMap((c) => {
    const cat = catalog.categories.find(
      (x) => x.name.toLocaleLowerCase() === c.categoryName.toLocaleLowerCase(),
    );
    const sub = catalog.subcategories.find(
      (x) =>
        x.categoryId === cat?.id &&
        x.name.toLocaleLowerCase() === c.subcategoryName?.toLocaleLowerCase(),
    );
    return cat
      ? [
          {
            categoryId: cat.id,
            subcategoryId: sub?.id,
            explanation: c.explanation,
          },
        ]
      : [];
  });
  if (result.suggestion?.macroCategoryId)
    candidates.unshift({
      categoryId: result.suggestion.macroCategoryId,
      subcategoryId: result.suggestion.subcategoryId,
      explanation: result.suggestion.explanation,
    });
  const findNamed = (list: { id: string; name: string }[]) => {
    const matches = list.filter((x) =>
      text.toLocaleLowerCase().includes(x.name.toLocaleLowerCase()),
    );
    return matches.length === 1 ? matches[0]!.id : null;
  };
  const cardId = kind === "expense" ? findNamed(cards) : null;
  const accountId = cardId
    ? null
    : (findNamed(accounts) ?? (accounts.length === 1 ? accounts[0]!.id : null));
  return {
    description,
    amountCents,
    date: occurredOn ?? today,
    kind,
    categoryId: candidates[0]?.categoryId ?? null,
    subcategoryId: candidates[0]?.subcategoryId ?? null,
    accountId,
    creditCardId: cardId,
    installmentCount:
      interpreted?.intent === "card_installment"
        ? (interpreted.purchase.installmentCount ?? 1)
        : 1,
    candidates: candidates.slice(0, 3),
    explanation: result.suppressed
      ? "A categoria foi deixada em branco pela sua regra."
      : (candidates[0]?.explanation ??
        "Escolha a categoria e o pagamento para confirmar."),
    intent: interpreted?.intent,
  };
}
