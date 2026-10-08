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

export async function startBot(
  env: Record<string, string>,
): Promise<{ url: string; stop(): Promise<void> }> {
  const port = await freePort();
  const root = resolve(fileURLToPath(new URL("../../", import.meta.url)));
  const childEnv = { ...process.env };
  delete childEnv.OPENAI_API_KEY;
  delete childEnv.ANTHROPIC_API_KEY;
  delete childEnv.TYPESAFE_API_KEY;
  // Keys are removed, so an inherited paid-fallback flag must not require one.
  childEnv.IMPORT_PAID_FALLBACK_ENABLED = "false";
  Object.assign(childEnv, env, { PORT: String(port) });
  const child = spawn("node", ["--import", "tsx", "src/server.ts"], {
    cwd: resolve(root, "apps/bot"),
    env: childEnv,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  let spawnError: Error | undefined;
  child.stdout?.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr?.on("data", (chunk) => {
    output += chunk;
  });
  child.once("error", (error) => {
    spawnError = error;
  });
  const hasExited = () => child.exitCode !== null || child.signalCode !== null;
  let stopping: Promise<void> | undefined;
  const stop = () =>
    (stopping ??= (async () => {
      if (hasExited() || child.pid === undefined) return;
      let exited = false;
      let resolveExit: () => void;
      function onExit() {
        exited = true;
        resolveExit();
      }
      // Register before sending a signal, then bound each wait and release timers.
      const exitNotification = new Promise<void>((done) => {
        resolveExit = done;
      });
      child.once("exit", onExit);
      async function waitForExit(timeoutMs: number) {
        if (exited || hasExited()) return true;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          return await Promise.race([
            exitNotification.then(() => true),
            new Promise<boolean>((done) => {
              timer = setTimeout(() => done(false), timeoutMs);
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
      }
      try {
        child.kill("SIGTERM");
        if (await waitForExit(2000)) return;
        child.kill("SIGKILL");
        if (!(await waitForExit(2000)))
          throw new Error("Bot did not exit after SIGKILL");
      } finally {
        child.removeListener("exit", onExit);
      }
    })());
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (spawnError || hasExited()) {
      await stop();
      throw new Error(`Bot exited: ${spawnError?.message ?? output}`);
    }
    try {
      if (
        (await fetch(`${url}/health`, { signal: AbortSignal.timeout(500) })).ok
      ) {
        return { url, stop };
      }
    } catch {
      /* wait for server */
    }
    await new Promise((done) => setTimeout(done, 100));
  }
  await stop();
  throw new Error(`Bot did not start: ${output}`);
}
