import { createServer } from "node:http";

export type SentMessage = { method: string; chatId: number; text?: string; payload: unknown };

export async function startFakeTelegram(): Promise<{ baseUrl: string; sent: SentMessage[]; stop(): Promise<void> }> {
  const sent: SentMessage[] = [];
  const server = createServer(async (request, response) => {
    const method = new URL(request.url ?? "/", "http://localhost").pathname.split("/").pop()!;
    let body = "";
    for await (const chunk of request) body += chunk;
    const payload = body ? JSON.parse(body) as Record<string, unknown> : {};
    if (method !== "getWebhookInfo") {
      sent.push({ method, chatId: Number(payload.chat_id ?? 0), text: typeof payload.text === "string" ? payload.text : undefined, payload });
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, result: method === "getWebhookInfo" ? { allowed_updates: ["message", "callback_query"] } : { message_id: sent.length } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No fake Telegram port");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    sent,
    stop: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}
