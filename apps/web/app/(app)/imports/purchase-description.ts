/** Keep bank identity separate from the user's label. Case/spacing alone is not a new label. */
export function purchaseDescription(
  bankName: string,
  description?: string | null,
): string | null {
  const text = description?.trim() ?? "";
  const normalize = (value: string) =>
    value.trim().replace(/\s+/g, " ").toLocaleLowerCase("pt-BR");
  return text && normalize(text) !== normalize(bankName) ? text : null;
}
