import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createCode: vi.fn(),
  unlink: vi.fn(),
  error: vi.fn(),
}));

vi.mock("../lib/auth.js", () => ({ requireAuthorizedUser: vi.fn() }));
vi.mock("../lib/supabase.js", () => ({
  createServerSupabaseClient: vi.fn(async () => ({})),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/headers", () => ({ cookies: vi.fn() }));
vi.mock("@family-finance/db", () => ({
  createTelegramLinkCode: mocks.createCode,
  unlinkTelegram: mocks.unlink,
}));

import {
  createTelegramLinkCodeAction,
  unlinkTelegramAction,
} from "../app/(app)/settings/actions.js";

describe("Telegram settings action failures", () => {
  it("hides an internal code generation error and logs it", async () => {
    const cause = new Error("internal database detail");
    const spy = vi.spyOn(console, "error").mockImplementation(mocks.error);
    mocks.createCode.mockRejectedValueOnce(cause);
    try {
      expect(await createTelegramLinkCodeAction()).toEqual({
        ok: false,
        error: "Não deu pra gerar o código agora. Tenta de novo em instantes.",
      });
      expect(mocks.error).toHaveBeenCalledWith(
        expect.stringContaining("createTelegramLinkCodeAction"),
        cause,
      );
    } finally {
      spy.mockRestore();
    }
  });

  it("hides an internal unlink error and logs it", async () => {
    const cause = new Error("internal database detail");
    const spy = vi.spyOn(console, "error").mockImplementation(mocks.error);
    mocks.unlink.mockRejectedValueOnce(cause);
    try {
      expect(await unlinkTelegramAction()).toEqual({
        ok: false,
        error: "Não deu pra desvincular agora. Tenta de novo em instantes.",
      });
      expect(mocks.error).toHaveBeenCalledWith(
        expect.stringContaining("unlinkTelegramAction"),
        cause,
      );
    } finally {
      spy.mockRestore();
    }
  });
});
