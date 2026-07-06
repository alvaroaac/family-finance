// NOTE: this module is server-only by construction — it imports `next/headers`
// (`cookies()`), which Next.js refuses to bundle into client components. We do
// not import the `server-only` marker package since it is not a dependency here.
import { cookies } from "next/headers";
import { createServerClient, type CookieOptions } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabasePublicConfig } from "@family-finance/config";
import type { Database } from "@family-finance/db";

/**
 * Server-side Supabase client for the Next.js App Router, built with the
 * official `@supabase/ssr` `createServerClient`. The Next.js request cookie
 * store backs the `getAll`/`setAll` adapter so RLS-scoped requests carry the
 * user's access token and refreshed tokens are written back when allowed.
 */

/**
 * Create a request-scoped Supabase server client. Must be awaited because
 * `cookies()` is async in the App Router.
 */
export async function createServerSupabaseClient(): Promise<
  SupabaseClient<Database>
> {
  const cookieStore = await cookies();
  const { supabaseUrl, supabaseAnonKey } = getSupabasePublicConfig();

  // During `next build` / prerender, secrets may be empty. Use safe placeholders
  // so client construction never throws; real requests provide real values.
  const url = supabaseUrl || "https://placeholder.supabase.co";
  const anonKey = supabaseAnonKey || "placeholder-anon-key";

  return createServerClient<Database>(url, anonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        // Cookie writes are not allowed in some server contexts (e.g. Server
        // Components); ignore them there. Session refresh is handled by the
        // middleware, which runs in a writable context.
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options as CookieOptions);
          }
        } catch {
          // Ignore in read-only contexts.
        }
      }
    }
  });
}
