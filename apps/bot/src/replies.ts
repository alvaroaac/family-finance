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
  lines.push(`• Categoria: ${view.categoryLabel}`);
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

/** PR-2 deferred: card installments are recognized but not yet persisted. */
export function cardInstallmentDeferredMessage(): string {
  return "Compra parcelada no cartão ainda não dá pra registrar por aqui — em breve. Por ora, cadastre em Cartões no painel.";
}

/** PR-2 deferred: card-bill payment ("nubank pago"). */
export function cardBillDeferredMessage(): string {
  return "Baixa de fatura do cartão ainda não está disponível por aqui — em breve.";
}
