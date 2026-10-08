/**
 * Seeds the disposable e2e stack (scripts/e2e-local-stack.sh) and signs a
 * password user in, saving the @supabase/ssr session cookies as Playwright
 * storage state. Refuses to run against anything but a local Supabase.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { test as setup } from "@playwright/test";
import { createServerClient } from "@supabase/ssr";

import { localAdminClient, localSupabaseConfig } from "./local-db";
import {
  E2E_ACCOUNT,
  E2E_CARD,
  E2E_EMAIL,
  E2E_PASSWORD,
  E2E_SEED_PURCHASE,
  LOCAL_STORAGE_STATE,
  todaySp,
} from "./local-env";

setup("seed local household and sign in", async ({ baseURL }) => {
  const { url: supabaseUrl, anonKey } = localSupabaseConfig();
  const admin = localAdminClient();

  const { data: created, error: userError } = await admin.auth.admin.createUser(
    {
      email: E2E_EMAIL,
      password: E2E_PASSWORD,
      email_confirm: true,
    },
  );
  if (userError !== null) throw userError;
  const userId = created.user.id;

  async function insert<T>(
    table: string,
    row: Record<string, unknown>,
  ): Promise<T> {
    const { data, error } = await admin
      .from(table)
      .insert(row)
      .select()
      .single();
    if (error !== null) throw new Error(`${table}: ${error.message}`);
    return data as T;
  }

  const household = await insert<{ id: string }>("households", {
    name: "Casa E2E",
  });
  await insert("household_members", {
    household_id: household.id,
    user_id: userId,
    display_name: "E2E",
  });
  await insert("accounts", {
    household_id: household.id,
    kind: "checking",
    name: E2E_ACCOUNT,
  });
  const card = await insert<{ id: string }>("credit_cards", {
    household_id: household.id,
    name: E2E_CARD,
    closing_day: 28,
    due_day: 5,
  });

  // Let @supabase/ssr write its own cookie format so the app reads it as-is.
  let jar: { name: string; value: string }[] = [];
  const ssr = createServerClient(supabaseUrl, anonKey, {
    cookies: {
      getAll: () => jar,
      setAll: (cookies) => {
        const names = new Set(cookies.map((cookie) => cookie.name));
        jar = [
          ...jar.filter((cookie) => !names.has(cookie.name)),
          ...cookies.filter((cookie) => cookie.value !== ""),
        ];
      },
    },
  });
  const { error: signInError } = await ssr.auth.signInWithPassword({
    email: E2E_EMAIL,
    password: E2E_PASSWORD,
  });
  if (signInError !== null) throw signInError;
  const { error: purchaseError } = await ssr.from("transactions").insert({
    household_id: household.id,
    kind: "expense",
    amount_cents: E2E_SEED_PURCHASE.cents,
    occurred_on: todaySp(),
    description: E2E_SEED_PURCHASE.description,
    credit_card_id: card.id,
    created_by_user_id: userId,
  });
  if (purchaseError !== null) throw purchaseError;
  if (jar.length === 0) throw new Error("Sign-in produced no session cookies.");

  const domain = new URL(baseURL ?? "http://localhost:3100").hostname;
  mkdirSync(dirname(LOCAL_STORAGE_STATE), { recursive: true });
  writeFileSync(
    LOCAL_STORAGE_STATE,
    JSON.stringify({
      cookies: jar.map(({ name, value }) => ({
        name,
        value,
        domain,
        path: "/",
        expires: -1,
        httpOnly: false,
        secure: false,
        sameSite: "Lax",
      })),
      origins: [],
    }),
  );
});
