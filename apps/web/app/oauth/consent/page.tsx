import { redirect } from "next/navigation";
import { SCOPES } from "@family-finance/import-service";
import { authenticateBrowser } from "../../../lib/agent-import/runtime";
import { createServerSupabaseClient } from "../../../lib/supabase";
export const dynamic = "force-dynamic";
export default async function Consent({
  searchParams,
}: {
  searchParams: Promise<{ authorization_id?: string }>;
}) {
  const { authorization_id: id } = await searchParams;
  if (!id)
    return (
      <main>
        <h1>Conexão inválida</h1>
        <p>Inicie a conexão pelo agente.</p>
      </main>
    );
  try {
    await authenticateBrowser();
  } catch {
    redirect(
      `/login?next=${encodeURIComponent(`/oauth/consent?authorization_id=${id}`)}`,
    );
  }
  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.auth.oauth.getAuthorizationDetails(id);
  if (error || !data)
    return (
      <main>
        <h1>Conexão indisponível</h1>
        <p>Solicite uma nova conexão ao agente.</p>
      </main>
    );
  if ("redirect_url" in data) redirect(data.redirect_url);
  const labels = {
    "finance:context:read":
      "Consultar contas, cartões, categorias e integrantes da casa",
    "imports:read": "Consultar suas importações e comprovantes",
    "imports:prepare": "Preparar e ajustar rascunhos de importação",
    "imports:commit":
      "Concluir somente as revisões que você aprovar nesta página",
  };
  return (
    <main style={{ maxWidth: 640, margin: "60px auto", padding: 24 }}>
      <h1>Conectar ao Family Finance</h1>
      <p>
        <strong>{data.client.name}</strong> está solicitando acesso à sua casa.
      </p>
      <p>
        Você revisará cada importação antes de salvá-la. Arquivos originais não
        serão arquivados; rascunhos expirados podem ser recuperados por 24
        horas.
      </p>
      <form action="/api/oauth/consent" method="post">
        <input type="hidden" name="authorization_id" value={id} />
        <fieldset>
          <legend>Permissões</legend>
          {SCOPES.map((s) => (
            <p key={s}>
              <label>
                <input type="checkbox" name="scopes" value={s} defaultChecked />
                {labels[s]}
              </label>
            </p>
          ))}
        </fieldset>
        <p>
          <button name="decision" value="approve">
            Permitir acesso
          </button>{" "}
          <button name="decision" value="deny">
            Recusar
          </button>
        </p>
      </form>
      <p>Você pode revogar o acesso em Conexões.</p>
    </main>
  );
}
