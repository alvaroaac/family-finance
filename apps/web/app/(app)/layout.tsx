import type { ReactNode } from "react";
import Link from "next/link";

import { requireAuthorizedUser } from "../../lib/auth";

/**
 * Navigation for the private Casa workspace. Labels are user-facing pt-BR;
 * hrefs/identifiers stay in English.
 */
const NAV_ITEMS: ReadonlyArray<{ href: string; label: string }> = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/imports", label: "Importação" },
  { href: "/transactions", label: "Transações" },
  { href: "/categories", label: "Categorias" },
  { href: "/accounts", label: "Contas" },
  { href: "/settings", label: "Configurações" }
];

/**
 * Protected app shell. This layout guards the entire `(app)` route group
 * server-side: any unauthenticated visitor is redirected to `/login` and any
 * authenticated-but-not-allowlisted email is sent to the access-denied state
 * BEFORE any child page renders, so protected content never reaches the client.
 */
export default async function AppLayout({ children }: { children: ReactNode }) {
  const { email } = await requireAuthorizedUser();

  return (
    <div style={{ display: "flex", minHeight: "100vh" }}>
      <aside
        style={{
          width: 220,
          background: "#11271f",
          color: "#e9f5ef",
          padding: "24px 16px",
          display: "flex",
          flexDirection: "column",
          gap: 24
        }}
      >
        <div>
          <div style={{ fontSize: 12, opacity: 0.7, letterSpacing: 1 }}>
            WORKSPACE
          </div>
          <div style={{ fontSize: 22, fontWeight: 700 }}>Casa</div>
          <div style={{ fontSize: 12, opacity: 0.7, marginTop: 4 }}>
            Finanças de Alvaro e Karol
          </div>
        </div>

        <nav style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {NAV_ITEMS.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              style={{
                color: "#e9f5ef",
                textDecoration: "none",
                padding: "8px 10px",
                borderRadius: 8,
                fontSize: 15
              }}
            >
              {item.label}
            </Link>
          ))}
        </nav>

        <div style={{ marginTop: "auto", fontSize: 12, opacity: 0.8 }}>
          <div>Conectado como</div>
          <div style={{ fontWeight: 600, wordBreak: "break-all" }}>{email}</div>
        </div>
      </aside>

      <main style={{ flex: 1, padding: "32px 40px" }}>{children}</main>
    </div>
  );
}
