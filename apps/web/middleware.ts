import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

import { getSupabasePublicConfig } from "@family-finance/config";

/**
 * Session-refresh middleware following the `@supabase/ssr` pattern. It builds a
 * server client bound to the request/response cookies and calls `getUser()`,
 * which transparently refreshes an expiring token and writes the new cookies
 * onto the outgoing response. Without this, Server Components (which cannot
 * write cookies) would never persist refreshed sessions.
 *
 * IMPORTANT: this performs NO authorization. The allowlist policy lives in
 * `lib/auth.ts` (`evaluateAccess`) and is applied by the `(app)` route group's
 * layout via `requireAuthorizedUser()`. Keeping the policy out of the
 * middleware preserves its pure, unit-tested core.
 */
export async function middleware(request: NextRequest): Promise<NextResponse> {
  let response = NextResponse.next({ request });

  const { supabaseUrl, supabaseAnonKey } = getSupabasePublicConfig();

  // During build/preview without secrets, skip refresh entirely.
  if (!supabaseUrl || !supabaseAnonKey) {
    return response;
  }

  const supabase = createServerClient(supabaseUrl, supabaseAnonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        for (const { name, value } of cookiesToSet) {
          request.cookies.set(name, value);
        }
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }
      }
    }
  });

  // Touch the user to trigger a token refresh when needed. Do not gate routing
  // on the result here — authorization is decided downstream.
  await supabase.auth.getUser();

  return response;
}

export const config = {
  // Run on all routes except Next.js internals and static assets. Auth cookies
  // must be refreshed on navigations to protected pages and on the OAuth
  // callback, so we keep the matcher broad and exclude only non-page requests.
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)"
  ]
};
