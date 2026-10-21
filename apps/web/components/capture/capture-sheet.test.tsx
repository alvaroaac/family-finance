// @vitest-environment jsdom

import { act, useState, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CaptureDraft } from "../../app/(app)/capture/actions";
import CapturePage from "../../app/(app)/capture/page";
import { captureMessage } from "../../lib/capture-copy";
import type { TransactionFieldOptions } from "../transaction-fields";
import { ToastProvider } from "../ui";
import { CaptureSheet, CaptureUserContext } from "./capture-sheet";
import { captureDraftKey } from "./use-capture-draft";
import {
  installFakeMedia,
  uninstallFakeMedia,
  type FakeMedia,
} from "./voice-button.test-utils";

const mocks = vi.hoisted(() => ({
  suggest: vi.fn(),
  transcribe: vi.fn(),
  load: vi.fn(),
  createCategory: vi.fn(),
  createTransaction: vi.fn(),
  router: { refresh: vi.fn(), push: vi.fn() },
}));

vi.mock("../../app/(app)/capture/actions", () => ({
  suggestCaptureDraftAction: mocks.suggest,
  transcribeCaptureAudioAction: mocks.transcribe,
  loadCaptureOptionsAction: mocks.load,
}));
vi.mock("../../app/(app)/categories/actions", () => ({
  createCategoryAction: mocks.createCategory,
}));
vi.mock("../../app/(app)/transactions/actions", () => ({
  createManualTransactionAction: mocks.createTransaction,
}));
vi.mock("next/navigation", () => ({ useRouter: () => mocks.router }));
vi.mock("next/link", () => ({
  default: (props: ComponentProps<"a">) => <a {...props} />,
}));

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const ACCOUNT = "00000000-0000-4000-8000-000000000001";
const FOOD = "00000000-0000-4000-8000-000000000003";
const FUN = "00000000-0000-4000-8000-000000000004";
const USER = "00000000-0000-4000-8000-0000000000a1";

const options: TransactionFieldOptions = {
  accounts: [{ id: ACCOUNT, name: "Conta Corrente" }],
  cards: [],
  categories: [
    { id: FOOD, name: "Alimentação", kind: "expense" },
    { id: FUN, name: "Lazer", kind: "expense" },
  ],
  subcategories: [],
  responsibles: [{ value: "household", label: "Casa" }],
};
const loaded = { options, defaultResponsible: "household" };

function draft(overrides: Partial<CaptureDraft> = {}): CaptureDraft {
  return {
    description: "Mercado",
    amountCents: 8500,
    date: "2026-10-19",
    kind: "expense",
    categoryId: FOOD,
    accountId: ACCOUNT,
    installmentCount: 1,
    candidates: [],
    explanation: "Regra: mercado → Alimentação",
    needsReview: false,
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

let container: HTMLDivElement;
let root: Root;
let online = true;
const onClose = vi.fn();

function Host() {
  const [open, setOpen] = useState(false);
  return (
    <CaptureUserContext.Provider value={USER}>
      <ToastProvider>
        <button type="button" id="opener" onClick={() => setOpen(true)}>
          Abrir
        </button>
        <CaptureSheet
          open={open}
          variant="sheet"
          onClose={() => {
            onClose();
            setOpen(false);
          }}
        />
      </ToastProvider>
    </CaptureUserContext.Provider>
  );
}

const flush = () =>
  act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

async function click(element: Element | null): Promise<void> {
  if (!(element instanceof HTMLElement)) throw new Error("Nothing to click");
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

async function type(
  element: Element | null,
  value: string,
): Promise<void> {
  if (
    !(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)
  ) {
    throw new Error("Nothing to type into");
  }
  const proto = Object.getPrototypeOf(element) as object;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  await act(async () => {
    setter?.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function press(
  element: Element | Document | null,
  key: string,
  init: KeyboardEventInit = {},
): Promise<KeyboardEvent> {
  const event = new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
    ...init,
  });
  await act(async () => {
    (element ?? document).dispatchEvent(event);
  });
  return event;
}

function button(name: string): HTMLButtonElement | null {
  return (
    [...document.querySelectorAll("button")].find(
      (b) =>
        b.getAttribute("aria-label") === name || b.textContent?.trim() === name,
    ) ?? null
  );
}

const dialog = () => document.querySelector<HTMLElement>("[role='dialog']");
const textarea = () =>
  document.querySelector<HTMLTextAreaElement>(
    "textarea[aria-label='Descreva o lançamento']",
  );
const fillButton = () =>
  document.querySelector<HTMLButtonElement>(".ff-capture__fill");
const saveButton = () =>
  document.querySelector<HTMLButtonElement>(".ff-capture__save");
const banner = () => document.querySelector<HTMLElement>(".ff-capture__banner");
const field = <T extends Element = HTMLInputElement>(name: string) =>
  document.querySelector<T>(`[name='${name}']`);
const stored = () => localStorage.getItem(captureDraftKey(USER));
const radio = (text: string) =>
  [...document.querySelectorAll('[role="radio"]')].find(
    (candidate) => candidate.textContent === text,
  ) ?? null;

/**
 * Clicks a link the way a browser would and reports whether the app blocked
 * the navigation. The document listener runs after React's, so it observes
 * the app's call, then stops jsdom from navigating.
 */
async function clickLink(link: Element | null | undefined): Promise<boolean> {
  if (!(link instanceof HTMLAnchorElement)) throw new Error("No link to click");
  let prevented = false;
  const observe = (event: Event) => {
    prevented = event.defaultPrevented;
    event.preventDefault();
  };
  document.addEventListener("click", observe);
  try {
    await act(async () => {
      link.dispatchEvent(
        new MouseEvent("click", { bubbles: true, cancelable: true }),
      );
    });
  } finally {
    document.removeEventListener("click", observe);
  }
  return prevented;
}

/** Shows the Obrigações banner and starts a save that waits on the result. */
async function startSaveUnderObligationsBanner() {
  mocks.suggest.mockResolvedValue({
    ok: false,
    message: captureMessage("unsupported_intent"),
  });
  await type(textarea(), "aluguel todo dia 5");
  await click(fillButton());
  await flush();
  await type(field("amount"), "85,00");
  await type(field("description"), "Mercado");
  const pending = deferred<{ ok: boolean; error?: string }>();
  mocks.createTransaction.mockReturnValueOnce(pending.promise);
  await click(saveButton());
  return pending;
}

async function openSheet(): Promise<void> {
  const opener = document.getElementById("opener") as HTMLButtonElement;
  opener.focus();
  await click(opener);
  await flush();
}

async function setOnline(next: boolean): Promise<void> {
  online = next;
  await act(async () => {
    window.dispatchEvent(new Event(next ? "online" : "offline"));
  });
}

beforeEach(async () => {
  localStorage.clear();
  vi.clearAllMocks();
  online = true;
  Object.defineProperty(window.navigator, "onLine", {
    configurable: true,
    get: () => online,
  });
  mocks.load.mockResolvedValue(loaded);
  mocks.createTransaction.mockResolvedValue({ ok: true });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root.render(<Host />));
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("options loading", () => {
  it("loads once on the first open, shows the skeleton until then, and reuses the result", async () => {
    const pending = deferred<typeof loaded>();
    mocks.load.mockReturnValueOnce(pending.promise);
    await openSheet();

    expect(document.querySelector(".ff-capture__skeleton")).not.toBeNull();
    expect(field("amount")).toBeNull();

    await act(async () => pending.resolve(loaded));
    await flush();
    expect(document.querySelector(".ff-capture__skeleton")).toBeNull();
    expect(field("amount")).not.toBeNull();

    await click(button("Fechar"));
    await openSheet();
    expect(field("amount")).not.toBeNull();
    expect(mocks.load).toHaveBeenCalledTimes(1);
  });

  it("dates a fresh draft with the current day on every open, from cached options", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(new Date("2026-10-20T23:50:00-03:00"));
      await openSheet();
      expect(field("occurredOn")?.value).toBe("2026-10-20");

      await click(button("Fechar"));
      vi.setSystemTime(new Date("2026-10-21T08:00:00-03:00"));
      await openSheet();
      expect(field("occurredOn")?.value).toBe("2026-10-21");
      expect(mocks.load).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows the unavailable banner on a failed load and retries on the next open", async () => {
    mocks.load.mockRejectedValueOnce(new Error("Nenhuma casa ativa"));
    await openSheet();

    expect(banner()?.textContent).toContain(captureMessage("unavailable").text);
    expect(document.querySelector(".ff-capture__skeleton")).not.toBeNull();
    expect(field("amount")).toBeNull();

    await click(button("Fechar"));
    await openSheet();
    expect(mocks.load).toHaveBeenCalledTimes(2);
    expect(field("amount")).not.toBeNull();
  });
});

describe("Preencher", () => {
  beforeEach(openSheet);

  it("is disabled while the text is empty and caps the text at 500 characters", async () => {
    expect(textarea()?.maxLength).toBe(500);
    expect(fillButton()?.disabled).toBe(true);
    await type(textarea(), "   ");
    expect(fillButton()?.disabled).toBe(true);
    await type(textarea(), "85 no mercado");
    expect(fillButton()?.disabled).toBe(false);
  });

  it("fills from Enter but lets Shift+Enter insert a newline", async () => {
    mocks.suggest.mockResolvedValue({ ok: true, intent: "plain", draft: draft() });
    await type(textarea(), "85 no mercado");

    const shifted = await press(textarea(), "Enter", { shiftKey: true });
    expect(shifted.defaultPrevented).toBe(false);
    expect(mocks.suggest).not.toHaveBeenCalled();

    const enter = await press(textarea(), "Enter");
    await flush();
    expect(enter.defaultPrevented).toBe(true);
    expect(mocks.suggest).toHaveBeenCalledWith("85 no mercado");
    expect(field("amount")?.value).toBe("85,00");
  });

  it("reads Preenchendo… while running, keeps fields editable and runs one fill at a time", async () => {
    const pending = deferred<unknown>();
    mocks.suggest.mockReturnValue(pending.promise);
    await type(textarea(), "85 no mercado");

    await click(fillButton());
    expect(fillButton()?.textContent).toContain("Preenchendo…");
    expect(fillButton()?.disabled).toBe(true);
    await press(textarea(), "Enter");
    await click(fillButton());
    expect(mocks.suggest).toHaveBeenCalledTimes(1);

    expect(field("amount")?.disabled).toBe(false);
    await type(field("amount"), "12,00");
    expect(field("amount")?.value).toBe("12,00");

    await act(async () =>
      pending.resolve({ ok: true, intent: "plain", draft: draft() }),
    );
    await flush();
    expect(field("amount")?.value).toBe("12,00");
    expect(field("description")?.value).toBe("Mercado");
  });

  it("drops a result that arrives after the sheet closed", async () => {
    const pending = deferred<unknown>();
    mocks.suggest.mockReturnValue(pending.promise);
    await type(textarea(), "85 no mercado");
    await click(fillButton());
    await click(button("Fechar"));

    await act(async () =>
      pending.resolve({ ok: true, intent: "plain", draft: draft() }),
    );
    await openSheet();

    expect(textarea()?.value).toBe("85 no mercado");
    expect(field("amount")?.value).toBe("");
    expect(document.querySelector(".ff-capture__explanation")).toBeNull();
  });

  it("shows the explanation, the AI marks, and the conflict chips; a chip picks the category as a user edit", async () => {
    mocks.suggest.mockResolvedValue({
      ok: true,
      intent: "plain",
      draft: draft({
        categoryId: undefined,
        needsReview: true,
        candidates: [
          { categoryId: FOOD, explanation: "a" },
          { categoryId: FUN, explanation: "b" },
        ],
      }),
    });
    await type(textarea(), "85 no mercado");
    await click(fillButton());
    await flush();

    expect(document.querySelector(".ff-capture__explanation")?.textContent).toBe(
      "Regra: mercado → Alimentação",
    );
    expect(document.querySelector(".ff-capture__conflict")?.textContent).toBe(
      "Há regras conflitantes para este lugar — escolha a categoria",
    );
    const amountLabel = document.querySelector(`label[for='${field("amount")?.id}']`);
    expect(amountLabel?.textContent).toContain("IA");
    const category = field<HTMLSelectElement>("categoryId");
    expect(category?.value).toBe("");
    expect(category?.closest(".ff-txfields--warn")).not.toBeNull();

    const chips = [...document.querySelectorAll<HTMLButtonElement>(".ff-capture__chip")];
    expect(chips.map((c) => c.textContent)).toEqual(["Alimentação", "Lazer"]);
    await click(chips[1]!);

    expect(field<HTMLSelectElement>("categoryId")?.value).toBe(FUN);
    expect(field("categoryId")?.closest(".ff-txfields--warn")).toBeNull();
    expect(chips[1]?.getAttribute("aria-pressed")).toBe("true");

    mocks.suggest.mockResolvedValue({ ok: true, intent: "plain", draft: draft() });
    await click(fillButton());
    await flush();
    expect(field<HTMLSelectElement>("categoryId")?.value).toBe(FUN);
  });
});

describe("suggestion chips", () => {
  const SALARY = "00000000-0000-4000-8000-000000000007";
  const chipNames = () =>
    [...document.querySelectorAll(".ff-capture__chip")].map((c) => c.textContent);

  beforeEach(async () => {
    mocks.load.mockResolvedValue({
      ...loaded,
      options: {
        ...options,
        categories: [
          ...options.categories,
          { id: SALARY, name: "Salário", kind: "income" },
        ],
      },
    });
    await openSheet();
    mocks.suggest.mockResolvedValue({
      ok: true,
      intent: "plain",
      draft: draft({
        categoryId: undefined,
        needsReview: true,
        candidates: [
          { categoryId: "00000000-0000-4000-8000-0000000000ee", explanation: "?" },
          { categoryId: FOOD, explanation: "a" },
          { categoryId: SALARY, explanation: "b" },
          { categoryId: FUN, explanation: "c" },
        ],
      }),
    });
    await type(textarea(), "85 no mercado");
    await click(fillButton());
    await flush();
  });

  it("shows only known candidates of the current kind and follows a kind change", async () => {
    expect(chipNames()).toEqual(["Alimentação", "Lazer"]);

    await click(radio("Receita"));
    expect(chipNames()).toEqual(["Salário"]);
    await click(document.querySelector(".ff-capture__chip"));
    expect(field<HTMLSelectElement>("categoryId")?.value).toBe(SALARY);

    await click(radio("Despesa"));
    expect(chipNames()).toEqual(["Alimentação", "Lazer"]);
  });
});

describe("message banner", () => {
  beforeEach(openSheet);

  it("shows an error with its tone and dismisses with Dispensar", async () => {
    mocks.suggest.mockResolvedValue({
      ok: false,
      message: captureMessage("rate_limited"),
    });
    await type(textarea(), "85 no mercado");
    await click(fillButton());
    await flush();

    expect(banner()?.getAttribute("role")).toBe("status");
    expect(banner()?.classList.contains("ff-capture__banner--warn")).toBe(true);
    expect(banner()?.textContent).toContain("Muitas tentativas — aguarde um minuto");

    await type(textarea(), "85 no mercado!");
    expect(banner()).not.toBeNull();

    await click(button("Dispensar"));
    expect(banner()).toBeNull();
  });

  it("renders the href as a link to Obrigações", async () => {
    mocks.suggest.mockResolvedValue({
      ok: false,
      message: captureMessage("unsupported_intent"),
    });
    await type(textarea(), "aluguel todo dia 5");
    await click(fillButton());
    await flush();

    const link = banner()?.querySelector("a");
    expect(banner()?.classList.contains("ff-capture__banner--accent")).toBe(true);
    expect(link?.getAttribute("href")).toBe("/obligations");
    expect(link?.textContent).toBe("Abrir Obrigações →");
  });

  it("clears the non_financial message once the text changes", async () => {
    mocks.suggest.mockResolvedValue({
      ok: false,
      message: captureMessage("non_financial"),
    });
    await type(textarea(), "bom dia");
    await click(fillButton());
    await flush();
    expect(banner()?.textContent).toContain("Não entendi como lançamento");

    await type(textarea(), "bom dia 85");
    expect(banner()).toBeNull();
  });

  it("recognises the non_financial message by its code, not its text", async () => {
    mocks.suggest.mockResolvedValue({
      ok: false,
      message: { code: "non_financial", text: "Outra redação", tone: "warn" },
    });
    await type(textarea(), "bom dia");
    await click(fillButton());
    await flush();
    expect(banner()?.textContent).toContain("Outra redação");

    await type(textarea(), "bom dia 85");
    expect(banner()).toBeNull();
  });
});

describe("offline", () => {
  beforeEach(openSheet);

  it("shows the saved-draft banner and disables Preencher", async () => {
    await type(textarea(), "85 no mercado");
    await setOnline(false);

    expect(document.querySelector(".ff-capture__offline")?.textContent).toContain(
      "Sem conexão — seu rascunho está salvo",
    );
    expect(fillButton()?.disabled).toBe(true);

    await setOnline(true);
    expect(document.querySelector(".ff-capture__offline")).toBeNull();
    expect(fillButton()?.disabled).toBe(false);
  });

  it("keeps the sheet open with the same banner when a save throws", async () => {
    mocks.createTransaction.mockRejectedValue(new TypeError("Failed to fetch"));
    await type(field("amount"), "85,00");
    await type(field("description"), "Mercado");
    await click(saveButton());
    await flush();

    expect(dialog()).not.toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    expect(document.querySelector(".ff-capture__offline")?.textContent).toContain(
      "Sem conexão — seu rascunho está salvo",
    );
  });

  it("puts the banner at the top of the panel, above the drag handle", async () => {
    await setOnline(false);

    const panel = dialog()!;
    expect(panel.firstElementChild?.classList).toContain("ff-capture__offline");
    expect(panel.firstElementChild?.nextElementSibling?.classList).toContain(
      "ff-capture__handle",
    );
  });

  async function failCategoryCreate(): Promise<void> {
    mocks.createCategory.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await click(button("+ Nova categoria"));
    await type(
      document.querySelector("input[aria-label='Nome da nova categoria']"),
      "Pets",
    );
    await click(button("Criar"));
    await flush();
    expect(document.querySelector(".ff-capture__offline")).not.toBeNull();
  }

  it("clears a network-error banner when the browser comes back online", async () => {
    await failCategoryCreate();

    await setOnline(true);
    expect(document.querySelector(".ff-capture__offline")).toBeNull();
  });

  it("clears a network-error banner when a later action succeeds", async () => {
    await failCategoryCreate();
    mocks.createCategory.mockResolvedValue({
      ok: true,
      message: "Categoria criada.",
      id: "new-cat",
    });

    await click(button("Criar"));
    await flush();
    expect(document.querySelector(".ff-capture__offline")).toBeNull();
  });

  it("clears a network-error banner when a later fill gets an answer", async () => {
    await failCategoryCreate();
    mocks.suggest.mockResolvedValue({ ok: true, intent: "plain", draft: draft() });

    await type(textarea(), "85 no mercado");
    await click(fillButton());
    await flush();
    expect(document.querySelector(".ff-capture__offline")).toBeNull();
  });
});

describe("voice", () => {
  let media: FakeMedia;
  const aiBox = () => document.querySelector<HTMLElement>(".ff-capture__ai");

  beforeEach(async () => {
    media = installFakeMedia();
    await openSheet();
  });

  afterEach(uninstallFakeMedia);

  async function record(): Promise<void> {
    await click(button("Gravar"));
    await flush();
  }

  async function stopRecording(): Promise<void> {
    await click(button("Parar"));
    await flush();
    await flush();
  }

  it("puts the transcript in the text box and runs Preencher with it", async () => {
    mocks.transcribe.mockResolvedValue({ ok: true, text: "85 no mercado no nubank" });
    mocks.suggest.mockResolvedValue({ ok: true, intent: "plain", draft: draft() });
    await type(textarea(), "rascunho antigo");

    await record();
    await stopRecording();

    expect(textarea()?.value).toBe("85 no mercado no nubank");
    expect(mocks.suggest).toHaveBeenCalledTimes(1);
    expect(mocks.suggest).toHaveBeenCalledWith("85 no mercado no nubank");
    expect(field("amount")?.value).toBe("85,00");
  });

  it("cuts a transcript over 500 characters to its first 500 before filling", async () => {
    const transcript = `85 no mercado no nubank ${"e mais ".repeat(100)}`;
    mocks.transcribe.mockResolvedValue({ ok: true, text: transcript });
    mocks.suggest.mockResolvedValue({ ok: true, intent: "plain", draft: draft() });

    await record();
    await stopRecording();

    expect(textarea()?.value).toBe(transcript.slice(0, 500));
    expect(mocks.suggest).toHaveBeenCalledWith(transcript.slice(0, 500));
  });

  it("after the browser ends a recording, Preencher and a new Gravar both work", async () => {
    mocks.transcribe.mockResolvedValue({ ok: true, text: "85 no mercado no nubank" });
    mocks.suggest.mockResolvedValue({ ok: true, intent: "plain", draft: draft() });

    await record();
    await act(async () => media.recorder().stopFromBrowser());
    await flush();
    await flush();

    expect(mocks.suggest).toHaveBeenCalledWith("85 no mercado no nubank");
    expect(fillButton()?.disabled).toBe(false);
    await record();
    expect(button("Parar")).not.toBeNull();
    expect(textarea()?.placeholder).toBe("Ouvindo…");
  });

  it("keeps the text and shows the negative banner when transcription fails", async () => {
    mocks.transcribe.mockResolvedValue({
      ok: false,
      message: captureMessage("transcribe_failed"),
    });
    await type(textarea(), "rascunho antigo");

    await record();
    await stopRecording();

    expect(textarea()?.value).toBe("rascunho antigo");
    expect(mocks.suggest).not.toHaveBeenCalled();
    expect(banner()?.textContent).toContain(captureMessage("transcribe_failed").text);
    expect(banner()?.className).toContain("ff-capture__banner--neg");
  });

  it("shows the mic_denied banner when the mic is refused", async () => {
    media.getUserMedia.mockRejectedValueOnce(
      new DOMException("Permission denied", "NotAllowedError"),
    );
    await record();

    expect(banner()?.textContent).toContain(captureMessage("mic_denied").text);
    expect(banner()?.className).toContain("ff-capture__banner--warn");
  });

  it("reads Ouvindo… while recording and Transcrevendo… while transcribing, with Preencher off", async () => {
    mocks.transcribe.mockReturnValue(new Promise(() => undefined));
    await type(textarea(), "85 no mercado");

    await record();
    expect(textarea()?.placeholder).toBe("Ouvindo…");
    expect(aiBox()?.className).toContain("ff-capture__ai--recording");
    expect(fillButton()?.disabled).toBe(true);

    await stopRecording();
    expect(textarea()?.placeholder).toBe("Transcrevendo…");
    expect(aiBox()?.className).not.toContain("ff-capture__ai--recording");
    expect(fillButton()?.disabled).toBe(true);
  });

  it("disables Gravar while offline", async () => {
    expect(button("Gravar")?.disabled).toBe(false);
    await setOnline(false);
    expect(button("Gravar")?.disabled).toBe(true);
    await setOnline(true);
    expect(button("Gravar")?.disabled).toBe(false);
  });

  it("disables Gravar while a fill runs", async () => {
    const pending = deferred<unknown>();
    mocks.suggest.mockReturnValue(pending.promise);
    await type(textarea(), "85 no mercado");
    await click(fillButton());

    expect(button("Gravar")?.disabled).toBe(true);

    await act(async () =>
      pending.resolve({ ok: true, intent: "plain", draft: draft() }),
    );
    await flush();
    expect(button("Gravar")?.disabled).toBe(false);
  });

  it("closing while recording stops the recorder, releases the mic and sends nothing", async () => {
    await record();
    const recorder = media.recorder();

    await click(button("Fechar"));
    await flush();

    expect(dialog()).toBeNull();
    expect(recorder.stop).toHaveBeenCalled();
    expect(media.track.stop).toHaveBeenCalled();
    expect(mocks.transcribe).not.toHaveBeenCalled();
  });
});

describe("new category", () => {
  beforeEach(openSheet);

  it("swaps the select for an input, creates with the current kind, and selects the result", async () => {
    mocks.createCategory.mockResolvedValue({
      ok: true,
      message: "Categoria criada.",
      id: "new-cat",
    });
    await click(button("+ Nova categoria"));

    expect(field("categoryId")).toBeNull();
    const input = document.querySelector<HTMLInputElement>(
      "input[aria-label='Nome da nova categoria']",
    );
    expect(button("Criar")).not.toBeNull();
    expect(document.querySelector(".ff-capture__category-toggle")?.textContent).toBe(
      "Cancelar",
    );

    await type(input, "Pets");
    await press(input, "Enter");
    await flush();

    const formData = mocks.createCategory.mock.calls[0]?.[0] as FormData;
    expect(formData.get("name")).toBe("Pets");
    expect(formData.get("kind")).toBe("expense");
    const select = field<HTMLSelectElement>("categoryId");
    expect(select?.value).toBe("new-cat");
    expect(select?.selectedOptions[0]?.textContent).toBe("Pets");
  });

  it.each([
    ["Receita", ["Receita"]],
    ["Receita and back", ["Receita", "Despesa"]],
  ])("drops a category created after Tipo changed to %s", async (_label, kinds) => {
    const pending = deferred<{ ok: true; message: string; id: string }>();
    mocks.createCategory.mockReturnValueOnce(pending.promise);
    await click(button("+ Nova categoria"));
    await type(
      document.querySelector("input[aria-label='Nome da nova categoria']"),
      "Pets",
    );
    await click(button("Criar"));
    for (const kind of kinds) await click(radio(kind));

    await act(async () =>
      pending.resolve({ ok: true, message: "Categoria criada.", id: "new-cat" }),
    );
    await flush();
    await type(field("amount"), "85,00");
    await type(field("description"), "Pets");
    await click(saveButton());
    await flush();

    const formData = mocks.createTransaction.mock.calls[0]?.[0] as FormData;
    expect(formData.get("categoryId")).not.toBe("new-cat");
  });

  it("shows the action's message under the field on failure", async () => {
    mocks.createCategory.mockResolvedValue({
      ok: false,
      message: "Já existe uma categoria com esse nome.",
    });
    await click(button("+ Nova categoria"));
    await type(
      document.querySelector("input[aria-label='Nome da nova categoria']"),
      "Lazer",
    );
    await click(button("Criar"));
    await flush();

    expect(
      document.querySelector(".ff-capture__category-error")?.textContent,
    ).toBe("Já existe uma categoria com esse nome.");
    expect(field("categoryId")).toBeNull();
  });

  it("names the open toggle apart from the footer Cancelar", async () => {
    await click(button("+ Nova categoria"));

    expect(
      document
        .querySelector(".ff-capture__category-toggle")
        ?.getAttribute("aria-label"),
    ).toBe("Cancelar nova categoria");
    const cancels = [...document.querySelectorAll("button")].filter(
      (b) => (b.getAttribute("aria-label") ?? b.textContent?.trim()) === "Cancelar",
    );
    expect(cancels).toHaveLength(1);
    expect(cancels[0]?.classList).toContain("ff-capture__cancel");
  });

  it("Esc closes only the creator, and a second Esc closes the sheet", async () => {
    await click(button("+ Nova categoria"));
    const input = document.querySelector(
      "input[aria-label='Nome da nova categoria']",
    );

    await press(input, "Escape");
    expect(onClose).not.toHaveBeenCalled();
    expect(dialog()).not.toBeNull();
    expect(field("categoryId")).not.toBeNull();

    await press(document, "Escape");
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("Salvar", () => {
  beforeEach(openSheet);

  it("is disabled until Valor has a value", async () => {
    expect(saveButton()?.disabled).toBe(true);
    await type(field("amount"), "85,00");
    expect(saveButton()?.disabled).toBe(false);
  });

  it("validates before calling the action", async () => {
    await type(field("amount"), "85,00");
    await click(saveButton());

    expect(mocks.createTransaction).not.toHaveBeenCalled();
    expect(document.querySelector(".ff-capture__save-error")?.textContent).toBe(
      "A descrição não pode ficar vazia.",
    );
  });

  it("saves, closes, clears the draft, toasts and refreshes", async () => {
    await type(textarea(), "85 no mercado");
    await type(field("amount"), "85,00");
    await type(field("description"), "Mercado");
    expect(stored()).not.toBeNull();

    await click(saveButton());
    await flush();

    const formData = mocks.createTransaction.mock.calls[0]?.[0] as FormData;
    expect(formData.get("amount")).toBe("85,00");
    expect(formData.get("description")).toBe("Mercado");
    expect(formData.get("payment")).toBe(`account:${ACCOUNT}`);
    expect(formData.get("responsible")).toBe("household");
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(dialog()).toBeNull();
    expect(stored()).toBeNull();
    expect(document.body.textContent).toContain("Lançamento salvo");
    expect(mocks.router.refresh).toHaveBeenCalled();
  });

  it.each([
    ["the × button", () => click(button("Fechar"))],
    ["Esc", () => press(document, "Escape").then(() => undefined)],
    [
      "the backdrop",
      () => click(document.querySelector(".ff-capture__backdrop")),
    ],
    ["Cancelar", () => click(document.querySelector(".ff-capture__cancel"))],
    [
      "the Obrigações link",
      () => clickLink(banner()?.querySelector("a")).then(() => undefined),
    ],
  ])("cannot be closed from %s while a save is in flight", async (_label, close) => {
    const pending = await startSaveUnderObligationsBanner();

    await close();
    expect(onClose).not.toHaveBeenCalled();
    expect(dialog()).not.toBeNull();
    expect(stored()).not.toBeNull();

    await act(async () => pending.resolve({ ok: true }));
    await flush();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(dialog()).toBeNull();
  });

  it("blocks the Obrigações link while a save is in flight and follows it after the save fails", async () => {
    const pending = await startSaveUnderObligationsBanner();

    expect(await clickLink(banner()?.querySelector("a"))).toBe(true);

    await act(async () => pending.resolve({ ok: false, error: "Falhou." }));
    await flush();
    expect(await clickLink(banner()?.querySelector("a"))).toBe(false);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("can be closed again after a failed save", async () => {
    mocks.createTransaction.mockResolvedValue({ ok: false, error: "Falhou." });
    await type(field("amount"), "85,00");
    await type(field("description"), "Mercado");
    await click(saveButton());
    await flush();

    await click(button("Fechar"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("keeps the sheet open with the action's error under the form", async () => {
    mocks.createTransaction.mockResolvedValue({
      ok: false,
      error: "Escolha uma categoria de despesa.",
    });
    await type(field("amount"), "85,00");
    await type(field("description"), "Mercado");
    await click(saveButton());
    await flush();

    expect(dialog()).not.toBeNull();
    expect(document.querySelector(".ff-capture__save-error")?.textContent).toBe(
      "Escolha uma categoria de despesa.",
    );
  });
});

describe("closing", () => {
  beforeEach(openSheet);

  it.each([
    ["the × button", () => click(button("Fechar"))],
    ["Esc", () => press(document, "Escape").then(() => undefined)],
    [
      "the backdrop",
      () => click(document.querySelector(".ff-capture__backdrop")),
    ],
  ])("closes from %s and keeps the draft", async (_label, close) => {
    await type(textarea(), "85 no mercado");
    await close();

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(dialog()).toBeNull();
    expect(JSON.parse(stored() ?? "null")?.text).toBe("85 no mercado");
  });

  it("locks body scroll while open and restores it on close", async () => {
    await click(button("Fechar"));
    document.body.style.overflow = "scroll";
    await openSheet();
    expect(document.body.style.overflow).toBe("hidden");

    await click(button("Fechar"));
    expect(document.body.style.overflow).toBe("scroll");
    document.body.style.overflow = "";
  });

  it("Cancelar closes and clears the draft", async () => {
    await type(textarea(), "85 no mercado");
    await click(document.querySelector(".ff-capture__cancel"));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(stored()).toBeNull();
  });

  it("traps focus inside the sheet and restores it to the opener", async () => {
    const panel = dialog()!;
    expect(panel.contains(document.activeElement)).toBe(true);

    const focusable = [
      ...panel.querySelectorAll<HTMLElement>("button, input, select, textarea, a[href]"),
    ].filter((el) => !(el as HTMLButtonElement).disabled);
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;

    last.focus();
    const forward = await press(last, "Tab");
    expect(forward.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(first);

    const back = await press(first, "Tab", { shiftKey: true });
    expect(back.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(last);

    await click(button("Fechar"));
    expect(document.activeElement).toBe(document.getElementById("opener"));
  });
});

describe("/capture page", () => {
  it("renders the page variant and closing goes to /", async () => {
    await act(async () =>
      root.render(
        <CaptureUserContext.Provider value={USER}>
          <ToastProvider>
            <CapturePage />
          </ToastProvider>
        </CaptureUserContext.Provider>,
      ),
    );
    await flush();

    expect(document.querySelector(".ff-capture--page")).not.toBeNull();
    expect(document.querySelector(".ff-capture__backdrop")).toBeNull();
    expect(textarea()).not.toBeNull();

    await click(button("Fechar"));
    expect(mocks.router.push).toHaveBeenCalledWith("/");
  });

  it("blocks the Obrigações link while a save is in flight and follows it after the save fails", async () => {
    await act(async () =>
      root.render(
        <CaptureUserContext.Provider value={USER}>
          <ToastProvider>
            <CapturePage />
          </ToastProvider>
        </CaptureUserContext.Provider>,
      ),
    );
    await flush();
    const pending = await startSaveUnderObligationsBanner();

    expect(await clickLink(banner()?.querySelector("a"))).toBe(true);

    await act(async () => pending.resolve({ ok: false, error: "Falhou." }));
    await flush();
    expect(await clickLink(banner()?.querySelector("a"))).toBe(false);
    expect(mocks.router.push).not.toHaveBeenCalled();
  });

  it("shows the offline banner at the top of the page panel", async () => {
    await act(async () =>
      root.render(
        <CaptureUserContext.Provider value={USER}>
          <ToastProvider>
            <CapturePage />
          </ToastProvider>
        </CaptureUserContext.Provider>,
      ),
    );
    await flush();
    await setOnline(false);

    const panel = document.querySelector(".ff-capture__panel")!;
    expect(panel.firstElementChild?.classList).toContain("ff-capture__offline");
    expect(document.body.style.overflow).toBe("");
  });
});
