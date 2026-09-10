import { fetch } from "expo/fetch";
import type {
  MobileData,
  EntryInput,
  DraftSuggestion,
  MobileAction,
} from "@family-finance/mobile-contracts";
import type { DesignSystemSource } from "./design-system";
export class ApiError extends Error {
  constructor(
    message: string,
    public status = 0,
  ) {
    super(message);
  }
}
export class CasaApi {
  constructor(
    private baseUrl: string,
    private token: () => Promise<string>,
    private householdId?: string,
  ) {}
  async request<T>(
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${await this.token()}`,
    };
    if (this.householdId) headers["x-household-id"] = this.householdId;
    const form = typeof FormData !== "undefined" && body instanceof FormData;
    if (body !== undefined && !form)
      headers["Content-Type"] = "application/json";
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (signal?.aborted) controller.abort();
    else signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(
      abort,
      path.startsWith("imports/") ? 120000 : 60000,
    );
    try {
      let response: Awaited<ReturnType<typeof fetch>>;
      try {
        response = await fetch(
          `${this.baseUrl.replace(/\/$/, "")}/api/mobile/v1/${path}`,
          {
            method: body === undefined ? "GET" : "POST",
            headers,
            body:
              body === undefined
                ? undefined
                : form
                  ? body
                  : JSON.stringify(body),
            signal: controller.signal,
          },
        );
      } catch {
        throw new ApiError(
          "Sem conexão. Seu rascunho continua aqui. Atualize antes de repetir uma alteração.",
        );
      }
      let value: unknown;
      try {
        value = await response.json();
      } catch {
        throw new ApiError(
          "O servidor não respondeu como esperado.",
          response.status,
        );
      }
      const error = value as { error?: string; message?: string; ok?: boolean };
      if (!response.ok || error?.ok === false)
        throw new ApiError(
          error?.error ?? error?.message ?? "Não foi possível concluir.",
          response.status,
        );
      return value as T;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }
  load(month?: string, signal?: AbortSignal) {
    return this.request<MobileData>(
      `bootstrap${month ? `?month=${encodeURIComponent(month)}` : ""}`,
      undefined,
      signal,
    );
  }
  suggest(text: string) {
    return this.request<DraftSuggestion>("draft", { text });
  }
  save(entry: EntryInput) {
    return this.request<{ ok: true; id: string }>("entries", entry);
  }
  action(input: MobileAction) {
    return this.request("actions", input);
  }
  designSystem: DesignSystemSource = {
    load: async (theme, signal) =>
      this.request(`design-system?theme=${theme}`, undefined, signal),
  };
}
