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

export async function provisionMultiTenantFixtures(namespace?: string) {
  const fixtureMembers = Object.fromEntries(
    Object.entries(members).map(([key, value]) => [
      key,
      {
        ...value,
        email: namespace ? `${key}-${namespace}@e2e.test` : value.email,
      },
    ]),
  ) as Record<keyof typeof members, { email: string; name: string }>;
  const blueName = namespace ? `Casa Azul ${namespace}` : "Casa Azul";
  const greenName = namespace ? `Casa Verde ${namespace}` : "Casa Verde";
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
        blueName,
        "--email",
        fixtureMembers.ana.email,
        "--email",
        fixtureMembers.bruno.email,
        "--theme",
        themePath,
      ],
      ["--name", greenName, "--email", fixtureMembers.carla.email],
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
    const member = fixtureMembers[key];
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
    .in("name", [blueName, greenName]);
  if (error) throw error;
  const azul = households.find((household) => household.name === blueName)?.id;
  const verde = households.find(
    (household) => household.name === greenName,
  )?.id;
  if (!azul || !verde) throw new Error("Fixture households missing");
  return { ids, azul, verde, members: fixtureMembers, namespace };
}

/** Dispose only namespaced fixtures; shared browser fixtures are preserved. */
export async function disposeMultiTenantFixtures(
  fixture: Awaited<ReturnType<typeof provisionMultiTenantFixtures>>,
) {
  if (!fixture.namespace)
    throw new Error("Refusing to dispose shared fixtures");
  const admin = adminClient();
  const householdIds = [fixture.azul, fixture.verde];
  // Closure/card RESTRICT edges require removing financial children first.
  for (const table of [
    "transactions",
    "card_bill_closures",
    "bot_interactions",
    "bot_conversations",
  ]) {
    const { error } = await admin
      .from(table)
      .delete()
      .in("household_id", householdIds);
    if (error) throw new Error(`${table} fixture cleanup: ${error.message}`);
  }
  const { error } = await admin
    .from("households")
    .delete()
    .in("id", householdIds);
  if (error) throw error;
  for (const userId of Object.values(fixture.ids)) {
    const { error: userError } = await admin.auth.admin.deleteUser(userId);
    if (userError) throw userError;
  }
}
