import { describe, it, expect } from "vitest";
import { derivePendencias, blockedDialogCopy } from "./confirm-blockers";

const ready = {
  destinationMissing: false,
  comparisonFailed: false,
  comparisonPending: false,
  selectedCount: 1,
  pendingInstallmentReviews: 0,
  uncategorized: [],
};

describe("confirmation blockers", () => {
  it("returns no pending items when ready", () => {
    expect(derivePendencias(ready)).toEqual([]);
  });
  it("returns all applicable items in order with exact copy and severity", () => {
    expect(
      derivePendencias({
        destinationMissing: true,
        comparisonFailed: true,
        comparisonPending: true,
        selectedCount: 0,
        pendingInstallmentReviews: 1,
        uncategorized: [
          { label: "IFOOD", count: 2 },
          { label: "99APP", count: 1 },
        ],
      }),
    ).toEqual([
      {
        id: "destination",
        hard: true,
        title: "Conta ou cartão de destino não escolhido",
        detail: "Onde esses lançamentos entram",
        action: "Escolher",
      },
      {
        id: "comparison-failed",
        hard: true,
        title: "Comparação com o banco falhou",
        detail: "Sem ela, não dá pra saber o que já existe",
        action: "Tentar de novo",
      },
      {
        id: "comparison-pending",
        hard: true,
        title: "Comparação com o banco ainda rodando",
        detail: "Só um instante, estamos vendo o que já existe",
        action: "Aguardar",
      },
      {
        id: "nothing-selected",
        hard: true,
        title: "Nenhum lançamento marcado",
        detail: "Marca pelo menos um pra gravar",
        action: "Ver lista",
      },
      {
        id: "installment-review",
        hard: true,
        title: "Parcelamentos sem decisão",
        detail: "1 grupo parecido com um já existente",
        action: "Comparar",
      },
      {
        id: "uncategorized",
        hard: false,
        title: "Lançamentos sem categoria",
        detail: "IFOOD ×2, 99APP ×1",
        action: "Ver",
      },
    ]);
  });
  it("pluralizes installment groups and truncates merchant labels without mutating input", () => {
    const uncategorized = ["A", "B", "C", "D", "E"].map((label) => ({
      label,
      count: 2,
    }));
    const input = { ...ready, pendingInstallmentReviews: 3, uncategorized };
    const before = structuredClone(input);
    expect(derivePendencias(input).map(({ detail }) => detail)).toEqual([
      "3 grupos parecidos com já existentes",
      "A ×2, B ×2, C ×2 e mais 2",
    ]);
    expect(input).toEqual(before);
    expect(
      derivePendencias({
        ...ready,
        uncategorized: uncategorized.slice(0, 3),
      })[0]!.detail,
    ).toBe("A ×2, B ×2, C ×2");
  });
  it("counts hard items only and handles a single selected row", () => {
    const pending = derivePendencias({
      ...ready,
      destinationMissing: true,
      uncategorized: [{ label: "A", count: 1 }],
    });
    expect(blockedDialogCopy(pending, 1)).toEqual({
      title: "Ainda não dá pra gravar",
      lead: "Falta 1 coisa antes de gravar o 1 lançamento",
      primary: "resolve",
    });
    expect(
      blockedDialogCopy(
        [...pending, ...derivePendencias({ ...ready, comparisonFailed: true })],
        7,
      ),
    ).toEqual({
      title: "Ainda não dá pra gravar",
      lead: "Faltam 2 coisas antes de gravar os 7 lançamentos",
      primary: "resolve",
    });
  });
  it.each([
    [1, "1 lançamento vai"],
    [7, "7 lançamentos vão"],
  ])("formats soft confirmation for %s", (count, prefix) => {
    const pending = derivePendencias({
      ...ready,
      uncategorized: [{ label: "A", count }],
    });
    expect(blockedDialogCopy(pending, count)).toEqual({
      title: "Gravar sem categoria?",
      lead: `${prefix} entrar sem categoria. Dá pra categorizar depois na lista de lançamentos.`,
      primary: "confirm-anyway",
    });
  });
});
