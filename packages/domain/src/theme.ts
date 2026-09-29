import { z } from "zod";

/**
 * Household theme document (`households.theme`): one of the two base themes
 * plus optional color overrides for a closed list of tokens. Members can write
 * this column, so every value is validated before it reaches a style.
 */

export const THEME_TOKENS = [
  "--ff-bg",
  "--ff-surface",
  "--ff-surface-soft",
  "--ff-tint",
  "--ff-ink",
  "--ff-ink-soft",
  "--ff-accent",
  "--ff-accent-hover",
  "--ff-border",
  "--ff-on-accent",
] as const;

export type ThemeToken = (typeof THEME_TOKENS)[number];

export type HouseholdTheme = {
  base: "esmeralda" | "salvia";
  lockBase?: boolean;
  overrides?: Partial<Record<ThemeToken, string>>;
};

const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

const householdThemeSchema = z
  .object({
    base: z.enum(["esmeralda", "salvia"]),
    lockBase: z.boolean().optional(),
    overrides: z
      .record(z.enum(THEME_TOKENS), z.string().regex(HEX_COLOR))
      .optional(),
  })
  .strict();

/**
 * Validate a stored theme document. Anything but `#rgb`/`#rrggbb` values on
 * known tokens invalidates the whole document, which falls back to Esmeralda.
 */
export function parseHouseholdTheme(value: unknown): {
  theme: HouseholdTheme;
  valid: boolean;
} {
  const parsed = householdThemeSchema.safeParse(value);
  return parsed.success
    ? { theme: parsed.data, valid: true }
    : { theme: { base: "esmeralda" }, valid: false };
}

/** Inline CSS custom properties for the theme's overrides. */
export function themeStyle(theme: HouseholdTheme): Record<string, string> {
  const style: Record<string, string> = {};
  for (const token of THEME_TOKENS) {
    const value = theme.overrides?.[token];
    if (value !== undefined) {
      style[token] = value;
    }
  }
  return style;
}
