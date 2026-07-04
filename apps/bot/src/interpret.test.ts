import { describe, it, expect, vi } from "vitest";

import type { AiCompletionClient } from "@family-finance/categorization";

import {
  createTextInterpreter,
  createMessageClassifier,
} from "./interpret.js";

const TODAY = "2026-06-22";

function clientReplying(reply: string | null): AiCompletionClient & {
  complete: ReturnType<typeof vi.fn>;
} {
  return { complete: vi.fn(async () => reply) };
}

describe("createTextInterpreter", () => {
  it("maps a strict JSON reply into an InterpretedExpense (snake_case -> camelCase)", async () => {
    const client = clientReplying(
      JSON.stringify({
        amount_cents: 4590,
        description: "Mercadinho da esquina",
        occurred_on: "2026-06-21",
        category_hint: "Alimentação",
        responsible_hint: "Karol",
      }),
    );
    const interpret = createTextInterpreter(client);

    const result = await interpret("gastei uma nota no mercadinho ontem", {
      today: TODAY,
    });

    expect(result).toEqual({
      amountCents: 4590,
      description: "Mercadinho da esquina",
      occurredOn: "2026-06-21",
      categoryHint: "Alimentação",
      responsibleHint: "Karol",
    });
  });

  it("sends a pt-BR prompt containing the user text and today's date", async () => {
    const client = clientReplying(
      JSON.stringify({ amount_cents: 1000, description: "Padaria" }),
    );
    const interpret = createTextInterpreter(client);

    await interpret("comprei pão na padaria", { today: TODAY });

    expect(client.complete).toHaveBeenCalledTimes(1);
    const prompt = client.complete.mock.calls[0]?.[0] as string;
    expect(prompt).toContain("comprei pão na padaria");
    expect(prompt).toContain(TODAY);
    expect(prompt).toContain("amount_cents");
    // pt-BR instructions (warm household bot speaks Portuguese to the model too).
    expect(prompt).toMatch(/JSON/);
    // description must be JUST the merchant/service, not "Gasto X valor".
    expect(prompt).toMatch(/estabelecimento|serviço/i);
    expect(prompt).toMatch(/"gasto"/i);
  });

  it("accepts optional fields as absent or null", async () => {
    const client = clientReplying(
      JSON.stringify({
        amount_cents: 2000,
        description: "Farmácia",
        occurred_on: null,
        category_hint: null,
        responsible_hint: null,
      }),
    );
    const interpret = createTextInterpreter(client);

    const result = await interpret("farmácia vinte pila", { today: TODAY });

    expect(result).toEqual({ amountCents: 2000, description: "Farmácia" });
  });

  it("extracts the JSON object even when the model wraps it in prose", async () => {
    const client = clientReplying(
      'Claro! Aqui está: {"amount_cents": 3200, "description": "Uber"} — espero ter ajudado.',
    );
    const interpret = createTextInterpreter(client);

    const result = await interpret("corrida de uber", { today: TODAY });

    expect(result).toEqual({ amountCents: 3200, description: "Uber" });
  });

  it("returns null when the model abstains (client returns null)", async () => {
    const interpret = createTextInterpreter(clientReplying(null));
    expect(await interpret("oi", { today: TODAY })).toBeNull();
  });

  it('returns null when the model replies "null"', async () => {
    const interpret = createTextInterpreter(clientReplying("null"));
    expect(await interpret("bom dia!", { today: TODAY })).toBeNull();
  });

  it("returns null on malformed JSON", async () => {
    const interpret = createTextInterpreter(
      clientReplying('{"amount_cents": 32,, "description": }'),
    );
    expect(await interpret("uber 32", { today: TODAY })).toBeNull();
  });

  it("returns null when the JSON does not match the schema", async () => {
    const interpret = createTextInterpreter(
      clientReplying(
        JSON.stringify({ amount_cents: "32 reais", description: "Uber" }),
      ),
    );
    expect(await interpret("uber", { today: TODAY })).toBeNull();
  });

  it("returns null when the description is missing", async () => {
    const interpret = createTextInterpreter(
      clientReplying(JSON.stringify({ amount_cents: 3200 })),
    );
    expect(await interpret("32", { today: TODAY })).toBeNull();
  });

  it("returns null when occurred_on is not an ISO date", async () => {
    const interpret = createTextInterpreter(
      clientReplying(
        JSON.stringify({
          amount_cents: 3200,
          description: "Uber",
          occurred_on: "ontem",
        }),
      ),
    );
    expect(await interpret("uber ontem", { today: TODAY })).toBeNull();
  });

  it("returns null when the amount is zero or negative", async () => {
    const interpret = createTextInterpreter(
      clientReplying(JSON.stringify({ amount_cents: -100, description: "X" })),
    );
    expect(await interpret("estorno", { today: TODAY })).toBeNull();
  });

  it("returns null when the client throws (API failure never breaks the flow)", async () => {
    const client: AiCompletionClient = {
      complete: async () => {
        throw new Error("network down");
      },
    };
    const interpret = createTextInterpreter(client);
    expect(await interpret("uber 32", { today: TODAY })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Unified intent classifier (recurring-obligations design: one shared
// classifier for plain / obligation / card_installment / mark_paid).
// ---------------------------------------------------------------------------

describe("createMessageClassifier", () => {
  const TODAY_JUL = "2026-07-03";

  it("classifies a plain expense and carries the expense fields", async () => {
    const client = clientReplying(
      JSON.stringify({
        intent: "plain",
        expense: {
          amount_cents: 23000,
          description: "Mercado",
          occurred_on: null,
          category_hint: "Alimentação",
          responsible_hint: null,
        },
      }),
    );
    const classify = createMessageClassifier(client);
    const result = await classify("mercado 230", { today: TODAY_JUL });
    expect(result).toEqual({
      intent: "plain",
      expense: {
        amountCents: 23000,
        description: "Mercado",
        categoryHint: "Alimentação",
      },
    });
  });

  it("classifies the solar financing (per-month wording) as an obligation", async () => {
    const client = clientReplying(
      JSON.stringify({
        intent: "obligation",
        obligation: {
          description: "Parcela solar",
          monthly_amount_cents: 71044,
          term_months: 72,
          start_month: "2026-10",
          due_day: 5,
          category_hint: null,
          responsible_hint: null,
        },
      }),
    );
    const classify = createMessageClassifier(client);
    const result = await classify(
      "Parcela solar 710,44 72x a partir de 05/10",
      { today: TODAY_JUL },
    );
    expect(result).toEqual({
      intent: "obligation",
      obligation: {
        description: "Parcela solar",
        monthlyAmountCents: 71044,
        termMonths: 72,
        startMonth: "2026-10",
        dueDay: 5,
      },
    });
  });

  it("accepts an indefinite obligation (no term, no start)", async () => {
    const client = clientReplying(
      JSON.stringify({
        intent: "obligation",
        obligation: {
          description: "Aluguel",
          monthly_amount_cents: 120000,
          term_months: null,
          start_month: null,
          due_day: 10,
          category_hint: "Moradia",
          responsible_hint: null,
        },
      }),
    );
    const classify = createMessageClassifier(client);
    const result = await classify("aluguel 1200 todo mês dia 10", {
      today: TODAY_JUL,
    });
    expect(result).toEqual({
      intent: "obligation",
      obligation: {
        description: "Aluguel",
        monthlyAmountCents: 120000,
        dueDay: 10,
        categoryHint: "Moradia",
      },
    });
  });

  it("classifies a card installment (deferred to PR-2)", async () => {
    const client = clientReplying(
      JSON.stringify({ intent: "card_installment" }),
    );
    const classify = createMessageClassifier(client);
    expect(
      await classify("notebook 3600 em 12x no nubank", { today: TODAY_JUL }),
    ).toEqual({ intent: "card_installment" });
  });

  it("classifies mark_paid with obligation and card targets", async () => {
    const obligationClient = clientReplying(
      JSON.stringify({
        intent: "mark_paid",
        target: "obligation",
        keyword: "placa solar",
      }),
    );
    expect(
      await createMessageClassifier(obligationClient)("placa solar pago", {
        today: TODAY_JUL,
      }),
    ).toEqual({ intent: "mark_paid", target: "obligation", keyword: "placa solar" });

    const cardClient = clientReplying(
      JSON.stringify({ intent: "mark_paid", target: "card", keyword: "nubank" }),
    );
    expect(
      await createMessageClassifier(cardClient)("nubank pago", {
        today: TODAY_JUL,
      }),
    ).toEqual({ intent: "mark_paid", target: "card", keyword: "nubank" });
  });

  it("builds a prompt naming the four intents, the rules and today", async () => {
    const client = clientReplying(JSON.stringify({ intent: "card_installment" }));
    const classify = createMessageClassifier(client);
    await classify("qualquer coisa", { today: TODAY_JUL });
    const prompt = client.complete.mock.calls[0]?.[0] as string;
    expect(prompt).toContain("plain");
    expect(prompt).toContain("obligation");
    expect(prompt).toContain("card_installment");
    expect(prompt).toContain("mark_paid");
    expect(prompt).toContain(TODAY_JUL);
    // Per-month vs total disambiguation must be spelled out for the model.
    expect(prompt).toMatch(/72x/);
  });

  it("returns null on abstention, junk, or schema mismatch", async () => {
    const cases: Array<string | null> = [
      null,
      "sem json aqui",
      JSON.stringify({ intent: "unknown" }),
      JSON.stringify({ intent: "mark_paid", target: "boleto", keyword: "x" }),
      JSON.stringify({ intent: "obligation" }), // missing obligation payload
      "{ quebrado",
    ];
    for (const reply of cases) {
      const classify = createMessageClassifier(clientReplying(reply));
      expect(await classify("qualquer", { today: TODAY_JUL })).toBeNull();
    }
  });

  it("returns null when the client throws", async () => {
    const client: AiCompletionClient = {
      complete: async () => {
        throw new Error("boom");
      },
    };
    const classify = createMessageClassifier(client);
    expect(await classify("mercado 230", { today: TODAY_JUL })).toBeNull();
  });
});
