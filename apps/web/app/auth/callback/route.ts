import { NextResponse, type NextRequest } from "next/server";

import { createServerSupabaseClient } from "../../../lib/supabase";

/**
 * OAuth code-exchange handler. After Google sign-in, Supabase redirects the
 * browser here with a `?code=` parameter (PKCE). We exchange that code for a
 * session — `@supabase/ssr` writes the session cookies via the `setAll` adapter
 * on the server client — then forward the user to their intended destination.
 *
 * The allowlist/guard policy is NOT enforced here: establishing a session only
 * proves identity. Authorization is still decided downstream by the `(app)`
 * layout via `requireAuthorizedUser()` (which calls `evaluateAccess`), so a
 * non-allowlisted account that signs in is bounced to the access-denied state.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const { searchParams, origin } = request.nextUrl;
  const code = searchParams.get("code");
  // Where to land after a successful exchange. Defaults to the dashboard, whose
  // route group then runs the authorization guard.
  const next = searchParams.get("next") ?? "/dashboard";

  if (!code) {
    return NextResponse.redirect(`${origin}/login?error=oauth`);
  }

  const supabase = await createServerSupabaseClient();
  const { error } = await supabase.auth.exchangeCodeForSession(code);

  if (error) {
    return NextResponse.redirect(`${origin}/login?error=oauth`);
  }

  return NextResponse.redirect(`${origin}${next}`);
}
