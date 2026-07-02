"use server";

import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";

import {
  findHouseholdIdForCurrentUser,
  updateHouseholdMember,
} from "@family-finance/db";

import { requireAuthorizedUser } from "../../../lib/auth";
import {
  memberPatchFromFormData,
  parseTheme,
  THEME_COOKIE,
  type ThemeId,
} from "./helpers";

/**
 * Server actions for "Configurações": theme cookie + member profile edits.
 *
 * The member action re-resolves the caller's household from the SESSION —
 * the form never carries (nor is trusted with) a household id — then calls
 * the household-scoped `packages/db` repository and revalidates the page.
 */

export type SettingsActionResult = { ok: boolean; error?: string };

const THEME_COOKIE_MAX_AGE = 60 * 60 * 24 * 365; // one year

/**
 * Persist the household's theme choice in the `ff-theme` cookie. The root
 * layout reads it server-side, so the next render has no theme flash.
 */
export async function setThemeAction(theme: ThemeId): Promise<void> {
  await requireAuthorizedUser();
  const safeTheme = parseTheme(theme);
  const cookieStore = await cookies();
  cookieStore.set(THEME_COOKIE, safeTheme, {
    path: "/",
    maxAge: THEME_COOKIE_MAX_AGE,
  });
  revalidatePath("/", "layout");
}

/**
 * Update a member's display name and/or linked Telegram id. Blank fields
 * clear the value; the Telegram id must be a positive integer.
 */
export async function updateMemberAction(
  formData: FormData,
): Promise<SettingsActionResult> {
  try {
    await requireAuthorizedUser();
    const { createServerSupabaseClient } = await import("../../../lib/supabase");
    const client = await createServerSupabaseClient();
    const householdId = await findHouseholdIdForCurrentUser(client);
    if (householdId === null) {
      throw new Error("Nenhuma casa ativa para o usuário atual.");
    }

    const memberId = formData.get("memberId");
    if (typeof memberId !== "string" || memberId.trim().length === 0) {
      throw new Error("Campo obrigatório ausente: memberId");
    }

    const patch = memberPatchFromFormData(formData);
    await updateHouseholdMember(client, householdId, memberId.trim(), patch);
    revalidatePath("/settings");
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof Error
          ? error.message
          : "Não foi possível salvar o perfil.",
    };
  }
}
