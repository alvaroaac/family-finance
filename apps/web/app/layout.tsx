import type { ReactNode } from "react";
import { cookies } from "next/headers";

import "./globals.css";
import { parseTheme, THEME_COOKIE } from "./(app)/settings/helpers";

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
    <html lang="pt-BR" data-theme={theme}>
      <body
        style={{
          margin: 0,
          fontFamily:
            "system-ui, -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
          background: "#f6f7f9",
          color: "#1a1a1a"
        }}
      >
        {children}
      </body>
    </html>
  );
}
