// NOTE: this module is server-only by construction — it imports `next/headers`
// (`cookies()`), which Next.js refuses to bundle into client components. We do
// not import the `server-only` marker package since it is not a dependency here.
import { cookies } from "next/headers";
import {
  createClient,
  type SupabaseClient,
  type SupportedStorage
} from "@supabase/supabase-js";
import { getSupabasePublicConfig } from "@family-finance/config";
import type { Database } from "@family-finance/db";

/**
 * Server-side Supabase client for the Next.js App Router.
 *
 * NOTE: the recommended package for this is `@supabase/ssr`, which is not
 * installable in this offline environment. We replicate its behavior with the
 * mechanism it uses under the hood: a custom `storage` adapter on top of
 * `@supabase/supabase-js`, backed by Next.js request cookies. The session is
 * persisted as a single JSON cookie so RLS-scoped requests carry the user's
 * access token. Swap to `@supabase/ssr` when the registry is reachable.
 */

const SESSION_COOKIE = "ff-auth-token";

/**
 * Build a cookie-backed storage adapter from a Next.js cookie store. Reads are
 * always allowed; writes are best-effort and silently ignored in contexts where
 * cookie mutation is not permitted (e.g. Server Components), matching the
 * read-only guarantees we need for `getUser()` in a layout/page.
 */
function createCookieStorage(
  cookieStore: Awaited<ReturnType<typeof cookies>>
): SupportedStorage {
  return {
    isServer: true,
    getItem: (key) => {
      if (key !== SESSION_COOKIE) {
        return cookieStore.get(key)?.value ?? null;
      }
      return cookieStore.get(SESSION_COOKIE)?.value ?? null;
    },
    setItem: (key, value) => {
      try {
        cookieStore.set(key, value, {
          httpOnly: true,
          sameSite: "lax",
          secure: process.env.NODE_ENV === "production",
          path: "/"
        });
      } catch {
        // Cookie writes are not allowed in some server contexts; ignore.
      }
    },
    removeItem: (key) => {
      try {
        cookieStore.set(key, "", { path: "/", maxAge: 0 });
      } catch {
        // Ignore in read-only contexts.
      }
    }
  };
}

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

  return createClient<Database>(url, anonKey, {
    auth: {
      storageKey: SESSION_COOKIE,
      storage: createCookieStorage(cookieStore),
      persistSession: true,
      autoRefreshToken: false,
      detectSessionInUrl: false
    }
  });
}
