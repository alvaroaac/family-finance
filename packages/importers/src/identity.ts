import type { ImportSource, NormalizedImportRow } from "./types.js";

/**
 * Stable source-item identity contract. Changing any normalization below
 * requires a new version and an explicit compatibility rollout.
 */
export const IMPORT_IDENTITY_VERSION = "import-row-v1" as const;

export type ImportIdentityVersion = typeof IMPORT_IDENTITY_VERSION;

export type SourceIdentityMetadata = {
  /** Statement month, required by callers for Mercado Pago when known. */
  statementReferenceMonth?: string;
  /** Card section parsed from a statement. */
  cardLast4?: string;
  /** Observed installment coordinates from the source row. */
  installmentNumber?: number;
  installmentCount?: number;
};

export type RowIdentityInput = {
  source: ImportSource;
  row: NormalizedImportRow;
  /** Authoritative provider identity when a future adapter exposes one. */
  providerTransactionId?: string;
  sourceMetadata?: SourceIdentityMetadata;
};

export type RowIdentity = {
  identityVersion: ImportIdentityVersion;
  baseIdentityHash: string;
  occurrenceNo: number;
  providerTransactionId?: string;
};

export type ClaimTarget =
  | { type: "account"; id: string }
  | { type: "credit_card"; id: string };

export type ClaimIdentity = RowIdentity & {
  target: ClaimTarget;
  claimFingerprint: string;
};

/** Unicode/case/whitespace-only normalization used by financial identity. */
export function normalizeIdentityDescription(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("pt-BR");
}

function normalizedProviderId(value: string | undefined): string | undefined {
  const normalized = value?.normalize("NFKC").trim();
  return normalized && normalized.length > 0 ? normalized : undefined;
}

function sourceMetadataFor(input: RowIdentityInput): SourceIdentityMetadata | undefined {
  if (input.source !== "mercado-pago") {
    return undefined;
  }
  const installment = input.row.installment;
  const metadata: SourceIdentityMetadata = {
    statementReferenceMonth: input.sourceMetadata?.statementReferenceMonth,
    cardLast4: input.sourceMetadata?.cardLast4 ?? input.row.cardLast4,
    installmentNumber:
      input.sourceMetadata?.installmentNumber ?? installment?.number,
    installmentCount: input.sourceMetadata?.installmentCount ?? installment?.count,
  };
  return Object.values(metadata).some((value) => value !== undefined)
    ? metadata
    : undefined;
}

/**
 * Canonical source identity. Provider IDs are authoritative and deliberately
 * exclude mutable date/description fields. Otherwise the immutable normalized
 * source row and source-specific identity metadata are used.
 */
export function rowIdentityCanonicalValue(input: RowIdentityInput): unknown {
  const providerTransactionId = normalizedProviderId(
    input.providerTransactionId ?? input.row.providerTransactionId,
  );
  if (providerTransactionId !== undefined) {
    return {
      identityVersion: IMPORT_IDENTITY_VERSION,
      providerTransactionId,
      source: input.source,
    };
  }
  const metadata = sourceMetadataFor(input);
  return {
    amountCents: input.row.amount.cents,
    description: normalizeIdentityDescription(input.row.description),
    identityVersion: IMPORT_IDENTITY_VERSION,
    kind: input.row.kind,
    ...(metadata === undefined ? {} : { metadata }),
    occurredOn: input.row.occurredOn,
    source: input.source,
  };
}

/** Stable JSON with recursively sorted object keys and no undefined members. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) {
      throw new Error("canonicalJson cannot encode undefined");
    }
    return encoded;
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const entries = Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
  return `{${entries.join(",")}}`;
}

// Small synchronous SHA-256 implementation keeps this pure package portable
// across Node server actions and browser-compatible bundlers without importing
// a provider or Node-only crypto API.
const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotateRight(value: number, amount: number): number {
  return (value >>> amount) | (value << (32 - amount));
}

export function sha256Hex(value: string | Uint8Array): string {
  const input = typeof value === "string" ? new TextEncoder().encode(value) : value;
  const bitLength = input.length * 8;
  const paddedLength = Math.ceil((input.length + 9) / 64) * 64;
  const bytes = new Uint8Array(paddedLength);
  bytes.set(input);
  bytes[input.length] = 0x80;
  const view = new DataView(bytes.buffer);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x1_0000_0000), false);
  view.setUint32(paddedLength - 4, bitLength >>> 0, false);

  const hash = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const words = new Uint32Array(64);
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let i = 0; i < 16; i += 1) {
      words[i] = view.getUint32(offset + i * 4, false);
    }
    for (let i = 16; i < 64; i += 1) {
      const x = words[i - 15] as number;
      const y = words[i - 2] as number;
      const s0 = rotateRight(x, 7) ^ rotateRight(x, 18) ^ (x >>> 3);
      const s1 = rotateRight(y, 17) ^ rotateRight(y, 19) ^ (y >>> 10);
      words[i] = (((words[i - 16] as number) + s0 + (words[i - 7] as number) + s1) >>> 0);
    }
    let [a, b, c, d, e, f, g, h] = hash;
    for (let i = 0; i < 64; i += 1) {
      const s1 = rotateRight(e as number, 6) ^ rotateRight(e as number, 11) ^ rotateRight(e as number, 25);
      const ch = ((e as number) & (f as number)) ^ (~(e as number) & (g as number));
      const temp1 = (((h as number) + s1 + ch + (SHA256_K[i] as number) + (words[i] as number)) >>> 0);
      const s0 = rotateRight(a as number, 2) ^ rotateRight(a as number, 13) ^ rotateRight(a as number, 22);
      const maj = ((a as number) & (b as number)) ^ ((a as number) & (c as number)) ^ ((b as number) & (c as number));
      const temp2 = (s0 + maj) >>> 0;
      h = g; g = f; f = e; e = (((d as number) + temp1) >>> 0);
      d = c; c = b; b = a; a = ((temp1 + temp2) >>> 0);
    }
    const next = [a, b, c, d, e, f, g, h] as number[];
    for (let i = 0; i < 8; i += 1) {
      hash[i] = (((hash[i] as number) + (next[i] as number)) >>> 0);
    }
  }
  return Array.from(hash, (word) => word.toString(16).padStart(8, "0")).join("");
}

export function rowBaseIdentityHash(input: RowIdentityInput): string {
  return sha256Hex(canonicalJson(rowIdentityCanonicalValue(input)));
}

/** Assign deterministic 1-based occurrence slots in caller/source order. */
export function assignRowIdentities(inputs: readonly RowIdentityInput[]): RowIdentity[] {
  const occurrences = new Map<string, number>();
  return inputs.map((input) => {
    const baseIdentityHash = rowBaseIdentityHash(input);
    const providerTransactionId = normalizedProviderId(
      input.providerTransactionId ?? input.row.providerTransactionId,
    );
    // A provider ID is the item identity itself: repeating it is an exact
    // duplicate, never a second legitimate occurrence slot.
    const occurrenceNo =
      providerTransactionId === undefined
        ? (occurrences.get(baseIdentityHash) ?? 0) + 1
        : 1;
    occurrences.set(baseIdentityHash, occurrenceNo);
    return {
      identityVersion: IMPORT_IDENTITY_VERSION,
      baseIdentityHash,
      occurrenceNo,
      ...(providerTransactionId === undefined ? {} : { providerTransactionId }),
    };
  });
}

export function normalizedRowsFingerprint(identities: readonly RowIdentity[]): string {
  return sha256Hex(
    canonicalJson({
      identityVersion: IMPORT_IDENTITY_VERSION,
      rows: identities.map(({ baseIdentityHash, occurrenceNo }) => ({
        baseIdentityHash,
        occurrenceNo,
      })),
    }),
  );
}

export function claimIdentity(identity: RowIdentity, target: ClaimTarget): ClaimIdentity {
  const claimFingerprint = sha256Hex(
    canonicalJson({
      identityVersion: identity.identityVersion,
      baseIdentityHash: identity.baseIdentityHash,
      occurrenceNo: identity.occurrenceNo,
      target,
    }),
  );
  return { ...identity, target, claimFingerprint };
}

/** Stable purchase-level identity shared by every observed monthly parcel. */
export function installmentGroupBaseIdentityHash(input: {
  source: "mercado-pago" | "nubank-ofx";
  description: string;
  installmentCount: number;
  purchasedOn: string;
  cardLast4?: string;
}): string {
  return sha256Hex(
    canonicalJson({
      identityVersion: IMPORT_IDENTITY_VERSION,
      artifact: "installment_group",
      source: input.source,
      description: normalizeIdentityDescription(input.description),
      installmentCount: input.installmentCount,
      purchasedOn: input.purchasedOn,
      cardLast4: input.cardLast4,
    }),
  );
}

export type InstallmentGroupIdentityInput = Parameters<
  typeof installmentGroupBaseIdentityHash
>[0];

export function assignInstallmentGroupIdentities(
  groups: readonly InstallmentGroupIdentityInput[],
): RowIdentity[] {
  const occurrences = new Map<string, number>();
  return groups.map((group) => {
    const baseIdentityHash = installmentGroupBaseIdentityHash(group);
    const occurrenceNo = (occurrences.get(baseIdentityHash) ?? 0) + 1;
    occurrences.set(baseIdentityHash, occurrenceNo);
    return {
      identityVersion: IMPORT_IDENTITY_VERSION,
      baseIdentityHash,
      occurrenceNo,
    };
  });
}
