import type { ReactNode } from "react";
import { cookies } from "next/headers";
import { Inter, Playfair_Display } from "next/font/google";

import "./globals.css";
import "../components/ui/ui.css";
import { parseTheme, THEME_COOKIE } from "./(app)/settings/helpers";

const playfair = Playfair_Display({
  weight: ["500", "600"],
  subsets: ["latin"],
  variable: "--ff-font-display"
});

const inter = Inter({
  weight: ["300", "400", "500", "600"],
  subsets: ["latin"],
  variable: "--ff-font-body"
});

export const metadata = {
  title: "Family Finance — Casa",
  description: "Workspace financeiro privado da casa (Alvaro e Karol)."
};

/**
 * The theme is decided HERE, server-side, from the `ff-theme` cookie set by
 * Configurações — the <html data-theme> attribute is in the first byte of
 * HTML, so there is never a flash of the wrong theme. Esmeralda is the
 * household default; anything unknown falls back to it.
 */
export default async function RootLayout({
  children
}: {
  children: ReactNode;
}) {
  const cookieStore = await cookies();
  const theme = parseTheme(cookieStore.get(THEME_COOKIE)?.value);

  return (
    <html
      lang="pt-BR"
      data-theme={theme}
      className={`${playfair.variable} ${inter.variable}`}
    >
      <body>{children}</body>
    </html>
  );
}
