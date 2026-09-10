import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const IMPORT_PREVIEW_VERSION = 2 as const;
export const IMPORT_PREVIEW_TTL_MS = 30 * 60 * 1000;

export type ImportPreviewTokenClaims = {
  version: typeof IMPORT_PREVIEW_VERSION;
  requestKey: string;
  householdId: string;
  userId: string;
  issuedAt: number;
  expiresAt: number;
  source: "minhas-financas" | "nubank" | "nubank-ofx" | "mercado-pago";
  fileFingerprint: string;
  normalizedFingerprint: string;
  parserVersion: string;
  snapshotHash: string;
};

function base64Url(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function importPreviewSnapshotHash(snapshot: unknown): string {
  return sha256(JSON.stringify(snapshot));
}

export function signImportPreviewToken(
  claims: ImportPreviewTokenClaims,
  secret: string,
): string {
  if (secret.length < 32)
    throw new Error("Import preview signing is not configured.");
  const payload = base64Url(JSON.stringify(claims));
  const signature = createHmac("sha256", secret).update(payload).digest();
  return `${payload}.${base64Url(signature)}`;
}

export function verifyImportPreviewToken(args: {
  token: string;
  secret: string;
  snapshot: unknown;
  now?: number;
}): ImportPreviewTokenClaims {
  const [payload, suppliedSignature, extra] = args.token.split(".");
  if (
    payload === undefined ||
    suppliedSignature === undefined ||
    extra !== undefined
  ) {
    throw new Error("Preview inválido. Envie o arquivo novamente.");
  }
  const wanted = createHmac("sha256", args.secret).update(payload).digest();
  let supplied: Buffer;
  try {
    supplied = Buffer.from(suppliedSignature, "base64url");
  } catch {
    throw new Error("Preview inválido. Envie o arquivo novamente.");
  }
  if (supplied.length !== wanted.length || !timingSafeEqual(supplied, wanted)) {
    throw new Error("Preview inválido. Envie o arquivo novamente.");
  }
  let claims: ImportPreviewTokenClaims;
  try {
    claims = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    ) as ImportPreviewTokenClaims;
  } catch {
    throw new Error("Preview inválido. Envie o arquivo novamente.");
  }
  const now = args.now ?? Date.now();
  if (
    claims.version !== IMPORT_PREVIEW_VERSION ||
    claims.issuedAt > now + 5_000 ||
    claims.expiresAt < now ||
    claims.expiresAt - claims.issuedAt > IMPORT_PREVIEW_TTL_MS ||
    claims.snapshotHash !== importPreviewSnapshotHash(args.snapshot)
  ) {
    throw new Error("Preview expirado ou alterado. Envie o arquivo novamente.");
  }
  return claims;
}
