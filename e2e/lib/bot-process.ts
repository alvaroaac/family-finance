import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No free port");
  await new Promise<void>((done) => server.close(() => done()));
  return address.port;
}

export async function startBot(env: Record<string, string>): Promise<{ url: string; stop(): Promise<void> }> {
  const port = await freePort();
  const root = resolve(fileURLToPath(new URL("../../", import.meta.url)));
  const childEnv = { ...process.env };
  delete childEnv.OPENAI_API_KEY;
  delete childEnv.ANTHROPIC_API_KEY;
  delete childEnv.TYPESAFE_API_KEY;
  Object.assign(childEnv, env, { PORT: String(port) });
  const child = spawn("node", ["--import", "tsx", "src/server.ts"], {
    cwd: resolve(root, "apps/bot"),
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout?.on("data", (chunk) => { output += chunk; });
  child.stderr?.on("data", (chunk) => { output += chunk; });
  const url = `http://127.0.0.1:${port}`;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error(`Bot exited: ${output}`);
    try {
      if ((await fetch(`${url}/health`)).ok) {
        return { url, stop: async () => {
          const exited = new Promise<void>((done) => child.once("exit", () => done()));
          child.kill("SIGTERM");
          await exited;
        } };
      }
    } catch { /* wait for server */ }
    await new Promise((done) => setTimeout(done, 100));
  }
  child.kill("SIGTERM");
  throw new Error(`Bot did not start: ${output}`);
}
