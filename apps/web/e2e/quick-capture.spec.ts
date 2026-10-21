import { readFile } from "node:fs/promises";

import { expect, test } from "@playwright/test";

import { testPassword } from "../../../e2e/lib/multi-tenant-fixtures";
import { storageStateFor } from "../../../e2e/lib/session";
import { localAdminClient } from "./local-db";
import { todaySp } from "./local-env";
import {
  configureQuickCaptureEnv,
  QUICK_CAPTURE_FIXTURE_PATH,
  QUICK_CAPTURE_TEXT,
  type QuickCaptureFixture,
} from "./quick-capture-fixtures";

test("quick capture fills a signed draft, saves an edited category, and isolates households", async ({
  browser,
  baseURL,
}) => {
  test.skip(
    process.env.E2E_LOCAL_SUPABASE !== "1",
    "Disposable local stack only.",
  );
  test.setTimeout(120_000);
  configureQuickCaptureEnv();
  const fixture: QuickCaptureFixture = JSON.parse(
    await readFile(QUICK_CAPTURE_FIXTURE_PATH, "utf8"),
  );
  const contextA = await browser.newContext({
    viewport: { width: 390, height: 844 },
    storageState: await storageStateFor(
      fixture.members.ana.email,
      testPassword,
      baseURL!,
    ),
  });
  const contextB = await browser.newContext({
    viewport: { width: 390, height: 844 },
    storageState: await storageStateFor(
      fixture.members.carla.email,
      testPassword,
      baseURL!,
    ),
  });
  try {
    const pageA = await contextA.newPage();
    await pageA.goto(`${baseURL}/dashboard`);
    await pageA
      .getByRole("button", { name: "Novo lançamento", exact: true })
      .click();
    const sheet = pageA.getByRole("dialog", { name: "Novo lançamento" });
    await expect(sheet).toBeVisible();
    await sheet
      .getByRole("textbox", { name: "Descreva o lançamento" })
      .fill(QUICK_CAPTURE_TEXT);
    await sheet.getByRole("button", { name: "Preencher", exact: true }).click();

    // These marks must come from the signed bot response, never a browser mock.
    for (const label of [
      "Valor",
      "Data",
      "Descrição",
      "Conta / cartão",
      "Categoria",
    ]) {
      await expect(
        sheet
          .locator("label")
          .filter({ hasText: new RegExp(`^${label}`) })
          .getByText("IA", { exact: true }),
      ).toBeVisible();
    }
    await expect(
      sheet.getByRole("textbox", { name: "Valor (R$)" }),
    ).toHaveValue("85,00");
    await expect(sheet.locator('input[name="description"]')).toHaveValue(
      fixture.description,
    );
    await expect(sheet.locator('input[name="occurredOn"]')).toHaveValue(
      todaySp(),
    );
    await expect(sheet.locator('select[name="payment"]')).toHaveValue(
      `account:${fixture.accountId}`,
    );
    const category = sheet.locator('select[name="categoryId"]');
    await expect(category).toHaveValue(fixture.suggestedCategory.id);
    await category.selectOption(fixture.editedCategory.id);
    await expect(category).toHaveValue(fixture.editedCategory.id);
    await expect(
      sheet
        .locator("label")
        .filter({ hasText: /^Categoria/ })
        .getByText("IA", { exact: true }),
    ).toHaveCount(0);
    await sheet.getByRole("button", { name: "Salvar", exact: true }).click();
    await expect(
      pageA.getByRole("status").filter({ hasText: "Lançamento salvo" }),
    ).toBeVisible();
    await expect(sheet).toBeHidden();

    await pageA.goto(`${baseURL}/transactions`);
    await expect(
      pageA.locator(".ff-txrow__desc").filter({ hasText: fixture.description }),
    ).toBeVisible();
    const pageB = await contextB.newPage();
    await pageB.goto(`${baseURL}/transactions`);
    await expect(
      pageB.getByRole("heading", { name: "Transações", exact: true }),
    ).toBeVisible();
    await expect(
      pageB.locator(".ff-txrow__desc").filter({ hasText: fixture.description }),
    ).toHaveCount(0);
    await expect(pageB.locator("body")).not.toContainText(fixture.description);

    // Prove the edited category and the draft amount reached the real save path.
    const { data, error } = await localAdminClient()
      .from("transactions")
      .select(
        "household_id,amount_cents,category_id,account_id,created_by_user_id",
      )
      .eq("household_id", fixture.azul)
      .eq("description", fixture.description);
    expect(error).toBeNull();
    expect(data).toEqual([
      {
        household_id: fixture.azul,
        amount_cents: 8500,
        category_id: fixture.editedCategory.id,
        account_id: fixture.accountId,
        created_by_user_id: fixture.ids.ana,
      },
    ]);
  } finally {
    await contextA.close();
    await contextB.close();
  }
});

test("an iPhone visitor sees the install steps until they dismiss them", async ({
  browser,
  baseURL,
}) => {
  test.skip(
    process.env.E2E_LOCAL_SUPABASE !== "1",
    "Disposable local stack only.",
  );
  configureQuickCaptureEnv();
  const fixture: QuickCaptureFixture = JSON.parse(
    await readFile(QUICK_CAPTURE_FIXTURE_PATH, "utf8"),
  );
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
    storageState: await storageStateFor(
      fixture.members.ana.email,
      testPassword,
      baseURL!,
    ),
  });
  try {
    const page = await context.newPage();
    await page.goto(`${baseURL}/dashboard`);
    const banner = page.getByRole("status").filter({
      hasText: "Adicionar à Tela de Início",
    });
    await expect(banner).toBeVisible();
    await page.screenshot({
      path: test.info().outputPath("install-banner.png"),
    });

    await banner.getByRole("button", { name: "Dispensar" }).click();
    await expect(banner).toBeHidden();
    await page.reload();
    await expect(page.getByRole("heading").first()).toBeVisible();
    await expect(banner).toBeHidden();
  } finally {
    await context.close();
  }
});
