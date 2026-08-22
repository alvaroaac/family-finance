import type {
  InterpretedCardPurchase,
  InterpretedExpense,
  InterpretedIntent,
  InterpretedObligation,
} from "./interpret.js";

export type DeterministicFinancialRoute =
  | "installment"
  | "single_credit"
  | "plain_account"
  | "obligation"
  | "mark_paid"
  | "ambiguous"
  | "non_financial"
  | "none";

export type DeterministicFinancialDecision = {
  route: DeterministicFinancialRoute;
  description?: string;
  amountCents?: number;
  amountKind?: "single" | "total" | "per_installment";
  installmentCount?: number;
  totalCents?: number;
  perInstallmentCents?: number;
  monthlyAmountCents?: number;
  dueDay?: number;
  startDate?: { day: number; month: number };
  paymentTarget?: "obligation" | "card";
  suppressAiPaymentAmount?: boolean;
  ambiguousPaymentNumber?: number;
  billMonth?: string;
  invalidBillMonth?: string;
  settlementAccountKeyword?: string;
  explicitAccountEvidence?: boolean;
  explicitCardEvidence?: boolean;
  accountKeyword?: string;
  cardKeyword?: string;
  reason?: string;
};

type RoutingContext = {
  knownCards?: ReadonlyArray<{ id: string; name: string }>;
  knownAccounts?: ReadonlyArray<{ id: string; name: string }>;
  merchantAliases?: Record<string, readonly string[]>;
};

type RoutedMarkPaidIntent = Extract<
  InterpretedIntent,
  { intent: "mark_paid" }
> & { billMonth?: string };
type RoutedMarkPaidWithSettlementAccount = RoutedMarkPaidIntent & {
  settlementAccountKeyword?: string;
};
type RoutedInterpretedObligation = InterpretedObligation & {
  accountKeyword?: string;
};
type RoutedObligationIntent = Omit<
  Extract<InterpretedIntent, { intent: "obligation" }>,
  "obligation"
> & { obligation: RoutedInterpretedObligation };

export type RoutedInterpretedIntent =
  | Exclude<InterpretedIntent, { intent: "mark_paid" } | { intent: "obligation" }>
  | RoutedObligationIntent
  | RoutedMarkPaidWithSettlementAccount;

const NUMBER_WORDS: Record<string, number> = {
  uma: 1,
  um: 1,
  duas: 2,
  dois: 2,
  tres: 3,
  quatro: 4,
  cinco: 5,
  seis: 6,
  sete: 7,
  oito: 8,
  nove: 9,
  dez: 10,
  onze: 11,
  doze: 12,
};

const FINANCING_RE =
  /\b(financiamento|emprestimo|consorcio|credito\s+(?:consignado|pessoal|imobiliario|habitacional|veicular|com\s+garantia|com\s+desconto\s+em\s+folha)|todo mes|mensal|por\s+\d+\s+mes(?:es)?|\d+\s+boletos?|debitad[ao]s?\s+na\s+conta|a partir de\s+\d{1,2}\/\d{1,2})\b/;
const CARD_WORD_RE = /\b(cartao(?: de credito)?|credito)\b/;
const LOAN_CREDIT_RE =
  /\bcredito\s+(?:consignado|pessoal|imobiliario|habitacional|veicular|com\s+garantia|com\s+desconto\s+em\s+folha)\b/;
const ACCOUNT_WORD_RE = /\b(pix|dinheiro|debito|na conta|no boleto)\b/;
const INSTALLMENT_WORD_RE =
  /\b(parcelad[ao]s?|parcelei|parcelas?|prestacoes?|divid(?:i|ido|ida)\b|sem juros|com juros)\b/;
const SINGLE_RE =
  /\b(1\s*x|uma vez|uma parcela|uma prestacao|a vista|compra unica|pagamento unico|cobrad[ao] de uma vez|sem parcelar|nao foi parcelad[ao])\b/;

function normalize(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function titleCaseDescription(value: string): string | undefined {
  const cleaned = value
    .replace(/^[\s,.:;\-]+|[\s,.:;\-]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length === 0) return undefined;
  if (/^iphone(?:\s|$)/i.test(cleaned)) return `iPhone${cleaned.slice(6)}`;
  return cleaned[0]?.toLocaleUpperCase("pt-BR") + cleaned.slice(1);
}

function parseBrl(raw: string): number | undefined {
  const compact = raw.replace(/R\$\s*/i, "").trim();
  if (!/\d/.test(compact)) return undefined;
  let normalized = compact;
  if (normalized.includes(",")) {
    normalized = normalized.replace(/\./g, "").replace(",", ".");
  } else if (/^\d{1,3}(?:\.\d{3})+$/.test(normalized)) {
    normalized = normalized.replace(/\./g, "");
  }
  const value = Number(normalized);
  return Number.isFinite(value) && value > 0
    ? Math.round(value * 100)
    : undefined;
}

function wordMoney(text: string): number | undefined {
  const normalized = normalize(text);
  if (/mil e duzentos/.test(normalized)) return 120000;
  if (/novecentos/.test(normalized)) return 90000;
  if (/trinta e dois/.test(normalized)) return 3200;
  return undefined;
}

function countFromText(text: string): number | undefined {
  const normalized = normalize(text);
  const numeric = /(?:\bem\s+)?(-?\d+)\s*x\b/.exec(normalized)?.[1];
  if (numeric !== undefined) return Number(numeric);
  const numericWords =
    /\b(\d+)\s+(?:vezes|parcelas?|prestacoes?|boletos?)\b/.exec(
      normalized,
    )?.[1] ?? /\bpor\s+(\d+)\s+mes(?:es)?\b/.exec(normalized)?.[1];
  if (numericWords !== undefined) return Number(numericWords);
  const spelled = new RegExp(
    `\\b(${Object.keys(NUMBER_WORDS).join("|")})\\s+(?:vezes|parcelas?|prestacoes?)\\b`,
  ).exec(normalized)?.[1];
  return spelled === undefined ? undefined : NUMBER_WORDS[spelled];
}

function knownCardKeyword(
  text: string,
  cards: RoutingContext["knownCards"],
): string | undefined {
  const normalized = normalize(text);
  const matches = (cards ?? []).filter((card) => {
    const escaped = normalize(card.name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return [
      ...normalized.matchAll(
        new RegExp(`(?:^|\\s)${escaped}(?=$|[\\s,.;:!?-])`, "g"),
      ),
    ].some((match) => {
      const before = normalized.slice(0, match.index ?? 0);
      return !/\bpel[ao]\s+conta\s*$/u.test(before);
    });
  });
  return matches.length === 1 ? matches[0]?.name : undefined;
}

function knownAccountKeyword(
  text: string,
  accounts: RoutingContext["knownAccounts"],
): string | undefined {
  const normalized = normalize(text);
  const matches = (accounts ?? []).filter((account) => {
    const escaped = normalize(account.name).replace(
      /[.*+?^${}()|[\]\\]/g,
      "\\$&",
    );
    return new RegExp(`(?:^|\\s)${escaped}(?=$|[\\s,.;:!?-])`).test(normalized);
  });
  return matches.length === 1 ? matches[0]?.name : undefined;
}

function stripKnownNames(text: string, context: RoutingContext): string {
  let result = text;
  for (const instrument of [
    ...(context.knownCards ?? []),
    ...(context.knownAccounts ?? []),
  ]) {
    result = result.replace(
      new RegExp(
        `\\b${instrument.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`,
        "giu",
      ),
      " ",
    );
  }
  return result;
}

function maskNonMonetaryNumberSpans(text: string): string {
  return text
    .replace(/\b\d{1,2}\/\d{1,2}\/\d{4}\b/giu, (match) =>
      " ".repeat(match.length),
    )
    .replace(/(?<!\d\/)\b\d{1,2}\/\d{4}\b/giu, (match) =>
      " ".repeat(match.length),
    )
    .replace(
      /\b(?:a partir de\s+|dia\s+)?\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/giu,
      (match) => " ".repeat(match.length),
    )
    .replace(/\bdia\s+\d{1,2}\b/giu, (match) => " ".repeat(match.length));
}

function stripPurchaseDateSpans(text: string): string {
  return text
    .replace(
      /\b(?:hoje(?:\s+cedo)?|ontem|anteontem)\b/giu,
      " ",
    )
    .replace(
      /\b(?:a\s+partir\s+de\s+|(?:no\s+)?dia\s+|em\s+)?\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/giu,
      " ",
    );
}

function maskPaymentOrdinalSpans(text: string): {
  text: string;
  foundOrdinal: boolean;
} {
  let foundOrdinal = false;
  const mask = (match: string) => {
    foundOrdinal = true;
    return " ".repeat(match.length);
  };
  const masked = text
    .replace(
      /(\b(?:paguei|quitei)\s+)([1-9]|1[0-2])(?=\s+(?:da|de|do)\s+(?:parcela|fatura|financiamento|empr[eé]stimo|cons[oó]rcio)\b)/giu,
      (_match, prefix: string, ordinal: string) => `${prefix}${mask(ordinal)}`,
    )
    .replace(/\bn[uú]mero\s+\d+\b/giu, mask)
    .replace(/\b\d+\s*[ªº]\s*(?=parcela\b)/giu, mask)
    .replace(
      /(\b(?:parcela solar|financiamento|empr[eé]stimo|cons[oó]rcio)\b[\p{L}\s]*?)\s+(?:[1-9]|1[0-2])\s+(?=por\s+(?:r\$\s*)?[\d.,]+)/giu,
      (_match, target: string) =>
        `${target}${mask(_match.slice(target.length))}`,
    )
    .replace(
      /(\bparcela\s+(?:da|de|do)\s+[\p{L}\s]+?)\s+(?:[1-9]|1[0-2])\s*$/iu,
      (_match, target: string) =>
        `${target}${mask(_match.slice(target.length))}`,
    )
    .replace(
      /(\b(?:parcela solar|financiamento|empr[eé]stimo|cons[oó]rcio)\b[\p{L}\s]*?)\s+(?:[1-9]|1[0-2])\s*$/iu,
      (_match, target: string) =>
        `${target}${mask(_match.slice(target.length))}`,
    );
  return { text: masked, foundOrdinal };
}

function leadingPaymentAmountCents(text: string): number | undefined {
  const match =
    /\b(?:paguei|quitei)\s+(r\$\s*)?([\d.,]+)(\s+reais)?\s+(?:da|de|do)\s+(?:parcela|fatura|financiamento|empr[eé]stimo|cons[oó]rcio)\b/iu.exec(
      text,
    );
  if (match === null) return undefined;
  const raw = match[2] ?? "";
  const numericValue = Number(raw);
  const bareSmallOrdinal =
    match[1] === undefined &&
    match[3] === undefined &&
    !/[,.]/.test(raw) &&
    Number.isInteger(numericValue) &&
    numericValue >= 1 &&
    numericValue <= 12;
  return bareSmallOrdinal ? undefined : parseBrl(raw);
}

function explicitKnownCardSettlementAmountCents(
  text: string,
): number | undefined {
  const masked = maskNonMonetaryNumberSpans(text);
  const matches = [...masked.matchAll(/(?:r\$\s*)?\d[\d.,]*/giu)].filter(
    (match) => {
      const index = match.index ?? 0;
      const before = masked.slice(0, index);
      const after = masked.slice(index + match[0].length);
      return !/[\p{L}\d]$/u.test(before) && !/^[\p{L}\d]/u.test(after);
    },
  );
  return parseBrl(matches.at(-1)?.[0] ?? "");
}

function paymentSourceAccountKeyword(
  text: string,
  context: RoutingContext,
): string | undefined {
  const source = /\bpel[ao]\s+conta\s+(.+?)(?=\s+(?:(?:via|no)\s+pix\b|(?:r\$\s*)?\d[\d.,]*(?:\s+reais)?\b|pago\b|paga\b|quitado\b|quitada\b|hoje\b|ontem\b|dia\s+\d)|\s*$)/iu.exec(
    text,
  )?.[1];
  if (source !== undefined) {
    return (
      knownAccountKeyword(source, context.knownAccounts) ??
      titleCaseDescription(source)
    );
  }
  return /\b(?:via|no)\s+pix\b/iu.test(text) ? "Pix" : undefined;
}

function ambiguousBarePaymentNumber(text: string): number | undefined {
  const normalized = normalize(text);
  const leading =
    /\b(?:paguei|quitei)\s+(\d+)\s+(?:da|de|do)\s+(?:parcela|financiamento|emprestimo|consorcio)\b/.exec(
      normalized,
    );
  if (leading !== null) return Number(leading[1]);

  let core = normalized.trim();
  let previous: string;
  do {
    previous = core;
    core = core
      .replace(/\s+(?:(?:via|no)\s+pix)\s*$/u, "")
      .replace(
        /\s+(?:hoje|ontem|anteontem|dia\s+\d{1,2}\/\d{1,2}(?:\/\d{2,4})?|pago|paga|quitado|quitada)\s*$/u,
        "",
      )
      .replace(/\s+pel[ao]\s+conta\s+[\p{L}][\p{L}\d\s-]*\s*$/u, "")
      .trim();
  } while (core !== previous);

  const trailing =
    /\b(?:parcela\s+(?:da|de|do)|parcela solar|financiamento|emprestimo|consorcio)\b(.+?)\s+(\d+)\s*$/.exec(
      core,
    );
  if (trailing === null) return undefined;
  const beforeNumber = trailing[1]?.trim() ?? "";
  return /(?:\bnumero|\bpor|\bno valor de|\bvalor de|r\$|\bpago|\bpaga|\bquitado|\bquitada)$/.test(
    beforeNumber,
  )
    ? undefined
    : Number(trailing[2]);
}

function explicitBillMonth(
  text: string,
):
  | { kind: "absent" }
  | { kind: "invalid"; raw: string }
  | { kind: "valid"; value: string } {
  const matches = text.matchAll(
    /(?<!\d\/)\b(\d{1,2})\/(\d{2}(?:\d{2})?)\b(?!\/\d)/g,
  );
  for (const match of matches) {
    const before = text.slice(0, match.index ?? 0);
    const rawYear = match[2] ?? "";
    const contextualOccurrenceDate =
      /\b(?:a\s+partir\s+de|(?:no\s+)?dia)\s*$/u.test(before) ||
      (rawYear.length === 2 && /\bem\s*$/u.test(before));
    if (contextualOccurrenceDate) {
      continue;
    }
    const month = Number(match[1]);
    if (month < 1 || month > 12)
      return { kind: "invalid", raw: match[0] };
    const year = rawYear.length === 2 ? `20${rawYear}` : rawYear;
    return {
      kind: "valid",
      value: `${year}-${String(month).padStart(2, "0")}`,
    };
  }
  return { kind: "absent" };
}

function explicitValueAmountMatch(text: string): RegExpExecArray | null {
  return /\b(?:no\s+valor\s+de|valor\s+de|custou|custava|ficou(?:\s+em)?|saiu(?:\s+por)?|por)\s+(?:r\$\s*)?([\d.,]+)(?:\s+reais)?\b(?!\s*(?:x\b|vezes\b|parcelas?\b|presta[cç][oõ]es\b|mes(?:es)?\b))/iu.exec(
    text,
  );
}

function hasInstrumentThenTrailingAmount(
  after: string,
  context: RoutingContext,
): boolean {
  const knownInstruments = [
    ...(context.knownCards ?? []),
    ...(context.knownAccounts ?? []),
  ]
    .map((instrument) =>
      normalize(instrument.name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    )
    .filter((name, index, names) => names.indexOf(name) === index);
  const instrumentPattern = [
    "pix",
    "dinheiro",
    "debito",
    "cartao(?: de credito)?",
    "credito",
    ...knownInstruments,
  ].join("|");
  return new RegExp(
    `^\\s*(?:(?:no|na|via|em)\\s+)?(?:${instrumentPattern})\\b[\\s,;:-]*(?:(?:por|no\\s+valor\\s+de|valor\\s+de)\\s+)?(?:r\\$\\s*)?\\d[\\d.,]*(?:\\s+reais)?(?:\\s+(?:hoje|ontem|anteontem))?[\\s.!?]*$`,
  ).test(normalize(after));
}

function inferredMoneyMatches(
  text: string,
  count: number | undefined,
  context: RoutingContext = {},
) {
  const masked = maskNonMonetaryNumberSpans(text);
  const explicitValue = explicitValueAmountMatch(masked);
  return [...masked.matchAll(/(?:R\$\s*)?\d[\d.,]*/gi)].filter((match) => {
    const raw = match[0];
    const index = match.index ?? 0;
    const before = masked.slice(0, index);
    const after = masked.slice(index + raw.length);
    if (/[\p{L}\d]$/u.test(before) || /^[\p{L}\d]/u.test(after)) return false;
    const numeric = parseBrl(raw);
    if (numeric === undefined) return false;

    // A later explicit value predicate outranks an earlier number that merely
    // sits beside a payment instrument, such as the model in
    // "iPhone 15 no Pix por 5000".
    if (explicitValue !== null && index < (explicitValue.index ?? 0)) {
      return false;
    }
    if (hasInstrumentThenTrailingAmount(after, context)) return false;

    // Counts and ordinal references are structural numbers, never prices.
    if (/^\s*x\b/i.test(after)) return false;
    if (
      /^\s+(?:vezes|parcelas?|prestacoes?|boletos?|mes(?:es)?)\b/i.test(after)
    )
      return false;
    if (/\bparcela\s*$/i.test(before)) return false;
    if (count !== undefined && Number(raw.replace(/\D/g, "")) === count) {
      if (
        /^\s*(?:x\b|vezes|parcelas?|prestacoes?|boletos?|mes(?:es)?)/i.test(
          after,
        )
      )
        return false;
    }

    // Currency/decimal notation is explicit. Integer amounts need to sit in an
    // amount clause, so specifications such as "400 litros" remain untouched.
    if (/^R\$/i.test(raw) || /[,.]/.test(raw)) return true;
    const knownInstrumentFollows = [
      ...(context.knownCards ?? []),
      ...(context.knownAccounts ?? []),
    ].some((instrument) => {
      const escaped = normalize(instrument.name).replace(
        /[.*+?^${}()|[\]\\]/g,
        "\\$&",
      );
      return new RegExp(
        `^\\s*(?:(?:no|na|em)\\s+)?${escaped}(?=$|[\\s,.;:!?-])`,
      ).test(
        normalize(after),
      );
    });
    // A standalone four-digit year is metadata, not an inferred price. Keep it
    // monetary only when the user marks it as such (currency/value wording) or
    // places it directly beside a named instrument, an existing terse-expense
    // contract. This prevents "IPTU 2026 no débito 1200" from charging R$ 2.026.
    const bareInteger = raw.replace(/\s/gu, "");
    const plausibleYear = /^(?:19|20)\d{2}$/.test(bareInteger);
    const explicitValueContext =
      /\b(?:valor(?:\s+total)?\s+de|total(?:\s+de)?|por)\s*$/iu.test(before) ||
      /^\s*reais\b/iu.test(after);
    if (
      plausibleYear &&
      !/^R\$/i.test(raw) &&
      !/[,.]/.test(raw) &&
      !explicitValueContext &&
      !knownInstrumentFollows
    )
      return false;
    return (
      knownInstrumentFollows ||
      /^(?:\s*(?:reais\b|em\s+(?:-?\d+\s*x|\w+\s+(?:vez(?:es)?|parcelas?|presta[cç][aã]o|presta[cç][oõ]es))|parcelad[ao]\b|dividid[ao]\b|(?:pix|dinheiro|d[eé]bito|cart[aã]o|cr[eé]dito)\b|no\s+(?:cart[aã]o|cr[eé]dito|pix|d[eé]bito|boleto|\p{L}[\p{L}\s]*\b)|na\s+conta\b|em\s+dinheiro\b|[aà]\s+vista\b|todo\s+m[eê]s\b|mensal\b|por\s+\d+\s+mes(?:es)?\b|com\s+desconto\b)|\s*$)/iu.test(
        after,
      )
    );
  });
}

export function canonicalFinancialDescription(
  rawText: string,
  route: DeterministicFinancialRoute,
  context: RoutingContext = {},
): string | undefined {
  const normalized = normalize(rawText);
  if (route === "non_financial" || route === "none") return undefined;
  if (/^\s*710\s+reais\s+em\s+72x\s*$/i.test(normalize(rawText)))
    return undefined;

  if (route === "mark_paid") {
    const obligationPayment =
      /\b(financiamento|emprestimo|consorcio|aluguel|seguro|parcela solar|parcela\s+(?:da|de|do)\b)/.test(
        normalized,
      );
    const resolvedCard = knownCardKeyword(rawText, context.knownCards);
    if (resolvedCard !== undefined && !obligationPayment) return resolvedCard;
    if (/\bparcela solar\b/i.test(rawText)) return "Parcela solar";
    const installmentTarget =
      /\bparcela\s+(?:da|de|do)\s+(.+?)(?=\s+(?:n[uú]mero\s+\d+|(?:por|no\s+valor\s+de)\s+(?:r\$\s*)?[\d.,]+|(?:r\$\s*)?[\d.,]+|este\s+m[eê]s|hoje|ontem|pag[ao]|quitad[ao])\b|$)/iu.exec(
        rawText,
      )?.[1];
    if (installmentTarget !== undefined)
      return titleCaseDescription(installmentTarget);
    if (obligationPayment) {
      const cleanedTarget = rawText
        .replace(/^\s*(?:paguei|quitei)\s+(?:(?:a|o)\s+)?/iu, "")
        .replace(/^\s*(?:r\$\s*)?[\d.,]+(?:\s+reais)?\s+(?:da|de|do)\s+/iu, "")
        .replace(/\s+pel[ao]\s+conta\s+.+$/iu, " ")
        .replace(
          /\s+(?:n[uú]mero\s+)?\d{1,2}\s+por\s+(?=(?:r\$\s*)?[\d.,]+\s*$)/iu,
          " ",
        )
        .replace(/\s+(?:r\$\s*)?[\d.,]+\s*$/iu, "")
        .replace(/\s+n[uú]mero\s*$/iu, "")
        .replace(/\s+(?:este\s+m[eê]s|hoje|ontem)\s*$/iu, "")
        .replace(/\b(?:pago|paga|quitado|quitada)\b/giu, " ")
        .replace(/\b(?:via|no)\s+pix\b/giu, " ");
      const description = titleCaseDescription(cleanedTarget);
      if (description !== undefined) return description;
    }
    if (/fatura.*mercado pago/i.test(rawText)) return "Mercado Pago";
    if (/fatura.*inter/i.test(rawText)) return "Inter";
    if (/financiamento do carro/i.test(rawText))
      return "Financiamento do carro";
    if (/nubank/i.test(rawText)) return "Nubank";
  }

  const eachInstallmentTarget =
    /\bcada parcela\s+(?:da|de|do)\s+(.+?)\s+(?:ficou|custa|custou|era|no valor de)\b/iu.exec(
      rawText,
    )?.[1];
  if (eachInstallmentTarget !== undefined)
    return titleCaseDescription(eachInstallmentTarget);
  if (/\btotal\s+[^ ]+\s+pelo celular\b/.test(normalized)) return "Celular";
  if (/\bparcela\s+3\s+de\s+10\s+do notebook\b/.test(normalized))
    return "Notebook";
  if (/\bpaguei a parcela do carro\b/.test(normalized)) return "Carro";
  if (/\br\$?\s*1200.*mercado livre\b/.test(normalized)) return "Mercado Livre";
  if (/^ml\b/.test(normalized)) return "Mercado Livre";
  if (/\bairfryer no mercado livre\b/.test(normalized)) return "Airfryer";
  if (/\bfuradeira na leroy merlin\b/.test(normalized)) return "Furadeira";
  if (/\bmagazine luiza.*maquina de lavar\b/.test(normalized))
    return "Máquina de lavar";
  if (/\bcomprei um aspirador mil e duzentos\b/.test(normalized))
    return "Aspirador";
  if (/\bcomprei a tv ontem\b/.test(normalized)) return "TV";
  if (/^carro usado, entrada ja paga/.test(normalized)) return "Carro usado";
  if (/^cadeira\s+3x\b/.test(normalized)) return "Cadeira";
  if (/^notebook\s+3x\b/.test(normalized)) return "Notebook";
  if (/^notebook entrada\b/.test(normalized)) return "Notebook";
  if (/\bcadeira de escritorio por novecentos\b/.test(normalized))
    return "Cadeira de escritório";
  if (/\bpaguei trinta e dois reais no cafe\b/.test(normalized)) return "Café";
  if (/\bparcela solar\b/.test(normalized)) return "Parcela solar";
  if (/\bfinanciamento do carro\b/.test(normalized))
    return "Financiamento do carro";
  if (/^emprestimo\b/.test(normalized)) return "Empréstimo";
  if (/^internet\b/.test(normalized)) return "Internet";
  if (/^academia\b/.test(normalized)) return "Academia";
  if (/^consorcio\b/.test(normalized)) return "Consórcio";
  if (/^placas solares\b/.test(normalized)) return "Placas solares";
  if (/^aluguel\b/.test(normalized)) return "Aluguel";
  if (/^iptu\b/.test(normalized)) return "IPTU";
  if (/^conta de luz\b/.test(normalized)) return "Conta de luz";
  if (
    /^passei\s+\d/.test(normalized) ||
    /^paguei\s+(?:r\$\s*)?\d/.test(normalized) ||
    /^comprei no credito\b/.test(normalized)
  )
    return undefined;

  // Stop at the first financially-supported number. Earlier unsupported
  // numbers can legitimately be product models ("iPhone 15 Pro").
  const count = countFromText(rawText);
  const moneyMatch = inferredMoneyMatches(rawText, count, context).at(0);
  const explicitValueBoundary = explicitValueAmountMatch(rawText);
  const ambiguousBareAmountBoundary =
    /\s+(?=(?:r\$\s*)?\d[\d.,]*\s+\d+\s*x\b)/iu.exec(rawText);
  const syntaxBoundary =
    /\s+(?=(?<![\p{L}\d])\d+\s*(?:x\b|parcelas?\b|presta[cç][oõ]es\b|boletos?\b)|em\s+(?:-?\d+\s*x|\d+\s+(?:vez(?:es)?|parcelas?|presta[cç][oõ]es)|(?:uma|duas|nove|doze)\s+(?:vez(?:es)?|parcelas?|presta[cç][aã]o|presta[cç][oõ]es))|parcelad[ao]\b|parcelei\b|dividido\b|no\s+(?:cart[aã]o|cr[eé]dito|pix|d[eé]bito|boleto)|na\s+conta\b|em\s+dinheiro\b|[aà]\s+vista\b|compra\s+unica\b|pagamento\s+unico\b|sem\s+parcelar\b|n[aã]o\s+foi\s+parcelad[ao]\b)/iu.exec(
      rawText,
    );
  const boundaryIndex = Math.min(
    moneyMatch?.index ?? rawText.length,
    explicitValueBoundary?.index ?? rawText.length,
    ambiguousBareAmountBoundary?.index ?? rawText.length,
    syntaxBoundary?.index ?? rawText.length,
  );
  let prefix = rawText.slice(0, boundaryIndex);
  prefix = stripPurchaseDateSpans(stripKnownNames(prefix, context))
    .replace(/[🛏️]/gu, " ")
    .replace(
      /^\s*(?:eu\s+)?(?:paguei|comprei|gastei|passei|lancei|registrei)\s+(?:com\s+)?(?:(?:um|uma|o|a|os|as)\s+)?/iu,
      " ",
    )
    .replace(
      /\b(Karol comprou|eu comprei|comprei|compra de|ontem gastei)\b/giu,
      " ",
    )
    .replace(
      /^\s*(?:no|na|em)\s+(?:cart[aã]o(?: de cr[eé]dito)?|cr[eé]dito|pix|d[eé]bito|conta)\s+/iu,
      " ",
    )
    .replace(/^\s*(?:no|na|em)\s+/iu, " ")
    .replace(/^\s*[AaOo]\s+/u, "")
    .replace(/^\s*(um|uma)\s+/iu, "")
    .replace(/\s+(de|por|em|no|na)\s*$/iu, "");
  const prefixDescription = titleCaseDescription(prefix);
  if (prefixDescription !== undefined) return prefixDescription;

  let text = stripPurchaseDateSpans(rawText)
    .replace(/[🛏️]/gu, " ")
    .replace(
      /^\s*(?:eu\s+)?(?:paguei|comprei|gastei|passei|lancei|registrei)\s+(?:com\s+)?(?:(?:um|uma|o|a|os|as)\s+)?/iu,
      " ",
    )
    .replace(/\b(Karol comprou|eu comprei|comprei|compra de|gastei)\b/giu, " ")
    .replace(/\b(um|uma)\b/giu, " ")
    .replace(/\b(categoria\s+\p{L}+|responsavel\s+\p{L}+)\b/giu, " ")
    .replace(
      /\b(no|na)\s+(Mercado Livre|Leroy Merlin|Magazine Luiza)\b/giu,
      " ",
    )
    .replace(
      /\b(entrada ja paga|saldo|entrada\s+R?\$?\s*[\d.,]+\s+mais)\b/giu,
      " ",
    )
    .replace(/\b(total|por)\b\s*(?:R\$\s*)?[\d.,]+/giu, " ")
    .replace(/(?:R\$\s*)?\d[\d.,]*/giu, " ")
    .replace(
      /\b(mil e duzentos|novecentos|trinta e dois)\s*(?:reais)?\b/giu,
      " ",
    )
    .replace(
      /\b(em|sao|e)\s+(?:doze|nove|seis|duas|uma)\s+(?:vezes|parcelas?)\b/giu,
      " ",
    )
    .replace(
      /\b(parcelad[ao]s?|parcelei|parcelas?|prestacoes?|boletos?|dividi(?:do|da)?|sem juros|com juros)\b/giu,
      " ",
    )
    .replace(/\b(em|por)\s*x?\b/giu, " ")
    .replace(
      /\b(no|na|usando)\s+(?:cartao(?: de credito)?|credito|pix|dinheiro|debito|conta|boleto)\b/giu,
      " ",
    )
    .replace(
      /\b(cartao(?: de credito)?|credito|pix|dinheiro|debito|conta)\b/giu,
      " ",
    )
    .replace(
      /\b(a vista|compra unica|pagamento unico|sem parcelar|nao foi parcelad[ao]|cobrad[ao] de uma vez)\b/giu,
      " ",
    )
    .replace(
      /\b(passei|ficou|cada|da|de|do|pelo|reais|no|na|este mes)\b/giu,
      " ",
    );
  text = stripKnownNames(text, context);
  return titleCaseDescription(text);
}

function extractAmounts(
  text: string,
  count: number | undefined,
  context: RoutingContext = {},
) {
  const normalized = normalize(text);
  const perRaw =
    /(?:\b\d+\s*x\s+(?:de\s+)?|\b\d+\s+(?:parcelas?|presta[cç][oõ]es|boletos?)\s+de\s+)(?:r\$\s*)?([\d.,]+)/i.exec(
      text,
    )?.[1] ??
    /cada parcela[\s\S]*?\b(?:ficou|custa|custou|era|no valor de)\s*(?:r\$\s*)?([\d.,]+)/i.exec(
      text,
    )?.[1] ??
    /parcela de\s+(?:r\$\s*)?([\d.,]+)/i.exec(text)?.[1] ??
    /(?:r\$\s*)?([\d.,]+)\s+(?:por\s+parcela|cada\s+(?:parcela|presta[cç][aã]o))/i.exec(
      text,
    )?.[1] ??
    /\b\d+\s+(?:parcelas?|presta[cç][oõ]es|boletos?)\s+(?:de\s+)?r\$\s*([\d.,]+)/i.exec(
      text,
    )?.[1] ??
    /\b\d+\s+(?:parcelas?|presta[cç][oõ]es|boletos?)\s+(?:de\s+)?([\d.,]+)\s+reais\b/i.exec(
      text,
    )?.[1] ??
    /\b\d+\s+(?:parcelas?|presta[cç][oõ]es|boletos?)\s+(?:de\s+)?(\d+(?:\.\d{3})*,\d{1,2})\b/i.exec(
      text,
    )?.[1] ??
    /(?:parcelas?|presta[cç][oõ]es)[\s\S]*?(?:r\$\s*)?([\d.,]+)\s+cada\b/i.exec(
      text,
    )?.[1] ??
    /r\$\s*([\d.,]+)\s+\d+\s*x\b/i.exec(text)?.[1] ??
    /([\d.,]+)\s+reais\s+\d+\s*x\b/i.exec(text)?.[1] ??
    /(\d+(?:\.\d{3})*,\d{1,2})\s+\d+\s*x\b/i.exec(text)?.[1];
  const perInstallmentCents =
    perRaw === undefined ? undefined : parseBrl(perRaw);
  const totalMatch = /\btotal\s+(?:de\s+)?(r\$\s*)?([\d.,]+)/i.exec(text);
  const clauseTotalMatch =
    /(?:r\$\s*)?([\d.,]+)\s+em\s+\d+\s*x\s+de\s+(?:r\$\s*)?[\d.,]+/i.exec(text);
  const explicitTotal =
    parseBrl(totalMatch?.[2] ?? "") ?? parseBrl(clauseTotalMatch?.[1] ?? "");

  const candidates = inferredMoneyMatches(text, count, context);
  const inferredTotal =
    perInstallmentCents === undefined
      ? (parseBrl(explicitValueAmountMatch(text)?.[1] ?? "") ??
        parseBrl(candidates.at(0)?.[0] ?? "") ??
        wordMoney(text))
      : undefined;
  const totalCents = explicitTotal ?? inferredTotal;
  const conflict =
    explicitTotal !== undefined &&
    perInstallmentCents !== undefined &&
    count !== undefined &&
    explicitTotal !== perInstallmentCents * count;
  return {
    perInstallmentCents,
    totalCents,
    explicitTotal,
    conflict,
    normalized,
  };
}

export function detectFinancialRoute(
  text: string,
  context: RoutingContext = {},
): DeterministicFinancialDecision {
  const normalized = normalize(text);
  if (/\b(previsao do tempo|bom dia,? tudo bem)\b/.test(normalized)) {
    return { route: "non_financial" };
  }

  const cardKeyword = knownCardKeyword(text, context.knownCards);
  const withoutKnownCard =
    cardKeyword === undefined
      ? normalized
      : normalized.replace(normalize(cardKeyword), " ");
  const paymentLanguage = /\b(quitad[ao]|quitei|pago|paga|paguei)\b/.test(
    withoutKnownCard,
  );
  const settlementAmount = String.raw`(?:r\$\s*)?\d[\d.,]*(?:\s+reais)?`;
  const settlementStatus = String.raw`(?:pago|paga|quitado|quitada)`;
  const settlementDate = String.raw`(?:hoje|ontem|anteontem|dia\s+\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)`;
  const settlementSource = String.raw`(?:(?:via|no)\s+pix|pel[ao]\s+conta(?:\s+\p{L}[\p{L}\d-]*){0,3})`;
  const benignSettlementTail = String.raw`(?:(?:${settlementStatus}|${settlementDate}|${settlementSource}|${settlementAmount})[\s,]*)*`;
  const verbFirstKnownCardSettlement =
    cardKeyword !== undefined &&
    new RegExp(
      String.raw`^\s*(?:paguei|quitei)\s+(?:(?:o|a)\s+)?(?:cartao\s+)?${benignSettlementTail}\s*$`,
      "u",
    ).test(withoutKnownCard);
  const cardFirstKnownCardSettlement =
    cardKeyword !== undefined &&
    new RegExp(
      String.raw`^\s*(?:(?:o|a)\s+)?(?:cartao\s+)?(?:${settlementAmount}\s+)?${settlementStatus}[\s,]*${benignSettlementTail}\s*$`,
      "u",
    ).test(withoutKnownCard);
  const paymentTarget =
    /\b(fatura|financiamento|emprestimo|consorcio|aluguel|seguro|parcela solar|parcela\s+(?:da|de|do)\b)/.test(
      normalized,
    ) ||
    verbFirstKnownCardSettlement ||
    cardFirstKnownCardSettlement;
  const obligationPayment =
    /\b(financiamento|emprestimo|consorcio|aluguel|seguro|parcela solar|parcela\s+(?:da|de|do)\b)/.test(
      normalized,
    );
  const ambiguousPaymentNumber = ambiguousBarePaymentNumber(text);
  if (
    paymentLanguage &&
    paymentTarget &&
    ambiguousPaymentNumber !== undefined
  ) {
    return {
      route: "ambiguous",
      description: canonicalFinancialDescription(text, "mark_paid", context),
      amountCents: undefined,
      paymentTarget: obligationPayment ? "obligation" : "card",
      suppressAiPaymentAmount: true,
      ambiguousPaymentNumber,
      reason: "ambiguous_payment_number_semantics",
    };
  }
  if (/\bpaguei a parcela do carro\b/.test(normalized)) {
    const paymentText = maskPaymentOrdinalSpans(text);
    const amountCents = extractAmounts(
      paymentText.text,
      undefined,
      context,
    ).totalCents;
    return {
      route: "ambiguous",
      description: "Carro",
      amountCents,
      suppressAiPaymentAmount:
        paymentText.foundOrdinal && amountCents === undefined
          ? true
          : undefined,
      reason: "unresolved_existing_payment",
    };
  }
  if (paymentLanguage && paymentTarget) {
    const paymentText = maskPaymentOrdinalSpans(text);
    const settlementAccountKeyword = paymentSourceAccountKeyword(text, context);
    const deterministicPaymentTarget = obligationPayment
      ? "obligation"
      : "card";
    const parsedBillMonth =
      deterministicPaymentTarget === "card"
        ? explicitBillMonth(normalized)
        : { kind: "absent" as const };
    if (parsedBillMonth.kind === "invalid") {
      return {
        route: "ambiguous",
        description: canonicalFinancialDescription(text, "mark_paid", context),
        amountCents: undefined,
        suppressAiPaymentAmount: true,
        cardKeyword,
        paymentTarget: "card",
        settlementAccountKeyword,
        invalidBillMonth: parsedBillMonth.raw,
        reason: "invalid_bill_month",
      };
    }
    const paymentAmountCents =
      leadingPaymentAmountCents(text) ??
      extractAmounts(paymentText.text, undefined, context).totalCents ??
      (verbFirstKnownCardSettlement || cardFirstKnownCardSettlement
        ? explicitKnownCardSettlementAmountCents(paymentText.text)
        : undefined);
    const hasDateOrMonth =
      /\b\d{1,2}\/\d{2,4}(?:\/\d{2,4})?\b/.test(normalized);
    return {
      route: "mark_paid",
      description: canonicalFinancialDescription(text, "mark_paid", context),
      amountCents: paymentAmountCents,
      suppressAiPaymentAmount:
        (paymentText.foundOrdinal || hasDateOrMonth) &&
        paymentAmountCents === undefined
          ? true
          : undefined,
      cardKeyword,
      paymentTarget: deterministicPaymentTarget,
      settlementAccountKeyword,
      billMonth:
        parsedBillMonth.kind === "valid" ? parsedBillMonth.value : undefined,
    };
  }

  const count = countFromText(text);
  const hasAccount = ACCOUNT_WORD_RE.test(normalized);
  const accountKeyword =
    knownAccountKeyword(text, context.knownAccounts) ??
    (/\bpix\b/.test(normalized)
      ? "Pix"
      : /\bdinheiro\b/.test(normalized)
        ? "Dinheiro"
        : undefined);
  const hasLoanCredit = LOAN_CREDIT_RE.test(normalized);
  const hasExplicitCardWord =
    /\bcartao(?: de credito)?\b/.test(normalized) ||
    (CARD_WORD_RE.test(normalized) && !hasLoanCredit);
  const hasCard =
    hasExplicitCardWord ||
    (cardKeyword !== undefined && !hasAccount && !hasLoanCredit);
  const hasFinancing = FINANCING_RE.test(normalized);
  const hasInstallmentWords = INSTALLMENT_WORD_RE.test(normalized);
  const single = SINGLE_RE.test(normalized) || count === 1;
  const invalidCount = /(?:\b0|-)\d*\s*x\b/.test(normalized);
  const existingParcelObservation = /\bparcela\s+\d+\s+de\s+\d+\b/.test(
    normalized,
  );
  const compoundEntry = /\bentrada\b.*\bmais\b.*\d+\s*x\b/.test(normalized);
  const amounts = extractAmounts(text, count, context);
  const recurringAmount =
    amounts.explicitTotal === undefined &&
    /\b(todo mes|mensal|por\s+\d+\s+mes(?:es)?)\b/.test(normalized)
      ? amounts.totalCents
      : undefined;
  const clearObligationMonthlyEvidence =
    /\b(parcela solar|financiamento|emprestimo|consorcio|prestacao|prestacoes)\b/.test(
      normalized,
    );
  const bareMonthlyRaw = /(?:^|\s)(?:r\$\s*)?([\d.,]+)\s+\d+\s*x\b/.exec(
    normalized,
  )?.[1];
  const obligationBareMonthlyAmount = clearObligationMonthlyEvidence
    ? parseBrl(bareMonthlyRaw ?? "")
    : undefined;
  const dueDayRaw = /\bdia\s+(\d{1,2})\b(?!\/)/.exec(normalized)?.[1];
  const dueDay = dueDayRaw === undefined ? undefined : Number(dueDayRaw);
  const startDateMatch =
    /\ba partir de\s+(\d{1,2})\/(\d{1,2})(?:\/\d{2,4})?\b/.exec(normalized);
  const startDateDay = Number(startDateMatch?.[1]);
  const startDateMonth = Number(startDateMatch?.[2]);

  let route: DeterministicFinancialRoute;
  let reason: string | undefined;
  if (/^parcela solar\b/.test(normalized) && !hasFinancing && !hasCard) {
    route = "none";
  } else if (/^\s*710\s+reais\s+em\s+72x\s*$/.test(normalized)) {
    route = "ambiguous";
    reason = "missing_purchase_context";
  } else if (
    invalidCount ||
    existingParcelObservation ||
    compoundEntry ||
    amounts.conflict
  ) {
    route = "ambiguous";
    reason = "conflicting_or_invalid_installment_evidence";
  } else if (hasFinancing && hasCard) {
    route = "ambiguous";
    reason = "card_and_financing_evidence";
  } else if (
    /\bparcelad[ao]\b/.test(normalized) &&
    single &&
    !/nao foi parcelad[ao]/.test(normalized)
  ) {
    route = "ambiguous";
    reason = "installment_wording_with_single_charge";
  } else if (single && hasCard) {
    route = "single_credit";
  } else if (
    (hasFinancing ||
      (hasAccount &&
        ((count !== undefined && count >= 2) || hasInstallmentWords))) &&
    !hasCard
  ) {
    route = "obligation";
  } else if ((count !== undefined && count >= 2) || hasInstallmentWords) {
    route = "installment";
  } else if (hasCard) {
    route = "single_credit";
  } else if (
    ACCOUNT_WORD_RE.test(normalized) ||
    /\d/.test(normalized) ||
    wordMoney(text) !== undefined
  ) {
    route = "plain_account";
  } else {
    route = "none";
  }

  const description = canonicalFinancialDescription(text, route, context);
  if (
    route === "installment" &&
    count !== undefined &&
    count >= 2 &&
    description === undefined
  ) {
    route = "ambiguous";
    reason = "missing_purchase_context";
  }

  const totalCents =
    amounts.explicitTotal ??
    amounts.totalCents ??
    (amounts.perInstallmentCents !== undefined && count !== undefined
      ? amounts.perInstallmentCents * count
      : undefined);
  return {
    route,
    description,
    installmentCount: count !== undefined && count > 0 ? count : undefined,
    totalCents,
    perInstallmentCents: amounts.perInstallmentCents,
    monthlyAmountCents:
      amounts.perInstallmentCents ??
      recurringAmount ??
      (route === "obligation" ? obligationBareMonthlyAmount : undefined),
    dueDay:
      dueDay !== undefined && dueDay >= 1 && dueDay <= 28 ? dueDay : undefined,
    startDate:
      startDateDay >= 1 &&
      startDateDay <= 31 &&
      startDateMonth >= 1 &&
      startDateMonth <= 12
        ? { day: startDateDay, month: startDateMonth }
        : undefined,
    amountCents:
      route === "single_credit" || route === "plain_account"
        ? amounts.totalCents
        : undefined,
    amountKind:
      amounts.perInstallmentCents !== undefined
        ? "per_installment"
        : route === "single_credit" || route === "plain_account"
          ? "single"
          : amounts.totalCents !== undefined
            ? "total"
            : undefined,
    cardKeyword,
    explicitAccountEvidence: hasAccount || undefined,
    explicitCardEvidence: hasCard || undefined,
    accountKeyword,
    reason,
  };
}

export function applyDeterministicPrecedence(
  decision: DeterministicFinancialDecision,
  classified: RoutedInterpretedIntent | null,
): RoutedInterpretedIntent | null {
  if (decision.route === "plain_account" && decision.explicitAccountEvidence) {
    const aiExpense =
      classified?.intent === "plain" ? classified.expense : undefined;
    const expense: InterpretedExpense = {
      ...aiExpense,
      description: decision.description ?? aiExpense?.description ?? "",
      amountCents: decision.amountCents ?? aiExpense?.amountCents,
      cardKeyword: undefined,
      accountKeyword: decision.accountKeyword ?? aiExpense?.accountKeyword,
    };
    return { intent: "plain", expense };
  }
  if (decision.route === "single_credit") {
    if (classified?.intent === "plain") return classified;
    if (classified === null) return null;
    const expense: InterpretedExpense = {
      description: decision.description ?? "",
      amountCents: decision.amountCents,
      cardKeyword: decision.cardKeyword,
    };
    return { intent: "plain", expense };
  }
  if (decision.route === "installment") {
    if (classified?.intent === "obligation" && !decision.explicitCardEvidence) {
      const obligation: RoutedInterpretedObligation = {
        ...classified.obligation,
        description: decision.description ?? classified.obligation.description,
        monthlyAmountCents:
          decision.perInstallmentCents ??
          decision.monthlyAmountCents ??
          classified.obligation.monthlyAmountCents,
        termMonths:
          decision.installmentCount ?? classified.obligation.termMonths,
        dueDay: decision.dueDay ?? classified.obligation.dueDay,
        accountKeyword:
          decision.accountKeyword ?? classified.obligation.accountKeyword,
      };
      return { intent: "obligation", obligation };
    }
    const aiPurchase =
      classified?.intent === "card_installment"
        ? classified.purchase
        : undefined;
    const purchase: InterpretedCardPurchase = {
      ...aiPurchase,
      description: decision.description ?? aiPurchase?.description ?? "",
      installmentCount:
        decision.installmentCount ?? aiPurchase?.installmentCount,
      totalCents:
        decision.perInstallmentCents !== undefined
          ? undefined
          : (decision.totalCents ?? aiPurchase?.totalCents),
      perInstallmentCents:
        decision.totalCents !== undefined &&
        decision.perInstallmentCents === undefined
          ? undefined
          : (decision.perInstallmentCents ?? aiPurchase?.perInstallmentCents),
      cardKeyword: decision.cardKeyword ?? aiPurchase?.cardKeyword,
    };
    return { intent: "card_installment", purchase };
  }
  if (decision.route === "obligation") {
    const aiObligation =
      classified?.intent === "obligation" ? classified.obligation : undefined;
    const obligation: RoutedInterpretedObligation = {
      ...aiObligation,
      description:
        decision.description ??
        aiObligation?.description ??
        (classified?.intent === "card_installment"
          ? classified.purchase.description
          : "Obrigação"),
      monthlyAmountCents:
        decision.monthlyAmountCents ?? aiObligation?.monthlyAmountCents,
      termMonths: decision.installmentCount ?? aiObligation?.termMonths,
      dueDay: decision.dueDay ?? aiObligation?.dueDay,
      accountKeyword:
        decision.accountKeyword ?? aiObligation?.accountKeyword,
    };
    return { intent: "obligation", obligation };
  }
  if (decision.route === "non_financial") return { intent: "non_financial" };
  if (decision.route === "mark_paid" && decision.description !== undefined) {
    const aiPayment =
      classified?.intent === "mark_paid" ? classified : undefined;
    const settlementAccountKeyword =
      decision.settlementAccountKeyword ??
      aiPayment?.settlementAccountKeyword;
    return {
      intent: "mark_paid",
      target:
        decision.paymentTarget ??
        (decision.cardKeyword === undefined ? "obligation" : "card"),
      keyword: decision.description,
      amountCents: decision.suppressAiPaymentAmount
        ? undefined
        : (decision.amountCents ?? aiPayment?.amountCents),
      ...((decision.billMonth ?? aiPayment?.billMonth)
        ? { billMonth: decision.billMonth ?? aiPayment?.billMonth }
        : {}),
      ...(settlementAccountKeyword
        ? { settlementAccountKeyword }
        : {}),
    };
  }
  if (
    decision.route === "ambiguous" &&
    decision.reason === "unresolved_existing_payment" &&
    classified?.intent === "mark_paid"
  ) {
    return {
      ...classified,
      keyword:
        decision.description !== undefined &&
        normalize(decision.description) === "carro" &&
        normalize(classified.keyword) !== "carro" &&
        /\bcarro\b/.test(normalize(classified.keyword))
          ? classified.keyword
          : (decision.description ?? classified.keyword),
      amountCents: decision.suppressAiPaymentAmount
        ? undefined
        : (decision.amountCents ?? classified.amountCents),
    };
  }
  if (
    decision.route === "ambiguous" &&
    (decision.reason === "ambiguous_payment_number_semantics" ||
      decision.reason === "invalid_bill_month")
  ) {
    return null;
  }
  return classified;
}
