/**
 * Card-bill payments and closing, end to end in the browser against the
 * disposable local stack (`pnpm test:e2e:local`; see local-auth.setup.ts).
 * Each step saves a screenshot into the feature's e2e-evidence folder.
 *
 * The seeded card closes on day 28 and holds one purchase dated today, so the
 * open fatura is this month (next month after the 28th).
 */

import { join } from "node:path";

import { expect, test, type Locator, type Page } from "@playwright/test";

import {
  E2E_ACCOUNT,
  E2E_CARD,
  addMonths,
  monthLabel,
  todaySp,
} from "./local-env";

const EVIDENCE = join(
  process.cwd(),
  "..",
  "..",
  "thoughts",
  "features",
  "card-bill-payments",
  "e2e-evidence",
  "screenshots",
);

const today = todaySp();
const thisMonth = today.slice(0, 7);
const openMonth =
  Number(today.slice(8, 10)) > 28 ? addMonths(thisMonth, 1) : thisMonth;
const nextMonth = addMonths(openMonth, 1);
const futureMonth = addMonths(openMonth, 3);

async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: join(EVIDENCE, `${name}.png`), fullPage: true });
}

function fatura(page: Page, month: string): Locator {
  return page
    .locator(".ff-fatura")
    .filter({ has: page.getByRole("heading", { name: `Fatura ${monthLabel(month)}` }) });
}

function figure(block: Locator, label: "Total" | "Pago" | "Falta"): Locator {
  return block
    .locator(".ff-fatura__figure")
    .filter({ has: block.page().locator("dt", { hasText: new RegExp(`^${label}$`) }) })
    .locator("dd");
}

function payments(block: Locator): Locator {
  return block.getByRole("button", { name: /^Desfazer pagamento/ });
}

function field(scope: Locator, label: string): Locator {
  return scope
    .locator(".ff-field")
    .filter({ has: scope.page().locator("label", { hasText: new RegExp(`^${label}$`) }) })
    .locator("input, select");
}

async function buyOnCard(
  page: Page,
  description: string,
  amount: string,
  installments?: number,
): Promise<Locator> {
  const form = page.locator("section, div").filter({
    has: page.getByRole("heading", { name: "Lançar compra no cartão" }),
  }).last();
  await field(form, "Cartão").selectOption({ label: E2E_CARD });
  await field(form, "Descrição").fill(description);
  await field(form, "Valor total \\(R\\$\\)").fill(amount);
  await field(form, "Data da compra").fill(today);
  if (installments !== undefined) {
    await field(form, "Forma").selectOption("parcelado");
    await field(form, "Nº de parcelas").fill(String(installments));
  }
  return form;
}

async function pay(block: Locator, amount: string): Promise<void> {
  const open = block.getByRole("button", { name: "Pagar fatura" });
  if (await open.isVisible()) await open.click();
  await block.getByLabel("Valor", { exact: true }).fill(amount);
  await block.getByLabel("Conta", { exact: true }).selectOption({ label: E2E_ACCOUNT });
}

async function expectToast(page: Page, message: string): Promise<void> {
  await expect(page.locator(".ff-toast").filter({ hasText: message }).last()).toBeVisible();
}

test.describe.configure({ mode: "serial" });

test("pay, close and correct faturas from /cards", async ({ page }) => {
  await test.step("01 seeded purchase shows in the open fatura", async () => {
    await page.goto("/cards");
    const block = fatura(page, openMonth);
    await expect(block).toBeVisible();
    await expect(figure(block, "Total")).toHaveText("R$ 300,00");
    await expect(block.getByText("aberta", { exact: true })).toBeVisible();
    await shot(page, "01-open-fatura");
  });

  await test.step("02 à vista purchase adds to the open fatura", async () => {
    const form = await buyOnCard(page, "Farmácia E2E", "100,00");
    await form.getByRole("button", { name: "Salvar compra" }).click();
    await expectToast(page, "Compra salva.");
    await page.reload();
    await expect(figure(fatura(page, openMonth), "Total")).toHaveText("R$ 400,00");
    await shot(page, "02-purchase-added");
  });

  await test.step("03 Fechar fatura with a corrected total (C6, C18)", async () => {
    const block = fatura(page, openMonth);
    await block.getByRole("button", { name: "Fechar fatura" }).click();
    await block.getByLabel("Total da fatura").fill("380,00");
    await block.getByRole("button", { name: "Confirmar fechamento" }).click();
    await expectToast(page, "Fatura fechada.");
    await expect(figure(block, "Total")).toHaveText("R$ 380,00");
    await expect(block.getByText("fechada · a pagar R$ 380,00")).toBeVisible();
    await shot(page, "03-closed-corrected-total");
  });

  await test.step("04 purchase after close lands in the next fatura (C25, P1, P9)", async () => {
    const form = await buyOnCard(page, "Padaria E2E", "50,00");
    await form.getByRole("button", { name: "Salvar compra" }).click();
    await expectToast(page, "Compra salva.");
    await page.reload();
    const pending = fatura(page, openMonth);
    const next = fatura(page, nextMonth);
    await expect(figure(pending, "Total")).toHaveText("R$ 380,00");
    await expect(figure(next, "Total")).toHaveText("R$ 50,00");
    // Pending (closed) fatura is listed above the open one.
    const headings = await page.locator(".ff-fatura__title").allTextContents();
    expect(headings.indexOf(`Fatura ${monthLabel(openMonth)}`)).toBeLessThan(
      headings.indexOf(`Fatura ${monthLabel(nextMonth)}`),
    );
    await shot(page, "04-pending-and-open");
  });

  await test.step("05 partial payment (E2, C26)", async () => {
    const block = fatura(page, openMonth);
    await expect(block.getByLabel("Valor", { exact: true })).toHaveValue("380,00");
    await pay(block, "100,00");
    await block.getByRole("button", { name: "Registrar pagamento" }).click();
    await expectToast(page, "Pagamento registrado.");
    await expect(figure(block, "Pago")).toHaveText("R$ 100,00");
    await expect(figure(block, "Falta")).toHaveText("R$ 280,00");
    await expect(block.getByText("fechada · parcial, falta R$ 280,00")).toBeVisible();
    await shot(page, "05-partial-payment");
  });

  await test.step("06 double-click submit records one payment (E11)", async () => {
    const block = fatura(page, openMonth);
    await expect(payments(block)).toHaveCount(1);
    await pay(block, "30,00");
    await block.getByRole("button", { name: "Registrar pagamento" }).dblclick();
    // Step 05's toast may still be up; wait for the saved state instead.
    await expect(figure(block, "Pago")).toHaveText("R$ 130,00");
    await page.reload();
    await expect(payments(fatura(page, openMonth))).toHaveCount(2);
    await expect(figure(fatura(page, openMonth), "Falta")).toHaveText("R$ 250,00");
    await shot(page, "06-double-submit-single-payment");
  });

  await test.step("07 paying the rest collapses to the open fatura (E3, P3)", async () => {
    const block = fatura(page, openMonth);
    await pay(block, "250,00");
    await block.getByRole("button", { name: "Registrar pagamento" }).click();
    await expect(fatura(page, openMonth)).toHaveCount(0);
    await page.reload();
    await expect(fatura(page, openMonth)).toHaveCount(0);
    await expect(fatura(page, nextMonth)).toBeVisible();
    await shot(page, "07-paid-collapses-to-open");
    await page.goto("/resumo");
    await expect(page.getByText(`Fatura ${openMonth.slice(5, 7)} · fechada`)).toHaveCount(0);
    await shot(page, "07b-resumo-after-paid");
  });

  await test.step("08 Desfazer removes a payment (E13)", async () => {
    await page.goto(`/cards?fatura=${openMonth}`);
    const block = fatura(page, openMonth);
    await expect(block.getByText("paga ✅")).toBeVisible();
    await shot(page, "08a-paid-month-view");
    await block.getByRole("button", { name: /^Desfazer pagamento .* R\$ 250,00$/ }).click();
    await expectToast(page, "Pagamento desfeito.");
    await expect(payments(block)).toHaveCount(2);
    await expect(figure(block, "Falta")).toHaveText("R$ 250,00");
    await shot(page, "08b-payment-undone");
  });

  await test.step("09 invalid amount shows an error and saves nothing (E7)", async () => {
    await page.goto("/cards");
    const block = fatura(page, openMonth);
    await pay(block, "0,00");
    await block.getByRole("button", { name: "Registrar pagamento" }).click();
    await expect(block.getByRole("alert")).toHaveText("Informe um valor maior que zero.");
    await expect(payments(block)).toHaveCount(2);
    await shot(page, "09-invalid-amount");
  });

  await test.step("10 ?fatura= future month accepts a payment (E5)", async () => {
    await page.goto(`/cards?fatura=${futureMonth}`);
    const block = fatura(page, futureMonth);
    await expect(block).toBeVisible();
    await pay(block, "20,00");
    await block.getByRole("button", { name: "Registrar pagamento" }).click();
    await expectToast(page, "Pagamento registrado.");
    await expect(figure(block, "Pago")).toHaveText("R$ 20,00");
    await shot(page, "10-future-month-payment");
  });

  await test.step("11 parcelado preview shifts past the closed fatura (C15)", async () => {
    await page.goto("/cards");
    const form = await buyOnCard(page, "Geladeira E2E", "300,00", 3);
    await form.getByRole("button", { name: "Ver parcelas" }).click();
    await expect(
      form.getByText(
        `Fatura de ${monthLabel(openMonth)} já fechada — começa em ${monthLabel(nextMonth)}.`,
      ),
    ).toBeVisible();
    await shot(page, "11-parcelado-shift-note");
  });

  await test.step("12 /resumo shows the pending + open pair (P1)", async () => {
    await page.goto("/resumo");
    const card = page.locator(".ff-icard").filter({ hasText: E2E_CARD });
    await expect(card.getByText(`Fatura ${openMonth.slice(5, 7)} · fechada`)).toBeVisible();
    await expect(card.getByText(`Próxima ${nextMonth.slice(5, 7)} · aberta`)).toBeVisible();
    await shot(page, "12-resumo-pair");
  });
});
