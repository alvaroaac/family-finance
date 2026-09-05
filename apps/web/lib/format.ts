/**
 * Shared pt-BR formatting helpers for the web app (moved out of the dashboard
 * data layer in v1.0 Task 5 so /resumo and /dashboard share one source).
 */

/** Format integer BRL cents into a pt-BR currency string, e.g. "R$ 12,34". */
export function formatBrlCents(cents: number): string {
  return (cents / 100).toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
  });
}

/**
 * Parse a pt-BR ("1.234,56") or dot-decimal ("1234.56") reais string into
 * integer cents. Zero is valid (a caixinha pode ser esvaziada); negative,
 * blank or non-numeric input returns null. Callers that need strictly
 * positive amounts (e.g. card purchases) must additionally reject 0.
 */
export function parseReaisToCents(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }
  let normalized = trimmed.replace(/\s/g, "");
  if (normalized.includes(",")) {
    normalized = normalized.replace(/\./g, "").replace(",", ".");
  }
  const reais = Number.parseFloat(normalized);
  if (!Number.isFinite(reais) || reais < 0) {
    return null;
  }
  return Math.round(reais * 100);
}

const MONTH_NAMES_PT = [
  "janeiro",
  "fevereiro",
  "março",
  "abril",
  "maio",
  "junho",
  "julho",
  "agosto",
  "setembro",
  "outubro",
  "novembro",
  "dezembro",
];

/** "2026-07" -> "julho de 2026". Pure. */
export function monthLabelPtBr(month: string): string {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  if (match === null) return month;
  const idx = Number.parseInt(match[2] as string, 10) - 1;
  const name = MONTH_NAMES_PT[idx] ?? month;
  return `${name} de ${match[1]}`;
}

/** Just the month name, e.g. "2026-06" -> "junho". Pure. */
export function monthNamePtBr(month: string): string {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  if (match === null) return month;
  return MONTH_NAMES_PT[Number.parseInt(match[2] as string, 10) - 1] ?? month;
}
