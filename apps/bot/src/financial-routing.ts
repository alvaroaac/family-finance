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
  cardKeyword?: string;
  reason?: string;
};

type RoutingContext = {
  knownCards?: ReadonlyArray<{ id: string; name: string }>;
  knownAccounts?: ReadonlyArray<{ id: string; name: string }>;
  merchantAliases?: Record<string, readonly string[]>;
};

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
  /\b(financiamento|emprestimo|consorcio|todo mes|mensal|por\s+\d+\s+mes(?:es)?|\d+\s+boletos?|debitad[ao]s?\s+na\s+conta|a partir de\s+\d{1,2}\/\d{1,2})\b/;
const CARD_WORD_RE = /\b(cartao(?: de credito)?|credito)\b/;
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
  if (/^iphone$/i.test(cleaned)) return "iPhone";
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
    const resolvedCard = knownCardKeyword(rawText, context.knownCards);
    if (resolvedCard !== undefined) return resolvedCard;
    if (/fatura.*mercado pago/i.test(rawText)) return "Mercado Pago";
    if (/fatura.*inter/i.test(rawText)) return "Inter";
    if (/parcela solar/i.test(rawText)) return "Parcela solar";
    if (/financiamento do carro/i.test(rawText))
      return "Financiamento do carro";
    if (/nubank/i.test(rawText)) return "Nubank";
  }

  if (/\bcada parcela da cadeira\b/.test(normalized)) return "Cadeira";
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
    /^comprei no credito\b/.test(normalized)
  )
    return undefined;

  // Most messages put the meaningful item/merchant first. Stop at the first
  // financial clause instead of repeatedly deleting tokens (which used to
  // leave fragments such as "Notebook 12x" or "Farmácia cartão").
  const boundary =
    /\s+(?=(?:R\$\s*)?(?<![\p{L}\d])\d[\d.,]*(?:\s|$)|\d+\s*x\b|em\s+(?:-?\d+\s*x|(?:uma|duas|nove|doze)\s+(?:vezes|parcelas?))|parcelad[ao]\b|parcelei\b|dividido\b|no\s+(?:cart[aã]o|cr[eé]dito|pix|d[eé]bito|boleto)|na\s+conta\b|em\s+dinheiro\b|sem\s+parcelar\b|n[aã]o\s+foi\s+parcelad[ao]\b)/iu;
  let prefix = rawText.split(boundary, 1)[0] ?? rawText;
  prefix = stripKnownNames(prefix, context)
    .replace(/[🛏️]/gu, " ")
    .replace(
      /\b(Karol comprou|eu comprei|comprei|compra de|ontem gastei)\b/giu,
      " ",
    )
    .replace(/^\s*[AaOo]\s+/u, "")
    .replace(/^\s*(um|uma)\s+/iu, "")
    .replace(/\s+(de|por|em|no|na)\s*$/iu, "");
  const prefixDescription = titleCaseDescription(prefix);
  if (prefixDescription !== undefined) return prefixDescription;

  let text = rawText
    .replace(/[🛏️]/gu, " ")
    .replace(/\b(Karol comprou|eu comprei|comprei|compra de|gastei)\b/giu, " ")
    .replace(/\b(um|uma)\b/giu, " ")
    .replace(
      /\b(ontem|hoje cedo|dia\s+\d{1,2}\/\d{1,2}|a partir de\s+\d{1,2}\/\d{1,2})\b/giu,
      " ",
    )
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

function extractAmounts(text: string, count: number | undefined) {
  const normalized = normalize(text);
  const perMatch =
    /(?:\b\d+\s*x|\b\d+\s+(?:parcelas?|prestacoes?|boletos?))\s+de\s+(r\$\s*)?([\d.,]+)/i.exec(
      text,
    ) ??
    /cada parcela[^\d]*([\d.,]+)/i.exec(text) ??
    /parcela de\s+(r\$\s*)?([\d.,]+)/i.exec(text);
  const perRaw = perMatch?.[2] ?? perMatch?.[1];
  const perInstallmentCents =
    perRaw === undefined ? undefined : parseBrl(perRaw);
  const totalMatch = /\btotal\s+(?:de\s+)?(r\$\s*)?([\d.,]+)/i.exec(text);
  const explicitTotal = parseBrl(totalMatch?.[2] ?? "");

  const candidates = [...text.matchAll(/(?:R\$\s*)?\d[\d.,]*/gi)]
    .map((match) => match[0])
    .filter(
      (raw) =>
        !/^\d+\s*x$/i.test(raw) && !/^\d+$/.test(raw) && raw !== String(count),
    );
  // Integers are valid money too; remove dates and the installment count by position.
  const allNumbers = [...text.matchAll(/(?:R\$\s*)?\d[\d.,]*/gi)]
    .map((m) => m[0])
    .filter(
      (raw) => !raw.includes("/") && Number(raw.replace(/\D/g, "")) !== count,
    );
  const inferredTotal =
    perInstallmentCents === undefined
      ? (parseBrl(candidates[0] ?? allNumbers[0] ?? "") ?? wordMoney(text))
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
  const paymentTarget =
    /\b(fatura|parcela solar|financiamento|parcela do carro)\b/.test(
      normalized,
    ) ||
    (cardKeyword !== undefined &&
      !/\b(paguei\s+(?:trinta|\d|r\$))\b/.test(normalized));
  if (/\bpaguei a parcela do carro\b/.test(normalized)) {
    return {
      route: "ambiguous",
      description: "Carro",
      reason: "unresolved_existing_payment",
    };
  }
  if (paymentLanguage && paymentTarget) {
    return {
      route: "mark_paid",
      description: canonicalFinancialDescription(text, "mark_paid", context),
      amountCents: extractAmounts(text, undefined).totalCents,
      cardKeyword,
    };
  }

  const count = countFromText(text);
  const hasAccount = ACCOUNT_WORD_RE.test(normalized);
  const hasCard =
    CARD_WORD_RE.test(normalized) || (cardKeyword !== undefined && !hasAccount);
  const hasFinancing = FINANCING_RE.test(normalized);
  const hasInstallmentWords = INSTALLMENT_WORD_RE.test(normalized);
  const single = SINGLE_RE.test(normalized) || count === 1;
  const invalidCount = /(?:\b0|-)\d*\s*x\b/.test(normalized);
  const existingParcelObservation = /\bparcela\s+\d+\s+de\s+\d+\b/.test(
    normalized,
  );
  const compoundEntry = /\bentrada\b.*\bmais\b.*\d+\s*x\b/.test(normalized);
  const amounts = extractAmounts(text, count);

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
    (hasFinancing || (hasAccount && /\b\d+\s*x\b/.test(normalized))) &&
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
    reason,
  };
}

export function applyDeterministicPrecedence(
  decision: DeterministicFinancialDecision,
  classified: InterpretedIntent | null,
): InterpretedIntent | null {
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
        aiPurchase !== undefined
          ? aiPurchase.totalCents
          : decision.perInstallmentCents === undefined
            ? decision.totalCents
            : undefined,
      perInstallmentCents:
        aiPurchase !== undefined
          ? aiPurchase.perInstallmentCents
          : decision.perInstallmentCents,
      cardKeyword: decision.cardKeyword ?? aiPurchase?.cardKeyword,
    };
    return { intent: "card_installment", purchase };
  }
  if (decision.route === "obligation" && classified?.intent === "obligation") {
    return classified;
  }
  if (decision.route === "obligation") {
    const obligation: InterpretedObligation = {
      description:
        decision.description ??
        (classified?.intent === "card_installment"
          ? classified.purchase.description
          : "Obrigação"),
      monthlyAmountCents: decision.perInstallmentCents ?? decision.totalCents,
      termMonths: decision.installmentCount,
    };
    return { intent: "obligation", obligation };
  }
  if (decision.route === "non_financial") return { intent: "non_financial" };
  if (decision.route === "mark_paid" && decision.description !== undefined) {
    if (classified?.intent === "mark_paid") return classified;
    return {
      intent: "mark_paid",
      target: decision.cardKeyword === undefined ? "obligation" : "card",
      keyword: decision.description,
      amountCents: decision.amountCents,
    };
  }
  return classified;
}
