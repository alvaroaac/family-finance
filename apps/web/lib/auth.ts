import { getAuthorizedEmails, isEmailAuthorized } from "@family-finance/config";

/**
 * Minimal shape of an authenticated principal we need for access decisions.
 * Mirrors the relevant part of a Supabase `User` without importing the type, so
 * the core logic stays pure and trivially testable.
 */
export type AuthPrincipal = {
  email?: string | null;
};

export type AccessDecision =
  | { status: "unauthenticated" }
  | { status: "forbidden"; email: string }
  | { status: "authorized"; email: string };

/**
 * Pure access decision used by every protected route. This contains the entire
 * auth/allowlist policy and has no framework or I/O dependencies so it can be
 * unit-tested in isolation.
 *
 * - No user, or a user without a usable email -> `unauthenticated` (send to login).
 * - Authenticated email not on the allowlist -> `forbidden` (access denied).
 * - Authenticated email on the allowlist -> `authorized`.
 */
export function evaluateAccess(
  principal: AuthPrincipal | null,
  allowlist: readonly string[]
): AccessDecision {
  const email = principal?.email?.trim() ?? "";
  if (email.length === 0) {
    return { status: "unauthenticated" };
  }
  if (isEmailAuthorized(email, allowlist)) {
    return { status: "authorized", email: email.toLowerCase() };
  }
  return { status: "forbidden", email };
}

/**
 * Server-only helpers. Imported lazily so the pure core above can be tested
 * without pulling in Next.js / Supabase server modules.
 */

export type ServerAuthState =
  | { status: "unauthenticated" }
  | { status: "forbidden"; email: string }
  | { status: "authorized"; email: string };

/**
 * Resolve the current request's auth state by reading the Supabase session and
 * applying {@link evaluateAccess} against the `AUTHORIZED_EMAILS` allowlist.
 */
export async function getAuthState(): Promise<ServerAuthState> {
  const { createServerSupabaseClient } = await import("./supabase");
  const supabase = await createServerSupabaseClient();

  let principal: AuthPrincipal | null = null;
  try {
    const {
      data: { user }
    } = await supabase.auth.getUser();
    principal = user ? { email: user.email } : null;
  } catch {
    // Missing/invalid session or unreachable auth -> treat as signed out.
    principal = null;
  }

  return evaluateAccess(principal, getAuthorizedEmails());
}

/**
 * Guard for protected routes. Redirects unauthenticated users to `/login` and
 * unauthorized emails to the access-denied state. Returns the authorized email
 * when access is granted.
 */
export async function requireAuthorizedUser(): Promise<{ email: string }> {
  const { redirect } = await import("next/navigation");
  const state = await getAuthState();

  if (state.status === "unauthenticated") {
    redirect("/login");
  }
  if (state.status === "forbidden") {
    redirect(`/login?denied=1&email=${encodeURIComponent(state.email)}`);
  }
  // status === "authorized"
  return { email: (state as Extract<ServerAuthState, { status: "authorized" }>).email };
}
