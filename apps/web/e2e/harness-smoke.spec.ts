import { expect, test } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { createTestUser } from "../../../e2e/lib/users";
import { storageStateFor } from "../../../e2e/lib/session";

test("a seeded household member reaches dashboard with an SSR session", async ({ browser, baseURL }) => {
  const email = "alvaro.a.a.a.c@gmail.com";
  const password = "Test-password-123!";
  const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  const { data: existing } = await admin.auth.admin.listUsers();
  const prior = existing?.users.find((user) => user.email === email);
  if (prior) await admin.auth.admin.deleteUser(prior.id);
  const { userId } = await createTestUser(email, password);
  const { data } = await admin.from("household_members").select("household_id").eq("user_id", userId).single();
  expect(data?.household_id).toBe("00000000-0000-0000-0000-000000000001");
  for (const origin of [baseURL!, "http://127.0.0.1:3100"]) {
    const state = await storageStateFor(email, password, origin);
    const context = await browser.newContext({ storageState: state });
    try {
      const page = await context.newPage();
      await page.goto(`${origin}/dashboard`);
      await expect(page).toHaveURL(`${origin}/dashboard`);
      await expect(page.locator("body")).toContainText(/resumo|dashboard|mês/i);
    } finally {
      await context.close();
    }
  }
});
