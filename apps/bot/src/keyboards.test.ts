import { describe, it, expect } from "vitest";

import {
  TOKENS,
  bindPromptKeyboard,
  parsePromptCallbackData,
  CATEGORY_TOKEN_PREFIX,
  CARD_TOKEN_PREFIX,
  confirmationKeyboard,
  installmentConfirmationKeyboard,
  obligationConfirmationKeyboard,
  categoryGridKeyboard,
  responsibleGridKeyboard,
  cancelOnlyKeyboard,
  cardGridKeyboard,
} from "./keyboards.js";

describe.each([
  ["expense", confirmationKeyboard],
  ["installment", installmentConfirmationKeyboard],
  ["obligation", obligationConfirmationKeyboard],
] as const)("%s category alternatives", (_name, buildKeyboard) => {
  const candidates = [
    {
      categoryId: "food",
      categoryName: "Alimentação",
      subcategoryId: "market",
      subcategoryName: "Mercado",
    },
    {
      categoryId: "food",
      categoryName: "Alimentação",
      subcategoryId: "restaurant",
      subcategoryName: "Restaurante",
    },
    { categoryId: "food", categoryName: "Alimentação" },
  ] as const;

  it("puts confirm first and keeps same-category alternatives with their original indexes", () => {
    const keyboard = buildKeyboard(undefined, candidates, candidates[0]);
    expect(
      keyboard.inline_keyboard[0]?.map((button) => button.callback_data),
    ).toEqual(["cf", "cx"]);
    expect(
      keyboard.inline_keyboard
        .flat()
        .filter((button) => button.callback_data.startsWith("cs:")),
    ).toEqual([
      { text: "📂 Alimentação › Restaurante", callback_data: "cs:1" },
      { text: "📂 Alimentação", callback_data: "cs:2" },
    ]);
  });

  it("omits the redundant row when the only suggestion is already selected", () => {
    const keyboard = buildKeyboard(undefined, [candidates[2]], candidates[2]);
    expect(keyboard.inline_keyboard).toHaveLength(2);
    expect(
      keyboard.inline_keyboard
        .flat()
        .some((button) => button.callback_data.startsWith("cs:")),
    ).toBe(false);
  });

  it("keeps suggestions when there is no selection, or another category has the same name", () => {
    for (const selected of [undefined, { categoryId: "other-food" }]) {
      const buttons = buildKeyboard(
        undefined,
        candidates,
        selected,
      ).inline_keyboard.flat();
      expect(
        buttons
          .filter((button) => button.callback_data.startsWith("cs:"))
          .map((button) => button.callback_data),
      ).toEqual(["cs:0", "cs:1", "cs:2"]);
    }
  });
});

describe("confirmationKeyboard", () => {
  it("without a proposal: confirm/cancel + category/responsável rows", () => {
    expect(confirmationKeyboard()).toEqual({
      inline_keyboard: [
        [
          { text: "✅ Confirmar", callback_data: "cf" },
          { text: "❌ Cancelar", callback_data: "cx" },
        ],
        [
          { text: "📂 Alterar categoria", callback_data: "cats" },
          { text: "👤 Responsável", callback_data: "resp" },
        ],
      ],
    });
  });

  it("with a proposal: accept-with-create / other / no-category / cancel", () => {
    expect(confirmationKeyboard("Pets")).toEqual({
      inline_keyboard: [
        [
          { text: '✅ Confirmar (cria "Pets")', callback_data: "nca" },
          { text: "📂 Outra categoria", callback_data: "cats" },
        ],
        [
          { text: "🚫 Sem categoria", callback_data: "nocat" },
          { text: "❌ Cancelar", callback_data: "cx" },
        ],
      ],
    });
  });
});

describe("installmentConfirmationKeyboard", () => {
  it("without a proposal: confirm/cancel + categoria only, no responsável", () => {
    const keyboard = installmentConfirmationKeyboard();
    expect(keyboard).toEqual({
      inline_keyboard: [
        [
          { text: "✅ Confirmar", callback_data: "cf" },
          { text: "❌ Cancelar", callback_data: "cx" },
        ],
        [{ text: "📂 Alterar categoria", callback_data: "cats" }],
      ],
    });
    const flat = keyboard.inline_keyboard.flat();
    expect(flat.some((b) => b.callback_data === TOKENS.responsible)).toBe(
      false,
    );
  });

  it("with a proposal: accept-with-create / other / no-category / cancel, no responsável", () => {
    const keyboard = installmentConfirmationKeyboard("Pets");
    expect(keyboard).toEqual({
      inline_keyboard: [
        [
          { text: '✅ Confirmar (cria "Pets")', callback_data: "nca" },
          { text: "📂 Outra categoria", callback_data: "cats" },
        ],
        [
          { text: "🚫 Sem categoria", callback_data: "nocat" },
          { text: "❌ Cancelar", callback_data: "cx" },
        ],
      ],
    });
    const flat = keyboard.inline_keyboard.flat();
    expect(flat.some((b) => b.callback_data === TOKENS.responsible)).toBe(
      false,
    );
  });
});

describe("categoryGridKeyboard", () => {
  it("lists active categories alphabetically, 2 per row, ending with nova categoria", () => {
    const grid = categoryGridKeyboard([
      { id: "cat-t", name: "Transporte" },
      { id: "cat-a", name: "Alimentação" },
      { id: "cat-s", name: "Saúde" },
    ]);
    expect(grid).toEqual({
      inline_keyboard: [
        [
          { text: "Alimentação", callback_data: "ct:cat-a" },
          { text: "Saúde", callback_data: "ct:cat-s" },
        ],
        [{ text: "Transporte", callback_data: "ct:cat-t" }],
        [{ text: "➕ Nova categoria", callback_data: "nc" }],
      ],
    });
  });

  it("never embeds names in callback_data (64-byte cap)", () => {
    const grid = categoryGridKeyboard([
      {
        id: "11111111-2222-3333-4444-555555555555",
        name: "Nome enorme de categoria",
      },
    ]);
    for (const row of grid.inline_keyboard) {
      for (const button of row) {
        expect(
          Buffer.byteLength(button.callback_data, "utf8"),
        ).toBeLessThanOrEqual(64);
      }
    }
    expect(grid.inline_keyboard[0]?.[0]?.callback_data).toBe(
      `${CATEGORY_TOKEN_PREFIX}11111111-2222-3333-4444-555555555555`,
    );
  });

  it("omits nova categoria when includeNewCategory is false (installment variant)", () => {
    const grid = categoryGridKeyboard(
      [
        { id: "cat-t", name: "Transporte" },
        { id: "cat-a", name: "Alimentação" },
      ],
      false,
    );
    const flat = grid.inline_keyboard.flat();
    expect(flat.some((b) => b.callback_data === TOKENS.newCategory)).toBe(
      false,
    );
  });

  it("keeps nova categoria by default", () => {
    const grid = categoryGridKeyboard([{ id: "cat-a", name: "Alimentação" }]);
    const flat = grid.inline_keyboard.flat();
    expect(flat.some((b) => b.callback_data === TOKENS.newCategory)).toBe(true);
  });
});

describe("responsibleGridKeyboard", () => {
  it("puts Casa first, then one button per member, 2 per row", () => {
    expect(
      responsibleGridKeyboard([
        { userId: "user-alvaro", displayName: "Alvaro" },
        { userId: "user-karol", displayName: "Karol" },
      ]),
    ).toEqual({
      inline_keyboard: [
        [{ text: "🏠 Casa", callback_data: "rs:house" }],
        [
          { text: "Alvaro", callback_data: "rs:user-alvaro" },
          { text: "Karol", callback_data: "rs:user-karol" },
        ],
      ],
    });
  });
});

describe("cardGridKeyboard", () => {
  it("lists cards alphabetically, 2 per row, no trailing button", () => {
    const grid = cardGridKeyboard([
      { id: "card-n", name: "Nubank" },
      { id: "card-i", name: "Inter" },
      { id: "card-x", name: "XP" },
    ]);
    expect(grid).toEqual({
      inline_keyboard: [
        [
          { text: "Inter", callback_data: "cd:card-i" },
          { text: "Nubank", callback_data: "cd:card-n" },
        ],
        [{ text: "XP", callback_data: "cd:card-x" }],
      ],
    });
  });

  it("never embeds names in callback_data (64-byte cap)", () => {
    const grid = cardGridKeyboard([
      {
        id: "11111111-2222-3333-4444-555555555555",
        name: "Nome enorme de cartão",
      },
    ]);
    for (const row of grid.inline_keyboard) {
      for (const button of row) {
        expect(
          Buffer.byteLength(button.callback_data, "utf8"),
        ).toBeLessThanOrEqual(64);
      }
    }
    expect(grid.inline_keyboard[0]?.[0]?.callback_data).toBe(
      `${CARD_TOKEN_PREFIX}11111111-2222-3333-4444-555555555555`,
    );
  });
});

describe("cancelOnlyKeyboard", () => {
  it("is a single cancel button", () => {
    expect(cancelOnlyKeyboard()).toEqual({
      inline_keyboard: [
        [{ text: "❌ Cancelar", callback_data: TOKENS.cancel }],
      ],
    });
  });
});

describe("prompt-bound callback data", () => {
  const promptToken = "0123456789abcdef";
  const uuid = "12345678-1234-1234-1234-123456789abc";

  it("binds UUID actions within Telegram's 64-byte limit and preserves each action", () => {
    const keyboards = [
      confirmationKeyboard(),
      categoryGridKeyboard([{ id: uuid, name: "Categoria" }]),
      responsibleGridKeyboard([{ userId: uuid, displayName: "Pessoa" }]),
      cardGridKeyboard([{ id: uuid, name: "Cartão" }]),
    ];
    for (const keyboard of keyboards) {
      const bound = bindPromptKeyboard(keyboard, promptToken);
      const originals = keyboard.inline_keyboard.flat();
      bound.inline_keyboard.flat().forEach((button, index) => {
        expect(
          new TextEncoder().encode(button.callback_data).length,
        ).toBeLessThanOrEqual(64);
        expect(parsePromptCallbackData(button.callback_data)).toEqual({
          action: originals[index]!.callback_data,
          promptToken,
        });
        expect(button.text).toBe(originals[index]!.text);
      });
    }
  });

  it("keeps legacy tokens parseable and rejects malformed prompt wrappers", () => {
    expect(parsePromptCallbackData("cf")).toEqual({ action: "cf" });
    expect(parsePromptCallbackData(`ct:${uuid}`)).toEqual({
      action: `ct:${uuid}`,
    });
    for (const data of [
      "p:bad:cf",
      `p:${promptToken}:`,
      `p:${promptToken.toUpperCase()}:cf`,
    ]) {
      expect(parsePromptCallbackData(data)).toBeNull();
    }
  });

  it("rejects invalid identities and oversized payloads before they can be sent", () => {
    expect(() => bindPromptKeyboard(confirmationKeyboard(), "bad")).toThrow(
      "Invalid prompt token",
    );
    expect(() =>
      bindPromptKeyboard(
        {
          inline_keyboard: [[{ text: "Long", callback_data: "x".repeat(46) }]],
        },
        promptToken,
      ),
    ).toThrow("64-byte limit");
    expect(() =>
      bindPromptKeyboard(
        {
          inline_keyboard: [
            [{ text: "Unicode", callback_data: "á".repeat(23) }],
          ],
        },
        promptToken,
      ),
    ).toThrow("64-byte limit");
  });
});
