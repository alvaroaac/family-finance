import { expect, test } from "@playwright/test";

/**
 * Galaxy Z Fold 6 widths: the slim cover screen (344–369 CSS px depending on
 * display zoom) and the unfolded inner screen (707 at its largest zoom, 884 at
 * the default). No page may scroll sideways and no content may be clipped by
 * the main column.
 */
const VIEWPORTS = [
  { name: "cover small", width: 344, height: 882 },
  { name: "cover", width: 369, height: 905 },
  { name: "inner large zoom", width: 707, height: 823 },
  { name: "inner", width: 884, height: 1029 },
];

const ROUTES = [
  "/resumo",
  "/dashboard",
  "/transactions",
  "/imports",
  "/categories",
  "/accounts",
  "/cards",
  "/obligations",
  "/investments",
  "/settings",
];

for (const { name, width, height } of VIEWPORTS) {
  test.describe(`Fold 6 ${name} screen`, () => {
    test.use({ viewport: { width, height }, isMobile: true, hasTouch: true });

    test("no page scrolls sideways", async ({ page }) => {
      for (const route of ROUTES) {
        await page.goto(route);
        const overflow = await page.evaluate(
          () =>
            document.documentElement.scrollWidth -
            document.documentElement.clientWidth,
        );
        expect(overflow, `${route} at ${width}px`).toBe(0);
        const clipped = await page.evaluate(() => {
          const right = document
            .querySelector(".ff-main")!
            .getBoundingClientRect().right;
          return [...document.querySelectorAll(".ff-main *")]
            .filter((element) => {
              const box = element.getBoundingClientRect();
              return box.width > 0 && box.right > right + 1;
            })
            .map((element) => element.className.toString());
        });
        expect(clipped, `${route} at ${width}px`).toEqual([]);
      }
    });
  });
}

test.describe("Fold 6 inner screen navigation", () => {
  test.use({
    viewport: { width: 884, height: 1029 },
    isMobile: true,
    hasTouch: true,
  });

  test("shows the icon rail instead of the bottom nav", async ({ page }) => {
    await page.goto("/transactions");
    const rail = page.locator(".ff-sidebar");
    await expect(rail).toBeVisible();
    expect((await rail.boundingBox())!.width).toBeLessThanOrEqual(84);
    await expect(page.locator(".ff-bottombar")).toBeHidden();
    await expect(page.getByRole("button", { name: "sair" })).toBeVisible();

    await rail.getByRole("button", { name: "Novo lançamento" }).tap();
    await expect(
      page.getByRole("textbox", { name: "Descreva o lançamento" }),
    ).toBeVisible();
  });
});
