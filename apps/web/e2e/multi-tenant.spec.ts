import { randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { storageStateFor } from "../../../e2e/lib/session";
import {
  adminClient,
  members,
  provisionMultiTenantFixtures,
  testPassword,
} from "../../../e2e/lib/multi-tenant-fixtures";

const forbidden = /Alvaro|Álvaro|Karol|alvaroekarol/i;

async function memberPage(browser: Browser, email: string, origin: string) {
  const state = await storageStateFor(email, testPassword, origin);
  const context = await browser.newContext({ storageState: state });
  return { context, page: await context.newPage() };
}

async function ensureAccount(householdId: string) {
  const admin = adminClient();
  const { data, error } = await admin
    .from("accounts")
    .select("id")
    .eq("household_id", householdId)
    .limit(1);
  if (error) throw error;
  if (data.length > 0) return;
  const inserted = await admin.from("accounts").insert({
    household_id: householdId,
    kind: "checking",
    name: "Conta e2e",
  });
  if (inserted.error) throw inserted.error;
}

async function createFromPages(page: Page, origin: string, prefix: string) {
  const transaction = `${prefix} compra`;
  const category = `${prefix} categoria`;
  const card = `${prefix} cartão`;
  const bucket = `${prefix} objetivo`;
  const amount = prefix.startsWith("Azul") ? "17,43" : "29,57";

  await page.goto(`${origin}/transactions`);
  await page.getByRole("button", { name: "+ Lançamento" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.locator('input[name="amount"]').fill(amount);
  await dialog.locator('input[name="description"]').fill(transaction);
  await dialog.getByRole("button", { name: /salvar/i }).click();
  await expect(dialog).toBeHidden();
  await page.reload();
  await expect(page.getByText(transaction).first()).toBeVisible();

  await page.goto(`${origin}/categories`);
  await page.getByRole("textbox", { name: "Nome da categoria" }).fill(category);
  await page.getByRole("button", { name: "Criar categoria" }).click();
  await expect(
    page.getByRole("textbox", { name: "Nome da categoria" }),
  ).toBeEmpty();
  await page.reload();
  await expect(
    page.locator(".ff-catrow__name").filter({ hasText: category }),
  ).toBeVisible();

  await page.goto(`${origin}/cards`);
  await page
    .getByRole("textbox", { name: "Nome do cartão", exact: true })
    .fill(card);
  const cardSaved = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/cards",
  );
  await page.getByRole("button", { name: "Adicionar cartão" }).click();
  await cardSaved;
  await page.reload();
  await expect(
    page.locator(".ff-name--lg").filter({ hasText: card }),
  ).toBeVisible();

  await page.goto(`${origin}/investments`);
  await page.getByRole("textbox", { name: "Nome do objetivo" }).fill(bucket);
  await page.getByRole("button", { name: "Criar caixinha" }).click();
  await expect(page.getByRole("status")).toContainText("Caixinha criada.");
  await page.reload();
  await expect(page.getByText(bucket).first()).toBeVisible();
  return { transaction, category, card, bucket, amount };
}

test("two households create and see only their own records; a second member shares Casa Azul", async ({
  browser,
  baseURL,
}) => {
  test.setTimeout(120_000);
  const { azul, verde, ids } = await provisionMultiTenantFixtures();
  await ensureAccount(azul);
  await ensureAccount(verde);
  const origin = baseURL!;
  const ana = await memberPage(browser, members.ana.email, origin);
  const carla = await memberPage(browser, members.carla.email, origin);
  const bruno = await memberPage(browser, members.bruno.email, origin);
  const suffix = randomUUID().slice(0, 8);
  try {
    await bruno.page.goto(`${origin}/settings`);
    await expect(
      bruno.page.getByRole("button", { name: "Vincular Telegram" }),
    ).toHaveCount(1);
    await expect(bruno.page.locator('input[name="telegram"]')).toHaveCount(0);
    await bruno.page.getByRole("button", { name: "Vincular Telegram" }).click();
    await expect(bruno.page.locator("code")).toContainText(
      /\/vincular [A-HJ-NP-Z2-9]{8}/,
    );

    const blue = await createFromPages(ana.page, origin, `Azul ${suffix}`);
    const green = await createFromPages(carla.page, origin, `Verde ${suffix}`);
    for (const [page, own, other] of [
      [ana.page, blue, green],
      [bruno.page, blue, green],
      [carla.page, green, blue],
    ] as const) {
      for (const [route, key, selector] of [
        ["transactions", "transaction", ".ff-txrow__desc"],
        ["categories", "category", ".ff-catrow__name"],
        ["cards", "card", ".ff-name--lg"],
        ["investments", "bucket", "main"],
      ] as const) {
        await page.goto(`${origin}/${route}`);
        const ownRows =
          route === "transactions"
            ? page.getByRole("button", { name: `${own.transaction} Pendente` })
            : page.locator(selector).filter({ hasText: own[key] });
        const otherRows =
          route === "transactions"
            ? page.getByRole("button", {
                name: `${other.transaction} Pendente`,
              })
            : page.locator(selector).filter({ hasText: other[key] });
        await expect(ownRows.first()).toBeVisible();
        await expect(otherRows).toHaveCount(0);
      }
      await page.goto(`${origin}/dashboard`);
      await expect(page.locator("body")).toContainText(own.transaction);
      await expect(page.locator("body")).not.toContainText(other.transaction);
      await expect(page.locator("body")).toContainText(`R$ ${own.amount}`);
      await expect(page.locator("body")).not.toContainText(
        `R$ ${other.amount}`,
      );
    }

    const { data: batch, error } = await adminClient()
      .from("import_batches")
      .insert({
        household_id: azul,
        created_by_user_id: ids.ana,
        source: "nubank_csv",
        status: "pending",
        notes: `private-${suffix}`,
      })
      .select("id")
      .single();
    expect(error).toBeNull();
    const ownResponse = await ana.page.goto(`${origin}/imports/${batch!.id}`);
    expect(ownResponse?.status()).toBe(200);
    await expect(
      ana.page.getByRole("heading", { name: "Detalhes do lote" }),
    ).toBeVisible();
    await carla.page.goto(`${origin}/imports/${batch!.id}`);
    await expect(
      carla.page.getByRole("heading", { name: "404" }),
    ).toBeVisible();
    await expect(
      carla.page.getByRole("heading", { name: "Detalhes do lote" }),
    ).toHaveCount(0);
    await expect(carla.page.getByText(`private-${suffix}`)).toHaveCount(0);
  } finally {
    await Promise.all([
      ana.context.close(),
      bruno.context.close(),
      carla.context.close(),
    ]);
  }
});

test("household branding and the public and denied screens", async ({
  browser,
  baseURL,
}) => {
  const origin = baseURL!;
  const ana = await memberPage(browser, members.ana.email, origin);
  const carla = await memberPage(browser, members.carla.email, origin);
  const dario = await memberPage(browser, members.dario.email, origin);
  try {
    await ana.page.goto(`${origin}/dashboard`);
    await expect(ana.page.locator(".ff-sidebar__brand-title")).toHaveText(
      "Casa Azul",
    );
    await expect(ana.page.locator("html")).toHaveAttribute(
      "style",
      /--ff-accent:\s*#2f6fed/,
    );
    await expect(ana.page.locator(".ff-themepicker")).toHaveCount(0);
    await carla.page.goto(`${origin}/dashboard`);
    await expect(carla.page.locator(".ff-sidebar__brand-title")).toHaveText(
      "Casa Verde",
    );
    await expect(carla.page.locator("html")).not.toHaveAttribute(
      "style",
      /--ff-accent:/,
    );
    await dario.page.goto(`${origin}/dashboard`);
    await expect(dario.page).toHaveURL(/\/login\?denied=1/);
    await expect(dario.page.locator(".ff-alert--negative")).toContainText(
      "Acesso negado",
    );
    await expect(dario.page.locator("body")).not.toContainText("O mês inteiro");
    const visitor = await browser.newPage();
    try {
      await visitor.goto(`${origin}/login`);
      await expect(visitor.locator("body")).not.toContainText(
        /Casa Azul|Casa Verde/,
      );
      await expect(visitor.locator("body")).not.toContainText(forbidden);
    } finally {
      await visitor.close();
    }
  } finally {
    await Promise.all([
      ana.context.close(),
      carla.context.close(),
      dario.context.close(),
    ]);
  }
});

test("signing out clears household branding", async ({ browser, baseURL }) => {
  const origin = baseURL!;
  const ana = await memberPage(browser, members.ana.email, origin);
  try {
    await ana.page.goto(`${origin}/dashboard`);
    await expect(ana.page.locator("html")).toHaveAttribute(
      "style",
      /--ff-accent:/,
    );
    await expect(ana.page.locator("body")).toContainText("Casa Azul");
    await ana.page.getByRole("button", { name: "sair" }).click();
    await expect(ana.page).toHaveURL(/\/login/);
    await expect(ana.page.locator("html")).not.toHaveAttribute(
      "style",
      /--ff-accent:/,
    );
    await expect(ana.page.locator("body")).not.toContainText("Casa Azul");
  } finally {
    await ana.context.close();
  }
});

test("OAuth starts on the allowed request host and falls back for an unknown Host", async ({
  browser,
}) => {
  let actionId: string | undefined;
  let actionBody: string | null = null;
  let actionContentType: string | undefined;
  for (const origin of ["http://localhost:3100", "http://127.0.0.1:3100"]) {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      await page.goto(`${origin}/login`);
      const authorize = page.waitForRequest((candidate) =>
        candidate.url().includes("/auth/v1/authorize"),
      );
      const action = page.waitForRequest(
        (candidate) =>
          candidate.method() === "POST" &&
          new URL(candidate.url()).pathname === "/login",
      );
      await page.getByRole("button", { name: "Entrar com Google" }).click();
      const submitted = await action;
      actionId = submitted.headers()["next-action"];
      actionBody = submitted.postData();
      actionContentType = submitted.headers()["content-type"];
      const url = new URL((await authorize).url());
      const redirect = new URL(url.searchParams.get("redirect_to")!);
      expect(redirect.origin).toBe(origin);
    } finally {
      await context.close();
    }
  }
  expect(actionId).toBeTruthy();
  const redirect = await new Promise<string | undefined>((resolve, reject) => {
    const request = httpRequest(
      "http://127.0.0.1:3100/login",
      {
        method: "POST",
        headers: {
          Host: "unlisted.example.test",
          Accept: "text/x-component",
          "Content-Type": actionContentType!,
          "Next-Action": actionId!,
        },
      },
      (response) => {
        response.resume();
        resolve(
          (response.headers["x-action-redirect"] as string | undefined) ??
            response.headers.location,
        );
      },
    );
    request.on("error", reject);
    request.end(actionBody);
  });
  expect(redirect).toBeTruthy();
  const authorize = new URL(redirect!.split(";")[0]!);
  expect(new URL(authorize.searchParams.get("redirect_to")!).origin).toBe(
    "http://localhost:3100",
  );
});

test("a localhost session is absent on the IP hostname", async ({
  browser,
}) => {
  const state = await storageStateFor(
    members.ana.email,
    testPassword,
    "http://localhost:3100",
  );
  const context = await browser.newContext({ storageState: state });
  try {
    const page = await context.newPage();
    await page.goto("http://localhost:3100/dashboard");
    await expect(page).toHaveURL(/\/dashboard$/);
    await page.goto("http://127.0.0.1:3100/dashboard");
    await expect(page).toHaveURL(/\/login/);
  } finally {
    await context.close();
  }
});
