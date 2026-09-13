import { normalizeMerchantKey } from "@family-finance/categorization";

export type GroupableRow = {
  description: string;
  occurredOn: string;
  amount: { cents: number };
  kind: "expense" | "income";
};
export type MerchantGroup = {
  key: string;
  label: string;
  indices: number[];
  totalCents: number;
  firstDate: string;
  lastDate: string;
  /** Distinct occurrence dates — decides "07 e 19 ago" vs "03 a 29 ago". */
  dateCount: number;
};

export function buildMerchantGroups(
  rows: GroupableRow[],
  descriptionOverrides?: Record<number, string>,
): MerchantGroup[] {
  const groups = new Map<string, MerchantGroup>();
  rows.forEach((row, index) => {
    const description = (
      descriptionOverrides?.[index] ?? row.description
    ).trim();
    const key =
      normalizeMerchantKey(description) || description.toUpperCase() || "—";
    const label = description || "Sem descrição";
    const amount =
      row.kind === "expense" ? row.amount.cents : -row.amount.cents;
    const group = groups.get(key);
    if (!group) {
      groups.set(key, {
        key,
        label,
        indices: [index],
        totalCents: amount,
        firstDate: row.occurredOn,
        lastDate: row.occurredOn,
        dateCount: 1,
      });
      return;
    }
    group.indices.push(index);
    group.totalCents += amount;
    if (
      !group.indices.some(
        (other) => other !== index && rows[other]!.occurredOn === row.occurredOn,
      )
    )
      group.dateCount += 1;
    if (label.length < group.label.length) group.label = label;
    if (row.occurredOn < group.firstDate) group.firstDate = row.occurredOn;
    if (row.occurredOn > group.lastDate) group.lastDate = row.occurredOn;
  });
  return [...groups.values()];
}

export type GroupOrderInput = {
  group: MerchantGroup;
  uncategorizedSelected: number;
};

export function orderMerchantGroups(
  groups: GroupOrderInput[],
): MerchantGroup[] {
  return [...groups]
    .sort(
      (a, b) =>
        Number(b.uncategorizedSelected > 0) -
          Number(a.uncategorizedSelected > 0) ||
        b.group.indices.length - a.group.indices.length ||
        a.group.label.localeCompare(b.group.label, "pt-BR"),
    )
    .map(({ group }) => group);
}

export type PreviewFilter =
  | "all"
  | "uncategorized"
  | "duplicates"
  | "installments";

function foldSearch(value: string): string {
  return value.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

export function filterGroups(
  groups: MerchantGroup[],
  opts: {
    filter: PreviewFilter;
    search: string;
    isUncategorized: (i: number) => boolean;
    isDuplicate: (i: number) => boolean;
    isInstallment: (i: number) => boolean;
  },
): MerchantGroup[] {
  const predicates = {
    uncategorized: opts.isUncategorized,
    duplicates: opts.isDuplicate,
    installments: opts.isInstallment,
  };
  const search = foldSearch(opts.search);
  return groups.filter(
    (group) =>
      (opts.filter === "all" || group.indices.some(predicates[opts.filter])) &&
      (foldSearch(group.label).includes(search) ||
        foldSearch(group.key).includes(search)),
  );
}

const months = [
  "jan",
  "fev",
  "mar",
  "abr",
  "mai",
  "jun",
  "jul",
  "ago",
  "set",
  "out",
  "nov",
  "dez",
];
function day(date: string): string {
  return date.slice(8, 10);
}
function month(date: string): string {
  return months[Number(date.slice(5, 7)) - 1]!;
}
function shortDate(date: string): string {
  return `${day(date)} ${month(date)}`;
}
function sameMonth(a: string, b: string): boolean {
  return a.slice(0, 7) === b.slice(0, 7);
}

export function formatGroupDates(
  firstDate: string,
  lastDate: string,
  dateCount: number,
): string {
  if (firstDate === lastDate) return shortDate(firstDate);
  if (sameMonth(firstDate, lastDate))
    return `${day(firstDate)} ${dateCount > 2 ? "a" : "e"} ${shortDate(lastDate)}`;
  return `${shortDate(firstDate)} a ${shortDate(lastDate)}`;
}

export function formatPeriod(rows: { occurredOn: string }[]): string {
  if (!rows.length) return "";
  let first = rows[0]!.occurredOn;
  let last = first;
  for (const { occurredOn } of rows) {
    if (occurredOn < first) first = occurredOn;
    if (occurredOn > last) last = occurredOn;
  }
  if (first === last) return shortDate(first);
  return `${sameMonth(first, last) ? day(first) : shortDate(first)} – ${shortDate(last)}`;
}

export function countLabel(
  n: number,
  singular: string,
  plural: string,
): string {
  return `${n} ${n === 1 ? singular : plural}`;
}
