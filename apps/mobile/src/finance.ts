/** Pure prototype model. Integer cents; never writes to the household ledger. */
export type Entry = {
  id: string;
  description: string;
  amountCents: number;
  kind: "expense" | "income";
  category: string;
  payment: string;
  date: string;
};
export type Assumption = {
  id: string;
  description: string;
  amountCents: number;
  kind: "expense" | "income";
  start: number;
  months: number;
  enabled: boolean;
};
export type Snapshot = {
  asOf: string;
  openingCashCents: number;
  months: { label: string; incomeCents: number; outflowCents: number }[];
};
export const categories = [
  "Alimentação",
  "Transporte",
  "Moradia",
  "Saúde",
  "Lazer",
  "Compras",
  "Receitas",
  "Outros",
];
export const payments = ["Conta principal", "Nubank", "Mercado Pago"];
export const demoDate = "2026-09-05";
export const seedEntries: Entry[] = [
  {
    id: "1",
    description: "Giassi",
    amountCents: 18642,
    kind: "expense",
    category: "Alimentação",
    payment: "Nubank",
    date: demoDate,
  },
  {
    id: "2",
    description: "Café da esquina",
    amountCents: 2850,
    kind: "expense",
    category: "Alimentação",
    payment: "Conta principal",
    date: demoDate,
  },
  {
    id: "3",
    description: "Uber",
    amountCents: 2490,
    kind: "expense",
    category: "Transporte",
    payment: "Nubank",
    date: "2026-09-04",
  },
  {
    id: "4",
    description: "Salário",
    amountCents: 850000,
    kind: "income",
    category: "Receitas",
    payment: "Conta principal",
    date: "2026-09-04",
  },
  {
    id: "5",
    description: "Supermercado",
    amountCents: 32470,
    kind: "expense",
    category: "Alimentação",
    payment: "Mercado Pago",
    date: "2026-09-03",
  },
  {
    id: "6",
    description: "Internet",
    amountCents: 12990,
    kind: "expense",
    category: "Moradia",
    payment: "Conta principal",
    date: "2026-09-02",
  },
  {
    id: "7",
    description: "Cinema",
    amountCents: 7800,
    kind: "expense",
    category: "Lazer",
    payment: "Nubank",
    date: "2026-09-01",
  },
];
// This snapshot is cash AFTER seedEntries, with future payments only.
export const demoSnapshot: Snapshot = {
  asOf: demoDate,
  openingCashCents: 1248000,
  months: [
    { label: "Set", incomeCents: 350000, outflowCents: 423000 },
    { label: "Out", incomeCents: 1200000, outflowCents: 1060000 },
    { label: "Nov", incomeCents: 1200000, outflowCents: 1040000 },
    { label: "Dez", incomeCents: 1200000, outflowCents: 1090000 },
    { label: "Jan", incomeCents: 1200000, outflowCents: 1060000 },
    { label: "Fev", incomeCents: 1200000, outflowCents: 1010000 },
  ],
};
export function money(cents: number) {
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
  }).format(cents / 100);
}
export function parseMoney(text: string): number | null {
  const clean = text.trim().replace(/^R\$\s*/, "");
  if (!/^(?:\d{1,3}(?:\.\d{3})+|\d+)(?:,\d{1,2})?$/.test(clean)) return null;
  const [whole, fraction = ""] = clean.replace(/\./g, "").split(",");
  const value = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  return Number.isSafeInteger(value) && value > 0 && value <= 10000000000
    ? value
    : null;
}
export function parseQuickEntry(text: string): Partial<Entry> {
  const normalized = text
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
  const match = text.match(/(?:R\$\s*)?\d+(?:\.\d{3})*(?:,\d{1,2})?/);
  const amountCents = match ? parseMoney(match[0]) : null;
  const kind = /salario|recebi|receita|freela/.test(normalized)
    ? "income"
    : "expense";
  const category =
    kind === "income"
      ? "Receitas"
      : /giassi|mercado(?! pago| livre)|cafe|padaria|restaurante/.test(
            normalized,
          )
        ? "Alimentação"
        : /uber|gasolina|posto/.test(normalized)
          ? "Transporte"
          : /internet|aluguel|energia/.test(normalized)
            ? "Moradia"
            : /farmacia|medico/.test(normalized)
              ? "Saúde"
              : /cinema|netflix/.test(normalized)
                ? "Lazer"
                : "Outros";
  const payment = /nubank/.test(normalized)
    ? "Nubank"
    : /mercado pago/.test(normalized)
      ? "Mercado Pago"
      : "Conta principal";
  const description = text
    .replace(match?.[0] ?? "\u0000", "")
    .replace(/\b(no|na|com|pelo|usando)\s+(nubank|mercado pago|pix)\b/gi, "")
    .replace(/\b(hoje|ontem)\b/gi, "")
    .trim();
  return {
    description,
    ...(amountCents ? { amountCents } : {}),
    category,
    payment,
    kind,
    date: /ontem/.test(normalized) ? "2026-09-04" : demoDate,
  };
}
export function project(
  snapshot: Snapshot,
  assumptions: readonly Assumption[],
) {
  let baseline = snapshot.openingCashCents;
  let simulated = baseline;
  return snapshot.months.map((month, index) => {
    baseline += month.incomeCents - month.outflowCents;
    const delta = assumptions.reduce(
      (sum, a) =>
        sum +
        (a.enabled && index >= a.start && index < a.start + a.months
          ? (a.kind === "income" ? 1 : -1) * a.amountCents
          : 0),
      0,
    );
    simulated += month.incomeCents - month.outflowCents + delta;
    return {
      label: month.label,
      baseline,
      simulated,
      delta: simulated - baseline,
    };
  });
}
export function snapshotWithEntries(entries: readonly Entry[]): Snapshot {
  const added = entries.filter(
    (e) => !seedEntries.some((seed) => seed.id === e.id),
  );
  const cashDelta = added.reduce(
    (sum, e) =>
      sum +
      (e.payment === "Conta principal"
        ? e.kind === "income"
          ? e.amountCents
          : -e.amountCents
        : 0),
    0,
  );
  const cardDelta = added.reduce(
    (sum, e) =>
      sum +
      (e.payment !== "Conta principal" && e.kind === "expense"
        ? e.amountCents
        : 0),
    0,
  );
  return {
    ...demoSnapshot,
    openingCashCents: demoSnapshot.openingCashCents + cashDelta,
    months: demoSnapshot.months.map((m, i) => ({
      ...m,
      outflowCents: m.outflowCents + (i === 0 ? cardDelta : 0),
    })),
  };
}
export function totals(entries: readonly Entry[]) {
  return entries.reduce(
    (t, e) => ({
      income: t.income + (e.kind === "income" ? e.amountCents : 0),
      expense: t.expense + (e.kind === "expense" ? e.amountCents : 0),
    }),
    { income: 0, expense: 0 },
  );
}
