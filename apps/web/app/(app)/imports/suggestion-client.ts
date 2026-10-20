import { isAllowedBotUrl, signBotRequest } from "../../../lib/bot-client";

const PATH = "/internal/v1/import-category-suggestions";
const MAX_RESPONSE_BYTES = 256 * 1024;

async function readBoundedJson(response: Response): Promise<unknown> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    throw new Error("Resposta do serviço de sugestões excedeu o limite.");
  }
  if (response.body === null) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("Resposta do serviço de sugestões excedeu o limite.");
    }
    chunks.push(value);
  }
  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(joined));
}

export function signImportSuggestionRequest(args: {
  body: string;
  secret: string;
  timestamp: number;
  nonce: string;
}): string {
  return signBotRequest({
    secret: args.secret,
    path: PATH,
    body: args.body,
    now: args.timestamp * 1000,
    nonce: args.nonce,
  })["x-import-signature"] as string;
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
  if (!isAllowedBotUrl(url)) {
    throw new Error("O serviço de sugestões exige HTTPS.");
  }
  const body = JSON.stringify(args.body);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), args.timeoutMs ?? 30_000);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...signBotRequest({ secret: args.secret, path: PATH, body }),
      },
      body,
      signal: controller.signal,
      cache: "no-store",
      // Never forward financial data or HMAC headers to another origin.
      redirect: "error",
    });
    if (!response.ok) {
      throw new Error(
        `Serviço de sugestões indisponível (${response.status}).`,
      );
    }
    return await readBoundedJson(response);
  } finally {
    clearTimeout(timer);
  }
}
