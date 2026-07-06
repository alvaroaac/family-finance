/**
 * Mercado Pago fatura (PDF) adapter. Input is the ALREADY-EXTRACTED text of the
 * statement (extraction happens in the web layer via unpdf — this package never
 * sees PDF bytes). Unlike a CSV, the extracted text is ONE CONTINUOUS STRING with
 * no newlines (confirmed against `unpdf.extractText(..., { mergePages: true })`
 * output) — there is no line structure to split on, so this adapter scans the
 * raw string with anchored regexes instead of iterating lines.
 *
 * Observed shape (see `__fixtures__/mercado-pago-fatura.ts` for a full sample):
 *
 *   ...Emitida em: 30/06/2026... Resumo da fatura ... Total R$ 3.240,00
 *   Movimentações na fatura Data Movimentações Valor em R$
 *   05/06 Pagamento da fatura de junho/2026 R$ 5.100,00
 *   Cartão Visa [************1111] Data Movimentações Valor em R$
 *   15/11 MERCADOLIVRE*LOJA EXEMPLO Parcela 14 de 18 R$ 250,00
 *   02/06 Compra internacional em EXEMPLO* SERVICO ASSINATURA R$ 500,00
 *   BRL 0 = USD 1 = R$ 0 BRL 100.00
 *   06/06 EBN*HOSPEDAGEM EXEMPLO R$ 40,00
 *   Total R$ 1.295,00
 *   Cartão Visa [************2222] Data Movimentações Valor em R$
 *   ...
 *
 * The header/summary block and the "Movimentações na fatura" + payment row
 * always appear BEFORE the first "Cartão ..." section header, so everything up
 * to (and including) the first card header is dropped wholesale — this also
 * discards the "Pagamento da fatura de <mês>/<ano>" row without any special
 * casing. Each card section is then scanned independently for transaction rows
 * anchored on a leading `DD/MM` date token; the repeated column-label runs
 * ("Data Movimentações Valor em R$") and the per-card "Total R$ <valor>" line
 * have no leading date, so they never match the row pattern.
 *
 * The international-purchase continuation ("BRL 0 = USD 1 = R$ 0 BRL 100.00")
 * sits in the text GAP between two row matches (it is not itself a row); when
 * found there, the foreign currency + amount are appended to the PRECEDING
 * row's description as "(USD 100.00)".
 *
 * Dates carry no year; the year is inferred from the emission date
 * ("Emitida em: 30/06/2026"): a row month GREATER than the statement month
 * belongs to the previous year (fatura closes mid-month, so rows from the tail
 * end of the prior year's December can appear on a January statement, etc).
 *
 * `sourceLine` has no literal meaning here (there are no lines) — it is the
 * 1-based ordinal of the transaction-like match across the whole document
 * (card sections in document order, rows within a section in match order).
 * Both parsed rows and error rows share this ordinal scheme.
 */

import {
  parseBrlToCents,
  normalizeDescription,
  moneyFromSignedCents,
} from "./normalize.js";
import type {
  ImportAdapter,
  AdapterResult,
  NormalizedImportRow,
  ImportRowError,
  StatementInfo,
} from "./types.js";

const EMITTED_RE = /Emitida em:?\s*(\d{2})\/(\d{2})\/(\d{4})/;
const CARD_SECTION_RE = /Cart[ãa]o\s+\S+\s+\[\*+(\d{4})\]/g;

// Lazy description, but excludes "R$" so a following "Total R$ <valor>" or the
// next column-label run cannot be swallowed into a preceding row's description.
const ROW_RE =
  /(\d{2})\/(\d{2})\s+((?:(?!R\$).)+?)(?:\s+Parcela\s+(\d+)\s+de\s+(\d+))?\s+R\$\s*([\d.,]+)/g;

// Exchange-rate continuation fragment sitting between two rows, e.g.
// "BRL 0 = USD 1 = R$ 0 BRL 100.00". The FIRST currency is the rate-quote
// placeholder; the SECOND currency is the actual foreign currency, and the
// trailing number (anchored at the fragment end) is the foreign amount.
const INTL_GAP_RE =
  /([A-Z]{3})\s+[\d.,]+\s*=\s*([A-Z]{3})\s+[\d.,]+\s*=\s*R\$\s*[\d.,]+\s+[A-Z]{3}\s+([\d.,]+)\s*$/;

function isRealDate(year: number, month: number, day: number): boolean {
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

/** Row year: statement year, unless the row month is AFTER the closing month. */
function inferYear(rowMonth: number, refYear: number, refMonth: number): number {
  return rowMonth > refMonth ? refYear - 1 : refYear;
}

type CardSection = {
  last4: string;
  /** Text between this section's header and the next (or end of document). */
  text: string;
};

/** Split the document into per-card-section text chunks, keyed by last4. */
function splitCardSections(fileText: string): CardSection[] {
  const headers: { index: number; end: number; last4: string }[] = [];
  const re = new RegExp(CARD_SECTION_RE.source, CARD_SECTION_RE.flags);
  let match: RegExpExecArray | null;
  while ((match = re.exec(fileText)) !== null) {
    headers.push({
      index: match.index,
      end: re.lastIndex,
      last4: match[1] as string,
    });
  }

  return headers.map((header, i) => {
    const start = header.end;
    const end = i + 1 < headers.length ? (headers[i + 1] as { index: number }).index : fileText.length;
    return { last4: header.last4, text: fileText.slice(start, end) };
  });
}

async function parse(fileText: string): Promise<AdapterResult> {
  const rows: NormalizedImportRow[] = [];
  const errors: ImportRowError[] = [];

  const emitted = EMITTED_RE.exec(fileText);
  if (emitted === null) {
    return {
      source: "mercado-pago",
      rows,
      errors: [
        {
          sourceLine: 1,
          message:
            'Fatura não reconhecida: data de emissão ("Emitida em: DD/MM/AAAA") não encontrada.',
        },
      ],
    };
  }
  const refMonth = Number.parseInt(emitted[2] as string, 10);
  const refYear = Number.parseInt(emitted[3] as string, 10);
  const statement: StatementInfo = {
    referenceMonth: `${refYear}-${String(refMonth).padStart(2, "0")}`,
  };

  const sections = splitCardSections(fileText);
  let ordinal = 0;

  for (const section of sections) {
    const rowRe = new RegExp(ROW_RE.source, ROW_RE.flags);
    const matches: RegExpExecArray[] = [];
    let rowMatch: RegExpExecArray | null;
    while ((rowMatch = rowRe.exec(section.text)) !== null) {
      matches.push(rowMatch);
    }

    for (let i = 0; i < matches.length; i += 1) {
      const current = matches[i] as RegExpExecArray;
      ordinal += 1;
      const sourceLine = ordinal;

      const day = Number.parseInt(current[1] as string, 10);
      const month = Number.parseInt(current[2] as string, 10);
      const descriptionRaw = current[3] as string;
      const rawValue = current[6] as string;

      // ROW_RE captures "Parcela X de Y" as its own optional group (4/5), so
      // the description group (3) never contains the marker text to begin with.
      let installment: { number: number; count: number } | undefined;
      const parcelaNumber = current[4];
      const parcelaCount = current[5];
      if (parcelaNumber !== undefined && parcelaCount !== undefined) {
        installment = {
          number: Number.parseInt(parcelaNumber, 10),
          count: Number.parseInt(parcelaCount, 10),
        };
      }

      // International continuation: gap text between this row and the next.
      const gapStart = current.index + current[0].length;
      const gapEnd =
        i + 1 < matches.length
          ? (matches[i + 1] as RegExpExecArray).index
          : section.text.length;
      const gap = section.text.slice(gapStart, gapEnd).trim();
      const intl = INTL_GAP_RE.exec(gap);
      let descriptionSuffix = "";
      if (intl !== null) {
        descriptionSuffix = ` (${intl[2]} ${intl[3]})`;
      }

      const year = inferYear(month, refYear, refMonth);
      if (!isRealDate(year, month, day)) {
        errors.push({
          sourceLine,
          message: `Data inválida na transação ${sourceLine} (${current[1]}/${current[2]}).`,
        });
        continue;
      }
      const occurredOn = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;

      const cents = parseBrlToCents(rawValue);
      if (cents === null) {
        errors.push({
          sourceLine,
          message: `Valor inválido na transação ${sourceLine}.`,
        });
        continue;
      }
      // Fatura consumo rows are expenses; the sign is not carried on the row.
      const money = moneyFromSignedCents(-Math.abs(cents));
      if (money === null) {
        errors.push({
          sourceLine,
          message: `Valor zero não pode ser importado (transação ${sourceLine}).`,
        });
        continue;
      }

      const description = normalizeDescription(descriptionRaw + descriptionSuffix);
      rows.push({
        sourceLine,
        occurredOn,
        description: description.length > 0 ? description : "(sem descrição)",
        amount: money.amount,
        kind: money.kind,
        installment,
        cardLast4: section.last4,
      });
    }
  }

  return { source: "mercado-pago", rows, errors, statement };
}

export const mercadoPagoPdfAdapter: ImportAdapter = {
  source: "mercado-pago",
  parse,
};
