// @vitest-environment jsdom
/**
 * Household theme and branding: the stored theme document is validated, the
 * authenticated pages carry the household's overrides and name on the root
 * element, and the login page stays product-neutral.
 */
import type { ReactElement, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  getCurrentHousehold,
  type AppSupabaseClient,
} from "@family-finance/db";
import type { HouseholdTheme } from "@family-finance/domain";

import { ToastProvider } from "../components/ui";
import {
  FakeSupabaseStore,
  createFakeSupabaseClient,
} from "./fake-supabase.js";

const HOUSEHOLD = "00000000-0000-0000-0000-000000000001";
const LOCKED: HouseholdTheme = {
  base: "salvia",
  lockBase: true,
  overrides: { "--ff-accent": "#2f6fed", "--ff-accent-hover": "#1f57c8" },
};

const state = vi.hoisted(() => ({
  cookie: undefined as string | undefined,
  auth: { status: "authorized", email: "ana@e2e.test", householdId: "h" } as
    | { status: "unauthenticated" }
    | { status: "authorized"; email: string; householdId: string },
  household: {
    id: "h",
    name: "Casa Azul",
    theme: { base: "esmeralda" } as HouseholdTheme,
  },
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      name === "ff-theme" && state.cookie !== undefined
        ? { name, value: state.cookie }
        : undefined,
  }),
}));
vi.mock("next/font/google", () => ({
  Inter: () => ({ variable: "font-body" }),
  Playfair_Display: () => ({ variable: "font-display" }),
}));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`redirect ${url}`);
  },
  usePathname: () => "/dashboard",
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ refresh: () => undefined }),
}));
vi.mock("../lib/auth", () => ({
  getAuthState: async () => state.auth,
  requireAuthorizedUser: async () => ({
    email: "ana@e2e.test",
    householdId: "h",
  }),
}));
vi.mock("../lib/member", () => ({
  currentHousehold: async () => state.household,
  currentMemberName: async () => "Ana",
}));
vi.mock("../app/(app)/settings/actions", () => ({
  setThemeAction: async () => undefined,
  updateMemberAction: async () => undefined,
}));
vi.mock("../lib/supabase", () => ({
  createServerSupabaseClient: async () => {
    throw new Error("offline");
  },
}));

vi.stubEnv("NEXT_PUBLIC_SITE_URL", "https://family-finance.example.dev");
const { default: RootLayout, metadata } = await import("../app/layout");
const { default: AppLayout } = await import("../app/(app)/layout");
const { default: LoginPage } = await import("../app/login/page");
const { default: SettingsPage } = await import("../app/(app)/settings/page");

it("uses the canonical site URL for metadata and Open Graph", () => {
  expect(metadata.metadataBase?.origin).toBe(
    "https://family-finance.example.dev",
  );
  expect(metadata.openGraph.url).toBe("https://family-finance.example.dev");
});

async function renderRoot(children: ReactNode = null): Promise<HTMLElement> {
  const html = renderToStaticMarkup(
    (await RootLayout({ children })) as ReactElement,
  );
  const doc = new DOMParser().parseFromString(html, "text/html");
  return doc.documentElement;
}

async function renderApp(): Promise<string> {
  return renderToStaticMarkup(
    (await AppLayout({ children: <p>conteúdo</p> })) as ReactElement,
  );
}

beforeEach(() => {
  state.cookie = undefined;
  state.auth = {
    status: "authorized",
    email: "ana@e2e.test",
    householdId: "h",
  };
  state.household = {
    id: "h",
    name: "Casa Azul",
    theme: { base: "esmeralda" },
  };
});

describe("getCurrentHousehold", () => {
  afterEach(() => vi.restoreAllMocks());

  function client(theme: unknown): AppSupabaseClient {
    const store = new FakeSupabaseStore({
      households: [{ id: HOUSEHOLD, name: "Casa Azul", theme }],
    });
    return createFakeSupabaseClient(store) as unknown as AppSupabaseClient;
  }

  it("returns the household name and its validated theme", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await expect(getCurrentHousehold(client(LOCKED))).resolves.toEqual({
      id: HOUSEHOLD,
      name: "Casa Azul",
      theme: LOCKED,
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it("falls back to Esmeralda and logs one warning with the household id for an invalid document", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const invalid = {
      base: "salvia",
      overrides: { "--ff-accent": "url(https://evil.test/x)" },
    };
    await expect(getCurrentHousehold(client(invalid))).resolves.toEqual({
      id: HOUSEHOLD,
      name: "Casa Azul",
      theme: { base: "esmeralda" },
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain(HOUSEHOLD);
  });

  it("names the failure when no household is visible", async () => {
    const empty = createFakeSupabaseClient(
      new FakeSupabaseStore({ households: [] }),
    ) as unknown as AppSupabaseClient;
    await expect(getCurrentHousehold(empty)).rejects.toThrow(
      /getCurrentHousehold failed/,
    );
  });
});

describe("root element of an authenticated page", () => {
  it("carries the overrides as inline custom properties", async () => {
    state.household.theme = LOCKED;
    const root = await renderRoot();
    expect(root.style.getPropertyValue("--ff-accent")).toBe("#2f6fed");
    expect(root.style.getPropertyValue("--ff-accent-hover")).toBe("#1f57c8");
  });

  it("uses the locked base and ignores the ff-theme cookie", async () => {
    state.household.theme = LOCKED;
    state.cookie = "esmeralda";
    expect((await renderRoot()).getAttribute("data-theme")).toBe("salvia");
  });

  it("lets the cookie choose the base without lockBase, overrides on top", async () => {
    state.household.theme = {
      base: "esmeralda",
      overrides: { "--ff-accent": "#2f6fed" },
    };
    state.cookie = "salvia";
    const root = await renderRoot();
    expect(root.getAttribute("data-theme")).toBe("salvia");
    expect(root.style.getPropertyValue("--ff-accent")).toBe("#2f6fed");
  });

  it("uses the household base when no cookie is set", async () => {
    state.household.theme = { base: "salvia" };
    expect((await renderRoot()).getAttribute("data-theme")).toBe("salvia");
  });

  it.each(["esmeralda", "salvia", undefined])(
    "renders the default document exactly like before (cookie %s)",
    async (cookie) => {
      state.cookie = cookie;
      const root = await renderRoot();
      expect(root.getAttribute("data-theme")).toBe(cookie ?? "esmeralda");
      expect(root.hasAttribute("style")).toBe(false);
    },
  );
});

describe("authenticated layout", () => {
  it("shows the household name and no fixed kicker", async () => {
    const html = await renderApp();
    expect(html).toContain("Casa Azul");
    expect(html).not.toContain("Nossa casa");
  });

  it("does not render the theme picker with lockBase", async () => {
    state.household.theme = LOCKED;
    expect(await renderApp()).not.toContain("ff-themepicker");
  });

  it("renders the theme picker on the cookie base without lockBase", async () => {
    state.cookie = "salvia";
    const html = await renderApp();
    expect(html).toContain("ff-themepicker");
    expect(html).toMatch(/aria-label="Tema Sálvia" aria-pressed="true"/);
  });
});

describe("settings page", () => {
  async function renderSettings(): Promise<string> {
    return renderToStaticMarkup(
      <ToastProvider>{(await SettingsPage()) as ReactElement}</ToastProvider>,
    );
  }

  it("hides the theme cards with lockBase", async () => {
    state.household.theme = LOCKED;
    const html = await renderSettings();
    expect(html).not.toContain("ff-themecard");
    expect(html).not.toContain("Nossa casa");
  });

  it("marks the cookie base as active without lockBase", async () => {
    state.cookie = "salvia";
    expect(await renderSettings()).toMatch(
      /aria-pressed="true" class="ff-themecard ff-themecard--salvia/,
    );
  });
});

describe("login page", () => {
  beforeEach(() => {
    state.auth = { status: "unauthenticated" };
    state.household.theme = LOCKED;
  });

  it("has no overrides on the root element and no household name", async () => {
    state.cookie = "esmeralda";
    const page = (await LoginPage({
      searchParams: Promise.resolve({}),
    })) as ReactElement;
    const root = await renderRoot(page);
    expect(root.hasAttribute("style")).toBe(false);
    expect(root.getAttribute("data-theme")).toBe("esmeralda");
    expect(root.outerHTML).not.toContain("--ff-");
    expect(root.outerHTML).not.toContain("Casa Azul");
  });

  it("shows the product name and the neutral copy", async () => {
    const html = renderToStaticMarkup(
      (await LoginPage({ searchParams: Promise.resolve({}) })) as ReactElement,
    );
    expect(html).toContain("Family Finance");
    expect(html).toContain("As contas da casa, do jeito de vocês.");
    expect(html).toContain("Acesso por convite.");
    expect(html).not.toContain("Nossa casa");
    expect(html).not.toMatch(/alvaro|karol/i);
  });
});

describe("metadata", () => {
  it("describes the product without a household", () => {
    expect(metadata.description).toBe(
      "Workspace financeiro privado para a sua casa.",
    );
  });
});
