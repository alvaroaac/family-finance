import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { addToast, removeToast, useToast, type ToastRecord } from "../components/ui/toast";

/**
 * No jsdom/happy-dom is configured in apps/web/vitest.config.ts (see the
 * comment there — only `lib/**` and `integration/**` run under vitest; the
 * Playwright e2e suite covers real-browser behavior). `createPortal` and
 * effect-driven auto-dismiss timers need a DOM, so this suite exercises the
 * exported pure queue helpers (`addToast`/`removeToast`) directly — the same
 * reducer-shaped logic the provider's `show`/`dismiss` callbacks delegate to
 * — plus an SSR smoke check that `useToast()` throws outside a provider.
 */
describe("toast queue — pure helpers", () => {
  it("addToast appends a record with defaulted tone and duration", () => {
    const queue = addToast([], 0, { message: "Não foi possível salvar" });
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({
      id: 0,
      message: "Não foi possível salvar",
      tone: "negative",
      durationMs: 5000,
    });
  });

  it("addToast respects an explicit tone and durationMs", () => {
    const queue = addToast([], 1, {
      message: "Lançamento salvo",
      tone: "positive",
      durationMs: 3000,
    });
    expect(queue[0]).toMatchObject({ tone: "positive", durationMs: 3000 });
  });

  it("addToast stacks multiple toasts in call order", () => {
    let queue = addToast([], 0, { message: "primeiro", tone: "negative" });
    queue = addToast(queue, 1, { message: "segundo", tone: "positive" });
    queue = addToast(queue, 2, { message: "terceiro", tone: "warn" });
    expect(queue.map((t) => t.message)).toEqual(["primeiro", "segundo", "terceiro"]);
  });

  it("removeToast removes only the matching id, preserving order of the rest", () => {
    const seed: ToastRecord[] = [
      { id: 0, message: "a", tone: "negative", durationMs: 5000 },
      { id: 1, message: "b", tone: "positive", durationMs: 5000 },
      { id: 2, message: "c", tone: "warn", durationMs: 5000 },
    ];
    const next = removeToast(seed, 1);
    expect(next.map((t) => t.id)).toEqual([0, 2]);
  });

  it("removeToast is a no-op when the id is not present", () => {
    const seed: ToastRecord[] = [{ id: 0, message: "a", tone: "negative", durationMs: 5000 }];
    const next = removeToast(seed, 99);
    expect(next).toEqual(seed);
  });

  it("addToast does not mutate the input queue (immutable update)", () => {
    const seed: ToastRecord[] = [];
    const next = addToast(seed, 0, { message: "x" });
    expect(seed).toHaveLength(0);
    expect(next).toHaveLength(1);
  });
});

describe("useToast — misuse guard", () => {
  it("throws a clear developer error when called outside a ToastProvider", () => {
    function Consumer() {
      useToast();
      return null;
    }
    expect(() => renderToStaticMarkup(createElement(Consumer))).toThrow(
      /useToast\(\) must be called within a <ToastProvider>/,
    );
  });
});
