/**
 * Deterministic Portuguese expense-text parser for the Telegram bot.
 *
 * Extracts the rough fields of an expense from a free-text message like
 * "Uber 32 reais ontem" or "Mercado R$ 32,50 no cartão". It is intentionally
 * conservative: it only reports what it can extract deterministically and flags
 * the rest in `uncertainFields`. The conversation layer then asks the user to
 * confirm/correct, and (Task 8) AI fallback handles what this cannot.
 *
 * This module is PURE: no I/O, no network, no domain/db imports. It returns
 * BRL integer cents (the money contract) and ISO dates (YYYY-MM-DD).
 */

/** Fields the parser was unsure about (defaulted or missing). */
export type UncertainField = "amount" | "date" | "category";

export type ParsedExpense = {
  /** BRL integer cents, when a value could be extracted. */
  amountCents?: number;
  /** Cleaned merchant/description text (value/date tokens stripped). */
  description: string;
  /** ISO date the expense occurred on (YYYY-MM-DD). Defaults to today. */
  occurredOn?: string;
  /** True when the text mentions paying with a credit card. */
  cardHint?: boolean;
  /** True when the text mentions paying from an account (débito/conta/pix). */
  accountHint?: boolean;
  /** Which fields were defaulted/uncertain and may need confirmation. */
  uncertainFields: UncertainField[];
};

export type ParseOptions = {
  /** ISO date (YYYY-MM-DD) used to resolve "hoje"/"ontem" and default dates. */
  today: string;
};

const ACCENTS: Record<string, string> = {
  á: "a", à: "a", ã: "a", â: "a", ä: "a",
  é: "e", ê: "e", è: "e", ë: "e",
  í: "i", ì: "i", î: "i", ï: "i",
  ó: "o", ô: "o", õ: "o", ò: "o", ö: "o",
  ú: "u", ù: "u", û: "u", ü: "u",
  ç: "c",
};

function foldAccents(value: string): string {
  return value.replace(/[áàãâäéêèëíìîïóôõòöúùûüç]/g, (ch) => ACCENTS[ch] ?? ch);
}

/** Shift an ISO date by a number of days (UTC, no time component). Pure. */
function shiftIsoDate(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map((p) => Number.parseInt(p, 10));
  const date = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1));
  date.setUTCDate(date.getUTCDate() + days);
  const yy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(date.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

/**
 * Extract a BRL value (in cents) from text.
 *
 * Handles "32", "32 reais", "R$ 32,50", "R$ 1.234,56" and dot-decimal "32.50".
 * Returns the cents and the substring matched so the caller can strip it from
 * the description.
 */
function extractAmount(
  text: string,
): { cents: number; matched: string } | null {
  // Prefer an explicit money token: optional R$, then a number with BR or dot
  // decimals. We pick the first money-looking token.
  const moneyRe =
    /(r\$\s*)?(\d{1,3}(?:\.\d{3})+,\d{2}|\d+,\d{2}|\d+\.\d{2}|\d+)(\s*(reais|real))?/i;
  const match = moneyRe.exec(text);
  if (match === null) {
    return null;
  }
  // Require some money signal: an R$ prefix, a "reais"/"real" suffix, or a
  // decimal part. A bare integer with no signal is still accepted (e.g. "32"),
  // but we avoid matching a date like "12/03" because slashes are excluded.
  const numberToken = match[2] as string;
  let cents: number;
  if (numberToken.includes(",")) {
    // BR format: thousands "." removed, decimal ",".
    const normalized = numberToken.replace(/\./g, "").replace(",", ".");
    cents = Math.round(Number.parseFloat(normalized) * 100);
  } else if (/^\d+\.\d{2}$/.test(numberToken)) {
    // Dot-decimal "32.50".
    cents = Math.round(Number.parseFloat(numberToken) * 100);
  } else {
    // Plain integer reais.
    cents = Number.parseInt(numberToken, 10) * 100;
  }
  if (!Number.isFinite(cents) || cents <= 0) {
    return null;
  }
  return { cents, matched: match[0] };
}

/**
 * Extract a date from text.
 *
 * Recognizes "hoje", "ontem", "anteontem", and "DD/MM" or "DD/MM/YYYY".
 * Returns the ISO date and the matched substring (to strip from description).
 * When nothing is found, returns null and the caller defaults to today.
 */
function extractDate(
  text: string,
  today: string,
): { iso: string; matched: string } | null {
  const folded = foldAccents(text.toLowerCase());

  // Explicit numeric date DD/MM or DD/MM/YYYY.
  const numericRe = /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/;
  const numericMatch = numericRe.exec(text);
  if (numericMatch !== null) {
    const day = Number.parseInt(numericMatch[1] as string, 10);
    const month = Number.parseInt(numericMatch[2] as string, 10);
    let year: number;
    if (numericMatch[3] !== undefined) {
      const raw = Number.parseInt(numericMatch[3], 10);
      year = raw < 100 ? 2000 + raw : raw;
    } else {
      year = Number.parseInt(today.slice(0, 4), 10);
    }
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      const iso = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      return { iso, matched: numericMatch[0] };
    }
  }

  // Relative words.
  const relWord = /\b(anteontem|ontem|hoje)\b/.exec(folded);
  if (relWord !== null) {
    const word = relWord[1] as string;
    const iso =
      word === "hoje"
        ? today
        : word === "ontem"
          ? shiftIsoDate(today, -1)
          : shiftIsoDate(today, -2);
    // Match against the ORIGINAL text region (same indices since folding keeps length).
    return { iso, matched: text.slice(relWord.index, relWord.index + word.length) };
  }

  return null;
}

const CARD_WORDS = /\b(cartao|cartão|credito|crédito|fatura)\b/i;
const ACCOUNT_WORDS = /\b(debito|débito|conta|pix|dinheiro|corrente)\b/i;

const EDGE_PUNCTUATION_RE =
  /^[\s.,;:!?…"'`´“”‘’()[\]{}\-–—]+|[\s.,;:!?…"'`´“”‘’()[\]{}\-–—]+$/g;

/**
 * Strip leading/trailing punctuation from a description ("Tabacaria," ->
 * "Tabacaria"). Shared final normalization for BOTH description sources:
 * the deterministic parser below and the LLM interpreter (conversation.ts).
 */
export function stripEdgePunctuation(value: string): string {
  return value.replace(EDGE_PUNCTUATION_RE, "");
}

/**
 * Parse a Portuguese expense message into a rough draft.
 *
 * Conservative by design: extracts value, date, card/account hints and a
 * cleaned description, and records which fields had to be defaulted/guessed in
 * `uncertainFields` so the confirmation step can ask about them.
 */
export function parseExpenseText(
  text: string,
  options: ParseOptions,
): ParsedExpense {
  const uncertainFields: UncertainField[] = [];
  let remaining = ` ${text} `;

  // Date first (so a "12/03" is not mistaken for a value).
  const date = extractDate(remaining, options.today);
  let occurredOn: string;
  if (date !== null) {
    occurredOn = date.iso;
    remaining = remaining.replace(date.matched, " ");
  } else {
    occurredOn = options.today;
    uncertainFields.push("date");
  }

  // Value.
  const amount = extractAmount(remaining);
  let amountCents: number | undefined;
  if (amount !== null) {
    amountCents = amount.cents;
    remaining = remaining.replace(amount.matched, " ");
  } else {
    uncertainFields.push("amount");
  }

  // Payment hints.
  const cardHint = CARD_WORDS.test(text);
  const accountHint = !cardHint && ACCOUNT_WORDS.test(text);

  // Description: strip payment-hint words and collapse whitespace.
  const description = stripEdgePunctuation(
    remaining
      .replace(/\b(no|na|de|do|da|em|com|pelo|pela)\b/gi, " ")
      .replace(CARD_WORDS, " ")
      .replace(ACCOUNT_WORDS, " ")
      .replace(/r\$/gi, " ")
      .replace(/\b(reais|real)\b/gi, " ")
      .replace(/\s+/g, " ")
      .trim(),
  );

  // We never auto-assign a category here; the categorization engine does that.
  uncertainFields.push("category");

  return {
    amountCents,
    description,
    occurredOn,
    cardHint: cardHint || undefined,
    accountHint: accountHint || undefined,
    uncertainFields,
  };
}
