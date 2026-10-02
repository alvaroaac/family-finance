import type { HouseholdTheme } from "@family-finance/domain";

/**
 * PURE helpers for "Configurações" — no server-only imports, so both the
 * client widgets (settings-forms.tsx) and the server side (page, actions,
 * root layout) can share them. Mirrors the transactions/filters.ts pattern.
 */

// ---------------------------------------------------------------------------
// Themes
// ---------------------------------------------------------------------------

export type ThemeId = HouseholdTheme["base"];

/** The two household skins; Esmeralda (dark) is the default. */
export const THEMES: ReadonlyArray<{
  id: ThemeId;
  label: string;
  /** Swatch colors for the picker button (bg + accent). */
  swatch: { background: string; accent: string };
}> = [
  {
    id: "esmeralda",
    label: "Esmeralda",
    swatch: { background: "#16352B", accent: "#D4AF6A" },
  },
  {
    id: "salvia",
    label: "Sálvia",
    swatch: { background: "#E8EDE3", accent: "#A8853C" },
  },
];

export const THEME_COOKIE = "ff-theme";
export const DEFAULT_THEME: ThemeId = "esmeralda";

/** Narrow an arbitrary cookie value to a known theme (default Esmeralda). */
export function parseTheme(value: string | undefined): ThemeId {
  return value === "salvia" ? "salvia" : DEFAULT_THEME;
}

/**
 * The base theme a member sees: the household's `base` when it is locked,
 * otherwise the `ff-theme` cookie, falling back to the household's `base`.
 */
export function resolveBaseTheme(
  theme: HouseholdTheme,
  cookieValue: string | undefined,
): ThemeId {
  if (theme.lockBase === true) {
    return theme.base;
  }
  return cookieValue === "esmeralda" || cookieValue === "salvia"
    ? cookieValue
    : theme.base;
}

// ---------------------------------------------------------------------------
// Member form parsing
// ---------------------------------------------------------------------------

export type MemberPatch = {
  displayName: string | null;
};

/** Parse the display name; a blank field clears it. */
export function memberPatchFromFormData(formData: FormData): MemberPatch {
  const rawName = formData.get("displayName");
  const name = typeof rawName === "string" ? rawName.trim() : "";
  return { displayName: name === "" ? null : name };
}

// ---------------------------------------------------------------------------
// Bot heartbeat copy
// ---------------------------------------------------------------------------

export type LastBotInteraction = {
  created_at: string;
  input_kind: string;
  transaction_id: string | null;
};

const BOT_TIMESTAMP_FORMAT = new Intl.DateTimeFormat("pt-BR", {
  timeZone: "America/Sao_Paulo",
  day: "2-digit",
  month: "2-digit",
  year: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

/** Warm pt-BR one-liner answering "o bot tá vivo?". Pure. */
export function botStatusLabel(last: LastBotInteraction | null): string {
  if (last === null) {
    return "O bot ainda não registrou nada por aqui";
  }
  const when = BOT_TIMESTAMP_FORMAT.format(new Date(last.created_at));
  return `Último lançamento pelo bot: ${when} 🎙️`;
}

/** Friendly pt-BR label for the interaction kind chip. Pure. */
export function inputKindLabel(kind: string): string {
  switch (kind) {
    case "audio":
      return "áudio";
    case "text":
      return "texto";
    default:
      return kind;
  }
}
