import Link from "next/link";
import { redirect, notFound } from "next/navigation";
import {
  ImportError,
  summary,
  expiresAt,
  RECOVERY_MS,
  type Draft,
} from "@family-finance/import-service";
import {
  authenticateBrowser,
  transaction,
} from "../../../../lib/agent-import/runtime";
export const dynamic = "force-dynamic";
export const metadata = {
  title: "Revisar importação — Family Finance",
  referrer: "same-origin",
};
const money = (cents: number) =>
  new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(
    cents / 100,
  );
export default async function AgentReview({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{
    challenge?: string;
    page?: string;
    approved?: string;
  }>;
}) {
  const { id } = await params;
  const query = await searchParams;
  let identity;
  try {
    identity = await authenticateBrowser();
  } catch (e) {
    if (e instanceof ImportError && e.code === "AUTH_REQUIRED")
      redirect(
        `/login?next=${encodeURIComponent(`/imports/agent/${id}?challenge=${query.challenge ?? ""}`)}`,
      );
    throw e;
  }
  const data = await transaction(identity, async (db) => {
    const d = await db.loadDraft<Draft>(id);
    return d
      ? {
          draft: d,
          catalog: await db.catalog(),
          approval: await db.approval(id),
        }
      : null;
  });
  if (!data) notFound();
  const { draft: d, catalog, approval } = data;
  if (d.state !== "committed" && expiresAt(d) + RECOVERY_MS <= Date.now())
    return (
      <main>
        <h1>Rascunho expirado</h1>
        <p>
          O prazo de recuperação terminou. Envie os lançamentos novamente para
          criar uma nova importação.
        </p>
      </main>
    );
  const s = summary(d);
  const page = Math.max(
    0,
    Math.min(Math.ceil(d.rows.length / 100) - 1, Number(query.page) || 0),
  );
  const selected = d.rows.filter((r) => r.included);
  const out = selected
    .filter((r) => r.proposed.kind === "expense")
    .reduce((n, r) => n + (r.proposed.amount_cents ?? 0), 0);
  const incoming = selected
    .filter((r) => ["income", "refund"].includes(r.proposed.kind))
    .reduce((n, r) => n + (r.proposed.amount_cents ?? 0), 0);
  return (
    <main style={{ maxWidth: 1100, margin: "40px auto", padding: 24 }}>
      <h1>Revisar importação</h1>
      <p>
        Revise os lançamentos abaixo. Peça ajustes ao agente antes de aprovar.
        Esta aprovação vale apenas para a revisão {d.revision}.
      </p>
      {approval?.approved_at && (
        <p role="status">
          Revisão aprovada. Volte à conversa para concluir a importação.
        </p>
      )}
      <p>
        <strong>{selected.length} selecionados</strong> de {d.rows.length}{" "}
        lançamentos · Saídas: {money(out)} · Entradas e estornos:{" "}
        {money(incoming)}
      </p>
      <p>
        Validade:{" "}
        {new Date(String(s.expires_at)).toLocaleString("pt-BR", {
          timeZone: "America/Sao_Paulo",
        })}{" "}
        (Brasília)
      </p>
      {d.warnings.length > 0 && (
        <ul>
          {d.warnings.map((w, i) => (
            <li key={i}>{w}</li>
          ))}
        </ul>
      )}
      <h2>Fontes</h2>
      <ul>
        {d.sources.map((source) => (
          <li key={source.client_source_id}>
            {source.label ?? source.client_source_id} —{" "}
            {source.coverage === "complete"
              ? "completa"
              : source.coverage === "partial"
                ? "parcial"
                : "abrangência desconhecida"}
          </li>
        ))}
      </ul>
      <h2>Lançamentos</h2>
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>
              {[
                "Seleção",
                "Data",
                "Descrição e evidência",
                "Valor",
                "Destino e categoria",
                "Revisão",
              ].map((t) => (
                <th
                  key={t}
                  scope="col"
                  style={{ textAlign: "left", padding: 8 }}
                >
                  {t}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {d.rows.slice(page * 100, page * 100 + 100).map((r) => (
              <tr key={r.id} style={{ borderTop: "1px solid #ccc" }}>
                <td style={{ padding: 8 }}>
                  {r.included ? "Incluir" : "Excluir"}
                </td>
                <td>{r.proposed.occurred_on ?? "A definir"}</td>
                <td>
                  <strong>
                    {r.proposed.purchase_description ??
                      r.observed.description_original}
                  </strong>
                  {r.proposed.purchase_description && (
                    <p>Original: {r.observed.description_original}</p>
                  )}
                  <details>
                    <summary>Evidência original</summary>
                    <p>
                      {r.observed.evidence_text ??
                        r.observed.description_original}
                    </p>
                    <p>{r.observed.locator}</p>
                  </details>
                </td>
                <td>
                  {r.proposed.amount_cents
                    ? money(r.proposed.amount_cents)
                    : "A definir"}
                  <p>
                    {
                      {
                        expense: "Despesa",
                        income: "Receita",
                        refund: "Estorno",
                        transfer: "Transferência",
                        card_payment: "Pagamento de fatura",
                        unknown: "Tipo indefinido",
                      }[r.proposed.kind]
                    }
                  </p>
                </td>
                <td>
                  {[...catalog.accounts, ...catalog.cards].find(
                    (a) => a.id === r.proposed.target?.id,
                  )?.name ?? "A definir"}
                  <p>
                    {catalog.categories.find((c) => c.id === r.category_id)
                      ?.name ?? "Sem categoria"}
                    {r.category_explicit ? " (escolha explícita)" : ""}
                  </p>
                  {r.subcategory_id && (
                    <p>
                      {
                        catalog.subcategories.find(
                          (c) => c.id === r.subcategory_id,
                        )?.name
                      }
                    </p>
                  )}
                  <p>
                    {r.proposed.responsible_user_id
                      ? catalog.members.find(
                          (m) => m.user_id === r.proposed.responsible_user_id,
                        )?.display_name
                      : "Responsabilidade da casa"}
                  </p>
                </td>
                <td>
                  {r.issues.map((issue, i) => (
                    <p key={i}>{issue.message}</p>
                  ))}
                  {r.proposed.installment && (
                    <p>
                      Parcela {r.proposed.installment.number}/
                      {r.proposed.installment.count} · Total:{" "}
                      {money(r.proposed.installment.total_amount_cents ?? 0)} ·{" "}
                      {r.proposed.installment.existing_group_id
                        ? "Vincular compra existente"
                        : "Nova compra"}
                      {r.proposed.installment.inferred
                        ? " · Informação inferida"
                        : ""}
                    </p>
                  )}
                  {r.candidates.length > 0 && (
                    <details>
                      <summary>
                        {r.candidates.length} possíveis duplicatas ·{" "}
                        {r.match.decision}
                      </summary>
                      {r.candidates.map((c) => (
                        <p key={c.id}>
                          {c.description} · {c.occurred_on} ·{" "}
                          {money(c.amount_cents)}
                        </p>
                      ))}
                      <p>{r.match.reason}</p>
                    </details>
                  )}
                  {r.learning.merchant && (
                    <p>Lembrar categoria deste estabelecimento.</p>
                  )}
                  {r.learning.source_category && (
                    <p>Lembrar categoria desta fonte.</p>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {d.rows.length > 100 && (
        <nav aria-label="Páginas da revisão">
          {page > 0 && (
            <Link href={`?challenge=${query.challenge ?? ""}&page=${page - 1}`}>
              Anterior
            </Link>
          )}{" "}
          <span>
            Página {page + 1} de {Math.ceil(d.rows.length / 100)}
          </span>{" "}
          {(page + 1) * 100 < d.rows.length && (
            <Link href={`?challenge=${query.challenge ?? ""}&page=${page + 1}`}>
              Próxima
            </Link>
          )}
        </nav>
      )}
      {s.can_confirm && query.challenge && !approval?.approved_at ? (
        <form
          action={`/api/v1/import-review/${d.id}/approval`}
          method="post"
          style={{ marginTop: 24 }}
        >
          <input type="hidden" name="revision" value={d.revision} />
          <input type="hidden" name="challenge" value={query.challenge} />
          <label>
            <input type="checkbox" name="reviewed" value="yes" required />{" "}
            Revisei a seleção, os valores, as duplicatas e as preferências que
            serão salvas.
          </label>
          <p>
            <button className="ff-btn ff-btn--primary" type="submit">
              Aprovar revisão {d.revision}
            </button>
          </p>
        </form>
      ) : (
        <p>
          {d.state === "committed"
            ? "Importação concluída."
            : approval?.approved_at
              ? "A aprovação foi registrada. O agente já pode concluir esta revisão."
              : "Solicite uma revisão válida ao agente antes de aprovar."}
        </p>
      )}
    </main>
  );
}
