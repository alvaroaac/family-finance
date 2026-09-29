import type { CSSProperties, ReactNode } from "react";
import { cookies } from "next/headers";
import { Inter, Playfair_Display } from "next/font/google";
import { themeStyle } from "@family-finance/domain";

import "./globals.css";
import "../components/ui/ui.css";
import { getAuthState } from "../lib/auth";
import { currentHousehold } from "../lib/member";
import {
  parseTheme,
  resolveBaseTheme,
  THEME_COOKIE,
} from "./(app)/settings/helpers";

const playfair = Playfair_Display({
  weight: ["500", "600"],
  subsets: ["latin"],
  variable: "--ff-font-display",
});

const inter = Inter({
  weight: ["300", "400", "500", "600"],
  subsets: ["latin"],
  variable: "--ff-font-body",
});

export const metadata = {
  title: "Family Finance — Casa",
  description: "Workspace financeiro privado para a sua casa.",
};

/**
 * The theme is decided HERE, server-side, so the <html> attributes are in the
 * first byte of HTML and there is never a flash of the wrong theme. For a
 * member, the household theme picks the base (locked, or the `ff-theme`
 * cookie) and its validated overrides become inline custom properties on
 * <html>, so body, portals and toasts all inherit them. Anyone else (login,
 * access denied) gets the cookie theme and never a household's overrides.
 */
export default async function RootLayout({
  children,
}: {
  children: ReactNode;
}) {
  const cookie = (await cookies()).get(THEME_COOKIE)?.value;
  const auth = await getAuthState();
  const household =
    auth.status === "authorized" ? await currentHousehold() : null;

  return (
    <html
      lang="pt-BR"
      data-theme={
        household
          ? resolveBaseTheme(household.theme, cookie)
          : parseTheme(cookie)
      }
      style={
        household ? (themeStyle(household.theme) as CSSProperties) : undefined
      }
      className={`${playfair.variable} ${inter.variable}`}
    >
      <body>{children}</body>
    </html>
  );
}
