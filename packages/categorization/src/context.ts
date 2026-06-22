/**
 * Shared input shape for a categorization request.
 *
 * Kept in its own module so `rules.ts`, `memory.ts`, and `index.ts` can all
 * depend on it without import cycles. Pure: no I/O, no domain/db/web imports.
 *
 * The same context is produced by both the importer (one normalized row) and
 * the Telegram bot (one parsed message), so the engine serves both channels.
 */
export type CategorizationContext = {
  householdId: string;
  /** Merchant/payee/description text. The primary signal for matching. */
  description: string;
  /** Optional ISO amount in cents — reserved for future amount-based rules. */
  amountCents?: number;
  /** Optional ISO date (YYYY-MM-DD) — reserved for future seasonal rules. */
  occurredOn?: string;
};
