/**
 * pt-BR reply formatting for the Telegram bot.
 *
 * Pure string builders: no I/O, no domain/db imports. They turn the
 * conversation's in-progress draft into the editable confirmation summary,
 * correction prompts, and success/cancel messages the user sees.
 */

/** Format BRL integer cents as a pt-BR amount string, e.g. 3250 -> "32,50". */
export function formatBrl(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const reais = Math.floor(abs / 100);
  const centavos = String(abs % 100).padStart(2, "0");
  const reaisStr = reais
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${sign}${reaisStr},${centavos}`;
}

/** Format an ISO date (YYYY-MM-DD) as pt-BR DD/MM/YYYY. */
export function formatIsoDate(iso: string): string {
  const [y, m, d] = iso.split("-");
  if (y === undefined || m === undefined || d === undefined) {
    return iso;
  }
  return `${d}/${m}/${y}`;
}

/** What a confirmation summary needs to render. */
export type SummaryView = {
  amountCents?: number;
  description: string;
  occurredOn: string;
  categoryLabel: string;
  paymentLabel: string;
  responsibleLabel: string;
  /** Why the category was suggested (auditable explanation). */
  categoryExplanation?: string;
  /** AI-proposed NEW category name — rendered as (nova — sugerida). */
  proposedNewCategory?: string;
  /** True when confidence was low / fields were uncertain. */
  needsAttention?: boolean;
};

/**
 * Build the editable confirmation summary shown BEFORE saving. It lists every
 * field and the commands to correct each one, then asks for confirmation.
 */
export function confirmationMessage(view: SummaryView): string {
  const lines: string[] = [];
  lines.push("Confirme o lançamento:");
  lines.push("");
  lines.push(
    `• Valor: R$ ${view.amountCents !== undefined ? formatBrl(view.amountCents) : "— (informe com \"valor 32,50\")"}`,
  );
  lines.push(`• Descrição: ${view.description || "—"}`);
  lines.push(`• Data: ${formatIsoDate(view.occurredOn)}`);
  if (view.proposedNewCategory !== undefined) {
    lines.push(`• Categoria: "${view.proposedNewCategory}" (nova — sugerida)`);
  } else {
    lines.push(`• Categoria: ${view.categoryLabel}`);
  }
  lines.push(`• Pagamento: ${view.paymentLabel}`);
  lines.push(`• Responsável: ${view.responsibleLabel}`);
  if (view.categoryExplanation) {
    lines.push("");
    lines.push(`Sugestão: ${view.categoryExplanation}`);
  }
  lines.push("");
  lines.push("Responda *confirmar* para salvar, ou corrija:");
  lines.push('"valor 45,90" · "data 12/03" · "categoria Alimentação" · "responsável Karol"');
  lines.push('Para descartar, responda *cancelar*.');
  return lines.join("\n");
}

/** Prompt shown when the amount is missing and must be supplied. */
export function needsAmountMessage(description: string): string {
  const what = description ? ` para "${description}"` : "";
  return [
    `Não identifiquei o valor${what}.`,
    'Informe o valor, por exemplo: "valor 32,50".',
  ].join("\n");
}

/**
 * Prefix shown when every AI tier failed (Codex error/timeout, then the paid
 * fallbacks) and the deterministic parser filled the draft alone. The entry
 * still works — the reader just needs to know it was read the simple way.
 */
export const AI_UNAVAILABLE_NOTICE =
  "A leitura inteligente falhou agora; li sua mensagem no modo simples. Confira os campos abaixo.";

/** Confirmation that a correction was applied. */
export function correctionAppliedMessage(field: string): string {
  return `Atualizei ${field}.`;
}

/** Success message after a transaction is saved. */
export function savedMessage(view: {
  amountCents: number;
  description: string;
  occurredOn: string;
  categoryLabel: string;
}): string {
  return [
    "Lançamento salvo! ✅",
    `R$ ${formatBrl(view.amountCents)} · ${view.description} · ${formatIsoDate(view.occurredOn)}`,
    `Categoria: ${view.categoryLabel}`,
  ].join("\n");
}

/** Message after the user cancels. */
export function cancelledMessage(): string {
  return "Tudo bem, não salvei nada. ❌";
}

/** Generic message when we could not understand a correction command. */
export function notUnderstoodMessage(): string {
  return [
    "Não entendi. Você pode:",
    '• confirmar · cancelar',
    '• corrigir: "valor 32,50", "data 12/03", "categoria X", "responsável Karol"',
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Obligations (recurring fixed obligations) — PR-1.
// ---------------------------------------------------------------------------

const MONTH_ABBR_PT = [
  "jan",
  "fev",
  "mar",
  "abr",
  "mai",
  "jun",
  "jul",
  "ago",
  "set",
  "out",
  "nov",
  "dez",
];

/** "2026-10" -> "out/2026". */
export function monthAbbrPtBr(month: string): string {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  if (match === null) {
    return month;
  }
  const idx = Number.parseInt(match[2] as string, 10) - 1;
  return `${MONTH_ABBR_PT[idx] ?? month}/${match[1]}`;
}

/** What an obligation confirmation summary needs to render. */
export type ObligationSummaryView = {
  description: string;
  /** Monthly amount in cents; undefined = still missing (ask for "valor"). */
  monthlyAmountCents?: number;
  termMonths: number | null;
  startMonth: string;
  /** Derived last month, or null when indefinite. */
  endMonth: string | null;
  dueDay: number;
  accountLabel: string;
  categoryLabel: string;
  categoryExplanation?: string;
};

/**
 * Obligation confirmation SUMMARY (design: never one line per parcel).
 * `Financiamento: Solar — R$ 710,44/mês × 72 (out/2026 → set/2032)`.
 */
export function obligationConfirmationMessage(
  view: ObligationSummaryView,
): string {
  const amount =
    view.monthlyAmountCents !== undefined
      ? `R$ ${formatBrl(view.monthlyAmountCents)}/mês`
      : '— (informe com "valor 710,44")';
  const term =
    view.termMonths !== null
      ? ` × ${view.termMonths} (${monthAbbrPtBr(view.startMonth)} → ${monthAbbrPtBr(view.endMonth ?? view.startMonth)})`
      : ` (sem prazo, desde ${monthAbbrPtBr(view.startMonth)})`;
  const kind = view.termMonths !== null ? "Financiamento" : "Obrigação fixa";

  const lines: string[] = [];
  lines.push("Confirme a obrigação:");
  lines.push("");
  lines.push(`• ${kind}: ${view.description} — ${amount}${term}`);
  lines.push(`• Vence dia ${view.dueDay}`);
  lines.push(`• Pago via: ${view.accountLabel}`);
  lines.push(`• Categoria: ${view.categoryLabel}`);
  if (view.categoryExplanation) {
    lines.push(`Sugestão: ${view.categoryExplanation}`);
  }
  lines.push("");
  lines.push("Responda *confirmar* para salvar, ou corrija:");
  lines.push('"valor 710,44" · "dia 5" · "conta Nubank"');
  lines.push("Para descartar, responda *cancelar*.");
  return lines.join("\n");
}

/** Success message after an obligation template is saved. */
export function obligationSavedMessage(view: {
  description: string;
  monthlyAmountCents: number;
  termMonths: number | null;
}): string {
  const term =
    view.termMonths !== null ? ` × ${view.termMonths}` : " (sem prazo)";
  return [
    "Obrigação salva! ✅",
    `${view.description} — R$ ${formatBrl(view.monthlyAmountCents)}/mês${term}`,
    "Quando pagar um mês, é só dizer: por exemplo, " +
      `"${view.description.toLowerCase()} pago".`,
  ].join("\n");
}

/** Success message after a month is materialized as paid. */
export function obligationPaidMessage(view: {
  description: string;
  amountCents: number;
  month: string;
}): string {
  return `Pago! ✅ ${view.description} — R$ ${formatBrl(view.amountCents)} (${monthAbbrPtBr(view.month)})`;
}

/** Friendly no-op when the month was already settled (idempotent repeat). */
export function obligationAlreadyPaidMessage(view: {
  description: string;
  month: string;
}): string {
  return `${view.description} de ${monthAbbrPtBr(view.month)} já estava pago — não lancei de novo. 👍`;
}

/** No active obligation matched the keyword. */
export function obligationNotFoundMessage(keyword: string): string {
  return [
    `Não encontrei uma obrigação parecida com "${keyword}".`,
    "Veja as obrigações ativas no painel, em Obrigações.",
  ].join("\n");
}

/** Two or more obligations matched — ask which one. */
export function obligationAmbiguousMessage(names: string[]): string {
  return `Qual delas? ${names.join(" ou ")}?`;
}

/** Help shown for an unrecognized message during obligation confirmation. */
export function obligationNotUnderstoodMessage(): string {
  return [
    "Não entendi. Você pode:",
    "• confirmar · cancelar",
    '• corrigir: "valor 710,44", "dia 5", "conta Nubank"',
  ].join("\n");
}

/** Mark-paid failed at materialization (e.g. month outside the term window). */
export function obligationSettleFailedMessage(description: string): string {
  return [
    `Não consegui dar baixa em "${description}" — o mês atual pode estar fora do período dessa obrigação.`,
    "Confira em Obrigações no painel.",
  ].join("\n");
}

/** Mark-paid recognized but the settle capability is not wired here. */
export function obligationUnavailableMessage(): string {
  return "Dar baixa em obrigações não está disponível por aqui agora. Use o painel, em Obrigações.";
}

// ---------------------------------------------------------------------------
// Card installments (PR-2 / Task 5).
// ---------------------------------------------------------------------------

/** What an installment confirmation summary needs to render. */
export type InstallmentSummaryView = {
  description: string;
  totalCents?: number;
  installmentCount?: number;
  cardName?: string;
  /** `YYYY-MM` of the first parcel, when the draft is complete enough to compute it. */
  firstDueMonth?: string;
  categoryLabel: string;
  categoryExplanation?: string;
  proposedNewCategory?: string;
  responsibleLabel: string;
  /** True when no card is resolved yet — the reply asks "Qual cartão?". */
  needsCard: boolean;
};

/**
 * Installment confirmation SUMMARY (design: never one line per parcel).
 * `Compra parcelada: <desc> — R$ <total> em <N>× de R$ <per> no <Card> (1ª parcela <mmm/yyyy>)`.
 */
export function installmentConfirmationMessage(
  view: InstallmentSummaryView,
): string {
  const lines: string[] = [];
  lines.push("Confirme a compra parcelada:");
  lines.push("");

  if (
    view.totalCents !== undefined &&
    view.installmentCount !== undefined &&
    view.cardName !== undefined
  ) {
    const perFragment =
      view.totalCents % view.installmentCount === 0
        ? ` de R$ ${formatBrl(view.totalCents / view.installmentCount)}`
        : "";
    const firstParcel =
      view.firstDueMonth !== undefined
        ? ` (1ª parcela ${monthAbbrPtBr(view.firstDueMonth)})`
        : "";
    lines.push(
      `Compra parcelada: ${view.description} — R$ ${formatBrl(view.totalCents)} em ${view.installmentCount}×${perFragment} no ${view.cardName}${firstParcel}`,
    );
  } else {
    lines.push(`Compra parcelada: ${view.description}`);
    if (view.totalCents === undefined) {
      lines.push('• valor? (informe com "valor 3.700")');
    }
    if (view.installmentCount === undefined) {
      lines.push('• parcelas? (informe com "parcelas 12")');
    }
    if (view.needsCard) {
      lines.push("• cartão?");
    }
  }

  if (view.proposedNewCategory !== undefined) {
    lines.push(`• Categoria: "${view.proposedNewCategory}" (nova — sugerida)`);
  } else {
    lines.push(`• Categoria: ${view.categoryLabel}`);
  }
  lines.push(`• Responsável: ${view.responsibleLabel}`);
  if (view.categoryExplanation) {
    lines.push("");
    lines.push(`Sugestão: ${view.categoryExplanation}`);
  }
  lines.push("");
  lines.push(
    'Confirma? Corrija com "valor 3.700", "parcelas 10", "cartão X", "categoria Y", "data 12/06", ou "cancelar".',
  );
  return lines.join("\n");
}

/** Success message after a card installment purchase is saved. */
export function installmentSavedMessage(view: {
  description: string;
  totalCents: number;
  installmentCount: number;
  cardName: string;
  firstDueMonth: string;
}): string {
  return (
    `Compra parcelada salva! ✅ ${view.description} — R$ ${formatBrl(view.totalCents)} ` +
    `em ${view.installmentCount}× no ${view.cardName} (1ª parcela ${monthAbbrPtBr(view.firstDueMonth)})`
  );
}

/** No active card at all — installments cannot be registered by the bot. */
export function noActiveCardMessage(): string {
  return "Compra parcelada é no cartão — a casa ainda não tem cartão cadastrado. Cadastre um em Cartões no painel.";
}

// ---------------------------------------------------------------------------
// Card-bill payment ("nubank pago", PR-2 / Task 6).
// ---------------------------------------------------------------------------

/** No card matched the mark_paid{card} keyword (household has cards, though). */
export function cardBillNoMatchMessage(keyword: string, cardNames: string[]): string {
  const sorted = [...cardNames].sort((a, b) => a.localeCompare(b, "pt-BR"));
  return `Não encontrei o cartão "${keyword}". Cartões da casa: ${sorted.join(", ")} — ou corrija o nome.`;
}

/** The mark_paid{card} keyword needs a confirmation state prompting "which card?". */
export function chooseCardBillMessage(): string {
  return "Qual cartão é a fatura?";
}

/** The resolved bill is zero this month — nothing to pay, nothing written. */
export function cardBillZeroMessage(cardName: string): string {
  return `Fatura do ${cardName} está zerada este mês — nada pra pagar. 👍`;
}

/**
 * Card-bill confirmation SUMMARY: `Fatura <Card> de <mmm/yyyy> — R$ <amount>.
 * Pagar da conta <Account>?` plus the correction hint.
 */
export function cardBillConfirmationMessage(view: {
  cardName: string;
  month: string;
  amountCents: number;
  accountLabel: string;
}): string {
  return [
    `Fatura ${view.cardName} de ${monthAbbrPtBr(view.month)} — R$ ${formatBrl(view.amountCents)}. Pagar da conta ${view.accountLabel}?`,
    "",
    'Responda "confirmar", corrija com "valor 2.350" ou "conta X", ou "cancelar".',
  ].join("\n");
}

/** Success message after a card bill is settled. */
export function cardBillPaidMessage(view: {
  cardName: string;
  amountCents: number;
  month: string;
}): string {
  return `Fatura paga! ✅ ${view.cardName} — R$ ${formatBrl(view.amountCents)} (${monthAbbrPtBr(view.month)})`;
}

/** Friendly no-op when the bill month was already settled (idempotent repeat). */
export function cardBillAlreadyPaidMessage(view: {
  cardName: string;
  month: string;
}): string {
  return `A fatura do ${view.cardName} de ${monthAbbrPtBr(view.month)} já estava paga — nada mudou. 👍`;
}

/** Settle failed (RPC threw) — mirrors `obligationSettleFailedMessage`. */
export function cardBillSettleFailedMessage(cardName: string): string {
  return `Não consegui registrar o pagamento da fatura do ${cardName} — tenta de novo em instantes.`;
}

/** Installment persist failed (RPC threw) — same recovery contract as above. */
export function installmentSaveFailedMessage(description: string): string {
  return `Não consegui salvar a compra parcelada "${description}" — tenta de novo em instantes.`;
}

// ---------------------------------------------------------------------------
// Inline buttons + category creation (2026-07-04 design).
// ---------------------------------------------------------------------------

/** Prompt when the bot is waiting for a new category's name. */
export function askCategoryNameMessage(): string {
  return [
    "Qual o nome da nova categoria?",
    'Responda com o nome, ou "cancelar" para voltar.',
  ].join("\n");
}

/** Success after a category is created (standalone or mid-draft). */
export function categoryCreatedMessage(name: string): string {
  return `Categoria "${name}" criada ✅`;
}

/** Dedupe outcome: an existing (or reactivated) category was used instead. */
export function categoryReusedMessage(name: string): string {
  return `A categoria "${name}" já existia — usei ela. ✅`;
}

/** Header for the category-pick grid message. */
export function chooseCategoryMessage(): string {
  return "Escolha a categoria:";
}

/** Header for the responsável-pick grid message. */
export function chooseResponsibleMessage(): string {
  return "Quem é o responsável?";
}

/** pt-BR validation errors for a typed category name. */
export function invalidCategoryNameMessage(
  reason: "empty" | "too_long",
): string {
  return reason === "empty"
    ? "O nome da categoria não pode ficar vazio. Tente de novo, ou responda \"cancelar\"."
    : "O nome da categoria precisa ter no máximo 40 caracteres. Tente um nome mais curto.";
}

/** Toast for a tap on an expired/mismatched conversation. */
export const SESSION_EXPIRED_TOAST =
  "Sessão expirada — envie o gasto novamente.";

/** Toast for a double-tap on ✅ after the draft was already persisted. */
export const ALREADY_SAVED_TOAST = "Já salvo ✅";

/** Toast when a tapped category id is no longer in the catalog. */
export const CATEGORY_NOT_FOUND_TOAST =
  "Categoria não encontrada — abra a lista de novo.";

/** Toast for a tap on a draft created by ANOTHER household member. */
export const DRAFT_NOT_YOURS_TOAST =
  "Esse lançamento é de outra pessoa — só quem criou pode usar os botões.";
