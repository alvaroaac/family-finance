import { createClient } from "@supabase/supabase-js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required (run test:e2e:local).`);
  return value;
}

export function localSupabaseConfig(): { url: string; anonKey: string } {
  const url = requireEnv("E2E_SUPABASE_URL");
  const host = new URL(url).hostname;
  if (host !== "127.0.0.1" && host !== "localhost") {
    throw new Error(`Refusing to use a non-local Supabase (${host}).`);
  }
  return { url, anonKey: requireEnv("E2E_SUPABASE_ANON_KEY") };
}

export function localAdminClient() {
  const { url } = localSupabaseConfig();
  return createClient(url, requireEnv("E2E_SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false },
  });
}
