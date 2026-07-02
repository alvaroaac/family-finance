import { describe, it, expect, vi } from "vitest";

import type { AiCompletionClient } from "@family-finance/categorization";

import { createTextInterpreter } from "./interpret.js";

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
