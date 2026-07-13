import Link from "next/link";
import { notFound } from "next/navigation";

import {
  findHouseholdIdForCurrentUser,
  findImportBatchById,
  listImportRowsByBatchId,
} from "@family-finance/db";

import { Card } from "../../../../components/ui";
import { requireAuthorizedUser } from "../../../../lib/auth";

const dispositionLabel = {
  imported: "importado",
  duplicate_existing: "já existente",
  duplicate_in_file: "duplicado no arquivo",
  parser_error: "erro de leitura",
  validation_error: "erro de validação",
  excluded: "excluído",
} as const;

export default async function ImportBatchPage({
  params,
}: {
  params: Promise<{ batchId: string }>;
}) {
  await requireAuthorizedUser();
  const { createServerSupabaseClient } =
    await import("../../../../lib/supabase");
  const client = await createServerSupabaseClient();
  const householdId = await findHouseholdIdForCurrentUser(client);
  if (householdId === null) notFound();
  const { batchId } = await params;
  const [batch, rows] = await Promise.all([
    findImportBatchById(client, householdId, batchId),
    listImportRowsByBatchId(client, householdId, batchId),
  ]);
  if (batch === null) notFound();

  return (
    <section>
      <header>
        <div className="ff-kicker">Nossa casa · Importação</div>
        <h1 className="ff-page-title__heading">Detalhes do lote</h1>
        <p className="ff-page-title__lead">
          {batch.imported_rows} importado(s) · {batch.duplicate_rows}{" "}
          duplicata(s) · {batch.error_rows} erro(s)
        </p>
      </header>
      <div style={{ marginTop: 24 }}>
        <Card>
          <p className="ff-note">
            Fonte: {batch.source} ·{" "}
            {batch.confirmed_at
              ? new Date(batch.confirmed_at).toLocaleString("pt-BR")
              : "não confirmado"}
          </p>
          <div style={{ overflowX: "auto", marginTop: 12 }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  <th>Linha</th>
                  <th>Descrição da origem</th>
                  <th>Destino</th>
                  <th>Resultado</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.id}>
                    <td className="ff-num">{row.source_line ?? "—"}</td>
                    <td>{row.description ?? row.error_message ?? "—"}</td>
                    <td>
                      {row.transaction_id
                        ? "transação"
                        : row.installment_group_id
                          ? "parcelamento"
                          : "—"}
                    </td>
                    <td>
                      {row.disposition
                        ? dispositionLabel[row.disposition]
                        : "—"}
                      {row.override_reason ? ` · ${row.override_reason}` : ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
      <p style={{ marginTop: 18 }}>
        <Link href="/imports">← Voltar para importações</Link>
      </p>
    </section>
  );
}
