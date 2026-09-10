import { AsyncLocalStorage } from "node:async_hooks";
import { createClient } from "@supabase/supabase-js";
import {
  getSupabasePublicConfig,
  getAuthorizedEmails,
  isEmailAuthorized,
} from "@family-finance/config";
import type { AppSupabaseClient, Database } from "@family-finance/db";
export type MobileContext = {
  client: AppSupabaseClient;
  householdId: string;
  userId: string;
};
const storage = new AsyncLocalStorage<MobileContext>();
export const getMobileContext = () => storage.getStore();
export const withMobileContext = <T>(
  context: MobileContext,
  fn: () => Promise<T>,
) => storage.run(context, fn);
export class MobileError extends Error {
  constructor(
    public status: number,
    message: string,
    public code = "request_failed",
  ) {
    super(message);
  }
}
export async function authenticateMobile(
  request: Request,
): Promise<MobileContext> {
  const auth = request.headers.get("authorization");
  if (!auth?.startsWith("Bearer ") || auth.length > 16384)
    throw new MobileError(401, "Faça login novamente.", "unauthorized");
  const token = auth.slice(7);
  const { supabaseUrl, supabaseAnonKey } = getSupabasePublicConfig();
  if (!supabaseUrl || !supabaseAnonKey)
    throw new MobileError(
      503,
      "A conexão com a Casa ainda não foi configurada.",
    );
  const client = createClient<Database>(supabaseUrl, supabaseAnonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: auth } },
  });
  const {
    data: { user },
    error,
  } = await client.auth.getUser(token);
  if (error || !user)
    throw new MobileError(
      401,
      "Sua sessão expirou. Entre novamente.",
      "unauthorized",
    );
  if (!user.email || !isEmailAuthorized(user.email, getAuthorizedEmails()))
    throw new MobileError(
      403,
      "Este usuário não tem acesso à Casa.",
      "forbidden",
    );
  const { data: memberships, error: membershipError } = await client
    .from("household_members")
    .select("household_id")
    .eq("user_id", user.id)
    .eq("is_active", true);
  if (membershipError)
    throw new MobileError(503, "Não foi possível verificar sua casa.");
  const requested = request.headers.get("x-household-id");
  const membership = requested
    ? memberships?.find((m) => m.household_id === requested)
    : memberships?.length === 1
      ? memberships[0]
      : null;
  if (!membership)
    throw new MobileError(
      403,
      requested
        ? "Você não pertence a esta casa."
        : "Selecione uma casa válida.",
      "household_required",
    );
  return { client, householdId: membership.household_id, userId: user.id };
}
