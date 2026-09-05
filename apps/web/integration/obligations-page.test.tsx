// @vitest-environment jsdom

/**
 * Server-render coverage for the three /obligations panels.
 *
 * They are server components (props in, markup out), so `renderToStaticMarkup`
 * is enough — the client children they mount (payment/edit dialogs, the undo
 * button) only use SSR-safe hooks. `ToastProvider` wraps them because those
 * children call `useToast`.
 */

import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { formatBrlCents } from "../lib/format";
import { ObligationsTable } from "../app/(app)/obligations/obligations-table";
import { ThisMonthCard } from "../app/(app)/obligations/this-month-card";
import { TimelineCard } from "../app/(app)/obligations/timeline-card";
import {
  reliefNote,
  timelineChanges,
} from "../app/(app)/obligations/view-model";
import type {
  ObligationListItem,
  ObligationsData,
  TimelineMonth,
} from "../app/(app)/obligations/queries";
import type { ProjectedEntry } from "@family-finance/domain";
import { ToastProvider } from "../components/ui/toast";

const MONTH = "2026-09";
const ACCOUNT = "acc-itau";
const CATEGORY = "cat-moradia";

const accountName = (id: string): string =>
  id === ACCOUNT ? "Conta Itaú" : "Conta";
const categoryName = (id: string | null): string | null =>
  id === CATEGORY ? "Moradia" : null;

function item(over: Partial<ObligationListItem> = {}): ObligationListItem {
  return {
    id: "ob-1",
    householdId: "hh",
    description: "Aluguel",
    amountCents: 120000,
    startMonth: "2026-01",
    termMonths: null,
    dueDay: 10,
    accountId: ACCOUNT,
    status: "active",
    categoryId: CATEGORY,
    subcategoryId: null,
    responsibilityScope: "household",
    responsibleUserId: null,
    createdByUserId: "user-1",
    endMonth: null,
    remainingMonths: null,
    ...over,
  };
}

function entry(over: Partial<ProjectedEntry> = {}): ProjectedEntry {
  return {
    obligationId: "ob-1",
    month: MONTH,
    amountCents: 120000,
    description: "Aluguel",
    dueDay: 10,
    accountId: ACCOUNT,
    ...over,
  };
}

function slot(over: Partial<TimelineMonth> = {}): TimelineMonth {
  return { month: MONTH, entries: [], paidCents: 0, totalCents: 0, ...over };
}

function render(node: ReactElement): string {
  return renderToStaticMarkup(createElement(ToastProvider, null, node));
}

async function noopAction(): Promise<{ ok: boolean }> {
  return { ok: true };
}

describe("TimelineCard", () => {
  const solar = item({
    id: "ob-solar",
    description: "Placas solares",
    amountCents: 71044,
    startMonth: "2026-11",
    termMonths: 72,
    dueDay: 5,
    endMonth: "2032-10",
  });
  const entrada = item({
    id: "ob-entrada",
    description: "Entrada da Casa",
    amountCents: 366666,
    startMonth: "2026-01",
    termMonths: 10,
    dueDay: 15,
    endMonth: "2026-10",
  });
  const obligations = [solar, entrada];
  const timeline: TimelineMonth[] = [
    slot({ month: "2026-09", totalCents: 366666 }),
    slot({ month: "2026-10", totalCents: 366666 }),
    slot({ month: "2026-11", totalCents: 71044 }),
    slot({ month: "2026-12", totalCents: 71044 }),
  ];
  const changes = timelineChanges(obligations, timeline);

  it("badges only the months that change and opens the first of them", () => {
    const html = render(
      createElement(TimelineCard, {
        timeline,
        changes,
        relief: null,
        paidByMonth: new Map<string, string[]>(),
      }),
    );

    // out/2026 is Entrada's last month, nov/2026 starts Placas + drops Entrada.
    expect(html).toContain("última parcela · Entrada da Casa");
    expect(html).toContain("+ Placas solares");
    expect(html).toContain("− Entrada da Casa quitada");
    // set/2026 and dez/2026 change nothing.
    expect(changes.has("2026-09")).toBe(false);
    expect(changes.has("2026-12")).toBe(false);

    const opened = html.match(/<details open=""/g) ?? [];
    expect(opened).toHaveLength(1);
    const firstDetails = html.slice(html.indexOf("<details"));
    expect(firstDetails.startsWith('<details open=""')).toBe(false);
    // The open row is out/2026 — the first month carrying a badge.
    const openIndex = html.indexOf('<details open=""');
    expect(html.slice(openIndex, openIndex + 400)).toContain("out/2026");
  });

  it("shows the relief note when a term ends inside the window", () => {
    const relief = reliefNote(obligations, timeline);
    expect(relief).not.toBeNull();

    const html = render(
      createElement(TimelineCard, {
        timeline,
        changes,
        relief,
        paidByMonth: new Map<string, string[]>(),
      }),
    );

    // formatBrlCents emits a non-breaking space after "R$".
    expect(html).toContain(
      `alívio de ${formatBrlCents(366666)}/mês a partir de nov/2026`,
    );
  });

  it("omits the relief note when nothing is given", () => {
    const html = render(
      createElement(TimelineCard, {
        timeline,
        changes,
        relief: null,
        paidByMonth: new Map<string, string[]>(),
      }),
    );

    expect(html).not.toContain("alívio de");
  });
});

describe("ThisMonthCard", () => {
  const unimed = item({
    id: "ob-unimed",
    description: "Unimed",
    amountCents: 120000,
    dueDay: 5,
    categoryId: null,
  });
  const casa = item({
    id: "ob-casa",
    description: "Financiamento Casa",
    dueDay: 20,
  });
  const luz = item({
    id: "ob-luz",
    description: "Luz",
    dueDay: 12,
    categoryId: null,
  });

  function data(over: Partial<ObligationsData> = {}): ObligationsData {
    return {
      month: MONTH,
      obligations: [unimed, casa, luz],
      ended: [],
      thisMonth: { unpaid: [], paid: [] },
      timeline: [],
      loadError: null,
      ...over,
    };
  }

  it("orders the unpaid rows by due day", () => {
    const html = render(
      createElement(ThisMonthCard, {
        data: data({
          thisMonth: {
            unpaid: [
              entry({
                obligationId: "ob-casa",
                description: "Financiamento Casa",
                dueDay: 20,
              }),
              entry({
                obligationId: "ob-unimed",
                description: "Unimed",
                dueDay: 5,
              }),
              entry({ obligationId: "ob-luz", description: "Luz", dueDay: 12 }),
            ],
            paid: [],
          },
        }),
        today: "2026-09-01",
        accountName,
        categoryName,
        markPaidAction: noopAction,
        undoAction: noopAction,
      }),
    );

    expect(html.indexOf("Unimed")).toBeLessThan(html.indexOf("Luz"));
    expect(html.indexOf("Luz")).toBeLessThan(
      html.indexOf("Financiamento Casa"),
    );
  });

  it("marks overdue and near-due rows from today", () => {
    const html = render(
      createElement(ThisMonthCard, {
        data: data({
          thisMonth: {
            unpaid: [
              entry({
                obligationId: "ob-unimed",
                description: "Unimed",
                dueDay: 5,
              }),
              entry({ obligationId: "ob-luz", description: "Luz", dueDay: 12 }),
              entry({
                obligationId: "ob-casa",
                description: "Financiamento Casa",
                dueDay: 20,
              }),
            ],
            paid: [],
          },
        }),
        today: "2026-09-11",
        accountName,
        categoryName,
        markPaidAction: noopAction,
        undoAction: noopAction,
      }),
    );

    expect(html).toContain("ff-checklist__row--overdue");
    expect(html).toContain("atrasada");
    expect(html).toContain("ff-checklist__row--warn");
    expect(html).toContain("vence amanhã");
    // Day 20 is nine days out — no state class of its own.
    expect(html).not.toContain("vence em 9 dias");
  });

  it("renders paid rows with a paga badge and an undo button", () => {
    const html = render(
      createElement(ThisMonthCard, {
        data: data({
          thisMonth: {
            unpaid: [
              entry({ obligationId: "ob-luz", description: "Luz", dueDay: 12 }),
            ],
            paid: [
              {
                obligationId: "ob-unimed",
                transactionId: "tx-1",
                description: "Unimed",
                amountCents: 120000,
                paidOn: "2026-09-01",
              },
            ],
          },
        }),
        today: "2026-09-11",
        accountName,
        categoryName,
        markPaidAction: noopAction,
        undoAction: noopAction,
      }),
    );

    expect(html).toContain("ff-checklist__row--paid");
    expect(html).toContain(">paga<");
    expect(html).toContain("desfazer");
    expect(html).toContain("Paga em 1º de set · Conta Itaú");
  });

  it("shows an empty state when nothing is due", () => {
    const html = render(
      createElement(ThisMonthCard, {
        data: data(),
        today: "2026-09-11",
        accountName,
        categoryName,
        markPaidAction: noopAction,
        undoAction: noopAction,
      }),
    );

    expect(html).toContain("Nada vence este mês.");
  });
});

describe("ObligationsTable", () => {
  const casa = item({
    id: "ob-casa",
    description: "Financiamento Casa",
    amountCents: 765000,
    startMonth: "2025-08",
    termMonths: 360,
    dueDay: 10,
    endMonth: "2055-07",
  });
  const aluguel = item({
    id: "ob-aluguel",
    description: "Aluguel",
    dueDay: 10,
  });
  const solar = item({
    id: "ob-solar",
    description: "Placas solares",
    amountCents: 71044,
    startMonth: "2026-10",
    termMonths: 72,
    dueDay: 5,
    endMonth: "2032-09",
  });
  const antigo = item({
    id: "ob-antigo",
    description: "Financiamento antigo",
    amountCents: 5000,
    startMonth: "2020-01",
    termMonths: 12,
    dueDay: 1,
    status: "canceled",
    endMonth: "2020-12",
  });

  const props = {
    items: [casa, aluguel, solar],
    ended: [antigo],
    currentMonth: MONTH,
    accountName,
    categoryName,
    accounts: [{ id: ACCOUNT, name: "Conta Itaú" }],
    categories: [{ id: CATEGORY, name: "Moradia" }],
    updateAction: noopAction,
    cancelAction: noopAction,
  };

  it("renders each term shape", () => {
    const html = render(
      createElement(ObligationsTable, { ...props, showEnded: false }),
    );

    expect(html).toContain("13 de 360 pagas · até jul/2055");
    expect(html).toContain("sem prazo");
    expect(html).toContain("começa em out/2026 · 72 parcelas");
    expect(html).toContain("vence dia 10 · Conta Itaú · Moradia");
  });

  it("lists the ended obligations only when asked", () => {
    const hidden = render(
      createElement(ObligationsTable, { ...props, showEnded: false }),
    );
    expect(hidden).not.toContain("Financiamento antigo");
    expect(hidden).toContain("ver encerradas");

    const shown = render(
      createElement(ObligationsTable, { ...props, showEnded: true }),
    );
    expect(shown).toContain("Financiamento antigo");
    expect(shown).toContain("encerrada");
  });

  it("fades and badges finished active templates in both layouts", () => {
    const html = render(
      createElement(ObligationsTable, {
        ...props,
        items: [],
        ended: [item({ ...antigo, status: "active" })],
        showEnded: true,
      }),
    );
    const container = document.createElement("div");
    container.innerHTML = html;
    for (const selector of [".ff-table .ff-row", ".ff-rowcards .ff-rowcard"]) {
      const row = container.querySelector(selector);
      expect(row?.classList.contains("ff-off")).toBe(true);
      expect(row?.querySelector(".ff-badge")?.textContent).toBe("encerrada");
      expect(row?.querySelector("button")).toBeNull();
    }
  });

  it("keeps the total and archive toggle reachable in the mobile footer", () => {
    for (const showEnded of [false, true]) {
      const container = document.createElement("div");
      container.innerHTML = render(
        createElement(ObligationsTable, { ...props, showEnded }),
      );
      const href = showEnded ? "?" : "?encerradas=1";
      expect(container.querySelectorAll(`a[href="${href}"]`)).toHaveLength(2);
      const mobileFoot = container.querySelector(".ff-mobile-foot");
      expect(mobileFoot?.querySelector("a")?.getAttribute("href")).toBe(href);
      expect(mobileFoot?.textContent).toContain("Total a partir de out/2026");
      expect(mobileFoot?.textContent).toContain(formatBrlCents(956044));
      expect(mobileFoot?.closest(".ff-table")).toBeNull();
    }
  });

  it("shows a full-width desktop empty state and a mobile empty state", () => {
    const container = document.createElement("div");
    container.innerHTML = render(
      createElement(ObligationsTable, {
        ...props,
        items: [],
        ended: [],
        showEnded: false,
      }),
    );
    for (const selector of [".ff-table > .ff-empty", ".ff-rowcards > .ff-empty"]) {
      expect(container.querySelector(selector)?.textContent).toBe(
        "Nenhuma obrigação cadastrada.",
      );
    }
    expect(container.querySelector(".ff-table .ff-row")).toBeNull();
  });

});
