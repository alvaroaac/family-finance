import { resolve } from "node:path";

import { provisionMultiTenantFixtures } from "../../../e2e/lib/multi-tenant-fixtures";
import { localAdminClient, localSupabaseConfig } from "./local-db";

export const QUICK_CAPTURE_FIXTURE_PATH = resolve(
  __dirname,
  "../test-results/quick-capture-fixture.json",
);
export const LOCAL_STACK_PATH = resolve(__dirname, "../../../.e2e-supabase");
export const QUICK_CAPTURE_TEXT = "85 no mercado no nubank";

/** Adapt the local stack's env to the existing multi-household harness. */
export function configureQuickCaptureEnv(): void {
  const { url, anonKey } = localSupabaseConfig();
  process.env.NEXT_PUBLIC_SUPABASE_URL = url;
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = anonKey;
  process.env.SUPABASE_SERVICE_ROLE_KEY =
    process.env.E2E_SUPABASE_SERVICE_ROLE_KEY;
}

export async function seedQuickCaptureFixtures() {
  configureQuickCaptureEnv();
  const fixture = await provisionMultiTenantFixtures("quick-capture");
  const admin = localAdminClient();
  const { data: account, error: accountError } = await admin
    .from("accounts")
    .insert({
      household_id: fixture.azul,
      kind: "checking",
      name: "Nubank captura E2E",
    })
    .select("id")
    .single();
  if (accountError) throw accountError;
  const { data: categories, error: categoryError } = await admin
    .from("categories")
    .select("id,name")
    .eq("household_id", fixture.azul)
    .eq("kind", "expense")
    .order("name")
    .limit(2);
  if (categoryError) throw categoryError;
  const [suggestedCategory, editedCategory] = categories;
  if (!suggestedCategory || !editedCategory) {
    throw new Error("Quick capture needs two seeded expense categories.");
  }
  return {
    ...fixture,
    accountId: account.id as string,
    suggestedCategory,
    editedCategory,
    description: "mercado captura E2E",
  };
}

export type QuickCaptureFixture = Awaited<
  ReturnType<typeof seedQuickCaptureFixtures>
>;
