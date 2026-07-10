import { createHash, createHmac, randomUUID } from "node:crypto";

const PATH = "/internal/v1/import-category-suggestions";

export function signImportSuggestionRequest(args: {
  body: string;
  secret: string;
  timestamp: number;
  nonce: string;
}): string {
  const bodyHash = createHash("sha256").update(args.body).digest("hex");
  const canonical = `${args.timestamp}\n${args.nonce}\nPOST\n${PATH}\n${bodyHash}`;
  return `v1=${createHmac("sha256", args.secret).update(canonical).digest("hex")}`;
}

export async function requestImportSuggestions(args: {
  baseUrl: string;
  secret: string;
  body: unknown;
  timeoutMs?: number;
}): Promise<unknown> {
  if (args.secret.length < 32)
    throw new Error("Serviço de sugestões não configurado.");
  const url = new URL(PATH, args.baseUrl);
  if (
    url.protocol !== "https:" &&
    !(
      url.protocol === "http:" &&
      ["localhost", "127.0.0.1"].includes(url.hostname)
    )
  ) {
    throw new Error("O serviço de sugestões exige HTTPS.");
  }
  const body = JSON.stringify(args.body);
  const timestamp = Math.floor(Date.now() / 1000);
  const nonce = randomUUID();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), args.timeoutMs ?? 30_000);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-import-timestamp": String(timestamp),
        "x-import-nonce": nonce,
        "x-import-signature": signImportSuggestionRequest({
          body,
          secret: args.secret,
          timestamp,
          nonce,
        }),
      },
      body,
      signal: controller.signal,
      cache: "no-store",
    });
    if (!response.ok) {
      throw new Error(
        `Serviço de sugestões indisponível (${response.status}).`,
      );
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}
