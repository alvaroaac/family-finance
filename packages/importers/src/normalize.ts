/**
 * Pure normalization helpers shared by every source adapter: a small hand-rolled
 * CSV parser (no dependency), value/date parsing, and description cleanup.
 *
 * Formats are simple (single-line records, optional double-quoting), so a tiny
 * state machine is enough and keeps the package dependency-free.
 */

import { brl, type MoneyAmount } from "@family-finance/domain";
import type { ImportRowKind } from "./types.js";

/**
 * Parse delimited text into a matrix of string cells.
 *
 * Supports:
 *  - a configurable single-char delimiter (`,` or `;`),
 *  - double-quoted fields that may contain the delimiter or newlines,
 *  - escaped quotes inside quoted fields (`""`),
 *  - `\r\n` and `\n` line endings,
 *  - skipping fully blank lines.
 *
 * Pure: no I/O. The input text is transient; nothing is retained.
 */
export function parseCsv(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  let fieldStarted = false;

  const pushField = (): void => {
    row.push(field);
    field = "";
    fieldStarted = false;
  };

  const pushRow = (): void => {
    pushField();
    // Skip rows that are entirely empty (e.g. trailing newline / blank lines).
    const isBlank = row.length === 1 && row[0] === "";
    if (!isBlank) {
      rows.push(row);
    }
    row = [];
  };

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i] as string;

    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1; // consume the escaped quote
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"' && !fieldStarted) {
      inQuotes = true;
      fieldStarted = true;
      continue;
    }
    if (char === delimiter) {
      pushField();
      continue;
    }
    if (char === "\n") {
      pushRow();
      continue;
    }
    if (char === "\r") {
      // Swallow CR; the following LF (if any) triggers the row push.
      continue;
    }
    field += char;
    fieldStarted = true;
  }

  // Flush a trailing record with no final newline.
  if (field.length > 0 || row.length > 0) {
    pushRow();
  }

  return rows;
}

/**
 * Parse a monetary string into signed integer BRL cents.
 *
 * Handles both Brazilian (`3.000,00`, `-150,90`) and dot-decimal (`-25.50`,
 * `30.00`) formats by detecting which separator is the decimal one. Returns
 * `null` when the value is empty or not a number, so callers can turn it into a
 * reviewable error rather than guessing a wrong amount.
 */
export function parseBrlToCents(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return null;
  }

  // Keep sign, digits, and separators only (strip "R$", spaces, NBSP, etc).
  const cleaned = trimmed.replace(/[^0-9,.\-]/g, "");
  if (cleaned.length === 0 || !/\d/.test(cleaned)) {
    return null;
  }

  const negative = cleaned.startsWith("-");
  let body = cleaned.replace(/-/g, "");

  const lastComma = body.lastIndexOf(",");
  const lastDot = body.lastIndexOf(".");

  let decimalSep: "," | "." | null = null;
  if (lastComma !== -1 && lastDot !== -1) {
    // The right-most separator is the decimal one.
    decimalSep = lastComma > lastDot ? "," : ".";
  } else if (lastComma !== -1) {
    decimalSep = ",";
  } else if (lastDot !== -1) {
    // A lone dot could be a thousands separator (e.g. "3.000"); treat it as a
    // decimal point only when it leaves at most two trailing digits.
    const after = body.length - lastDot - 1;
    decimalSep = after <= 2 ? "." : null;
  }

  let intPart: string;
  let fracPart: string;
  if (decimalSep === null) {
    intPart = body.replace(/[.,]/g, "");
    fracPart = "";
  } else {
    const groupSep = decimalSep === "," ? "." : ",";
    body = body.split(groupSep).join("");
    const idx = body.lastIndexOf(decimalSep);
    intPart = body.slice(0, idx);
    fracPart = body.slice(idx + 1);
  }

  intPart = intPart.replace(/[.,]/g, "");
  fracPart = (fracPart + "00").slice(0, 2);

  const intDigits = intPart === "" ? "0" : intPart;
  if (!/^\d+$/.test(intDigits) || !/^\d{0,2}$/.test(fracPart)) {
    return null;
  }

  const cents = Number.parseInt(intDigits, 10) * 100 + Number.parseInt(fracPart || "0", 10);
  if (!Number.isFinite(cents)) {
    return null;
  }
  return negative ? -cents : cents;
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const BR_DATE = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;

function isRealDate(year: number, month: number, day: number): boolean {
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

/**
 * Normalize a date string to ISO `YYYY-MM-DD`, accepting ISO input and
 * Brazilian `DD/MM/YYYY`. Returns `null` for anything unparseable so the row
 * becomes a reviewable error.
 */
export function normalizeDate(raw: string): string | null {
  const trimmed = raw.trim();

  const iso = ISO_DATE.exec(trimmed);
  if (iso) {
    const year = Number.parseInt(iso[1] as string, 10);
    const month = Number.parseInt(iso[2] as string, 10);
    const day = Number.parseInt(iso[3] as string, 10);
    return isRealDate(year, month, day)
      ? `${iso[1]}-${iso[2]}-${iso[3]}`
      : null;
  }

  const br = BR_DATE.exec(trimmed);
  if (br) {
    const day = Number.parseInt(br[1] as string, 10);
    const month = Number.parseInt(br[2] as string, 10);
    const year = Number.parseInt(br[3] as string, 10);
    if (!isRealDate(year, month, day)) {
      return null;
    }
    const mm = String(month).padStart(2, "0");
    const dd = String(day).padStart(2, "0");
    return `${year}-${mm}-${dd}`;
  }

  return null;
}

/** Collapse internal whitespace and trim. Empty -> empty string. */
export function normalizeDescription(raw: string): string {
  return raw.replace(/\s+/g, " ").trim();
}

/**
 * Build a normalized money amount + kind from a signed cents value. The stored
 * `amount.cents` is the positive magnitude; the sign becomes the `kind`.
 *
 * `signedCents` of 0 is rejected (returns null) — a zero-value row is treated as
 * unparseable since it cannot become a valid transaction.
 */
export function moneyFromSignedCents(
  signedCents: number,
): { amount: MoneyAmount; kind: ImportRowKind } | null {
  if (!Number.isInteger(signedCents) || signedCents === 0) {
    return null;
  }
  const kind: ImportRowKind = signedCents < 0 ? "expense" : "income";
  return { amount: brl(Math.abs(signedCents)), kind };
}
