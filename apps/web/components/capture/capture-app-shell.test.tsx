// @vitest-environment jsdom

import { act, useContext, useEffect, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CaptureAppShell } from "./capture-app-shell";
import { CaptureUserContext } from "./capture-sheet";

const nav = vi.hoisted(() => ({ pathname: "/resumo" }));
const sheetMounts = vi.hoisted(() => ({ count: 0 }));

vi.mock("next/navigation", () => ({
  usePathname: () => nav.pathname,
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("next/link", () => ({
  default: (props: ComponentProps<"a">) => <a {...props} />,
}));
vi.mock("./capture-sheet", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./capture-sheet")>();
  return {
    ...actual,
    CaptureSheet: ({ open }: { open: boolean }) => {
      const userId = useContext(actual.CaptureUserContext);
      useEffect(() => {
        sheetMounts.count++;
      }, []);
      return open ? <div className="ff-capture" data-user={userId} /> : null;
    },
  };
});

function PageUser() {
  return <p className="page-user">{useContext(CaptureUserContext)}</p>;
}

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;

async function render(pathname: string, userId = "user-1"): Promise<void> {
  nav.pathname = pathname;
  await act(async () =>
    root.render(
      <CaptureAppShell
        items={[
          { href: "/resumo", label: "Resumo", icon: "home" },
          { href: "/transactions", label: "Transações", icon: "transfer" },
          { href: "/cards", label: "Cartões", icon: "card" },
        ]}
        householdName="Casa Azul"
        user={{ initial: "M", name: "Member", email: "member@example.test" }}
        userId={userId}
      >
        <PageUser />
      </CaptureAppShell>,
    ),
  );
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

const entries = () =>
  container.querySelectorAll(".ff-sidebar__new, .ff-bottomnav__new");

describe("CaptureAppShell", () => {
  it("opens the capture sheet from the Novo lançamento entries", async () => {
    await render("/resumo");
    expect(entries()).toHaveLength(2);

    await act(async () => {
      container
        .querySelector(".ff-bottomnav__new")
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(container.querySelector(".ff-capture")).not.toBeNull();
  });

  it("gives the sheet and the page the signed-in user's id for the draft key", async () => {
    await render("/resumo");
    expect(container.querySelector(".page-user")?.textContent).toBe("user-1");

    await act(async () => {
      container
        .querySelector(".ff-bottomnav__new")
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(container.querySelector(".ff-capture")?.getAttribute("data-user")).toBe(
      "user-1",
    );
  });

  it("remounts the capture sheet when the signed-in user changes", async () => {
    sheetMounts.count = 0;
    await render("/resumo");
    await render("/resumo", "user-1");
    expect(sheetMounts.count).toBe(1);

    await render("/resumo", "user-2");
    expect(sheetMounts.count).toBe(2);
    expect(container.querySelector(".page-user")?.textContent).toBe("user-2");
  });

  it("hides the Novo lançamento entries on /capture", async () => {
    await render("/capture");
    expect(entries()).toHaveLength(0);
  });
});
