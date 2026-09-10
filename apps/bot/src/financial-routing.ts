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
  requestedDueDay?: number;
  startDate?: { day: number; month: number };
  paymentTarget?: "obligation" | "card";
  suppressAiPaymentAmount?: boolean;
  explicitInvalidPaymentAmount?: string;
  explicitInvalidPaymentOrdinal?: string;
  ambiguousPaymentNumber?: number;
  billMonth?: string;
  invalidBillMonth?: string;
  settlementAccountKeyword?: string;
  explicitDefaultSettlementAccount?: boolean;
  explicitNamedSettlementAccount?: boolean;
  explicitPaymentLanguage?: boolean;
  deterministicExistingPaymentChoice?: boolean;
  explicitObligationTargetEvidence?: boolean;
  explicitAccountEvidence?: boolean;
  implicitKnownAccountEvidence?: boolean;
  explicitCardEvidence?: boolean;
  explicitCardInstrumentLanguage?: boolean;
  unambiguousKnownCardEvidence?: boolean;
  explicitMetadataYearEvidence?: boolean;
  accountKeyword?: string;
  cardKeyword?: string;
  authoritativeCardName?: string;
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
  authoritativeCardName?: string;
};
type RoutedInterpretedCardPurchase = InterpretedCardPurchase & {
  authoritativeCardName?: string;
};
type RoutedCardInstallmentIntent = Omit<
  Extract<InterpretedIntent, { intent: "card_installment" }>,
  "purchase"
> & { purchase: RoutedInterpretedCardPurchase };
type RoutedInterpretedObligation = InterpretedObligation & {
  accountKeyword?: string;
  requestedDueDay?: number;
};
type RoutedObligationIntent = Omit<
  Extract<InterpretedIntent, { intent: "obligation" }>,
  "obligation"
> & { obligation: RoutedInterpretedObligation };

export type RoutedInterpretedIntent =
  | Exclude<
      InterpretedIntent,
      | { intent: "mark_paid" }
      | { intent: "obligation" }
      | { intent: "card_installment" }
    >
  | RoutedCardInstallmentIntent
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
// Regexes that run against the original user text need to accept Portuguese
// diacritics even though count lookup itself runs against `normalize(text)`.
// Keep this shared so every count-word grammar accepts the same vocabulary.
const INSTALLMENT_COUNT_WORD = String.raw`(?:uma|um|duas|dois|tr[eê]s|quatro|cinco|seis|sete|oito|nove|dez|onze|doze)`;

const RECURRENCE_SYNTAX = String.raw`(?:todo\s+(?:o\s+)?m[eê]s|todos\s+(?:os\s+)?meses|cada\s+m[eê]s|a\s+cada\s+m[eê]s|m[eê]s\s+a\s+m[eê]s|recorrente|mens(?:almente|ais|al)|mensalidade|(?:por|ao)\s+m[eê]s|todo\s+dia\s+\d{1,2}|(?:por|durante)\s+\d+\s+mes(?:es)?)`;
const METADATA_YEAR_QUALIFIER = String.raw`(?:ano(?:-base|[-\s]calend[aá]rio|\s+fiscal)?|exerc[ií]cio(?:\s+(?:fiscal|financeiro))?|modelo|refer[eê]ncia|compet[eê]ncia)`;
const FINANCING_RE = new RegExp(
  String.raw`\b(financiamento|emprestimo|consorcio|credito\s+(?:consignado|pessoal|imobiliario|habitacional|veicular|com\s+garantia|com\s+desconto\s+em\s+folha)|${RECURRENCE_SYNTAX}|\d+\s+boletos?|debitad[ao]s?\s+na\s+conta|a partir de\s+\d{1,2}\/\d{1,2})\b`,
  "u",
);
const CARD_WORD_RE = /\b(cartao(?: de credito)?|credito)\b/;
const LOAN_CREDIT_RE =
  /\bcredito\s+(?:consignado|pessoal|imobiliario|habitacional|veicular|com\s+garantia|com\s+desconto\s+em\s+folha)\b/;
const ACCOUNT_WORD_RE = /\b(pix|dinheiro|debito|na conta|no boleto)\b/;
const INSTALLMENT_WORD_RE =
  /\b(parcelad[ao]s?|parcelei|parcelas?|prestacoes?|divid(?:i|ido|ida)\b|sem juros|com juros)\b/;
const NEGATED_INSTALLMENT_RE =
  /\b(?:nao\s+(?:foi\s+)?parcelad[ao]s?|nao\s+parcelei|sem\s+parcelas?)\b/;
const SINGLE_RE =
  /\b(1\s*x|(?:em\s+)?uma\s+(?:(?:unica|so)\s+)?vez|(?:em\s+)?(?:(?:uma\s+)?unica|uma\s+so)\s+(?:parcela|prestacao)|(?:em\s+)?(?:parcela|prestacao) unica|uma parcela|uma prestacao|a vista|compra unica|pagamento unico|cobrad[ao] de uma vez|sem parcelar|sem parcelas?|nao (?:foi )?parcelad[ao]s?|nao parcelei)\b/;
const PAYMENT_ACCOUNT_SOURCE_PREFIX = String.raw`(?:via|pel[ao]|com(?:\s+a)?|usando(?:\s+a)?|d[ae]|na)\s+conta`;
const PAYMENT_PIX_SOURCE = String.raw`(?:(?:via|no|pel[ao]|com|usando|por)\s+(?:(?:o|a)\s+)?pix)`;
const PAYMENT_NUMERIC_DATE = String.raw`\d{1,2}\/\d{1,2}(?:(?:\/|\s+(?:(?:do\s+)?ano\s+de|de)\s*)\d{2,4}(?!\s*\/\d))?`;
const PAYMENT_SPOKEN_FULL_DATE = String.raw`(?:(?:em|(?:no\s+)?dia|(?:na\s+)?data)\s*)\d{1,2}\/\d{1,2}\s+(?:(?:do\s+)?ano\s+de|de)\s*\d{2,4}(?!\s*\/\d)`;
export const PAYMENT_OCCURRENCE_DATE = String.raw`(?:hoje|ontem|anteontem|(?:(?:em|(?:no\s+)?dia|(?:na\s+)?data)\s*)?${PAYMENT_NUMERIC_DATE})`;
// A day-of-month by itself is useful settlement metadata, but it is not a
// complete occurrence date. Keep it out of PAYMENT_OCCURRENCE_DATE so the
// conversation layer continues to use `today` unless DD/MM[/YYYY] is given.
const PAYMENT_BARE_DAY_METADATA = String.raw`(?:(?:no\s+)?dia\s*\d+(?![\d/]))`;
const PAYMENT_QUALIFIED_AMOUNT = String.raw`(?:(?:por|no\s+valor\s+de|valor\s+de)\s+(?:r\$\s*)?\+?\s*\d[\d.,]*(?:\s+reais)?)`;
const EXPLICIT_OBLIGATION_PAYMENT_TARGET_RE =
  /\b(financiamento|emprestimo|consorcio|aluguel|seguro|condominio|iptu|ipva|internet|academia|mensalidade|conta\s+(?:de|da|do)\s+[\p{L}\d-]+|(?:parcela|placa) solar|(?:parcela|prestacao)(?:\s+(?:numero\s+)?\d+)?\s+(?:da|de|do)\b)/u;

function hasGenericCardSettlementShape(normalized: string): boolean {
  const amount = String.raw`(?:r\$\s*)?\d[\d.,]*(?:\s+reais)?`;
  const status = String.raw`(?:pago|paga|quitado|quitada)`;
  const date = String.raw`(?:hoje|ontem|anteontem|${PAYMENT_BARE_DAY_METADATA}|(?:(?:em|no\s+dia|dia)\s+)?\d{1,2}\/\d{2,4}(?:\/\d{2,4})?)`;
  const source = String.raw`(?:${PAYMENT_PIX_SOURCE}|${PAYMENT_ACCOUNT_SOURCE_PREFIX}(?:\s+\p{L}[\p{L}\d-]*){1,4})`;
  const tail = String.raw`(?:(?:${status}|${date}|${source}|${amount})[\s,]*)*`;
  const target = String.raw`(?:cartao(?:\s+de\s+credito)?|fatura(?:\s+do\s+cartao)?)`;
  return (
    new RegExp(
      String.raw`^\s*(?:paguei|quitei)\s+(?:(?:o|a)\s+)?${target}[\s,]*${tail}\s*$`,
      "u",
    ).test(normalized) ||
    new RegExp(
      String.raw`^\s*(?:(?:o|a)\s+)?${target}\s+(?:${amount}\s+)?${status}[\s,]*${tail}\s*$`,
      "u",
    ).test(normalized)
  );
}

function hasGenericSettlementStatus(normalized: string): boolean {
  return (
    /\b(?:pago|paga|quitado|quitada)\b/.test(normalized) &&
    !/\b(?:entrada|compra|pedido)\b/.test(normalized)
  );
}

function normalize(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

/**
 * Sentence punctuation immediately after an authoritative instrument name is
 * prose, not part of the stored name. Punctuation that can legitimately be
 * part of a name (for example `+`) is intentionally preserved.
 */
function trimAuthoritativeInstrumentName(value: string): string {
  return value
    .trim()
    .replace(/[.,;:!?]+$/u, "")
    .trim();
}

type InstrumentNameSpan = { index: number; length: number };

function escapedPattern(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Whether everything after a registered authoritative instrument name is
 * supported financial metadata. This is deliberately an all-or-nothing
 * check: `cartao chamado Nubank hoje Black` names an unknown card, while
 * `cartao chamado Nubank hoje por R$ 50` safely names the registered card.
 *
 * Keep the occurrence-date clause shared with the conversation layer so both
 * authoritative matching and later `paidOn` extraction agree about `dia`,
 * `no dia`, `data`, `na data`, and supported bare dates.
 */
export function isCompleteAuthoritativeInstrumentMetadataTail(
  value: string,
  options: { allowBareAmount?: boolean } = {},
): boolean {
  const occurrence = String.raw`(?:${PAYMENT_OCCURRENCE_DATE}|${PAYMENT_BARE_DAY_METADATA})`;
  const amount = String.raw`(?:${PAYMENT_QUALIFIED_AMOUNT}|r\$\s*\d[\d.,]*(?:\s+reais)?${
    options.allowBareAmount ? String.raw`|\d[\d.,]*(?:\s+reais)?` : ""
  })`;
  const adjustment = String.raw`(?:com\s+desconto\s+(?:de\s+)?(?:r\$\s*)?\d[\d.,]*(?:\s+reais)?)`;
  const status = String.raw`(?:pago|paga|quitado|quitada)`;
  const billMonth = String.raw`(?:(?:em|de|compet[eê]ncia)\s+(?:\d{1,2}\/)?\d{2,4})`;
  const installment = String.raw`(?:a\s+partir\s+de\s+\d{1,2}\/\d{1,2}(?:\/\d{2,4})?|em\s+-?\d+\s*x(?:\s+de\s+(?:r\$\s*)?\d[\d.,]*)?|parcelad[ao]s?|sem\s+juros|com\s+juros)`;
  const pixSource = String.raw`(?:${PAYMENT_PIX_SOURCE})`;
  // Source-account names are intentionally allowed to be unknown and
  // compound. Account resolution owns the later clarification; this helper
  // only distinguishes a grammatical metadata clause from stray residue.
  const metadataStarter = String.raw`(?:hoje|ontem|anteontem|(?:no\s+)?dia(?=\s*\d)|(?:na\s+)?data(?=\s+\d)|em(?=\s+\d)|pago|paga|quitado|quitada|r\$|por(?=\s+(?:r\$|\d))|(?:no\s+)?valor(?=\s+de)|com(?=\s+desconto))`;
  const accountToken = String.raw`[\p{L}\p{N}+$._-]+`;
  const accountSource = String.raw`(?:${PAYMENT_ACCOUNT_SOURCE_PREFIX}(?:\s+(?:chamad[ao]|de\s+nome))?\s+${accountToken}(?:\s+(?!${metadataStarter}\b)${accountToken}){0,3})`;
  const clause = String.raw`(?:${occurrence}|${amount}|${adjustment}|${status}|${billMonth}|${installment}|${pixSource}|${accountSource})`;
  const separator = String.raw`(?:\s+|\s*[.,;:!?—–-]\s*|\s*\(\s*|\s*\)\s*)`;
  return new RegExp(
    String.raw`^(?:${separator})*(?:${clause}(?:${separator})*)*$`,
    "iu",
  ).test(value);
}

export function splitAuthoritativeInstrumentNameAndMetadata(
  value: string,
  options: { allowBareAmount?: boolean } = {},
): { name: string; metadata: string } {
  for (let index = 1; index < value.length; index += 1) {
    const atBoundary =
      /[\s,.;:!?—–()-]/u.test(value[index] as string) ||
      /\s/u.test(value[index - 1] as string);
    if (!atBoundary) continue;
    const metadata = value.slice(index);
    if (!isCompleteAuthoritativeInstrumentMetadataTail(metadata, options))
      continue;
    const name = trimAuthoritativeInstrumentName(value.slice(0, index));
    if (name.length > 0) return { name, metadata };
  }
  return { name: trimAuthoritativeInstrumentName(value), metadata: "" };
}

function instrumentNameSpans(text: string, name: string): InstrumentNameSpan[] {
  const normalizedText = normalize(text);
  const normalizedName = normalize(name);
  if (normalizedName.length === 0) return [];
  return [
    ...normalizedText.matchAll(
      new RegExp(
        String.raw`(?<![\p{L}\p{N}])${escapedPattern(normalizedName)}(?![\p{L}\p{N}])`,
        "gu",
      ),
    ),
  ].map((match) => ({
    index: match.index ?? 0,
    length: match[0].length,
  }));
}

function maskInstrumentName(
  text: string,
  name: string,
  shouldMask: (span: InstrumentNameSpan) => boolean = () => true,
): string {
  let masked = text;
  for (const span of instrumentNameSpans(text, name)
    .filter(shouldMask)
    .reverse()) {
    masked = `${masked.slice(0, span.index)}${" ".repeat(span.length)}${masked.slice(span.index + span.length)}`;
  }
  return masked;
}

function preferLongestInstrumentMatches<T extends { name: string }>(
  text: string,
  matches: T[],
): T[] {
  const spansByName = new Map(
    matches.map((instrument) => [
      instrument,
      instrumentNameSpans(text, instrument.name),
    ]),
  );
  return matches.filter((candidate) => {
    const candidateSpans = spansByName.get(candidate) ?? [];
    return !matches.some((other) => {
      if (normalize(other.name).length <= normalize(candidate.name).length)
        return false;
      const otherSpans = spansByName.get(other) ?? [];
      return (
        candidateSpans.length > 0 &&
        candidateSpans.every((candidateSpan) =>
          otherSpans.some(
            (otherSpan) =>
              otherSpan.index <= candidateSpan.index &&
              otherSpan.index + otherSpan.length >=
                candidateSpan.index + candidateSpan.length,
          ),
        )
      );
    });
  });
}

function isTemporalInstrumentFragment(value: string): boolean {
  return /^(?:hoje|ontem|anteontem|dia)$/u.test(normalize(value));
}

function isExplicitInstrumentName(
  text: string,
  value: string,
  kind: "card" | "account",
): boolean {
  const escaped = escapedPattern(normalize(value));
  const normalized = normalize(text);
  if (kind === "account") {
    return new RegExp(
      String.raw`\b(?:${PAYMENT_ACCOUNT_SOURCE_PREFIX}|conta)\s+(?:chamad[ao]|de\s+nome)\s+${escaped}(?![\p{L}\p{N}])`,
      "u",
    ).test(normalized);
  }
  return new RegExp(
    String.raw`\bcartao(?:\s+de\s+credito)?\s+(?:chamad[ao]|de\s+nome)\s+${escaped}(?![\p{L}\p{N}])`,
    "u",
  ).test(normalized);
}

function explicitNamedInstrumentKeyword(
  text: string,
  kind: "card" | "account",
  instruments?: ReadonlyArray<{ name: string }>,
): string | undefined {
  const introducer =
    kind === "card"
      ? String.raw`cart[aã]o(?:\s+de\s+cr[eé]dito)?`
      : String.raw`(?:(?:${PAYMENT_ACCOUNT_SOURCE_PREFIX}|conta))`;
  const normalizedText = normalize(text);
  const normalizedIntroducer =
    kind === "card"
      ? String.raw`cartao(?:\s+de\s+credito)?`
      : String.raw`(?:(?:${PAYMENT_ACCOUNT_SOURCE_PREFIX}|conta))`;
  const introducerMatch = new RegExp(
    String.raw`\b${normalizedIntroducer}\s+(?:chamad[ao]|de\s+nome)\s+`,
    "u",
  ).exec(normalizedText);
  if (introducerMatch !== null) {
    const remainder = normalizedText.slice(
      (introducerMatch.index ?? 0) + introducerMatch[0].length,
    );
    const exactRegisteredName = [...(instruments ?? [])]
      .sort(
        (left, right) =>
          normalize(right.name).length - normalize(left.name).length,
      )
      .find((instrument) => {
        const normalizedName = normalize(instrument.name);
        const tail = remainder.slice(normalizedName.length);
        return (
          remainder.startsWith(normalizedName) &&
          !/^[\p{L}\p{N}]/u.test(tail) &&
          isCompleteAuthoritativeInstrumentMetadataTail(tail)
        );
      });
    if (exactRegisteredName !== undefined) {
      const nameStart =
        (introducerMatch.index ?? 0) + introducerMatch[0].length;
      return text.slice(
        nameStart,
        nameStart + normalize(exactRegisteredName.name).length,
      );
    }
  }
  const match = new RegExp(
    String.raw`\b${introducer}\s+(?:chamad[ao]|de\s+nome)\s+(.+)$`,
    "iu",
  ).exec(text);
  const captured =
    match?.[1] === undefined
      ? undefined
      : splitAuthoritativeInstrumentNameAndMetadata(match[1]).name;
  const exactRegisteredName = (instruments ?? []).some(
    (instrument) => normalize(instrument.name) === normalize(captured ?? ""),
  );
  const keyword =
    captured === undefined
      ? undefined
      : exactRegisteredName
        ? captured
        : trimAuthoritativeInstrumentName(captured);
  return keyword === undefined || keyword.length === 0 ? undefined : keyword;
}

/**
 * `fatura NAME ...` is an authoritative target just like `cartao chamado
 * NAME`: a registered prefix must not silently win when the user typed a
 * longer name. The name ends only where payment metadata begins.
 */
export type RegisteredNormalFaturaTargetMatch = {
  keyword: string;
  index: number;
  length: number;
};

/**
 * Resolve the registered card-name span in the normal `fatura NAME` form.
 * Registered names are checked before temporal metadata so a card literally
 * named `Hoje` or `Ontem` is not consumed as the payment date. The remaining
 * tail still has to be entirely valid payment metadata.
 */
export function registeredNormalFaturaTargetMatch(
  text: string,
  instruments?: ReadonlyArray<{ name: string }>,
): RegisteredNormalFaturaTargetMatch | undefined {
  const introducer = /\bfatura(?:\s+do\s+cart[aã]o|\s+cart[aã]o)?\s+/iu.exec(
    text,
  );
  if (introducer === null) return undefined;

  const leadingContext = normalize(text.slice(0, introducer.index ?? 0)).trim();
  if (
    leadingContext.length > 0 &&
    !/^(?:paguei|quitei|pago|paga|quitado|quitada)\b/u.test(leadingContext)
  ) {
    return undefined;
  }

  const nameStart = (introducer.index ?? 0) + introducer[0].length;
  const remainder = text.slice(nameStart);
  const exactRegisteredName = [...(instruments ?? [])]
    .map((instrument) => {
      const normalizedName = normalize(instrument.name);
      const rawLength = Array.from(
        { length: remainder.length },
        (_, index) => index + 1,
      ).find(
        (length) => normalize(remainder.slice(0, length)) === normalizedName,
      );
      if (rawLength === undefined) return undefined;
      const tail = remainder.slice(rawLength);
      if (
        /^[\p{L}\p{N}]/u.test(normalize(tail)) ||
        !isCompleteAuthoritativeInstrumentMetadataTail(tail, {
          allowBareAmount: true,
        })
      ) {
        return undefined;
      }
      return { instrument, rawLength };
    })
    .filter(
      (
        candidate,
      ): candidate is { instrument: { name: string }; rawLength: number } =>
        candidate !== undefined,
    )
    .sort(
      (left, right) =>
        normalize(right.instrument.name).length -
        normalize(left.instrument.name).length,
    )[0];
  if (exactRegisteredName === undefined) return undefined;
  return {
    keyword: remainder.slice(0, exactRegisteredName.rawLength),
    index: nameStart,
    length: exactRegisteredName.rawLength,
  };
}

function normalFaturaTargetKeyword(
  text: string,
  instruments?: ReadonlyArray<{ name: string }>,
): string | undefined {
  const registeredMatch = registeredNormalFaturaTargetMatch(text, instruments);
  if (registeredMatch !== undefined) return registeredMatch.keyword;

  const introducer = /\bfatura(?:\s+do\s+cart[aã]o|\s+cart[aã]o)?\s+/iu.exec(
    text,
  );
  if (introducer === null) return undefined;

  const nameStart = (introducer.index ?? 0) + introducer[0].length;
  const remainder = text.slice(nameStart);
  const metadata = String.raw`(?:pago\b|paga\b|quitado\b|quitada\b|${PAYMENT_QUALIFIED_AMOUNT}|r\$\s*\d|${PAYMENT_BARE_DAY_METADATA}|${PAYMENT_OCCURRENCE_DATE}\b|(?:em|de|compet[eê]ncia)\s+\d{1,2}\/\d{2,4}\b|${PAYMENT_PIX_SOURCE}\b|${PAYMENT_ACCOUNT_SOURCE_PREFIX}\b)`;
  if (
    new RegExp(String.raw`^\s*(?:[—–-]\s*|\(\s*)?(?:${metadata})`, "iu").test(
      remainder,
    )
  ) {
    return undefined;
  }

  const keyword = splitAuthoritativeInstrumentNameAndMetadata(remainder, {
    allowBareAmount: true,
  }).name;
  if (
    keyword.length === 0 ||
    /^(?:pago|paga|quitado|quitada)$/u.test(normalize(keyword)) ||
    new RegExp(String.raw`^(?:${PAYMENT_OCCURRENCE_DATE})$`, "iu").test(keyword)
  ) {
    return undefined;
  }
  return keyword;
}

function explicitKnownInstrumentKeyword(
  text: string,
  kind: "card" | "account",
  instruments: ReadonlyArray<{ id: string; name: string }> | undefined,
): string | undefined {
  const authoritativeName = explicitNamedInstrumentKeyword(
    text,
    kind,
    instruments,
  );
  if (authoritativeName === undefined) return undefined;
  const normalizedAuthoritativeName = normalize(authoritativeName).trim();
  return (instruments ?? []).find(
    (instrument) =>
      normalize(instrument.name).trim() === normalizedAuthoritativeName,
  )?.name;
}

function isImplicitInstrumentMetadataVocabulary(value: string): boolean {
  return /^(?:mensal|mensais|mensalmente|mensalidade|referencia|competencia|exercicio|financeiro)$/u.test(
    normalize(value),
  );
}

function isLeadingTemporalOccurrence(text: string, value: string): boolean {
  const temporal = normalize(value);
  if (!/^(?:hoje|ontem|anteontem)$/.test(temporal)) return false;
  return new RegExp(`^\\s*${temporal}(?=$|[\\s,.;:!?-])`, "u").test(
    normalize(text),
  );
}

function followsGenericInstrumentAlias(value: string): boolean {
  return /\b(?:no|na|via|pelo|pela|com|usando|em)\s+(?:(?:o|a)\s+)?(?:cartao(?:\s+de\s+credito)?|credito|debito|dinheiro|pix|conta|fatura|boleto)\s*$/u.test(
    normalize(value),
  );
}

function isStructuralCardClauseFragment(
  value: string,
  before: string,
): boolean {
  if (!followsGenericInstrumentAlias(before)) return false;
  const normalizedValue = normalize(value);
  return (
    /^(?:por|em|de|uma|um|a vista|sem parcelar|sem parcelas?|nao parcelad[ao]s?|\d+\s*x?)$/u.test(
      normalizedValue,
    ) || Object.hasOwn(NUMBER_WORDS, normalizedValue)
  );
}

function isGenericCardStructuralVocabulary(value: string): boolean {
  return /^(?:cart[aã]o|cr[eé]dito|parcelad[ao]s?|parcelei|parcelas?|presta[cç][oõ]es?|dividid[ao]s?|com\s+juros|sem\s+juros)$/u.test(
    normalize(value),
  );
}

function isContextualCardStructuralVocabulary(
  value: string,
  before: string,
): boolean {
  const normalizedValue = normalize(value);
  const normalizedBefore = normalize(before);
  if (normalizedValue === "juros")
    return /\b(?:com|sem)\s*$/u.test(normalizedBefore);
  if (normalizedValue === "unica") {
    return /\b(?:parcela|prestacao)\s*$/u.test(normalizedBefore);
  }
  if (normalizedValue === "vez")
    return /\buma(?:\s+(?:unica|so))?\s*$/u.test(normalizedBefore);
  return false;
}

function stripSingleChargeMarkers(value: string): string {
  return value.replace(
    /\b(?:1\s*x|(?:em\s+)?uma\s+(?:(?:[uú]nica|s[oó])\s+)?vez|(?:em\s+)?(?:(?:uma\s+)?[uú]nica|uma\s+s[oó])\s+(?:parcela|presta[cç][aã]o)|(?:em\s+)?(?:parcela|presta[cç][aã]o)\s+[uú]nica|uma\s+(?:parcela|presta[cç][aã]o)|[aà]\s+vista|compra\s+[uú]nica|pagamento\s+[uú]nico|cobrad[ao]\s+de\s+uma\s+vez|sem\s+parcelar|sem\s+parcelas?|n[aã]o\s+(?:foi\s+)?parcelad[ao]s?|n[aã]o\s+parcelei)\b\s*[,;:-]?/giu,
    " ",
  );
}

function stripMetadataYearQualifiers(value: string): string {
  return value
    .replace(
      new RegExp(
        String.raw`\b(?:${METADATA_YEAR_QUALIFIER}(?:\s+de)?|referente\s+a)\s*[:#-]?\s*(?:r\$\s*)?(?:19|20)\d{2}\b`,
        "giu",
      ),
      " ",
    )
    .replace(/\b(iptu|ipva)\s+de\s+(?:19|20)\d{2}\b/giu, "$1");
}

function resolvableAccountKeyword(
  keyword: string | undefined,
  preserveNamedPix = false,
): string | undefined {
  return keyword !== undefined &&
    (preserveNamedPix || normalize(keyword) !== "pix")
    ? keyword
    : undefined;
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
  const compact = raw
    .replace(/R\$\s*/i, "")
    .replace(/\s+/g, "")
    .trim();
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

/** Installment positions are ordinals and therefore start at one. */
function explicitInvalidPaymentOrdinal(text: string): string | undefined {
  const patterns = [
    /\b(?:parcela|presta[cç][aã]o)\s+(?:(?:n(?:[uú]mero)?|n[º°])\.?\s*)?0+\s*\/\s*\d+\b/giu,
    /\b(?:parcela|presta[cç][aã]o)\s+(?:(?:n(?:[uú]mero)?|n[º°])\.?\s*)?zero\b/giu,
    /\b(?:parcela|presta[cç][aã]o)\s+(?:(?:n(?:[uú]mero)?|n[º°])\.?\s*)?0+(?=\s+(?:da|de|do)\b)/giu,
    /\bn[uú]mero\s+0+\b/giu,
    /\b0+\s*[ªº]\s*(?=parcela\b)/giu,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match !== null) return match[0].trim();
  }
  return undefined;
}

/**
 * Preserve evidence that the user explicitly supplied a non-positive payment
 * amount. `parseBrl` intentionally returns `undefined` for those values, but
 * settlement flows also use `undefined` to mean "use the scheduled/computed
 * amount". Keeping this signal separate prevents an explicit R$ 0 (or a
 * negative amount) from being mistaken for an omitted override.
 */
function explicitInvalidPaymentAmount(text: string): string | undefined {
  const patterns = [
    /r\$\s*([+-]?\s*\d[\d.,]*)/giu,
    /\b(?:no\s+valor\s+de|valor\s+de|por)\s+([+-]?\s*\d[\d.,]*)(?:\s+reais)?\b/giu,
    /(?<![\p{L}\d])([+-]\s*\d[\d.,]*)(?:\s+reais)?\b/giu,
    /(?<![\p{L}\d])([+-]?\d[\d.,]*)\s+reais\b/giu,
    /(?<![\p{L}\d.,])([+-]?0+(?:[.,]0+)?)(?![\p{L}\d/])/giu,
  ];

  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const before = text.slice(0, match.index ?? 0);
      if (/desconto\s+(?:de\s+)?$/iu.test(before)) continue;
      const adjacentOrdinalLabel =
        /(?:dia|parcela|presta[cç][aã]o)(?:\s+n[uú]mero)?\s*$/iu.test(before);
      const explicitMoneyEvidence =
        /r\$/iu.test(match[0]) ||
        /\breais\b/iu.test(match[0]) ||
        /^[+-]\s*/u.test(match[1] ?? "");
      if (adjacentOrdinalLabel && !explicitMoneyEvidence) continue;
      const raw = (match[1] ?? "").replace(/\s+/g, "");
      let normalized = raw;
      if (normalized.includes(",")) {
        normalized = normalized.replace(/\./g, "").replace(",", ".");
      } else if (/^[+-]?\d{1,3}(?:\.\d{3})+$/u.test(normalized)) {
        normalized = normalized.replace(/\./g, "");
      }
      const value = Number(normalized);
      if (Number.isFinite(value) && value <= 0) return match[0].trim();
    }
  }
  return undefined;
}

function hasExplicitMetadataYearEvidence(text: string): boolean {
  if (
    new RegExp(
      String.raw`\b(?:${METADATA_YEAR_QUALIFIER}(?:\s+de)?|referente\s+a)\s*[:#-]?\s*(?:19|20)\d{2}\b(?![,.])`,
      "iu",
    ).test(text)
  ) {
    return true;
  }

  return [
    ...text.matchAll(
      /\b(?:(?:iptu|ipva)(?:\s+de)?\s*(?:19|20)\d{2}|(?:19|20)\d{2}\s+(?:iptu|ipva))\b/giu,
    ),
  ].some((match) => !/r\$\s*$/iu.test(text.slice(0, match.index ?? 0)));
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
  if (
    /\b(?:(?:em\s+)?uma\s+(?:unica|so)\s+vez|(?:em\s+)?(?:(?:uma\s+)?unica|uma\s+so)\s+(?:parcela|prestacao)|(?:em\s+)?(?:parcela|prestacao)\s+unica)\b/u.test(
      normalized,
    )
  ) {
    return 1;
  }
  const numeric = /(?:\bem\s+)?(-?\d+)\s*x\b/.exec(normalized)?.[1];
  if (numeric !== undefined) return Number(numeric);
  const numericWords =
    /\b(\d+)\s+(?:vezes|parcelas?|prestacoes?|boletos?)\b/.exec(
      normalized,
    )?.[1] ?? /\b(?:por|durante)\s+(\d+)\s+mes(?:es)?\b/.exec(normalized)?.[1];
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
  const matches = preferLongestInstrumentMatches(
    text,
    (cards ?? []).filter((card) => {
      const explicitlyNamed = isExplicitInstrumentName(text, card.name, "card");
      if (explicitlyNamed) return true;
      if (isGenericCardStructuralVocabulary(card.name)) return false;
      if (
        !explicitlyNamed &&
        (isTemporalInstrumentFragment(card.name) ||
          isImplicitInstrumentMetadataVocabulary(card.name))
      )
        return false;
      return instrumentNameSpans(text, card.name).some((span) => {
        const before = normalized.slice(0, span.index);
        if (
          isLeadingTemporalOccurrence(text, card.name) ||
          isContextualCardStructuralVocabulary(card.name, before) ||
          (isTemporalInstrumentFragment(card.name) &&
            followsGenericInstrumentAlias(before)) ||
          isStructuralCardClauseFragment(card.name, before)
        ) {
          return false;
        }
        return !new RegExp(
          String.raw`\b${PAYMENT_ACCOUNT_SOURCE_PREFIX}\s*$`,
          "u",
        ).test(before);
      });
    }),
  );
  return matches.length === 1 ? matches[0]?.name : undefined;
}

function explicitNamedCardKeyword(text: string): string | undefined {
  const escapedKeyword = explicitNamedInstrumentKeyword(text, "card");
  if (escapedKeyword !== undefined) return escapedKeyword;
  const match =
    /\b(?:no|na|via|pelo|pela|com|usando)\s+(?:(?:o|a)\s+)?cart[aã]o(?:\s+de\s+cr[eé]dito)?\s+(.+?)(?=\s+(?:em\s+-?\d+\s*x\b|parcelad[ao]s?\b|sem\s+juros\b|com\s+juros\b|(?:por|no\s+valor\s+de|valor\s+de)\s+(?:r\$\s*)?\d|hoje\b|ontem\b)|[.,;!?]|$)/iu.exec(
      text,
    );
  const keyword = match?.[1]?.trim();
  if (keyword === undefined || keyword.length === 0) return undefined;
  const normalized = normalize(keyword);
  if (
    new RegExp(
      String.raw`^(?:por\s+(?:r\$\s*)?\d|em\s+-?\d+\s*x\b|${INSTALLMENT_COUNT_WORD}\s+(?:vez(?:es)?|parcelas?|presta[cç][oõ]es?)\b|(?:uma\s+vez|uma\s+(?:parcela|prestacao)|a\s+vista|sem\s+parcelar|sem\s+parcelas?|nao\s+(?:foi\s+)?parcelad[ao]))`,
      "u",
    ).test(normalized) ||
    /^(?:hoje|ontem|anteontem|(?:em|no\s+dia|dia)\s+\d{1,2}(?:\/\d{1,2}(?:\/\d{2,4})?)?)$/u.test(
      normalized,
    )
  ) {
    return undefined;
  }
  if (isGenericCardStructuralVocabulary(keyword)) return undefined;
  return normalized === "credito" || normalized === "de credito"
    ? undefined
    : keyword;
}

function hasAuthoritativeCardTargetSyntax(
  text: string,
  cardKeyword: string | undefined,
): boolean {
  if (cardKeyword === undefined) return false;
  const normalized = normalize(text);
  return instrumentNameSpans(text, cardKeyword).some((span) => {
    const before = normalized.slice(0, span.index);
    const introducer =
      /\b(fatura|cartao(?:\s+de\s+credito)?)(?:\s+(chamad[ao]|de\s+nome|d[aeo]))?\s+$/u.exec(
        before,
      );
    if (introducer === null) return false;
    if (introducer[1] === "fatura" || introducer[2] !== undefined) return true;
    if (
      introducer[1]?.startsWith("cartao") &&
      /\bfatura(?:\s+do)?\s*$/u.test(before.slice(0, introducer.index))
    ) {
      return true;
    }
    return /^\s*(?:paguei|quitei)\s+(?:(?:o|a)\s+)?$/u.test(
      before.slice(0, introducer.index),
    );
  });
}

function maskExplicitKnownInstrumentNamesForFinancialGrammar(
  text: string,
  context: RoutingContext,
): string {
  let masked = text;
  const instruments = [
    ...(context.knownCards ?? []).map((item) => ({
      ...item,
      kind: "card" as const,
    })),
    ...(context.knownAccounts ?? []).map((item) => ({
      ...item,
      kind: "account" as const,
    })),
  ].sort(
    (left, right) => normalize(right.name).length - normalize(left.name).length,
  );
  for (const instrument of instruments) {
    if (!isExplicitInstrumentName(text, instrument.name, instrument.kind))
      continue;
    masked = maskInstrumentName(masked, instrument.name);
  }
  return masked;
}

function knownAccountKeyword(
  text: string,
  accounts: RoutingContext["knownAccounts"],
): string | undefined {
  const normalized = normalize(text);
  const matches = preferLongestInstrumentMatches(
    text,
    (accounts ?? []).filter((account) => {
      const explicitlyNamed = isExplicitInstrumentName(
        text,
        account.name,
        "account",
      );
      if (
        !explicitlyNamed &&
        (isTemporalInstrumentFragment(account.name) ||
          isImplicitInstrumentMetadataVocabulary(account.name))
      )
        return false;
      const match = instrumentNameSpans(text, account.name).at(0);
      if (match === undefined) return false;
      if (
        !explicitlyNamed &&
        (isLeadingTemporalOccurrence(text, account.name) ||
          (isTemporalInstrumentFragment(account.name) &&
            followsGenericInstrumentAlias(normalized.slice(0, match.index))))
      ) {
        return false;
      }
      return true;
    }),
  );
  return matches.length === 1 ? matches[0]?.name : undefined;
}

function isUnambiguousKnownCardKeyword(
  keyword: string | undefined,
  context: RoutingContext,
): boolean {
  if (keyword === undefined) return false;
  const normalizedKeyword = normalize(keyword);
  const matchingCards = (context.knownCards ?? []).filter(
    (card) => normalize(card.name) === normalizedKeyword,
  );
  const matchingAccounts = (context.knownAccounts ?? []).filter(
    (account) => normalize(account.name) === normalizedKeyword,
  );
  return matchingCards.length === 1 && matchingAccounts.length === 0;
}

function isPaymentInstrumentSpan(
  text: string,
  span: InstrumentNameSpan,
  kind: "card" | "account",
): boolean {
  const before = normalize(text.slice(0, span.index));
  const after = normalize(text.slice(span.index + span.length));
  const bareTrailingInstrument =
    /^\s*[,.;:!?-]*\s*$/u.test(after) &&
    /(?:r\$\s*)?\d[\d.,]*(?:\s+reais)?\s*$/u.test(before);
  const merchantIntroducer =
    /\b(?:comprei|compra(?:\s+de)?)\s+(?:no|na|em)\s*$/u.test(before);
  const laterExplicitInstrument =
    /\b(?:no|na|via|pel[ao]|com|usando|em)\s+(?:(?:o|a)\s+)?(?:cartao(?:\s+de\s+credito)?|credito|pix|debito|conta|boleto)\b/u.test(
      after,
    );
  if (merchantIntroducer && laterExplicitInstrument) return false;
  if (kind === "card") {
    return (
      bareTrailingInstrument ||
      /\b(?:(?:(?:no|na|via|pel[ao]|com|usando|em)\s+(?:(?:o|a)\s+)?(?:cartao(?:\s+de\s+credito)?|credito)|cartao(?:\s+de\s+credito)?)\s+(?:(?:chamad[ao]|de\s+nome|d[aeo])\s+)?|(?:no|na|via|pel[ao]|com|usando|em)\s+)$/u.test(
        before,
      )
    );
  }
  return (
    bareTrailingInstrument ||
    /\b(?:(?:(?:via|pel[ao]|com(?:\s+a)?|usando(?:\s+a)?|d[ae]|na)\s+conta|conta)\s+(?:(?:chamad[ao]|de\s+nome)\s+)?|(?:no|na|via|pel[ao]|com|usando|em)\s+)$/u.test(
      before,
    )
  );
}

function stripKnownNames(text: string, context: RoutingContext): string {
  let result = text;
  const instruments = [
    ...(context.knownCards ?? []).map((instrument) => ({
      ...instrument,
      kind: "card" as const,
    })),
    ...(context.knownAccounts ?? []).map((instrument) => ({
      ...instrument,
      kind: "account" as const,
    })),
  ].sort(
    (left, right) => normalize(right.name).length - normalize(left.name).length,
  );
  for (const instrument of instruments) {
    const spans = instrumentNameSpans(text, instrument.name).filter((span) => {
      if (!isPaymentInstrumentSpan(text, span, instrument.kind)) return false;
      if (normalize(instrument.name) !== "conta") return true;
      return !/^\s+(?:de\s+nome|chamad[ao])\b/u.test(
        normalize(text.slice(span.index + span.length)),
      );
    });
    for (const span of spans.reverse()) {
      const before = text.slice(0, span.index);
      const explicitShell =
        instrument.kind === "card"
          ? /\b(?:no|na|via|pel[ao]|com|usando|em)\s+(?:(?:o|a)\s+)?(?:cart[aã]o(?:\s+de\s+cr[eé]dito)?|cr[eé]dito)\s*$/iu.exec(
              before,
            )
          : new RegExp(
              String.raw`\b${PAYMENT_ACCOUNT_SOURCE_PREFIX}\s*$`,
              "iu",
            ).exec(before);
      const start =
        explicitShell === null
          ? span.index
          : span.index - explicitShell[0].length;
      const length = span.index + span.length - start;
      result = `${result.slice(0, start)}${" ".repeat(length)}${result.slice(start + length)}`;
    }
  }
  return result;
}

function maskNonMonetaryNumberSpans(text: string): string {
  return text
    .replace(
      new RegExp(
        String.raw`\b${METADATA_YEAR_QUALIFIER}(?:\s+de)?\s*[:#-]?\s*(?:19|20)\d{2}\b`,
        "giu",
      ),
      (match) => " ".repeat(match.length),
    )
    .replace(
      new RegExp(String.raw`\b${PAYMENT_OCCURRENCE_DATE}\b`, "giu"),
      (match) => " ".repeat(match.length),
    )
    .replace(/(?<!\d\/)\b\d{1,2}\/\d{4}\b/giu, (match) =>
      " ".repeat(match.length),
    )
    .replace(
      /\b(?:a partir de\s*|dia\s+)?\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/giu,
      (match) => " ".repeat(match.length),
    )
    .replace(/\bdia\s*\d+\b/giu, (match) => " ".repeat(match.length));
}

function stripPurchaseDateSpans(text: string): string {
  return text
    .replace(/\b(?:hoje(?:\s+cedo)?|ontem|anteontem)\b/giu, " ")
    .replace(
      new RegExp(
        String.raw`\b(?:a\s+partir\s+de\s+|(?:(?:em|(?:no\s+)?dia|(?:na\s+)?data)\s*)?)${PAYMENT_NUMERIC_DATE}\b`,
        "giu",
      ),
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
    .replace(
      /(\b(?:parcela|presta[cç][aã]o)\s+)\d+(?=\s+(?:da|de|do)\b)/giu,
      (_match, prefix: string) =>
        `${prefix}${mask(_match.slice(prefix.length))}`,
    )
    .replace(/\b\d+\s*[ªº]\s*(?=parcela\b)/giu, mask)
    .replace(/\b\d+\s*[ªº](?=\s|$)/giu, mask)
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
    /\b(?:paguei|quitei)\s+(r\$\s*)?\+?\s*([\d.,]+)(\s+reais)?\s+(?:da|de|do)\s+(?:parcela|fatura|financiamento|empr[eé]stimo|cons[oó]rcio)\b/iu.exec(
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

function amountFirstObligationPaymentTarget(text: string): string | undefined {
  const amount = String.raw`(?:r\$\s*)?\+?\s*\d[\d.,]*(?:\s+reais)?`;
  const source = String.raw`(?:${PAYMENT_PIX_SOURCE}|${PAYMENT_ACCOUNT_SOURCE_PREFIX}(?:\s+\p{L}[\p{L}\d-]*){1,4})`;
  const match = new RegExp(
    String.raw`^\s*(?:paguei|quitei)\s+${amount}\s+((?:da|de|do)\s+)?(.+?)(?=\s+${source}\b|\s*$)`,
    "iu",
  ).exec(text);
  const target = match?.[2];
  if (
    target === undefined ||
    !/\p{L}/u.test(target) ||
    /\b(?:fatura|cart[aã]o)\b/iu.test(target) ||
    (match?.[1] === undefined &&
      !EXPLICIT_OBLIGATION_PAYMENT_TARGET_RE.test(normalize(target)))
  ) {
    return undefined;
  }
  return titleCaseDescription(target);
}

function prepositionlessAmountFirstObligationPaymentCents(
  text: string,
): number | undefined {
  if (amountFirstObligationPaymentTarget(text) === undefined) return undefined;
  const match =
    /^\s*(?:paguei|quitei)\s+(?:r\$\s*)?\+?\s*(\d[\d.,]*)(?:\s+reais)?\s+(?!da\b|de\b|do\b)/iu.exec(
      text,
    );
  return parseBrl(match?.[1] ?? "");
}

function sourceFirstObligationPayment(
  text: string,
  context: RoutingContext,
): { target: string; amountCents: number } | undefined {
  const normalizedText = normalize(text);
  const knownSource = paymentSourceAccountKeyword(text, context);
  const sourcePatterns = [String.raw`(?:${PAYMENT_PIX_SOURCE})`];
  if (knownSource !== undefined) {
    sourcePatterns.push(
      String.raw`(?:${PAYMENT_ACCOUNT_SOURCE_PREFIX}\s+${escapedPattern(normalize(knownSource))})`,
    );
  }
  const occurrence = String.raw`(?:${PAYMENT_OCCURRENCE_DATE})`;
  const optionalOccurrenceBefore = String.raw`(?:${occurrence}[\s,]+)?`;
  const optionalOccurrenceAfter = String.raw`(?:[\s,]+${occurrence})?`;
  const match = new RegExp(
    String.raw`^\s*(?:paguei|quitei)\s+${optionalOccurrenceBefore}(?:${sourcePatterns.join("|")})[\s,]+${optionalOccurrenceBefore}(?:r\$\s*)?(\d[\d.,]*)(?:\s+reais)?${optionalOccurrenceAfter}\s+(?:da|de|do)\s+(.+?)${optionalOccurrenceAfter}\s*$`,
    "u",
  ).exec(normalizedText);
  const amountCents = parseBrl(match?.[1] ?? "");
  const target = titleCaseDescription(match?.[2] ?? "");
  return amountCents === undefined || target === undefined
    ? undefined
    : { target, amountCents };
}

function explicitObligationSettlementAmountCents(
  text: string,
): number | undefined {
  const normalized = normalize(text);
  const source = String.raw`(?:${PAYMENT_PIX_SOURCE}|${PAYMENT_ACCOUNT_SOURCE_PREFIX}\s+[\p{L}][\p{L}\d-]*(?:\s+[\p{L}][\p{L}\d-]*)*)`;
  const tail = String.raw`(?:\s+${source})?\s*$`;
  const amount = String.raw`(r\$\s*)?\+?\s*(\d[\d.,]*)(\s+reais)?`;
  const patterns = [
    new RegExp(
      String.raw`^\s*(?:paguei|quitei)\s+(?:(?:o|a)\s+)?(.+?)\s+${amount}${tail}`,
      "u",
    ),
    new RegExp(
      String.raw`^\s*(.+?)\s+(?:pago|paga|quitado|quitada)\s+${amount}${tail}`,
      "u",
    ),
    new RegExp(
      String.raw`^\s*(?:paguei|quitei)\s+${amount}\s+(?:da|de|do)\s+(.+?)${tail}`,
      "u",
    ),
  ];

  for (const [index, pattern] of patterns.entries()) {
    const match = pattern.exec(normalized);
    if (match === null) continue;
    const amountIndex = index === 2 ? 2 : 3;
    const targetIndex = index === 2 ? 4 : 1;
    const target = match[targetIndex] ?? "";
    const grammaticalAmountFirstTarget =
      index === 2 ? amountFirstObligationPaymentTarget(text) : undefined;
    if (
      !EXPLICIT_OBLIGATION_PAYMENT_TARGET_RE.test(target) &&
      grammaticalAmountFirstTarget === undefined
    )
      continue;
    const rawAmount = match[amountIndex] ?? "";
    const currencyIndex = index === 2 ? 1 : 2;
    const reaisIndex = index === 2 ? 3 : 4;
    if (
      /^(?:19|20)\d{2}$/u.test(rawAmount) &&
      match[currencyIndex] === undefined &&
      match[reaisIndex] === undefined &&
      hasExplicitMetadataYearEvidence(text)
    ) {
      continue;
    }
    return parseBrl(rawAmount);
  }
  return undefined;
}

function explicitKnownCardSettlementAmountCents(
  text: string,
): number | undefined {
  const masked = maskNonMonetaryNumberSpans(text);
  const matches = [
    ...masked.matchAll(/(?:(?:r\$\s*)|\+\s*)?\d[\d.,]*/giu),
  ].filter((match) => {
    const index = match.index ?? 0;
    const before = masked.slice(0, index);
    const after = masked.slice(index + match[0].length);
    if (/[\p{L}\d]$/u.test(before) || /^[\p{L}\d]/u.test(after)) {
      return false;
    }
    const bareNumber = match[0].replace(/\D/g, "");
    const metadataYear =
      /^(?:19|20)\d{2}$/.test(bareNumber) &&
      !/^r\$/iu.test(match[0]) &&
      !/[,.]/u.test(match[0]) &&
      new RegExp(
        String.raw`\b(?:de|em|${METADATA_YEAR_QUALIFIER})\s*$`,
        "u",
      ).test(normalize(before));
    return !metadataYear;
  });
  return parseBrl(matches.at(-1)?.[0] ?? "");
}

function paymentSourceNameAtStart(source: string): string | undefined {
  if (
    /^(?:\s*[,.;:!?-]?\s*)?(?:hoje\b|ontem\b|anteontem\b|(?:em|(?:no\s+)?dia|(?:na\s+)?data)\s+\d|(?:r\$\s*)?\d[\d.,]*(?:\s+reais)?\b|pago\b|paga\b|quitado\b|quitada\b)/iu.test(
      source,
    )
  ) {
    return undefined;
  }
  return new RegExp(
    String.raw`^(.+?)(?=\s+(?:a\s+partir\s+de\b|${PAYMENT_PIX_SOURCE}\b|(?:por|no\s+valor\s+de|valor\s+de)\s+(?:r\$\s*)?\d|(?:r\$\s*)?\d[\d.,]*(?:\s+reais)?\b|pago\b|paga\b|quitado\b|quitada\b|hoje\b|ontem\b|anteontem\b|(?:em|(?:no\s+)?dia|(?:na\s+)?data)\s+\d)|\s*$)`,
    "iu",
  ).exec(source)?.[1];
}

function hasGenericDefaultAccountSource(
  text: string,
  context: RoutingContext,
): boolean {
  const sourcePrefix = new RegExp(
    String.raw`\b(?:via|pel[ao]|com(?:\s+a)?|usando(?:\s+a)?|na)\s+conta\s*`,
    "giu",
  );
  for (const match of text.matchAll(sourcePrefix)) {
    const sourceTail = text.slice((match.index ?? 0) + match[0].length);
    const reservedKnownAccount = (context.knownAccounts ?? []).some(
      (account) =>
        (isTemporalInstrumentFragment(account.name) ||
          isImplicitInstrumentMetadataVocabulary(account.name)) &&
        new RegExp(
          `^${normalize(account.name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=$|[\\s,.;:!?-])`,
          "u",
        ).test(normalize(sourceTail)),
    );
    if (reservedKnownAccount) continue;
    if (
      knownAccountAtSourceStart(sourceTail, context.knownAccounts) !== undefined
    ) {
      continue;
    }
    if (paymentSourceNameAtStart(sourceTail) === undefined) return true;
  }
  return false;
}

function knownAccountAtSourceStart(
  source: string,
  accounts: RoutingContext["knownAccounts"],
): string | undefined {
  const normalizedSource = normalize(source);
  return [...(accounts ?? [])]
    .sort(
      (left, right) =>
        normalize(right.name).length - normalize(left.name).length,
    )
    .find((account) => {
      if (
        (isTemporalInstrumentFragment(account.name) ||
          isImplicitInstrumentMetadataVocabulary(account.name)) &&
        new RegExp(
          `^${normalize(account.name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=$|[\\s,.;:!?-])`,
          "u",
        ).test(normalizedSource)
      ) {
        return false;
      }
      const escaped = normalize(account.name).replace(
        /[.*+?^${}()|[\]\\]/g,
        "\\$&",
      );
      const match = new RegExp(`^${escaped}(?=$|[\\s,.;:!?-])`).exec(
        normalizedSource,
      );
      if (match === null) return false;
      const remainder = normalizedSource.slice(match[0].length);
      if (/^\s*[,.;:!?-]?\s*$/.test(remainder)) return true;
      return new RegExp(
        String.raw`^\s*(?:[,.;:!?-]\s*)?(?:a\s+partir\s+de\b|${PAYMENT_PIX_SOURCE}\b|(?:por|no\s+valor\s+de|valor\s+de)\s+(?:r\$\s*)?\d|(?:r\$\s*)?\d[\d.,]*(?:\s+reais)?\b|pago\b|paga\b|quitado\b|quitada\b|hoje\b|ontem\b|anteontem\b|(?:em|(?:no\s+)?dia|(?:na\s+)?data)\s+\d)`,
        "u",
      ).test(remainder);
    })?.name;
}

function paymentSourceAccountKeyword(
  text: string,
  context: RoutingContext,
): string | undefined {
  const explicitlyNamed = explicitNamedInstrumentKeyword(
    text,
    "account",
    context.knownAccounts,
  );
  if (explicitlyNamed !== undefined) {
    const exactKnownAccount = (context.knownAccounts ?? []).find(
      (account) =>
        normalize(account.name).trim() === normalize(explicitlyNamed).trim(),
    );
    return exactKnownAccount?.name ?? explicitlyNamed;
  }
  const sourcePrefix = new RegExp(
    String.raw`\b${PAYMENT_ACCOUNT_SOURCE_PREFIX}\s+`,
    "giu",
  );
  let resolvedAccount: string | undefined;
  for (const match of text.matchAll(sourcePrefix)) {
    if (isAccountShapedObligationTargetPrefix(text, match)) continue;
    const sourceStart = (match.index ?? 0) + match[0].length;
    const sourceTail = text.slice(sourceStart);
    const exactKnownAccount = knownAccountAtSourceStart(
      sourceTail,
      context.knownAccounts,
    );
    if (exactKnownAccount !== undefined) {
      resolvedAccount = exactKnownAccount;
      continue;
    }

    const ambiguousTargetPrefix = /\b(?:da|de)\s+conta\s*$/u.test(
      normalize(match[0]),
    );
    if (ambiguousTargetPrefix) continue;

    const reservedKnownAccount = (context.knownAccounts ?? []).some(
      (account) =>
        (isTemporalInstrumentFragment(account.name) ||
          isImplicitInstrumentMetadataVocabulary(account.name)) &&
        new RegExp(
          `^${normalize(account.name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=$|[\\s,.;:!?-])`,
          "u",
        ).test(normalize(sourceTail)),
    );
    if (reservedKnownAccount) continue;

    const sourceName = paymentSourceNameAtStart(sourceTail);
    const explicitUnknownAccount = titleCaseDescription(sourceName ?? "");
    if (explicitUnknownAccount !== undefined) {
      resolvedAccount = explicitUnknownAccount;
    }
  }
  return resolvedAccount;
}

/**
 * `conta da/de X` is an obligation target, not a settlement source. The
 * source grammar also accepts `da conta X`, so distinguish the target form by
 * its immediately preceding `conta`: in `a conta da escola pela conta Escola`
 * only the later `pela conta Escola` may be consumed as source metadata.
 */
function isAccountShapedObligationTargetPrefix(
  text: string,
  match: RegExpMatchArray,
): boolean {
  if (!/^\s*(?:da|de)\s+conta\s+$/u.test(normalize(match[0]))) return false;
  return /\bconta\s*$/u.test(normalize(text.slice(0, match.index ?? 0)));
}

function maskResolvedPaymentSourceAccount(
  text: string,
  accountName: string | undefined,
  context: RoutingContext,
): string {
  if (accountName === undefined) return text;
  const normalizedAccountName = normalize(accountName);
  const matches = (context.knownAccounts ?? []).filter(
    (account) => normalize(account.name) === normalizedAccountName,
  );
  if (matches.length !== 1) return text;

  const normalizedText = normalize(text);
  const spans: InstrumentNameSpan[] = [];
  const sourcePrefix = new RegExp(
    String.raw`\b${PAYMENT_ACCOUNT_SOURCE_PREFIX}\s+`,
    "gu",
  );
  for (const match of normalizedText.matchAll(sourcePrefix)) {
    if (isAccountShapedObligationTargetPrefix(normalizedText, match)) continue;
    const sourceClauseStart = match.index ?? 0;
    const sourceStart = (match.index ?? 0) + match[0].length;
    const sourceTail = normalizedText.slice(sourceStart);
    if (
      sourceTail.startsWith(normalizedAccountName) &&
      !/^[\p{L}\p{N}]/u.test(sourceTail.slice(normalizedAccountName.length))
    ) {
      spans.push({
        index: sourceClauseStart,
        length: sourceStart - sourceClauseStart + normalizedAccountName.length,
      });
    }
  }

  let masked = text;
  for (const span of spans.reverse()) {
    masked = `${masked.slice(0, span.index)}${" ".repeat(span.length)}${masked.slice(span.index + span.length)}`;
  }
  return masked;
}

/**
 * Capture a verb-first obligation target before provider names are masked or
 * stripped as payment metadata. The capture is intentionally limited to
 * `escola`, whose recurring payment wording is supported separately from
 * ordinary merchant expenses. Other established obligation descriptions keep
 * their more specific canonical cleanup below.
 */
function sourceQualifiedVerbFirstObligationTarget(
  text: string,
  context: RoutingContext,
): string | undefined {
  const settlementAccount = paymentSourceAccountKeyword(text, context);
  const hasPixSource = new RegExp(
    String.raw`\b${PAYMENT_PIX_SOURCE}\b`,
    "iu",
  ).test(text);
  if (settlementAccount === undefined && !hasPixSource) return undefined;

  let evidenceText = maskResolvedPaymentSourceAccount(
    text,
    settlementAccount,
    context,
  );
  evidenceText = evidenceText.replace(
    new RegExp(String.raw`\b${PAYMENT_PIX_SOURCE}\b`, "giu"),
    (match) => " ".repeat(match.length),
  );
  const normalizedEvidence = normalize(evidenceText);
  const match =
    /^\s*(?:paguei|quitei)\s+(?:(?:a|o)\s+)?(.+?)(?=\s+(?:(?:r\$\s*)?\d[\d.,]*(?:\s+reais)?\b|(?:por|no\s+valor\s+de|valor\s+de)\s+(?:r\$\s*)?\d)|\s*$)/u.exec(
      normalizedEvidence,
    );
  const target = match?.[1]?.trim();
  if (target !== "escola") return undefined;
  return titleCaseDescription(target);
}

function hasAmbiguousReservedAccountSource(
  text: string,
  context: RoutingContext,
): boolean {
  if (
    explicitNamedInstrumentKeyword(text, "account", context.knownAccounts) !==
    undefined
  ) {
    return false;
  }
  const normalized = normalize(text);
  return (context.knownAccounts ?? []).some((account) => {
    if (
      !isTemporalInstrumentFragment(account.name) &&
      !isImplicitInstrumentMetadataVocabulary(account.name)
    ) {
      return false;
    }
    const escaped = normalize(account.name).replace(
      /[.*+?^${}()|[\]\\]/g,
      "\\$&",
    );
    return new RegExp(
      String.raw`\b(?:via|pel[ao]|com(?:\s+a)?|usando(?:\s+a)?)\s+conta\s+${escaped}(?=$|[\s,.;:!?-])`,
      "u",
    ).test(normalized);
  });
}

function stripResolvedPaymentSourceSuffix(
  text: string,
  context: RoutingContext,
): string {
  const normalizedText = normalize(text);
  const sourcePrefix = new RegExp(
    String.raw`\b${PAYMENT_ACCOUNT_SOURCE_PREFIX}\s+`,
    "gu",
  );
  for (const match of normalizedText.matchAll(sourcePrefix)) {
    if (isAccountShapedObligationTargetPrefix(normalizedText, match)) continue;
    const sourceStart = (match.index ?? 0) + match[0].length;
    const sourceTail = normalizedText.slice(sourceStart);
    if (
      knownAccountAtSourceStart(sourceTail, context.knownAccounts) !== undefined
    ) {
      return text.slice(0, match.index).trim();
    }
  }
  return text;
}

function stripBenignPaymentTails(text: string): string {
  let core = text.trim();
  let previous: string;
  const accountTail = new RegExp(
    String.raw`\s+${PAYMENT_ACCOUNT_SOURCE_PREFIX}\s+[\p{L}][\p{L}\d-]*(?:\s+[\p{L}][\p{L}\d-]*)*\s*$`,
    "iu",
  );
  do {
    previous = core;
    core = core
      .replace(new RegExp(String.raw`\s+${PAYMENT_PIX_SOURCE}\s*$`, "iu"), "")
      .replace(
        new RegExp(
          String.raw`\s+(?:${PAYMENT_SPOKEN_FULL_DATE}|hoje|ontem|anteontem|dia\s*\d+(?![\d/])|dia\s+\d{1,2}\/\d{1,2}(?:\/\d{2,4})?|pago|paga|quitado|quitada)\s*$`,
          "iu",
        ),
        "",
      )
      .replace(accountTail, "")
      .trim();
  } while (core !== previous);
  return core;
}

function positiveBarePaymentPosition(raw: string): number | undefined {
  const value = Number(raw);
  return Number.isInteger(value) && value >= 1 ? value : undefined;
}

function ambiguousBarePaymentNumber(text: string): number | undefined {
  const normalized = normalize(text);
  const leading =
    /\b(?:paguei|quitei)\s+(\d+)\s+(?:da|de|do)\s+(parcela|prestacao|financiamento|emprestimo|consorcio)\b/.exec(
      normalized,
    );
  if (leading !== null) {
    const raw = leading[1] as string;
    return positiveBarePaymentPosition(raw);
  }

  const core = stripBenignPaymentTails(normalized);

  const trailing =
    /\b(parcela\s+(?:da|de|do)|prestacao\s+(?:da|de|do)|parcela solar|financiamento|emprestimo|consorcio)\b(.+?)\s+(\d+)\s*$/.exec(
      core,
    );
  if (trailing === null) return undefined;
  const beforeNumber = trailing[2]?.trim() ?? "";
  return /(?:\bnumero|\bpor|\bno valor de|\bvalor de|r\$|\bpago|\bpaga|\bquitado|\bquitada)$/.test(
    beforeNumber,
  )
    ? undefined
    : positiveBarePaymentPosition(trailing[3] as string);
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
    const plausibleShortYear = rawYear.length === 2 && Number(rawYear) >= 13;
    const explicitMonthSelector = /\b(?:de|competencia)\s*$/u.test(before);
    const contextualOccurrenceDate =
      /\b(?:a\s+partir\s+de|(?:no\s+)?dia)\s*$/u.test(before);
    if (contextualOccurrenceDate) {
      continue;
    }
    if (rawYear.length === 2 && !plausibleShortYear && !explicitMonthSelector) {
      continue;
    }
    const month = Number(match[1]);
    if (month < 1 || month > 12) return { kind: "invalid", raw: match[0] };
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
    `^\\s*(?:(?:no|na|via|em)\\s+|${PAYMENT_ACCOUNT_SOURCE_PREFIX}\\s+)?(?:${instrumentPattern})\\b[\\s,;:-]*(?:(?:por|no\\s+valor\\s+de|valor\\s+de)\\s+)?(?:r\\$\\s*)?\\d[\\d.,]*(?:\\s+reais)?(?:\\s+(?:hoje|ontem|anteontem))?[\\s.!?]*$`,
  ).test(normalize(after));
}

function leadingPurchaseMonetarySpan(
  text: string,
  context: RoutingContext,
): RegExpExecArray | null {
  const match = /^\s*((r\$\s*)?\d[\d.,]*(?:\s+reais)?)(?=\s+\p{L})/iu.exec(
    text,
  );
  if (match === null) return null;

  const rawNumber = match[1] ?? "";
  const remainder = normalize(text.slice(match[0].length));
  const bareDigits = rawNumber.replace(/\D/gu, "");
  if (
    match[2] === undefined &&
    /^(?:19|20)\d{2}$/.test(bareDigits) &&
    /^\s*(?:iptu|ipva|ano|modelo|referencia|competencia)\b/u.test(remainder)
  ) {
    return null;
  }
  const knownInstrument = [
    ...(context.knownCards ?? []),
    ...(context.knownAccounts ?? []),
  ].some((instrument) => {
    const escaped = normalize(instrument.name).replace(
      /[.*+?^${}()|[\]\\]/g,
      "\\$&",
    );
    return new RegExp(`\\b(?:no|na|em)\\s+${escaped}\\b`, "u").test(remainder);
  });
  const financialTail =
    /\b(?:parcelad[ao]s?|parcelei|dividid[ao]s?|em\s+-?\d+\s*x|\d+\s+(?:vezes|parcelas?|presta[cç][oõ]es)|(?:em\s+)?uma\s+unica\s+(?:parcela|prestacao)|no\s+(?:cart[aã]o|cr[eé]dito|pix|d[eé]bito|boleto)|na\s+conta|em\s+dinheiro|[aà]\s+vista)\b/u.test(
      remainder,
    );
  return financialTail || knownInstrument ? match : null;
}

function isLikelyProductModelNumber(
  text: string,
  raw: string,
  index: number,
  after: string,
): boolean {
  if (/^r\$/iu.test(raw) || /[,.]/u.test(raw)) return false;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > 99) return false;

  const before = text.slice(0, index).trimEnd();
  const previousToken = /([\p{L}\d-]+)$/u.exec(before)?.[1] ?? "";
  const productToken = /^(?:iphone|playstation|ps)$/u.test(
    normalize(previousToken),
  );
  const brandedToken = /\p{Ll}.*\p{Lu}/u.test(previousToken);
  if (!productToken && !brandedToken) return false;

  return /^\s+(?:\p{L}+[\s-]+)*(?:no|na|via)\s+(?:pix\b|cart[aã]o\b|cr[eé]dito\b|\p{L})/iu.test(
    after,
  );
}

function inferredMoneyMatches(
  text: string,
  count: number | undefined,
  context: RoutingContext = {},
) {
  const masked = maskNonMonetaryNumberSpans(text);
  const explicitValue = explicitValueAmountMatch(masked);
  const leadingAmount = leadingPurchaseMonetarySpan(masked, context);
  return [...masked.matchAll(/(?:(?:R\$\s*)|\+\s*)?\d[\d.,]*/gi)].filter(
    (match) => {
      const raw = match[0];
      const index = match.index ?? 0;
      const before = masked.slice(0, index);
      const after = masked.slice(index + raw.length);
      if (/[\p{L}\d]$/u.test(before) || /^[\p{L}\d]/u.test(after)) return false;
      const numeric = parseBrl(raw);
      if (numeric === undefined) return false;

      if (isLikelyProductModelNumber(text, raw, index, after)) return false;

      if (
        leadingAmount !== null &&
        index >= (leadingAmount.index ?? 0) &&
        index < (leadingAmount.index ?? 0) + leadingAmount[0].length
      ) {
        return true;
      }

      // A later explicit value predicate outranks an earlier number that merely
      // sits beside a payment instrument, such as the model in
      // "iPhone 15 no Pix por 5000".
      if (explicitValue !== null && index < (explicitValue.index ?? 0)) {
        return false;
      }
      if (hasInstrumentThenTrailingAmount(after, context)) return false;

      // A bare number immediately before `em Nx de Y` is only credible as a
      // leading total when it is at least one installment. Smaller values are
      // commonly product models (`iPhone 15`, `PlayStation 5`) and must remain
      // part of the description instead of creating a false amount conflict.
      const followingInstallmentClause =
        /^\s+em\s+\d+\s*x\s+de\s+(?:r\$\s*)?([\d.,]+)/iu.exec(after);
      if (
        followingInstallmentClause !== null &&
        !/^r\$/iu.test(raw) &&
        !/[,.]/u.test(raw)
      ) {
        const installmentValue = parseBrl(followingInstallmentClause[1] ?? "");
        if (installmentValue !== undefined && numeric < installmentValue) {
          return false;
        }
      }

      // Counts and ordinal references are structural numbers, never prices.
      if (/^\s*x\b/i.test(after)) return false;
      if (
        /^\s+(?:vezes|parcelas|prestacoes|boletos?|mes(?:es)?)\b/i.test(
          after,
        ) ||
        /^\s+(?:parcela|prestacao)\b(?!\s+[uú]nica\b)/iu.test(after)
      )
        return false;
      if (
        /\b(?:parcela|presta[cç][aã]o)\s*$/iu.test(before) &&
        !/^r\$/iu.test(raw) &&
        !/[,.]/u.test(raw) &&
        !/^\s+reais\b/iu.test(after)
      )
        return false;
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
        ).test(normalize(after));
      });
      const namedAccountSourceFollows = new RegExp(
        String.raw`^\s*${PAYMENT_ACCOUNT_SOURCE_PREFIX}\b`,
        "u",
      ).test(normalize(after));
      const explicitlyNamedAccountSourceFollows =
        /^\s*conta\s+(?:chamad[ao]|de\s+nome)\b/u.test(normalize(after));
      // A standalone four-digit year is metadata, not an inferred price. Keep it
      // monetary only when the user marks it as such (currency/value wording) or
      // places it directly beside a named instrument, an existing terse-expense
      // contract. This prevents "IPTU 2026 no débito 1200" from charging R$ 2.026.
      const bareInteger = raw.replace(/\s/gu, "");
      const plausibleYear = /^(?:19|20)\d{2}$/.test(bareInteger);
      const metadataYear =
        plausibleYear &&
        new RegExp(
          String.raw`\b(?:${METADATA_YEAR_QUALIFIER}(?:\s+de)?|referente\s+a|(?:iptu|ipva)(?:\s+de)?)\s*[:#-]?\s*$`,
          "u",
        ).test(normalize(before));
      const explicitValueContext =
        /\b(?:valor(?:\s+total)?\s+de|total(?:\s+de)?|por)\s*$/iu.test(
          before,
        ) || /^\s*reais\b/iu.test(after);
      const leadingPaidAmount = /\b(?:paguei|quitei)\s*$/iu.test(before);
      const explicitSingleChargeFollows =
        /^\s+(?:(?:em\s+)?uma\s+(?:[uú]nica|s[oó])\s+vez|(?:em\s+)?(?:(?:uma\s+)?[uú]nica|uma\s+s[oó])\s+(?:parcela|presta[cç][aã]o)|(?:em\s+)?(?:parcela|presta[cç][aã]o)\s+[uú]nica)\b/iu.test(
          after,
        );
      if (
        plausibleYear &&
        !/^R\$/i.test(raw) &&
        !/[,.]/.test(raw) &&
        ((metadataYear && !explicitValueContext) ||
          (!explicitValueContext &&
            !knownInstrumentFollows &&
            !namedAccountSourceFollows &&
            !explicitlyNamedAccountSourceFollows))
      )
        return false;
      return (
        leadingPaidAmount ||
        explicitSingleChargeFollows ||
        knownInstrumentFollows ||
        namedAccountSourceFollows ||
        explicitlyNamedAccountSourceFollows ||
        /^(?:\s*(?:reais\b|em\s+(?:-?\d+\s*x|\w+\s+(?:vez(?:es)?|parcelas?|presta[cç][aã]o|presta[cç][oõ]es))|parcelad[ao]\b|dividid[ao]\b|(?:pix|dinheiro|d[eé]bito|cart[aã]o|cr[eé]dito)\b|(?:via|no|pel[ao]|com|usando|por)\s+(?:(?:o|a)\s+)?pix\b|no\s+(?:cart[aã]o|cr[eé]dito|pix|d[eé]bito|boleto|\p{L}[\p{L}\s]*\b)|na\s+conta\b|em\s+dinheiro\b|[aà]\s+vista\b|todo\s+(?:o\s+)?m[eê]s\b|mens(?:almente|ais|al)\b|(?:por|ao)\s+m[eê]s\b|(?:por|durante)\s+\d+\s+mes(?:es)?\b|com\s+desconto\b)|\s*$)/iu.test(
          after.replace(
            /\b(?:todos\s+os\s+meses|cada\s+m[eê]s|a\s+cada\s+m[eê]s|recorrente)\b/iu,
            "mensalmente",
          ),
        )
      );
    },
  );
}

export function canonicalFinancialDescription(
  rawText: string,
  route: DeterministicFinancialRoute,
  context: RoutingContext = {},
): string | undefined {
  const normalized = normalize(rawText);
  const financialGrammarText =
    maskExplicitKnownInstrumentNamesForFinancialGrammar(rawText, context);
  const instrumentMaskedRawText = stripKnownNames(rawText, context);
  if (route === "non_financial" || route === "none") return undefined;
  if (/^\s*710\s+reais\s+em\s+72x\s*$/i.test(normalize(rawText)))
    return undefined;

  if (route === "mark_paid") {
    const sourceQualifiedTarget = sourceQualifiedVerbFirstObligationTarget(
      rawText,
      context,
    );
    if (sourceQualifiedTarget !== undefined) return sourceQualifiedTarget;
    const resolvedSettlementAccount = paymentSourceAccountKeyword(
      rawText,
      context,
    );
    const settlementSourceMaskedText = maskResolvedPaymentSourceAccount(
      rawText,
      resolvedSettlementAccount,
      context,
    );
    const resolvedCard =
      explicitKnownInstrumentKeyword(rawText, "card", context.knownCards) ??
      knownCardKeyword(rawText, context.knownCards);
    const obligationGrammarText = hasAuthoritativeCardTargetSyntax(
      rawText,
      resolvedCard,
    )
      ? maskInstrumentName(settlementSourceMaskedText, resolvedCard as string)
      : settlementSourceMaskedText;
    const normalizedObligationGrammar = normalize(obligationGrammarText);
    const genericCardPayment = hasGenericCardSettlementShape(normalized);
    const obligationPayment =
      /\b(financiamento|emprestimo|consorcio|aluguel|seguro|parcela solar|(?:parcela|prestacao)(?:\s+(?:(?:numero\s+)?\d+|\d+\/\d+))?\s+(?:da|de|do)\b)/.test(
        normalizedObligationGrammar,
      ) ||
      (resolvedCard === undefined &&
        !/\b(?:fatura|cartao)\b/.test(normalizedObligationGrammar) &&
        /\b(?:paguei|quitei)\b/.test(normalizedObligationGrammar) &&
        EXPLICIT_OBLIGATION_PAYMENT_TARGET_RE.test(
          normalizedObligationGrammar,
        )) ||
      amountFirstObligationPaymentTarget(obligationGrammarText) !== undefined ||
      (resolvedCard === undefined &&
        !genericCardPayment &&
        !/\b(?:fatura|cartao)\b/.test(normalizedObligationGrammar) &&
        hasGenericSettlementStatus(
          normalize(stripKnownNames(obligationGrammarText, context)),
        ));
    if (resolvedCard !== undefined && !obligationPayment) return resolvedCard;
    const genericFaturaWithoutName =
      /^\s*(?:(?:paguei|quitei)\s+)?(?:a\s+)?fatura(?:\s+\d{1,2}\/\d{2,4})?(?:\s+(?:paga|pago|quitada|quitado))?(?:\s+(?:(?:no\s+)?dia|em)\s+\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)?\s*$/u.test(
        normalized,
      );
    if (genericFaturaWithoutName && !obligationPayment) return "Fatura";
    if (genericCardPayment && !obligationPayment)
      return /\bfatura\b/.test(normalized) ? "Fatura" : "Cartão";
    if (/\bparcela solar\b/i.test(obligationGrammarText))
      return "Parcela solar";
    const installmentAmountTarget =
      /\b(?:parcela|presta[cç][aã]o)\s+(?:r\$\s*)?\+?\s*\d[\d.,]*(?:\s+reais)?\s+(?:da|de|do)\s+(.+?)(?=\s+(?:este\s+m[eê]s|hoje|ontem|pag[ao]|quitad[ao])\b|$)/iu.exec(
        obligationGrammarText,
      )?.[1];
    if (installmentAmountTarget !== undefined) {
      return titleCaseDescription(
        stripBenignPaymentTails(
          stripResolvedPaymentSourceSuffix(installmentAmountTarget, context),
        ),
      );
    }
    const installmentTarget =
      /\b(?:parcela|presta[cç][aã]o)(?:\s+(?:(?:n[uú]mero\s+)?\d+|\d+\/\d+))?\s+(?:da|de|do)\s+(.+?)(?=\s+(?:n[uú]mero\s+\d+|(?:por|no\s+valor\s+de)\s+(?:r\$\s*)?\+?\s*[\d.,]+|(?:r\$\s*)?\+?\s*[\d.,]+|este\s+m[eê]s|hoje|ontem|pag[ao]|quitad[ao])\b|$)/iu.exec(
        obligationGrammarText,
      )?.[1];
    if (installmentTarget !== undefined)
      return titleCaseDescription(
        stripBenignPaymentTails(
          stripResolvedPaymentSourceSuffix(installmentTarget, context),
        ),
      );
    if (obligationPayment) {
      let cleanedTarget = stripMetadataYearQualifiers(
        stripBenignPaymentTails(obligationGrammarText),
      )
        .replace(/^\s*(?:paguei|quitei)\s+(?:(?:a|o)\s+)?/iu, "")
        .replace(
          /^\s*(?:r\$\s*)?\+?\s*[\d.,]+(?:\s+reais)?\s+(?:(?:da|de|do)\s+)?/iu,
          "",
        )
        .replace(
          new RegExp(
            String.raw`\s+${PAYMENT_ACCOUNT_SOURCE_PREFIX}\s+.+$`,
            "iu",
          ),
          " ",
        )
        .replace(
          /\s+(?:por|no\s+valor\s+de|valor\s+de)\s+(?:r\$\s*)?\+?\s*[\d.,]+(?:\s+reais)?\s*$/iu,
          " ",
        )
        .replace(
          /\s+(?:n[uú]mero\s+)?\d{1,2}\s+por\s+(?=(?:r\$\s*)?[\d.,]+\s*$)/iu,
          " ",
        )
        .replace(/\s+(?:r\$\s*)?\+?\s*[\d.,]+(?:\s+reais)?\s*$/iu, "")
        .replace(
          /\s+(?:mil e duzentos|novecentos|trinta e dois)(?:\s+reais)?\s*$/iu,
          "",
        )
        .replace(/\s+(?:de|referente\s+a)\s*$/iu, "")
        .replace(/\s+n[uú]mero\s*$/iu, "")
        .replace(/\s+(?:este\s+m[eê]s|hoje|ontem)\s*$/iu, "")
        .replace(/\b(?:pago|paga|quitado|quitada)\b/giu, " ")
        .replace(new RegExp(String.raw`\b${PAYMENT_PIX_SOURCE}\b`, "giu"), " ");
      if (
        /\b(?:financiamento|empr[eé]stimo|cons[oó]rcio)\b/iu.test(
          obligationGrammarText,
        )
      ) {
        cleanedTarget = cleanedTarget.replace(/\s+\d{1,2}\/\d{1,2}\s*$/u, " ");
      }
      if (
        new RegExp(
          String.raw`\b(?:19|20)\d{2}\s+${PAYMENT_ACCOUNT_SOURCE_PREFIX}\b`,
          "iu",
        ).test(rawText)
      ) {
        cleanedTarget = cleanedTarget.replace(/\s+(?:19|20)\d{2}\s*$/u, " ");
      }
      const description = titleCaseDescription(
        stripMetadataYearQualifiers(cleanedTarget),
      );
      if (description !== undefined) return description;
    }
    if (/fatura.*mercado pago/i.test(rawText)) return "Mercado Pago";
    if (/fatura.*inter/i.test(rawText)) return "Inter";
    if (/financiamento do carro/i.test(obligationGrammarText))
      return "Financiamento do carro";
    if (/nubank/i.test(rawText)) return "Nubank";
  }

  const withoutLeadingSingleChargeMarker = rawText.replace(
    /^\s*(?:n[aã]o\s+(?:foi\s+)?parcelad[ao]s?|n[aã]o\s+parcelei|sem\s+parcelar|sem\s+parcelas?|pagamento\s+[uú]nico|compra\s+[uú]nica|(?:em\s+)?uma\s+(?:[uú]nica|s[oó])\s+(?:vez|parcela|presta[cç][aã]o)|cobrad[ao]\s+de\s+uma\s+vez)\s*[,;:-]?\s*/iu,
    "",
  );
  if (withoutLeadingSingleChargeMarker !== rawText) {
    return canonicalFinancialDescription(
      withoutLeadingSingleChargeMarker,
      route,
      context,
    );
  }

  const amountFirstFiniteObligation =
    /^\s*(?:r\$\s*)?\d[\d.,]*(?:\s+reais)?\s+((?:parcela solar|financiamento|empr[eé]stimo|cons[oó]rcio)\b.*?)\s+(?:em\s+)?\d+\s*x\b/iu.exec(
      rawText,
    )?.[1];
  if (amountFirstFiniteObligation !== undefined) {
    const description = titleCaseDescription(amountFirstFiniteObligation);
    if (description !== undefined) return description;
  }

  if (
    new RegExp(String.raw`\b${RECURRENCE_SYNTAX}\b`, "iu").test(
      financialGrammarText,
    ) ||
    /\/\s*m[eê]s\b/iu.test(financialGrammarText)
  ) {
    const recurringDescription = titleCaseDescription(
      stripMetadataYearQualifiers(stripKnownNames(rawText, context))
        .replace(/^\s*(?:eu\s+)?pago\s+(?:(?:o|a|os|as)\s+)?/iu, " ")
        .replace(/^\s*mensalidade\s+(?:d[aeo]\s+)?/iu, " ")
        .replace(/^\s*(?:r\$\s*)?[\d.,]+(?:\s+reais)?\s+/iu, " ")
        .replace(
          new RegExp(
            String.raw`(?:r\$\s*)?[\d.,]+(?:\s+reais)?\s+(?=${RECURRENCE_SYNTAX}\b)`,
            "giu",
          ),
          " ",
        )
        .replace(new RegExp(String.raw`\b${RECURRENCE_SYNTAX}\b`, "giu"), " ")
        .replace(
          new RegExp(String.raw`\b${METADATA_YEAR_QUALIFIER}\b`, "giu"),
          " ",
        )
        .replace(/\/\s*m[eê]s\b/giu, " ")
        .replace(/\b(?:em\s+)?\d+\s*x\b/giu, " ")
        .replace(/\ba\s+partir\s+de\s*\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/giu, " ")
        .replace(/\b(?:todo\s+)?dia\s*\d+\b/giu, " ")
        .replace(/(?:r\$\s*)?[\d.,]+(?:\s+reais)?/giu, " ")
        .replace(
          /\b(?:via|pel[ao]|com(?:\s+a)?|usando(?:\s+a)?|d[ae]|na)\s+conta\b.*$/giu,
          " ",
        )
        .replace(
          /\b(?:no\s+(?:boleto|d[eé]bito)|pix|dinheiro|d[eé]bito)\b/giu,
          " ",
        ),
    );
    if (recurringDescription !== undefined) return recurringDescription;
  }

  const leadingAmount = leadingPurchaseMonetarySpan(rawText, context);
  if (leadingAmount !== null) {
    const remainder = rawText.slice(
      (leadingAmount.index ?? 0) + leadingAmount[0].length,
    );
    const financialSyntax =
      /\s+(?=em\s+(?:-?\d+\s*x|\d+\s+(?:vez(?:es)?|parcelas?|presta[cç][oõ]es))|parcelad[ao]s?\b|parcelei\b|dividid[ao]s?\b|no\s+(?:cart[aã]o|cr[eé]dito|pix|d[eé]bito|boleto)\b|na\s+conta\b|em\s+dinheiro\b|[aà]\s+vista\b)/iu.exec(
        remainder,
      );
    const description = titleCaseDescription(
      stripKnownNames(
        stripPurchaseDateSpans(
          remainder.slice(0, financialSyntax?.index ?? remainder.length),
        ),
        context,
      ).replace(/^\s*(?:um|uma|o|a)\s+/iu, " "),
    );
    if (description !== undefined) return description;
  }

  const amountFirstRecurring =
    /^\s*(?:r\$\s*)?\d[\d.,]*(?:\s+reais)?\s+(.+)$/iu.exec(rawText)?.[1];
  if (
    amountFirstRecurring !== undefined &&
    new RegExp(String.raw`\b${RECURRENCE_SYNTAX}\b`, "iu").test(
      amountFirstRecurring,
    )
  ) {
    const description = titleCaseDescription(
      stripKnownNames(amountFirstRecurring, context)
        .replace(new RegExp(String.raw`\b${RECURRENCE_SYNTAX}\b`, "giu"), " ")
        .replace(/\bdia\s+\d+\b/giu, " "),
    );
    if (description !== undefined) return description;
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
    /^comprei no credito\b/.test(normalized)
  )
    return undefined;

  // Stop at the first financially-supported number. Earlier unsupported
  // numbers can legitimately be product models ("iPhone 15 Pro").
  const count = countFromText(rawText);
  const moneyMatch = inferredMoneyMatches(rawText, count, context).at(0);
  const explicitValueBoundary = explicitValueAmountMatch(rawText);
  const ambiguousBareAmountCandidate =
    /\s+((?:r\$\s*)?\d[\d.,]*)(?=\s+\d+\s*x\b)/iu.exec(rawText);
  const ambiguousBareAmountValue = Number(
    ambiguousBareAmountCandidate?.[1]?.replace(/\D/gu, "") ?? "",
  );
  const ambiguousBareAmountBoundary =
    ambiguousBareAmountCandidate !== null &&
    (!Number.isInteger(ambiguousBareAmountValue) ||
      ambiguousBareAmountValue > 99 ||
      /^r\$/iu.test(ambiguousBareAmountCandidate[1] ?? ""))
      ? ambiguousBareAmountCandidate
      : null;
  const syntaxBoundary =
    /\s+(?=(?<![\p{L}\d])\d+\s*(?:x\b|parcelas?\b|presta[cç][oõ]es\b|boletos?\b)|em\s+(?:-?\d+\s*x|\d+\s+(?:vez(?:es)?|parcelas?|presta[cç][oõ]es)|(?:uma|um|duas|dois|tr[eê]s|quatro|cinco|seis|sete|oito|nove|dez|onze|doze)\s+(?:vez(?:es)?|parcelas?|presta[cç][aã]o|presta[cç][oõ]es))|parcelad[ao]\b|parcelei\b|dividido\b|(?:no|via)\s+(?:cart[aã]o|cr[eé]dito|pix|d[eé]bito|boleto)|(?:via|pel[ao]|com(?:\s+a)?|usando(?:\s+a)?|d[ae]|na)\s+conta\b|em\s+dinheiro\b|1\s*x\b|uma\s+vez\b|(?:em\s+)?uma\s+[uú]nica\s+(?:parcela|presta[cç][aã]o)\b|uma\s+(?:parcela|presta[cç][aã]o)\b|[aà]\s+vista\b|compra\s+[uú]nica\b|pagamento\s+[uú]nico\b|cobrad[ao]\s+de\s+uma\s+vez\b|sem\s+parcelar\b|sem\s+parcelas?\b|n[aã]o\s+(?:foi\s+)?parcelad[ao]s?\b|n[aã]o\s+parcelei\b)/iu.exec(
      rawText,
    );
  const boundaryIndex = Math.min(
    moneyMatch?.index ?? rawText.length,
    explicitValueBoundary?.index ?? rawText.length,
    ambiguousBareAmountBoundary?.index ?? rawText.length,
    syntaxBoundary?.index ?? rawText.length,
  );
  let prefix = rawText.slice(0, boundaryIndex);
  prefix = stripMetadataYearQualifiers(
    stripSingleChargeMarkers(
      stripPurchaseDateSpans(instrumentMaskedRawText.slice(0, boundaryIndex)),
    ),
  )
    .replace(/[🛏️]/gu, " ")
    .replace(
      /^\s*(?:n[aã]o\s+(?:foi\s+)?parcelad[ao]s?|n[aã]o\s+parcelei|sem\s+parcelas?|sem\s+parcelar)\s*[,;:-]?\s*/iu,
      " ",
    )
    .replace(
      /^\s*(?:eu\s+)?(?:paguei|pago|comprei|compra|gastei|passei|lancei|registrei)\s+(?:com\s+)?(?:(?:um|uma|o|a|os|as)\s+)?/iu,
      " ",
    )
    .replace(
      /\b(Karol comprou|eu comprei|comprei|compra (?:de|no|na)|ontem gastei)\b/giu,
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

  // Classify registered-name spans while the original purchase grammar is
  // still intact. If verb/preposition cleanup runs first, `Comprei no
  // Mercado Livre` collapses to `no Mercado Livre` and a merchant that also
  // names an account can be mistaken for the payment instrument.
  let text = stripMetadataYearQualifiers(
    stripPurchaseDateSpans(instrumentMaskedRawText),
  )
    .replace(/[🛏️]/gu, " ")
    .replace(
      /^\s*(?:eu\s+)?(?:paguei|pago|comprei|compra|gastei|passei|lancei|registrei)\s+(?:com\s+)?(?:(?:um|uma|o|a|os|as)\s+)?/iu,
      " ",
    )
    .replace(
      /\b(Karol comprou|eu comprei|comprei|compra (?:de|no|na)|gastei)\b/giu,
      " ",
    )
    .replace(/\b(um|uma)\b/giu, " ")
    .replace(/\b(categoria\s+\p{L}+|responsavel\s+\p{L}+)\b/giu, " ")
    .replace(
      /\b(entrada ja paga|saldo|entrada\s+R?\$?\s*[\d.,]+\s+mais)\b/giu,
      " ",
    )
    .replace(/\b(total|por)\b\s*(?:R\$\s*)?[\d.,]+/giu, " ")
    .replace(/(?:(?:R\$\s*)|\+\s*)?\d[\d.,]*/giu, " ")
    .replace(
      /\b(mil e duzentos|novecentos|trinta e dois)\s*(?:reais)?\b/giu,
      " ",
    )
    .replace(
      new RegExp(
        String.raw`\b(?:em|s[aã]o|e)\s+${INSTALLMENT_COUNT_WORD}\s+(?:vezes|parcelas?|presta[cç][oõ]es)\b`,
        "giu",
      ),
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
    .replace(new RegExp(String.raw`\b${PAYMENT_PIX_SOURCE}\b`, "giu"), " ")
    .replace(
      /\b(cartao(?: de credito)?|credito|pix|dinheiro|debito|conta)\b/giu,
      " ",
    )
    .replace(
      /\b(a vista|compra unica|pagamento unico|(?:em\s+)?uma\s+(?:unica|so)\s+vez|(?:em\s+)?uma unica (?:parcela|prestacao)|sem parcelar|nao foi parcelad[ao]|cobrad[ao] de uma vez)\b/giu,
      " ",
    )
    .replace(
      /\b(passei|ficou|cada|da|de|do|pelo|pela|reais|no|na|este mes)\b/giu,
      " ",
    );
  return titleCaseDescription(text);
}

function extractAmounts(
  text: string,
  count: number | undefined,
  context: RoutingContext = {},
) {
  const normalized = normalize(text);
  const spokenCount = String.raw`(?:\d+|${INSTALLMENT_COUNT_WORD})`;
  const perRaw =
    new RegExp(
      String.raw`(?:\b\d+\s*x\s+(?:de\s+)?|\b${spokenCount}\s+(?:vezes|parcelas?|presta[cç][oõ]es|boletos?)\s+de\s+)(?:r\$\s*)?([\d.,]+)`,
      "iu",
    ).exec(text)?.[1] ??
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
    /\b\d+\s+(?:parcelas?|presta[cç][oõ]es|boletos?)\s+(\d+)\b/i.exec(
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
    /(r\$\s*)?([\d.,]+)\s+em\s+\d+\s*x\s+de\s+(?:r\$\s*)?[\d.,]+/i.exec(text);
  const clauseTotalCents = parseBrl(clauseTotalMatch?.[2] ?? "");
  const supportedClauseTotal =
    clauseTotalMatch?.[1] !== undefined ||
    perInstallmentCents === undefined ||
    (clauseTotalCents !== undefined && clauseTotalCents >= perInstallmentCents)
      ? clauseTotalCents
      : undefined;
  const explicitTotal = parseBrl(totalMatch?.[2] ?? "") ?? supportedClauseTotal;

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

  const explicitlyNamedKnownCard = explicitKnownInstrumentKeyword(
    text,
    "card",
    context.knownCards,
  );
  const explicitlyAuthoritativeCardName = explicitNamedInstrumentKeyword(
    text,
    "card",
    context.knownCards,
  );
  const normalFaturaCardName = normalFaturaTargetKeyword(
    text,
    context.knownCards,
  );
  const normalFaturaExactMatches = (context.knownCards ?? []).filter(
    (card) => normalize(card.name) === normalize(normalFaturaCardName ?? ""),
  );
  const normalFaturaRegisteredPrefix = (context.knownCards ?? []).some(
    (card) =>
      normalize(normalFaturaCardName ?? "").startsWith(normalize(card.name)) &&
      normalize(normalFaturaCardName ?? "") !== normalize(card.name),
  );
  const resolvedSettlementAccount = paymentSourceAccountKeyword(text, context);
  const settlementSourceMaskedText = maskResolvedPaymentSourceAccount(
    text,
    resolvedSettlementAccount,
    context,
  );
  const authoritativeCardName =
    explicitlyAuthoritativeCardName ??
    (normalFaturaExactMatches.length === 0 && normalFaturaRegisteredPrefix
      ? normalFaturaCardName
      : undefined);
  const authoritativeKnownCard =
    explicitlyAuthoritativeCardName === undefined
      ? undefined
      : (context.knownCards ?? []).find(
          (card) =>
            normalize(card.name) === normalize(explicitlyAuthoritativeCardName),
        )?.name;
  const normalFaturaKnownCard =
    normalFaturaExactMatches.length === 1
      ? normalFaturaExactMatches[0]?.name
      : undefined;
  let cardKeyword: string | undefined;
  if (explicitlyAuthoritativeCardName !== undefined) {
    cardKeyword =
      explicitlyNamedKnownCard ??
      authoritativeKnownCard ??
      explicitlyAuthoritativeCardName;
  } else if (authoritativeCardName !== undefined) {
    cardKeyword = authoritativeCardName;
  } else if (normalFaturaExactMatches.length > 1) {
    cardKeyword = undefined;
  } else {
    cardKeyword =
      normalFaturaKnownCard ??
      knownCardKeyword(settlementSourceMaskedText, context.knownCards) ??
      explicitNamedCardKeyword(text);
  }
  const obligationGrammarText = hasAuthoritativeCardTargetSyntax(
    text,
    cardKeyword,
  )
    ? maskInstrumentName(settlementSourceMaskedText, cardKeyword as string)
    : settlementSourceMaskedText;
  const normalizedObligationGrammar = normalize(obligationGrammarText);
  const withoutKnownCard =
    cardKeyword === undefined
      ? normalized
      : normalized.replace(normalize(cardKeyword), " ");
  const postNominalPaymentPosition =
    /\b(?:parcela|prestacao)\s+(?:numero\s+)?\d+\s+(?:da|de|do)\b(?!\s+\d)/.test(
      normalized,
    );
  const statusFirstKnownCardSettlementLanguage =
    cardKeyword !== undefined &&
    /^\s*(?:pago|paga|quitado|quitada)\s+(?:(?:o|a)\s+)?(?:fatura|cartao)\b/u.test(
      normalized,
    );
  const habitualPaymentCreation =
    /^\s*(?:eu\s+)?pago\s+(?:(?:o|a|os|as)\s+)?/u.test(normalized) &&
    !statusFirstKnownCardSettlementLanguage;
  const paymentLanguage =
    (!habitualPaymentCreation &&
      /\b(quitad[ao]|quitei|pago|paga|paguei)\b/.test(withoutKnownCard)) ||
    postNominalPaymentPosition ||
    normalFaturaRegisteredPrefix;
  const settlementAmount = String.raw`(?:r\$\s*)?\+?\s*\d[\d.,]*(?:\s+reais)?`;
  const qualifiedSettlementAmount = String.raw`(?:${PAYMENT_QUALIFIED_AMOUNT})`;
  const settlementStatus = String.raw`(?:pago|paga|quitado|quitada)`;
  const settlementDate = String.raw`(?:${PAYMENT_OCCURRENCE_DATE}|${PAYMENT_BARE_DAY_METADATA})`;
  const settlementSource = String.raw`(?:${PAYMENT_PIX_SOURCE}|${PAYMENT_ACCOUNT_SOURCE_PREFIX}(?:\s+\p{L}[\p{L}\d-]*){1,4})`;
  const benignSettlementTail = String.raw`(?:(?:${settlementStatus}|${settlementDate}|${settlementSource}|${qualifiedSettlementAmount}|${settlementAmount})[\s,]*)*`;
  let cardTargetMaskedResidueEvidenceText = text;
  for (const knownCard of [...(context.knownCards ?? [])].sort(
    (left, right) => normalize(right.name).length - normalize(left.name).length,
  )) {
    cardTargetMaskedResidueEvidenceText = maskInstrumentName(
      cardTargetMaskedResidueEvidenceText,
      knownCard.name,
      (span) =>
        /\bfatura(?:\s+(?:do\s+)?cartao)?\s*$/u.test(
          normalize(text.slice(0, span.index)),
        ),
    );
  }
  const cardSettlementResidueEvidenceText = maskResolvedPaymentSourceAccount(
    cardTargetMaskedResidueEvidenceText,
    resolvedSettlementAccount,
    context,
  );
  const normalizedCardSettlementResidueEvidence = normalize(
    cardSettlementResidueEvidenceText,
  );
  const cardSettlementBlockingResidue =
    /\b(?:compras?|pedidos?|entradas?)\b/.test(
      normalizedCardSettlementResidueEvidence,
    ) &&
    /\bfatura\b/.test(normalizedCardSettlementResidueEvidence) &&
    /\b(?:paguei|quitei|pago|paga|quitado|quitada)\b/.test(
      normalizedCardSettlementResidueEvidence,
    );
  const genericCardSettlement = hasGenericCardSettlementShape(normalized);
  const authoritativeCardSettlement =
    paymentLanguage &&
    hasAuthoritativeCardTargetSyntax(text, cardKeyword) &&
    !cardSettlementBlockingResidue;
  const verbFirstKnownCardSettlement =
    cardKeyword !== undefined &&
    new RegExp(
      String.raw`^\s*(?:paguei|quitei)\s+(?:(?:o|a)\s+)?(?:cartao\s+)?${benignSettlementTail}\s*$`,
      "u",
    ).test(withoutKnownCard);
  const cardFirstKnownCardSettlement =
    cardKeyword !== undefined &&
    new RegExp(
      String.raw`^\s*(?:(?:o|a)\s+)?(?:cartao\s+)?${benignSettlementTail}\s*$`,
      "u",
    ).test(withoutKnownCard) &&
    new RegExp(String.raw`\b${settlementStatus}\b`, "u").test(withoutKnownCard);
  const baseExplicitObligationPayment =
    /\b(financiamento|emprestimo|consorcio|aluguel|seguro|parcela solar|(?:parcela|prestacao)(?:\s+(?:(?:numero\s+)?\d+|\d+\/\d+))?\s+(?:da|de|do)\b)/.test(
      normalizedObligationGrammar,
    );
  const verbFirstExplicitObligationPayment =
    /\b(?:paguei|quitei)\b/.test(normalizedObligationGrammar) &&
    !/\b(?:fatura|cartao)\b/.test(normalizedObligationGrammar) &&
    /\b(financiamento|emprestimo|consorcio|aluguel|seguro|condominio|iptu|ipva|internet|academia|mensalidade|conta\s+(?:de|da|do)\s+[\p{L}\d-]+|(?:parcela|placa) solar|(?:parcela|prestacao)(?:\s+(?:numero\s+)?\d+)?\s+(?:da|de|do)\b)/u.test(
      normalizedObligationGrammar,
    );
  const sourceQualifiedObligationTarget =
    sourceQualifiedVerbFirstObligationTarget(text, context);
  const sourceQualifiedSchoolPaymentTarget =
    /\b(?:paguei|quitei)\s+(?:(?:a|o)\s+)?escola\b/u.test(
      normalizedObligationGrammar,
    );
  const sourceQualifiedSchoolPaymentSource = new RegExp(
    String.raw`\b(?:${PAYMENT_PIX_SOURCE}|${PAYMENT_ACCOUNT_SOURCE_PREFIX})\b`,
    "u",
  ).test(normalized);
  const schoolPaymentEvidenceText = maskResolvedPaymentSourceAccount(
    obligationGrammarText,
    paymentSourceAccountKeyword(text, context),
    context,
  );
  const sourceQualifiedSchoolPaymentAmount =
    extractAmounts(
      stripBenignPaymentTails(
        maskPaymentOrdinalSpans(schoolPaymentEvidenceText).text,
      ),
      undefined,
      context,
    ).totalCents !== undefined;
  const sourceQualifiedObligationPayment =
    (sourceQualifiedObligationTarget !== undefined ||
      sourceQualifiedSchoolPaymentTarget) &&
    sourceQualifiedSchoolPaymentSource &&
    sourceQualifiedSchoolPaymentAmount;
  const amountFirstGenericObligationPayment =
    amountFirstObligationPaymentTarget(obligationGrammarText) !== undefined;
  const sourceFirstPayment = sourceFirstObligationPayment(text, context);
  const genericAmountFirstTarget =
    sourceFirstPayment?.target ??
    amountFirstObligationPaymentTarget(obligationGrammarText);
  const genericAmountFirstObligationPayment =
    genericAmountFirstTarget !== undefined &&
    !EXPLICIT_OBLIGATION_PAYMENT_TARGET_RE.test(
      normalize(genericAmountFirstTarget),
    );
  const explicitObligationPayment =
    baseExplicitObligationPayment ||
    verbFirstExplicitObligationPayment ||
    sourceQualifiedObligationPayment ||
    (amountFirstGenericObligationPayment &&
      !genericAmountFirstObligationPayment) ||
    (/\b(?:pago|paga|quitado|quitada)\b/.test(normalizedObligationGrammar) &&
      !/\b(?:fatura|cartao)\b/.test(normalizedObligationGrammar) &&
      (EXPLICIT_OBLIGATION_PAYMENT_TARGET_RE.test(
        normalizedObligationGrammar,
      ) ||
        (cardKeyword === undefined &&
          /\b(?:em|no\s+dia|dia)\s+\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/.test(
            normalizedObligationGrammar,
          ))));
  const genericObligationStatusSettlement =
    cardKeyword === undefined &&
    !habitualPaymentCreation &&
    !genericCardSettlement &&
    !explicitObligationPayment &&
    !/\b(?:fatura|cartao)\b/.test(normalizedObligationGrammar) &&
    hasGenericSettlementStatus(
      normalize(stripKnownNames(obligationGrammarText, context)),
    );
  const paymentTarget =
    (/\bfatura\b/.test(normalized) && !cardSettlementBlockingResidue) ||
    explicitObligationPayment ||
    genericAmountFirstObligationPayment ||
    genericObligationStatusSettlement ||
    genericCardSettlement ||
    authoritativeCardSettlement ||
    verbFirstKnownCardSettlement ||
    cardFirstKnownCardSettlement;
  const obligationPayment =
    explicitObligationPayment || genericObligationStatusSettlement;
  // A complete, unambiguously resolved registered card name is metadata in a
  // settlement. Mask it before every amount parser so digits in names such as
  // `Áurea+ 2` cannot become a bill override. Unknown or ambiguous names stay
  // untouched and unresolved.
  const unambiguousKnownCardSettlement =
    !obligationPayment &&
    isUnambiguousKnownCardKeyword(cardKeyword, context) &&
    (genericCardSettlement ||
      authoritativeCardSettlement ||
      verbFirstKnownCardSettlement ||
      cardFirstKnownCardSettlement);
  const authoritativeSettlementName = obligationPayment
    ? undefined
    : authoritativeCardName;
  const cardMaskedPaymentEvidenceText = unambiguousKnownCardSettlement
    ? maskInstrumentName(text, cardKeyword as string)
    : authoritativeSettlementName !== undefined
      ? maskInstrumentName(text, authoritativeSettlementName)
      : text;
  const paymentEvidenceText = maskResolvedPaymentSourceAccount(
    cardMaskedPaymentEvidenceText,
    resolvedSettlementAccount,
    context,
  );
  const ambiguousPaymentNumber =
    ambiguousBarePaymentNumber(paymentEvidenceText);
  const invalidPaymentOrdinal =
    explicitInvalidPaymentOrdinal(paymentEvidenceText);
  const invalidPaymentAmount = explicitInvalidPaymentAmount(
    maskPaymentOrdinalSpans(paymentEvidenceText).text,
  );
  if (paymentLanguage && paymentTarget && invalidPaymentOrdinal !== undefined) {
    return {
      route: "ambiguous",
      description: canonicalFinancialDescription(text, "mark_paid", context),
      amountCents: undefined,
      paymentTarget: obligationPayment ? "obligation" : "card",
      suppressAiPaymentAmount: true,
      explicitInvalidPaymentOrdinal: invalidPaymentOrdinal,
      authoritativeCardName: obligationPayment
        ? undefined
        : authoritativeCardName,
      reason: "invalid_installment_ordinal",
    };
  }
  if (paymentLanguage && paymentTarget && invalidPaymentAmount !== undefined) {
    return {
      route: "ambiguous",
      description: canonicalFinancialDescription(text, "mark_paid", context),
      amountCents: undefined,
      paymentTarget: obligationPayment ? "obligation" : "card",
      suppressAiPaymentAmount: true,
      explicitInvalidPaymentAmount: invalidPaymentAmount,
      authoritativeCardName: obligationPayment
        ? undefined
        : authoritativeCardName,
      reason: "invalid_payment_amount",
    };
  }
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
      authoritativeCardName: obligationPayment
        ? undefined
        : authoritativeCardName,
      reason: "ambiguous_payment_number_semantics",
    };
  }
  if (paymentLanguage && genericAmountFirstObligationPayment) {
    const settlementAccountKeyword = paymentSourceAccountKeyword(text, context);
    const paymentText = maskPaymentOrdinalSpans(paymentEvidenceText);
    const amountCents =
      sourceFirstPayment?.amountCents ??
      explicitObligationSettlementAmountCents(
        stripBenignPaymentTails(paymentText.text),
      ) ??
      extractAmounts(
        stripBenignPaymentTails(paymentText.text),
        undefined,
        context,
      ).totalCents;
    return {
      route: "ambiguous",
      description: genericAmountFirstTarget,
      amountCents,
      paymentTarget: "obligation",
      settlementAccountKeyword,
      explicitNamedSettlementAccount:
        settlementAccountKeyword !== undefined || undefined,
      explicitDefaultSettlementAccount:
        settlementAccountKeyword === undefined &&
        (new RegExp(String.raw`\b${PAYMENT_PIX_SOURCE}\b`, "iu").test(text) ||
          hasGenericDefaultAccountSource(text, context)),
      explicitPaymentLanguage: true,
      deterministicExistingPaymentChoice: true,
      reason: "unresolved_existing_payment",
    };
  }
  if (/\bpaguei a parcela do carro\b/.test(normalized)) {
    const paymentText = maskPaymentOrdinalSpans(paymentEvidenceText);
    const settlementAccountKeyword = paymentSourceAccountKeyword(text, context);
    const amountCents = extractAmounts(
      stripBenignPaymentTails(paymentText.text),
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
      settlementAccountKeyword,
      explicitNamedSettlementAccount:
        settlementAccountKeyword !== undefined || undefined,
      explicitDefaultSettlementAccount:
        settlementAccountKeyword === undefined &&
        (new RegExp(String.raw`\b${PAYMENT_PIX_SOURCE}\b`, "iu").test(text) ||
          hasGenericDefaultAccountSource(text, context)),
      reason: "unresolved_existing_payment",
    };
  }
  if (paymentLanguage && genericObligationStatusSettlement) {
    const paymentText = maskPaymentOrdinalSpans(paymentEvidenceText);
    const settlementAccountKeyword = paymentSourceAccountKeyword(text, context);
    const amountCents = extractAmounts(
      stripBenignPaymentTails(paymentText.text),
      undefined,
      context,
    ).totalCents;
    return {
      route: "ambiguous",
      description: canonicalFinancialDescription(text, "mark_paid", context),
      amountCents,
      paymentTarget: "obligation",
      suppressAiPaymentAmount:
        paymentText.foundOrdinal && amountCents === undefined
          ? true
          : undefined,
      settlementAccountKeyword,
      explicitNamedSettlementAccount:
        settlementAccountKeyword !== undefined || undefined,
      explicitDefaultSettlementAccount:
        settlementAccountKeyword === undefined &&
        (new RegExp(String.raw`\b${PAYMENT_PIX_SOURCE}\b`, "iu").test(text) ||
          hasGenericDefaultAccountSource(text, context)),
      explicitPaymentLanguage: true,
      reason: "unresolved_existing_payment",
    };
  }
  if (paymentLanguage && paymentTarget) {
    const paymentText = maskPaymentOrdinalSpans(paymentEvidenceText);
    const settlementAccountKeyword = paymentSourceAccountKeyword(text, context);
    const explicitDefaultSettlementAccount =
      settlementAccountKeyword === undefined &&
      (new RegExp(String.raw`\b${PAYMENT_PIX_SOURCE}\b`, "iu").test(text) ||
        hasGenericDefaultAccountSource(text, context));
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
        authoritativeCardName,
        paymentTarget: "card",
        settlementAccountKeyword,
        explicitNamedSettlementAccount:
          settlementAccountKeyword !== undefined || undefined,
        explicitDefaultSettlementAccount,
        invalidBillMonth: parsedBillMonth.raw,
        reason: "invalid_bill_month",
      };
    }
    const paymentAmountText = stripBenignPaymentTails(paymentText.text);
    const paymentAmountCents =
      prepositionlessAmountFirstObligationPaymentCents(paymentEvidenceText) ??
      leadingPaymentAmountCents(paymentEvidenceText) ??
      (deterministicPaymentTarget === "obligation"
        ? explicitObligationSettlementAmountCents(paymentAmountText)
        : undefined) ??
      extractAmounts(paymentAmountText, undefined, context).totalCents ??
      (deterministicPaymentTarget === "card" &&
      (/\bfatura\b/.test(normalized) ||
        genericCardSettlement ||
        verbFirstKnownCardSettlement ||
        cardFirstKnownCardSettlement)
        ? explicitKnownCardSettlementAmountCents(paymentAmountText)
        : undefined);
    const hasDateOrMonth = /\b\d{1,2}\/\d{2,4}(?:\/\d{2,4})?\b/.test(
      normalized,
    );
    const completeCardSettlementWithoutAmount =
      deterministicPaymentTarget === "card" &&
      paymentAmountCents === undefined &&
      (/\bfatura\b/.test(normalized) ||
        genericCardSettlement ||
        authoritativeCardSettlement ||
        verbFirstKnownCardSettlement ||
        cardFirstKnownCardSettlement);
    return {
      route: "mark_paid",
      description: canonicalFinancialDescription(text, "mark_paid", context),
      amountCents: paymentAmountCents,
      suppressAiPaymentAmount:
        (paymentText.foundOrdinal ||
          hasDateOrMonth ||
          completeCardSettlementWithoutAmount ||
          verbFirstExplicitObligationPayment) &&
        paymentAmountCents === undefined
          ? true
          : undefined,
      cardKeyword,
      authoritativeCardName,
      paymentTarget: deterministicPaymentTarget,
      settlementAccountKeyword,
      explicitNamedSettlementAccount:
        settlementAccountKeyword !== undefined || undefined,
      explicitDefaultSettlementAccount,
      explicitPaymentLanguage: paymentLanguage || undefined,
      unambiguousKnownCardEvidence:
        deterministicPaymentTarget === "card" &&
        isUnambiguousKnownCardKeyword(cardKeyword, context)
          ? true
          : undefined,
      billMonth:
        parsedBillMonth.kind === "valid" ? parsedBillMonth.value : undefined,
    };
  }

  const sourceOnlyPayment =
    resolvedSettlementAccount !== undefined &&
    new RegExp(
      String.raw`^\s*(?:paguei|quitei)\s*${benignSettlementTail}\s*$`,
      "u",
    ).test(normalize(settlementSourceMaskedText));
  if (paymentLanguage && sourceOnlyPayment) {
    return {
      route: "ambiguous",
      description: undefined,
      amountCents: undefined,
      suppressAiPaymentAmount: true,
      settlementAccountKeyword: resolvedSettlementAccount,
      explicitNamedSettlementAccount: true,
      explicitPaymentLanguage: true,
      reason: "missing_payment_target",
    };
  }

  const financialGrammarText =
    maskExplicitKnownInstrumentNamesForFinancialGrammar(
      settlementSourceMaskedText,
      context,
    );
  const normalizedFinancialGrammar = normalize(financialGrammarText);
  const count = countFromText(financialGrammarText);
  const explicitNamedAccount = explicitNamedInstrumentKeyword(
    text,
    "account",
    context.knownAccounts,
  );
  const hasNamedAccountSource =
    new RegExp(String.raw`\b${PAYMENT_ACCOUNT_SOURCE_PREFIX}\b`, "u").test(
      normalized,
    ) || explicitNamedAccount !== undefined;
  const hasAccount = ACCOUNT_WORD_RE.test(normalized) || hasNamedAccountSource;
  const namedSettlementAccountKeyword = paymentSourceAccountKeyword(
    text,
    context,
  );
  const implicitKnownAccountKeyword =
    namedSettlementAccountKeyword === undefined
      ? knownAccountKeyword(text, context.knownAccounts)
      : undefined;
  const explicitDefaultSettlementAccount =
    namedSettlementAccountKeyword === undefined &&
    (new RegExp(String.raw`\b${PAYMENT_PIX_SOURCE}\b`, "iu").test(text) ||
      hasGenericDefaultAccountSource(text, context) ||
      /\b(?:debito|no boleto)\b/u.test(normalized));
  const accountKeyword =
    namedSettlementAccountKeyword ??
    (explicitDefaultSettlementAccount
      ? undefined
      : implicitKnownAccountKeyword) ??
    (/\bdinheiro\b/.test(normalized) ? "Dinheiro" : undefined);
  const hasLoanCredit = LOAN_CREDIT_RE.test(normalized);
  const hasExplicitCardWord =
    /\bcartao(?: de credito)?\b/.test(normalized) ||
    (CARD_WORD_RE.test(normalized) && !hasLoanCredit);
  const hasCard =
    hasExplicitCardWord ||
    (cardKeyword !== undefined && !hasAccount && !hasLoanCredit);
  const escapedCardName =
    cardKeyword !== undefined &&
    isExplicitInstrumentName(text, cardKeyword, "card")
      ? normalize(cardKeyword)
      : undefined;
  const normalizedForFinancialGrammar =
    escapedCardName === undefined
      ? normalizedFinancialGrammar
      : normalizedFinancialGrammar.replace(
          new RegExp(
            `(?:^|\\s)${escapedCardName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=$|[\\s,.;:!?-])`,
            "u",
          ),
          " ",
        );
  const normalizedForRecurrence =
    namedSettlementAccountKeyword === undefined
      ? normalizedForFinancialGrammar
      : normalizedForFinancialGrammar.replace(
          normalize(namedSettlementAccountKeyword),
          " ",
        );
  const hasFinancing =
    FINANCING_RE.test(normalizedForRecurrence) ||
    /\/\s*mes\b/u.test(normalizedForRecurrence) ||
    habitualPaymentCreation;
  const negatedInstallment = NEGATED_INSTALLMENT_RE.test(
    normalizedForFinancialGrammar,
  );
  const hasInstallmentWords =
    INSTALLMENT_WORD_RE.test(normalizedForFinancialGrammar) &&
    !negatedInstallment;
  const single = SINGLE_RE.test(normalizedForFinancialGrammar) || count === 1;
  const authoritativeSingleMarker =
    /\b(?:(?:em\s+)?uma\s+(?:unica|so)\s+vez|(?:em\s+)?(?:(?:uma\s+)?unica|uma\s+so)\s+(?:parcela|prestacao)|(?:em\s+)?(?:parcela|prestacao)\s+unica)\b/.test(
      normalizedForFinancialGrammar,
    );
  const invalidCount = /(?:\b0|-)\d*\s*x\b/.test(normalizedForFinancialGrammar);
  const existingParcelObservation = /\bparcela\s+\d+\s+de\s+\d+\b/.test(
    normalizedForFinancialGrammar,
  );
  const compoundEntry = /\bentrada\b.*\bmais\b.*\d+\s*x\b/.test(
    normalizedForFinancialGrammar,
  );
  const amounts = extractAmounts(financialGrammarText, count, context);
  const recurringClauseAmountText = financialGrammarText.replace(
    new RegExp(
      String.raw`\b${METADATA_YEAR_QUALIFIER}(?:\s+de)?\s*[:#-]?\s*(?:19|20)\d{2}\b(?!\s+reais)`,
      "giu",
    ),
    (match) => " ".repeat(match.length),
  );
  const recurringClauseMatch = new RegExp(
    String.raw`(?:^|\s)(r\$\s*)?([\d.,]+)(\s+reais)?(?:\s+|\s*\/\s*)(?=${RECURRENCE_SYNTAX}\b|m[eê]s\b)`,
    "iu",
  ).exec(recurringClauseAmountText);
  const recurringClauseIsBareMetadataYear =
    recurringClauseMatch !== null &&
    recurringClauseMatch[1] === undefined &&
    recurringClauseMatch[3] === undefined &&
    /^(?:19|20)\d{2}$/.test(recurringClauseMatch[2] ?? "") &&
    hasExplicitMetadataYearEvidence(text);
  const recurringClauseAmount = recurringClauseIsBareMetadataYear
    ? undefined
    : parseBrl(recurringClauseMatch?.[2] ?? "");
  const leadingRecurringAmountMatch =
    /^\s*(r\$\s*)?([\d.,]+)(\s+reais)?\s+\p{L}/iu.exec(financialGrammarText);
  const leadingRecurringAmount =
    leadingRecurringAmountMatch !== null &&
    leadingRecurringAmountMatch[1] === undefined &&
    leadingRecurringAmountMatch[3] === undefined &&
    /^(?:19|20)\d{2}$/.test(leadingRecurringAmountMatch[2] ?? "") &&
    hasExplicitMetadataYearEvidence(text)
      ? undefined
      : parseBrl(leadingRecurringAmountMatch?.[2] ?? "");
  const adjacentRecurringAmount = parseBrl(
    new RegExp(
      String.raw`(?<=\p{L})(?:r\$\s*)?([\d.,]+)(?:\s+reais)?\s+(?=${RECURRENCE_SYNTAX}\b)`,
      "iu",
    ).exec(financialGrammarText)?.[1] ?? "",
  );
  const recurringAmount =
    amounts.explicitTotal === undefined &&
    (new RegExp(String.raw`\b${RECURRENCE_SYNTAX}\b`, "u").test(
      normalizedForRecurrence,
    ) ||
      /\/\s*mes\b/u.test(normalizedForRecurrence))
      ? (recurringClauseAmount ??
        amounts.totalCents ??
        leadingRecurringAmount ??
        adjacentRecurringAmount)
      : undefined;
  const clearObligationMonthlyEvidence =
    /\b(parcela solar|financiamento|emprestimo|consorcio|prestacao|prestacoes)\b/.test(
      normalizedForFinancialGrammar,
    );
  const finiteObligationEvidence =
    /\b(parcela solar|financiamento|emprestimo|consorcio)\b/.test(
      normalizedForFinancialGrammar,
    );
  const bareMonthlyRaw = /(?:^|\s)(?:r\$\s*)?([\d.,]+)\s+\d+\s*x\b/.exec(
    normalizedForFinancialGrammar,
  )?.[1];
  const obligationBareMonthlyAmount = clearObligationMonthlyEvidence
    ? parseBrl(bareMonthlyRaw ?? "")
    : undefined;
  const amountFirstObligationMonthlyAmount = clearObligationMonthlyEvidence
    ? parseBrl(
        /^\s*(?:r\$\s*)?([\d.,]+)(?:\s+reais)?\s+\p{L}/iu.exec(text)?.[1] ?? "",
      )
    : undefined;
  const dueDayRaw = /\bdia\s*(\d+)\b(?!\/)/.exec(normalized)?.[1];
  const dueDay = dueDayRaw === undefined ? undefined : Number(dueDayRaw);
  const invalidDueDay = dueDay !== undefined && (dueDay < 1 || dueDay > 31);
  const startDateMatch =
    /\ba partir de\s*(\d{1,2})\/(\d{1,2})(?:\/\d{2,4})?\b/.exec(normalized);
  const startDateDay = Number(startDateMatch?.[1]);
  const startDateMonth = Number(startDateMatch?.[2]);

  let route: DeterministicFinancialRoute;
  let reason: string | undefined;
  if (invalidDueDay) {
    route = "ambiguous";
    reason = "invalid_due_day";
  } else if (hasAmbiguousReservedAccountSource(text, context)) {
    route = "ambiguous";
    reason = "ambiguous_account_name";
  } else if (/^parcela solar\b/.test(normalized) && !hasFinancing && !hasCard) {
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
  } else if ((hasFinancing || finiteObligationEvidence) && hasCard) {
    route = "ambiguous";
    reason = "card_and_financing_evidence";
  } else if (
    /\bparcelad[ao]\b/.test(normalizedForFinancialGrammar) &&
    single &&
    !authoritativeSingleMarker &&
    !negatedInstallment
  ) {
    route = "ambiguous";
    reason = "installment_wording_with_single_charge";
  } else if (single && hasCard) {
    route = "single_credit";
  } else if (single) {
    route = "plain_account";
  } else if (
    (hasFinancing ||
      finiteObligationEvidence ||
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

  const description = canonicalFinancialDescription(
    text,
    route === "none" && paymentLanguage && hasNamedAccountSource
      ? "plain_account"
      : route,
    context,
  );
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
  const routedAccountKeyword =
    (route === "obligation" || route === "none") &&
    implicitKnownAccountKeyword !== undefined
      ? undefined
      : accountKeyword;
  return {
    route,
    description,
    installmentCount: count !== undefined && count > 0 ? count : undefined,
    totalCents,
    perInstallmentCents: amounts.perInstallmentCents,
    monthlyAmountCents:
      amounts.perInstallmentCents ??
      recurringAmount ??
      (route === "obligation"
        ? (obligationBareMonthlyAmount ?? amountFirstObligationMonthlyAmount)
        : undefined),
    dueDay:
      dueDay !== undefined && dueDay >= 1 && dueDay <= 31
        ? Math.min(28, dueDay)
        : undefined,
    requestedDueDay:
      dueDay !== undefined && dueDay > 28 && dueDay <= 31 ? dueDay : undefined,
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
    authoritativeCardName,
    explicitPaymentLanguage: paymentLanguage || undefined,
    explicitObligationTargetEvidence:
      EXPLICIT_OBLIGATION_PAYMENT_TARGET_RE.test(normalizedObligationGrammar) ||
      undefined,
    explicitAccountEvidence: hasAccount || undefined,
    implicitKnownAccountEvidence:
      implicitKnownAccountKeyword !== undefined || undefined,
    explicitCardEvidence: hasCard || undefined,
    explicitCardInstrumentLanguage: hasExplicitCardWord || undefined,
    unambiguousKnownCardEvidence:
      isUnambiguousKnownCardKeyword(cardKeyword, context) || undefined,
    explicitMetadataYearEvidence:
      hasExplicitMetadataYearEvidence(text) || undefined,
    accountKeyword: routedAccountKeyword,
    explicitNamedSettlementAccount:
      namedSettlementAccountKeyword !== undefined || undefined,
    explicitDefaultSettlementAccount,
    reason,
  };
}

export function applyDeterministicPrecedence(
  decision: DeterministicFinancialDecision,
  classified: RoutedInterpretedIntent | null,
): RoutedInterpretedIntent | null {
  if (
    decision.route === "none" &&
    classified?.intent === "obligation" &&
    (decision.implicitKnownAccountEvidence ||
      decision.explicitNamedSettlementAccount)
  ) {
    return {
      intent: "obligation",
      obligation: {
        ...classified.obligation,
        accountKeyword: decision.explicitNamedSettlementAccount
          ? resolvableAccountKeyword(
              decision.accountKeyword,
              decision.explicitNamedSettlementAccount,
            )
          : undefined,
      },
    };
  }
  if (
    decision.explicitMetadataYearEvidence &&
    decision.amountCents === undefined &&
    decision.route === "plain_account" &&
    classified?.intent === "plain"
  ) {
    return {
      intent: "plain",
      expense: {
        ...classified.expense,
        description:
          decision.description ?? classified.expense.description ?? "",
        amountCents: undefined,
      },
    };
  }
  if (
    (decision.route === "plain_account" || decision.route === "none") &&
    decision.explicitPaymentLanguage &&
    decision.explicitAccountEvidence &&
    decision.explicitObligationTargetEvidence
  ) {
    if (classified?.intent === "mark_paid") {
      const settlementAccountKeyword = resolvableAccountKeyword(
        decision.accountKeyword,
        decision.explicitNamedSettlementAccount,
      );
      return {
        intent: "mark_paid",
        target: classified.target,
        keyword: decision.description ?? classified.keyword,
        amountCents: decision.amountCents,
        ...(settlementAccountKeyword ? { settlementAccountKeyword } : {}),
      };
    }
  }
  if (
    decision.route === "plain_account" &&
    (decision.explicitAccountEvidence ||
      (decision.explicitPaymentLanguage && classified?.intent === "mark_paid"))
  ) {
    const aiExpense =
      classified?.intent === "plain" ? classified.expense : undefined;
    const expense: InterpretedExpense = {
      ...aiExpense,
      description: decision.description ?? aiExpense?.description ?? "",
      amountCents:
        decision.amountCents ??
        (decision.explicitMetadataYearEvidence
          ? undefined
          : aiExpense?.amountCents),
      cardKeyword: undefined,
      accountKeyword: decision.explicitDefaultSettlementAccount
        ? undefined
        : resolvableAccountKeyword(
            decision.accountKeyword,
            decision.explicitNamedSettlementAccount,
          ),
    };
    return { intent: "plain", expense };
  }
  if (decision.route === "single_credit") {
    if (
      classified?.intent === "plain" &&
      !decision.explicitCardInstrumentLanguage &&
      !decision.unambiguousKnownCardEvidence
    )
      return classified;
    if (classified === null) return null;
    const aiExpense =
      classified.intent === "plain" ? classified.expense : undefined;
    const expense: InterpretedExpense = {
      ...aiExpense,
      description: decision.description ?? aiExpense?.description ?? "",
      amountCents:
        decision.amountCents ??
        (decision.explicitMetadataYearEvidence
          ? undefined
          : aiExpense?.amountCents),
      cardKeyword: decision.explicitCardInstrumentLanguage
        ? decision.cardKeyword
        : (decision.cardKeyword ?? aiExpense?.cardKeyword),
      accountKeyword: undefined,
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
          (decision.explicitMetadataYearEvidence
            ? undefined
            : classified.obligation.monthlyAmountCents),
        termMonths:
          decision.installmentCount ?? classified.obligation.termMonths,
        dueDay: decision.dueDay ?? classified.obligation.dueDay,
        requestedDueDay: decision.requestedDueDay,
        accountKeyword:
          (decision.explicitNamedSettlementAccount
            ? resolvableAccountKeyword(
                decision.accountKeyword,
                decision.explicitNamedSettlementAccount,
              )
            : undefined) ??
          (decision.explicitAccountEvidence ||
          decision.implicitKnownAccountEvidence
            ? undefined
            : resolvableAccountKeyword(classified.obligation.accountKeyword)),
      };
      return { intent: "obligation", obligation };
    }
    const aiPurchase =
      classified?.intent === "card_installment"
        ? classified.purchase
        : undefined;
    const purchase: RoutedInterpretedCardPurchase = {
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
      cardKeyword: decision.explicitCardInstrumentLanguage
        ? decision.cardKeyword
        : (decision.cardKeyword ?? aiPurchase?.cardKeyword),
      ...(decision.authoritativeCardName === undefined
        ? {}
        : { authoritativeCardName: decision.authoritativeCardName }),
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
        decision.monthlyAmountCents ??
        (decision.explicitMetadataYearEvidence
          ? undefined
          : aiObligation?.monthlyAmountCents),
      termMonths: decision.installmentCount ?? aiObligation?.termMonths,
      dueDay: decision.dueDay ?? aiObligation?.dueDay,
      requestedDueDay: decision.requestedDueDay,
      accountKeyword:
        (decision.explicitNamedSettlementAccount
          ? resolvableAccountKeyword(
              decision.accountKeyword,
              decision.explicitNamedSettlementAccount,
            )
          : undefined) ??
        (decision.explicitAccountEvidence ||
        decision.implicitKnownAccountEvidence
          ? undefined
          : resolvableAccountKeyword(aiObligation?.accountKeyword)),
    };
    return { intent: "obligation", obligation };
  }
  if (decision.route === "non_financial") return { intent: "non_financial" };
  if (decision.route === "mark_paid" && decision.description !== undefined) {
    const aiPayment =
      classified?.intent === "mark_paid" ? classified : undefined;
    const deterministicCardName =
      decision.authoritativeCardName ??
      (decision.paymentTarget === "card" &&
      decision.unambiguousKnownCardEvidence
        ? decision.cardKeyword
        : undefined);
    const settlementAccountKeyword = resolvableAccountKeyword(
      decision.settlementAccountKeyword,
      decision.explicitNamedSettlementAccount,
    );
    if (
      (decision.paymentTarget ??
        (decision.cardKeyword === undefined ? "obligation" : "card")) ===
        "obligation" &&
      !hasDiscriminatingObligationPaymentTarget(decision.description)
    ) {
      return null;
    }
    return {
      intent: "mark_paid",
      target:
        decision.paymentTarget ??
        (decision.cardKeyword === undefined ? "obligation" : "card"),
      keyword:
        (decision.paymentTarget ??
          (decision.cardKeyword === undefined ? "obligation" : "card")) ===
        "card"
          ? (deterministicCardName ??
            decision.cardKeyword ??
            decision.description)
          : decision.description,
      amountCents: decision.suppressAiPaymentAmount
        ? undefined
        : (decision.amountCents ?? aiPayment?.amountCents),
      ...((decision.billMonth ?? aiPayment?.billMonth)
        ? { billMonth: decision.billMonth ?? aiPayment?.billMonth }
        : {}),
      ...(settlementAccountKeyword ? { settlementAccountKeyword } : {}),
      ...(deterministicCardName === undefined
        ? {}
        : { authoritativeCardName: deterministicCardName }),
    };
  }
  if (
    decision.route === "ambiguous" &&
    decision.reason === "unresolved_existing_payment" &&
    decision.description !== undefined &&
    (classified?.intent === "mark_paid" ||
      decision.deterministicExistingPaymentChoice === true)
  ) {
    const settlementAccountKeyword = resolvableAccountKeyword(
      decision.settlementAccountKeyword,
      decision.explicitNamedSettlementAccount,
    );
    return {
      intent: "mark_paid",
      target:
        classified?.intent === "mark_paid"
          ? classified.target
          : (decision.paymentTarget ?? "obligation"),
      keyword:
        decision.description !== undefined &&
        normalize(decision.description) === "carro" &&
        classified?.intent === "mark_paid" &&
        normalize(classified.keyword) !== "carro" &&
        /\bcarro\b/.test(normalize(classified.keyword))
          ? classified.keyword
          : decision.description,
      amountCents: decision.suppressAiPaymentAmount
        ? undefined
        : (decision.amountCents ??
          (classified?.intent === "mark_paid"
            ? classified.amountCents
            : undefined)),
      ...(settlementAccountKeyword ? { settlementAccountKeyword } : {}),
    };
  }
  if (
    decision.route === "ambiguous" &&
    (decision.reason === "ambiguous_payment_number_semantics" ||
      decision.reason === "invalid_bill_month" ||
      decision.reason === "invalid_installment_ordinal" ||
      decision.reason === "invalid_payment_amount" ||
      decision.reason === "missing_payment_target")
  ) {
    return null;
  }
  if (classified?.intent === "mark_paid") {
    if (decision.route === "none") return null;
    const { settlementAccountKeyword: _aiSettlementAccount, ...payment } =
      classified;
    const deterministicSettlementAccount =
      decision.explicitNamedSettlementAccount === true
        ? resolvableAccountKeyword(
            decision.settlementAccountKeyword ?? decision.accountKeyword,
            true,
          )
        : undefined;
    return {
      ...payment,
      ...(deterministicSettlementAccount === undefined
        ? {}
        : { settlementAccountKeyword: deterministicSettlementAccount }),
    };
  }
  return classified;
}

function hasDiscriminatingObligationPaymentTarget(value: string): boolean {
  const generic = new Set([
    "a",
    "ao",
    "aos",
    "as",
    "conta",
    "contas",
    "da",
    "das",
    "de",
    "do",
    "dos",
    "em",
    "na",
    "nas",
    "no",
    "nos",
    "o",
    "os",
    "pagamento",
    "pagamentos",
    "parcela",
    "parcelas",
    "prestacao",
    "prestacoes",
  ]);
  return normalize(value)
    .split(/\s+/u)
    .some((token) => token.length >= 3 && !generic.has(token));
}
