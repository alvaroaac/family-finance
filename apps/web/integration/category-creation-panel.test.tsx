// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CategoryCreationPanel } from "../app/(app)/categories/category-creation-panel";
import { ToastProvider } from "../components/ui";

const mocks = vi.hoisted(() => ({
  createCategory: vi.fn(),
  createSubcategory: vi.fn(),
}));

vi.mock("../app/(app)/categories/actions", () => ({
  createCategoryAction: mocks.createCategory,
  createSubcategoryAction: mocks.createSubcategory,
}));

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(async () => {
  vi.clearAllMocks();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () =>
    root.render(
      <ToastProvider>
        <CategoryCreationPanel categories={[]} />
      </ToastProvider>,
    ),
  );
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

const nameInput = () =>
  container.querySelector<HTMLInputElement>("input[aria-label='Nome da categoria']")!;

async function submitCategory(name: string): Promise<void> {
  const input = nameInput();
  input.value = name;
  await act(async () => {
    input.form!.requestSubmit();
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

const toast = () => document.querySelector<HTMLElement>(".ff-toast");

describe("CategoryCreationPanel", () => {
  it("toasts success and resets the form when the category was created", async () => {
    mocks.createCategory.mockResolvedValue({
      ok: true,
      id: "cat-1",
      message: "Categoria “Pets” criada.",
      created: true,
    });
    await submitCategory("Pets");

    expect(toast()?.classList).toContain("ff-toast--positive");
    expect(toast()?.textContent).toContain("Categoria “Pets” criada.");
    expect(nameInput().value).toBe("");
  });

  it("shows the already-exists message without success tone and keeps the form", async () => {
    mocks.createCategory.mockResolvedValue({
      ok: true,
      id: "cat-food",
      message: "A categoria “Alimentação” já existe.",
      created: false,
    });
    await submitCategory("alimentacao");

    expect(toast()?.classList).toContain("ff-toast--warn");
    expect(toast()?.textContent).toContain("A categoria “Alimentação” já existe.");
    expect(nameInput().value).toBe("alimentacao");
  });
});
