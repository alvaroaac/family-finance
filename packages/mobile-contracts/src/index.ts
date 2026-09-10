import { z } from "zod";
export const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Informe uma data válida.")
  .refine(
    (s) =>
      !Number.isNaN(Date.parse(s)) &&
      new Date(s).toISOString().slice(0, 10) === s,
    "Data inválida",
  );
export const monthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
export const entrySchema = z
  .object({
    id: z.string().uuid(),
    description: z
      .string()
      .trim()
      .min(1, "Descreva este movimento.")
      .max(200, "Use até 200 caracteres na descrição."),
    amountCents: z
      .number({ invalid_type_error: "Informe um valor válido." })
      .int("Informe um valor válido.")
      .positive("Informe um valor maior que zero.")
      .max(1e10, "O valor ultrapassa o limite permitido."),
    kind: z.enum(["expense", "income"]),
    date: dateSchema,
    categoryId: z.string().uuid().nullable(),
    subcategoryId: z.string().uuid().nullable(),
    accountId: z.string().uuid().nullable(),
    creditCardId: z.string().uuid().nullable(),
    responsibleUserId: z.string().uuid().nullable(),
    installmentCount: z
      .number({ invalid_type_error: "Informe o número de parcelas." })
      .int("Use um número inteiro de parcelas.")
      .min(1, "Use pelo menos uma parcela.")
      .max(120, "Use até 120 parcelas.")
      .default(1),
  })
  .strict()
  .superRefine((e, c) => {
    if (Boolean(e.accountId) === Boolean(e.creditCardId))
      c.addIssue({ code: "custom", message: "Escolha uma conta ou cartão." });
    if (e.kind !== "expense" && e.creditCardId)
      c.addIssue({
        code: "custom",
        message: "Receitas e transferências precisam de uma conta.",
      });
    if (e.installmentCount > 1 && (!e.creditCardId || e.kind !== "expense"))
      c.addIssue({
        code: "custom",
        message: "Parcelas precisam de uma despesa no cartão.",
      });
  });
export type EntryInput = z.infer<typeof entrySchema>;
export type MobileEntry = {
  id: string;
  description: string;
  amountCents: number;
  kind: "expense" | "income" | "transfer";
  category: string;
  payment: string;
  date: string;
  categoryId?: string | null;
  subcategoryId?: string | null;
  accountId?: string | null;
  creditCardId?: string | null;
  responsibleUserId?: string | null;
  installmentCount?: number;
  installmentId?: string | null;
  installmentGroupId?: string;
};
export type Choice = {
  id: string;
  name: string;
  isActive?: boolean;
  parentId?: string;
  kind?: string;
};
export type Catalog = {
  categories: Choice[];
  subcategories: Choice[];
  accounts: Choice[];
  cards: Choice[];
  members: Choice[];
};
export type MobileData = {
  version: 1;
  householdId: string;
  householdName: string;
  today: string;
  month: string;
  catalog: Catalog;
  entries: MobileEntry[];
  hasMore: boolean;
  recordedIncomeCents: number;
  spentCents: number;
  future: {
    label: string;
    month: string;
    incomeCents: number;
    outflowCents: number;
  }[];
  resources: Record<string, Record<string, unknown>[]>;
};
export type DraftSuggestion = {
  description: string;
  amountCents?: number;
  date: string;
  kind: "expense" | "income";
  categoryId: string | null;
  subcategoryId: string | null;
  accountId: string | null;
  creditCardId: string | null;
  installmentCount: number;
  candidates: {
    categoryId: string;
    subcategoryId?: string;
    explanation: string;
  }[];
  explanation: string;
  intent?: string;
};
export type ApiErrorBody = { error: string; code: string };
export const querySchema = z.object({
  month: monthSchema.optional(),
  page: z.coerce.number().int().min(0).max(10000).default(0),
});
export const actionSchema = z
  .object({
    action: z.string().min(1).max(80),
    fields: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])),
  })
  .strict();
export type MobileAction = z.infer<typeof actionSchema>;
