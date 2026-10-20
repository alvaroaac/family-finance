/** Playwright owns this process, the real signed-route stub, and Next's child. */
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { createBotServer } from "../../bot/src/server.js";
import { CAPTURE_DRAFT_PATH } from "../../bot/src/capture.js";
import { localAdminClient } from "./local-db.js";
import { todaySp } from "./local-env.js";
import {
  configureQuickCaptureEnv,
  LOCAL_STACK_PATH,
  QUICK_CAPTURE_FIXTURE_PATH,
  QUICK_CAPTURE_TEXT,
  seedQuickCaptureFixtures,
} from "./quick-capture-fixtures.js";

async function main() {
  configureQuickCaptureEnv();
  // The shared household provisioner uses SQL, just like e2e/stack.sh.
  const stackEnv = execFileSync("supabase", ["status", "-o", "env"], {
    cwd: LOCAL_STACK_PATH,
    encoding: "utf8",
    env: { ...process.env, SUPABASE_TELEMETRY_DISABLED: "1" },
  });
  const databaseUrl = /^DB_URL="?([^"\n]+)"?$/m.exec(stackEnv)?.[1];
  if (
    !databaseUrl ||
    !["localhost", "127.0.0.1"].includes(new URL(databaseUrl).hostname)
  ) {
    throw new Error("Quick capture requires the disposable local database.");
  }
  process.env.DATABASE_URL = databaseUrl;
  const fixture = await seedQuickCaptureFixtures();
  await mkdir(dirname(QUICK_CAPTURE_FIXTURE_PATH), { recursive: true });
  await writeFile(QUICK_CAPTURE_FIXTURE_PATH, JSON.stringify(fixture));

  // Generated only in memory for this run; no real credentials or AI calls.
  const secret = randomBytes(32).toString("hex");
  const nonces = new Set();
  const admin = localAdminClient();
  /** @type {import("../../bot/src/capture.js").CaptureDraftResult} */
  const result = {
    ok: true,
    intent: "plain",
    draft: {
      description: fixture.description,
      amountCents: 8500,
      date: todaySp(),
      kind: "expense",
      categoryId: fixture.suggestedCategory.id,
      accountId: fixture.accountId,
      installmentCount: 1,
      candidates: [],
      explanation: "Rascunho fixo do teste local.",
      needsReview: false,
    },
  };
  const stub = createBotServer(
    async () => ({ status: 404, body: { ok: false } }),
    {
      signed: {
        secret,
        claimNonce: async (nonce) => {
          if (nonces.has(nonce)) return false;
          nonces.add(nonce);
          return true;
        },
        resolveActorHouseholdId: async (userId) => {
          const { data, error } = await admin
            .from("household_members")
            .select("household_id")
            .eq("user_id", userId)
            .eq("is_active", true)
            .maybeSingle();
          if (error) throw error;
          return data?.household_id ?? null;
        },
      },
      internalRoutes: [
        {
          path: CAPTURE_DRAFT_PATH,
          maxBodyBytes: 262144,
          handle: async (json, actor) => {
            if (
              actor.householdId !== fixture.azul ||
              json.text !== QUICK_CAPTURE_TEXT
            ) {
              return {
                status: 400,
                body: { ok: false, error: "invalid_request" },
              };
            }
            return { status: 200, body: result };
          },
        },
      ],
    },
  );
  // Log status only so the negative signing run has inspectable evidence.
  stub.on("request", (request, response) => {
    response.on("finish", () => {
      console.log(
        `[capture-stub] ${request.method} ${request.url} ${response.statusCode}`,
      );
    });
  });
  await new Promise((resolve, reject) => {
    stub.once("error", reject);
    stub.listen(0, "127.0.0.1", resolve);
  });
  const address = stub.address();
  if (address === null || typeof address === "string") {
    throw new Error("Capture stub did not bind a TCP port.");
  }
  const web = spawn("pnpm", ["dev", "--port", "3100"], {
    cwd: fileURLToPath(new URL("../", import.meta.url)),
    stdio: "inherit",
    env: {
      ...process.env,
      NEXT_TELEMETRY_DISABLED: "1",
      WATCHPACK_POLLING: "true",
      NEXT_FONT_GOOGLE_MOCKED_RESPONSES: fileURLToPath(
        new URL("./local-google-fonts.cjs", import.meta.url),
      ),
      IMPORT_SUGGESTION_URL: `http://127.0.0.1:${address.port}`,
      IMPORT_SUGGESTION_SHARED_SECRET: secret,
    },
  });
  const stop = () => {
    web.kill("SIGTERM");
    stub.close();
    stub.closeAllConnections();
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  web.once("error", (error) => {
    console.error(error);
    stop();
    process.exitCode = 1;
  });
  web.once("exit", (code) => {
    stub.close();
    process.exitCode = code ?? 1;
  });
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
