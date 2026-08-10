/**
 * Browser-level coverage for the /transactions "+ Lançamento" parcelado flow.
 *
 * This is intentionally opt-in: it writes to the configured Supabase project.
 * Set E2E_STORAGE_STATE to an authorized session and E2E_MUTATE_REAL_DATA=1
 * when running against a disposable/local e2e database.
 */

import { expect, test } from "@playwright/test";

const canMutate =
  Boolean(process.env.E2E_STORAGE_STATE) &&
  process.env.E2E_MUTATE_REAL_DATA === "1";

function currentHouseholdMonth(): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(new Date());
  const year = parts.find((part) => part.type === "year")?.value ?? "2026";
  const month = parts.find((part) => part.type === "month")?.value ?? "08";
  return `${year}-${month}`;
}

function firstDayOfCurrentHouseholdMonth(): string {
  return `${currentHouseholdMonth()}-01`;
}

function centsFromPtBrCurrency(value: string): number {
  const normalized = value
    .replace(/\s/g, "")
    .replace(/[^\d,-]/g, "")
    .replace(/\./g, "")
    .replace(",", ".");
  return Math.round(Number.parseFloat(normalized) * 100);
}

test.describe("manual transaction parcelado flow", () => {
  test.skip(
    !canMutate,
    "Set E2E_STORAGE_STATE and E2E_MUTATE_REAL_DATA=1 to run the mutating authenticated flow.",
  );

  test("creates a parcelado card purchase from dashboard entry and reflects it in dashboard card pressure", async ({
    page,
    request,
  }) => {
    const marker = `E2E Parcelado ${Date.now()}`;
    const pressureCard = page
      .locator(".ff-stat")
      .filter({ hasText: /Cartões em/i });
    const pressureValue = pressureCard.locator(".ff-stat__value");

    const dashboardResponse = await request.get("/dashboard");
    expect(dashboardResponse.ok()).toBe(true);

    await page.goto("/dashboard");
    await expect(pressureCard).toBeVisible();
    const before = centsFromPtBrCurrency(await pressureValue.innerText());

    await page.getByRole("link", { name: /\+ Lançamento/i }).click();
    await expect(page).toHaveURL(/\/transactions\?novo=1/);
    await expect(page.locator("dialog[open]")).toBeVisible();

    await page.locator('input[name="amount"]').fill("120,00");
    await page.locator('input[name="description"]').fill(marker);
    await page.locator('input[name="occurredOn"]').fill(firstDayOfCurrentHouseholdMonth());

    const paymentSelect = page.locator('select[name="payment"]');
    const cardValue = await paymentSelect
      .locator("option")
      .evaluateAll((options) => {
        const card = options.find((option) =>
          option.getAttribute("value")?.startsWith("card:"),
        );
        return card?.getAttribute("value") ?? "";
      });
    expect(cardValue).not.toBe("");
    await paymentSelect.selectOption(cardValue);

    await page.locator('select[name="purchaseMode"]').selectOption("parcelado");
    await page.locator('input[name="installmentCount"]').fill("3");
    await page.getByRole("button", { name: /Salvar lançamento/i }).click();
    await expect(page.getByText(/Compra parcelada salva/i)).toBeVisible();

    await page.goto("/dashboard");
    await expect(pressureCard).toBeVisible();
    await expect.poll(
      async () => centsFromPtBrCurrency(await pressureValue.innerText()),
      { message: "dashboard card pressure includes the first installment" },
    ).toBe(before + 4000);
  });
});
