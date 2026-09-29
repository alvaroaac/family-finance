import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createCode: vi.fn(),
  unlink: vi.fn(),
  findHousehold: vi.fn(),
  updateMember: vi.fn(),
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
  findHouseholdIdForCurrentUser: mocks.findHousehold,
  updateHouseholdMember: mocks.updateMember,
}));

import { requireAuthorizedUser } from "../lib/auth.js";
import {
  createTelegramLinkCodeAction,
  unlinkTelegramAction,
  updateMemberAction,
} from "../app/(app)/settings/actions.js";

describe("settings actions without a session", () => {
  it.each([
    ["updateMemberAction", () => updateMemberAction(new FormData())],
    ["createTelegramLinkCodeAction", () => createTelegramLinkCodeAction()],
    ["unlinkTelegramAction", () => unlinkTelegramAction()],
  ])("%s lets the sign-in redirect through", async (_name, run) => {
    const redirect = new Error("NEXT_REDIRECT");
    vi.mocked(requireAuthorizedUser).mockRejectedValueOnce(redirect);
    await expect(run()).rejects.toBe(redirect);
  });
});

describe("member settings action failures", () => {
  it("hides and logs a database error while saving a profile", async () => {
    const cause = new Error("internal database detail");
    const spy = vi.spyOn(console, "error").mockImplementation(mocks.error);
    mocks.findHousehold.mockResolvedValueOnce("house-1");
    mocks.updateMember.mockRejectedValueOnce(cause);
    const formData = new FormData();
    formData.set("memberId", "member-1");
    formData.set("displayName", "Ana");
    try {
      expect(await updateMemberAction(formData)).toEqual({
        ok: false,
        error: "Não deu pra salvar o perfil agora. Tenta de novo em instantes.",
      });
      expect(mocks.error).toHaveBeenCalledWith(
        expect.stringContaining("updateMemberAction"),
        cause,
      );
    } finally {
      spy.mockRestore();
    }
  });
});

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
