import { describe, expect, it } from "vitest";

import {
  applyDeterministicPrecedence,
  detectFinancialRoute,
  type DeterministicFinancialRoute,
} from "./financial-routing.js";

type CorpusCase = {
  id: string;
  message: string;
  route: DeterministicFinancialRoute;
  description?: string;
};

const ci = (id: string, message: string, description: string): CorpusCase => ({
  id,
  message,
  route: "installment",
  description,
});

const pc = (id: string, message: string, description?: string): CorpusCase => ({
  id,
  message,
  route: "single_credit",
  description,
});
const pa = (id: string, message: string, description: string): CorpusCase => ({
  id,
  message,
  route: "plain_account",
  description,
});
const ob = (id: string, message: string, description: string): CorpusCase => ({
  id,
  message,
  route: "obligation",
  description,
});
const mp = (id: string, message: string, description: string): CorpusCase => ({
  id,
  message,
  route: "mark_paid",
  description,
});
const cl = (id: string, message: string, description?: string): CorpusCase => ({
  id,
  message,
  route: "ambiguous",
  description,
});
const nf = (id: string, message: string): CorpusCase => ({
  id,
  message,
  route: "non_financial",
});

const cases: CorpusCase[] = [
  ci("001", "Notebook 3600 em 12x no Nubank", "Notebook"),
  ci("002", "Notebook em 12x de 300 no credito nubank", "Notebook"),
  ci("003", "Airfryer no Mercado Livre, 600 em 6x no Nubank", "Airfryer"),
  ci("004", "TV 8 parcelas de 250 no C6", "TV"),
  ci("005", "Geladeira de 4.800 parcelada em 10 vezes no Inter", "Geladeira"),
  ci("006", "Sofá 5400, parcelei em 18x no Nubank", "Sofá"),
  ci("007", "Curso 1200 dividido em 6 vezes no cartão Inter", "Curso"),
  ci("008", "Celular 4800 em 24x sem juros no Nubank", "Celular"),
  ci("009", "Óculos 800 em 4x com juros no C6", "Óculos"),
  ci("010", "Tênis de R$ 1.999,90 em 10x no Inter", "Tênis"),
  ci(
    "011",
    "Mercado Livre 1.200,00 em 12 vezes usando Nubank",
    "Mercado Livre",
  ),
  ci("012", "ml 1200 12x nubank", "Mercado Livre"),
  ci(
    "013",
    "comprei um aspirador mil e duzentos em doze vezes no nubank",
    "Aspirador",
  ),
  ci("014", "iPhone 4800 12x Nubank", "iPhone"),
  ci("015", "Comprei uma cadeira parcelada no Nubank", "Cadeira"),
  ci("016", "Notebook em 12x no cartão", "Notebook"),
  ci("017", "Notebook 3600 em 12x", "Notebook"),
  ci("018", "Notebook 3600 em 12x no cartão XP", "Notebook"),
  ci("019", "Notebook 3600 em 12x no crédito Mercado Pago", "Notebook"),
  ci("020", "Notebook 3600 em 12x no Mercado Pago", "Notebook"),
  ci("021", "Comprei a TV ontem por 2400 em 12x no Nubank", "TV"),
  ci("022", "Geladeira 3000 em 10x no Inter dia 12/08", "Geladeira"),
  ci("023", "Karol comprou um celular 2400 em 12x no Nubank", "Celular"),
  ci("024", "Farmácia 300 em 3x no cartão, categoria saúde", "Farmácia"),
  ci("025", "Furadeira na Leroy Merlin por 600 em 6x no Nubank", "Furadeira"),
  ci(
    "026",
    "Comprei no Magazine Luiza uma máquina de lavar de 3600 em 12x no Inter",
    "Máquina de lavar",
  ),
  ci("027", "PS5 3500 10x C6", "PS5"),
  ci("028", "Mesa 900 em nove vezes no Nubank", "Mesa"),
  ci("029", "Ventilador 200 em duas parcelas no Inter", "Ventilador"),
  ci("030", "Fone 300 em 2x no Nubank", "Fone"),
  ci(
    "031",
    "Carro usado, entrada já paga, saldo 48000 em 48x no cartão",
    "Carro usado",
  ),
  ci("032", "Comprei uma cama 🛏️ por 1800 em 6x no Inter", "Cama"),
  ci("033", "R$1200 em 12x - Nubank - Mercado Livre", "Mercado Livre"),
  ci(
    "034",
    "Mercado Livre: 8 parcelas de R$ 75,00 no Mercado Pago",
    "Mercado Livre",
  ),
  ci("035", "Notebook em 10 prestações de 350 no cartão Nubank", "Notebook"),
  ci(
    "036",
    "Cada parcela da cadeira ficou 89,90, são 5 vezes no Inter",
    "Cadeira",
  ),
  ci("037", "Total 899 pelo celular em 9x no C6", "Celular"),
  ci("038", "Cadeira parcelada no Nubank, 3 parcelas, 150 no total", "Cadeira"),
  ci("039", "Cadeira 3x de 50, total 150, no Inter", "Cadeira"),
  ci(
    "040",
    "eu comprei uma cadeira de escritório por novecentos reais e dividi em seis vezes no cartão inter",
    "Cadeira de escritório",
  ),
  pc("041", "Mercado 230 no Nubank", "Mercado"),
  pc("042", "Posto 100 no crédito", "Posto"),
  pc("043", "Farmácia 45 no cartão Inter", "Farmácia"),
  pc("044", "Notebook 3600 em 1x no Nubank", "Notebook"),
  pc("045", "Notebook 3600 em uma vez no Nubank", "Notebook"),
  pc("046", "Notebook 3600 à vista no crédito", "Notebook"),
  pc("047", "Notebook 3600 em uma parcela no Nubank", "Notebook"),
  pc("048", "Monitor 600, compra única no cartão C6", "Monitor"),
  pc("049", "Uber 32 no crédito Nubank", "Uber"),
  pc("050", "iFood 68,90 no C6", "IFood"),
  pc("051", "Hotel 750 no cartão Inter", "Hotel"),
  pc("052", "Passei 250 no cartão"),
  pc("053", "Mercado 100 no crédito", "Mercado"),
  pc("054", "Mercado 100 no Nubank", "Mercado"),
  pc("055", "Mercado 100 no Mercado Pago", "Mercado"),
  pc("056", "Tênis 400 no cartão de crédito", "Tênis"),
  pc("057", "Tênis 400 no crédito à vista", "Tênis"),
  pc("058", "Tênis 600, 1 parcela de 600, Nubank", "Tênis"),
  pc("059", "Mochila 300 em uma prestação no cartão Inter", "Mochila"),
  pc("060", "Celular 2000 no Nubank sem parcelar", "Celular"),
  pc("061", "A cadeira de 500 no Inter não foi parcelada", "Cadeira"),
  pc("062", "Mercado no cartão Nubank, pagamento único de 250", "Mercado"),
  pc("063", "Comprei no crédito ontem, 180 reais, cartão C6"),
  pc(
    "064",
    "Assinatura anual 120 no cartão Nubank cobrada de uma vez",
    "Assinatura anual",
  ),
  pc("065", "Mercado 100 no cartão da Karol", "Mercado"),
  pa("066", "Mercado 230 no Pix", "Mercado"),
  pa("067", "Padaria 28 em dinheiro", "Padaria"),
  pa("068", "Farmácia 45 no débito Nubank", "Farmácia"),
  pa("069", "Uber 32 na conta Inter", "Uber"),
  pa("070", "Escola 500 no boleto", "Escola"),
  pa("071", "Almoço 75", "Almoço"),
  pa("072", "Ontem gastei 84,50 no mercado", "Mercado"),
  pa("073", "paguei trinta e dois reais no café hoje cedo", "Café"),
  pa("074", "Cinema R$ 60,00 dinheiro", "Cinema"),
  pa("075", "Conta de luz deste mês 210 no débito", "Conta de luz"),
  ob("076", "Parcela solar 710,44 72x a partir de 05/10", "Parcela solar"),
  ob(
    "077",
    "Financiamento do carro 1500 por 48 meses",
    "Financiamento do carro",
  ),
  ob("078", "Empréstimo 24 parcelas de 500 debitadas na conta", "Empréstimo"),
  ob("079", "Aluguel 1200 todo mês dia 10", "Aluguel"),
  ob("080", "Internet 119,90 mensal no débito", "Internet"),
  ob("081", "Academia 99 todo mês na conta Nubank", "Academia"),
  ob("082", "Curso parcelado no boleto, 10 boletos de 200", "Curso"),
  ob("083", "Consórcio 850 por 60 meses", "Consórcio"),
  ob("084", "IPTU em 10x no boleto, parcela de 180", "IPTU"),
  ob("085", "Placas solares 51.000 em 72x no financiamento", "Placas solares"),
  mp("086", "Nubank pago", "Nubank"),
  mp("087", "Paguei a fatura do Inter 2350", "Inter"),
  mp("088", "Parcela solar paga", "Parcela solar"),
  mp(
    "089",
    "Paguei o financiamento do carro este mês",
    "Financiamento do carro",
  ),
  mp("090", "Fatura Mercado Pago quitada", "Mercado Pago"),
  cl("091", "Notebook 3600 parcelado em 1x no Nubank", "Notebook"),
  cl("092", "Notebook 3600 em 0x no Nubank", "Notebook"),
  cl("093", "Notebook 3600 em -3x no Nubank", "Notebook"),
  cl("094", "Parcela 3 de 10 do notebook 300 no Nubank", "Notebook"),
  cl("095", "Notebook entrada 500 mais 10x de 200 no Nubank", "Notebook"),
  cl("096", "Notebook 3x de 50, total 200, no Inter", "Notebook"),
  cl("097", "710 reais em 72x"),
  cl("098", "Paguei a parcela do carro 900", "Carro"),
  nf("099", "Bom dia, tudo bem?"),
  nf("100", "Qual a previsão do tempo hoje?"),
];

const context = {
  knownCards: [
    { id: "nubank-card", name: "Nubank" },
    { id: "inter-card", name: "Inter" },
    { id: "c6-card", name: "C6" },
    { id: "mp-card", name: "Mercado Pago" },
  ],
  knownAccounts: [
    { id: "nubank-account", name: "Nubank" },
    { id: "inter-account", name: "Inter" },
  ],
};

describe("deterministic Telegram financial routing corpus", () => {
  it("contains exactly the approved 100 hand-labelled messages", () => {
    expect(cases).toHaveLength(100);
    expect(new Set(cases.map((item) => item.id)).size).toBe(100);
  });

  it.each(cases)("$id $message", (fixture) => {
    const actual = detectFinancialRoute(fixture.message, context);
    expect(actual.route).toBe(fixture.route);
    expect(actual.description).toBe(fixture.description);
  });

  it("extracts the exact Notebook regression without leaking credit syntax", () => {
    const actual = detectFinancialRoute(
      "Notebook em 12x de 300 no credito nubank",
      context,
    );
    expect(actual).toMatchObject({
      route: "installment",
      description: "Notebook",
      installmentCount: 12,
      perInstallmentCents: 30_000,
      totalCents: 360_000,
      cardKeyword: "Nubank",
    });
  });

  it.each([
    [
      "a conflicting plain expense",
      {
        intent: "plain" as const,
        expense: { description: "Notebook errado", amountCents: 1 },
      },
    ],
    [
      "an already correct installment",
      {
        intent: "card_installment" as const,
        purchase: {
          description: "Notebook",
          totalCents: 30_000,
          installmentCount: 3,
          perInstallmentCents: 10_000,
          cardKeyword: "Nubank",
        },
      },
    ],
    ["no classifier result", null],
  ])(
    "treats spoken `vezes de` as a per-installment amount with %s",
    (_label, classified) => {
      const decision = detectFinancialRoute(
        "Notebook em 3 vezes de 100 no Nubank",
        context,
      );

      expect(decision).toMatchObject({
        route: "installment",
        description: "Notebook",
        installmentCount: 3,
        perInstallmentCents: 10_000,
        totalCents: 30_000,
        amountKind: "per_installment",
        cardKeyword: "Nubank",
      });
      expect(applyDeterministicPrecedence(decision, classified)).toMatchObject({
        intent: "card_installment",
        purchase: {
          description: "Notebook",
          installmentCount: 3,
          perInstallmentCents: 10_000,
          cardKeyword: "Nubank",
        },
      });
    },
  );

  it.each([
    [
      "a conflicting expense",
      {
        intent: "plain" as const,
        expense: { description: "Empréstimo errado", amountCents: 1 },
      },
    ],
    [
      "an already correct obligation",
      {
        intent: "obligation" as const,
        obligation: {
          description: "Empréstimo",
          monthlyAmountCents: 50_000,
          termMonths: 12,
        },
      },
    ],
    ["no classifier result", null],
  ])(
    "carries spoken `vezes de` into finite-obligation monthly terms with %s",
    (_label, classified) => {
      const decision = detectFinancialRoute(
        "Empréstimo em 12 vezes de 500",
        context,
      );

      expect(decision).toMatchObject({
        route: "obligation",
        description: "Empréstimo",
        installmentCount: 12,
        perInstallmentCents: 50_000,
        monthlyAmountCents: 50_000,
        totalCents: 600_000,
        amountKind: "per_installment",
      });
      expect(applyDeterministicPrecedence(decision, classified)).toMatchObject({
        intent: "obligation",
        obligation: {
          description: "Empréstimo",
          monthlyAmountCents: 50_000,
          termMonths: 12,
        },
      });
    },
  );

  it.each([
    [
      "a wrong AI payment",
      {
        intent: "mark_paid" as const,
        target: "card" as const,
        keyword: "Nubank",
        amountCents: 1,
      },
    ],
    [
      "a correct AI payment",
      {
        intent: "mark_paid" as const,
        target: "obligation" as const,
        keyword: "Aluguel",
        amountCents: 120_000,
      },
    ],
    ["no classifier result", null],
  ])(
    "extracts spoken rent payment money without leaking it into the target with %s",
    (_label, classified) => {
      const decision = detectFinancialRoute(
        "Paguei aluguel mil e duzentos",
        context,
      );

      expect(decision).toMatchObject({
        route: "mark_paid",
        description: "Aluguel",
        amountCents: 120_000,
        paymentTarget: "obligation",
      });
      expect(applyDeterministicPrecedence(decision, classified)).toEqual({
        intent: "mark_paid",
        target: "obligation",
        keyword: "Aluguel",
        amountCents: 120_000,
      });
    },
  );

  it("keeps every normal credit control out of installment routing", () => {
    for (const fixture of cases.slice(40, 65)) {
      expect(detectFinancialRoute(fixture.message, context).route).not.toBe(
        "installment",
      );
    }
  });

  it("enforces the safety precedence over incorrect AI classifications", () => {
    const installment = detectFinancialRoute(cases[1]?.message ?? "", context);
    expect(
      applyDeterministicPrecedence(installment, {
        intent: "plain",
        expense: { description: "Notebook 12x" },
      }),
    ).toMatchObject({
      intent: "card_installment",
      purchase: { description: "Notebook", installmentCount: 12 },
    });

    const single = detectFinancialRoute(cases[43]?.message ?? "", context);
    expect(
      applyDeterministicPrecedence(single, {
        intent: "card_installment",
        purchase: { description: "Notebook 1x", installmentCount: 12 },
      }),
    ).toMatchObject({ intent: "plain", expense: { description: "Notebook" } });

    const obligation = detectFinancialRoute(cases[76]?.message ?? "", context);
    expect(
      applyDeterministicPrecedence(obligation, {
        intent: "plain",
        expense: { description: "Financiamento" },
      }),
    ).toMatchObject({
      intent: "obligation",
      obligation: { description: "Financiamento do carro", termMonths: 48 },
    });
  });

  it("does not interpret dates or due days as monetary amounts", () => {
    expect(
      detectFinancialRoute("Aluguel todo mês dia 10", context),
    ).toMatchObject({
      route: "obligation",
      totalCents: undefined,
      perInstallmentCents: undefined,
      dueDay: 10,
    });
    expect(
      detectFinancialRoute("Condomínio mensal dia 12/08", context),
    ).toMatchObject({
      route: "obligation",
      totalCents: undefined,
      perInstallmentCents: undefined,
      dueDay: undefined,
    });
  });

  it("preserves financing totals without treating them as monthly amounts", () => {
    const decision = detectFinancialRoute(
      "Placas solares 51.000 em 72x no financiamento",
      context,
    );
    expect(decision).toMatchObject({
      route: "obligation",
      amountKind: "total",
      totalCents: 5_100_000,
      perInstallmentCents: undefined,
    });
    expect(applyDeterministicPrecedence(decision, null)).toMatchObject({
      intent: "obligation",
      obligation: {
        description: "Placas solares",
        monthlyAmountCents: undefined,
        termMonths: 72,
      },
    });
  });

  it("routes generic existing-installment payments to mark-paid", () => {
    const decision = detectFinancialRoute(
      "Paguei a parcela da internet 119,90",
      context,
    );
    expect(decision).toMatchObject({
      route: "mark_paid",
      description: "Internet",
      amountCents: 11_990,
    });
    expect(
      applyDeterministicPrecedence(decision, {
        intent: "mark_paid",
        target: "card",
        keyword: "Nubank",
        amountCents: 99_999,
      }),
    ).toEqual({
      intent: "mark_paid",
      target: "obligation",
      keyword: "Internet",
      amountCents: 11_990,
    });
  });

  it("keeps installment wording on boleto/account flows out of cards", () => {
    expect(
      detectFinancialRoute(
        "Conta de luz parcelada em 2 vezes no boleto",
        context,
      ),
    ).toMatchObject({
      route: "obligation",
      description: "Conta de luz",
      installmentCount: 2,
    });
  });

  it("distinguishes product specifications and model numbers from prices", () => {
    expect(
      detectFinancialRoute("iPhone 15 Pro 7200 em 12x no Nubank", context),
    ).toMatchObject({
      route: "installment",
      description: "iPhone 15 Pro",
      totalCents: 720_000,
    });
    expect(
      detectFinancialRoute(
        "Geladeira 400 litros parcelada em 12x no Nubank",
        context,
      ),
    ).toMatchObject({
      route: "installment",
      description: "Geladeira 400 litros",
      totalCents: undefined,
      perInstallmentCents: undefined,
    });
    expect(detectFinancialRoute("iPhone 15 no Pix", context)).toMatchObject({
      route: "plain_account",
      description: "iPhone 15",
      amountCents: undefined,
    });
    expect(
      detectFinancialRoute("PlayStation 5 no Nubank", context),
    ).toMatchObject({
      route: "single_credit",
      description: "PlayStation 5",
      amountCents: undefined,
    });
    expect(
      detectFinancialRoute("PlayStation 5 10x de 300 no Nubank", context),
    ).toMatchObject({
      route: "installment",
      description: "PlayStation 5",
      perInstallmentCents: 30_000,
      totalCents: 300_000,
    });
    expect(detectFinancialRoute("Posto 200 pix", context)).toMatchObject({
      route: "plain_account",
      description: "Posto",
      amountCents: 20_000,
    });
  });

  it("recognizes via account/card instruments without swallowing amount metadata", () => {
    expect(
      detectFinancialRoute("Mercado via conta Inter por 200", context),
    ).toMatchObject({
      route: "plain_account",
      description: "Mercado",
      amountCents: 20_000,
      accountKeyword: "Inter",
      explicitNamedSettlementAccount: true,
    });
    expect(
      detectFinancialRoute("Mercado via cartão Nubank por 200", context),
    ).toMatchObject({
      route: "single_credit",
      description: "Mercado",
      amountCents: 20_000,
      cardKeyword: "Nubank",
    });
    expect(
      detectFinancialRoute("Mercado via conta Desconhecida por 200", context),
    ).toMatchObject({
      route: "plain_account",
      accountKeyword: "Desconhecida",
      explicitNamedSettlementAccount: true,
    });
    expect(detectFinancialRoute("Mercado 200 via Pix", context)).toMatchObject({
      route: "plain_account",
      amountCents: 20_000,
      accountKeyword: undefined,
      explicitDefaultSettlementAccount: true,
    });
  });

  it("lets an explicit Pix method clear a conflicting AI account", () => {
    const decision = detectFinancialRoute("Mercado 200 via Pix", context);
    expect(
      applyDeterministicPrecedence(decision, {
        intent: "plain",
        expense: {
          description: "Mercado",
          amountCents: 20_000,
          accountKeyword: "Inter",
        },
      }),
    ).toEqual({
      intent: "plain",
      expense: {
        description: "Mercado",
        amountCents: 20_000,
        cardKeyword: undefined,
        accountKeyword: undefined,
      },
    });
  });

  it("lets an explicit single-card purchase override conflicting AI fields", () => {
    const decision = detectFinancialRoute(
      "Cadeira 900 no cartão Nubank",
      context,
    );
    expect(decision).toMatchObject({
      route: "single_credit",
      description: "Cadeira",
      amountCents: 90_000,
      cardKeyword: "Nubank",
    });
    expect(
      applyDeterministicPrecedence(decision, {
        intent: "plain",
        expense: {
          description: "Mesa errada",
          amountCents: 1,
          cardKeyword: "Inter",
          accountKeyword: "Itaú",
        },
      }),
    ).toEqual({
      intent: "plain",
      expense: {
        description: "Cadeira",
        amountCents: 90_000,
        cardKeyword: "Nubank",
        accountKeyword: undefined,
      },
    });
  });

  it.each([
    ["without AI", null],
    [
      "with correct AI",
      {
        intent: "card_installment" as const,
        purchase: {
          description: "Amazon",
          totalCents: 120_000,
          installmentCount: 12,
          cardKeyword: "Nubank",
        },
      },
    ],
    [
      "with conflicting AI",
      {
        intent: "card_installment" as const,
        purchase: {
          description: "Nubank",
          totalCents: 1,
          installmentCount: 2,
          cardKeyword: "Amazon",
        },
      },
    ],
  ])(
    "preserves a merchant that is also a registered card name %s",
    (_label, classified) => {
      const collisionContext = {
        ...context,
        knownCards: [
          { id: "amazon-card", name: "Amazon" },
          { id: "nubank-card", name: "Nubank" },
        ],
        knownAccounts: [],
      };
      const decision = detectFinancialRoute(
        "Compra na Amazon 1200 em 12x no cartão Nubank",
        collisionContext,
      );
      expect(decision).toMatchObject({
        route: "installment",
        description: "Amazon",
        installmentCount: 12,
        totalCents: 120_000,
        cardKeyword: "Nubank",
      });
      expect(applyDeterministicPrecedence(decision, classified)).toMatchObject({
        intent: "card_installment",
        purchase: {
          description: "Amazon",
          installmentCount: 12,
          totalCents: 120_000,
          cardKeyword: "Nubank",
        },
      });
    },
  );

  it("preserves a natural merchant phrase that collides with a registered account", () => {
    const decision = detectFinancialRoute(
      "Comprei no Mercado Livre 1200 em 12x no cartão Nubank",
      {
        ...context,
        knownAccounts: [
          ...context.knownAccounts,
          { id: "mercado-livre-account", name: "Mercado Livre" },
        ],
      },
    );

    expect(decision).toMatchObject({
      route: "installment",
      description: "Mercado Livre",
      installmentCount: 12,
      totalCents: 120_000,
      cardKeyword: "Nubank",
    });
  });

  it.each([
    ["Notebook em doze vezes de 300 no Nubank", "Notebook", 12, 30_000],
    ["Mesa em duas parcelas de 300 no Nubank", "Mesa", 2, 30_000],
    ["TV em nove prestações de 200 no Nubank", "TV", 9, 20_000],
  ])(
    "extracts spoken count-first per-installment amounts from %s",
    (message, description, installmentCount, perInstallmentCents) => {
      expect(detectFinancialRoute(message, context)).toMatchObject({
        route: "installment",
        description,
        installmentCount,
        perInstallmentCents,
        totalCents: perInstallmentCents * installmentCount,
        amountKind: "per_installment",
      });
    },
  );

  it("lets a uniquely known-card purchase override conflicting AI fields without a card noun", () => {
    const cardOnlyContext = {
      ...context,
      knownAccounts: context.knownAccounts.filter(
        (account) => account.name !== "Nubank",
      ),
    };
    const decision = detectFinancialRoute(
      "Notebook 2000 no Nubank",
      cardOnlyContext,
    );
    expect(decision).toMatchObject({
      route: "single_credit",
      description: "Notebook",
      amountCents: 200_000,
      cardKeyword: "Nubank",
      unambiguousKnownCardEvidence: true,
    });
    expect(
      applyDeterministicPrecedence(decision, {
        intent: "plain",
        expense: {
          description: "Descrição errada",
          amountCents: 1,
          cardKeyword: "Inter",
          accountKeyword: "Itaú",
        },
      }),
    ).toEqual({
      intent: "plain",
      expense: {
        description: "Notebook",
        amountCents: 200_000,
        cardKeyword: "Nubank",
        accountKeyword: undefined,
      },
    });
  });

  it("keeps a bare provider purchase non-authoritative when account and card names collide", () => {
    const decision = detectFinancialRoute("Notebook 2000 no Nubank", context);
    const classified = {
      intent: "plain" as const,
      expense: {
        description: "Notebook",
        amountCents: 200_000,
        accountKeyword: "Nubank",
      },
    };
    expect(decision.unambiguousKnownCardEvidence).toBeUndefined();
    expect(applyDeterministicPrecedence(decision, classified)).toEqual(
      classified,
    );
  });

  it("lets an explicit Pix method suppress incidental registered account names", () => {
    const decision = detectFinancialRoute("Mercado Inter 100 no Pix", context);
    expect(decision).toMatchObject({
      route: "plain_account",
      amountCents: 10_000,
      accountKeyword: undefined,
      explicitDefaultSettlementAccount: true,
    });
  });

  it.each([
    "710,44 parcela solar 72x a partir de 05/10",
    "R$710,44 financiamento solar em 72x a partir de 05/10",
  ])(
    "uses an amount-first fixed-obligation value as the monthly amount: %s",
    (message) => {
      expect(detectFinancialRoute(message, context)).toMatchObject({
        route: "obligation",
        monthlyAmountCents: 71_044,
        installmentCount: 72,
      });
    },
  );

  it("does not restore a marked metadata year from conflicting AI output", () => {
    const decision = detectFinancialRoute(
      "Notebook modelo 2024 no cartão Nubank",
      context,
    );
    expect(decision).toMatchObject({
      route: "single_credit",
      amountCents: undefined,
      explicitMetadataYearEvidence: true,
    });
    expect(
      applyDeterministicPrecedence(decision, {
        intent: "plain",
        expense: {
          description: "Notebook modelo 2024",
          amountCents: 202_400,
          cardKeyword: "Nubank",
        },
      }),
    ).toMatchObject({
      intent: "plain",
      expense: {
        amountCents: undefined,
        cardKeyword: "Nubank",
      },
    });
  });

  it.each([
    ["1900 mercado no pix", "plain_account", "Mercado", 190_000],
    ["2000 notebook em 10x no Nubank", "installment", "Notebook", 200_000],
    ["2099 cadeira no cartão Nubank", "single_credit", "Cadeira", 209_900],
  ] as const)(
    "recognizes a leading year-like purchase amount with clear financial syntax: %s",
    (message, route, description, totalCents) => {
      const decision = detectFinancialRoute(message, context);
      expect(decision).toMatchObject({ route, description });
      expect(decision.totalCents ?? decision.amountCents).toBe(totalCents);
    },
  );

  it.each([
    ["Paguei a fatura do cartão Aurea+2", undefined],
    ["Paguei a fatura cartão Aurea+2", undefined],
    ["Pago fatura cartão Aurea+2", undefined],
    ["Quitei a fatura do cartão Aurea+2", undefined],
    ["Paguei a fatura do cartão Aurea+2 por R$ 450", 45_000],
  ])(
    "masks the exact compact numeric card name in fatura/card settlement grammar: %s",
    (message, expectedAmountCents) => {
      const decision = detectFinancialRoute(message, {
        ...context,
        knownCards: [{ id: "aurea", name: "Áurea+2" }],
      });
      expect(decision).toMatchObject({
        route: "mark_paid",
        paymentTarget: "card",
        cardKeyword: "Áurea+2",
        amountCents: expectedAmountCents,
      });
      if (expectedAmountCents === undefined) {
        expect(decision.suppressAiPaymentAmount).toBe(true);
      }
    },
  );

  it.each([
    "2026 IPTU no débito",
    "2025 IPVA no Pix",
    "2024 modelo notebook no cartão Nubank",
    "Notebook ano 2024 no cartão Nubank",
    "Notebook modelo 2024 no Nubank",
    "IPTU referência 2025 no débito",
    "IPTU competência 2026 no Pix",
  ])(
    "keeps a leading metadata year out of the monetary fields: %s",
    (message) => {
      const decision = detectFinancialRoute(message, context);
      expect(decision.amountCents).toBeUndefined();
      expect(decision.totalCents).toBeUndefined();
    },
  );

  it("does not leak an amount-first Pix method into the description", () => {
    expect(detectFinancialRoute("gastei 100 via pix", context)).toMatchObject({
      route: "plain_account",
      description: undefined,
      amountCents: 10_000,
      accountKeyword: undefined,
      explicitDefaultSettlementAccount: true,
    });
  });

  it.each(["500 aluguel todo mes dia 10", "R$500 aluguel todo mês dia 10"])(
    "supports amount-first recurring obligations: %s",
    (message) => {
      expect(detectFinancialRoute(message, context)).toMatchObject({
        route: "obligation",
        description: "Aluguel",
        monthlyAmountCents: 50_000,
        dueDay: 10,
      });
    },
  );

  it("prefers explicit per-installment text over an inconsistent AI amount", () => {
    const decision = detectFinancialRoute(
      "Notebook em 12x de 300 no credito nubank",
      context,
    );
    expect(
      applyDeterministicPrecedence(decision, {
        intent: "card_installment",
        purchase: {
          description: "Notebook",
          installmentCount: 12,
          totalCents: 99_900,
        },
      }),
    ).toMatchObject({
      intent: "card_installment",
      purchase: {
        installmentCount: 12,
        totalCents: undefined,
        perInstallmentCents: 30_000,
      },
    });
  });

  it.each([
    "TV em 8 parcelas, R$ 250 cada",
    "TV em 8 parcelas, R$ 250 por parcela",
    "TV em 8 parcelas, R$ 250 cada prestação",
  ])("extracts suffix per-installment syntax: %s", (message) => {
    expect(detectFinancialRoute(message, context)).toMatchObject({
      route: "installment",
      description: "TV",
      installmentCount: 8,
      amountKind: "per_installment",
      perInstallmentCents: 25_000,
      totalCents: 200_000,
    });
  });

  it("keeps a correct AI per-installment amount when text has no amount semantics", () => {
    const decision = detectFinancialRoute(
      "TV parcelada em 8 vezes no Nubank",
      context,
    );
    expect(
      applyDeterministicPrecedence(decision, {
        intent: "card_installment",
        purchase: {
          description: "TV",
          installmentCount: 8,
          perInstallmentCents: 25_000,
        },
      }),
    ).toMatchObject({
      intent: "card_installment",
      purchase: {
        installmentCount: 8,
        totalCents: undefined,
        perInstallmentCents: 25_000,
      },
    });
  });

  it("defers ambiguous bare amount-count syntax while preserving AI semantics", () => {
    const ambiguous = detectFinancialRoute(
      "Notebook 300 12x no Nubank",
      context,
    );
    expect(ambiguous).toMatchObject({
      route: "installment",
      description: "Notebook",
      amountKind: undefined,
      perInstallmentCents: undefined,
      totalCents: undefined,
    });
    expect(
      applyDeterministicPrecedence(ambiguous, {
        intent: "card_installment",
        purchase: {
          description: "Notebook",
          installmentCount: 12,
          perInstallmentCents: 30_000,
        },
      }),
    ).toMatchObject({
      intent: "card_installment",
      purchase: {
        totalCents: undefined,
        perInstallmentCents: 30_000,
      },
    });

    expect(
      detectFinancialRoute("Notebook 300 em 12x no Nubank", context),
    ).toMatchObject({
      route: "installment",
      amountKind: "total",
      totalCents: 30_000,
      perInstallmentCents: undefined,
    });
  });

  it.each([
    ["PS5 3500 10x C6", "PS5", 350_000],
    ["iPhone 4800 12x C6", "iPhone", 480_000],
  ])(
    "never multiplies an ambiguous bare amount-count pair: %s",
    (message, description, aiTotalCents) => {
      const decision = detectFinancialRoute(message, context);
      expect(decision).toMatchObject({
        route: "installment",
        description,
        totalCents: undefined,
        perInstallmentCents: undefined,
        amountKind: undefined,
      });
      expect(
        applyDeterministicPrecedence(decision, {
          intent: "card_installment",
          purchase: {
            description,
            totalCents: aiTotalCents,
            installmentCount: 10,
          },
        }),
      ).toMatchObject({
        intent: "card_installment",
        purchase: {
          totalCents: aiTotalCents,
          perInstallmentCents: undefined,
        },
      });
    },
  );

  it("lets explicit financing evidence outrank a known card name", () => {
    const decision = detectFinancialRoute(
      "Financiamento Nubank pago 900",
      context,
    );
    expect(decision).toMatchObject({
      route: "mark_paid",
      description: "Financiamento Nubank",
      amountCents: 90_000,
      cardKeyword: "Nubank",
      paymentTarget: "obligation",
    });
    expect(
      applyDeterministicPrecedence(decision, {
        intent: "mark_paid",
        target: "card",
        keyword: "Nubank",
      }),
    ).toMatchObject({
      intent: "mark_paid",
      target: "obligation",
      keyword: "Financiamento Nubank",
      amountCents: 90_000,
    });
  });

  it("merges trusted recurring amount, term, and due day into AI obligations", () => {
    const rent = detectFinancialRoute("Aluguel 1200 todo mês dia 10", context);
    expect(rent).toMatchObject({
      route: "obligation",
      monthlyAmountCents: 120_000,
      dueDay: 10,
    });
    expect(
      applyDeterministicPrecedence(rent, {
        intent: "obligation",
        obligation: {
          description: "Aluguel errado",
          monthlyAmountCents: 99,
          dueDay: 20,
        },
      }),
    ).toMatchObject({
      intent: "obligation",
      obligation: {
        description: "Aluguel",
        monthlyAmountCents: 120_000,
        dueDay: 10,
      },
    });

    const loan = detectFinancialRoute(
      "Empréstimo 24 parcelas de 500 debitadas na conta",
      context,
    );
    expect(
      applyDeterministicPrecedence(loan, {
        intent: "obligation",
        obligation: {
          description: "Empréstimo",
          monthlyAmountCents: 100,
          termMonths: 12,
        },
      }),
    ).toMatchObject({
      intent: "obligation",
      obligation: { monthlyAmountCents: 50_000, termMonths: 24 },
    });
  });

  it("cleans generic obligation payment descriptions before precedence", () => {
    const decision = detectFinancialRoute(
      "Paguei o financiamento da moto pago 900",
      context,
    );
    expect(decision).toMatchObject({
      route: "mark_paid",
      description: "Financiamento da moto",
      paymentTarget: "obligation",
    });
    expect(
      applyDeterministicPrecedence(decision, {
        intent: "mark_paid",
        target: "obligation",
        keyword: "Financiamento errado",
      }),
    ).toMatchObject({
      intent: "mark_paid",
      target: "obligation",
      keyword: "Financiamento da moto",
      amountCents: 90_000,
    });
  });

  it("exposes explicit obligation start dates without treating them as due days", () => {
    const decision = detectFinancialRoute(
      "Parcela solar 710,44 72x a partir de 05/10",
      context,
    );
    expect(decision).toMatchObject({
      route: "obligation",
      startDate: { day: 5, month: 10 },
      dueDay: undefined,
      monthlyAmountCents: 71_044,
      installmentCount: 72,
    });
    expect(applyDeterministicPrecedence(decision, null)).toMatchObject({
      intent: "obligation",
      obligation: {
        description: "Parcela solar",
        monthlyAmountCents: 71_044,
        termMonths: 72,
      },
    });
  });

  it("keeps the primary purchase amount ahead of trailing monetary clauses", () => {
    const decision = detectFinancialRoute(
      "Notebook 3600 em 12x no Nubank, frete 50",
      context,
    );
    expect(decision).toMatchObject({
      route: "installment",
      amountKind: "total",
      totalCents: 360_000,
      perInstallmentCents: undefined,
    });
    expect(
      applyDeterministicPrecedence(decision, {
        intent: "card_installment",
        purchase: {
          description: "Notebook",
          installmentCount: 12,
          totalCents: 5_000,
        },
      }),
    ).toMatchObject({
      intent: "card_installment",
      purchase: { totalCents: 360_000, perInstallmentCents: undefined },
    });
  });

  it("keeps the primary paid amount ahead of a trailing discount", () => {
    const decision = detectFinancialRoute(
      "Paguei a fatura Nubank 2350 com desconto de 50",
      context,
    );
    expect(decision).toMatchObject({
      route: "mark_paid",
      description: "Nubank",
      amountCents: 235_000,
    });
    expect(
      applyDeterministicPrecedence(decision, {
        intent: "mark_paid",
        target: "card",
        keyword: "Nubank",
        amountCents: 5_000,
      }),
    ).toEqual({
      intent: "mark_paid",
      target: "card",
      keyword: "Nubank",
      amountCents: 235_000,
    });
  });

  it("lets explicit Pix/account evidence override an erroneous AI route", () => {
    const decision = detectFinancialRoute("Mercado 230 no Pix", context);
    expect(decision).toMatchObject({
      route: "plain_account",
      description: "Mercado",
      amountCents: 23_000,
      explicitAccountEvidence: true,
      accountKeyword: undefined,
    });
    expect(
      applyDeterministicPrecedence(decision, {
        intent: "card_installment",
        purchase: {
          description: "Mercado",
          installmentCount: 12,
          totalCents: 23_000,
          cardKeyword: "Nubank",
        },
      }),
    ).toMatchObject({
      intent: "plain",
      expense: {
        description: "Mercado",
        amountCents: 23_000,
        cardKeyword: undefined,
        accountKeyword: undefined,
      },
    });
  });

  it("keeps AI resolution when plain-account evidence is only a bare number", () => {
    const decision = detectFinancialRoute("Almoço 75", context);
    expect(decision).toMatchObject({
      route: "plain_account",
      explicitAccountEvidence: undefined,
    });
    const classified = {
      intent: "obligation" as const,
      obligation: { description: "Almoço mensal", monthlyAmountCents: 7_500 },
    };
    expect(applyDeterministicPrecedence(decision, classified)).toBe(classified);
  });

  it("routes a paid solar installment to an obligation regardless of AI", () => {
    const decision = detectFinancialRoute("Parcela solar paga", context);
    expect(decision).toMatchObject({
      route: "mark_paid",
      description: "Parcela solar",
      paymentTarget: "obligation",
    });
    expect(
      applyDeterministicPrecedence(decision, {
        intent: "mark_paid",
        target: "card",
        keyword: "Nubank",
      }),
    ).toEqual({
      intent: "mark_paid",
      target: "obligation",
      keyword: "Parcela solar",
      amountCents: undefined,
    });
  });

  it("cleans a bare trailing Pix instrument from plain-account expenses", () => {
    expect(detectFinancialRoute("Posto Marcio 200 pix", context)).toMatchObject(
      {
        route: "plain_account",
        description: "Posto Marcio",
        amountCents: 20_000,
        explicitAccountEvidence: true,
        accountKeyword: undefined,
      },
    );
  });

  it("preserves an AI obligation when installment syntax has no card evidence", () => {
    const decision = detectFinancialRoute(
      "IPTU em 10 parcelas de R$ 200",
      context,
    );
    expect(decision).toMatchObject({
      route: "installment",
      description: "IPTU",
      installmentCount: 10,
      perInstallmentCents: 20_000,
      explicitCardEvidence: undefined,
    });
    expect(
      applyDeterministicPrecedence(decision, {
        intent: "obligation",
        obligation: {
          description: "IPTU",
          monthlyAmountCents: 99,
          termMonths: 5,
        },
      }),
    ).toMatchObject({
      intent: "obligation",
      obligation: {
        description: "IPTU",
        monthlyAmountCents: 20_000,
        termMonths: 10,
      },
    });
  });

  it("keeps explicit card installments deterministic against an AI obligation", () => {
    const decision = detectFinancialRoute(
      "Notebook em 12x de 300 no credito nubank",
      context,
    );
    expect(decision).toMatchObject({
      route: "installment",
      explicitCardEvidence: true,
    });
    const aiObligation = {
      intent: "obligation" as const,
      obligation: { description: "Notebook", monthlyAmountCents: 30_000 },
    };
    expect(applyDeterministicPrecedence(decision, aiObligation)).toMatchObject({
      intent: "card_installment",
      purchase: {
        description: "Notebook",
        installmentCount: 12,
        perInstallmentCents: 30_000,
      },
    });
    expect(applyDeterministicPrecedence(decision, null)).toMatchObject({
      intent: "card_installment",
      purchase: { description: "Notebook", installmentCount: 12 },
    });
  });

  it.each([
    "Paguei 50 no Nubank",
    "Paguei 50,00 no Nubank",
    "Paguei 1.250,90 no Nubank",
    "Paguei R$ 50 no Nubank",
  ])(
    "treats paid card amounts as purchases rather than bill settlement: %s",
    (message) => {
      const decision = detectFinancialRoute(message, context);
      expect(decision).toMatchObject({
        route: "single_credit",
        cardKeyword: "Nubank",
      });
      const classified = {
        intent: "plain" as const,
        expense: {
          description: "Compra no Nubank",
          amountCents: 5_000,
          cardKeyword: "Nubank",
        },
      };
      expect(applyDeterministicPrecedence(decision, classified)).toBe(
        classified,
      );
    },
  );

  it.each(["Paguei a fatura Nubank 2350", "Fatura Nubank paga"])(
    "preserves genuine card-bill settlement wording: %s",
    (message) => {
      const decision = detectFinancialRoute(message, context);
      expect(decision).toMatchObject({
        route: "mark_paid",
        description: "Nubank",
        paymentTarget: "card",
      });
      expect(
        applyDeterministicPrecedence(decision, {
          intent: "plain",
          expense: { description: "Compra errada", amountCents: 5_000 },
        }),
      ).toMatchObject({
        intent: "mark_paid",
        target: "card",
        keyword: "Nubank",
      });
    },
  );

  it.each(["Paguei a fatura Nubank dia 5", "Paguei a fatura Nubank dia5"])(
    "treats a bare card-bill day as metadata rather than an amount: %s",
    (message) => {
      const decision = detectFinancialRoute(message, context);
      expect(decision).toMatchObject({
        route: "mark_paid",
        description: "Nubank",
        cardKeyword: "Nubank",
        paymentTarget: "card",
        amountCents: undefined,
        suppressAiPaymentAmount: true,
      });
      expect(
        applyDeterministicPrecedence(decision, {
          intent: "mark_paid",
          target: "card",
          keyword: "errado",
          amountCents: 5,
        }),
      ).toMatchObject({
        intent: "mark_paid",
        target: "card",
        keyword: "Nubank",
        amountCents: undefined,
      });
    },
  );

  it("preserves a numeric card name when it is explicitly named", () => {
    const numericCardContext = {
      ...context,
      knownCards: [...context.knownCards, { id: "day-five", name: "Dia5" }],
    };
    expect(
      detectFinancialRoute(
        "Paguei a fatura do cartão chamado Dia5",
        numericCardContext,
      ),
    ).toMatchObject({
      route: "mark_paid",
      cardKeyword: "Dia5",
      paymentTarget: "card",
      amountCents: undefined,
    });
  });

  it.each([
    "Paguei o mercado 50 no Nubank",
    "Paguei ontem o mercado 50 no Nubank",
    "Paguei o mercado ontem, 50 no Nubank",
  ])(
    "keeps described or dated card payments in purchase routing: %s",
    (message) => {
      const decision = detectFinancialRoute(message, context);
      expect(decision).toMatchObject({
        route: "single_credit",
        cardKeyword: "Nubank",
      });
      const classified = {
        intent: "plain" as const,
        expense: {
          description: "Mercado",
          amountCents: 5_000,
          occurredOn: "2026-08-21",
          cardKeyword: "Nubank",
        },
      };
      expect(applyDeterministicPrecedence(decision, classified)).toBe(
        classified,
      );
    },
  );

  it("preserves the approved terse known-card settlement form", () => {
    const decision = detectFinancialRoute("Nubank pago", context);
    expect(decision).toMatchObject({
      route: "mark_paid",
      description: "Nubank",
      paymentTarget: "card",
    });
    expect(applyDeterministicPrecedence(decision, null)).toMatchObject({
      intent: "mark_paid",
      target: "card",
      keyword: "Nubank",
    });
  });

  it("extracts cada-parcela values from the financial predicate, not model numbers", () => {
    expect(
      detectFinancialRoute(
        "Cada parcela do iPhone 15 ficou 200, são 10 vezes no Nubank",
        context,
      ),
    ).toMatchObject({
      route: "installment",
      description: "iPhone 15",
      installmentCount: 10,
      amountKind: "per_installment",
      perInstallmentCents: 20_000,
      totalCents: 200_000,
    });
  });

  it.each([
    ["Empréstimo pago", "Empréstimo"],
    ["Consórcio quitado", "Consórcio"],
  ])(
    "routes an explicitly paid obligation noun to mark-paid: %s",
    (message, description) => {
      const decision = detectFinancialRoute(message, context);
      expect(decision).toMatchObject({
        route: "mark_paid",
        description,
        paymentTarget: "obligation",
      });
      expect(
        applyDeterministicPrecedence(decision, {
          intent: "obligation",
          obligation: { description },
        }),
      ).toMatchObject({
        intent: "mark_paid",
        target: "obligation",
        keyword: description,
      });
    },
  );

  it.each(["Empréstimo 500 por 12 meses", "Consórcio 850 por 60 meses"])(
    "keeps unpaid obligation nouns in creation routing: %s",
    (message) => {
      expect(detectFinancialRoute(message, context).route).toBe("obligation");
    },
  );

  it("keeps an explicit installment position out of paid amounts and AI precedence", () => {
    const decision = detectFinancialRoute(
      "Paguei a parcela da televisão número 3",
      context,
    );
    expect(decision).toMatchObject({
      route: "mark_paid",
      description: "Televisão",
      amountCents: undefined,
      suppressAiPaymentAmount: true,
    });
    expect(
      applyDeterministicPrecedence(decision, {
        intent: "mark_paid",
        target: "obligation",
        keyword: "Televisão",
        amountCents: 300,
      }),
    ).toEqual({
      intent: "mark_paid",
      target: "obligation",
      keyword: "Televisão",
      amountCents: undefined,
    });
  });

  it.each([
    "Paguei a parcela da televisão R$ 300",
    "Paguei a parcela da televisão número 3 por 300",
    "Paguei a 3ª parcela da televisão no valor de 300",
  ])(
    "preserves clear paid amounts alongside installment positions: %s",
    (message) => {
      expect(detectFinancialRoute(message, context)).toMatchObject({
        route: "mark_paid",
        description: "Televisão",
        amountCents: 30_000,
        suppressAiPaymentAmount: undefined,
      });
    },
  );

  it("treats count-before-amount shorthand as explicitly per-installment", () => {
    const decision = detectFinancialRoute("TV 3x 100 no Nubank", context);
    expect(decision).toMatchObject({
      route: "installment",
      description: "TV",
      installmentCount: 3,
      amountKind: "per_installment",
      perInstallmentCents: 10_000,
      totalCents: 30_000,
    });
    expect(
      applyDeterministicPrecedence(decision, {
        intent: "card_installment",
        purchase: {
          description: "TV",
          installmentCount: 3,
          totalCents: 10_000,
        },
      }),
    ).toMatchObject({
      intent: "card_installment",
      purchase: {
        totalCents: undefined,
        perInstallmentCents: 10_000,
        installmentCount: 3,
      },
    });
  });

  it("keeps reverse amount-before-count shorthand unresolved", () => {
    expect(detectFinancialRoute("PS5 3500 10x C6", context)).toMatchObject({
      route: "installment",
      description: "PS5",
      totalCents: undefined,
      perInstallmentCents: undefined,
      amountKind: undefined,
    });
  });

  it("suppresses ordinal amounts in the special unresolved car payment", () => {
    const ordinal = detectFinancialRoute(
      "Paguei a parcela do carro 3",
      context,
    );
    expect(ordinal).toMatchObject({
      route: "ambiguous",
      description: "Carro",
      amountCents: undefined,
      suppressAiPaymentAmount: true,
      reason: "ambiguous_payment_number_semantics",
    });
    expect(
      applyDeterministicPrecedence(ordinal, {
        intent: "mark_paid",
        target: "obligation",
        keyword: "Carro",
        amountCents: 300,
      }),
    ).toBeNull();

    const explicit = detectFinancialRoute(
      "Paguei a parcela do carro R$ 300",
      context,
    );
    expect(explicit).toMatchObject({
      route: "ambiguous",
      amountCents: 30_000,
      suppressAiPaymentAmount: undefined,
    });
    expect(
      applyDeterministicPrecedence(explicit, {
        intent: "mark_paid",
        target: "obligation",
        keyword: "Carro",
        amountCents: 1,
      }),
    ).toMatchObject({ intent: "mark_paid", amountCents: 30_000 });
  });

  it("rejects conflicting leading-total and explicit-per-installment clauses", () => {
    expect(
      detectFinancialRoute("Notebook 3000 em 12x de 300 no Nubank", context),
    ).toMatchObject({
      route: "ambiguous",
      description: "Notebook",
      totalCents: 300_000,
      perInstallmentCents: 30_000,
      reason: "conflicting_or_invalid_installment_evidence",
    });
  });

  it("accepts matching leading-total and explicit-per-installment clauses", () => {
    expect(
      detectFinancialRoute("Notebook 3600 em 12x de 300 no Nubank", context),
    ).toMatchObject({
      route: "installment",
      description: "Notebook",
      installmentCount: 12,
      totalCents: 360_000,
      perInstallmentCents: 30_000,
    });
  });

  it.each([
    ["Paguei a parcela solar número 3", "Parcela solar"],
    ["Paguei o financiamento da moto número 3", "Financiamento da moto"],
    ["Paguei o empréstimo número 3", "Empréstimo"],
    ["Paguei o consórcio número 3", "Consórcio"],
  ])(
    "uses scheduled amounts for explicit named-obligation positions: %s",
    (message, description) => {
      const decision = detectFinancialRoute(message, context);
      expect(decision).toMatchObject({
        route: "mark_paid",
        description,
        paymentTarget: "obligation",
        amountCents: undefined,
        suppressAiPaymentAmount: true,
      });
      expect(
        applyDeterministicPrecedence(decision, {
          intent: "mark_paid",
          target: "obligation",
          keyword: description,
          amountCents: 300,
        }),
      ).toMatchObject({
        intent: "mark_paid",
        target: "obligation",
        keyword: description,
        amountCents: undefined,
      });
    },
  );

  it.each([
    "Paguei a parcela solar R$ 300",
    "Paguei a parcela solar número 3 por 300",
    "Paguei a parcela solar 3 por 300",
  ])(
    "preserves explicit amounts on named obligation payments: %s",
    (message) => {
      expect(detectFinancialRoute(message, context)).toMatchObject({
        route: "mark_paid",
        description: "Parcela solar",
        amountCents: 30_000,
        suppressAiPaymentAmount: undefined,
      });
    },
  );

  it("recognizes a direct verb-first known-card settlement", () => {
    const decision = detectFinancialRoute("Paguei Nubank R$ 500", context);
    expect(decision).toMatchObject({
      route: "mark_paid",
      description: "Nubank",
      paymentTarget: "card",
      amountCents: 50_000,
    });
    expect(
      applyDeterministicPrecedence(decision, {
        intent: "plain",
        expense: { description: "Compra errada", amountCents: 50_000 },
      }),
    ).toEqual({
      intent: "mark_paid",
      target: "card",
      keyword: "Nubank",
      amountCents: 50_000,
    });
  });

  it.each(["Paguei o mercado 50 no Nubank", "Paguei gasolina 50 no Nubank"])(
    "rejects descriptions from verb-first card settlement grammar: %s",
    (message) => {
      expect(detectFinancialRoute(message, context)).toMatchObject({
        route: "single_credit",
        cardKeyword: "Nubank",
      });
    },
  );

  it.each([3, 10])(
    "requires clarification for a bare trailing installment/payment number: %s",
    (number) => {
      const decision = detectFinancialRoute(
        `Paguei a parcela da internet ${number}`,
        context,
      );
      expect(decision).toMatchObject({
        route: "ambiguous",
        description: "Internet",
        amountCents: undefined,
        suppressAiPaymentAmount: true,
        reason: "ambiguous_payment_number_semantics",
      });
      expect(
        applyDeterministicPrecedence(decision, {
          intent: "mark_paid",
          target: "obligation",
          keyword: "Internet",
          amountCents: number * 100,
        }),
      ).toBeNull();
    },
  );

  it.each([13, 24, 50, 1500])(
    "requires clarification for a bare trailing payment position of any size: %s",
    (number) => {
      const decision = detectFinancialRoute(
        `Paguei a parcela da internet ${number}`,
        context,
      );
      expect(decision).toMatchObject({
        route: "ambiguous",
        description: "Internet",
        amountCents: undefined,
        ambiguousPaymentNumber: number,
        suppressAiPaymentAmount: true,
        reason: "ambiguous_payment_number_semantics",
      });
      expect(
        applyDeterministicPrecedence(decision, {
          intent: "mark_paid",
          target: "obligation",
          keyword: "Internet errada",
          amountCents: 1,
        }),
      ).toBeNull();
      expect(applyDeterministicPrecedence(decision, null)).toBeNull();
    },
  );

  it("requires explicit ordinal notation above the inferred 1-12 range", () => {
    expect(
      detectFinancialRoute("Paguei a parcela da internet número 15", context),
    ).toMatchObject({
      route: "mark_paid",
      description: "Internet",
      amountCents: undefined,
      suppressAiPaymentAmount: true,
    });
  });

  it("keeps an explicit financing total out of monthly amount semantics", () => {
    const decision = detectFinancialRoute(
      "Financiamento do carro total 48000 por 48 meses",
      context,
    );
    expect(decision).toMatchObject({
      route: "obligation",
      amountKind: "total",
      totalCents: 4_800_000,
      monthlyAmountCents: undefined,
      installmentCount: 48,
    });

    expect(
      applyDeterministicPrecedence(decision, {
        intent: "obligation",
        obligation: {
          description: "Financiamento do carro",
          monthlyAmountCents: 100_000,
          termMonths: 48,
        },
      }),
    ).toMatchObject({
      intent: "obligation",
      obligation: { monthlyAmountCents: 100_000, termMonths: 48 },
    });

    expect(
      applyDeterministicPrecedence(decision, {
        intent: "card_installment",
        purchase: {
          description: "Carro",
          totalCents: 4_800_000,
          installmentCount: 48,
        },
      }),
    ).toMatchObject({
      intent: "obligation",
      obligation: { monthlyAmountCents: undefined, termMonths: 48 },
    });

    expect(applyDeterministicPrecedence(decision, null)).toMatchObject({
      intent: "obligation",
      obligation: { monthlyAmountCents: undefined, termMonths: 48 },
    });
  });

  it.each([
    ["Paguei R$ 1500 da parcela da casa", "Casa", "obligation"],
    ["Paguei 1.500,50 da parcela da casa", "Casa", "obligation"],
    ["Paguei 1500 da fatura Nubank", "Nubank", "card"],
  ])(
    "extracts an amount before an explicit payment target: %s",
    (message, description, target) => {
      const decision = detectFinancialRoute(message, context);
      expect(decision).toMatchObject({
        route: "mark_paid",
        description,
        paymentTarget: target,
        amountCents: message.includes("1.500,50") ? 150_050 : 150_000,
        suppressAiPaymentAmount: undefined,
      });
      expect(applyDeterministicPrecedence(decision, null)).toMatchObject({
        intent: "mark_paid",
        target,
        keyword: description,
        amountCents: message.includes("1.500,50") ? 150_050 : 150_000,
      });
    },
  );

  it.each([
    "Paguei R$ 3 da parcela da casa",
    "Paguei 3 reais da parcela da casa",
    "Paguei 3,00 da parcela da casa",
  ])("preserves explicitly formatted small payment amounts: %s", (message) => {
    expect(detectFinancialRoute(message, context)).toMatchObject({
      route: "mark_paid",
      description: "Casa",
      amountCents: 300,
      suppressAiPaymentAmount: undefined,
    });
  });

  it.each([3, 10])(
    "requires clarification for a bare leading installment/payment number: %s",
    (number) => {
      const decision = detectFinancialRoute(
        `Paguei ${number} da parcela da casa`,
        context,
      );
      expect(decision).toMatchObject({
        route: "ambiguous",
        description: "Casa",
        amountCents: undefined,
        suppressAiPaymentAmount: true,
        reason: "ambiguous_payment_number_semantics",
      });
      expect(
        applyDeterministicPrecedence(decision, {
          intent: "mark_paid",
          target: "obligation",
          keyword: "Casa",
          amountCents: number * 100,
        }),
      ).toBeNull();
    },
  );

  it.each([13, 24, 50, 1500])(
    "requires clarification for a bare leading payment position of any size: %s",
    (number) => {
      const decision = detectFinancialRoute(
        `Paguei ${number} da parcela da casa`,
        context,
      );
      expect(decision).toMatchObject({
        route: "ambiguous",
        description: "Casa",
        amountCents: undefined,
        ambiguousPaymentNumber: number,
        suppressAiPaymentAmount: true,
        reason: "ambiguous_payment_number_semantics",
      });
      expect(
        applyDeterministicPrecedence(decision, {
          intent: "mark_paid",
          target: "obligation",
          keyword: "Casa errada",
          amountCents: 1,
        }),
      ).toBeNull();
      expect(applyDeterministicPrecedence(decision, null)).toBeNull();
    },
  );

  it.each([
    "Paguei a parcela da internet R$ 50",
    "Paguei a parcela da internet 50 reais",
    "Paguei a parcela da internet 50,00",
    "Paguei a parcela da internet por 50",
    "Paguei a parcela da internet no valor de 50",
  ])("preserves explicit trailing payment syntax: %s", (message) => {
    expect(detectFinancialRoute(message, context)).toMatchObject({
      route: "mark_paid",
      description: "Internet",
      amountCents: 5_000,
      suppressAiPaymentAmount: undefined,
    });
  });

  it("recognizes explicit payment of a named card as bill settlement", () => {
    const decision = detectFinancialRoute(
      "Paguei o cartão Nubank 2350",
      context,
    );
    expect(decision).toMatchObject({
      route: "mark_paid",
      description: "Nubank",
      paymentTarget: "card",
      amountCents: 235_000,
    });
    expect(
      applyDeterministicPrecedence(decision, {
        intent: "plain",
        expense: {
          description: "Compra errada",
          amountCents: 235_000,
          cardKeyword: "Nubank",
        },
      }),
    ).toEqual({
      intent: "mark_paid",
      target: "card",
      keyword: "Nubank",
      amountCents: 235_000,
    });
  });

  it("keeps described card purchases out of explicit card settlement grammar", () => {
    expect(
      detectFinancialRoute("Paguei mercado 50 no cartão Nubank", context),
    ).toMatchObject({
      route: "single_credit",
      cardKeyword: "Nubank",
    });
  });

  it("does not treat a card bill month as its paid amount", () => {
    const decision = detectFinancialRoute(
      "Paguei a fatura Nubank de 08/2026",
      context,
    );
    expect(decision).toMatchObject({
      route: "mark_paid",
      description: "Nubank",
      paymentTarget: "card",
      amountCents: undefined,
      suppressAiPaymentAmount: true,
      billMonth: "2026-08",
    });
    expect(
      applyDeterministicPrecedence(decision, {
        intent: "mark_paid",
        target: "card",
        keyword: "Nubank",
        amountCents: 202_600,
      }),
    ).toEqual({
      intent: "mark_paid",
      target: "card",
      keyword: "Nubank",
      amountCents: undefined,
      billMonth: "2026-08",
    });
  });

  it.each([
    ["fatura paga dia 05/07/2026", undefined],
    ["fatura 07/2026 paga", "2026-07"],
  ] as const)(
    "keeps a generic paid fatura on the card-settlement route: %s",
    (message, billMonth) => {
      const decision = detectFinancialRoute(message, context);
      expect(decision).toMatchObject({
        route: "mark_paid",
        description: "Fatura",
        paymentTarget: "card",
        amountCents: undefined,
        suppressAiPaymentAmount: true,
        billMonth,
      });
      expect(
        applyDeterministicPrecedence(decision, {
          intent: "obligation",
          obligation: {
            description: "Fatura errada",
            monthlyAmountCents: 1,
          },
        }),
      ).toMatchObject({
        intent: "mark_paid",
        target: "card",
        keyword: "Fatura",
        amountCents: undefined,
        ...(billMonth === undefined ? {} : { billMonth }),
      });
    },
  );

  it("preserves an actual paid amount after a card bill month", () => {
    expect(
      detectFinancialRoute(
        "Paguei a fatura Nubank de 08/2026 por 2350",
        context,
      ),
    ).toMatchObject({
      route: "mark_paid",
      description: "Nubank",
      paymentTarget: "card",
      amountCents: 235_000,
      suppressAiPaymentAmount: undefined,
      billMonth: "2026-08",
    });
  });

  it("normalizes and overrides AI with an explicit valid card bill month", () => {
    const decision = detectFinancialRoute(
      "Paguei a fatura Nubank de 07/2026",
      context,
    );
    expect(decision).toMatchObject({
      route: "mark_paid",
      paymentTarget: "card",
      billMonth: "2026-07",
      amountCents: undefined,
    });
    expect(
      applyDeterministicPrecedence(decision, {
        intent: "mark_paid",
        target: "card",
        keyword: "Nubank",
        amountCents: 202_600,
        billMonth: "2026-08",
      }),
    ).toEqual({
      intent: "mark_paid",
      target: "card",
      keyword: "Nubank",
      amountCents: undefined,
      billMonth: "2026-07",
    });
  });

  it.each(["13/2026", "00/26"])(
    "requires clarification for an explicit invalid card bill month: %s",
    (invalidBillMonth) => {
      const decision = detectFinancialRoute(
        `Paguei a fatura Nubank de ${invalidBillMonth}`,
        context,
      );
      expect(decision).toMatchObject({
        route: "ambiguous",
        description: "Nubank",
        paymentTarget: "card",
        invalidBillMonth,
        amountCents: undefined,
        suppressAiPaymentAmount: true,
        reason: "invalid_bill_month",
      });
      expect(
        applyDeterministicPrecedence(decision, {
          intent: "mark_paid",
          target: "card",
          keyword: "Nubank",
          amountCents: 100_000,
          billMonth: "2026-08",
        }),
      ).toBeNull();
    },
  );

  it("normalizes a standalone short-year bill month", () => {
    const decision = detectFinancialRoute(
      "Paguei a fatura Nubank de 07/26",
      context,
    );
    expect(decision).toMatchObject({
      route: "mark_paid",
      paymentTarget: "card",
      billMonth: "2026-07",
      amountCents: undefined,
      suppressAiPaymentAmount: true,
    });
    expect(
      applyDeterministicPrecedence(decision, {
        intent: "mark_paid",
        target: "card",
        keyword: "Nubank",
        billMonth: "2026-08",
      }),
    ).toMatchObject({
      intent: "mark_paid",
      target: "card",
      keyword: "Nubank",
      billMonth: "2026-07",
    });
  });

  it("does not derive a bill month from the suffix of a full payment date", () => {
    expect(
      detectFinancialRoute("Paguei a fatura Nubank dia 15/07/2026", context),
    ).toMatchObject({
      route: "mark_paid",
      paymentTarget: "card",
      billMonth: undefined,
      amountCents: undefined,
      suppressAiPaymentAmount: true,
    });
  });

  it("does not derive a short-year bill month from a full payment date", () => {
    expect(
      detectFinancialRoute("Paguei a fatura Nubank dia 15/07/26", context),
    ).toMatchObject({
      route: "mark_paid",
      paymentTarget: "card",
      billMonth: undefined,
      amountCents: undefined,
      suppressAiPaymentAmount: true,
    });
  });

  it.each([
    "Nubank pago dia 10/08",
    "Paguei a fatura Nubank em 15/07",
    "Paguei a fatura Nubank no dia 12/09",
  ])(
    "does not treat a contextual short occurrence date as a bill month: %s",
    (message) => {
      expect(detectFinancialRoute(message, context)).toMatchObject({
        route: "mark_paid",
        paymentTarget: "card",
        billMonth: undefined,
        amountCents: undefined,
        suppressAiPaymentAmount: true,
      });
    },
  );

  it.each(["Paguei a fatura Nubank de 07/26", "Paguei a fatura Nubank 07/26"])(
    "retains a standalone short-year bill month: %s",
    (message) => {
      expect(detectFinancialRoute(message, context)).toMatchObject({
        route: "mark_paid",
        paymentTarget: "card",
        billMonth: "2026-07",
        amountCents: undefined,
        suppressAiPaymentAmount: true,
      });
    },
  );

  it("finds a separate short-year bill month after an occurrence date", () => {
    expect(
      detectFinancialRoute(
        "Paguei a fatura Nubank dia 15/07 de 06/26",
        context,
      ),
    ).toMatchObject({
      route: "mark_paid",
      paymentTarget: "card",
      billMonth: "2026-06",
      amountCents: undefined,
      suppressAiPaymentAmount: true,
    });
  });

  it("finds an explicit bill month separately from a full payment date", () => {
    expect(
      detectFinancialRoute(
        "Paguei a fatura Nubank dia 15/07/2026 de 06/2026",
        context,
      ),
    ).toMatchObject({
      route: "mark_paid",
      paymentTarget: "card",
      billMonth: "2026-06",
      amountCents: undefined,
      suppressAiPaymentAmount: true,
    });
  });

  it("cleans instrument-first purchase phrasing before installment precedence", () => {
    const decision = detectFinancialRoute(
      "Comprei no Nubank uma geladeira por 3000 em 10x",
      context,
    );
    expect(decision).toMatchObject({
      route: "installment",
      description: "Geladeira",
      installmentCount: 10,
      totalCents: 300_000,
      cardKeyword: "Nubank",
    });
    expect(
      applyDeterministicPrecedence(decision, {
        intent: "card_installment",
        purchase: {
          description: "Geladeira",
          installmentCount: 10,
          totalCents: 300_000,
          cardKeyword: "Nubank",
        },
      }),
    ).toMatchObject({
      intent: "card_installment",
      purchase: {
        description: "Geladeira",
        installmentCount: 10,
        totalCents: 300_000,
        cardKeyword: "Nubank",
      },
    });
  });

  it("treats crédito consignado as an obligation rather than a card purchase", () => {
    const decision = detectFinancialRoute(
      "Crédito consignado 24 parcelas de 500",
      context,
    );
    expect(decision).toMatchObject({
      route: "obligation",
      description: "Crédito consignado",
      installmentCount: 24,
      monthlyAmountCents: 50_000,
      perInstallmentCents: 50_000,
      explicitCardEvidence: undefined,
    });
    expect(
      applyDeterministicPrecedence(decision, {
        intent: "obligation",
        obligation: {
          description: "Crédito consignado",
          monthlyAmountCents: 1,
          termMonths: 1,
        },
      }),
    ).toMatchObject({
      intent: "obligation",
      obligation: {
        description: "Crédito consignado",
        monthlyAmountCents: 50_000,
        termMonths: 24,
      },
    });
    expect(applyDeterministicPrecedence(decision, null)).toMatchObject({
      intent: "obligation",
      obligation: { monthlyAmountCents: 50_000, termMonths: 24 },
    });
  });

  it.each([
    "Crédito pessoal 12 parcelas de 300",
    "Crédito imobiliário 120 parcelas de 900",
    "Crédito veicular 48 parcelas de 700",
  ])("recognizes safe common loan-credit variants: %s", (message) => {
    expect(detectFinancialRoute(message, context)).toMatchObject({
      route: "obligation",
      explicitCardEvidence: undefined,
    });
  });

  it("keeps ordinary no-crédito wording in explicit card routing", () => {
    expect(
      detectFinancialRoute("Notebook 3000 em 12x no crédito Nubank", context),
    ).toMatchObject({
      route: "installment",
      explicitCardEvidence: true,
      cardKeyword: "Nubank",
    });
  });

  it.each([
    "Notebook R$ 300 12x no Nubank",
    "Notebook 300 reais 12x no Nubank",
    "Notebook 300,00 12x no Nubank",
  ])(
    "treats explicitly monetary reverse shorthand as per-installment: %s",
    (message) => {
      const decision = detectFinancialRoute(message, context);
      expect(decision).toMatchObject({
        route: "installment",
        description: "Notebook",
        installmentCount: 12,
        amountKind: "per_installment",
        perInstallmentCents: 30_000,
        totalCents: 360_000,
      });
      expect(
        applyDeterministicPrecedence(decision, {
          intent: "card_installment",
          purchase: {
            description: "Notebook",
            installmentCount: 12,
            totalCents: 30_000,
          },
        }),
      ).toMatchObject({
        intent: "card_installment",
        purchase: {
          installmentCount: 12,
          totalCents: undefined,
          perInstallmentCents: 30_000,
        },
      });
    },
  );

  it("keeps bare reverse shorthand unresolved after explicit-money support", () => {
    expect(detectFinancialRoute("PS5 3500 10x C6", context)).toMatchObject({
      route: "installment",
      description: "PS5",
      installmentCount: 10,
      amountKind: undefined,
      perInstallmentCents: undefined,
      totalCents: undefined,
    });
  });

  it("ignores a standalone tax year when inferring a plain account amount", () => {
    const decision = detectFinancialRoute("IPTU 2026 no débito 1200", context);
    expect(decision).toMatchObject({
      route: "plain_account",
      description: "IPTU",
      amountCents: 120_000,
    });
    expect(
      applyDeterministicPrecedence(decision, {
        intent: "plain",
        expense: {
          description: "IPTU 2026",
          amountCents: 202_600,
        },
      }),
    ).toMatchObject({
      intent: "plain",
      expense: {
        description: "IPTU",
        amountCents: 120_000,
      },
    });
  });

  it.each([
    ["IPTU R$ 2026 no débito", 202_600],
    ["IPTU no valor de 2026 no débito", 202_600],
    ["IPTU 2026 reais no débito", 202_600],
  ])(
    "keeps an explicitly monetary year-like value: %s",
    (message, amountCents) => {
      expect(detectFinancialRoute(message, context)).toMatchObject({
        route: "plain_account",
        description: "IPTU",
        amountCents,
      });
    },
  );

  it.each([
    "Paguei almoço 75 no débito",
    "Comprei o almoço 75 no débito",
    "Gastei com o almoço 75 no débito",
    "Passei um almoço 75 no débito",
  ])(
    "strips a leading transaction verb from plain descriptions: %s",
    (message) => {
      const decision = detectFinancialRoute(message, context);
      expect(decision).toMatchObject({
        route: "plain_account",
        description: "Almoço",
        amountCents: 7_500,
      });
      expect(
        applyDeterministicPrecedence(decision, {
          intent: "plain",
          expense: {
            description: "Descrição incorreta",
            amountCents: 1,
          },
        }),
      ).toMatchObject({
        intent: "plain",
        expense: { description: "Almoço", amountCents: 7_500 },
      });
    },
  );

  it("preserves product model numbers while stripping a transaction verb", () => {
    expect(
      detectFinancialRoute(
        "Comprei um iPhone 15 Pro R$ 5000 no débito",
        context,
      ),
    ).toMatchObject({
      route: "plain_account",
      description: "iPhone 15 Pro",
      amountCents: 500_000,
    });
  });

  it.each([
    "Notebook 12 parcelas R$ 300 no Nubank",
    "Notebook 12 parcelas 300 reais no Nubank",
    "Notebook 12 parcelas 300,00 no Nubank",
    "Notebook 12 parcelas 300 no Nubank",
  ])(
    "treats explicit money after an installment count as per-installment: %s",
    (message) => {
      const decision = detectFinancialRoute(message, context);
      expect(decision).toMatchObject({
        route: "installment",
        description: "Notebook",
        installmentCount: 12,
        amountKind: "per_installment",
        perInstallmentCents: 30_000,
        totalCents: 360_000,
      });
      expect(
        applyDeterministicPrecedence(decision, {
          intent: "card_installment",
          purchase: {
            description: "Notebook",
            installmentCount: 12,
            totalCents: 30_000,
          },
        }),
      ).toMatchObject({
        intent: "card_installment",
        purchase: {
          installmentCount: 12,
          totalCents: undefined,
          perInstallmentCents: 30_000,
        },
      });
    },
  );

  it("does not reinterpret a bare unrelated number after an installment count", () => {
    expect(
      detectFinancialRoute(
        "Notebook 12 parcelas modelo 300 no Nubank",
        context,
      ),
    ).toMatchObject({
      route: "installment",
      perInstallmentCents: undefined,
    });
  });

  it("keeps bare count-first amounts compatible with obligation routing", () => {
    expect(
      detectFinancialRoute("Empréstimo 12 parcelas 300", context),
    ).toMatchObject({
      route: "obligation",
      description: "Empréstimo",
      installmentCount: 12,
      monthlyAmountCents: 30_000,
      perInstallmentCents: 30_000,
    });
  });

  it.each([
    "Comprei notebook dia 10/08 por 3600 em 12x no Nubank",
    "Comprei o notebook ontem por 3600 em 12x no Nubank",
    "Comprei um notebook em 10/08/2026 por 3600 em 12x no Nubank",
  ])("strips purchase dates from the canonical description: %s", (message) => {
    const decision = detectFinancialRoute(message, context);
    expect(decision).toMatchObject({
      route: "installment",
      description: "Notebook",
      installmentCount: 12,
      totalCents: 360_000,
    });
    expect(
      applyDeterministicPrecedence(decision, {
        intent: "card_installment",
        purchase: {
          description: "Notebook dia 10/08",
          installmentCount: 12,
          totalCents: 360_000,
        },
      }),
    ).toMatchObject({
      intent: "card_installment",
      purchase: {
        description: "Notebook",
        installmentCount: 12,
        totalCents: 360_000,
      },
    });
  });

  it.each([
    ["Paguei o Nubank", undefined],
    ["Nubank pago ontem", undefined],
    ["Nubank pago dia 10/08", undefined],
    ["Paguei o cartão Nubank via Pix 2000", 200_000],
    ["Paguei a Nubank no Pix R$ 1.500", 150_000],
    ["Paguei Nubank pela conta Inter 2000", 200_000],
  ])(
    "accepts a narrow known-card settlement with benign tails: %s",
    (message, amountCents) => {
      const decision = detectFinancialRoute(message, context);
      expect(decision).toMatchObject({
        route: "mark_paid",
        description: "Nubank",
        paymentTarget: "card",
        amountCents,
      });
      expect(
        applyDeterministicPrecedence(decision, {
          intent: "plain",
          expense: {
            description: "Compra incorreta",
            amountCents: 1,
            accountKeyword: "Pix",
          },
        }),
      ).toMatchObject({
        intent: "mark_paid",
        target: "card",
        keyword: "Nubank",
        amountCents,
      });
    },
  );

  it.each([
    "Paguei o mercado 50 no Nubank",
    "Paguei gasolina 50 no Nubank",
    "Paguei ontem o mercado 50 no Nubank",
  ])(
    "keeps merchant wording outside card-settlement grammar: %s",
    (message) => {
      expect(detectFinancialRoute(message, context)).toMatchObject({
        route: "single_credit",
        cardKeyword: "Nubank",
      });
    },
  );

  it("keeps a descriptive Pix purchase out of card-settlement grammar", () => {
    expect(
      detectFinancialRoute("Paguei mercado via Pix 50 no Nubank", context),
    ).toMatchObject({
      route: "plain_account",
    });
  });

  it.each([
    "iPhone 15 no Pix por 5000",
    "iPhone 15 no Pix no valor de R$ 5.000",
    "iPhone 15 custou 5000 no Pix",
    "iPhone 15 no Pix ficou em 5000",
  ])(
    "prefers an explicit later value while preserving the product model: %s",
    (message) => {
      const decision = detectFinancialRoute(message, context);
      expect(decision).toMatchObject({
        route: "plain_account",
        description: "iPhone 15",
        amountCents: 500_000,
        accountKeyword: undefined,
      });
      expect(
        applyDeterministicPrecedence(decision, {
          intent: "plain",
          expense: {
            description: "iPhone",
            amountCents: 1_500,
            accountKeyword: "Pix",
          },
        }),
      ).toMatchObject({
        intent: "plain",
        expense: {
          description: "iPhone 15",
          amountCents: 500_000,
          accountKeyword: undefined,
        },
      });
    },
  );

  it("preserves the existing terse Pix expense contract", () => {
    expect(detectFinancialRoute("Posto Marcio 200 pix", context)).toMatchObject(
      {
        route: "plain_account",
        description: "Posto Marcio",
        amountCents: 20_000,
        accountKeyword: undefined,
      },
    );
  });

  it("preserves a classifier's specific obligation keyword for a generic car payment", () => {
    const decision = detectFinancialRoute(
      "Paguei a parcela do carro por R$ 900",
      context,
    );
    expect(decision).toMatchObject({
      route: "ambiguous",
      description: "Carro",
      amountCents: 90_000,
      reason: "unresolved_existing_payment",
    });
    expect(
      applyDeterministicPrecedence(decision, {
        intent: "mark_paid",
        target: "obligation",
        keyword: "Financiamento do carro",
        amountCents: 1,
      }),
    ).toEqual({
      intent: "mark_paid",
      target: "obligation",
      keyword: "Financiamento do carro",
      amountCents: 90_000,
    });
  });

  it("treats em MM/YYYY as an explicit bill month", () => {
    expect(
      detectFinancialRoute("Paguei a fatura Nubank em 07/2026", context),
    ).toMatchObject({
      route: "mark_paid",
      paymentTarget: "card",
      billMonth: "2026-07",
      amountCents: undefined,
      suppressAiPaymentAmount: true,
    });
    expect(
      detectFinancialRoute("Paguei a fatura Nubank em 15/07", context),
    ).toMatchObject({
      route: "mark_paid",
      paymentTarget: "card",
      billMonth: undefined,
      amountCents: undefined,
      suppressAiPaymentAmount: true,
    });
  });

  it("carries the source account through known-card settlement precedence", () => {
    const accountContext = {
      ...context,
      knownAccounts: [
        ...context.knownAccounts,
        { id: "itau-account", name: "Itaú" },
      ],
    };
    const decision = detectFinancialRoute(
      "Paguei Nubank pela conta Itaú R$ 2350",
      accountContext,
    );
    expect(decision).toMatchObject({
      route: "mark_paid",
      description: "Nubank",
      paymentTarget: "card",
      amountCents: 235_000,
      settlementAccountKeyword: "Itaú",
    });
    expect(
      applyDeterministicPrecedence(decision, {
        intent: "mark_paid",
        target: "card",
        keyword: "Nubank",
        amountCents: 1,
        settlementAccountKeyword: "Conta errada",
      }),
    ).toEqual({
      intent: "mark_paid",
      target: "card",
      keyword: "Nubank",
      amountCents: 235_000,
      settlementAccountKeyword: "Itaú",
    });
  });

  it.each([
    ["Aluguel pago no Pix 1500", "Aluguel", 150_000],
    ["Seguro pago via Pix R$ 500", "Seguro", 50_000],
  ])(
    "lets an explicit paid obligation outrank its Pix source: %s",
    (message, keyword, amountCents) => {
      const decision = detectFinancialRoute(message, context);
      expect(decision).toMatchObject({
        route: "mark_paid",
        description: keyword,
        paymentTarget: "obligation",
        amountCents,
        settlementAccountKeyword: undefined,
      });
      expect(
        applyDeterministicPrecedence(decision, {
          intent: "plain",
          expense: {
            description: keyword,
            amountCents: 1,
            accountKeyword: "Pix",
          },
        }),
      ).toMatchObject({
        intent: "mark_paid",
        target: "obligation",
        keyword,
        amountCents,
      });
      expect(applyDeterministicPrecedence(decision, null)).toMatchObject({
        intent: "mark_paid",
        target: "obligation",
        keyword,
        amountCents,
      });
    },
  );

  it.each([
    ["Aluguel pago 1900 via Pix", 190_000],
    ["Paguei aluguel 1999 via Pix", 199_900],
    ["Paguei aluguel 2000 via Pix", 200_000],
    ["Paguei 2099 do aluguel via Pix", 209_900],
    ["Paguei 2000 do aluguel", 200_000],
  ])(
    "keeps a bare year-range number as an explicit obligation payment amount: %s",
    (message, amountCents) => {
      const decision = detectFinancialRoute(message, context);
      expect(decision).toMatchObject({
        route: "mark_paid",
        description: "Aluguel",
        paymentTarget: "obligation",
        amountCents,
      });
      expect(
        applyDeterministicPrecedence(decision, {
          intent: "mark_paid",
          target: "obligation",
          keyword: "Aluguel errado",
          amountCents: 1,
        }),
      ).toEqual({
        intent: "mark_paid",
        target: "obligation",
        keyword: "Aluguel",
        amountCents,
      });
    },
  );

  it.each([
    ["Cartão Nubank pago", undefined],
    ["O cartão Nubank quitado ontem", undefined],
    ["Cartão Nubank pago R$ 500", 50_000],
  ])(
    "recognizes a card-noun-first known-card settlement: %s",
    (message, amountCents) => {
      const decision = detectFinancialRoute(message, context);
      expect(decision).toMatchObject({
        route: "mark_paid",
        description: "Nubank",
        paymentTarget: "card",
        amountCents,
      });
      expect(
        applyDeterministicPrecedence(decision, {
          intent: "plain",
          expense: {
            description: "Cartão pago",
            amountCents: 1,
            cardKeyword: "Nubank",
          },
        }),
      ).toMatchObject({
        intent: "mark_paid",
        target: "card",
        keyword: "Nubank",
        amountCents,
      });
    },
  );

  it.each([
    "Cartão Nubank compra mercado 50",
    "Cartão Nubank compra de gasolina R$ 50",
  ])(
    "keeps card-first merchant descriptions out of settlement: %s",
    (message) => {
      expect(detectFinancialRoute(message, context)).toMatchObject({
        route: "single_credit",
        cardKeyword: "Nubank",
      });
    },
  );

  it("preserves the terse known-card status settlement", () => {
    expect(detectFinancialRoute("Nubank pago", context)).toMatchObject({
      route: "mark_paid",
      description: "Nubank",
      paymentTarget: "card",
    });
  });

  it.each([
    ["iPhone 15 no Pix 5000", "iPhone 15", 500_000],
    ["TV 55 no Pix 3000", "TV 55", 300_000],
    ["Pneu aro 17 no Pix 800", "Pneu aro 17", 80_000],
  ])(
    "prefers a later instrument-tail amount while preserving specifications: %s",
    (message, description, amountCents) => {
      const decision = detectFinancialRoute(message, context);
      expect(decision).toMatchObject({
        route: "plain_account",
        description,
        amountCents,
        accountKeyword: undefined,
      });
      expect(
        applyDeterministicPrecedence(decision, {
          intent: "plain",
          expense: {
            description: description.split(" ")[0] ?? "Produto",
            amountCents: 1,
            accountKeyword: "Pix",
          },
        }),
      ).toMatchObject({
        intent: "plain",
        expense: { description, amountCents, accountKeyword: undefined },
      });
    },
  );

  it("keeps a single amount before Pix authoritative", () => {
    expect(detectFinancialRoute("Posto Marcio 200 pix", context)).toMatchObject(
      {
        route: "plain_account",
        description: "Posto Marcio",
        amountCents: 20_000,
        accountKeyword: undefined,
      },
    );
  });

  it.each([
    ["Paguei aluguel 1200", "Aluguel", 120_000],
    ["Paguei o empréstimo R$ 500", "Empréstimo", 50_000],
  ])(
    "removes only a complete optional article from paid obligation targets: %s",
    (message, keyword, amountCents) => {
      const decision = detectFinancialRoute(message, context);
      expect(decision).toMatchObject({
        route: "mark_paid",
        description: keyword,
        paymentTarget: "obligation",
        amountCents,
      });
      expect(
        applyDeterministicPrecedence(decision, {
          intent: "mark_paid",
          target: "obligation",
          keyword: "Luguel",
          amountCents: 1,
        }),
      ).toMatchObject({
        intent: "mark_paid",
        target: "obligation",
        keyword,
        amountCents,
      });
    },
  );

  it("carries an explicit account through obligation creation precedence", () => {
    const accountContext = {
      ...context,
      knownAccounts: [
        ...context.knownAccounts,
        { id: "itau-account", name: "Itaú" },
      ],
    };
    const decision = detectFinancialRoute(
      "Aluguel 1500 todo mês pela conta Itaú",
      accountContext,
    );
    expect(decision).toMatchObject({
      route: "obligation",
      description: "Aluguel",
      monthlyAmountCents: 150_000,
      accountKeyword: "Itaú",
    });
    expect(
      applyDeterministicPrecedence(decision, {
        intent: "obligation",
        obligation: {
          description: "Aluguel",
          monthlyAmountCents: 1,
          accountKeyword: "Pix",
        },
      }),
    ).toMatchObject({
      intent: "obligation",
      obligation: {
        description: "Aluguel",
        monthlyAmountCents: 150_000,
        accountKeyword: "Itaú",
      },
    });
    expect(applyDeterministicPrecedence(decision, null)).toMatchObject({
      intent: "obligation",
      obligation: {
        description: "Aluguel",
        monthlyAmountCents: 150_000,
        accountKeyword: "Itaú",
      },
    });
  });

  it("uses Pix as default-account semantics for obligation creation", () => {
    const pix = detectFinancialRoute("Aluguel 1500 todo mês no Pix", context);
    expect(applyDeterministicPrecedence(pix, null)).toMatchObject({
      intent: "obligation",
      obligation: { accountKeyword: undefined },
    });

    const unspecified = detectFinancialRoute("Aluguel 1500 todo mês", context);
    expect(
      applyDeterministicPrecedence(unspecified, {
        intent: "obligation",
        obligation: {
          description: "Aluguel",
          monthlyAmountCents: 150_000,
          accountKeyword: "Conta padrão",
        },
      }),
    ).toMatchObject({
      intent: "obligation",
      obligation: { accountKeyword: "Conta padrão" },
    });
  });

  it("cleans amount and named source from a paid obligation keyword", () => {
    const accountContext = {
      ...context,
      knownAccounts: [
        ...context.knownAccounts,
        { id: "itau-account", name: "Itaú" },
      ],
    };
    const decision = detectFinancialRoute(
      "Paguei aluguel R$ 1500 pela conta Itaú",
      accountContext,
    );
    expect(decision).toMatchObject({
      route: "mark_paid",
      description: "Aluguel",
      paymentTarget: "obligation",
      amountCents: 150_000,
      settlementAccountKeyword: "Itaú",
    });
    expect(
      applyDeterministicPrecedence(decision, {
        intent: "mark_paid",
        target: "obligation",
        keyword: "Aluguel R$ 1500 pela conta Itaú",
        amountCents: 1,
        settlementAccountKeyword: "Pix",
      }),
    ).toEqual({
      intent: "mark_paid",
      target: "obligation",
      keyword: "Aluguel",
      amountCents: 150_000,
      settlementAccountKeyword: "Itaú",
    });
  });

  it.each([
    ["Paguei aluguel 1500 pela conta Itaú", "Itaú"],
    ["Paguei aluguel 1500 pela conta Itaú hoje", "Itaú"],
    ["Paguei aluguel 1500 hoje pela conta Itaú", "Itaú"],
    ["Paguei aluguel 1500 via Pix hoje", undefined],
  ])(
    "preserves a bare payment amount before benign settlement tails: %s",
    (message, settlementAccountKeyword) => {
      const accountContext = {
        ...context,
        knownAccounts: [
          ...context.knownAccounts,
          { id: "itau-account", name: "Itaú" },
        ],
      };
      const decision = detectFinancialRoute(message, accountContext);
      expect(decision).toMatchObject({
        route: "mark_paid",
        description: "Aluguel",
        paymentTarget: "obligation",
        amountCents: 150_000,
        settlementAccountKeyword,
      });
      expect(
        applyDeterministicPrecedence(decision, {
          intent: "mark_paid",
          target: "obligation",
          keyword: "Aluguel errado",
          amountCents: 1,
          settlementAccountKeyword: "Conta errada",
        }),
      ).toEqual({
        intent: "mark_paid",
        target: "obligation",
        keyword: "Aluguel",
        amountCents: 150_000,
        ...(settlementAccountKeyword ? { settlementAccountKeyword } : {}),
      });
      expect(applyDeterministicPrecedence(decision, null)).toEqual({
        intent: "mark_paid",
        target: "obligation",
        keyword: "Aluguel",
        amountCents: 150_000,
        ...(settlementAccountKeyword ? { settlementAccountKeyword } : {}),
      });
    },
  );

  it("keeps every bare financing payment-position number ambiguous", () => {
    const decision = detectFinancialRoute(
      "Paguei o financiamento do carro 1500",
      context,
    );
    expect(decision).toMatchObject({
      route: "ambiguous",
      description: "Financiamento do carro",
      paymentTarget: "obligation",
      amountCents: undefined,
      suppressAiPaymentAmount: true,
      ambiguousPaymentNumber: 1500,
      reason: "ambiguous_payment_number_semantics",
    });
    expect(applyDeterministicPrecedence(decision, null)).toBeNull();
  });

  it.each([
    "com a conta Itaú",
    "com conta Itaú",
    "usando a conta Itaú",
    "usando conta Itaú",
    "da conta Itaú",
    "na conta Itaú",
  ])("recognizes a named settlement source expressed as `%s`", (source) => {
    const accountContext = {
      ...context,
      knownAccounts: [
        ...context.knownAccounts,
        { id: "itau-account", name: "Itaú" },
      ],
    };
    const decision = detectFinancialRoute(
      `Paguei a fatura Nubank R$ 2350 ${source} via Pix`,
      accountContext,
    );
    expect(decision).toMatchObject({
      route: "mark_paid",
      description: "Nubank",
      paymentTarget: "card",
      amountCents: 235_000,
      settlementAccountKeyword: "Itaú",
    });
    expect(
      applyDeterministicPrecedence(decision, {
        intent: "mark_paid",
        target: "card",
        keyword: "Cartão errado",
        amountCents: 1,
        settlementAccountKeyword: "Pix",
      }),
    ).toEqual({
      intent: "mark_paid",
      target: "card",
      keyword: "Nubank",
      amountCents: 235_000,
      settlementAccountKeyword: "Itaú",
    });
  });

  it.each([
    "Paguei a parcela da casa 10 via Pix",
    "Paguei a parcela da casa 10 no Pix ontem",
    "Paguei a parcela da casa 10 pela conta Itaú",
    "Paguei a parcela da casa 10 dia 12/08",
  ])(
    "keeps a bare ordinal-capable number ambiguous before benign payment tails: %s",
    (message) => {
      const decision = detectFinancialRoute(message, context);
      expect(decision).toMatchObject({
        route: "ambiguous",
        description: "Casa",
        amountCents: undefined,
        ambiguousPaymentNumber: 10,
        suppressAiPaymentAmount: true,
        reason: "ambiguous_payment_number_semantics",
      });
      expect(
        applyDeterministicPrecedence(decision, {
          intent: "mark_paid",
          target: "obligation",
          keyword: "Casa",
          amountCents: 1_000,
          settlementAccountKeyword: "Pix",
        }),
      ).toBeNull();
    },
  );

  it.each([
    "Paguei a parcela da casa R$ 10 via Pix",
    "Paguei a parcela da casa 10 reais no Pix",
    "Paguei a parcela da casa 10,00 pela conta Itaú",
    "Paguei a parcela da casa por 10 via Pix",
  ])("keeps explicit payment amounts ahead of benign tails: %s", (message) => {
    expect(detectFinancialRoute(message, context)).toMatchObject({
      route: "mark_paid",
      description: "Casa",
      paymentTarget: "obligation",
      amountCents: 1_000,
    });
  });

  it("prefers a named settlement account over a Pix method clause", () => {
    const accountContext = {
      ...context,
      knownAccounts: [
        ...context.knownAccounts,
        { id: "itau-account", name: "Itaú" },
      ],
    };
    const decision = detectFinancialRoute(
      "Paguei aluguel pela conta Itaú via Pix R$ 1500",
      accountContext,
    );
    expect(decision).toMatchObject({
      route: "mark_paid",
      description: "Aluguel",
      amountCents: 150_000,
      paymentTarget: "obligation",
      settlementAccountKeyword: "Itaú",
    });
    expect(
      applyDeterministicPrecedence(decision, {
        intent: "mark_paid",
        target: "obligation",
        keyword: "Aluguel",
        amountCents: 1,
        settlementAccountKeyword: "Pix",
      }),
    ).toMatchObject({
      intent: "mark_paid",
      target: "obligation",
      keyword: "Aluguel",
      amountCents: 150_000,
      settlementAccountKeyword: "Itaú",
    });
  });

  it("uses the default settlement account when Pix has no named account", () => {
    expect(
      detectFinancialRoute("Paguei aluguel via Pix R$ 1500", context),
    ).toMatchObject({
      route: "mark_paid",
      settlementAccountKeyword: undefined,
    });
  });

  it.each([
    ["Paguei a prestação da casa 1500", 1500],
    ["Paguei 1500 da prestação da casa", 1500],
  ])(
    "never lets AI reinterpret a bare prestação position as money: %s",
    (message, ambiguousPaymentNumber) => {
      const decision = detectFinancialRoute(message, context);
      expect(decision).toMatchObject({
        route: "ambiguous",
        description: "Casa",
        paymentTarget: "obligation",
        amountCents: undefined,
        ambiguousPaymentNumber,
        suppressAiPaymentAmount: true,
        reason: "ambiguous_payment_number_semantics",
      });
      expect(
        applyDeterministicPrecedence(decision, {
          intent: "mark_paid",
          target: "obligation",
          keyword: "Casa",
          amountCents: ambiguousPaymentNumber * 100,
        }),
      ).toBeNull();
    },
  );

  it.each([
    "Paguei a parcela da casa R$ 1500",
    "Paguei a parcela da casa 1500 reais",
    "Paguei a parcela da casa 1500,00",
    "Paguei a parcela da casa por 1500",
    "Paguei a parcela da casa no valor de 1500",
  ])("accepts an explicitly monetary large payment position: %s", (message) => {
    expect(detectFinancialRoute(message, context)).toMatchObject({
      route: "mark_paid",
      description: "Casa",
      paymentTarget: "obligation",
      amountCents: 150_000,
    });
  });

  it.each([
    "Paguei a parcela da casa número 1500",
    "Paguei a parcela da casa 1500ª",
  ])(
    "keeps an explicit large ordinal out of the payment amount: %s",
    (message) => {
      expect(detectFinancialRoute(message, context)).toMatchObject({
        route: "mark_paid",
        description: "Casa",
        paymentTarget: "obligation",
        amountCents: undefined,
        suppressAiPaymentAmount: true,
      });
    },
  );

  it.each([
    ["Paguei aluguel pela conta Itaú 1500", "Aluguel", "obligation"],
    ["Paguei Nubank pela conta Itaú 2350", "Nubank", "card"],
  ])(
    "preserves a source placed before the amount: %s",
    (message, description, paymentTarget) => {
      const accountContext = {
        ...context,
        knownAccounts: [
          ...context.knownAccounts,
          { id: "itau-account", name: "Itaú" },
        ],
      };
      expect(detectFinancialRoute(message, accountContext)).toMatchObject({
        route: "mark_paid",
        description,
        paymentTarget,
        amountCents: message.includes("2350") ? 235_000 : 150_000,
        settlementAccountKeyword: "Itaú",
      });
    },
  );

  it.each([
    ["Paguei aluguel pelo Pix 1500", "Aluguel", "obligation", 150_000],
    ["Paguei aluguel pela Pix R$ 1500", "Aluguel", "obligation", 150_000],
    ["Paguei Nubank pelo Pix 2350", "Nubank", "card", 235_000],
  ])(
    "recognizes pelo/pela Pix without losing the amount: %s",
    (message, description, paymentTarget, amountCents) => {
      expect(detectFinancialRoute(message, context)).toMatchObject({
        route: "mark_paid",
        description,
        paymentTarget,
        amountCents,
        settlementAccountKeyword: undefined,
      });
    },
  );

  it.each([
    ["Paguei aluguel pela conta Conta corrente 1500 pelo Pix", "Aluguel"],
    ["Paguei Nubank pela conta Conta corrente 2350 via Pix", "Nubank"],
  ])(
    "resolves a full Conta-prefixed registered name ahead of Pix: %s",
    (message, description) => {
      const accountContext = {
        ...context,
        knownAccounts: [
          ...context.knownAccounts,
          { id: "checking-account", name: "Conta corrente" },
        ],
      };
      expect(detectFinancialRoute(message, accountContext)).toMatchObject({
        route: "mark_paid",
        description,
        amountCents: message.includes("2350") ? 235_000 : 150_000,
        settlementAccountKeyword: "Conta corrente",
      });
    },
  );

  it.each([
    "pela conta Inter",
    "pelo conta Inter",
    "com a conta Inter",
    "com conta Inter",
    "usando a conta Inter",
    "usando conta Inter",
    "da conta Inter",
    "de conta Inter",
    "na conta Inter",
  ])(
    "does not mistake a card-named settlement source for the target: %s",
    (source) => {
      const decision = detectFinancialRoute(
        `Paguei a fatura Nubank ${source}`,
        context,
      );
      expect(decision).toMatchObject({
        route: "mark_paid",
        description: "Nubank",
        paymentTarget: "card",
        amountCents: undefined,
        suppressAiPaymentAmount: true,
        settlementAccountKeyword: "Inter",
      });
      expect(
        applyDeterministicPrecedence(decision, {
          intent: "mark_paid",
          target: "card",
          keyword: "Inter",
          amountCents: 1,
          settlementAccountKeyword: "Nubank",
        }),
      ).toEqual({
        intent: "mark_paid",
        target: "card",
        keyword: "Nubank",
        amountCents: undefined,
        settlementAccountKeyword: "Inter",
      });
      expect(applyDeterministicPrecedence(decision, null)).toEqual({
        intent: "mark_paid",
        target: "card",
        keyword: "Nubank",
        amountCents: undefined,
        settlementAccountKeyword: "Inter",
      });
    },
  );

  it.each([
    ["Paguei a fatura Nubank 2000 com conta Inter", 200_000],
    ["Paguei a fatura Nubank R$ 2350 com conta Inter", 235_000],
    ["Paguei a fatura Nubank com conta Inter 2000", 200_000],
    ["Paguei a fatura Nubank com conta Inter R$ 2350", 235_000],
  ])(
    "keeps an explicit card-settlement amount around a named source: %s",
    (message, amountCents) => {
      const decision = detectFinancialRoute(message, context);
      expect(decision).toMatchObject({
        route: "mark_paid",
        description: "Nubank",
        paymentTarget: "card",
        amountCents,
        suppressAiPaymentAmount: undefined,
        settlementAccountKeyword: "Inter",
      });
      expect(
        applyDeterministicPrecedence(decision, {
          intent: "mark_paid",
          target: "card",
          keyword: "Inter",
          amountCents: 1,
          settlementAccountKeyword: "Nubank",
        }),
      ).toEqual({
        intent: "mark_paid",
        target: "card",
        keyword: "Nubank",
        amountCents,
        settlementAccountKeyword: "Inter",
      });
      expect(applyDeterministicPrecedence(decision, null)).toEqual({
        intent: "mark_paid",
        target: "card",
        keyword: "Nubank",
        amountCents,
        settlementAccountKeyword: "Inter",
      });
    },
  );

  it.each([
    ["Paguei a fatura Nubank pela conta Inter3", undefined],
    ["Paguei a fatura Nubank R$ 1500 pela conta Inter3", 150_000],
    ["Paguei a fatura Nubank pela conta Inter3 R$ 1500", 150_000],
  ])(
    "never treats digits in a resolved settlement account as the card payment amount: %s",
    (message, amountCents) => {
      const accountContext = {
        ...context,
        knownAccounts: [{ id: "inter3-account", name: "Inter3" }],
      };
      const decision = detectFinancialRoute(message, accountContext);
      expect(decision).toMatchObject({
        route: "mark_paid",
        paymentTarget: "card",
        cardKeyword: "Nubank",
        amountCents,
        settlementAccountKeyword: "Inter3",
      });
      for (const classified of [
        null,
        {
          intent: "mark_paid" as const,
          target: "card" as const,
          keyword: "errado",
          amountCents: 3,
          settlementAccountKeyword: "errado",
        },
      ]) {
        expect(
          applyDeterministicPrecedence(decision, classified),
        ).toMatchObject({
          intent: "mark_paid",
          target: "card",
          keyword: "Nubank",
          amountCents,
          settlementAccountKeyword: "Inter3",
        });
      }
    },
  );

  it.each([
    ["Paguei o aluguel pela conta Inter3", undefined],
    ["Paguei o aluguel R$ 1500 pela conta Inter3", 150_000],
    ["Paguei o aluguel pela conta Inter3 R$ 1500", 150_000],
  ])(
    "never treats digits in a resolved settlement account as an obligation payment amount: %s",
    (message, amountCents) => {
      expect(
        detectFinancialRoute(message, {
          ...context,
          knownAccounts: [{ id: "inter3-account", name: "Inter3" }],
        }),
      ).toMatchObject({
        route: "mark_paid",
        paymentTarget: "obligation",
        amountCents,
        settlementAccountKeyword: "Inter3",
      });
    },
  );

  it("does not reinterpret a standalone card-bill metadata year as money", () => {
    expect(
      detectFinancialRoute(
        "Paguei a fatura Nubank de 2026 com conta Inter",
        context,
      ),
    ).toMatchObject({
      route: "mark_paid",
      paymentTarget: "card",
      amountCents: undefined,
      suppressAiPaymentAmount: true,
      settlementAccountKeyword: "Inter",
    });
  });

  it("preserves AI amount fallback outside a complete card settlement", () => {
    const decision = detectFinancialRoute("Parcela solar paga", context);
    expect(decision).toMatchObject({
      route: "mark_paid",
      paymentTarget: "obligation",
      amountCents: undefined,
      suppressAiPaymentAmount: undefined,
    });
    expect(
      applyDeterministicPrecedence(decision, {
        intent: "mark_paid",
        target: "obligation",
        keyword: "Parcela solar",
        amountCents: 90_000,
      }),
    ).toEqual({
      intent: "mark_paid",
      target: "obligation",
      keyword: "Parcela solar",
      amountCents: 90_000,
    });
  });

  it("prefers the longest exact registered source account including status words", () => {
    const accountContext = {
      ...context,
      knownAccounts: [
        ...context.knownAccounts,
        { id: "mercado-account", name: "Mercado" },
        { id: "mercado-pago-account", name: "Mercado Pago" },
      ],
    };
    const decision = detectFinancialRoute(
      "Paguei a fatura Nubank com a conta Mercado Pago hoje",
      accountContext,
    );
    expect(decision).toMatchObject({
      route: "mark_paid",
      description: "Nubank",
      paymentTarget: "card",
      settlementAccountKeyword: "Mercado Pago",
    });
    expect(applyDeterministicPrecedence(decision, null)).toMatchObject({
      intent: "mark_paid",
      target: "card",
      keyword: "Nubank",
      settlementAccountKeyword: "Mercado Pago",
    });
  });

  it("does not consume an obligation target as a settlement source", () => {
    expect(
      detectFinancialRoute("Paguei a parcela da conta de luz", context),
    ).toMatchObject({
      route: "mark_paid",
      description: "Conta de luz",
      paymentTarget: "obligation",
      settlementAccountKeyword: undefined,
    });
  });

  it("preserves an unknown account from an unambiguous explicit source", () => {
    const accountContext = {
      ...context,
      knownAccounts: [{ id: "nubank-account", name: "Nubank" }],
    };
    expect(
      detectFinancialRoute(
        "Paguei a fatura Nubank pela conta Inter R$ 2000",
        accountContext,
      ),
    ).toMatchObject({
      route: "mark_paid",
      description: "Nubank",
      paymentTarget: "card",
      amountCents: 200_000,
      settlementAccountKeyword: "Inter",
    });
  });

  it("lets a later registered source win after an account-shaped obligation target", () => {
    const accountContext = {
      ...context,
      knownAccounts: [
        ...context.knownAccounts,
        { id: "itau-account", name: "Itaú" },
      ],
    };
    expect(
      detectFinancialRoute(
        "Paguei a parcela da conta de luz pela conta Itaú",
        accountContext,
      ),
    ).toMatchObject({
      route: "mark_paid",
      description: "Conta de luz",
      paymentTarget: "obligation",
      settlementAccountKeyword: "Itaú",
    });
  });

  it("preserves a complete account-shaped target when the source account has the same name", () => {
    const accountContext = {
      ...context,
      knownAccounts: [{ id: "school-account", name: "Escola" }],
    };
    const decision = detectFinancialRoute(
      "Paguei a conta da escola pela conta Escola",
      accountContext,
    );

    expect(decision).toMatchObject({
      route: "mark_paid",
      description: "Conta da escola",
      paymentTarget: "obligation",
      settlementAccountKeyword: "Escola",
    });
    for (const classified of [
      null,
      {
        intent: "mark_paid" as const,
        target: "obligation" as const,
        keyword: "Conta de luz",
      },
      {
        intent: "mark_paid" as const,
        target: "obligation" as const,
        keyword: "Escola",
      },
    ]) {
      expect(applyDeterministicPrecedence(decision, classified)).toEqual({
        intent: "mark_paid",
        target: "obligation",
        keyword: "Conta da escola",
        amountCents: undefined,
        settlementAccountKeyword: "Escola",
      });
    }
  });

  it("fails closed instead of replacing a precise AI target with generic deterministic text", () => {
    expect(
      applyDeterministicPrecedence(
        {
          route: "mark_paid",
          description: "Conta",
          paymentTarget: "obligation",
          settlementAccountKeyword: "Escola",
          explicitNamedSettlementAccount: true,
        },
        {
          intent: "mark_paid",
          target: "obligation",
          keyword: "Escola",
        },
      ),
    ).toBeNull();
  });

  it.each([
    [
      "Paguei seguro do carro 2026 pela conta Inter R$1500",
      "Seguro do carro",
      150_000,
    ],
    ["iPhone 15 na conta Inter 5000", "iPhone 15", 500_000],
    ["TV 55 na conta Inter 5000", "TV 55", 500_000],
  ])(
    "prefers a later supported amount after a named account source: %s",
    (message, description, amountCents) => {
      expect(detectFinancialRoute(message, context)).toMatchObject({
        description,
        amountCents,
        ...(message.startsWith("Paguei seguro")
          ? { settlementAccountKeyword: "Inter" }
          : { accountKeyword: "Inter" }),
      });
    },
  );

  it.each([
    ["Mercado 50 na conta Inter", "Mercado", 5_000],
    ["Mercado na conta Inter 50", "Mercado", 5_000],
  ])(
    "preserves a genuine single amount around a named account: %s",
    (message, description, amountCents) => {
      expect(detectFinancialRoute(message, context)).toMatchObject({
        route: "plain_account",
        description,
        amountCents,
        accountKeyword: "Inter",
      });
    },
  );

  it.each(["pela conta Itaú", "com a conta Itaú", "usando a conta Itaú"])(
    "makes a named account authoritative for a plain expense: %s",
    (source) => {
      const accountContext = {
        ...context,
        knownAccounts: [
          ...context.knownAccounts,
          { id: "itau-account", name: "Itaú" },
        ],
      };
      const decision = detectFinancialRoute(
        `Paguei almoço 75 ${source}`,
        accountContext,
      );
      expect(decision).toMatchObject({
        route: "plain_account",
        description: "Almoço",
        amountCents: 7_500,
        explicitAccountEvidence: true,
        accountKeyword: "Itaú",
      });
      expect(
        applyDeterministicPrecedence(decision, {
          intent: "plain",
          expense: {
            description: "Almoço errado",
            amountCents: 1,
            cardKeyword: "Nubank",
            accountKeyword: "Nubank",
          },
        }),
      ).toEqual({
        intent: "plain",
        expense: {
          description: "Almoço",
          amountCents: 7_500,
          cardKeyword: undefined,
          accountKeyword: "Itaú",
        },
      });
      expect(applyDeterministicPrecedence(decision, null)).toEqual({
        intent: "plain",
        expense: {
          description: "Almoço",
          amountCents: 7_500,
          cardKeyword: undefined,
          accountKeyword: "Itaú",
        },
      });
    },
  );

  it.each([
    ["Paguei a conta de luz 210 pela conta Inter", "Conta de luz", 21_000],
    ["Paguei IPTU 1500 com a conta Inter", "IPTU", 150_000],
    ["Paguei Internet 119,90 usando a conta Inter", "Internet", 11_990],
    ["Paguei Academia 99 pela conta Inter", "Academia", 9_900],
    ["Paguei Condomínio 850 pela conta Inter", "Condomínio", 85_000],
  ])(
    "deterministically settles an explicit obligation target despite wrong AI: %s",
    (message, keyword, amountCents) => {
      const decision = detectFinancialRoute(message, context);
      expect(decision).toMatchObject({
        route: "mark_paid",
        description: keyword,
        amountCents,
        explicitPaymentLanguage: true,
        paymentTarget: "obligation",
        settlementAccountKeyword: "Inter",
      });
      expect(
        applyDeterministicPrecedence(decision, {
          intent: "plain",
          expense: {
            description: `${keyword} errada`,
            amountCents: 1,
            accountKeyword: "Nubank",
          },
        }),
      ).toEqual({
        intent: "mark_paid",
        target: "obligation",
        keyword,
        amountCents,
        settlementAccountKeyword: "Inter",
      });
      expect(applyDeterministicPrecedence(decision, null)).toEqual({
        intent: "mark_paid",
        target: "obligation",
        keyword,
        amountCents,
        settlementAccountKeyword: "Inter",
      });
    },
  );

  it.each([
    ["Paguei a conta de luz pela conta Itaú", "Conta de luz"],
    ["Paguei IPTU com a conta Itaú", "IPTU"],
    ["Paguei Internet usando a conta Itaú", "Internet"],
    ["Paguei Academia pela conta Itaú", "Academia"],
    ["Paguei Condomínio pela conta Itaú", "Condomínio"],
  ])(
    "deterministically settles an explicit obligation target without an amount: %s",
    (message, keyword) => {
      const accountContext = {
        ...context,
        knownAccounts: [
          ...context.knownAccounts,
          { id: "itau-account", name: "Itaú" },
        ],
      };
      const decision = detectFinancialRoute(message, accountContext);
      expect(decision).toMatchObject({
        route: "mark_paid",
        description: keyword,
        amountCents: undefined,
        explicitPaymentLanguage: true,
        paymentTarget: "obligation",
        settlementAccountKeyword: "Itaú",
      });
      expect(
        applyDeterministicPrecedence(decision, {
          intent: "mark_paid",
          target: "obligation",
          keyword: `${keyword} errada`,
          amountCents: 1,
          settlementAccountKeyword: "Nubank",
        }),
      ).toEqual({
        intent: "mark_paid",
        target: "obligation",
        keyword,
        amountCents: undefined,
        settlementAccountKeyword: "Itaú",
      });
      expect(applyDeterministicPrecedence(decision, null)).toEqual({
        intent: "mark_paid",
        target: "obligation",
        keyword,
        amountCents: undefined,
        settlementAccountKeyword: "Itaú",
      });
    },
  );

  it.each([
    ["Conta de luz paga pela conta Inter", "Conta de luz"],
    ["IPTU quitado com a conta Inter", "IPTU"],
    ["Internet paga usando a conta Inter", "Internet"],
    ["Academia quitada pela conta Inter", "Academia"],
  ])(
    "settles a target with explicit status even when the classifier is unavailable: %s",
    (message, keyword) => {
      const decision = detectFinancialRoute(message, context);
      expect(decision).toMatchObject({
        route: "mark_paid",
        description: keyword,
        paymentTarget: "obligation",
        explicitPaymentLanguage: true,
        settlementAccountKeyword: "Inter",
      });
      expect(applyDeterministicPrecedence(decision, null)).toEqual({
        intent: "mark_paid",
        target: "obligation",
        keyword,
        amountCents: undefined,
        settlementAccountKeyword: "Inter",
      });
    },
  );

  it("preserves a true account-backed expense when AI classifies it as plain", () => {
    const decision = detectFinancialRoute(
      "Paguei almoço 50 pela conta Inter",
      context,
    );
    expect(
      applyDeterministicPrecedence(decision, {
        intent: "plain",
        expense: {
          description: "Almoço",
          amountCents: 5_000,
          accountKeyword: "Inter",
        },
      }),
    ).toEqual({
      intent: "plain",
      expense: {
        description: "Almoço",
        amountCents: 5_000,
        cardKeyword: undefined,
        accountKeyword: "Inter",
      },
    });
  });

  it("does not let a wrong AI payment intent turn an ordinary account expense into a settlement", () => {
    const decision = detectFinancialRoute(
      "Paguei almoço 50 pela conta Inter",
      context,
    );
    expect(decision).toMatchObject({
      route: "plain_account",
      description: "Almoço",
      amountCents: 5_000,
      explicitObligationTargetEvidence: undefined,
    });
    expect(
      applyDeterministicPrecedence(decision, {
        intent: "mark_paid",
        target: "obligation",
        keyword: "Almoço",
        amountCents: 1,
        settlementAccountKeyword: "Nubank",
      }),
    ).toEqual({
      intent: "plain",
      expense: {
        description: "Almoço",
        amountCents: 5_000,
        cardKeyword: undefined,
        accountKeyword: "Inter",
      },
    });
  });

  it("carries a source account and suppresses an ordinal in the unresolved car flow", () => {
    const accountContext = {
      ...context,
      knownAccounts: [
        ...context.knownAccounts,
        { id: "itau-account", name: "Itaú" },
      ],
    };
    const decision = detectFinancialRoute(
      "Paguei a parcela do carro número 9 pela conta Itaú",
      accountContext,
    );
    expect(decision).toMatchObject({
      route: "ambiguous",
      description: "Carro",
      amountCents: undefined,
      suppressAiPaymentAmount: true,
      settlementAccountKeyword: "Itaú",
      reason: "unresolved_existing_payment",
    });
    expect(
      applyDeterministicPrecedence(decision, {
        intent: "mark_paid",
        target: "obligation",
        keyword: "Financiamento do carro",
        amountCents: 900,
        settlementAccountKeyword: "Nubank",
      }),
    ).toEqual({
      intent: "mark_paid",
      target: "obligation",
      keyword: "Financiamento do carro",
      amountCents: undefined,
      settlementAccountKeyword: "Itaú",
    });
    expect(applyDeterministicPrecedence(decision, null)).toBeNull();
  });

  it("keeps an explicit amount and source account in the unresolved car flow", () => {
    const accountContext = {
      ...context,
      knownAccounts: [
        ...context.knownAccounts,
        { id: "itau-account", name: "Itaú" },
      ],
    };
    const decision = detectFinancialRoute(
      "Paguei a parcela do carro por R$ 900 pela conta Itaú",
      accountContext,
    );
    expect(decision).toMatchObject({
      route: "ambiguous",
      description: "Carro",
      amountCents: 90_000,
      suppressAiPaymentAmount: undefined,
      settlementAccountKeyword: "Itaú",
      reason: "unresolved_existing_payment",
    });
    expect(
      applyDeterministicPrecedence(decision, {
        intent: "mark_paid",
        target: "obligation",
        keyword: "Financiamento do carro",
        amountCents: 1,
        settlementAccountKeyword: "Nubank",
      }),
    ).toEqual({
      intent: "mark_paid",
      target: "obligation",
      keyword: "Financiamento do carro",
      amountCents: 90_000,
      settlementAccountKeyword: "Itaú",
    });
  });

  it("uses a plausible short year after em as a bill month", () => {
    const decision = detectFinancialRoute(
      "Paguei a fatura Nubank em 07/26",
      context,
    );
    expect(decision).toMatchObject({
      route: "mark_paid",
      paymentTarget: "card",
      billMonth: "2026-07",
      amountCents: undefined,
      suppressAiPaymentAmount: true,
    });
    expect(
      applyDeterministicPrecedence(decision, {
        intent: "mark_paid",
        target: "card",
        keyword: "Inter",
        amountCents: 2_600,
        billMonth: "2027-07",
      }),
    ).toEqual({
      intent: "mark_paid",
      target: "card",
      keyword: "Nubank",
      amountCents: undefined,
      billMonth: "2026-07",
    });
    expect(applyDeterministicPrecedence(decision, null)).toEqual({
      intent: "mark_paid",
      target: "card",
      keyword: "Nubank",
      amountCents: undefined,
      billMonth: "2026-07",
    });
  });

  it("keeps em DD/MM as an occurrence date when the year is implausible", () => {
    const decision = detectFinancialRoute(
      "Paguei a fatura Nubank em 15/07",
      context,
    );
    expect(decision).toMatchObject({
      route: "mark_paid",
      paymentTarget: "card",
      billMonth: undefined,
      amountCents: undefined,
      suppressAiPaymentAmount: true,
    });
    expect(applyDeterministicPrecedence(decision, null)).toEqual({
      intent: "mark_paid",
      target: "card",
      keyword: "Nubank",
      amountCents: undefined,
    });
  });

  it.each([
    ["Paguei o cartão 1000", "Cartão", 100_000],
    ["Cartão pago", "Cartão", undefined],
    ["Fatura paga", "Fatura", undefined],
  ])(
    "routes a generic card settlement deterministically: %s",
    (message, keyword, amountCents) => {
      const decision = detectFinancialRoute(message, context);
      expect(decision).toMatchObject({
        route: "mark_paid",
        description: keyword,
        paymentTarget: "card",
        amountCents,
      });
      expect(
        applyDeterministicPrecedence(decision, {
          intent: "plain",
          expense: {
            description: "Compra incorreta",
            amountCents: 1,
            accountKeyword: "Pix",
          },
        }),
      ).toEqual({
        intent: "mark_paid",
        target: "card",
        keyword,
        amountCents,
      });
      expect(applyDeterministicPrecedence(decision, null)).toEqual({
        intent: "mark_paid",
        target: "card",
        keyword,
        amountCents,
      });
    },
  );

  it("preserves an unknown card name following the fatura target", () => {
    expect(
      detectFinancialRoute("Paguei a fatura Santander", context),
    ).toMatchObject({
      route: "mark_paid",
      description: "Fatura Santander",
      paymentTarget: "card",
    });
  });

  it("preserves a duplicated known card name for downstream ambiguity", () => {
    const duplicatedCardContext = {
      ...context,
      knownCards: [
        ...context.knownCards,
        { id: "nubank-second", name: "Nubank" },
      ],
    };
    expect(
      detectFinancialRoute("Paguei a fatura Nubank", duplicatedCardContext),
    ).toMatchObject({
      route: "mark_paid",
      description: "Nubank",
      paymentTarget: "card",
      cardKeyword: undefined,
    });
  });

  it("does not mistake a merchant purchase paid with a card for settlement", () => {
    expect(
      detectFinancialRoute("Paguei mercado 50 no cartão Nubank", context),
    ).toMatchObject({
      route: "single_credit",
      description: "Mercado",
      amountCents: 5_000,
      cardKeyword: "Nubank",
    });
  });

  it.each([
    ["Notebook 300 no cartão Nubank, não parcelado", "single_credit"],
    ["Cadeira 500 no Nubank, não parcelada", "single_credit"],
    ["Tênis 200 no cartão Inter, não parcelei", "single_credit"],
    ["Mercado 100 no Pix, sem parcelas", "plain_account"],
  ] as const)(
    "treats negated installment wording as a single charge: %s",
    (message, route) => {
      expect(detectFinancialRoute(message, context)).toMatchObject({ route });
    },
  );

  it.each([13, 24, 1500])(
    "keeps a bare financing position ambiguous regardless of magnitude: %s",
    (position) => {
      expect(
        detectFinancialRoute(
          `Paguei o financiamento do carro ${position}`,
          context,
        ),
      ).toMatchObject({
        route: "ambiguous",
        paymentTarget: "obligation",
        amountCents: undefined,
        suppressAiPaymentAmount: true,
        ambiguousPaymentNumber: position,
        reason: "ambiguous_payment_number_semantics",
      });
    },
  );

  it.each([
    ["Paguei o financiamento do carro R$ 1500", 150_000],
    ["Paguei o financiamento do carro 1500 reais", 150_000],
    ["Paguei o financiamento do carro 1500,00", 150_000],
    ["Paguei o financiamento do carro por 1500", 150_000],
    ["Paguei o financiamento do carro no valor de 1500", 150_000],
  ])(
    "accepts explicit financing payment amounts: %s",
    (message, amountCents) => {
      expect(detectFinancialRoute(message, context)).toMatchObject({
        route: "mark_paid",
        paymentTarget: "obligation",
        amountCents,
      });
    },
  );

  it.each(["13/08", "10/08"])(
    "treats a bare DD/MM card-payment fragment as an occurrence date: %s",
    (date) => {
      expect(
        detectFinancialRoute(`Paguei a fatura Nubank ${date}`, context),
      ).toMatchObject({
        route: "mark_paid",
        paymentTarget: "card",
        billMonth: undefined,
        amountCents: undefined,
        suppressAiPaymentAmount: true,
      });
    },
  );

  it("preserves an explicit short-year bill-month selector", () => {
    expect(
      detectFinancialRoute("Paguei a fatura Nubank de 07/26", context),
    ).toMatchObject({
      route: "mark_paid",
      paymentTarget: "card",
      billMonth: "2026-07",
    });
  });

  it.each([
    ["Nubank pago 07/2026", "2026-07"],
    ["Nubank pago em 15/07", undefined],
    ["Nubank pago no dia 15/07", undefined],
    ["Nubank pago 15/07", undefined],
    ["Fatura paga 07/2026", "2026-07"],
    ["Fatura do cartão paga", undefined],
  ])(
    "keeps card settlements with supported date/month fragments out of purchase routing: %s",
    (message, billMonth) => {
      expect(detectFinancialRoute(message, context)).toMatchObject({
        route: "mark_paid",
        paymentTarget: "card",
        amountCents: undefined,
        suppressAiPaymentAmount: true,
        billMonth,
      });
    },
  );

  it.each([
    "Paguei a fatura Nubank dia 0",
    "Paguei a fatura Nubank dia32",
    "Paguei a fatura Nubank dia 100",
    "Paguei aluguel dia 0",
    "Paguei aluguel dia32",
    "Paguei aluguel dia 100",
  ])("keeps invalid bare settlement days as metadata: %s", (message) => {
    const decision = detectFinancialRoute(message, context);
    expect(decision).toMatchObject({
      route: "mark_paid",
      amountCents: undefined,
      suppressAiPaymentAmount: true,
    });
    expect(decision.description).not.toMatch(/\b(?:0|32|100)\b/);
  });

  it.each([
    "Paguei a parcela número 3 do carro",
    "Paguei a parcela 3 do carro",
    "parcela 3 do carro",
  ])(
    "treats a post-nominal parcel number as a paid position: %s",
    (message) => {
      expect(detectFinancialRoute(message, context)).toMatchObject({
        route: "mark_paid",
        description: "Carro",
        paymentTarget: "obligation",
        amountCents: undefined,
        suppressAiPaymentAmount: true,
      });
    },
  );

  it.each([
    "Não parcelado, Notebook 300 no crédito Nubank",
    "Sem parcelas: Notebook 300 no crédito Nubank",
    "Não parcelei - Notebook 300 no crédito Nubank",
  ])(
    "strips leading negated-installment wording from descriptions: %s",
    (message) => {
      expect(detectFinancialRoute(message, context)).toMatchObject({
        route: "single_credit",
        description: "Notebook",
        amountCents: 30_000,
      });
    },
  );

  it("uses Pix as default-account semantics while preserving named precedence", () => {
    const namedContext = {
      ...context,
      knownAccounts: [
        ...context.knownAccounts,
        { id: "itau-account", name: "Itaú" },
      ],
    };
    const defaultPix = detectFinancialRoute(
      "Paguei aluguel R$ 1500 via Pix",
      namedContext,
    );
    expect(defaultPix).toMatchObject({
      route: "mark_paid",
      settlementAccountKeyword: undefined,
      explicitDefaultSettlementAccount: true,
    });
    expect(
      applyDeterministicPrecedence(defaultPix, {
        intent: "mark_paid",
        target: "obligation",
        keyword: "Aluguel",
        amountCents: 150_000,
        settlementAccountKeyword: "Pix",
      }),
    ).not.toHaveProperty("settlementAccountKeyword");

    expect(
      detectFinancialRoute(
        "Paguei aluguel R$ 1500 pela conta Itaú via Pix",
        namedContext,
      ),
    ).toMatchObject({
      route: "mark_paid",
      settlementAccountKeyword: "Itaú",
      explicitDefaultSettlementAccount: false,
    });
  });

  it.each([
    ["Paguei a fatura Nubank R$ 2350 pela conta Pix", "card", "Nubank"],
    ["Paguei aluguel R$ 1500 com a conta Pix", "obligation", "Aluguel"],
  ])(
    "preserves Pix as an explicitly named settlement account: %s",
    (message, target, keyword) => {
      const pixAccountContext = {
        ...context,
        knownAccounts: [
          ...context.knownAccounts,
          { id: "pix-account", name: "Pix" },
        ],
      };
      const decision = detectFinancialRoute(message, pixAccountContext);
      expect(decision).toMatchObject({
        route: "mark_paid",
        paymentTarget: target,
        settlementAccountKeyword: "Pix",
        explicitNamedSettlementAccount: true,
        explicitDefaultSettlementAccount: false,
      });
      expect(
        applyDeterministicPrecedence(decision, {
          intent: "mark_paid",
          target: target as "card" | "obligation",
          keyword,
          amountCents: 1,
          settlementAccountKeyword: "Conta errada",
        }),
      ).toMatchObject({
        intent: "mark_paid",
        target,
        keyword,
        settlementAccountKeyword: "Pix",
      });
    },
  );

  it.each([
    ["Aluguel 1500 todo mês na conta Pix", "obligation"],
    ["Mercado 100 pela conta Pix", "plain_account"],
  ])(
    "preserves Pix as an explicitly named account for creation: %s",
    (message, route) => {
      const pixAccountContext = {
        ...context,
        knownAccounts: [
          ...context.knownAccounts,
          { id: "pix-account", name: "Pix" },
        ],
      };
      const decision = detectFinancialRoute(message, pixAccountContext);
      expect(decision).toMatchObject({
        route,
        accountKeyword: "Pix",
        explicitNamedSettlementAccount: true,
        explicitDefaultSettlementAccount: false,
      });
      const routed = applyDeterministicPrecedence(decision, null);
      if (route === "obligation") {
        expect(routed).toMatchObject({
          intent: "obligation",
          obligation: { accountKeyword: "Pix" },
        });
      } else {
        expect(routed).toMatchObject({
          intent: "plain",
          expense: { accountKeyword: "Pix" },
        });
      }
    },
  );

  it.each([
    "Paguei aluguel R$ 1500 via Pix",
    "Paguei aluguel R$ 1500 no Pix",
    "Paguei aluguel R$ 1500 pelo Pix",
    "Paguei aluguel R$ 1500 com Pix",
    "Paguei aluguel R$ 1500 usando Pix",
    "Paguei aluguel R$ 1500 por Pix",
    "Paguei aluguel R$ 1500 via o Pix",
    "Paguei aluguel R$ 1500 via a Pix",
  ])(
    "keeps Pix payment-method wording on default-account semantics: %s",
    (message) => {
      const pixAccountContext = {
        ...context,
        knownAccounts: [
          ...context.knownAccounts,
          { id: "pix-account", name: "Pix" },
        ],
      };
      const decision = detectFinancialRoute(message, pixAccountContext);
      expect(decision).toMatchObject({
        route: "mark_paid",
        settlementAccountKeyword: undefined,
        explicitNamedSettlementAccount: undefined,
        explicitDefaultSettlementAccount: true,
      });
      expect(
        applyDeterministicPrecedence(decision, {
          intent: "mark_paid",
          target: "obligation",
          keyword: "Aluguel",
          amountCents: 150_000,
          settlementAccountKeyword: "Pix",
        }),
      ).not.toHaveProperty("settlementAccountKeyword");
    },
  );

  it.each([
    "Almoço 75 via Pix",
    "Almoço 75 no Pix",
    "Almoço 75 pelo Pix",
    "Almoço 75 com Pix",
    "Almoço 75 usando Pix",
    "Almoço 75 por Pix",
    "Almoço 75 via o Pix",
    "Almoço 75 via a Pix",
  ])(
    "does not turn a Pix payment method into the registered Pix account: %s",
    (message) => {
      const pixAccountContext = {
        ...context,
        knownAccounts: [
          ...context.knownAccounts,
          { id: "pix-account", name: "Pix" },
        ],
      };
      const decision = detectFinancialRoute(message, pixAccountContext);
      expect(decision).toMatchObject({
        route: "plain_account",
        explicitNamedSettlementAccount: undefined,
        explicitDefaultSettlementAccount: true,
      });
      expect(
        applyDeterministicPrecedence(decision, {
          intent: "plain",
          expense: {
            description: "Almoço",
            amountCents: 7500,
            accountKeyword: "Pix",
          },
        }),
      ).toEqual({
        intent: "plain",
        expense: {
          description: "Almoço",
          amountCents: 7500,
          cardKeyword: undefined,
          accountKeyword: undefined,
        },
      });
    },
  );

  it("requires a choice for a generic adjective status instead of auto-settling a matching obligation", () => {
    const decision = detectFinancialRoute("Almoço pago no Pix R$ 50", context);
    expect(decision).toMatchObject({
      route: "ambiguous",
      reason: "unresolved_existing_payment",
      description: "Almoço",
      paymentTarget: "obligation",
      amountCents: 5_000,
      explicitDefaultSettlementAccount: true,
    });
  });

  it.each([
    ["Paguei aluguel pela conta Nubank PJ R$ 1500", "Nubank PJ"],
    ["Paguei aluguel pela conta Nubank-PJ R$ 1500", "Nubank-PJ"],
    ["Paguei aluguel pela conta Itaú conjunta hoje", "Itaú conjunta"],
  ])(
    "does not resolve a registered account-name prefix inside a longer spoken source: %s",
    (message, settlementAccountKeyword) => {
      expect(detectFinancialRoute(message, context)).toMatchObject({
        route: "mark_paid",
        settlementAccountKeyword,
        explicitNamedSettlementAccount: true,
      });
    },
  );

  it("keeps the longest exact multiword source before method and amount tails", () => {
    const accountContext = {
      ...context,
      knownAccounts: [
        ...context.knownAccounts,
        { id: "current-account", name: "Conta corrente" },
      ],
    };
    expect(
      detectFinancialRoute(
        "Paguei aluguel pela conta Conta corrente via o Pix R$ 1500",
        accountContext,
      ),
    ).toMatchObject({
      route: "mark_paid",
      settlementAccountKeyword: "Conta corrente",
      amountCents: 150_000,
    });
  });

  it.each([
    ["iPhone 15 em 12x de 300 no crédito Nubank", "iPhone 15"],
    ["PlayStation 5 em 12x de 300 no crédito Nubank", "PlayStation 5"],
  ])(
    "does not reinterpret a product model as the total before an explicit installment clause: %s",
    (message, description) => {
      expect(detectFinancialRoute(message, context)).toMatchObject({
        route: "installment",
        description,
        installmentCount: 12,
        perInstallmentCents: 30_000,
        totalCents: 360_000,
      });
    },
  );

  it("keeps a supported leading total before an explicit installment clause", () => {
    expect(
      detectFinancialRoute(
        "Notebook 3600 em 12x de 300 no crédito Nubank",
        context,
      ),
    ).toMatchObject({
      route: "installment",
      description: "Notebook",
      installmentCount: 12,
      perInstallmentCents: 30_000,
      totalCents: 360_000,
    });
  });

  it("recognizes a bare amount before the description without consuming model numbers", () => {
    expect(
      detectFinancialRoute("5000 Notebook parcelado em 10x no Nubank", context),
    ).toMatchObject({
      route: "installment",
      description: "Notebook",
      installmentCount: 10,
      totalCents: 500_000,
      cardKeyword: "Nubank",
    });
  });

  it("removes only the leading currency span from an amount-first description", () => {
    expect(
      detectFinancialRoute("R$ 5000 iPhone 15 Pro no Pix", context),
    ).toMatchObject({
      route: "plain_account",
      description: "iPhone 15 Pro",
      amountCents: 500_000,
    });
  });

  it("preserves an explicitly named unknown installment card", () => {
    const decision = detectFinancialRoute(
      "Notebook 5000 parcelado em 10x no cartão Fantasma",
      context,
    );
    expect(decision).toMatchObject({
      route: "installment",
      description: "Notebook",
      totalCents: 500_000,
      installmentCount: 10,
      cardKeyword: "Fantasma",
    });
    expect(applyDeterministicPrecedence(decision, null)).toMatchObject({
      intent: "card_installment",
      purchase: { cardKeyword: "Fantasma" },
    });
  });

  it("keeps the description when a paid plain expense leads with its amount", () => {
    const decision = detectFinancialRoute("Paguei 50 almoço no Pix", context);
    expect(decision).toMatchObject({
      route: "plain_account",
      description: "Almoço",
      amountCents: 5_000,
      accountKeyword: undefined,
      explicitDefaultSettlementAccount: true,
    });
    expect(applyDeterministicPrecedence(decision, null)).toMatchObject({
      intent: "plain",
      expense: {
        description: "Almoço",
        amountCents: 5_000,
        accountKeyword: undefined,
      },
    });
  });

  it.each([
    "Paguei parcela 10/12 da placa solar R$710",
    "Paguei a parcela 10/12 da placa solar por R$ 710",
    "QuiteI a prestação 10/12 da placa solar no valor de 710 reais",
  ])(
    "routes an existing installment fraction as an obligation settlement: %s",
    (message) => {
      expect(detectFinancialRoute(message, context)).toMatchObject({
        route: "mark_paid",
        description: "Placa solar",
        paymentTarget: "obligation",
        amountCents: 71_000,
        billMonth: undefined,
      });
      expect(
        applyDeterministicPrecedence(
          detectFinancialRoute(message, context),
          null,
        ),
      ).toMatchObject({
        intent: "mark_paid",
        target: "obligation",
        keyword: "Placa solar",
        amountCents: 71_000,
      });
    },
  );

  it("recognizes a monthly recurrence with an explicit term and account source", () => {
    const decision = detectFinancialRoute(
      "Academia R$99 por mês durante 12 meses na conta Inter",
      context,
    );
    expect(decision).toMatchObject({
      route: "obligation",
      description: "Academia",
      monthlyAmountCents: 9_900,
      installmentCount: 12,
      accountKeyword: "Inter",
    });
    expect(
      applyDeterministicPrecedence(decision, {
        intent: "obligation",
        obligation: {
          description: "Academia errada",
          monthlyAmountCents: 1,
          termMonths: 2,
          accountKeyword: "Nubank",
        },
      }),
    ).toEqual({
      intent: "obligation",
      obligation: {
        description: "Academia",
        monthlyAmountCents: 9_900,
        termMonths: 12,
        dueDay: undefined,
        accountKeyword: "Inter",
      },
    });
  });

  it("stops the named account at an obligation start-date delimiter", () => {
    expect(
      detectFinancialRoute(
        "Academia R$99 por mês durante 12 meses na conta Nubank a partir de 15/09",
        context,
      ),
    ).toMatchObject({
      route: "obligation",
      description: "Academia",
      monthlyAmountCents: 9_900,
      installmentCount: 12,
      accountKeyword: "Nubank",
      startDate: { day: 15, month: 9 },
    });
  });

  it.each([
    ["R$710,44 parcela solar em 72x", "Parcela solar"],
    ["710,44 empréstimo 72x", "Empréstimo"],
    ["710,44 consórcio 72x", "Consórcio"],
  ])(
    "routes an amount-first finite obligation without card evidence: %s",
    (message, description) => {
      const decision = detectFinancialRoute(message, context);
      expect(decision).toMatchObject({
        route: "obligation",
        description,
        monthlyAmountCents: 71_044,
        installmentCount: 72,
        explicitCardEvidence: undefined,
      });
      expect(
        applyDeterministicPrecedence(decision, {
          intent: "card_installment",
          purchase: {
            description: "Compra errada",
            totalCents: 71_044,
            installmentCount: 72,
          },
        }),
      ).toMatchObject({
        intent: "obligation",
        obligation: {
          description,
          monthlyAmountCents: 71_044,
          termMonths: 72,
        },
      });
    },
  );

  it("keeps mixed finite-obligation and explicit-card evidence unsafe", () => {
    expect(
      detectFinancialRoute(
        "R$710,44 parcela solar em 72x no cartão Nubank",
        context,
      ),
    ).toMatchObject({
      route: "ambiguous",
      reason: "card_and_financing_evidence",
    });
  });

  it.each([
    ["Parcela solar 710,44 72x todo dia 29", 28],
    ["Parcela solar 710,44 72x todo dia 30", 28],
    ["Parcela solar 710,44 72x todo dia 31", 28],
  ] as const)(
    "clamps an explicit late-month due day: %s",
    (message, dueDay) => {
      const decision = detectFinancialRoute(message, context);
      expect(decision).toMatchObject({
        route: "obligation",
        dueDay,
      });
      expect(
        applyDeterministicPrecedence(decision, {
          intent: "obligation",
          obligation: {
            description: "Descrição errada",
            monthlyAmountCents: 1,
            termMonths: 2,
            dueDay: 1,
          },
        }),
      ).toMatchObject({
        intent: "obligation",
        obligation: { dueDay },
      });
    },
  );

  it.each([
    "Parcela solar 710,44 72x todo dia 0",
    "Parcela solar 710,44 72x todo dia 32",
  ])("rejects an invalid explicit due day: %s", (message) => {
    expect(detectFinancialRoute(message, context)).toMatchObject({
      route: "ambiguous",
      reason: "invalid_due_day",
    });
  });

  it("keeps an independent due day ahead of the obligation start-date day", () => {
    const decision = detectFinancialRoute(
      "aluguel1200 todo mês dia10 a partir de05/09",
      context,
    );

    expect(decision).toMatchObject({
      route: "obligation",
      description: "Aluguel",
      monthlyAmountCents: 120_000,
      dueDay: 10,
      requestedDueDay: undefined,
      startDate: { day: 5, month: 9 },
    });
    expect(
      applyDeterministicPrecedence(decision, {
        intent: "obligation",
        obligation: {
          description: "Aluguel errado",
          monthlyAmountCents: 1,
          dueDay: 5,
        },
      }),
    ).toMatchObject({
      intent: "obligation",
      obligation: {
        description: "Aluguel",
        monthlyAmountCents: 120_000,
        dueDay: 10,
      },
    });
  });

  it("does not consume a start-date phrase into an unknown account name", () => {
    expect(
      detectFinancialRoute(
        "Academia R$99 por mês durante 12 meses na conta Fantasma a partir de 15/09",
        context,
      ),
    ).toMatchObject({
      route: "obligation",
      accountKeyword: "Fantasma",
      startDate: { day: 15, month: 9 },
    });
  });

  it.each([
    ["Mercado 100 no cartão hoje", "Hoje"],
    ["Mercado 100 no cartão dia 05/08", "Dia"],
  ])(
    "keeps a temporal fragment after a generic card unnamed: %s",
    (message, name) => {
      const decision = detectFinancialRoute(message, {
        ...context,
        knownCards: [{ id: "temporal", name }, ...context.knownCards],
      });
      expect(decision).toMatchObject({
        route: "single_credit",
        description: "Mercado",
        amountCents: 10_000,
        cardKeyword: undefined,
        explicitCardInstrumentLanguage: true,
      });
    },
  );

  it("does not restore AI-invented providers for generic instruments", () => {
    expect(
      applyDeterministicPrecedence(
        detectFinancialRoute("Mercado 100 no débito", context),
        {
          intent: "plain",
          expense: {
            description: "Mercado errado",
            amountCents: 1,
            accountKeyword: "Itaú",
            cardKeyword: "Inter",
          },
        },
      ),
    ).toEqual({
      intent: "plain",
      expense: {
        description: "Mercado",
        amountCents: 10_000,
        accountKeyword: undefined,
        cardKeyword: undefined,
      },
    });

    expect(
      applyDeterministicPrecedence(
        detectFinancialRoute("Notebook 1200 em 12x no cartão", context),
        {
          intent: "card_installment",
          purchase: {
            description: "Notebook errado",
            totalCents: 1,
            installmentCount: 2,
            cardKeyword: "Inter",
          },
        },
      ),
    ).toMatchObject({
      intent: "card_installment",
      purchase: {
        description: "Notebook",
        totalCents: 120_000,
        installmentCount: 12,
        cardKeyword: undefined,
      },
    });
  });

  it.each([
    ["Seguro 245 por mês todo dia 14", "Seguro", 24_500, undefined, 14],
    [
      "Financiamento 1800 durante 240 meses",
      "Financiamento",
      180_000,
      240,
      undefined,
    ],
  ] as const)(
    "extracts a mid-description bare monthly amount: %s",
    (message, description, monthlyAmountCents, installmentCount, dueDay) => {
      expect(detectFinancialRoute(message, context)).toMatchObject({
        route: "obligation",
        description,
        monthlyAmountCents,
        installmentCount,
        dueDay,
      });
    },
  );

  it("treats present habitual payment wording as obligation creation", () => {
    const decision = detectFinancialRoute("Eu pago o aluguel", context);
    expect(decision).toMatchObject({
      route: "obligation",
      description: "Aluguel",
    });
    expect(
      applyDeterministicPrecedence(decision, {
        intent: "mark_paid",
        target: "obligation",
        keyword: "Aluguel",
      }),
    ).toMatchObject({
      intent: "obligation",
      obligation: { description: "Aluguel" },
    });
    expect(detectFinancialRoute("Paguei o aluguel", context).route).toBe(
      "mark_paid",
    );
  });

  it("suppresses adjacent tax years from AI payment amounts but preserves currency", () => {
    const metadata = detectFinancialRoute("Paguei IPVA 2026 via Pix", context);
    expect(metadata).toMatchObject({
      route: "mark_paid",
      amountCents: undefined,
      suppressAiPaymentAmount: true,
    });
    expect(
      applyDeterministicPrecedence(metadata, {
        intent: "mark_paid",
        target: "obligation",
        keyword: "IPVA 2026",
        amountCents: 202_600,
      }),
    ).toMatchObject({ intent: "mark_paid", amountCents: undefined });
    expect(
      detectFinancialRoute("Paguei IPVA R$ 2026 via Pix", context),
    ).toMatchObject({ route: "mark_paid", amountCents: 202_600 });
  });

  it.each([
    ["Mercado 100 no crédito hoje", "single_credit"],
    ["Mercado 100 no débito hoje", "plain_account"],
    ["Mercado 100 em dinheiro hoje", "plain_account"],
    ["Mercado 100 via Pix hoje", "plain_account"],
  ] as const)(
    "does not resolve temporal account/card names after a generic instrument: %s",
    (message, route) => {
      const decision = detectFinancialRoute(message, {
        ...context,
        knownCards: [{ id: "card-today", name: "Hoje" }],
        knownAccounts: [{ id: "account-today", name: "Hoje" }],
      });
      expect(decision).toMatchObject({
        route,
        description: "Mercado",
        amountCents: 10_000,
        cardKeyword: undefined,
      });
      expect(decision.accountKeyword).not.toBe("Hoje");
    },
  );

  it.each([
    "Paguei IPVA de 2026 via Pix",
    "Paguei IPTU referente a 2026 pela conta Itaú",
  ])(
    "suppresses a tax metadata year and a conflicting AI amount: %s",
    (message) => {
      const decision = detectFinancialRoute(message, context);
      expect(decision).toMatchObject({
        route: "mark_paid",
        amountCents: undefined,
        suppressAiPaymentAmount: true,
      });
      expect(
        applyDeterministicPrecedence(decision, {
          intent: "mark_paid",
          target: "obligation",
          keyword: "IPVA",
          amountCents: 202_600,
        }),
      ).toMatchObject({ intent: "mark_paid", amountCents: undefined });
    },
  );

  it.each([
    "Paguei IPVA de R$ 2026 via Pix",
    "Paguei IPTU referente a R$ 2026 pela conta Itaú",
  ])(
    "preserves an explicitly monetary tax-year-shaped value: %s",
    (message) => {
      expect(detectFinancialRoute(message, context)).toMatchObject({
        route: "mark_paid",
        amountCents: 202_600,
      });
    },
  );

  it.each([
    ["Aluguel 1500 ao mês", "Aluguel", 150_000, undefined],
    ["Academia 99 mensalmente", "Academia", 9_900, undefined],
    ["Academia 99 mensais durante 12 meses", "Academia", 9_900, 12],
  ] as const)(
    "recognizes recurring-language variants with a clean description: %s",
    (message, description, monthlyAmountCents, installmentCount) => {
      expect(detectFinancialRoute(message, context)).toMatchObject({
        route: "obligation",
        description,
        monthlyAmountCents,
        installmentCount,
      });
    },
  );

  it.each([
    "Notebook 300 no crédito Nubank, não parcelado",
    "Notebook não parcelada, 300 no crédito Nubank",
    "Notebook sem parcelas 300 no crédito Nubank",
    "Notebook pagamento único 300 no crédito Nubank",
    "Notebook 300 no crédito Nubank, uma vez",
  ])(
    "removes every single-charge marker from the description: %s",
    (message) => {
      expect(detectFinancialRoute(message, context)).toMatchObject({
        route: "single_credit",
        description: "Notebook",
        amountCents: 30_000,
      });
    },
  );

  it.each([
    ["Notebook no cartão por 1200", "Por", "single_credit", undefined],
    ["Notebook no cartão em 12x de 100", "Em", "installment", 12],
    ["Notebook no cartão uma vez por 1200", "Uma", "single_credit", undefined],
    [
      "Notebook no cartão sem parcelar por 1200",
      "Sem parcelar",
      "single_credit",
      undefined,
    ],
  ] as const)(
    "does not treat a structural clause after generic cartão as its name: %s",
    (message, structuralName, route, installmentCount) => {
      expect(
        detectFinancialRoute(message, {
          ...context,
          knownCards: [{ id: "structural", name: structuralName }],
        }),
      ).toMatchObject({
        route,
        cardKeyword: undefined,
        installmentCount,
        explicitCardInstrumentLanguage: true,
      });
    },
  );

  it.each([
    ["Notebook no cartão em três parcelas de 100", "Notebook"],
    ["Compra na Três em três parcelas de 100 no cartão Nubank", "Três"],
  ])(
    "normalizes accented count words without leaking the count clause into the description: %s",
    (message, description) => {
      expect(
        detectFinancialRoute(message, {
          ...context,
          knownCards: [
            { id: "merchant-collision", name: "Três" },
            { id: "nubank", name: "Nubank" },
          ],
        }),
      ).toMatchObject({
        route: "installment",
        description,
        installmentCount: 3,
        perInstallmentCents: 10_000,
        totalCents: 30_000,
      });
    },
  );

  it.each([
    ["Mercado 100 na fatura hoje", "plain_account"],
    ["Mercado 100 no boleto hoje", "plain_account"],
  ] as const)(
    "does not use Hoje as an instrument name after every generic alias: %s",
    (message, route) => {
      const decision = detectFinancialRoute(message, {
        ...context,
        knownCards: [{ id: "card-today", name: "Hoje" }],
        knownAccounts: [{ id: "account-today", name: "Hoje" }],
      });
      expect(decision).toMatchObject({ route, cardKeyword: undefined });
      expect(decision.accountKeyword).not.toBe("Hoje");
    },
  );

  it.each(["IPTU 2026", "IPVA de2026", "Seguro referência2026"])(
    "suppresses a metadata year without requiring instrument wording: %s",
    (message) => {
      const decision = detectFinancialRoute(message, context);
      expect(decision).toMatchObject({
        route: "plain_account",
        amountCents: undefined,
        explicitMetadataYearEvidence: true,
      });
      expect(
        applyDeterministicPrecedence(decision, {
          intent: "plain",
          expense: { description: "errada", amountCents: 202_600 },
        }),
      ).toMatchObject({ intent: "plain", expense: { amountCents: undefined } });
    },
  );

  it.each([
    ["Aluguel 1500 todos os meses", "Aluguel", 150_000],
    ["Academia 99 cada mês", "Academia", 9_900],
    ["Internet 120 a cada mês", "Internet", 12_000],
    ["Seguro recorrente 245", "Seguro", 24_500],
  ] as const)(
    "routes additional recurrence synonyms as clean obligations: %s",
    (message, description, monthlyAmountCents) => {
      expect(detectFinancialRoute(message, context)).toMatchObject({
        route: "obligation",
        description,
        monthlyAmountCents,
      });
    },
  );

  it.each([
    "sem parcelar: Notebook 300 no crédito Nubank",
    "cobrado de uma vez: Notebook 300 no crédito Nubank",
  ])(
    "cleans a leading single-charge marker with punctuation: %s",
    (message) => {
      expect(detectFinancialRoute(message, context)).toMatchObject({
        route: "single_credit",
        description: "Notebook",
        amountCents: 30_000,
      });
    },
  );

  it.each([
    "Seguro exercício 2026",
    "Seguro exercício de 2026",
    "Seguro ano-base 2026",
  ])(
    "suppresses qualified metadata years with null or wrong AI: %s",
    (message) => {
      const decision = detectFinancialRoute(message, context);
      expect(decision).toMatchObject({
        route: "plain_account",
        description: "Seguro",
        amountCents: undefined,
        explicitMetadataYearEvidence: true,
      });
      expect(
        applyDeterministicPrecedence(decision, {
          intent: "plain",
          expense: { description: "Seguro errado", amountCents: 202_600 },
        }),
      ).toMatchObject({
        intent: "plain",
        expense: { description: "Seguro", amountCents: undefined },
      });
    },
  );

  it("suppresses a qualified payment year but preserves explicit currency", () => {
    const metadata = detectFinancialRoute(
      "Paguei IPVA exercício de 2026 via Pix",
      context,
    );
    expect(metadata).toMatchObject({
      route: "mark_paid",
      description: "IPVA",
      amountCents: undefined,
      suppressAiPaymentAmount: true,
    });
    expect(
      applyDeterministicPrecedence(metadata, {
        intent: "mark_paid",
        target: "obligation",
        keyword: "IPVA",
        amountCents: 202_600,
      }),
    ).toMatchObject({ intent: "mark_paid", amountCents: undefined });
    expect(
      detectFinancialRoute("Paguei IPVA exercício de R$ 2026 via Pix", context),
    ).toMatchObject({ route: "mark_paid", amountCents: 202_600 });
  });

  it.each([
    "Notebook 300 uma única parcela no crédito Nubank",
    "Notebook 300 em uma única prestação no cartão Nubank",
    "Notebook 300 parcelado em uma única parcela no crédito Nubank",
  ])("makes an explicit single-charge marker authoritative: %s", (message) => {
    const decision = detectFinancialRoute(message, context);
    expect(decision).toMatchObject({
      route: "single_credit",
      description: "Notebook",
      amountCents: 30_000,
      cardKeyword: "Nubank",
    });
    expect(
      applyDeterministicPrecedence(decision, {
        intent: "card_installment",
        purchase: {
          description: "Notebook 1x",
          totalCents: 1,
          installmentCount: 12,
          cardKeyword: "Inter",
        },
      }),
    ).toMatchObject({
      intent: "plain",
      expense: {
        description: "Notebook",
        amountCents: 30_000,
        cardKeyword: "Nubank",
      },
    });
  });

  it("recognizes mês a mês as a clean recurrence", () => {
    expect(
      detectFinancialRoute("Internet 120 mês a mês", context),
    ).toMatchObject({
      route: "obligation",
      description: "Internet",
      monthlyAmountCents: 12_000,
    });
  });

  it.each(["Parcelado", "Parcelei", "Com juros", "Sem juros"])(
    "does not resolve structural installment vocabulary as card %s",
    (structuralName) => {
      const decision = detectFinancialRoute(
        `Notebook 1200 parcelado em 12x sem juros no cartão Nubank`,
        {
          ...context,
          knownCards: [
            { id: "structural", name: structuralName },
            { id: "nubank", name: "Nubank" },
          ],
        },
      );
      expect(decision).toMatchObject({
        route: "installment",
        cardKeyword: "Nubank",
        installmentCount: 12,
      });
    },
  );

  it("keeps a generic parcelado occurrence from selecting a card named Parcelado", () => {
    expect(
      detectFinancialRoute("Notebook 1200 parcelado em 12x no cartão", {
        ...context,
        knownCards: [
          { id: "structural", name: "Parcelado" },
          { id: "nubank", name: "Nubank" },
        ],
      }),
    ).toMatchObject({
      route: "installment",
      cardKeyword: undefined,
      installmentCount: 12,
    });
  });

  it.each([
    "IPTU ano fiscal 2026",
    "IPTU ano-calendário 2026",
    "IPTU ano calendário 2026",
    "IPTU exercício fiscal 2026",
  ])(
    "treats the full metadata-year qualifier family as non-monetary: %s",
    (message) => {
      const decision = detectFinancialRoute(message, context);
      expect(decision).toMatchObject({
        route: "plain_account",
        description: "IPTU",
        amountCents: undefined,
        explicitMetadataYearEvidence: true,
      });
    },
  );

  it.each([
    "Paguei IPTU ano fiscal 2026 via Pix",
    "Paguei IPTU ano-calendário 2026 via Pix",
    "Paguei IPTU ano calendário 2026 via Pix",
    "Paguei IPTU exercício fiscal 2026 via Pix",
  ])(
    "suppresses qualified payment years across the metadata family: %s",
    (message) => {
      const decision = detectFinancialRoute(message, context);
      expect(decision).toMatchObject({
        route: "mark_paid",
        description: "IPTU",
        amountCents: undefined,
        suppressAiPaymentAmount: true,
      });
    },
  );

  it.each([
    "IPTU ano fiscal R$ 2026",
    "IPTU ano-calendário R$ 2026",
    "IPTU exercício fiscal R$ 2026",
  ])(
    "preserves explicit currency even beside a metadata qualifier: %s",
    (message) => {
      expect(detectFinancialRoute(message, context)).toMatchObject({
        route: "plain_account",
        description: "IPTU",
        amountCents: 202_600,
      });
    },
  );

  it.each([
    "Notebook 300 parcela única no crédito Nubank",
    "Notebook 300 prestação única no crédito Nubank",
    "Notebook 300 em parcela única no crédito Nubank",
    "Notebook 300 uma só parcela no crédito Nubank",
    "Notebook 300 uma só prestação no crédito Nubank",
  ])(
    "makes every explicit one-charge marker authoritative without treating the amount as a count: %s",
    (message) => {
      expect(detectFinancialRoute(message, context)).toMatchObject({
        route: "single_credit",
        description: "Notebook",
        amountCents: 30_000,
        installmentCount: 1,
        cardKeyword: "Nubank",
      });
    },
  );

  it.each([
    ["Notebook 1200 em 12x com juros no cartão", "Juros"],
    ["Notebook 300 em parcela única no cartão", "Única"],
    ["Notebook 300 uma vez no cartão", "Vez"],
    ["Notebook 300 no cartão", "Cartão"],
    ["Notebook 300 no crédito", "Crédito"],
  ] as const)(
    "does not resolve contextual structural vocabulary as a card: %s",
    (message, name) => {
      expect(
        detectFinancialRoute(message, {
          ...context,
          knownCards: [{ id: "structural", name }],
        }),
      ).toMatchObject({ cardKeyword: undefined });
    },
  );

  it("preserves a structurally named real card when the user names it explicitly", () => {
    expect(
      detectFinancialRoute("Notebook 300 no cartão chamado Juros", {
        ...context,
        knownCards: [{ id: "real-card", name: "Juros" }],
      }),
    ).toMatchObject({
      route: "single_credit",
      description: "Notebook",
      amountCents: 30_000,
      cardKeyword: "Juros",
    });
  });

  it.each(["Hoje", "Ontem", "Anteontem"])(
    "does not select a temporal instrument from a leading occurrence token: %s",
    (name) => {
      const decision = detectFinancialRoute(`${name} mercado 100 no crédito`, {
        ...context,
        knownCards: [{ id: "temporal-card", name }],
        knownAccounts: [{ id: "temporal-account", name }],
      });
      expect(decision).toMatchObject({
        route: "single_credit",
        description: "Mercado",
        amountCents: 10_000,
        cardKeyword: undefined,
      });
      expect(decision.accountKeyword).toBeUndefined();
    },
  );

  it.each([
    ["Academia 99 todos meses", "Academia", 9_900, undefined],
    ["Internet R$ 120/mês", "Internet", 12_000, undefined],
    ["Internet 120 todo dia 10", "Internet", 12_000, 10],
    ["Mensalidade da academia R$ 99", "Academia", 9_900, undefined],
  ] as const)(
    "recognizes recurrence grammar while cleaning amount, cadence, and due day: %s",
    (message, description, monthlyAmountCents, dueDay) => {
      expect(detectFinancialRoute(message, context)).toMatchObject({
        route: "obligation",
        description,
        monthlyAmountCents,
        dueDay,
      });
    },
  );

  it.each([
    "Seguro exercício financeiro 2026",
    "Seguro exercício financeiro de 2026",
  ])("shares exercício financeiro metadata semantics: %s", (message) => {
    const decision = detectFinancialRoute(message, context);
    expect(decision).toMatchObject({
      route: "plain_account",
      description: "Seguro",
      amountCents: undefined,
      explicitMetadataYearEvidence: true,
    });
    expect(
      applyDeterministicPrecedence(decision, {
        intent: "plain",
        expense: { description: "Seguro 2026", amountCents: 202_600 },
      }),
    ).toMatchObject({
      intent: "plain",
      expense: { description: "Seguro", amountCents: undefined },
    });
  });

  it("suppresses exercício financeiro as an invented payment amount", () => {
    expect(
      detectFinancialRoute(
        "Paguei IPVA exercício financeiro 2026 via Pix",
        context,
      ),
    ).toMatchObject({
      route: "mark_paid",
      description: "IPVA",
      amountCents: undefined,
      suppressAiPaymentAmount: true,
    });
    expect(
      detectFinancialRoute(
        "Paguei IPVA exercício financeiro R$ 2026 via Pix",
        context,
      ),
    ).toMatchObject({
      route: "mark_paid",
      description: "IPVA",
      amountCents: 202_600,
    });
  });

  it.each(["Aluguel 1500 todo o mês", "1500 aluguel todo o mês dia 10"])(
    "routes and cleans todo o mês recurrence: %s",
    (message) => {
      expect(detectFinancialRoute(message, context)).toMatchObject({
        route: "obligation",
        description: "Aluguel",
        monthlyAmountCents: 150_000,
      });
    },
  );

  it.each([
    "Notebook 300 em uma única vez no crédito Nubank",
    "Notebook em uma só vez por 300 no crédito Nubank",
    "Notebook 300 parcelado em uma única vez no crédito Nubank",
  ])("makes a one-time vez clause authoritative and clean: %s", (message) => {
    const decision = detectFinancialRoute(message, context);
    expect(decision).toMatchObject({
      route: "single_credit",
      description: "Notebook",
      amountCents: 30_000,
      installmentCount: 1,
      cardKeyword: "Nubank",
    });
    expect(
      applyDeterministicPrecedence(decision, {
        intent: "card_installment",
        purchase: {
          description: "Notebook 1x",
          totalCents: 1,
          installmentCount: 12,
          cardKeyword: "Inter",
        },
      }),
    ).toMatchObject({
      intent: "plain",
      expense: { description: "Notebook", amountCents: 30_000 },
    });
  });

  it("does not treat Vez as an implicit card name in a structural clause", () => {
    expect(
      detectFinancialRoute("Notebook 300 em uma única vez no cartão", {
        ...context,
        knownCards: [{ id: "vez", name: "Vez" }],
      }),
    ).toMatchObject({
      route: "single_credit",
      description: "Notebook",
      cardKeyword: undefined,
    });
  });

  it("keeps explicitly named temporal cards while treating other relative dates as occurrences", () => {
    const temporalContext = {
      ...context,
      knownCards: [{ id: "today", name: "Hoje" }],
      knownAccounts: [{ id: "today-account", name: "Hoje" }],
    };
    expect(
      detectFinancialRoute("Mercado 100 hoje no crédito", temporalContext),
    ).toMatchObject({
      route: "single_credit",
      description: "Mercado",
      cardKeyword: undefined,
      accountKeyword: undefined,
    });
    expect(
      detectFinancialRoute(
        "Mercado 100 no cartão chamado Hoje",
        temporalContext,
      ),
    ).toMatchObject({ route: "single_credit", cardKeyword: "Hoje" });
  });

  it.each(["Mensal", "Referência", "Competência"])(
    "does not implicitly resolve cadence or metadata card/account %s",
    (name) => {
      const decision = detectFinancialRoute(`Mercado 100 ${name} no crédito`, {
        ...context,
        knownCards: [{ id: "metadata-card", name }],
        knownAccounts: [{ id: "metadata-account", name }],
      });
      expect(decision.cardKeyword).toBeUndefined();
      expect(decision.accountKeyword).toBeUndefined();
    },
  );

  it("allows an explicitly escaped cadence account", () => {
    expect(
      detectFinancialRoute("Mercado 100 pela conta de nome Mensal", {
        ...context,
        knownAccounts: [{ id: "monthly-account", name: "Mensal" }],
      }),
    ).toMatchObject({
      route: "plain_account",
      description: "Mercado",
      amountCents: 10_000,
      accountKeyword: "Mensal",
    });
  });

  it.each(["Hoje", "Mensal", "Referência"])(
    "requires an explicit escape before using a reserved account name: %s",
    (name) => {
      expect(
        detectFinancialRoute(`Mercado 100 pela conta ${name}`, {
          ...context,
          knownAccounts: [{ id: "reserved-account", name }],
        }),
      ).toMatchObject({
        route: "ambiguous",
        accountKeyword: undefined,
        reason: "ambiguous_account_name",
      });
      expect(
        detectFinancialRoute(`Mercado 100 pela conta chamada ${name}`, {
          ...context,
          knownAccounts: [{ id: "reserved-account", name }],
        }),
      ).toMatchObject({
        route: "plain_account",
        description: "Mercado",
        amountCents: 10_000,
        accountKeyword: name,
      });
      expect(
        detectFinancialRoute(`Mercado 100 conta de nome ${name}`, {
          ...context,
          knownAccounts: [{ id: "reserved-account", name }],
        }),
      ).toMatchObject({
        route: "plain_account",
        description: "Mercado",
        amountCents: 10_000,
        accountKeyword: name,
      });
    },
  );

  it.each(["Hoje", "Parcelado", "Mensal"])(
    "uses an explicitly escaped structural card name without activating its grammar: %s",
    (name) => {
      const escaped = detectFinancialRoute(
        `Mercado 100 no cartão de nome ${name}`,
        {
          ...context,
          knownCards: [{ id: "reserved-card", name }],
        },
      );
      expect(escaped).toMatchObject({
        route: "single_credit",
        description: "Mercado",
        amountCents: 10_000,
        cardKeyword: name,
      });
    },
  );

  it.each(["Parcelado 10x", "Uma vez", "0x", "Entrada mais 5x", "Mensal 2026"])(
    "masks the complete explicitly named card from every financial grammar: %s",
    (name) => {
      expect(
        detectFinancialRoute(`Mercado 100 no cartão de nome ${name}`, {
          ...context,
          knownCards: [
            { id: "short-card", name: name.split(" ")[0] as string },
            { id: "full-card", name },
          ],
        }),
      ).toMatchObject({
        route: "single_credit",
        description: "Mercado",
        amountCents: 10_000,
        cardKeyword: name,
        installmentCount: undefined,
      });
    },
  );

  it.each(["Parcelado", "Mensal 2026", "Conta123", "Hoje2", "Minha.Conta"])(
    "resolves the complete escaped account name without activating its grammar: %s",
    (name) => {
      const shortName = name.replace(/[ .]?\d+$/u, "").split(".")[0] as string;
      expect(
        detectFinancialRoute(`Mercado 100 pela conta de nome ${name}`, {
          ...context,
          knownAccounts:
            shortName === name
              ? [{ id: "full-account", name }]
              : [
                  { id: "short-account", name: shortName },
                  { id: "full-account", name },
                ],
        }),
      ).toMatchObject({
        route: "plain_account",
        description: "Mercado",
        amountCents: 10_000,
        accountKeyword: name,
        installmentCount: undefined,
      });
    },
  );

  it.each([
    ["Paguei o cartão de nome Parcela Solar", null, "Parcela Solar"],
    [
      "Paguei a fatura Parcela Solar",
      {
        intent: "mark_paid" as const,
        target: "obligation" as const,
        keyword: "Parcela solar",
      },
      "Parcela Solar",
    ],
    [
      "Paguei o cartão de nome Parcela Solar Black",
      {
        intent: "mark_paid" as const,
        target: "obligation" as const,
        keyword: "Parcela solar",
      },
      "Parcela Solar Black",
    ],
  ])(
    "makes an explicit card target authoritative over obligation-shaped card names: %s",
    (message, classified, expectedCard) => {
      const cardContext = {
        ...context,
        knownCards: [
          ...context.knownCards,
          { id: "solar-short", name: "Parcela Solar" },
          { id: "solar-long", name: "Parcela Solar Black" },
        ],
      };
      const decision = detectFinancialRoute(message, cardContext);
      expect(decision).toMatchObject({
        route: "mark_paid",
        paymentTarget: "card",
        description: expectedCard,
        cardKeyword: expectedCard,
      });
      expect(applyDeterministicPrecedence(decision, classified)).toMatchObject({
        intent: "mark_paid",
        target: "card",
        keyword: expectedCard,
      });
    },
  );

  it("keeps a real parcela solar payment as an obligation without explicit card syntax", () => {
    expect(
      detectFinancialRoute("Paguei a parcela solar", {
        ...context,
        knownCards: [
          ...context.knownCards,
          { id: "solar-card", name: "Parcela Solar" },
        ],
      }),
    ).toMatchObject({
      route: "mark_paid",
      paymentTarget: "obligation",
      description: "Parcela solar",
    });
  });

  it.each([
    null,
    {
      intent: "mark_paid" as const,
      target: "obligation" as const,
      keyword: "Parcela solar",
    },
    {
      intent: "plain" as const,
      expense: { description: "Parcela solar", amountCents: 1 },
    },
  ])(
    "does not reuse a resolved source-account name as a missing obligation target with AI %#",
    (classified) => {
      const sourceNamedLikeObligation = {
        ...context,
        knownAccounts: [
          ...context.knownAccounts,
          { id: "solar-account", name: "Parcela Solar" },
        ],
      };
      const decision = detectFinancialRoute(
        "Paguei pela conta Parcela Solar",
        sourceNamedLikeObligation,
      );

      expect(decision).toMatchObject({
        route: "ambiguous",
        reason: "missing_payment_target",
        description: undefined,
        settlementAccountKeyword: "Parcela Solar",
      });
      expect(applyDeterministicPrecedence(decision, classified)).toBeNull();
    },
  );

  it.each([
    ["Parcela Solar", "Parcela Solar"],
    ["Parcela Solar Pagamentos", "Parcela Solar Pagamentos"],
  ])(
    "keeps an explicit parcela solar target separate from its %s source account",
    (accountName, expectedAccount) => {
      const decision = detectFinancialRoute(
        `Paguei a parcela solar pela conta ${accountName}`,
        {
          ...context,
          knownAccounts: [{ id: "solar-account", name: accountName }],
        },
      );

      expect(decision).toMatchObject({
        route: "mark_paid",
        paymentTarget: "obligation",
        description: "Parcela solar",
        settlementAccountKeyword: expectedAccount,
      });
      expect(applyDeterministicPrecedence(decision, null)).toMatchObject({
        intent: "mark_paid",
        target: "obligation",
        keyword: "Parcela solar",
        settlementAccountKeyword: expectedAccount,
      });
    },
  );

  it.each([
    ["Conta+", "Conta"],
    ["(VIP)", "VIP"],
    ["Minha.Conta.", "Minha.Conta"],
  ])(
    "resolves and strips a punctuation-ending account longest-first: %s",
    (fullName, shortName) => {
      expect(
        detectFinancialRoute(
          `Academia 99 mensal pela conta de nome ${fullName}`,
          {
            ...context,
            knownAccounts: [
              { id: "short-account", name: shortName },
              { id: "full-account", name: fullName },
            ],
          },
        ),
      ).toMatchObject({
        route: "obligation",
        description: "Academia",
        monthlyAmountCents: 9_900,
        accountKeyword: fullName,
      });
    },
  );

  it.each([
    "IPTU referência 2026 mensal",
    "IPTU referente a 2026 mensal",
    "IPTU de 2026 mensal",
    "IPTU competência 2026 todo mês",
    "IPTU exercício financeiro 2026 mensal",
    "IPTU 2026 mensal",
  ])("never treats a recurring metadata year as money: %s", (message) => {
    const decision = detectFinancialRoute(message, context);
    expect(decision).toMatchObject({
      route: "obligation",
      description: "IPTU",
      monthlyAmountCents: undefined,
      explicitMetadataYearEvidence: true,
    });
    expect(
      applyDeterministicPrecedence(decision, {
        intent: "obligation",
        obligation: {
          description: "IPTU 2026",
          monthlyAmountCents: 202_600,
        },
      }),
    ).toMatchObject({
      intent: "obligation",
      obligation: { description: "IPTU", monthlyAmountCents: undefined },
    });
  });

  it.each([
    "IPTU referência R$ 2026 mensal",
    "IPTU competência 2026 reais todo mês",
  ])(
    "keeps explicitly monetary recurring year-shaped values: %s",
    (message) => {
      expect(detectFinancialRoute(message, context)).toMatchObject({
        route: "obligation",
        monthlyAmountCents: 202_600,
      });
    },
  );

  it("does not shorten an authoritative card name to a registered prefix", () => {
    const decision = detectFinancialRoute(
      "Notebook 300 no cartão chamado Nubank Ultravioleta",
      {
        ...context,
        knownCards: [{ id: "nubank", name: "Nubank" }],
      },
    );
    expect(decision).toMatchObject({
      route: "single_credit",
      description: "Notebook",
      amountCents: 30_000,
      cardKeyword: "Nubank Ultravioleta",
      authoritativeCardName: "Nubank Ultravioleta",
      unambiguousKnownCardEvidence: undefined,
    });
    expect(applyDeterministicPrecedence(decision, null)).toBeNull();
    expect(
      applyDeterministicPrecedence(decision, {
        intent: "card_installment",
        purchase: {
          description: "Notebook errado",
          totalCents: 1,
          cardKeyword: "Nubank",
        },
      }),
    ).toMatchObject({
      intent: "plain",
      expense: { cardKeyword: "Nubank Ultravioleta" },
    });
  });

  it("does not shorten an authoritative punctuation-ending account name", () => {
    expect(
      detectFinancialRoute("Mercado 100 pela conta de nome Conta+", {
        ...context,
        knownAccounts: [{ id: "conta", name: "Conta" }],
      }),
    ).toMatchObject({
      route: "plain_account",
      accountKeyword: "Conta+",
    });
  });

  it.each([
    ["card", "Aurea+ 2", "Áurea+ 2"],
    ["account", "Conta.2026+", "Conta.2026+"],
  ] as const)(
    "matches the complete authoritative %s name accent-insensitively while preserving punctuation and numbers",
    (kind, typedName, registeredName) => {
      const decision = detectFinancialRoute(
        kind === "card"
          ? `Notebook 300 no cartão chamado ${typedName}`
          : `Mercado 100 pela conta de nome ${typedName}`,
        {
          ...context,
          knownCards:
            kind === "card"
              ? [{ id: "exact-card", name: registeredName }]
              : context.knownCards,
          knownAccounts:
            kind === "account"
              ? [{ id: "exact-account", name: registeredName }]
              : context.knownAccounts,
        },
      );
      expect(decision).toMatchObject(
        kind === "card"
          ? {
              cardKeyword: registeredName,
              authoritativeCardName: typedName,
            }
          : { accountKeyword: registeredName },
      );
    },
  );

  it.each([
    ["Paguei o cartão chamado Aurea+ 2", undefined],
    ["Paguei o cartão chamado Aurea+ 2 por R$ 450", 45_000],
  ])(
    "does not extract digits from an authoritative card name: %s",
    (message, expectedAmountCents) => {
      const decision = detectFinancialRoute(message, {
        ...context,
        knownCards: [{ id: "aurea", name: "Áurea+ 2" }],
      });
      expect(decision).toMatchObject({
        route: "mark_paid",
        paymentTarget: "card",
        cardKeyword: "Áurea+ 2",
        authoritativeCardName: "Aurea+ 2",
        amountCents: expectedAmountCents,
      });
      if (expectedAmountCents === undefined) {
        expect(decision).toMatchObject({ suppressAiPaymentAmount: true });
      }

      for (const classified of [
        null,
        {
          intent: "plain" as const,
          expense: { description: "errado", amountCents: 2 },
        },
        {
          intent: "mark_paid" as const,
          target: "card" as const,
          keyword: "errado",
          amountCents: 2,
        },
      ]) {
        expect(
          applyDeterministicPrecedence(decision, classified),
        ).toMatchObject({
          intent: "mark_paid",
          target: "card",
          keyword: "Aurea+ 2",
          amountCents: expectedAmountCents,
        });
      }
    },
  );

  it.each([
    ["Paguei o cartão Aurea+ 2", undefined],
    ["Cartão Aurea+ 2 pago", undefined],
    ["Fatura Aurea+ 2 paga", undefined],
    ["Paguei a fatura do cartão Aurea+ 2", undefined],
    ["Paguei a fatura cartão Aurea+ 2", undefined],
    ["Fatura do cartão Aurea+ 2 paga", undefined],
    ["Quitei a fatura do cartão Aurea+ 2", undefined],
    ["Paguei o cartão Aurea+ 2 por R$ 450", 45_000],
    ["Paguei a fatura do cartão Aurea+ 2 por R$ 450", 45_000],
    ["Cartão Aurea+ 2 pago R$ 450", 45_000],
    ["Fatura Aurea+ 2 paga 450 reais", 45_000],
  ])(
    "masks digits in an unambiguously resolved known-card settlement: %s",
    (message, expectedAmountCents) => {
      const decision = detectFinancialRoute(message, {
        ...context,
        knownCards: [{ id: "aurea", name: "Áurea+ 2" }],
      });
      expect(decision).toMatchObject({
        route: "mark_paid",
        paymentTarget: "card",
        cardKeyword: "Áurea+ 2",
        amountCents: expectedAmountCents,
      });
      if (expectedAmountCents === undefined) {
        expect(decision).toMatchObject({ suppressAiPaymentAmount: true });
      }

      for (const classified of [
        null,
        {
          intent: "mark_paid" as const,
          target: "card" as const,
          keyword: "errado",
          amountCents: 2,
        },
      ]) {
        expect(
          applyDeterministicPrecedence(decision, classified),
        ).toMatchObject({
          intent: "mark_paid",
          target: "card",
          keyword: "Áurea+ 2",
          amountCents: expectedAmountCents,
        });
      }
    },
  );

  it.each([
    ["Paguei o cartão chamado Aurea+ 2 pago", undefined, undefined],
    ["Paguei o cartão chamado Aurea+ 2 em 07/2026", undefined, "2026-07"],
    ["Paguei o cartão chamado Aurea+ 2 via Pix", undefined, undefined],
    ["Paguei o cartão chamado Aurea+ 2 com conta Inter", undefined, undefined],
    ["Paguei o cartão chamado Aurea+ 2 por R$ 450", 45_000, undefined],
  ])(
    "keeps payment metadata outside the longest exact authoritative card name: %s",
    (message, expectedAmountCents, expectedBillMonth) => {
      const decision = detectFinancialRoute(message, {
        ...context,
        knownCards: [
          { id: "aurea-short", name: "Áurea" },
          { id: "aurea-full", name: "Áurea+ 2" },
        ],
        knownAccounts: [{ id: "inter", name: "Inter" }],
      });

      expect(decision).toMatchObject({
        route: "mark_paid",
        paymentTarget: "card",
        cardKeyword: "Áurea+ 2",
        authoritativeCardName: "Aurea+ 2",
        amountCents: expectedAmountCents,
      });
      expect(decision.billMonth).toBe(expectedBillMonth);
      if (message.includes("conta Inter")) {
        expect(decision.settlementAccountKeyword).toBe("Inter");
      }
    },
  );

  it("keeps an unknown full authoritative card name unresolved before payment metadata", () => {
    const decision = detectFinancialRoute(
      "Paguei o cartão chamado Aurea+ 2 pago",
      context,
    );
    expect(decision).toMatchObject({
      route: "mark_paid",
      paymentTarget: "card",
      cardKeyword: "Aurea+ 2",
      authoritativeCardName: "Aurea+ 2",
      unambiguousKnownCardEvidence: undefined,
    });
  });

  it("does not shorten a normal fatura target to a registered prefix", () => {
    const decision = detectFinancialRoute("Fatura Aurea+2 Black paga", {
      ...context,
      knownCards: [{ id: "aurea", name: "Áurea+2" }],
    });

    expect(decision).toMatchObject({
      route: "mark_paid",
      paymentTarget: "card",
      cardKeyword: "Aurea+2 Black",
      authoritativeCardName: "Aurea+2 Black",
      amountCents: undefined,
      suppressAiPaymentAmount: true,
    });
    expect(applyDeterministicPrecedence(decision, null)).toMatchObject({
      intent: "mark_paid",
      target: "card",
      keyword: "Aurea+2 Black",
      amountCents: undefined,
    });
  });

  it.each([
    "Fatura Card05/08 dia06/08 Black",
    "Fatura Card05/08 paga Black",
    "Fatura Card05/08 R$450 Black",
  ])(
    "keeps invalid metadata residue in an unresolved normal fatura target: %s",
    (message) => {
      const decision = detectFinancialRoute(message, {
        ...context,
        knownCards: [{ id: "card-date", name: "Card05/08" }],
      });

      expect(decision).toMatchObject({
        route: "mark_paid",
        paymentTarget: "card",
        cardKeyword: message.slice("Fatura ".length),
        authoritativeCardName: message.slice("Fatura ".length),
        unambiguousKnownCardEvidence: undefined,
      });
      expect(applyDeterministicPrecedence(decision, null)).toMatchObject({
        intent: "mark_paid",
        target: "card",
        keyword: message.slice("Fatura ".length),
      });
    },
  );

  it.each([
    "Compra mercado paga na fatura Nubank R$50",
    "Pedido pago na fatura Nubank R$50",
    "Entrada paga na fatura Nubank R$50",
    "Compra da fatura Nubank paga",
    "Pedido da fatura Nubank pago",
    "Entrada da fatura Nubank paga",
    "Fatura Nubank paga, compra do mercado",
    "Compras na fatura Nubank paga",
    "Fatura Nubank paga, pedidos do mercado",
    "Entradas da fatura Nubank paga",
  ])(
    "does not reinterpret purchase residue as a card-bill settlement: %s",
    (message) => {
      const decision = detectFinancialRoute(message, context);
      expect(decision.route).not.toBe("mark_paid");

      const classified = {
        intent: "plain" as const,
        expense: {
          description: "Mercado",
          amountCents: 5_000,
          cardKeyword: "Nubank",
        },
      };
      expect(applyDeterministicPrecedence(decision, classified)).toEqual(
        classified,
      );
      expect(applyDeterministicPrecedence(decision, null)?.intent).not.toBe(
        "mark_paid",
      );
      expect(
        applyDeterministicPrecedence(decision, {
          intent: "mark_paid",
          target: "card",
          keyword: "Nubank",
          amountCents: 5_000,
        })?.intent,
      ).not.toBe("mark_paid");
    },
  );

  it.each(["Compra", "Compras", "Pedido", "Pedidos", "Entrada", "Entradas"])(
    "does not treat the registered card name %s as purchase residue",
    (cardName) => {
      const decision = detectFinancialRoute(`Fatura ${cardName} paga`, {
        ...context,
        knownCards: [
          ...context.knownCards,
          { id: `card-${cardName.toLowerCase()}`, name: cardName },
        ],
      });

      expect(decision).toMatchObject({
        route: "mark_paid",
        paymentTarget: "card",
        cardKeyword: cardName,
        unambiguousKnownCardEvidence: true,
      });
    },
  );

  it.each(["Compra", "Compras", "Pedido", "Pedidos", "Entrada", "Entradas"])(
    "does not treat the registered settlement-account name %s as purchase residue",
    (accountName) => {
      expect(
        detectFinancialRoute(`Fatura Nubank paga pela conta ${accountName}`, {
          ...context,
          knownAccounts: [
            ...context.knownAccounts,
            {
              id: `account-${accountName.toLowerCase()}`,
              name: accountName,
            },
          ],
        }),
      ).toMatchObject({
        route: "mark_paid",
        paymentTarget: "card",
        cardKeyword: "Nubank",
        settlementAccountKeyword: accountName,
      });
    },
  );

  it.each([
    "Fatura Nubank — paga pela conta Inter R$ 1500",
    "Fatura Nubank - paga pela conta Inter R$ 1500",
    "Fatura Nubank (paga) pela conta Inter R$ 1500",
  ])(
    "accepts prose punctuation between a registered fatura target and payment metadata: %s",
    (message) => {
      const decision = detectFinancialRoute(message, context);
      expect(decision).toMatchObject({
        route: "mark_paid",
        paymentTarget: "card",
        cardKeyword: "Nubank",
        amountCents: 150_000,
        settlementAccountKeyword: "Inter",
      });
      for (const classified of [
        null,
        {
          intent: "mark_paid" as const,
          target: "obligation" as const,
          keyword: "errado",
          amountCents: 1,
          settlementAccountKeyword: "Nubank",
        },
      ]) {
        expect(
          applyDeterministicPrecedence(decision, classified),
        ).toMatchObject({
          intent: "mark_paid",
          target: "card",
          keyword: "Nubank",
          amountCents: 150_000,
          settlementAccountKeyword: "Inter",
        });
      }
    },
  );

  it("keeps an unknown punctuated fatura target unresolved", () => {
    expect(
      detectFinancialRoute("Fatura Santander — paga", context),
    ).toMatchObject({
      route: "mark_paid",
      paymentTarget: "card",
      description: "Fatura Santander — paga",
      cardKeyword: undefined,
      authoritativeCardName: undefined,
      unambiguousKnownCardEvidence: undefined,
    });
  });

  it.each([
    "Cartão Nubank pago por R$ 450",
    "Cartão Nubank pago no valor de 450 pela conta Inter no dia 05/07/2026",
    "Cartão Nubank dia 05/07/2026 pela conta Inter pago valor de R$ 450",
    "Cartão Nubank pela conta Inter data 05/07/2026 pago por R$ 450",
  ])(
    "keeps qualified amounts and reordered benign tails on card-first settlements: %s",
    (message) => {
      const decision = detectFinancialRoute(message, {
        ...context,
        knownAccounts: [{ id: "inter", name: "Inter" }],
      });
      expect(decision).toMatchObject({
        route: "mark_paid",
        paymentTarget: "card",
        cardKeyword: "Nubank",
        amountCents: 45_000,
      });
      expect(
        applyDeterministicPrecedence(decision, {
          intent: "card_installment",
          purchase: {
            description: "Compra errada",
            totalCents: 1,
            installmentCount: 12,
            cardKeyword: "Nubank",
          },
        }),
      ).toMatchObject({
        intent: "mark_paid",
        target: "card",
        keyword: "Nubank",
        amountCents: 45_000,
      });
    },
  );

  it.each([
    "Paguei o cartão chamado Aurea+ 2 05/07/2026 por R$ 450",
    "Paguei o cartão chamado Aurea+ 2 dia 05/07/2026 no valor de 450",
    "Paguei o cartão chamado Aurea+ 2 no dia 05/07/2026 valor de R$ 450",
    "Paguei o cartão chamado Aurea+ 2 data 05/07/2026 por 450",
  ])(
    "delimits an authoritative card name before every supported payment-date clause: %s",
    (message) => {
      const decision = detectFinancialRoute(message, {
        ...context,
        knownCards: [{ id: "aurea", name: "Áurea+ 2" }],
      });
      expect(decision).toMatchObject({
        route: "mark_paid",
        paymentTarget: "card",
        cardKeyword: "Áurea+ 2",
        authoritativeCardName: "Aurea+ 2",
        amountCents: 45_000,
      });
    },
  );

  it("preserves the complete unknown authoritative name before a date clause", () => {
    expect(
      detectFinancialRoute(
        "Paguei o cartão chamado Aurea+ 2 Black data 05/07/2026",
        {
          ...context,
          knownCards: [{ id: "aurea", name: "Áurea+ 2" }],
        },
      ),
    ).toMatchObject({
      route: "mark_paid",
      paymentTarget: "card",
      cardKeyword: "Aurea+ 2 Black",
      authoritativeCardName: "Aurea+ 2 Black",
      amountCents: undefined,
    });
  });

  it.each([
    ["Paguei o cartão chamado Nubank.", ["Nubank"], "Nubank"],
    [
      "Paguei o cartão chamado Minha.Conta.",
      ["Minha.Conta", "Minha.Conta."],
      "Minha.Conta.",
    ],
  ])(
    "treats terminal prose punctuation separately from exact registered punctuation: %s",
    (message, registeredNames, expectedName) => {
      expect(
        detectFinancialRoute(message, {
          ...context,
          knownCards: registeredNames.map((name) => ({ id: name, name })),
        }),
      ).toMatchObject({
        route: "mark_paid",
        cardKeyword: expectedName,
        authoritativeCardName: expectedName,
        amountCents: undefined,
      });
    },
  );

  it.each([
    [
      "Paguei o aluguel",
      {
        intent: "mark_paid" as const,
        target: "obligation" as const,
        keyword: "Aluguel",
        settlementAccountKeyword: "Inter",
      },
    ],
    ["Paguei o aluguel", null],
    [
      "Fatura Nubank paga",
      {
        intent: "mark_paid" as const,
        target: "card" as const,
        keyword: "Nubank",
        settlementAccountKeyword: "Inter",
      },
    ],
    ["Fatura Nubank paga", null],
  ])(
    "never invents a settlement source from classifier output when the user names none: %s",
    (message, classified) => {
      const decision = detectFinancialRoute(message, context);
      expect(decision.route).toBe("mark_paid");
      expect(
        applyDeterministicPrecedence(decision, classified),
      ).not.toHaveProperty("settlementAccountKeyword");
    },
  );

  it("does not inherit a classifier settlement source for an unresolved existing payment", () => {
    const decision = detectFinancialRoute("Paguei a parcela do carro", context);
    expect(decision).toMatchObject({
      route: "ambiguous",
      reason: "unresolved_existing_payment",
    });
    expect(
      applyDeterministicPrecedence(decision, {
        intent: "mark_paid",
        target: "obligation",
        keyword: "Financiamento do carro",
        settlementAccountKeyword: "Inter",
      }),
    ).not.toHaveProperty("settlementAccountKeyword");
    expect(applyDeterministicPrecedence(decision, null)).toBeNull();
  });

  it.each(["Paguei escola", "Paguei escola pela conta"])(
    "rejects an AI-only settlement without deterministic target evidence: %s",
    (message) => {
      const decision = detectFinancialRoute(message, context);
      expect(decision.explicitPaymentLanguage).toBe(true);
      expect(
        applyDeterministicPrecedence(decision, {
          intent: "mark_paid",
          target: "obligation",
          keyword: "Escola",
          settlementAccountKeyword: "Itaú",
        }),
      ).toBeNull();
    },
  );

  it("keeps an explicitly sourced generic payment out of AI-only settlement", () => {
    const namedContext = {
      ...context,
      knownAccounts: [
        ...context.knownAccounts,
        { id: "itau-account", name: "Itaú" },
      ],
    };
    const decision = detectFinancialRoute(
      "Paguei escola pela conta Itaú",
      namedContext,
    );
    expect(
      applyDeterministicPrecedence(decision, {
        intent: "mark_paid",
        target: "obligation",
        keyword: "Escola",
        settlementAccountKeyword: "Inter",
      }),
    ).toBeNull();
  });

  it.each([
    ["Paguei escola no Pix 950", undefined],
    ["Paguei escola 950 no Pix", undefined],
    ["Paguei escola pela conta 950", undefined],
    ["Paguei escola pela conta Itaú 950", "Itaú"],
    ["Paguei escola 950 pela conta Itaú", "Itaú"],
    ["Paguei R$950 da escola pela conta Itaú", "Itaú"],
    ["Paguei 950 da escola no Pix", undefined],
    ["Paguei R$950 da escola", undefined],
  ])(
    "keeps a source-qualified school payment on the existing-payment path: %s",
    (message, settlementAccountKeyword) => {
      const namedContext = {
        ...context,
        knownAccounts: [
          ...context.knownAccounts,
          { id: "itau-account", name: "Itaú" },
        ],
      };
      const decision = detectFinancialRoute(message, namedContext);
      expect(decision).toMatchObject({
        explicitPaymentLanguage: true,
        description: "Escola",
        amountCents: 95_000,
      });
      const expected = {
        intent: "mark_paid" as const,
        target: "obligation" as const,
        keyword: "Escola",
        amountCents: 95_000,
        ...(settlementAccountKeyword === undefined
          ? {}
          : { settlementAccountKeyword }),
      };
      expect(applyDeterministicPrecedence(decision, null)).toEqual(expected);
      expect(
        applyDeterministicPrecedence(decision, {
          intent: "plain",
          expense: {
            description: "Compra errada",
            amountCents: 1,
            accountKeyword: "Inter",
          },
        }),
      ).toEqual(expected);
      expect(
        applyDeterministicPrecedence(decision, {
          intent: "mark_paid",
          target: "obligation",
          keyword: "Escola",
          amountCents: 1,
          settlementAccountKeyword: "Inter",
        }),
      ).toEqual(expected);
    },
  );

  it.each([
    null,
    {
      intent: "plain" as const,
      expense: {
        description: "Compra errada",
        amountCents: 1,
        accountKeyword: "Inter",
      },
    },
    {
      intent: "mark_paid" as const,
      target: "obligation" as const,
      keyword: "Alvo errado",
      amountCents: 1,
      settlementAccountKeyword: "Inter",
    },
  ])(
    "routes a grammatical amount-before-target payment without relying on obligation vocabulary: %#",
    (classified) => {
      const namedContext = {
        ...context,
        knownAccounts: [
          ...context.knownAccounts,
          { id: "itau-account", name: "Itaú" },
        ],
      };
      const decision = detectFinancialRoute(
        "Paguei R$950 da escola pela conta Itaú",
        namedContext,
      );
      expect(decision).toMatchObject({
        route: "ambiguous",
        reason: "unresolved_existing_payment",
        description: "Escola",
        amountCents: 95_000,
        paymentTarget: "obligation",
        settlementAccountKeyword: "Itaú",
      });
      expect(applyDeterministicPrecedence(decision, classified)).toEqual({
        intent: "mark_paid",
        target: "obligation",
        keyword: "Escola",
        amountCents: 95_000,
        settlementAccountKeyword: "Itaú",
      });
    },
  );

  it("keeps an ordinary verb-first merchant expense out of obligation settlement routing", () => {
    const decision = detectFinancialRoute("Paguei almoço 50", context);
    expect(decision.route).toBe("plain_account");
    expect(
      applyDeterministicPrecedence(decision, {
        intent: "mark_paid",
        target: "obligation",
        keyword: "Almoço",
        amountCents: 1,
      }),
    ).toMatchObject({
      intent: "plain",
      expense: { description: "Almoço", amountCents: 5_000 },
    });
  });

  it.each([
    null,
    {
      intent: "plain" as const,
      expense: {
        description: "Empréstimo Nubank",
        amountCents: 1,
        accountKeyword: "Nubank",
      },
    },
    {
      intent: "mark_paid" as const,
      target: "obligation" as const,
      keyword: "Empréstimo Nubank",
      amountCents: 1,
      settlementAccountKeyword: "Nubank",
    },
    {
      intent: "mark_paid" as const,
      target: "obligation" as const,
      keyword: "Escola",
      amountCents: 1,
      settlementAccountKeyword: "Nubank",
    },
  ])(
    "keeps an obligation target independent when its source account and a card share the same name: %#",
    (classified) => {
      const decision = detectFinancialRoute(
        "Paguei escola 500 pela conta Nubank",
        context,
      );
      expect(decision).toMatchObject({
        description: "Escola",
        amountCents: 50_000,
        paymentTarget: "obligation",
        settlementAccountKeyword: "Nubank",
      });
      expect(applyDeterministicPrecedence(decision, classified)).toEqual({
        intent: "mark_paid",
        target: "obligation",
        keyword: "Escola",
        amountCents: 50_000,
        settlementAccountKeyword: "Nubank",
      });
    },
  );

  it.each([
    [
      "Paguei Nubank PJ pela conta Nubank 2350",
      "Nubank PJ",
      "Nubank",
      "account-nubank",
    ],
    [
      "Paguei Nubank pela conta Nubank PJ 2350",
      "Nubank",
      "Nubank PJ",
      "account-nubank-pj",
    ],
  ])(
    "resolves the longest card only from the target side when target and source overlap: %s",
    (message, expectedCard, expectedAccount, expectedAccountId) => {
      const sharedProviderContext = {
        knownCards: [
          { id: "card-nubank", name: "Nubank" },
          { id: "card-nubank-pj", name: "Nubank PJ" },
        ],
        knownAccounts: [{ id: expectedAccountId, name: expectedAccount }],
      };
      const decision = detectFinancialRoute(message, sharedProviderContext);
      expect(decision).toMatchObject({
        route: "mark_paid",
        paymentTarget: "card",
        cardKeyword: expectedCard,
        settlementAccountKeyword: expectedAccount,
        amountCents: 235_000,
      });
      for (const classified of [
        null,
        {
          intent: "plain" as const,
          expense: {
            description: "Compra errada",
            amountCents: 1,
            cardKeyword: expectedAccount,
          },
        },
        {
          intent: "mark_paid" as const,
          target: "obligation" as const,
          keyword: "Errado",
          amountCents: 1,
          settlementAccountKeyword: expectedCard,
        },
      ]) {
        expect(applyDeterministicPrecedence(decision, classified)).toEqual({
          intent: "mark_paid",
          target: "card",
          keyword: expectedCard,
          amountCents: 235_000,
          settlementAccountKeyword: expectedAccount,
          authoritativeCardName: expectedCard,
        });
      }
    },
  );

  it("keeps duplicate same-provider cards unresolved after excluding the source span", () => {
    const decision = detectFinancialRoute(
      "Paguei a fatura Nubank pela conta Inter 2350",
      {
        knownCards: [
          { id: "card-nubank-1", name: "Nubank" },
          { id: "card-nubank-2", name: "Nubank" },
        ],
        knownAccounts: [{ id: "account-inter", name: "Inter" }],
      },
    );
    expect(decision).toMatchObject({
      route: "mark_paid",
      paymentTarget: "card",
      cardKeyword: undefined,
      settlementAccountKeyword: "Inter",
      amountCents: 235_000,
    });
  });

  it("keeps longest-card purchase routing independent of source-account masking", () => {
    expect(
      detectFinancialRoute("Notebook 1200 no Nubank PJ", {
        knownCards: [
          { id: "card-nubank", name: "Nubank" },
          { id: "card-nubank-pj", name: "Nubank PJ" },
        ],
        knownAccounts: [{ id: "account-nubank", name: "Nubank" }],
      }),
    ).toMatchObject({
      route: "single_credit",
      description: "Notebook",
      cardKeyword: "Nubank PJ",
      amountCents: 120_000,
    });
  });

  it("rejects an AI-only settlement when deterministic routing has no payment evidence", () => {
    const decision = detectFinancialRoute("escola", context);
    expect(decision.route).toBe("none");
    expect(
      applyDeterministicPrecedence(decision, {
        intent: "mark_paid",
        target: "obligation",
        keyword: "Escola",
        settlementAccountKeyword: "Itaú",
      }),
    ).toBeNull();
  });

  it.each([
    ["Paguei R$100 do mercado", undefined, "Mercado", 10_000],
    ["Paguei pela conta Itaú R$950 da escola", "Itaú", "Escola", 95_000],
    ["Paguei via Pix R$950 da escola", undefined, "Escola", 95_000],
    ["Paguei ontem via Pix R$950 da escola", undefined, "Escola", 95_000],
    ["Paguei via Pix ontem R$950 da escola", undefined, "Escola", 95_000],
    ["Paguei via Pix R$950 da escola ontem", undefined, "Escola", 95_000],
    ["Paguei dia 02/07 via Pix R$950 da escola", undefined, "Escola", 95_000],
    [
      "Paguei dia 05/08/2026 pela conta Itaú R$950 da escola",
      "Itaú",
      "Escola",
      95_000,
    ],
    [
      "Paguei pela conta Itaú R$950 da escola em 05/08/2026",
      "Itaú",
      "Escola",
      95_000,
    ],
    ["Paguei ontem pela conta Itaú R$950 da escola", "Itaú", "Escola", 95_000],
  ])(
    "keeps a generic amount-first payment behind an existing-obligation choice: %s",
    (message, settlementAccountKeyword, keyword, amountCents) => {
      const namedContext = {
        ...context,
        knownAccounts: [
          ...context.knownAccounts,
          { id: "itau-account", name: "Itaú" },
        ],
      };
      const decision = detectFinancialRoute(message, namedContext);
      expect(decision).toMatchObject({
        route: "ambiguous",
        reason: "unresolved_existing_payment",
        description: keyword,
        amountCents,
        paymentTarget: "obligation",
        ...(settlementAccountKeyword === undefined
          ? {}
          : { settlementAccountKeyword }),
      });
      expect(applyDeterministicPrecedence(decision, null)).toEqual({
        intent: "mark_paid",
        target: "obligation",
        keyword,
        amountCents,
        ...(settlementAccountKeyword === undefined
          ? {}
          : { settlementAccountKeyword }),
      });
    },
  );

  it("keeps a Pix merchant expense ordinary despite a wrong AI settlement", () => {
    const decision = detectFinancialRoute(
      "Paguei mercado 100 via Pix",
      context,
    );
    expect(decision.route).toBe("plain_account");
    expect(
      applyDeterministicPrecedence(decision, {
        intent: "mark_paid",
        target: "obligation",
        keyword: "Mercado",
        amountCents: 1,
      }),
    ).toMatchObject({
      intent: "plain",
      expense: { description: "Mercado", amountCents: 10_000 },
    });
  });

  it("never accepts an AI-only settlement for compact merchant text", () => {
    const decision = detectFinancialRoute("Paguei mercado100", context);
    const routed = applyDeterministicPrecedence(decision, {
      intent: "mark_paid",
      target: "obligation",
      keyword: "Mercado",
      amountCents: 10_000,
    });
    expect(routed?.intent).not.toBe("mark_paid");
  });
});

describe("authoritative registered-name metadata tails", () => {
  const namedContext = {
    knownCards: [
      { id: "card-nubank", name: "Nubank" },
      { id: "card-today", name: "Hoje" },
    ],
    knownAccounts: [
      { id: "acct-inter", name: "Inter" },
      { id: "acct-today", name: "Hoje" },
    ],
  };

  it.each([
    "Paguei o cartão chamado Nubank hoje Black",
    "Paguei o cartão chamado Nubank dia 05/07 Black",
    "Paguei o cartão chamado Nubank no dia 05/07 Black",
    "Paguei o cartão chamado Nubank data 05/07 Black",
    "Paguei o cartão chamado Nubank na data 05/07 Black",
    "Paguei o cartão chamado Nubank 05/07 Black",
    "Paguei o cartão chamado Nubank pela conta Inter hoje Black",
  ])(
    "preserves residue after a supported date as part of an unknown name: %s",
    (message) => {
      expect(detectFinancialRoute(message, namedContext)).toMatchObject({
        paymentTarget: "card",
        cardKeyword: expect.stringContaining("Black"),
        authoritativeCardName: expect.stringContaining("Black"),
        unambiguousKnownCardEvidence: undefined,
      });
    },
  );

  it.each([
    "dia 05/07/2026",
    "no dia 05/07/2026",
    "data 05/07/2026",
    "na data 05/07/2026",
    "05/07/2026",
  ])("accepts a complete supported occurrence-date tail: %s", (dateClause) => {
    expect(
      detectFinancialRoute(
        `Paguei o cartão chamado Nubank ${dateClause} por R$ 450`,
        namedContext,
      ),
    ).toMatchObject({
      route: "mark_paid",
      paymentTarget: "card",
      cardKeyword: "Nubank",
      authoritativeCardName: "Nubank",
      amountCents: 45_000,
      unambiguousKnownCardEvidence: true,
    });
  });
});

describe("amount-first obligation settlements and creation-account boundaries", () => {
  it.each([
    "Paguei aluguel em15/08 de2025",
    "Paguei aluguel no dia 15/08 do ano de 2025",
    "Paguei aluguel data 15/08 de 2025",
  ])("keeps a spoken full payment date out of the amount: %s", (message) => {
    expect(detectFinancialRoute(message, context)).toMatchObject({
      route: "mark_paid",
      paymentTarget: "obligation",
      description: "Aluguel",
      amountCents: undefined,
    });
  });

  it("preserves a separate explicit amount beside a spoken full payment date", () => {
    expect(
      detectFinancialRoute(
        "Paguei aluguel por R$ 1.100 em15/08 de2025",
        context,
      ),
    ).toMatchObject({
      route: "mark_paid",
      paymentTarget: "obligation",
      amountCents: 110_000,
    });
  });

  it.each([
    ["Paguei R$710 financiamento do carro", "Financiamento do carro"],
    ["Paguei R$710 parcela solar", "Parcela solar"],
  ])(
    "preserves a preposition-less explicit payment amount: %s",
    (message, description) => {
      const decision = detectFinancialRoute(message, context);
      expect(decision).toMatchObject({
        route: "mark_paid",
        paymentTarget: "obligation",
        description,
        amountCents: 71_000,
      });
    },
  );

  it("does not turn an ordinary amount-first merchant payment into an obligation settlement", () => {
    expect(
      detectFinancialRoute("Paguei R$75 mercado", context),
    ).not.toMatchObject({
      route: "mark_paid",
      paymentTarget: "obligation",
    });
  });

  it("does not use a registered account name merely because it is part of an obligation description", () => {
    const solarContext = {
      ...context,
      knownAccounts: [{ id: "solar-account", name: "Solar" }],
    };
    const implicit = detectFinancialRoute(
      "Parcela solar 710,44 72x",
      solarContext,
    );
    expect(implicit).toMatchObject({
      route: "none",
      accountKeyword: undefined,
      implicitKnownAccountEvidence: true,
    });
    expect(
      applyDeterministicPrecedence(implicit, {
        intent: "obligation",
        obligation: {
          description: "Parcela solar",
          monthlyAmountCents: 71_044,
          termMonths: 72,
          accountKeyword: "Solar",
        },
      }),
    ).toMatchObject({
      intent: "obligation",
      obligation: { accountKeyword: undefined },
    });

    const explicit = detectFinancialRoute(
      "Parcela solar 710,44 72x pela conta Solar",
      solarContext,
    );
    expect(
      applyDeterministicPrecedence(explicit, {
        intent: "obligation",
        obligation: {
          description: "Parcela solar",
          monthlyAmountCents: 71_044,
          termMonths: 72,
          accountKeyword: "Solar",
        },
      }),
    ).toMatchObject({
      intent: "obligation",
      obligation: { accountKeyword: "Solar" },
    });
  });
});

describe("explicit non-positive settlement amounts", () => {
  it.each([
    ["Paguei parcela 0 do financiamento do carro", "parcela 0"],
    ["Paguei parcela 0/12 do financiamento do carro", "parcela 0/12"],
    ["Paguei parcela zero do financiamento do carro", "parcela zero"],
    ["Paguei a parcela número 0 do financiamento do carro", "parcela número 0"],
    ["Paguei a 0ª parcela do financiamento do carro", "0ª"],
  ])(
    "terminally rejects an invalid zero installment ordinal before AI precedence: %s",
    (message, evidence) => {
      const decision = detectFinancialRoute(message, context);
      expect(decision).toMatchObject({
        route: "ambiguous",
        reason: "invalid_installment_ordinal",
        explicitInvalidPaymentOrdinal: evidence,
        amountCents: undefined,
        suppressAiPaymentAmount: true,
      });
      for (const classified of [
        null,
        {
          intent: "plain" as const,
          expense: { description: "Errado", amountCents: 10_000 },
        },
        {
          intent: "mark_paid" as const,
          target: "obligation" as const,
          keyword: "Financiamento do carro",
          amountCents: 10_000,
        },
      ]) {
        expect(applyDeterministicPrecedence(decision, classified)).toBeNull();
      }
    },
  );

  it.each([
    ["Paguei academia R$ 0 ontem pela conta Inter", "R$ 0"],
    ["Paguei academia 0 ontem pela conta Inter", "0"],
    ["Paguei aluguel no valor de 0 reais", "no valor de 0 reais"],
    ["Fatura Nubank paga por R$ -10 pela conta Inter", "-10"],
    [
      "Paguei a fatura do Nubank parcela -10 reais pela conta Inter",
      "-10 reais",
    ],
    ["Paguei parcela 0 reais do financiamento", "0 reais"],
  ])(
    "keeps invalid amount evidence terminal before AI precedence: %s",
    (message, evidence) => {
      const decision = detectFinancialRoute(message, context);
      expect(decision).toMatchObject({
        route: "ambiguous",
        reason: "invalid_payment_amount",
        explicitInvalidPaymentAmount: evidence,
        amountCents: undefined,
        suppressAiPaymentAmount: true,
      });
      for (const classified of [
        null,
        {
          intent: "plain" as const,
          expense: { description: "Errado", amountCents: 10_000 },
        },
        {
          intent: "mark_paid" as const,
          target: "obligation" as const,
          keyword: "Academia",
          amountCents: 10_000,
        },
      ]) {
        expect(applyDeterministicPrecedence(decision, classified)).toBeNull();
      }
    },
  );

  it.each(["Paguei academia ontem pela conta Inter", "Fatura Nubank paga"])(
    "continues treating an omitted settlement amount as scheduled/computed: %s",
    (message) => {
      expect(detectFinancialRoute(message, context)).toMatchObject({
        route: "mark_paid",
        amountCents: undefined,
      });
    },
  );

  it.each([
    "Paguei a parcela número 10 do financiamento",
    "Paguei a 10ª parcela do financiamento",
  ])("preserves a genuine installment ordinal: %s", (message) => {
    expect(detectFinancialRoute(message, context)).toMatchObject({
      route: "mark_paid",
      paymentTarget: "obligation",
      amountCents: undefined,
      suppressAiPaymentAmount: true,
    });
  });

  it.each([
    ["Paguei parcela 10 reais do financiamento", 1_000],
    ["Paguei +10 reais do financiamento do carro", 1_000],
    ["Paguei parcela +10 reais do financiamento do carro", 1_000],
    ["Paguei academia +10 reais ontem pela conta Inter", 1_000],
    ["Paguei academia por R$ +10", 1_000],
    ["Paguei a fatura do Nubank parcela R$ 10 pela conta Inter", 1_000],
  ])(
    "preserves a positive explicit payment amount: %s",
    (message, amountCents) => {
      const decision = detectFinancialRoute(message, context);
      expect(decision).toMatchObject({
        route: "mark_paid",
        amountCents,
      });
      if (message.includes("financiamento do carro")) {
        expect(decision.description).toBe("Financiamento do carro");
      }
      if (message.includes("academia")) {
        expect(decision.description).toBe("Academia");
        expect(decision.paymentTarget).toBe("obligation");
        for (const classified of [
          null,
          {
            intent: "plain" as const,
            expense: { description: "Errado", amountCents: 1 },
          },
        ]) {
          expect(
            applyDeterministicPrecedence(decision, classified),
          ).toMatchObject({
            intent: "mark_paid",
            target: "obligation",
            keyword: "Academia",
            amountCents: 1_000,
          });
        }
      }
    },
  );
});

describe("spoken installment counts cannot impersonate card names", () => {
  const countCardContext = {
    ...context,
    knownCards: [
      { id: "three-card", name: "Três" },
      { id: "nubank-card", name: "Nubank" },
    ],
  };

  it.each([
    ["a null classifier", null],
    [
      "a wrong classifier",
      {
        intent: "card_installment" as const,
        purchase: {
          description: "Errado",
          totalCents: 1,
          installmentCount: 2,
          cardKeyword: "Três",
        },
      },
    ],
  ])(
    "keeps a structural spoken count unresolved with %s",
    (_label, classified) => {
      const decision = detectFinancialRoute(
        "Notebook no cartão três vezes de 100",
        countCardContext,
      );

      expect(decision).toMatchObject({
        route: "installment",
        description: "Notebook",
        installmentCount: 3,
        perInstallmentCents: 10_000,
        totalCents: 30_000,
        cardKeyword: undefined,
      });
      expect(applyDeterministicPrecedence(decision, classified)).toMatchObject({
        intent: "card_installment",
        purchase: { cardKeyword: undefined },
      });
    },
  );

  it("still resolves the same card through the authoritative called-name syntax", () => {
    expect(
      detectFinancialRoute(
        "Notebook 300 no cartão chamado Três",
        countCardContext,
      ),
    ).toMatchObject({
      route: "single_credit",
      description: "Notebook",
      amountCents: 30_000,
      cardKeyword: "Três",
      authoritativeCardName: "Três",
    });
  });
});
