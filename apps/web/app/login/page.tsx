import { redirect } from "next/navigation";

import { getAuthState } from "../../lib/auth";

export const metadata = {
  title: "Entrar — Casa"
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

  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: {
      redirectTo: `${process.env.NEXT_PUBLIC_SITE_URL ?? ""}/dashboard`
    }
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
 * - access-denied (authenticated email not on the allowlist) via `?denied=1`;
 * - default sign-in with Google.
 */
export default async function LoginPage({
  searchParams
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
  const deniedEmail =
    params.email ?? (state.status === "forbidden" ? state.email : undefined);
  const oauthError = params.error === "oauth";

  return (
    <main
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 24
      }}
    >
      <div
        style={{
          width: "100%",
          maxWidth: 420,
          background: "#fff",
          border: "1px solid #e3e6ea",
          borderRadius: 16,
          padding: 32,
          boxShadow: "0 8px 30px rgba(0,0,0,0.06)"
        }}
      >
        <div style={{ fontSize: 12, letterSpacing: 1, color: "#6b7280" }}>
          WORKSPACE
        </div>
        <h1 style={{ margin: "4px 0 2px" }}>Casa</h1>
        <p style={{ color: "#555", marginTop: 0 }}>
          Workspace financeiro privado de Alvaro e Karol.
        </p>

        {denied ? (
          <div
            role="alert"
            style={{
              background: "#fdecec",
              border: "1px solid #f5c2c2",
              color: "#8a1f1f",
              borderRadius: 10,
              padding: 14,
              margin: "16px 0"
            }}
          >
            <strong>Acesso negado.</strong>
            <div style={{ marginTop: 4, fontSize: 14 }}>
              {deniedEmail ? (
                <>
                  A conta <strong>{deniedEmail}</strong> não está autorizada nesta
                  casa.
                </>
              ) : (
                <>Esta conta Google não está autorizada nesta casa.</>
              )}{" "}
              Fale com um membro da casa para liberar seu email.
            </div>
          </div>
        ) : null}

        {oauthError ? (
          <div
            role="alert"
            style={{
              background: "#fff6e6",
              border: "1px solid #f0d28a",
              color: "#7a5a00",
              borderRadius: 10,
              padding: 14,
              margin: "16px 0",
              fontSize: 14
            }}
          >
            Não foi possível iniciar o login com Google. Tente novamente.
          </div>
        ) : null}

        <form action={signInWithGoogle} style={{ marginTop: 16 }}>
          <button
            type="submit"
            style={{
              width: "100%",
              padding: "12px 16px",
              borderRadius: 10,
              border: "1px solid #11271f",
              background: "#11271f",
              color: "#fff",
              fontSize: 16,
              fontWeight: 600,
              cursor: "pointer"
            }}
          >
            Entrar com Google
          </button>
        </form>

        <p style={{ color: "#9aa1a9", fontSize: 12, marginTop: 16 }}>
          Apenas emails autorizados (allowlist) podem acessar a Casa. Não há
          cadastro público.
        </p>
      </div>
    </main>
  );
}
