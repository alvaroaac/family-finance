import { describe, it, expect } from "vitest";

import {
  TOKENS,
  CATEGORY_TOKEN_PREFIX,
  CARD_TOKEN_PREFIX,
  confirmationKeyboard,
  installmentConfirmationKeyboard,
  categoryGridKeyboard,
  responsibleGridKeyboard,
  cancelOnlyKeyboard,
  cardGridKeyboard,
} from "./keyboards.js";

describe("confirmationKeyboard", () => {
  it("without a proposal: confirm/cancel + category/responsável rows", () => {
    expect(confirmationKeyboard()).toEqual({
      inline_keyboard: [
        [
          { text: "✅ Confirmar", callback_data: "cf" },
          { text: "❌ Cancelar", callback_data: "cx" },
        ],
        [
          { text: "📂 Categoria", callback_data: "cats" },
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
        [{ text: "📂 Categoria", callback_data: "cats" }],
      ],
    });
    const flat = keyboard.inline_keyboard.flat();
    expect(flat.some((b) => b.callback_data === TOKENS.responsible)).toBe(false);
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
    expect(flat.some((b) => b.callback_data === TOKENS.responsible)).toBe(false);
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
      { id: "11111111-2222-3333-4444-555555555555", name: "Nome enorme de categoria" },
    ]);
    for (const row of grid.inline_keyboard) {
      for (const button of row) {
        expect(Buffer.byteLength(button.callback_data, "utf8")).toBeLessThanOrEqual(64);
      }
    }
    expect(grid.inline_keyboard[0]?.[0]?.callback_data).toBe(
      `${CATEGORY_TOKEN_PREFIX}11111111-2222-3333-4444-555555555555`,
    );
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
      { id: "11111111-2222-3333-4444-555555555555", name: "Nome enorme de cartão" },
    ]);
    for (const row of grid.inline_keyboard) {
      for (const button of row) {
        expect(Buffer.byteLength(button.callback_data, "utf8")).toBeLessThanOrEqual(64);
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
      inline_keyboard: [[{ text: "❌ Cancelar", callback_data: TOKENS.cancel }]],
    });
  });
});
