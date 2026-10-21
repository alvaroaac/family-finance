// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { InstallBanner } from "./install-banner";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const IPHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const ANDROID_UA =
  "Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36";

let root: Root;
let container: HTMLDivElement;

function setPlatform({
  userAgent,
  standalone = false,
}: {
  userAgent: string;
  standalone?: boolean;
}): void {
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue(userAgent);
  window.matchMedia = vi.fn((query: string) => ({
    matches: standalone && query === "(display-mode: standalone)",
  })) as unknown as typeof window.matchMedia;
}

async function render(): Promise<void> {
  await act(async () => root.render(<InstallBanner />));
}

function installPromptEvent(): Event & { prompt: ReturnType<typeof vi.fn> } {
  const event = Object.assign(
    new Event("beforeinstallprompt", { cancelable: true }),
    {
      prompt: vi.fn(async () => undefined),
    },
  );
  return event;
}

const banner = () => container.querySelector(".ff-install-banner");

beforeEach(() => {
  localStorage.clear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

describe("InstallBanner", () => {
  it("tells iPhone users how to add the app to the home screen", async () => {
    setPlatform({ userAgent: IPHONE_UA });
    await render();
    expect(banner()?.textContent).toContain("Adicionar à Tela de Início");
  });

  it("stays hidden inside the installed app", async () => {
    setPlatform({ userAgent: IPHONE_UA, standalone: true });
    await render();
    expect(banner()).toBeNull();
  });

  it("offers the native install prompt once the browser allows it", async () => {
    setPlatform({ userAgent: ANDROID_UA });
    await render();
    expect(banner()).toBeNull();

    const event = installPromptEvent();
    await act(async () => window.dispatchEvent(event));
    expect(event.defaultPrevented).toBe(true);
    const install = [...container.querySelectorAll("button")].find(
      (button) => button.textContent === "Instalar",
    );
    expect(install).toBeDefined();

    await act(async () => install?.click());
    expect(event.prompt).toHaveBeenCalledOnce();
    expect(banner()).toBeNull();
  });

  it("remembers a dismissal", async () => {
    setPlatform({ userAgent: IPHONE_UA });
    await render();
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('[aria-label="Dispensar"]')
        ?.click(),
    );
    expect(banner()).toBeNull();

    await act(async () => root.unmount());
    root = createRoot(container);
    await render();
    expect(banner()).toBeNull();
  });

  it("shows nothing where the browser cannot install the app", async () => {
    setPlatform({
      userAgent: "Mozilla/5.0 (X11; Linux x86_64) Gecko/20100101 Firefox/140.0",
    });
    await render();
    expect(banner()).toBeNull();
  });
});
