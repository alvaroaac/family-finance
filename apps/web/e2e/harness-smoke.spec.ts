import { expect, test } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { createTestUser } from "../../../e2e/lib/users";
import { storageStateFor } from "../../../e2e/lib/session";

test("a seeded household member reaches dashboard with an SSR session", async ({ browser, baseURL }) => {
  const email = "seed-member@example.test";
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

for (const { email, inactive } of [
  { email: "unlisted@example.com", inactive: false },
  { email: "inactive@example.com", inactive: true },
]) test(`a signed-in user with ${inactive ? "inactive" : "no"} membership sees the denied screen and their email`, async ({ browser, baseURL }) => {
  const password = "Test-password-123!";
  const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  const { data: existing } = await admin.auth.admin.listUsers();
  const prior = existing?.users.find((user) => user.email === email);
  if (prior) await admin.auth.admin.deleteUser(prior.id);
  const { userId } = await createTestUser(email, password);
  if (inactive) {
    const { error } = await admin.from("household_members").insert({
      household_id: "00000000-0000-0000-0000-000000000001",
      user_id: userId,
      is_active: false,
    });
    expect(error).toBeNull();
  }
  const { data: activeMembership } = await admin.from("household_members")
    .select("household_id").eq("user_id", userId).eq("is_active", true).maybeSingle();
  expect(activeMembership).toBeNull();
  const state = await storageStateFor(email, password, baseURL!);
  const context = await browser.newContext({ storageState: state });
  try {
    const page = await context.newPage();
    await page.goto(`${baseURL}/dashboard`);
    await expect(page).toHaveURL(/\/login\?denied=1/);
    await expect(page.locator(".ff-alert--negative")).toContainText(email);
  } finally {
    await context.close();
  }
});
