import { cookies } from "next/headers";

import {
  parseTheme,
  resolveBaseTheme,
  themeBackground,
  THEME_COOKIE,
} from "../app/(app)/settings/helpers";
import { getAuthState } from "./auth";
import { currentHouseholdOrFallback } from "./member";

/**
 * The theme of the current request, shared by the root layout (`<html>`
 * attributes) and its viewport (browser chrome color) so they cannot drift.
 * A member gets the household theme (locked, or the `ff-theme` cookie);
 * anyone else (login, access denied) gets the cookie theme and no household.
 * `background` is the page background the user will actually see: the
 * household's `--ff-bg` override when it has one, else the base theme's.
 */
export async function resolveRootTheme() {
  const cookie = (await cookies()).get(THEME_COOKIE)?.value;
  const auth = await getAuthState();
  const household =
    auth.status === "authorized" ? await currentHouseholdOrFallback() : null;
  const base = household
    ? resolveBaseTheme(household.theme, cookie)
    : parseTheme(cookie);
  const background =
    household?.theme.overrides?.["--ff-bg"] ?? themeBackground(base);
  return { base, household, background };
}
