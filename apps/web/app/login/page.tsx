import { redirect } from "next/navigation";
import { headers } from "next/headers";

import { getAuthState } from "../../lib/auth";
import { resolveSiteOrigin } from "../../lib/site-origin";

export const metadata = {
  title: "Entrar — Casa",
};

/**
 * Server action that starts the Google OAuth flow via Supabase Auth. Supabase
 * returns the provider URL to redirect the browser to. If config is missing
 * (e.g. local build without secrets) we fall back to re-rendering login.
 */
async function signInWithGoogle(): Promise<void> {
  "use server";
  const { createServerSupabaseClient } = await import("../../lib/supabase");
  const supabase = await createServerSupabaseClient();
  const requestHeaders = await headers();
  const origin = resolveSiteOrigin({
    host: requestHeaders.get("host"),
    forwardedProto: requestHeaders.get("x-forwarded-proto"),
  });

  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: {
      // Supabase redirects back here with a `?code=`; the callback route
      // exchanges it for a session before forwarding to the dashboard.
      redirectTo: `${origin}/auth/callback`,
    },
  });

  if (error || !data?.url) {
    redirect("/login?error=oauth");
  }
  redirect(data.url);
}

type LoginSearchParams = {
  denied?: string;
  email?: string;
  error?: string;
};

/**
 * Public login screen for the Casa workspace. Handles three states:
 * - already authorized -> bounce to the dashboard;
 * - access-denied (authenticated user without active membership) via `?denied=1`;
 * - default sign-in with Google.
 */
export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<LoginSearchParams>;
}) {
  const params = await searchParams;

  // If the visitor already has an authorized session, don't show login.
  const state = await getAuthState();
  if (state.status === "authorized") {
    redirect("/dashboard");
  }

  const denied = params.denied === "1" || state.status === "forbidden";
  const deniedEmail = state.status === "forbidden" ? state.email : params.email;
  const oauthError = params.error === "oauth";

  return (
    <main className="ff-auth">
      <div className="ff-auth-card">
        <h1 className="ff-auth-card__title ff-serif">Family Finance</h1>
        <p className="ff-auth-card__lead">
          As contas da casa, do jeito de vocês.
        </p>

        {denied ? (
          <div role="alert" className="ff-alert ff-alert--negative">
            <strong>Acesso negado.</strong>
            <div style={{ marginTop: 4 }}>
              {deniedEmail ? (
                <>
                  A conta <strong>{deniedEmail}</strong> não pertence a uma casa
                  ativa.
                </>
              ) : (
                <>Esta conta Google não pertence a uma casa ativa.</>
              )}{" "}
              Fale com quem administra a casa para solicitar acesso.
            </div>
          </div>
        ) : null}

        {oauthError ? (
          <div role="alert" className="ff-alert ff-alert--warn">
            Não foi possível iniciar o login com Google. Tente novamente.
          </div>
        ) : null}

        <div className="ff-auth-card__divider" />

        <form action={signInWithGoogle}>
          <button type="submit" className="ff-auth-card__google">
            <svg
              width="17"
              height="17"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              aria-hidden="true"
            >
              <circle cx="12" cy="12" r="9" />
              <path d="M12 7v5l3 2" />
            </svg>
            Entrar com Google
          </button>
        </form>

        <p className="ff-auth-card__note">Acesso por convite.</p>
      </div>
    </main>
  );
}
