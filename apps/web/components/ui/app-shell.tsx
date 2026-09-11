"use client";

/**
 * AppShell — the "Editorial acolhedor" chrome around every private page:
 * desktop 256px sidebar (soft bg, active item = gold tint + inset gold bar)
 * and mobile bottom nav (Resumo/Transações/Cartões/Mais, per the mockups).
 * "Mais" opens a sheet above the bar with every remaining section, so no
 * page is reachable only by typing its URL on a phone.
 *
 * Design firewall: presentational only. Nav items, brand, user identity,
 * sign-out form and theme picker all arrive via props from `(app)/layout.tsx`.
 * The only client concern here is the active state via `usePathname()`.
 */
import { useEffect, useState, type MouseEvent, type ReactNode } from "react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";

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
import { Spinner } from "./primitives";

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

export type NavItem = {
  href: string;
  label: string;
  icon: keyof typeof NAV_ICONS;
};

/** Active when the pathname is the item's href or a nested route under it. */
export function isNavItemActive(
  pathname: string | null,
  href: string,
): boolean {
  if (pathname === null) {
    return false;
  }
  return pathname === href || pathname.startsWith(`${href}/`);
}

/** Mobile bottom nav shows these three items + "Mais" (sheet with the rest). */
const BOTTOM_NAV_HREFS: ReadonlyArray<string> = [
  "/resumo",
  "/transactions",
  "/cards",
];
const MORE_NAV_ID = "ff-morenav";

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
  const searchParams = useSearchParams();
  const [pendingHref, setPendingHref] = useState<string | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const routeKey = `${pathname ?? ""}?${searchParams?.toString() ?? ""}`;

  useEffect(() => {
    setPendingHref(null);
    setMoreOpen(false);
  }, [routeKey]);

  useEffect(() => {
    if (!moreOpen) {
      return;
    }
    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        setMoreOpen(false);
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [moreOpen]);

  useEffect(() => {
    if (pendingHref === null) {
      return;
    }
    const timeoutId = window.setTimeout(() => setPendingHref(null), 15_000);
    return () => window.clearTimeout(timeoutId);
  }, [pendingHref]);

  useEffect(() => {
    function handleDocumentClick(event: globalThis.MouseEvent): void {
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey ||
        !(event.target instanceof Element)
      ) {
        return;
      }
      const anchor = event.target.closest("a[href]");
      if (
        !(anchor instanceof HTMLAnchorElement) ||
        anchor.target ||
        anchor.download
      ) {
        return;
      }
      const destination = new URL(anchor.href, window.location.href);
      if (
        destination.origin !== window.location.origin ||
        (destination.pathname === window.location.pathname &&
          destination.search === window.location.search)
      ) {
        return;
      }
      setPendingHref(destination.pathname);
    }

    function handleDocumentSubmit(event: SubmitEvent): void {
      if (
        !(event.target instanceof HTMLFormElement) ||
        event.target.method !== "get"
      ) {
        return;
      }
      const destination = new URL(event.target.action, window.location.href);
      if (destination.origin === window.location.origin) {
        setPendingHref(destination.pathname);
      }
    }

    document.addEventListener("click", handleDocumentClick, true);
    document.addEventListener("submit", handleDocumentSubmit, true);
    return () => {
      document.removeEventListener("click", handleDocumentClick, true);
      document.removeEventListener("submit", handleDocumentSubmit, true);
    };
  }, []);

  function startNavigation(
    event: MouseEvent<HTMLAnchorElement>,
    href: string,
  ): void {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey ||
      isNavItemActive(pathname, href)
    ) {
      return;
    }
    setPendingHref(href);
  }

  const bottomItems = BOTTOM_NAV_HREFS.map((href) =>
    items.find((item) => item.href === href),
  ).filter((item): item is NavItem => item !== undefined);
  const moreItems = items.filter(
    (item) => !BOTTOM_NAV_HREFS.includes(item.href),
  );
  const moreActive = moreItems.some((item) =>
    isNavItemActive(pathname, item.href),
  );

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
                className={
                  pendingHref === item.href
                    ? "ff-nav-link ff-nav-link--pending"
                    : active
                      ? "ff-nav-link ff-nav-link--active"
                      : "ff-nav-link"
                }
                aria-current={active ? "page" : undefined}
                aria-busy={pendingHref === item.href || undefined}
                onClick={(event) => startNavigation(event, item.href)}
              >
                <Icon size={18} />
                <span>{item.label}</span>
                {pendingHref === item.href ? <Spinner /> : null}
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
        {pendingHref !== null ? (
          <div
            className="ff-route-progress"
            role="progressbar"
            aria-label="Carregando página"
          >
            <span />
          </div>
        ) : null}
        <main className="ff-main">{children}</main>

        <button
          type="button"
          className="ff-morenav__backdrop"
          aria-label="Fechar menu"
          hidden={!moreOpen}
          onClick={() => setMoreOpen(false)}
        />

        <div className="ff-bottombar">
          <nav
            id={MORE_NAV_ID}
            className="ff-morenav"
            aria-label="Mais telas"
            hidden={!moreOpen}
          >
            {moreItems.map((item) => {
              const Icon = NAV_ICONS[item.icon];
              const active = isNavItemActive(pathname, item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={
                    pendingHref === item.href
                      ? "ff-nav-link ff-nav-link--pending"
                      : active
                        ? "ff-nav-link ff-nav-link--active"
                        : "ff-nav-link"
                  }
                  aria-current={active ? "page" : undefined}
                  aria-busy={pendingHref === item.href || undefined}
                  onClick={(event) => {
                    if (
                      !event.defaultPrevented &&
                      event.button === 0 &&
                      !event.metaKey &&
                      !event.ctrlKey &&
                      !event.shiftKey &&
                      !event.altKey
                    ) {
                      setMoreOpen(false);
                    }
                    startNavigation(event, item.href);
                  }}
                >
                  <Icon size={18} />
                  <span>{item.label}</span>
                  {pendingHref === item.href ? <Spinner /> : null}
                </Link>
              );
            })}
          </nav>

          <nav className="ff-bottomnav">
            {bottomItems.map((item) => {
              const Icon = NAV_ICONS[item.icon];
              const active = isNavItemActive(pathname, item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={
                    active
                      ? "ff-bottomnav__item ff-bottomnav__item--active"
                      : "ff-bottomnav__item"
                  }
                  aria-current={active ? "page" : undefined}
                  aria-busy={pendingHref === item.href || undefined}
                  onClick={(event) => startNavigation(event, item.href)}
                >
                  <Icon size={21} />
                  <span className="ff-bottomnav__label">
                    {item.label}
                    {pendingHref === item.href ? <Spinner /> : null}
                  </span>
                </Link>
              );
            })}
            <button
              type="button"
              className={
                moreOpen || moreActive
                  ? "ff-bottomnav__item ff-bottomnav__item--active"
                  : "ff-bottomnav__item"
              }
              aria-controls={MORE_NAV_ID}
              aria-expanded={moreOpen}
              onClick={() => setMoreOpen((open) => !open)}
            >
              <IconDots size={21} />
              <span className="ff-bottomnav__label">Mais</span>
            </button>
          </nav>
        </div>
      </div>

      {themePicker}
    </div>
  );
}
