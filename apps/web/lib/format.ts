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
