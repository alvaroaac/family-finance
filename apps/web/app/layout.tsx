import type { ReactNode } from "react";

export const metadata = {
  title: "Family Finance — Casa",
  description: "Workspace financeiro privado da casa (Alvaro e Karol)."
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="pt-BR">
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
