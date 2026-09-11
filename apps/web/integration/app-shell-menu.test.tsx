// @vitest-environment jsdom
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppShell } from "../components/ui/app-shell";

vi.mock("next/link", () => ({
  default: ({ onClick, ...props }: ComponentProps<"a">) => (
    <a
      {...props}
      onClick={(event) => {
        onClick?.(event);
        event.preventDefault();
      }}
    />
  ),
}));
const route = vi.hoisted(() => ({ pathname: "/resumo", search: "" }));
vi.mock("next/navigation", () => ({
  usePathname: () => route.pathname,
  useSearchParams: () => new URLSearchParams(route.search),
}));
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
const render = () =>
  root.render(
    <AppShell
      items={[
        { href: "/resumo", label: "Resumo", icon: "home" },
        { href: "/transactions", label: "Transações", icon: "transfer" },
        { href: "/cards", label: "Cartões", icon: "card" },
        { href: "/categories", label: "Categorias", icon: "tag" },
      ]}
      brand={{ kicker: "Casa", title: "Casa" }}
      user={{ initial: "A", name: "Member", email: "member@example.test" }}
    >
      <p>Page content</p>
    </AppShell>,
  );
const toggle = () =>
  container.querySelector<HTMLButtonElement>(
    "button[aria-controls='ff-morenav']",
  )!;
const sheet = () => container.querySelector<HTMLElement>("#ff-morenav")!;
const click = async (element: HTMLElement) => act(() => element.click());
const expectOpen = (open: boolean) => {
  expect(toggle().getAttribute("aria-expanded")).toBe(String(open));
  expect(sheet().hidden).toBe(!open);
};
beforeEach(async () => {
  route.pathname = "/resumo";
  route.search = "";
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(render);
});
afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
});
describe("mobile Mais menu lifecycle", () => {
  it("toggles and closes from the backdrop", async () => {
    expectOpen(false);
    await click(toggle());
    expectOpen(true);
    await click(toggle());
    expectOpen(false);
    await click(toggle());
    await click(container.querySelector<HTMLElement>(".ff-morenav__backdrop")!);
    expectOpen(false);
  });
  it("closes with Escape", async () => {
    await click(toggle());
    await act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expectOpen(false);
  });
  it.each(["pathname", "search"] as const)(
    "closes when %s changes",
    async (field) => {
      await click(toggle());
      route[field] = field === "pathname" ? "/categories" : "month=2026-09";
      await act(render);
      expectOpen(false);
    },
  );
  it("closes when the active sheet page is clicked", async () => {
    route.pathname = "/categories";
    await act(render);
    await click(toggle());
    const link = sheet().querySelector<HTMLAnchorElement>("a")!;
    await click(link);
    expectOpen(false);
  });
});
