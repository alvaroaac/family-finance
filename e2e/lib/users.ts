import { createClient } from "@supabase/supabase-js";

export async function createTestUser(email: string, password: string): Promise<{ userId: string }> {
  const admin = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  );
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
  if (error || !data.user) throw error ?? new Error("GoTrue did not create a user");
  return { userId: data.user.id };
}
