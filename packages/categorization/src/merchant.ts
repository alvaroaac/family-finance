/** Versioned merchant/source-label normalization. */
export const MERCHANT_KEY_VERSION = "merchant-key-v1" as const;
export const SOURCE_CATEGORY_KEY_VERSION = "source-category-v1" as const;

function fold(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Conservative merchant identity. Only explicitly known processor prefixes
 * and labelled order-ID suffixes are removed. Unlabelled numbers are retained
 * because they can identify a legitimate merchant or branch.
 */
export function normalizeMerchantKey(description: string): string {
  let key = fold(description);
  key = key.replace(/^(?:PAG|PG|MP|MERCADO\s*PAGO)\s*\*\s*/, "");
  key = key.replace(
    /\s+(?:PEDIDO|ORDER|TRANSACAO|TRANSACTION)\s*(?:ID\s*)?[:#-]?\s*[A-Z0-9-]{5,}$/,
    "",
  );
  return key.replace(/\s+/g, " ").trim();
}

export function normalizeSourceCategoryLabel(label: string): string {
  return fold(label);
}
