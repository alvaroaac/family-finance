/**
 * Minhas Financas CSV adapter (implemented FIRST per the plan).
 *
 * Handles the app's CSV export / custom-model layout. Observed shape:
 *   Data;Descrição;Categoria;Valor;Tipo
 *   15/01/2026;Mercado;Alimentação;-150,90;Despesa
 *
 * Robustness:
 *  - Semicolon OR comma delimiter is auto-detected from the header.
 *  - Header columns are matched by name (accent-insensitive), so column order
 *    can vary. Required: a date column, a value column. Description/Tipo optional.
 *  - Brazilian date (DD/MM/YYYY) and decimal comma are normalized.
 *  - The sign of `Valor` decides expense vs income; an explicit `Tipo` column
 *    (Receita/Despesa/Entrada/Saída) overrides when the value is unsigned.
 *  - Any row that cannot be mapped becomes a reviewable error; the rest import.
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

/** Strip accents + lowercase for header matching. */
function fold(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase();
}

function detectDelimiter(headerLine: string): string {
  const semis = (headerLine.match(/;/g) ?? []).length;
  const commas = (headerLine.match(/,/g) ?? []).length;
  return semis >= commas ? ";" : ",";
}

type ColumnMap = {
  date: number;
  description: number;
  value: number;
  type: number;
  category: number;
};

function mapColumns(header: string[]): ColumnMap | null {
  const folded = header.map(fold);
  const find = (...names: string[]): number =>
    folded.findIndex((h) => names.includes(h));

  const date = find("data", "date", "data lancamento", "data da transacao");
  const value = find("valor", "value", "amount", "quantia");
  const description = find("descricao", "description", "title", "historico", "nome");
  const type = find("tipo", "type", "natureza");
  const category = find("categoria", "category");

  if (date === -1 || value === -1) {
    return null;
  }
  return { date, value, description, type, category };
}

/** Resolve income/expense from an explicit type cell when present. */
function kindFromTypeCell(raw: string): "expense" | "income" | null {
  const folded = fold(raw);
  if (folded === "") {
    return null;
  }
  if (["receita", "entrada", "credito", "income", "credit"].includes(folded)) {
    return "income";
  }
  if (["despesa", "saida", "debito", "expense", "debit"].includes(folded)) {
    return "expense";
  }
  return null;
}

async function parse(fileText: string): Promise<AdapterResult> {
  const firstLine = fileText.split(/\r?\n/, 1)[0] ?? "";
  const delimiter = detectDelimiter(firstLine);
  const matrix = parseCsv(fileText, delimiter);

  const rows: NormalizedImportRow[] = [];
  const errors: ImportRowError[] = [];

  if (matrix.length === 0) {
    return { source: "minhas-financas", rows, errors };
  }

  const header = matrix[0] as string[];
  const columns = mapColumns(header);
  if (columns === null) {
    return {
      source: "minhas-financas",
      rows,
      errors: [
        {
          sourceLine: 1,
          message:
            "Cabeçalho não reconhecido: faltam colunas de data e/ou valor.",
        },
      ],
    };
  }

  for (let i = 1; i < matrix.length; i += 1) {
    const cells = matrix[i] as string[];
    const sourceLine = i + 1; // header is line 1

    const rawDate = cells[columns.date] ?? "";
    const rawValue = cells[columns.value] ?? "";
    const rawDescription =
      columns.description >= 0 ? (cells[columns.description] ?? "") : "";
    const rawType = columns.type >= 0 ? (cells[columns.type] ?? "") : "";
    const rawCategory =
      columns.category >= 0 ? (cells[columns.category] ?? "") : "";

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

    // An explicit type cell overrides the inferred direction (handles unsigned
    // exports where the sign alone is ambiguous).
    const typeKind = kindFromTypeCell(rawType);
    const kind = typeKind ?? money.kind;

    const description = normalizeDescription(rawDescription);
    const row: NormalizedImportRow = {
      sourceLine,
      occurredOn,
      description: description.length > 0 ? description : "(sem descrição)",
      amount: money.amount,
      kind,
    };
    const sourceCategory = normalizeDescription(rawCategory);
    if (sourceCategory.length > 0) {
      row.sourceCategory = sourceCategory;
    }
    rows.push(row);
  }

  return { source: "minhas-financas", rows, errors };
}

export const minhasFinancasCsvAdapter: ImportAdapter = {
  source: "minhas-financas",
  parse,
};
