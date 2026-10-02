import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { createTestUser } from "./users.js";

export const testPassword = "Test-password-123!";
export const members = {
  ana: { email: "ana@e2e.test", name: "Ana" },
  bruno: { email: "bruno@e2e.test", name: "Bruno" },
  carla: { email: "carla@e2e.test", name: "Carla" },
  dario: { email: "dario@e2e.test", name: "Dario" },
} as const;

export function adminClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
}

export async function provisionMultiTenantFixtures() {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const themeDir = mkdtempSync(join(tmpdir(), "family-finance-theme-"));
  const themePath = join(themeDir, "theme.json");
  writeFileSync(
    themePath,
    JSON.stringify({
      base: "salvia",
      lockBase: true,
      overrides: { "--ff-accent": "#2f6fed", "--ff-accent-hover": "#1f57c8" },
    }),
  );
  try {
    for (const args of [
      [
        "--name",
        "Casa Azul",
        "--email",
        members.ana.email,
        "--email",
        members.bruno.email,
        "--theme",
        themePath,
      ],
      ["--name", "Casa Verde", "--email", members.carla.email],
    ]) {
      execFileSync("node", ["scripts/create-household.mjs", ...args], {
        cwd: root,
        env: process.env,
        encoding: "utf8",
      });
    }
  } finally {
    rmSync(themeDir, { recursive: true, force: true });
  }

  const admin = adminClient();
  const { data: existing, error: listError } = await admin.auth.admin.listUsers(
    { perPage: 1000 },
  );
  if (listError) throw listError;
  const ids: Record<keyof typeof members, string> = {} as Record<
    keyof typeof members,
    string
  >;
  for (const key of Object.keys(members) as (keyof typeof members)[]) {
    const member = members[key];
    const user = existing.users.find(
      (candidate) => candidate.email === member.email,
    );
    ids[key] =
      user?.id ?? (await createTestUser(member.email, testPassword)).userId;
    if (key !== "dario") {
      const { error } = await admin
        .from("household_members")
        .update({ display_name: member.name })
        .eq("user_id", ids[key]);
      if (error) throw error;
    }
  }
  const { data: households, error } = await admin
    .from("households")
    .select("id,name")
    .in("name", ["Casa Azul", "Casa Verde"]);
  if (error) throw error;
  const azul = households.find(
    (household) => household.name === "Casa Azul",
  )?.id;
  const verde = households.find(
    (household) => household.name === "Casa Verde",
  )?.id;
  if (!azul || !verde) throw new Error("Fixture households missing");
  return { ids, azul, verde };
}
