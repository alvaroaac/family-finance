/**
 * Inline-keyboard builders + callback token constants for the Telegram bot.
 *
 * Pure module (no I/O): the conversation layer decides WHICH keyboard a state
 * gets; this module only knows how each keyboard is shaped. Telegram caps
 * callback_data at 64 BYTES, so tokens carry ids (uuid ≤ 39 bytes with the
 * prefix) and NEVER user-typed names — proposal names live in conversation
 * state instead.
 */

import type { InlineKeyboardButton, InlineKeyboardMarkup } from "./telegram.js";

/** Fixed callback tokens (spec §1's table). */
export const TOKENS = {
  confirm: "cf",
  cancel: "cx",
  categories: "cats",
  newCategory: "nc",
  acceptProposal: "nca",
  dropProposal: "nocat",
  responsible: "resp",
  responsibleHouse: "rs:house",
} as const;

/** `ct:<uuid>` assigns an existing category. */
export const CATEGORY_TOKEN_PREFIX = "ct:";
/** `cs:<index>` selects a persisted ranked suggestion (keeps subcategory). */
export const CATEGORY_SUGGESTION_TOKEN_PREFIX = "cs:";
/** `rs:<uuid>` assigns a responsável (`rs:house` = the house). */
export const RESPONSIBLE_TOKEN_PREFIX = "rs:";
/** `cd:<uuid>` assigns a credit card (card installment flow). */
export const CARD_TOKEN_PREFIX = "cd:";

/** Chunk buttons into rows of two (household-scale grids, no pagination). */
function twoPerRow(buttons: InlineKeyboardButton[]): InlineKeyboardButton[][] {
  const rows: InlineKeyboardButton[][] = [];
  for (let i = 0; i < buttons.length; i += 2) {
    rows.push(buttons.slice(i, i + 2));
  }
  return rows;
}

/**
 * The standard confirmation keyboard. With an AI category proposal pending,
 * the confirm button doubles as "create the category" (token `nca`) and a
 * `nocat` escape hatch drops the proposal.
 */
export function confirmationKeyboard(
  proposedCategoryName?: string,
  categoryCandidates: ReadonlyArray<{
    categoryName: string;
    subcategoryName?: string;
  }> = [],
): InlineKeyboardMarkup {
  if (proposedCategoryName !== undefined) {
    return {
      inline_keyboard: [
        [
          {
            text: `✅ Confirmar (cria "${proposedCategoryName}")`,
            callback_data: TOKENS.acceptProposal,
          },
          { text: "📂 Outra categoria", callback_data: TOKENS.categories },
        ],
        [
          { text: "🚫 Sem categoria", callback_data: TOKENS.dropProposal },
          { text: "❌ Cancelar", callback_data: TOKENS.cancel },
        ],
      ],
    };
  }
  const candidateRows = twoPerRow(
    categoryCandidates.slice(0, 3).map((category, index) => ({
      text: `📂 ${category.categoryName}${category.subcategoryName ? ` › ${category.subcategoryName}` : ""}`,
      callback_data: `${CATEGORY_SUGGESTION_TOKEN_PREFIX}${index}`,
    })),
  );
  return {
    inline_keyboard: [
      ...candidateRows,
      [
        { text: "✅ Confirmar", callback_data: TOKENS.confirm },
        { text: "❌ Cancelar", callback_data: TOKENS.cancel },
      ],
      [
        { text: "📂 Categoria", callback_data: TOKENS.categories },
        { text: "👤 Responsável", callback_data: TOKENS.responsible },
      ],
    ],
  };
}

/**
 * Card-installment confirmation keyboard: same shape as
 * `confirmationKeyboard`, minus the "👤 Responsável" button — the
 * installment flow always attributes to whoever typed the purchase, so
 * there is no responsável state to hand this button to.
 */
export function installmentConfirmationKeyboard(
  proposedCategoryName?: string,
  categoryCandidates: ReadonlyArray<{
    categoryName: string;
    subcategoryName?: string;
  }> = [],
): InlineKeyboardMarkup {
  if (proposedCategoryName !== undefined) {
    return {
      inline_keyboard: [
        [
          {
            text: `✅ Confirmar (cria "${proposedCategoryName}")`,
            callback_data: TOKENS.acceptProposal,
          },
          { text: "📂 Outra categoria", callback_data: TOKENS.categories },
        ],
        [
          { text: "🚫 Sem categoria", callback_data: TOKENS.dropProposal },
          { text: "❌ Cancelar", callback_data: TOKENS.cancel },
        ],
      ],
    };
  }
  const candidateRows = twoPerRow(
    categoryCandidates.slice(0, 3).map((category, index) => ({
      text: `📂 ${category.categoryName}${category.subcategoryName ? ` › ${category.subcategoryName}` : ""}`,
      callback_data: `${CATEGORY_SUGGESTION_TOKEN_PREFIX}${index}`,
    })),
  );
  return {
    inline_keyboard: [
      ...candidateRows,
      [
        { text: "✅ Confirmar", callback_data: TOKENS.confirm },
        { text: "❌ Cancelar", callback_data: TOKENS.cancel },
      ],
      [{ text: "📂 Categoria", callback_data: TOKENS.categories }],
    ],
  };
}

/**
 * Category-pick grid: active categories alphabetically (pt-BR collation),
 * 2 per row, ending with the new-category button. Household scale — tens of
 * categories, far below Telegram's 100-button cap.
 *
 * `includeNewCategory` defaults to true; the installment flow passes `false`
 * because its callback branch has no handler for `nc` — the button would
 * otherwise show but expire the draft with a bogus "Sessão expirada" toast.
 */
export function categoryGridKeyboard(
  categories: ReadonlyArray<{ id: string; name: string }>,
  includeNewCategory = true,
): InlineKeyboardMarkup {
  const sorted = [...categories].sort((a, b) =>
    a.name.localeCompare(b.name, "pt-BR"),
  );
  const rows = twoPerRow(
    sorted.map((c) => ({
      text: c.name,
      callback_data: `${CATEGORY_TOKEN_PREFIX}${c.id}`,
    })),
  );
  if (includeNewCategory) {
    rows.push([
      { text: "➕ Nova categoria", callback_data: TOKENS.newCategory },
    ]);
  }
  return { inline_keyboard: rows };
}

/**
 * Card-pick grid: active cards alphabetically (pt-BR collation), 2 per row —
 * mirrors `categoryGridKeyboard` without the trailing new-category button
 * (cards are managed in the panel, not from the bot).
 */
export function cardGridKeyboard(
  cards: ReadonlyArray<{ id: string; name: string }>,
): InlineKeyboardMarkup {
  const sorted = [...cards].sort((a, b) =>
    a.name.localeCompare(b.name, "pt-BR"),
  );
  return {
    inline_keyboard: twoPerRow(
      sorted.map((c) => ({
        text: c.name,
        callback_data: `${CARD_TOKEN_PREFIX}${c.id}`,
      })),
    ),
  };
}

/** Responsável grid: the house first, then one button per active member. */
export function responsibleGridKeyboard(
  members: ReadonlyArray<{ userId: string; displayName: string }>,
): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [{ text: "🏠 Casa", callback_data: TOKENS.responsibleHouse }],
      ...twoPerRow(
        members.map((m) => ({
          text: m.displayName,
          callback_data: `${RESPONSIBLE_TOKEN_PREFIX}${m.userId}`,
        })),
      ),
    ],
  };
}

/** Single-cancel keyboard for the "type the category name" prompt. */
export function cancelOnlyKeyboard(): InlineKeyboardMarkup {
  return {
    inline_keyboard: [[{ text: "❌ Cancelar", callback_data: TOKENS.cancel }]],
  };
}

/** Shared Confirm/Cancel keyboard for obligation and card-bill confirmations. */
export function confirmCancelKeyboard(): InlineKeyboardMarkup {
  return {
    inline_keyboard: [
      [
        { text: "✅ Confirmar", callback_data: TOKENS.confirm },
        { text: "❌ Cancelar", callback_data: TOKENS.cancel },
      ],
    ],
  };
}

export function obligationConfirmationKeyboard(): InlineKeyboardMarkup {
  return confirmCancelKeyboard();
}
