/**
 * Pure FormData → domain-input mapping for the Obrigações forms.
 *
 * Extracted from the server actions so the parsing/validation rules (pt-BR
 * amount, blank-vs-numeric term, required fields) are unit-testable without
 * next/cache or an auth session. Errors are pt-BR — the actions surface them
 * to the household directly.
 */

import type { ObligationChanges } from "@family-finance/db";
import type { CreateObligationInput } from "@family-finance/domain";

import { parseReaisToCents } from "../../../lib/format";

export function requireField(formData: FormData, name: string): string {
  const value = formData.get(name);
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Missing required field: ${name}`);
  }
  return value.trim();
}

export function optionalField(
  formData: FormData,
  name: string,
): string | undefined {
  const value = formData.get(name);
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

export type ObligationPaymentInput = {
  obligationId: string;
  month: string;
  amountCents: number;
};

/** Map the payment modal fields into the actual monthly payment override. */
export function obligationPaymentFromForm(
  formData: FormData,
): ObligationPaymentInput {
  const amountCents = parseReaisToCents(requireField(formData, "amount"));
  if (amountCents === null || amountCents <= 0) {
    throw new Error("Valor pago inválido — use por exemplo 710,44.");
  }

  return {
    obligationId: requireField(formData, "obligationId"),
    month: requireField(formData, "month"),
    amountCents,
  };
}

/** Strictly numeric positive integer — "12abc" is rejected, not truncated. */
function strictPositiveInt(value: string, label: string): number {
  if (!/^\d+$/.test(value)) {
    throw new Error(`${label} inválido — use apenas números.`);
  }
  const parsed = Number.parseInt(value, 10);
  if (parsed < 1) {
    throw new Error(`${label} precisa ser positivo.`);
  }
  return parsed;
}

/**
 * Map the create-obligation form into a `CreateObligationInput`. The domain
 * `createObligationDraft` still runs its own validation afterwards — this
 * layer only owns the FormData/pt-BR parsing concerns.
 */
export function obligationInputFromForm(
  formData: FormData,
  ids: { householdId: string; createdByUserId: string },
): CreateObligationInput {
  const amountCents = parseReaisToCents(requireField(formData, "amount"));
  if (amountCents === null || amountCents <= 0) {
    throw new Error("Valor mensal inválido — use por exemplo 710,44.");
  }

  const termMode = optionalField(formData, "termMode");
  const termRaw =
    termMode === "indefinite"
      ? undefined
      : optionalField(formData, "termMonths");
  if (termMode === "installments" && termRaw === undefined) {
    throw new Error("Informe o prazo em meses.");
  }
  const termMonths =
    termRaw === undefined ? null : strictPositiveInt(termRaw, "Prazo");

  const dueDay = strictPositiveInt(
    requireField(formData, "dueDay"),
    "Dia de vencimento",
  );

  const categoryId = optionalField(formData, "categoryId");

  return {
    householdId: ids.householdId,
    description: requireField(formData, "description"),
    amountCents,
    startMonth: requireField(formData, "startMonth"),
    termMonths,
    dueDay,
    accountId: requireField(formData, "accountId"),
    createdByUserId: ids.createdByUserId,
    category: categoryId !== undefined ? { categoryId } : undefined,
  };
}

/** Map editable fields, preserving omitted account/category selections. */
export function obligationChangesFromForm(formData: FormData): {
  obligationId: string;
  changes: ObligationChanges;
} {
  const obligationId = requireField(formData, "obligationId");
  const amountCents = parseReaisToCents(requireField(formData, "amount"));
  if (amountCents === null || amountCents <= 0) {
    throw new Error("Valor mensal inválido — use por exemplo 710,44.");
  }
  const changes: ObligationChanges = {
    description: requireField(formData, "description"),
    amountCents,
    dueDay: strictPositiveInt(
      requireField(formData, "dueDay"),
      "Dia de vencimento",
    ),
  };
  if (formData.has("accountId")) {
    changes.accountId = requireField(formData, "accountId");
  }
  if (formData.has("categoryId")) {
    changes.categoryId = optionalField(formData, "categoryId") ?? null;
  }
  return { obligationId, changes };
}
