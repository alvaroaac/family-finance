import { describe, expect, it } from "vitest";

import { THEME_TOKENS, parseHouseholdTheme, themeStyle } from "./theme.js";

const FALLBACK = { theme: { base: "esmeralda" }, valid: false };

describe("parseHouseholdTheme", () => {
  it("accepts the default document", () => {
    expect(parseHouseholdTheme({ base: "esmeralda" })).toEqual({
      theme: { base: "esmeralda" },
      valid: true,
    });
  });

  it("accepts a locked base with #rgb and #rrggbb overrides", () => {
    const document = {
      base: "salvia",
      lockBase: true,
      overrides: { "--ff-accent": "#2f6fed", "--ff-on-accent": "#FFF" },
    };
    expect(parseHouseholdTheme(document)).toEqual({
      theme: document,
      valid: true,
    });
  });

  it("accepts every overridable token", () => {
    const overrides = Object.fromEntries(
      THEME_TOKENS.map((token) => [token, "#123456"]),
    );
    expect(parseHouseholdTheme({ base: "esmeralda", overrides }).valid).toBe(
      true,
    );
    expect(THEME_TOKENS).toEqual([
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
    ]);
  });

  it.each([
    "url(https://evil.test/x.png)",
    "var(--ff-bg)",
    "#fff;background:red",
    "#fff; }",
    "red",
    "#ffff",
    "#12345",
    "#1234567",
    "#ggg",
    "fff",
    " #fff",
    "#fff ",
    "#fff\n",
    "rgba(0,0,0,0.5)",
  ])("rejects the override value %j", (value) => {
    expect(
      parseHouseholdTheme({
        base: "esmeralda",
        overrides: { "--ff-accent": value },
      }),
    ).toEqual(FALLBACK);
  });

  it("rejects a non-string override value", () => {
    expect(
      parseHouseholdTheme({ base: "salvia", overrides: { "--ff-accent": 1 } }),
    ).toEqual(FALLBACK);
  });

  it.each([
    "--ff-positive",
    "--ff-negative",
    "--ff-radius-md",
    "color",
    "--ff-shadow-card",
  ])("rejects the unknown token %s", (token) => {
    expect(
      parseHouseholdTheme({ base: "salvia", overrides: { [token]: "#fff" } }),
    ).toEqual(FALLBACK);
  });

  it.each([
    null,
    undefined,
    "esmeralda",
    [],
    {},
    { base: "roxo" },
    { base: "salvia", lockBase: "yes" },
    { base: "salvia", overrides: [] },
    { base: "salvia", extra: true },
  ])("rejects the malformed document %j", (value) => {
    expect(parseHouseholdTheme(value)).toEqual(FALLBACK);
  });
});

describe("themeStyle", () => {
  it("maps override tokens to their values", () => {
    expect(
      themeStyle({
        base: "salvia",
        lockBase: true,
        overrides: { "--ff-accent": "#2f6fed", "--ff-accent-hover": "#1f57c8" },
      }),
    ).toEqual({ "--ff-accent": "#2f6fed", "--ff-accent-hover": "#1f57c8" });
  });

  it("is empty without overrides", () => {
    expect(themeStyle({ base: "esmeralda" })).toEqual({});
    expect(themeStyle({ base: "esmeralda", overrides: {} })).toEqual({});
  });
});
