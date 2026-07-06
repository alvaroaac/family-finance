import {
  findHouseholdIdForCurrentUser,
  listHouseholdMembers,
} from "@family-finance/db";
import { createServerSupabaseClient } from "./supabase";
/** "karol@casa.com" → "Karol" — fallback until the member sets a name. */
export function nameFromEmail(email: string): string {
  const local = email.split("@")[0] ?? email;
  return local.length > 0
    ? local.charAt(0).toUpperCase() + local.slice(1)
    : email;
}
/**
 * The logged-in member's friendly name: their `display_name` from
 * Configurações when set, otherwise derived from the email. Never throws —
 * any lookup failure falls back to the email-derived name.
 */
export async function currentMemberName(email: string): Promise<string> {
  try {
    const client = await createServerSupabaseClient();
    const [householdId, auth] = await Promise.all([
      findHouseholdIdForCurrentUser(client),
      client.auth.getUser(),
    ]);
    const userId = auth.data.user?.id;
    if (householdId === null || userId === undefined) {
      return nameFromEmail(email);
    }
    const members = await listHouseholdMembers(client, householdId);
    const me = members.find((m) => m.userId === userId);
    return me?.displayName?.trim() || nameFromEmail(email);
  } catch {
    return nameFromEmail(email);
  }
}
