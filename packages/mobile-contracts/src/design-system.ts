export type ThemeId = "esmeralda" | "salvia";
export type Tokens = {
  bg: string;
  surface: string;
  soft: string;
  ink: string;
  muted: string;
  accent: string;
  onAccent: string;
  border: string;
  positive: string;
  negative: string;
  tint: string;
  radius: number;
  cardPadding: number;
  controlHeight: number;
  typeScale: number;
  body: string;
  display: string;
};
export const themes: Record<ThemeId, Tokens> = {
  esmeralda: {
    bg: "#16352b",
    surface: "#1e4133",
    soft: "#1a3a2e",
    ink: "#f2ede0",
    muted: "#b2beb0",
    accent: "#d4af6a",
    onAccent: "#16352b",
    border: "#45604a",
    positive: "#93c7a1",
    negative: "#e8a07d",
    tint: "#344c35",
    radius: 20,
    cardPadding: 20,
    controlHeight: 54,
    typeScale: 1,
    body: "Inter_400Regular",
    display: "PlayfairDisplay_500Medium",
  },
  salvia: {
    bg: "#e8ede3",
    surface: "#f7f9f3",
    soft: "#eff3ea",
    ink: "#2e3a2a",
    muted: "#5f6b58",
    accent: "#a8853c",
    onAccent: "#ffffff",
    border: "#cbd6c0",
    positive: "#3e7d52",
    negative: "#b4552f",
    tint: "#e9e5d4",
    radius: 20,
    cardPadding: 20,
    controlHeight: 54,
    typeScale: 1,
    body: "Inter_400Regular",
    display: "PlayfairDisplay_500Medium",
  },
};
export type DesignSystem = {
  version: 1;
  tenantId: string;
  theme: ThemeId;
  tokens: Tokens;
};
export interface DesignSystemSource {
  load(theme: ThemeId, signal: AbortSignal): Promise<DesignSystem>;
}
export const demoDesignSystem: DesignSystemSource = {
  async load(theme) {
    return { version: 1, tenantId: "casa-demo", theme, tokens: themes[theme] };
  },
};
/** API contract for future authenticated integration. Tenant is resolved by the server from the session. */
export function apiDesignSystem(
  baseUrl: string,
  getAccessToken: () => Promise<string>,
): DesignSystemSource {
  return {
    async load(theme, signal) {
      const response = await fetch(
        `${baseUrl}/api/mobile/v1/design-system?theme=${theme}`,
        {
          signal,
          headers: { Authorization: `Bearer ${await getAccessToken()}` },
        },
      );
      if (!response.ok) throw new Error("Theme unavailable");
      return validateDesignSystem(await response.json(), theme);
    },
  };
}
export function validateDesignSystem(
  input: unknown,
  theme: ThemeId,
): DesignSystem {
  const d = input as DesignSystem;
  if (
    !d ||
    d.version !== 1 ||
    typeof d.tenantId !== "string" ||
    !d.tenantId ||
    d.theme !== theme ||
    !d.tokens
  )
    throw new Error("Invalid design system");
  const colorKeys = [
    "bg",
    "surface",
    "soft",
    "ink",
    "muted",
    "accent",
    "onAccent",
    "border",
    "positive",
    "negative",
    "tint",
  ] as const;
  for (const key of colorKeys)
    if (
      typeof d.tokens[key] !== "string" ||
      !/^#[0-9a-f]{6}$/i.test(d.tokens[key])
    )
      throw new Error("Invalid color token");
  if (
    !Number.isFinite(d.tokens.radius) ||
    d.tokens.radius < 0 ||
    d.tokens.radius > 32
  )
    throw new Error("Invalid radius");
  for (const [key, min, max] of [
    ["cardPadding", 12, 32],
    ["controlHeight", 44, 64],
    ["typeScale", 0.9, 1.3],
  ] as const) {
    if (
      !Number.isFinite(d.tokens[key]) ||
      d.tokens[key] < min ||
      d.tokens[key] > max
    )
      throw new Error("Invalid layout token");
  }
  // API selects bundled fonts only, never arbitrary executable style/config.
  return {
    ...d,
    tokens: {
      ...d.tokens,
      body: themes[theme].body,
      display: themes[theme].display,
    },
  };
}
