type SiteEnv = {
  NEXT_PUBLIC_SITE_URL?: string;
  ALLOWED_WEB_HOSTS?: string;
};

function parseHost(
  value: string | null,
): { hostname: string; host: string } | null {
  if (!value || !/^[a-z0-9.-]+(?::[0-9]{1,5})?$/i.test(value)) return null;

  const [rawName = "", rawPort] = value.split(":");
  const hostname = rawName.replace(/\.$/, "").toLowerCase();
  if (
    !hostname ||
    hostname
      .split(".")
      .some((label) => !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label))
  )
    return null;

  if (
    rawPort !== undefined &&
    (Number(rawPort) < 1 || Number(rawPort) > 65535)
  ) {
    return null;
  }
  const host =
    rawPort === undefined ? hostname : `${hostname}:${Number(rawPort)}`;
  return { hostname, host };
}

export function resolveSiteOrigin(
  input: { host: string | null; forwardedProto: string | null },
  env: SiteEnv = {
    NEXT_PUBLIC_SITE_URL: process.env.NEXT_PUBLIC_SITE_URL,
    ALLOWED_WEB_HOSTS: process.env.ALLOWED_WEB_HOSTS,
  },
): string {
  if (!env.NEXT_PUBLIC_SITE_URL) {
    throw new Error("NEXT_PUBLIC_SITE_URL is required for web redirects");
  }
  const canonical = new URL(env.NEXT_PUBLIC_SITE_URL);
  const fallback = canonical.origin;
  const requested = parseHost(input.host);
  if (!requested) return fallback;

  const allowed = (env.ALLOWED_WEB_HOSTS?.trim() || canonical.host)
    .split(",")
    .map((host) => parseHost(host.trim())?.host);
  if (!allowed.includes(requested.host)) return fallback;

  const local =
    requested.hostname === "localhost" || requested.hostname === "127.0.0.1";
  const protocol = local && input.forwardedProto !== "https" ? "http" : "https";
  return new URL(`${protocol}://${requested.host}`).origin;
}

export function safeCallbackPath(next: string | null): string {
  if (
    !next?.startsWith("/") ||
    next.startsWith("//") ||
    /[\\\u0000-\u001f\u007f]/.test(next)
  ) {
    return "/dashboard";
  }
  return next;
}
