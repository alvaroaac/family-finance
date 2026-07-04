/**
 * Data layer for "/settings" (Configurações).
 *
 * `buildSettingsData` is the composition tested against the fake store;
 * `loadSettingsData` wraps it with auth/household resolution. The PURE bits
 * (themes, member form parsing, bot copy) live in ./helpers.ts — re-exported
 * here so server code and tests have one import point. The client widgets
 * (settings-forms.tsx) import ./helpers directly, since this module reaches
 * server-only code.
 */

import {
  findHouseholdIdForCurrentUser,
  listHouseholdMembers,
  findLastBotInteraction,
  type AppSupabaseClient,
  type HouseholdMemberProfile,
} from "@family-finance/db";

import type { LastBotInteraction } from "./helpers";

export {
  THEMES,
  THEME_COOKIE,
  DEFAULT_THEME,
  parseTheme,
  memberPatchFromFormData,
  telegramDisplayValue,
  botStatusLabel,
  inputKindLabel,
  type ThemeId,
  type MemberPatch,
  type LastBotInteraction,
} from "./helpers";

export type SettingsData = {
  members: HouseholdMemberProfile[];
  lastBotInteraction: LastBotInteraction | null;
  /** Non-null when data could not be loaded; the page shows an empty state. */
  loadError: string | null;
};

/**
 * Compose the settings dataset from the repositories. Exported separately
 * from `loadSettingsData` so the integration tests can drive it against the
 * fake store — the exact composition production uses.
 */
export async function buildSettingsData(
  client: AppSupabaseClient,
  householdId: string,
): Promise<SettingsData> {
  const [members, lastBotInteraction] = await Promise.all([
    listHouseholdMembers(client, householdId),
    findLastBotInteraction(client, householdId),
  ]);
  return { members, lastBotInteraction, loadError: null };
}

function emptySettings(loadError: string | null): SettingsData {
  return { members: [], lastBotInteraction: null, loadError };
}

/**
 * Load the settings dataset for the current household. Never throws: any
 * failure collapses to an empty state with a `loadError` for the page.
 */
export async function loadSettingsData(): Promise<SettingsData> {
  try {
    const { createServerSupabaseClient } = await import("../../../lib/supabase");
    const client = await createServerSupabaseClient();
    const householdId = await findHouseholdIdForCurrentUser(client);
    if (householdId === null) {
      return emptySettings(null);
    }
    return await buildSettingsData(client, householdId);
  } catch (error) {
    return emptySettings(
      error instanceof Error
        ? error.message
        : "Não foi possível carregar as configurações agora.",
    );
  }
}
