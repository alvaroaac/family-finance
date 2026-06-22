/**
 * Nubank CSV adapter.
 *
 * Observed shape (account/statement export):
 *   date,title,amount
 *   2026-02-03,Padaria,-25.50
 *
 * Robustness:
 *  - Comma OR semicolon delimiter auto-detected from the header.
 *  - Header columns matched by name; required: date + amount; title optional.
 *  - ISO date and dot-decimal values normalized; signed amount decides
 *    expense (negative) vs income (positive).
 *  - Quoted fields with embedded commas are preserved by the shared CSV parser.
 *  - Unmappable rows become reviewable errors; the rest still import.
 */

import {
  parseCsv,
  parseBrlToCents,
  normalizeDate,
  normalizeDescription,
  moneyFromSignedCents,
} from "./normalize.js";
import type {
  ImportAdapter,
  AdapterResult,
  NormalizedImportRow,
  ImportRowError,
} from "./types.js";

function fold(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase();
}

function detectDelimiter(headerLine: string): string {
  const commas = (headerLine.match(/,/g) ?? []).length;
  const semis = (headerLine.match(/;/g) ?? []).length;
  return commas >= semis ? "," : ";";
}

type ColumnMap = {
  date: number;
  description: number;
  value: number;
};

function mapColumns(header: string[]): ColumnMap | null {
  const folded = header.map(fold);
  const find = (...names: string[]): number =>
    folded.findIndex((h) => names.includes(h));

  const date = find("date", "data");
  const value = find("amount", "valor", "value");
  const description = find("title", "description", "descricao", "historico", "nome");

  if (date === -1 || value === -1) {
    return null;
  }
  return { date, value, description };
}

async function parse(fileText: string): Promise<AdapterResult> {
  const firstLine = fileText.split(/\r?\n/, 1)[0] ?? "";
  const delimiter = detectDelimiter(firstLine);
  const matrix = parseCsv(fileText, delimiter);

  const rows: NormalizedImportRow[] = [];
  const errors: ImportRowError[] = [];

  if (matrix.length === 0) {
    return { source: "nubank", rows, errors };
  }

  const header = matrix[0] as string[];
  const columns = mapColumns(header);
  if (columns === null) {
    return {
      source: "nubank",
      rows,
      errors: [
        {
          sourceLine: 1,
          message:
            "Cabeçalho Nubank não reconhecido: faltam colunas de data e/ou valor.",
        },
      ],
    };
  }

  for (let i = 1; i < matrix.length; i += 1) {
    const cells = matrix[i] as string[];
    const sourceLine = i + 1;

    const rawDate = cells[columns.date] ?? "";
    const rawValue = cells[columns.value] ?? "";
    const rawDescription =
      columns.description >= 0 ? (cells[columns.description] ?? "") : "";

    const occurredOn = normalizeDate(rawDate);
    if (occurredOn === null) {
      errors.push({
        sourceLine,
        message: `Data inválida ou ausente na linha ${sourceLine}.`,
      });
      continue;
    }

    const signedCents = parseBrlToCents(rawValue);
    if (signedCents === null) {
      errors.push({
        sourceLine,
        message: `Valor inválido ou ausente na linha ${sourceLine}.`,
      });
      continue;
    }

    const money = moneyFromSignedCents(signedCents);
    if (money === null) {
      errors.push({
        sourceLine,
        message: `Valor zero não pode ser importado (linha ${sourceLine}).`,
      });
      continue;
    }

    const description = normalizeDescription(rawDescription);
    rows.push({
      sourceLine,
      occurredOn,
      description: description.length > 0 ? description : "(sem descrição)",
      amount: money.amount,
      kind: money.kind,
    });
  }

  return { source: "nubank", rows, errors };
}

export const nubankCsvAdapter: ImportAdapter = {
  source: "nubank",
  parse,
};
