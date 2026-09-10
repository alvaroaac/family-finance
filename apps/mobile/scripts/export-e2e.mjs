import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
const entry = new URL("../index.ts", import.meta.url);
const original = readFileSync(entry, "utf8");
if (!original.includes('"./App"'))
  throw new Error("Unexpected app entrypoint; refusing to replace it.");
let status = 1;
try {
  writeFileSync(entry, original.replace('"./App"', '"./tests/e2e-app"'));
  const result = spawnSync(
    "pnpm",
    [
      "exec",
      "expo",
      "export",
      "--clear",
      "--platform",
      "web",
      "--output-dir",
      "dist-e2e",
    ],
    {
      cwd: new URL("..", import.meta.url),
      env: { ...process.env, EXPO_NO_TELEMETRY: "1", CI: "1" },
      stdio: "inherit",
    },
  );
  status = result.status ?? 1;
} finally {
  writeFileSync(entry, original);
}
process.exitCode = status;
