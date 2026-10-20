// @vitest-environment jsdom
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppShell } from "../components/ui/app-shell";

vi.mock("next/link", () => ({
  default: (props: ComponentProps<"a">) => <a {...props} />,
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/resumo",
  useSearchParams: () => new URLSearchParams(),
}));
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const ITEMS: ComponentProps<typeof AppShell>["items"] = [
  { href: "/resumo", label: "Resumo", icon: "home" },
  { href: "/dashboard", label: "Dashboard", icon: "grid" },
  { href: "/transactions", label: "Transações", icon: "transfer" },
  { href: "/cards", label: "Cartões", icon: "card" },
  { href: "/categories", label: "Categorias", icon: "tag" },
];

let root: Root;
let container: HTMLDivElement;
const onNewTransaction = vi.fn();

beforeEach(async () => {
  onNewTransaction.mockClear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root.render(
      <AppShell
        items={ITEMS}
        householdName="Casa Azul"
        user={{ initial: "M", name: "Member", email: "member@example.test" }}
        onNewTransaction={onNewTransaction}
      >
        <p>Page content</p>
      </AppShell>,
    ),
  );
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

const click = (element: Element) =>
  act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });

describe("capture entry points", () => {
  it("puts a round + between Transações and Cartões on the mobile bar", async () => {
    const bar = container.querySelector(".ff-bottomnav")!;
    const entries = [...bar.children].map(
      (el) => el.getAttribute("aria-label") ?? el.textContent,
    );
    expect(entries).toEqual([
      "Resumo",
      "Transações",
      "Novo lançamento",
      "Cartões",
      "Mais",
    ]);
    const hrefs = [...bar.querySelectorAll("a")].map((a) =>
      a.getAttribute("href"),
    );
    expect(hrefs).toEqual(["/resumo", "/transactions", "/cards"]);

    await click(bar.querySelector("[aria-label='Novo lançamento']")!);
    expect(onNewTransaction).toHaveBeenCalledTimes(1);
  });

  it("appends the + before Mais when there is no Cartões item", async () => {
    await act(async () =>
      root.render(
        <AppShell
          items={ITEMS.filter((item) => item.href !== "/cards")}
          householdName="Casa Azul"
          user={{ initial: "M", name: "Member", email: "member@example.test" }}
          onNewTransaction={onNewTransaction}
        >
          <p>Page content</p>
        </AppShell>,
      ),
    );

    const bar = container.querySelector(".ff-bottomnav")!;
    const entries = [...bar.children].map(
      (el) => el.getAttribute("aria-label") ?? el.textContent,
    );
    expect(entries).toEqual(["Resumo", "Transações", "Novo lançamento", "Mais"]);
  });

  it("keeps every other link in the Mais sheet", () => {
    const more = [...container.querySelectorAll("#ff-morenav a")].map((a) =>
      a.getAttribute("href"),
    );
    expect(more).toEqual(["/dashboard", "/categories"]);
  });

  it("puts an accent Novo lançamento button above the sidebar nav", async () => {
    const sidebar = container.querySelector(".ff-sidebar")!;
    const entry = sidebar.querySelector(".ff-sidebar__new")!;
    expect(entry.textContent).toBe("Novo lançamento");
    expect(entry.nextElementSibling?.classList).toContain("ff-sidebar__nav");

    await click(entry);
    expect(onNewTransaction).toHaveBeenCalledTimes(1);
  });
});
