export type Pendencia = {
  id:
    | "destination"
    | "comparison-failed"
    | "comparison-pending"
    | "nothing-selected"
    | "installment-review"
    | "uncategorized";
  hard: boolean;
  title: string;
  detail: string;
  action: string;
};

export function derivePendencias(input: {
  destinationMissing: boolean;
  comparisonFailed: boolean;
  comparisonPending: boolean;
  selectedCount: number;
  pendingInstallmentReviews: number;
  uncategorized: { label: string; count: number }[];
}): Pendencia[] {
  const result: Pendencia[] = [];
  if (input.destinationMissing)
    result.push({
      id: "destination",
      hard: true,
      title: "Conta ou cartão de destino não escolhido",
      detail: "Onde esses lançamentos entram",
      action: "Escolher",
    });
  if (input.comparisonFailed)
    result.push({
      id: "comparison-failed",
      hard: true,
      title: "Comparação com o banco falhou",
      detail: "Sem ela, não dá pra saber o que já existe",
      action: "Tentar de novo",
    });
  if (input.comparisonPending)
    result.push({
      id: "comparison-pending",
      hard: true,
      title: "Comparação com o banco ainda rodando",
      detail: "Só um instante, estamos vendo o que já existe",
      action: "Aguardar",
    });
  if (input.selectedCount === 0)
    result.push({
      id: "nothing-selected",
      hard: true,
      title: "Nenhum lançamento marcado",
      detail: "Marca pelo menos um pra gravar",
      action: "Ver lista",
    });
  const count = input.pendingInstallmentReviews;
  if (count > 0)
    result.push({
      id: "installment-review",
      hard: true,
      title: "Parcelamentos sem decisão",
      detail:
        count === 1
          ? "1 grupo parecido com um já existente"
          : `${count} grupos parecidos com já existentes`,
      action: "Comparar",
    });
  if (input.uncategorized.length > 0)
    result.push({
      id: "uncategorized",
      hard: false,
      title: "Lançamentos sem categoria",
      detail:
        input.uncategorized
          .slice(0, 3)
          .map(({ label, count }) => `${label} ×${count}`)
          .join(", ") +
        (input.uncategorized.length > 3
          ? ` e mais ${input.uncategorized.length - 3}`
          : ""),
      action: "Ver",
    });
  return result;
}

export function blockedDialogCopy(
  pendencias: Pendencia[],
  selectedCount: number,
): {
  title: string;
  lead: string;
  primary: "resolve" | "confirm-anyway";
} {
  const hardCount = pendencias.filter(({ hard }) => hard).length;
  if (hardCount > 0)
    return {
      title: "Ainda não dá pra gravar",
      lead: `${hardCount === 1 ? "Falta 1 coisa" : `Faltam ${hardCount} coisas`} antes de gravar ${selectedCount === 1 ? "o 1 lançamento" : `os ${selectedCount} lançamentos`}`,
      primary: "resolve",
    };
  return {
    title: "Gravar sem categoria?",
    lead: `${selectedCount === 1 ? "1 lançamento vai" : `${selectedCount} lançamentos vão`} entrar sem categoria. Dá pra categorizar depois na lista de lançamentos.`,
    primary: "confirm-anyway",
  };
}
