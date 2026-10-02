import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServerClient } from "@supabase/ssr";

export async function storageStateFor(email: string, password: string, origin: string): Promise<string> {
  const cookies = new Map<string, { name: string; value: string; options: Record<string, unknown> }>();
  const client = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => [...cookies.values()].map(({ name, value }) => ({ name, value })),
        setAll: (entries) => entries.forEach(({ name, value, options }) => cookies.set(name, { name, value, options })),
      },
    },
  );
  const { error } = await client.auth.signInWithPassword({ email, password });
  if (error) throw error;
  const url = new URL(origin);
  const state = {
    cookies: [...cookies.values()].map(({ name, value, options }) => ({
      name, value, domain: url.hostname, path: String(options.path ?? "/"),
      expires: -1, httpOnly: Boolean(options.httpOnly), secure: url.protocol === "https:",
      sameSite: "Lax" as const,
    })),
    origins: [],
  };
  const dir = await mkdtemp(join(tmpdir(), "family-finance-e2e-session-"));
  const path = join(dir, "storage-state.json");
  await writeFile(path, JSON.stringify(state));
  return path;
}
