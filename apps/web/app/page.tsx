import { redirect } from "next/navigation";

/**
 * The site root is just an entry point into the private app. Everything real
 * lives under the protected `(app)` route group, which guards itself
 * server-side. Send visitors straight to the dashboard; the guard will bounce
 * them to `/login` if they are not an authorized member of the Casa workspace.
 *
 * Safety net: if an OAuth provider ever redirects here carrying a `code`
 * (e.g. a GoTrue redirect-allowlist misconfiguration falls back to SITE_URL),
 * forward it to the callback route instead of silently dropping the login.
 */
export default async function HomePage({
  searchParams
}: {
  searchParams: Promise<{ code?: string }>;
}) {
  const { code } = await searchParams;
  if (code) {
    redirect(`/auth/callback?code=${encodeURIComponent(code)}`);
  }
  redirect("/dashboard");
}
