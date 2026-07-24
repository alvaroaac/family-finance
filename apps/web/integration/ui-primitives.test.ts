import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  AppShell,
  Badge,
  Button,
  Card,
  Delta,
  EmptyState,
  Field,
  IconHome,
  Input,
  isNavItemActive,
  Kicker,
  MonthStepper,
  PageTitle,
  PillToggle,
  PressureBars,
  RouteSkeleton,
  RowCardList,
  Select,
  StatCard,
  Table,
  TableRow,
  type NavItem,
} from "../components/ui";

describe("ui primitives — core", () => {
  it("Badge tone=warn renders .ff-badge--warn and children text", () => {
    const html = renderToStaticMarkup(
      createElement(Badge, { tone: "warn", children: "Pendente de revisão" }),
    );
    expect(html).toContain("ff-badge--warn");
    expect(html).toContain("Pendente de revisão");
  });

  it("Badge dot renders the leading dot span", () => {
    const html = renderToStaticMarkup(
      createElement(Badge, { tone: "warn", dot: true, children: "Pendente" }),
    );
    expect(html).toContain("ff-badge__dot");
  });

  it("Button variant=primary renders <button class~=ff-btn--primary type=button>", () => {
    const html = renderToStaticMarkup(
      createElement(Button, { variant: "primary", children: "Salvar lançamento" }),
    );
    expect(html).toMatch(/<button[^>]*class="[^"]*ff-btn--primary[^"]*"/);
    expect(html).toMatch(/<button[^>]*type="button"/);
    expect(html).toContain("Salvar lançamento");
  });

  it("Button defaults to ghost variant", () => {
    const html = renderToStaticMarkup(createElement(Button, { children: "Cancelar" }));
    expect(html).toContain("ff-btn--ghost");
  });

  it("Button loading state is immediate, disabled and announced", () => {
    const html = renderToStaticMarkup(
      createElement(Button, {
        loading: true,
        loadingText: "Salvando…",
        children: "Salvar",
      }),
    );
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("disabled");
    expect(html).toContain("ff-spinner");
    expect(html).toContain("Salvando…");
    expect(html).not.toContain(">Salvar<");
  });

  it("route skeletons preserve page-specific geometry", () => {
    const expectedClassByVariant = {
      resumo: "ff-grid-resumo",
      dashboard: "ff-grid-stats",
      transactions: "ff-skeleton-table",
      imports: "ff-skeleton-upload",
      categories: "ff-skeleton-category-list",
      accounts: "ff-cards-grid",
      cards: "ff-skeleton-fields",
      obligations: "ff-skeleton-rows",
      investments: "ff-skeleton-actions",
      settings: "ff-skeleton-theme-grid",
    } as const;

    for (const [variant, expectedClass] of Object.entries(expectedClassByVariant)) {
      const html = renderToStaticMarkup(
        createElement(RouteSkeleton, {
          variant: variant as keyof typeof expectedClassByVariant,
        }),
      );
      expect(html).toContain('role="status"');
      expect(html).toContain(expectedClass);
    }
  });

  it("StatCard renders kicker uppercase text + value inside .ff-num", () => {
    const html = renderToStaticMarkup(
      createElement(StatCard, { kicker: "Gasto do mês", value: "R$ 4.812,90" }),
    );
    expect(html).toContain("Gasto do mês");
    expect(html).toMatch(/class="[^"]*ff-num[^"]*"[^>]*>R\$ 4\.812,90/);
  });

  it("StatCard tone=positive marks the value", () => {
    const html = renderToStaticMarkup(
      createElement(StatCard, {
        kicker: "Entrou",
        value: "R$ 12.400,00",
        tone: "positive",
      }),
    );
    expect(html).toContain("ff-stat__value--positive");
  });

  it("Card composes modifier classes from props", () => {
    const html = renderToStaticMarkup(
      createElement(Card, {
        soft: true,
        hoverable: true,
        warnEdge: true,
        accentEdge: true,
        children: "conteúdo",
      }),
    );
    expect(html).toContain("ff-card");
    expect(html).toContain("ff-card--soft");
    expect(html).toContain("ff-card--hoverable");
    expect(html).toContain("ff-card--warn-edge");
    expect(html).toContain("ff-card--accent-edge");
  });

  it("Kicker renders the .ff-kicker class", () => {
    const html = renderToStaticMarkup(createElement(Kicker, { children: "Nossa casa" }));
    expect(html).toContain("ff-kicker");
    expect(html).toContain("Nossa casa");
  });

  it("PageTitle renders kicker, title and optional lead", () => {
    const html = renderToStaticMarkup(
      createElement(PageTitle, {
        kicker: "Nossa casa · Julho de 2026",
        title: "Transações",
        lead: "Tudo que entrou e saiu — dá pra ajustar categoria, descrição e responsável direto na lista.",
      }),
    );
    expect(html).toContain("Nossa casa · Julho de 2026");
    expect(html).toMatch(/<h1[^>]*>Transações<\/h1>/);
    expect(html).toContain("Tudo que entrou e saiu");
  });

  it("Delta renders the arrow for its direction and the tone wash", () => {
    const html = renderToStaticMarkup(
      createElement(Delta, {
        direction: "down",
        tone: "positive",
        children: "R$ 320 a menos que junho 🌱",
      }),
    );
    expect(html).toContain("↓");
    expect(html).toContain("ff-delta--positive");
    expect(html).toContain("R$ 320 a menos que junho 🌱");
  });

  it("EmptyState renders icon bubble, title, description and action", () => {
    const html = renderToStaticMarkup(
      createElement(EmptyState, {
        icon: createElement(IconHome, {}),
        title: "Nenhum lançamento por aqui ainda",
        description:
          "Quando a gente lançar algo — pelo site ou pelo bot — aparece aqui.",
        action: createElement(Button, { children: "Importar fatura" }),
      }),
    );
    expect(html).toContain("ff-empty");
    expect(html).toContain("Nenhum lançamento por aqui ainda");
    expect(html).toContain("aparece aqui");
    expect(html).toContain("Importar fatura");
  });

  it("Field renders the uppercase mini-label and its control", () => {
    const html = renderToStaticMarkup(
      createElement(Field, {
        label: "Descrição",
        children: createElement(Input, { defaultValue: "Mercado Guanabara" }),
      }),
    );
    expect(html).toMatch(/<label[^>]*class="[^"]*ff-field__label[^"]*"[^>]*>Descrição<\/label>/);
    expect(html).toContain("ff-input");
  });

  it("Input renders the .ff-input class and forwards native props", () => {
    const html = renderToStaticMarkup(
      createElement(Input, { name: "description", placeholder: "PIX João da horta" }),
    );
    expect(html).toMatch(/<input[^>]*class="[^"]*ff-input[^"]*"/);
    expect(html).toContain('name="description"');
    expect(html).toContain('placeholder="PIX João da horta"');
  });

  it("Select renders a native select inside the styled shell with caret", () => {
    const html = renderToStaticMarkup(
      createElement(Select, {
        name: "category",
        defaultValue: "mercado",
        children: createElement("option", { value: "mercado" }, "Mercado"),
      }),
    );
    expect(html).toMatch(/<select[^>]*class="[^"]*ff-select__control[^"]*"/);
    expect(html).toContain('name="category"');
    expect(html).toContain("ff-select__caret");
    expect(html).toContain("Mercado");
  });

  it("MonthStepper renders both hrefs around the month label", () => {
    const html = renderToStaticMarkup(
      createElement(MonthStepper, {
        label: "julho de 2026",
        prevHref: "/transactions?month=2026-06",
        nextHref: "/transactions?month=2026-08",
      }),
    );
    expect(html).toContain('href="/transactions?month=2026-06"');
    expect(html).toContain('href="/transactions?month=2026-08"');
    expect(html).toContain("julho de 2026");
    expect(html).toContain("‹");
    expect(html).toContain("›");
  });

  it("PillToggle marks the active state and links its href", () => {
    const active = renderToStaticMarkup(
      createElement(PillToggle, {
        active: true,
        href: "/transactions",
        children: "Só pendentes · 3",
      }),
    );
    expect(active).toContain("ff-pill--active");
    expect(active).toContain('href="/transactions"');
    expect(active).toContain("Só pendentes · 3");

    const inactive = renderToStaticMarkup(
      createElement(PillToggle, {
        active: false,
        href: "/transactions?pending=1",
        children: "Só pendentes · 3",
      }),
    );
    expect(inactive).not.toContain("ff-pill--active");
  });

  it("Table renders header labels on the grid template and TableRow pending adds the warn stripe", () => {
    const html = renderToStaticMarkup(
      createElement(Table, {
        columns: [
          { key: "day", label: "Dia" },
          { key: "description", label: "Descrição" },
          { key: "amount", label: "Valor", align: "right" as const },
        ],
        gridTemplate: "62px 1fr 110px",
        children: [
          createElement(TableRow, { key: "a", children: "linha normal" }),
          createElement(TableRow, {
            key: "b",
            pending: true,
            children: "linha pendente",
          }),
        ],
      }),
    );
    expect(html).toContain("ff-table");
    expect(html).toContain("Dia");
    expect(html).toContain("Descrição");
    expect(html).toContain("62px 1fr 110px");
    expect(html).toMatch(/ff-table__th--right[^>]*>Valor/);
    expect(html).toContain("ff-row--pending");
    expect(html).toContain("linha pendente");
  });

  it("RowCardList renders the mobile card stack container", () => {
    const html = renderToStaticMarkup(
      createElement(RowCardList, {
        children: createElement(Card, { children: "Mercado Guanabara" }),
      }),
    );
    expect(html).toContain("ff-rowcards");
    expect(html).toContain("Mercado Guanabara");
  });

  it("PressureBars gives the max bar 100% height and marks the active bar", () => {
    const html = renderToStaticMarkup(
      createElement(PressureBars, {
        bars: [
          { label: "JUL", value: 2483, display: "2.483", active: true },
          { label: "AGO", value: 2118, display: "2.118" },
          { label: "DEZ", value: 290, display: "290" },
        ],
      }),
    );
    expect(html).toContain("ff-bars");
    expect(html).toContain("ff-bar--active");
    expect(html).toMatch(/height:100%/);
    expect(html).toContain("2.483");
    expect(html).toContain("AGO");
  });

  it("PressureBars survives an all-zero month set (no division by zero)", () => {
    const html = renderToStaticMarkup(
      createElement(PressureBars, {
        bars: [{ label: "JUL", value: 0, display: "0" }],
      }),
    );
    expect(html).toContain("height:0%");
  });

  it("icons render as line-art SVG (currentColor, stroke 1.7) sized by prop", () => {
    const html = renderToStaticMarkup(createElement(IconHome, { size: 22 }));
    expect(html).toContain("<svg");
    expect(html).toContain('stroke="currentColor"');
    expect(html).toContain('stroke-width="1.7"');
    expect(html).toContain('width="22"');
    expect(html).toContain('fill="none"');
  });
});

describe("ui primitives — app shell", () => {
  const items: NavItem[] = [
    { href: "/resumo", label: "Resumo", icon: "home" },
    { href: "/transactions", label: "Transações", icon: "transfer" },
    { href: "/cards", label: "Cartões", icon: "card" },
    { href: "/settings", label: "Configurações", icon: "sliders" },
  ];

  function renderShell(): string {
    return renderToStaticMarkup(
      createElement(AppShell, {
        items,
        brand: { kicker: "Nossa casa", title: "Alvaro & Karol" },
        user: { initial: "K", name: "Karol", email: "karol@casa.com" },
        signOut: createElement("button", { type: "submit" }, "sair"),
        children: "conteúdo da página",
      }),
    );
  }

  it("renders the sidebar with brand, every nav item and the user footer", () => {
    const html = renderShell();
    expect(html).toContain("ff-sidebar");
    expect(html).toContain("Nossa casa");
    expect(html).toContain("Alvaro &amp; Karol");
    for (const item of items) {
      expect(html).toContain(`href="${item.href}"`);
      expect(html).toContain(item.label);
    }
    expect(html).toContain("Karol");
    expect(html).toContain("karol@casa.com");
    expect(html).toContain("sair");
    expect(html).toContain("conteúdo da página");
  });

  it("renders the mobile bottom nav — Resumo/Transações/Cartões/Mais", () => {
    const html = renderShell();
    expect(html).toContain("ff-bottomnav");
    expect(html).toContain("Mais");
    // "Mais" points at Configurações per the mockup.
    expect(html).toMatch(/ff-bottomnav[^]*href="\/settings"/);
  });

  it("nav active state matches exact paths and nested routes only", () => {
    expect(isNavItemActive("/transactions", "/transactions")).toBe(true);
    expect(isNavItemActive("/transactions/123", "/transactions")).toBe(true);
    expect(isNavItemActive("/transactions-old", "/transactions")).toBe(false);
    expect(isNavItemActive("/resumo", "/transactions")).toBe(false);
    expect(isNavItemActive(null, "/transactions")).toBe(false);
  });
});
