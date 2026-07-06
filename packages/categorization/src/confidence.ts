/**
 * Confidence scoring and thresholds for category suggestions.
 *
 * Confidence is always a number in the closed interval [0, 1]. Every suggestion
 * surfaced by the engine carries one so the UI and the bot can decide whether to
 * auto-apply, ask for confirmation, or fall back to manual categorization.
 *
 * Pure module: no I/O, no domain/db/web imports.
 */

/** Named confidence levels used across rules, memory, and AI fallback. */
export const CONFIDENCE = {
  /** A confirmed correction recalled from memory — trusted most. */
  MEMORY: 0.97,
  /** A deterministic rule on a strong merchant token. */
  RULE: 0.9,
  /** At/above this, a suggestion is shown without forcing confirmation. */
  HIGH: 0.85,
  /** Below this, the suggestion is treated as unreliable. */
  LOW: 0.5,
} as const;

export type ConfidenceTier = "high" | "medium" | "low";

/** Clamp any numeric score into the valid [0, 1] confidence range. */
export function scoreConfidence(raw: number): number {
  if (Number.isNaN(raw)) {
    return 0;
  }
  if (raw < 0) {
    return 0;
  }
  if (raw > 1) {
    return 1;
  }
  return raw;
}

/** Bucket a confidence value into a coarse tier for display/decisions. */
export function tierOf(confidence: number): ConfidenceTier {
  const c = scoreConfidence(confidence);
  if (c >= CONFIDENCE.HIGH) {
    return "high";
  }
  if (c >= CONFIDENCE.LOW) {
    return "medium";
  }
  return "low";
}

/**
 * Whether a suggestion at this confidence must be confirmed before it is saved.
 *
 * Per the spec, confirmation is the default and only a clearly high-confidence
 * match may be shown as ready-to-save; anything below {@link CONFIDENCE.HIGH}
 * asks the user to confirm.
 */
export function needsConfirmation(confidence: number): boolean {
  return scoreConfidence(confidence) < CONFIDENCE.HIGH;
}
