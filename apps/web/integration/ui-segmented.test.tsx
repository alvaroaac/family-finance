// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { Segmented } from "../components/ui";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const OPTIONS = [
  { value: "sem-prazo", label: "Sem prazo" },
  { value: "parcelado", label: "Parcelado" },
  { value: "ate", label: "Até uma data" },
];

async function renderSegmented(
  value: string,
  onChange: (next: string) => void,
): Promise<HTMLDivElement> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  await act(async () => {
    createRoot(container).render(
      <Segmented
        value={value}
        options={OPTIONS}
        onChange={onChange}
        ariaLabel="Tipo de prazo"
      />,
    );
  });
  return container;
}

function pressKey(container: HTMLElement, key: string): void {
  const group = container.querySelector<HTMLElement>(".ff-seg");
  if (!group) throw new Error("radiogroup não renderizado");
  act(() => {
    group.dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }),
    );
  });
}

describe("Segmented — teclado e clique", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("clicking an option reports it", async () => {
    const onChange = vi.fn();
    const container = await renderSegmented("sem-prazo", onChange);
    act(() => {
      container.querySelectorAll("button")[2]?.click();
    });
    expect(onChange).toHaveBeenCalledWith("ate");
  });

  it("ArrowRight/ArrowDown move to the next option and wrap around", async () => {
    const onChange = vi.fn();
    const container = await renderSegmented("parcelado", onChange);
    pressKey(container, "ArrowRight");
    expect(onChange).toHaveBeenLastCalledWith("ate");

    const wrapping = await renderSegmented("ate", onChange);
    pressKey(wrapping, "ArrowDown");
    expect(onChange).toHaveBeenLastCalledWith("sem-prazo");
  });

  it("ArrowLeft/ArrowUp move to the previous option and wrap around", async () => {
    const onChange = vi.fn();
    const container = await renderSegmented("parcelado", onChange);
    pressKey(container, "ArrowLeft");
    expect(onChange).toHaveBeenLastCalledWith("sem-prazo");

    const wrapping = await renderSegmented("sem-prazo", onChange);
    pressKey(wrapping, "ArrowUp");
    expect(onChange).toHaveBeenLastCalledWith("ate");
  });

  it("moves focus onto the option the arrow keys selected", async () => {
    const container = await renderSegmented("sem-prazo", () => undefined);
    pressKey(container, "ArrowRight");
    expect(document.activeElement).toBe(container.querySelectorAll("button")[1]);
  });

  it("ignores keys that are not arrows", async () => {
    const onChange = vi.fn();
    const container = await renderSegmented("sem-prazo", onChange);
    pressKey(container, "Tab");
    expect(onChange).not.toHaveBeenCalled();
  });
});
