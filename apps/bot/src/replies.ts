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
