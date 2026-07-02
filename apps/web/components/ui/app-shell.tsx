"use client";

/**
 * AppShell — the "Editorial acolhedor" chrome around every private page:
 * desktop 256px sidebar (soft bg, active item = gold tint + inset gold bar)
 * and mobile bottom nav (Resumo/Transações/Cartões/Mais, per the mockups).
 *
 * Design firewall: presentational only. Nav items, brand, user identity,
 * sign-out form and theme picker all arrive via props from `(app)/layout.tsx`.
 * The only client concern here is the active state via `usePathname()`.
 */
import type { ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";

import {
  IconBank,
  IconCard,
  IconDots,
  IconGrid,
  IconHome,
  IconJar,
  IconSliders,
  IconTag,
  IconTransfer,
  IconUpload,
} from "./icons";

/** Icon registry so nav config (in the layout) stays serializable strings. */
export const NAV_ICONS = {
  home: IconHome,
  grid: IconGrid,
  transfer: IconTransfer,
  upload: IconUpload,
  tag: IconTag,
  bank: IconBank,
  card: IconCard,
  jar: IconJar,
  sliders: IconSliders,
} as const;

export type NavItem = { href: string; label: string; icon: keyof typeof NAV_ICONS };

/** Active when the pathname is the item's href or a nested route under it. */
export function isNavItemActive(pathname: string | null, href: string): boolean {
  if (pathname === null) {
    return false;
  }
  return pathname === href || pathname.startsWith(`${href}/`);
}

/** Mobile bottom nav shows these three items + "Mais" (→ Configurações). */
const BOTTOM_NAV_HREFS: ReadonlyArray<string> = ["/resumo", "/transactions", "/cards"];
const BOTTOM_NAV_MORE_HREF = "/settings";

export function AppShell(props: {
  items: NavItem[];
  brand: { kicker: string; title: ReactNode };
  user: { initial: string; name: string; email: string };
  signOut?: ReactNode;
  themePicker?: ReactNode;
  children: ReactNode;
}) {
  const { items, brand, user, signOut, themePicker, children } = props;
  const pathname = usePathname();

  const bottomItems = BOTTOM_NAV_HREFS.map((href) =>
    items.find((item) => item.href === href),
  ).filter((item): item is NavItem => item !== undefined);

  return (
    <div className="ff-shell">
      <aside className="ff-sidebar">
        <div className="ff-sidebar__brand">
          <div className="ff-sidebar__brand-kicker">{brand.kicker}</div>
          <div className="ff-sidebar__brand-title ff-serif">{brand.title}</div>
        </div>

        <nav className="ff-sidebar__nav">
          {items.map((item) => {
            const Icon = NAV_ICONS[item.icon];
            const active = isNavItemActive(pathname, item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={active ? "ff-nav-link ff-nav-link--active" : "ff-nav-link"}
                aria-current={active ? "page" : undefined}
              >
                <Icon size={18} />
                {item.label}
              </Link>
            );
          })}
        </nav>

        <div className="ff-sidebar__user">
          <span className="ff-sidebar__avatar" aria-hidden="true">
            {user.initial}
          </span>
          <div className="ff-sidebar__id">
            <div className="ff-sidebar__name">{user.name}</div>
            <div className="ff-sidebar__email">{user.email}</div>
          </div>
          {signOut}
        </div>
      </aside>

      <div className="ff-shell__content">
        <main className="ff-main">{children}</main>

        <nav className="ff-bottomnav">
          {bottomItems.map((item) => {
            const Icon = NAV_ICONS[item.icon];
            const active = isNavItemActive(pathname, item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={
                  active ? "ff-bottomnav__item ff-bottomnav__item--active" : "ff-bottomnav__item"
                }
                aria-current={active ? "page" : undefined}
              >
                <Icon size={21} />
                <span>{item.label}</span>
              </Link>
            );
          })}
          <Link
            href={BOTTOM_NAV_MORE_HREF}
            className={
              isNavItemActive(pathname, BOTTOM_NAV_MORE_HREF)
                ? "ff-bottomnav__item ff-bottomnav__item--active"
                : "ff-bottomnav__item"
            }
          >
            <IconDots size={21} />
            <span>Mais</span>
          </Link>
        </nav>
      </div>

      {themePicker}
    </div>
  );
}
