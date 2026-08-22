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
});
