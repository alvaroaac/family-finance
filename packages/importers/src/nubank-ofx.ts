import { parseSync } from "ofx-js";
import { z } from "zod";
import {
  moneyFromSignedCents,
  normalizeDate,
  normalizeDescription,
} from "./normalize.js";
import type { AdapterResult, ImportAdapter } from "./types.js";

const statementSchema = z.object({
  CURDEF: z.literal("BRL"),
  CCACCTFROM: z.object({ ACCTID: z.string().trim().min(1) }),
  BANKTRANLIST: z.object({
    DTSTART: z.string(),
    DTEND: z.string(),
    STMTTRN: z.union([z.array(z.unknown()), z.record(z.unknown())]).optional(),
  }),
});
const rowSchema = z.object({
  TRNTYPE: z.enum(["DEBIT", "CREDIT"]),
  DTPOSTED: z.string(),
  TRNAMT: z.string().regex(/^-?\d+(?:\.\d{1,2})?$/),
  FITID: z.string().trim().min(1),
  MEMO: z.string().optional(),
  NAME: z.string().optional(),
});

function ofxDate(value: string): string | null {
  const match =
    /^(\d{4})(\d{2})(\d{2})(?:\d{6}(?:\.\d+)?(?:\[[^\]]+\])?)?$/.exec(value);
  return match ? normalizeDate(`${match[1]}-${match[2]}-${match[3]}`) : null;
}

/** Some exports declare Windows-1252 but contain UTF-8. Prefer valid UTF-8. */
export function decodeOfx(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    const header = new TextDecoder("ascii").decode(bytes.slice(0, 1024));
    if (!/CHARSET:\s*1252\b/i.test(header)) {
      throw new Error("Codificacao OFX nao suportada.");
    }
    return new TextDecoder("windows-1252").decode(bytes);
  }
}

async function parse(fileText: string): Promise<AdapterResult> {
  const result: AdapterResult = { source: "nubank-ofx", rows: [], errors: [] };
  try {
    if (!/<OFX>/.test(fileText) || !/<\/OFX>\s*$/.test(fileText)) {
      throw new Error("Arquivo OFX incompleto.");
    }
    const document = parseSync(fileText);
    const envelope = z
      .object({
        SIGNONMSGSRSV1: z.object({
          SONRQ: z.unknown().optional(),
          SONRS: z.object({
            STATUS: z.object({ CODE: z.literal("0") }),
            FI: z.object({ FID: z.literal("260") }),
          }),
        }),
        CREDITCARDMSGSRSV1: z.object({
          CCSTMTTRNRS: z.object({
            STATUS: z.object({ CODE: z.literal("0") }),
            CCSTMTRS: statementSchema,
          }),
        }),
      })
      .parse(document.OFX);
    const statement = envelope.CREDITCARDMSGSRSV1.CCSTMTTRNRS.CCSTMTRS;
    const start = ofxDate(statement.BANKTRANLIST.DTSTART);
    const end = ofxDate(statement.BANKTRANLIST.DTEND);
    if (!start || !end || start > end) throw new Error("Periodo invalido.");
    result.statement = { referenceMonth: end.slice(0, 7) };
    const transactions = statement.BANKTRANLIST.STMTTRN;
    const rows =
      transactions === undefined
        ? []
        : Array.isArray(transactions)
          ? transactions
          : [transactions];
    let payments = 0;
    const seenIds = new Set<string>();
    for (const [index, raw] of rows.entries()) {
      const sourceLine = index + 1;
      const parsed = rowSchema.safeParse(raw);
      if (!parsed.success) {
        result.errors.push({
          sourceLine,
          message: "Lancamento OFX com campos ausentes ou invalidos.",
        });
        continue;
      }
      const row = parsed.data;
      const occurredOn = ofxDate(row.DTPOSTED);
      const signedCents = Math.round(Number(row.TRNAMT) * 100);
      const money = moneyFromSignedCents(signedCents);
      const description = normalizeDescription(row.MEMO || row.NAME || "");
      if (
        !occurredOn ||
        !Number.isSafeInteger(signedCents) ||
        !money ||
        !description ||
        (row.TRNTYPE === "DEBIT") !== signedCents < 0
      ) {
        result.errors.push({
          sourceLine,
          message: "Data, valor, tipo ou descricao OFX invalido.",
        });
        continue;
      }
      // Nubank reuses FITID for purchases, their refunds and associated IOF.
      const providerTransactionId = JSON.stringify([
        statement.CCACCTFROM.ACCTID,
        row.FITID,
        occurredOn,
        row.TRNTYPE,
        signedCents,
      ]);
      if (seenIds.has(providerTransactionId)) {
        result.errors.push({
          sourceLine,
          message:
            "Identificador FITID repetido no arquivo; lancamento nao importado.",
        });
        continue;
      }
      seenIds.add(providerTransactionId);
      if (
        row.TRNTYPE === "CREDIT" &&
        /^Pagamento recebido$/i.test(description)
      ) {
        payments += 1;
        continue;
      }
      const parcel =
        money.kind === "expense"
          ? (/ - Parcela (\d+)\/(\d+)$/i.exec(description) ??
            (/^Pix no Cr[eé]dito - /i.test(description)
              ? / - (\d+)\/(\d+)$/.exec(description)
              : null))
          : null;
      const installment = parcel
        ? { number: Number(parcel[1]), count: Number(parcel[2]) }
        : undefined;
      if (
        installment &&
        (installment.number < 1 ||
          installment.number > installment.count ||
          installment.count > 120)
      ) {
        result.errors.push({
          sourceLine,
          message: "Numero de parcela OFX invalido.",
        });
        continue;
      }
      result.rows.push({
        sourceLine,
        occurredOn,
        ...money,
        description: parcel
          ? description.slice(0, parcel.index).trim()
          : description,
        providerTransactionId,
        ...(installment ? { installment } : {}),
      });
    }
    result.notices = [
      `Periodo do OFX: ${start} a ${end}. Mes de referencia sugerido: ${end.slice(0, 7)}.`,
      ...(payments
        ? [
            `${payments} pagamento(s) recebido(s) excluido(s) das compras da fatura.`,
          ]
        : []),
      ...(result.rows.some((row) => row.installment)
        ? [
            "As datas de compra e os totais dos parcelamentos sao estimativas; revise antes de confirmar.",
          ]
        : []),
    ];
  } catch {
    return {
      source: "nubank-ofx",
      rows: [],
      errors: [
        {
          sourceLine: 1,
          message:
            "OFX invalido: selecione uma unica fatura de cartao Nubank em BRL, com periodo e identificadores validos.",
        },
      ],
    };
  }
  return result;
}

export const nubankOfxAdapter: ImportAdapter = { source: "nubank-ofx", parse };
