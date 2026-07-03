import type { ReactNode } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { AppShell, ThemePicker, type NavItem } from "../../components/ui";
import { requireAuthorizedUser } from "../../lib/auth";
import { setThemeAction } from "./settings/actions";
import { parseTheme, THEME_COOKIE } from "./settings/helpers";

/**
 * Navigation for the private Casa workspace — the ONLY nav source. Labels are
 * user-facing pt-BR; hrefs/identifiers stay in English. Order follows the
 * approved mockups (Resumo.dc.html desktop sidebar).
 */
const NAV_ITEMS: NavItem[] = [
  { href: "/resumo", label: "Resumo", icon: "home" },
  { href: "/dashboard", label: "Dashboard", icon: "grid" },
  { href: "/transactions", label: "Transações", icon: "transfer" },
  { href: "/imports", label: "Importação", icon: "upload" },
  { href: "/categories", label: "Categorias", icon: "tag" },
  { href: "/accounts", label: "Contas", icon: "bank" },
  { href: "/cards", label: "Cartões", icon: "card" },
  { href: "/obligations", label: "Obrigações", icon: "bank" },
  { href: "/investments", label: "Investimentos", icon: "jar" },
  { href: "/settings", label: "Configurações", icon: "sliders" }
];

/** End the Supabase session and send the visitor back to the login screen. */
async function signOutAction(): Promise<void> {
  "use server";
  const { createServerSupabaseClient } = await import("../../lib/supabase");
  const supabase = await createServerSupabaseClient();
  await supabase.auth.signOut();
  redirect("/login");
}

/** "karol@casa.com" → "Karol" — friendly fallback until profiles carry names. */
function nameFromEmail(email: string): string {
  const local = email.split("@")[0] ?? email;
  return local.length > 0 ? local.charAt(0).toUpperCase() + local.slice(1) : email;
}

/**
 * Protected app shell. This layout guards the entire `(app)` route group
 * server-side: any unauthenticated visitor is redirected to `/login` and any
 * authenticated-but-not-allowlisted email is sent to the access-denied state
 * BEFORE any child page renders, so protected content never reaches the client.
 */
export default async function AppLayout({ children }: { children: ReactNode }) {
  const { email } = await requireAuthorizedUser();
  const cookieStore = await cookies();
  const theme = parseTheme(cookieStore.get(THEME_COOKIE)?.value);
  const name = nameFromEmail(email);

  return (
    <AppShell
      items={NAV_ITEMS}
      brand={{
        kicker: "Nossa casa",
        title: (
          <>
            Alvaro <span className="ff-amp">&amp;</span> Karol
          </>
        )
      }}
      user={{ initial: name.charAt(0).toUpperCase(), name, email }}
      signOut={
        <form action={signOutAction}>
          <button type="submit" className="ff-signout">
            sair
          </button>
        </form>
      }
      themePicker={<ThemePicker current={theme} onSelect={setThemeAction} />}
    >
      {children}
    </AppShell>
  );
}
