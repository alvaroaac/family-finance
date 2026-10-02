import { findHouseholdIdForCurrentUser } from "@family-finance/db";
import { cache } from "react";

/** Relevant part of an authenticated Supabase user. */
export type AuthPrincipal = {
  email?: string | null;
};

export type AccessDecision =
  | { status: "unauthenticated" }
  | { status: "forbidden"; email: string }
  | { status: "authorized"; email: string };

/** Decide access from the session and its RLS-visible active membership. */
export function evaluateAccess(
  principal: AuthPrincipal | null,
  householdId: string | null,
): AccessDecision {
  const email = principal?.email?.trim() ?? "";
  if (email.length === 0) {
    return { status: "unauthenticated" };
  }
  if (householdId !== null) {
    return { status: "authorized", email: email.toLowerCase() };
  }
  return { status: "forbidden", email };
}

export type ServerAuthState =
  | { status: "unauthenticated" }
  | { status: "forbidden"; email: string }
  | { status: "authorized"; email: string; householdId: string };

/** Resolve the current session and its active household under the user's RLS. */
export const getAuthState = cache(async (): Promise<ServerAuthState> => {
  const { createServerSupabaseClient } = await import("./supabase");
  const supabase = await createServerSupabaseClient();

  try {
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user?.email?.trim()) {
      return { status: "unauthenticated" };
    }

    const householdId = await findHouseholdIdForCurrentUser(supabase);
    const decision = evaluateAccess({ email: data.user.email }, householdId);
    return decision.status === "authorized"
      ? { ...decision, householdId: householdId! }
      : decision;
  } catch {
    // Auth and membership query failures both fail closed as signed out.
    return { status: "unauthenticated" };
  }
});

/** Guard protected routes and return the authorized member's household. */
export async function requireAuthorizedUser(): Promise<{
  email: string;
  householdId: string;
}> {
  const { redirect } = await import("next/navigation");
  const state = await getAuthState();

  if (state.status === "authorized") {
    return { email: state.email, householdId: state.householdId };
  }
  if (state.status === "forbidden") {
    return redirect(`/login?denied=1&email=${encodeURIComponent(state.email)}`);
  }
  return redirect("/login");
}
