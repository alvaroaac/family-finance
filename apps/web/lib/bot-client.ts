import "server-only";

import { createHash, createHmac, randomUUID } from "node:crypto";

const DEFAULT_TIMEOUT_MS = 30_000;
const MIN_SECRET_LENGTH = 32;

export type BotResponse =
  | { ok: true; status: number; json: unknown }
  | { ok: false; reason: "not_configured" | "unreachable" | "timeout" };

/** Signing headers the bot's internal-route verifier expects. `now` is in ms. */
export function signBotRequest(args: {
  secret: string;
  path: string;
  body: string;
  now?: number;
  nonce?: string;
}): Record<string, string> {
  const timestamp = Math.floor((args.now ?? Date.now()) / 1000);
  const nonce = args.nonce ?? randomUUID();
  const bodyHash = createHash("sha256").update(args.body).digest("hex");
  const canonical = `${timestamp}\n${nonce}\nPOST\n${args.path}\n${bodyHash}`;
  return {
    "x-import-timestamp": String(timestamp),
    "x-import-nonce": nonce,
    "x-import-signature": `v1=${createHmac("sha256", args.secret)
      .update(canonical)
      .digest("hex")}`,
  };
}

export function isAllowedBotUrl(url: URL): boolean {
  return (
    url.protocol === "https:" ||
    (url.protocol === "http:" &&
      ["localhost", "127.0.0.1"].includes(url.hostname))
  );
}

function readBotConfig(): { baseUrl: URL; secret: string } | null {
  const baseUrl = process.env.IMPORT_SUGGESTION_URL;
  const secret = process.env.IMPORT_SUGGESTION_SHARED_SECRET;
  if (!baseUrl || !secret || secret.length < MIN_SECRET_LENGTH) return null;
  try {
    const url = new URL(baseUrl);
    return isAllowedBotUrl(url) ? { baseUrl: url, secret } : null;
  } catch {
    return null;
  }
}

export async function postToBot(
  path: string,
  body: unknown,
  opts: { timeoutMs?: number } = {},
): Promise<BotResponse> {
  const config = readBotConfig();
  if (config === null) return { ok: false, reason: "not_configured" };
  const payload = JSON.stringify(body);
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  try {
    const response = await fetch(new URL(path, config.baseUrl), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...signBotRequest({ secret: config.secret, path, body: payload }),
      },
      body: payload,
      signal: controller.signal,
      cache: "no-store",
      // Never forward financial data or HMAC headers to another origin.
      redirect: "error",
    });
    const json: unknown = await response.json().catch(() => null);
    return { ok: true, status: response.status, json };
  } catch (error) {
    const aborted = error instanceof Error && error.name === "AbortError";
    return { ok: false, reason: aborted ? "timeout" : "unreachable" };
  } finally {
    clearTimeout(timer);
  }
}
