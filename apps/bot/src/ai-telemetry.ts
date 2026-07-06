/**
 * Structured telemetry for LLM completion calls. The Anthropic client in
 * `providers.ts` is the single seam every AI completion passes through; it emits
 * exactly one {@link AiCallTelemetry} record per call via an injectable
 * {@link AiCallLogger}.
 *
 * The default logger writes one JSON line to stdout (captured by the platform's
 * log drain), so token spend and failure rates are queryable without adding a
 * metrics dependency. The sink is swappable — tests inject a spy; a future sink
 * could POST to a metrics endpoint — without touching any call site.
 */

/** How a completion call ended. */
export type AiCallOutcome =
  | "ok" // model returned usable text
  | "abstain" // 200 but no text — the model chose not to answer
  | "http_error" // non-2xx from the API
  | "timeout" // aborted by the per-request timeout
  | "error"; // network / parse / other throw

/** One record per completion call. Token counts are absent when unknown. */
export type AiCallTelemetry = {
  /** Caller tag for attribution, e.g. "categorizer" | "classifier" | "interpreter". */
  label: string;
  /** Model id the request targeted. */
  model: string;
  outcome: AiCallOutcome;
  /** Wall-clock duration of the call in milliseconds. */
  latencyMs: number;
  /** Prompt tokens billed (API `usage.input_tokens`), when the call reached the API. */
  inputTokens?: number;
  /** Completion tokens billed (API `usage.output_tokens`), when the call reached the API. */
  outputTokens?: number;
  /** HTTP status, set on `http_error`. */
  status?: number;
  /** Error name/message, set on `timeout` / `error`. */
  error?: string;
};

/** Sink for a telemetry record. */
export type AiCallLogger = (record: AiCallTelemetry) => void;

/**
 * Default sink: one JSON line per call, tagged `type:"ai_call"` so log queries
 * can grep for it. Swappable via the `logCall` arg on the client factory.
 */
export const logAiCall: AiCallLogger = (record) => {
  console.log(JSON.stringify({ type: "ai_call", ...record }));
};
