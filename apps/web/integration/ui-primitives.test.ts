import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  Badge,
  Button,
  Card,
  Delta,
  EmptyState,
  IconHome,
  Kicker,
  PageTitle,
  StatCard,
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

  it("icons render as line-art SVG (currentColor, stroke 1.7) sized by prop", () => {
    const html = renderToStaticMarkup(createElement(IconHome, { size: 22 }));
    expect(html).toContain("<svg");
    expect(html).toContain('stroke="currentColor"');
    expect(html).toContain('stroke-width="1.7"');
    expect(html).toContain('width="22"');
    expect(html).toContain('fill="none"');
  });
});
