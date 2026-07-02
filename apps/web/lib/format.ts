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
