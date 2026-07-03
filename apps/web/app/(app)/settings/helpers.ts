/**
 * PURE helpers for "Configurações" — no server-only imports, so both the
 * client widgets (settings-forms.tsx) and the server side (page, actions,
 * root layout) can share them. Mirrors the transactions/filters.ts pattern.
 */

// ---------------------------------------------------------------------------
// Themes
// ---------------------------------------------------------------------------

export type ThemeId = "esmeralda" | "salvia";

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

// ---------------------------------------------------------------------------
// Member form parsing
// ---------------------------------------------------------------------------

export type MemberPatch = {
  displayName: string | null;
  telegramUserId: number | null;
  telegramUsername: string | null;
};

/**
 * Parse the member profile form into a repo patch. Blank fields become null
 * (clear the name / unlink Telegram). The single Telegram field accepts a
 * numeric user id OR an @username ("@karol" / "karol"): digits go to
 * `telegramUserId`, anything else to `telegramUsername` (lowercased, "@"
 * stripped). Throws a pt-BR message the action surfaces as-is.
 */
export function memberPatchFromFormData(formData: FormData): MemberPatch {
  const rawName = formData.get("displayName");
  const name = typeof rawName === "string" ? rawName.trim() : "";

  const rawTelegram = formData.get("telegram");
  const telegramText = typeof rawTelegram === "string" ? rawTelegram.trim() : "";

  let telegramUserId: number | null = null;
  let telegramUsername: string | null = null;
  if (telegramText !== "") {
    if (/^\d+$/.test(telegramText)) {
      const parsed = Number.parseInt(telegramText, 10);
      if (!Number.isSafeInteger(parsed) || parsed <= 0) {
        throw new Error(
          "O ID do Telegram precisa ser um número inteiro positivo.",
        );
      }
      telegramUserId = parsed;
    } else {
      const username = telegramText.replace(/^@/, "").toLowerCase();
      if (!/^[a-z0-9_]{5,32}$/.test(username)) {
        throw new Error(
          "Telegram inválido — use o @username (5-32 letras/números/_) ou o ID numérico.",
        );
      }
      telegramUsername = username;
    }
  }

  return {
    displayName: name === "" ? null : name,
    telegramUserId,
    telegramUsername,
  };
}

/** How the settings form displays a member's linked Telegram. Pure. */
export function telegramDisplayValue(member: {
  telegramUserId: number | null;
  telegramUsername: string | null;
}): string {
  if (member.telegramUsername !== null) {
    return `@${member.telegramUsername}`;
  }
  if (member.telegramUserId !== null) {
    return String(member.telegramUserId);
  }
  return "";
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
