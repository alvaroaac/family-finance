import {
  authenticateBrowser,
  transaction,
} from "../../../lib/agent-import/runtime";
export const dynamic = "force-dynamic";
export default async function Connections() {
  const identity = await authenticateBrowser();
  const grants = await transaction(identity, (db) => db.grants());
  return (
    <main style={{ maxWidth: 640, margin: "60px auto", padding: 24 }}>
      <h1>Conexões de agentes</h1>
      <p>
        Revogar interrompe novas consultas, ajustes e confirmações, inclusive
        com tokens ainda válidos.
      </p>
      {grants.map((g) => (
        <section key={g.client_id}>
          <h2>{g.client_id}</h2>
          <p>{g.revoked_at ? "Acesso revogado" : g.scopes.join(", ")}</p>
          {!g.revoked_at && (
            <form action="/api/oauth/revoke" method="post">
              <input type="hidden" name="client_id" value={g.client_id} />
              <button>Revogar acesso</button>
            </form>
          )}
        </section>
      ))}
    </main>
  );
}
