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
  });

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
      accountKeyword: "Pix",
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
        accountKeyword: "Pix",
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
        accountKeyword: "Pix",
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

  it.each([3, 13, 24, 50])(
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

  it.each([3, 13, 24, 50])(
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
  ])("does not treat a contextual short occurrence date as a bill month: %s", (message) => {
    expect(detectFinancialRoute(message, context)).toMatchObject({
      route: "mark_paid",
      paymentTarget: "card",
      billMonth: undefined,
      amountCents: undefined,
      suppressAiPaymentAmount: true,
    });
  });

  it.each([
    "Paguei a fatura Nubank de 07/26",
    "Paguei a fatura Nubank 07/26",
  ])("retains a standalone short-year bill month: %s", (message) => {
    expect(detectFinancialRoute(message, context)).toMatchObject({
      route: "mark_paid",
      paymentTarget: "card",
      billMonth: "2026-07",
      amountCents: undefined,
      suppressAiPaymentAmount: true,
    });
  });

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
  ])("keeps an explicitly monetary year-like value: %s", (message, amountCents) => {
    expect(detectFinancialRoute(message, context)).toMatchObject({
      route: "plain_account",
      description: "IPTU",
      amountCents,
    });
  });

  it.each([
    "Paguei almoço 75 no débito",
    "Comprei o almoço 75 no débito",
    "Gastei com o almoço 75 no débito",
    "Passei um almoço 75 no débito",
  ])("strips a leading transaction verb from plain descriptions: %s", (message) => {
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
  });

  it("preserves product model numbers while stripping a transaction verb", () => {
    expect(
      detectFinancialRoute("Comprei um iPhone 15 Pro R$ 5000 no débito", context),
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
      detectFinancialRoute("Notebook 12 parcelas modelo 300 no Nubank", context),
    ).toMatchObject({
      route: "installment",
      perInstallmentCents: undefined,
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
  ])("keeps merchant wording outside card-settlement grammar: %s", (message) => {
    expect(detectFinancialRoute(message, context)).toMatchObject({
      route: "single_credit",
      cardKeyword: "Nubank",
    });
  });

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
        accountKeyword: "Pix",
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
          accountKeyword: "Pix",
        },
      });
    },
  );

  it("preserves the existing terse Pix expense contract", () => {
    expect(detectFinancialRoute("Posto Marcio 200 pix", context)).toMatchObject({
      route: "plain_account",
      description: "Posto Marcio",
      amountCents: 20_000,
      accountKeyword: "Pix",
    });
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
    const decision = detectFinancialRoute(
      "Paguei Nubank pela conta Itaú R$ 2350",
      context,
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
        settlementAccountKeyword: "Pix",
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
        settlementAccountKeyword: "Pix",
      });
      expect(applyDeterministicPrecedence(decision, null)).toMatchObject({
        intent: "mark_paid",
        target: "obligation",
        keyword,
        amountCents,
        settlementAccountKeyword: "Pix",
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
  ])("keeps card-first merchant descriptions out of settlement: %s", (message) => {
    expect(detectFinancialRoute(message, context)).toMatchObject({
      route: "single_credit",
      cardKeyword: "Nubank",
    });
  });

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
        accountKeyword: "Pix",
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
        expense: { description, amountCents, accountKeyword: "Pix" },
      });
    },
  );

  it("keeps a single amount before Pix authoritative", () => {
    expect(detectFinancialRoute("Posto Marcio 200 pix", context)).toMatchObject({
      route: "plain_account",
      description: "Posto Marcio",
      amountCents: 20_000,
      accountKeyword: "Pix",
    });
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

  it("preserves Pix or AI/default account context for obligation creation", () => {
    const pix = detectFinancialRoute(
      "Aluguel 1500 todo mês no Pix",
      context,
    );
    expect(applyDeterministicPrecedence(pix, null)).toMatchObject({
      intent: "obligation",
      obligation: { accountKeyword: "Pix" },
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

  it("uses Pix as the settlement source when no named account exists", () => {
    expect(
      detectFinancialRoute("Paguei aluguel via Pix R$ 1500", context),
    ).toMatchObject({
      route: "mark_paid",
      settlementAccountKeyword: "Pix",
    });
  });
});
