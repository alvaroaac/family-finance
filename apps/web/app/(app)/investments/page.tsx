import {
  listInvestmentBuckets,
  type InvestmentBucketRow,
} from "@family-finance/db";

import { requireAuthorizedUser } from "../../../lib/auth";
import { formatBrlCents } from "../../../lib/format";
import {
  Card,
  EmptyState,
  Field,
  IconJar,
  Input,
  PageTitle,
  SubmitButton,
} from "../../../components/ui";
import {
  createBucketAction,
  renameBucketAction,
  updateBucketBalanceAction,
  deleteBucketAction,
} from "./actions";
import { BucketActionForm } from "./bucket-form";

export const metadata = {
  title: "Investimentos — Casa",
};

// This page reads per-request, RLS-scoped data; never statically prerender it.
export const dynamic = "force-dynamic";

/** Integer cents -> plain pt-BR reais input value, e.g. 123456 -> "1.234,56". */
function centsToReaisInput(cents: number): string {
  return (cents / 100).toLocaleString("pt-BR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

type InvestmentsData = {
  buckets: InvestmentBucketRow[];
  loadError: string | null;
};

async function loadData(householdId: string): Promise<InvestmentsData> {
  try {
    const { createServerSupabaseClient } = await import("../../../lib/supabase");
    const client = await createServerSupabaseClient();
    const buckets = await listInvestmentBuckets(client, householdId);
    return { buckets, loadError: null };
  } catch (error) {
    return {
      buckets: [],
      loadError:
        error instanceof Error
          ? error.message
          : "Não foi possível carregar as caixinhas.",
    };
  }
}

/** Name a new caixinha; the slug is derived on the server. */
function CreateBucketForm() {
  return (
    <BucketActionForm
      action={createBucketAction}
      style={{
        display: "flex",
        gap: 12,
        flexWrap: "wrap",
        alignItems: "flex-end",
        justifyContent: "center",
      }}
    >
      <div style={{ flex: 1, minWidth: 200, textAlign: "left" }}>
        <Field label="Objetivo">
          <Input
            type="text"
            name="name"
            placeholder="Ex.: Viagem 2027"
            required
            maxLength={60}
            autoComplete="off"
            aria-label="Nome do objetivo"
          />
        </Field>
      </div>
      <SubmitButton variant="primary" pendingLabel="Criando…">
        Criar caixinha
      </SubmitButton>
    </BucketActionForm>
  );
}

export default async function InvestmentsPage() {
  const { householdId } = await requireAuthorizedUser();
  const { buckets, loadError } = await loadData(householdId);
  const totalCents = buckets.reduce((sum, b) => sum + b.balance_cents, 0);

  return (
    <section style={{ maxWidth: 980, margin: "0 auto" }}>
      <PageTitle
        kicker="Nossa casa"
        title="Caixinhas"
        lead="O que a gente está guardando pros nossos planos."
        actions={
          buckets.length > 0 ? (
            <div className="ff-total">
              <div className="ff-total__kicker">Guardado no total</div>
              <div className="ff-total__value ff-serif ff-num">
                {formatBrlCents(totalCents)}
              </div>
            </div>
          ) : undefined
        }
      />

      {loadError ? (
        <div role="alert" className="ff-alert ff-alert--negative" style={{ marginTop: 20 }}>
          {loadError}
        </div>
      ) : null}

      {buckets.length === 0 ? (
        loadError ? null : (
          <div style={{ marginTop: 26 }}>
            <EmptyState
              icon={<IconJar size={22} />}
              title="Nenhuma caixinha ainda"
              description="Dê um nome ao primeiro objetivo — uma viagem, a reserva de emergência, a casa nova."
              action={<CreateBucketForm />}
            />
          </div>
        )
      ) : (
        <>
          <div className="ff-cards-grid" style={{ marginTop: 26 }}>
            {buckets.map((bucket) => (
              <BucketCard key={bucket.id} bucket={bucket} />
            ))}
          </div>

          <div style={{ marginTop: 20 }}>
            <Card>
              <h2 className="ff-h2">Nova caixinha</h2>
              <p className="ff-sub">
                Um objetivo novo para guardar dinheiro junto.
              </p>
              <div style={{ marginTop: 18 }}>
                <CreateBucketForm />
              </div>
            </Card>
          </div>
        </>
      )}
    </section>
  );
}

/** One caixinha: balance, rename, and delete (allowed once the balance is zero). */
function BucketCard({ bucket }: { bucket: InvestmentBucketRow }) {
  return (
    <Card hoverable>
      <div className="ff-head-row">
        <span className="ff-bubble ff-bubble--md">
          <IconJar size={17} />
        </span>
        <div className="ff-name">{bucket.name}</div>
      </div>
      <div className="ff-bucket__value ff-serif ff-num">
        {formatBrlCents(bucket.balance_cents)}
      </div>
      <form
        action={updateBucketBalanceAction}
        style={{
          display: "flex",
          gap: 8,
          alignItems: "center",
          flexWrap: "wrap",
          marginTop: 12,
        }}
      >
        <input type="hidden" name="bucketId" value={bucket.id} />
        <div style={{ width: 130 }}>
          <Input
            type="text"
            name="balance"
            inputMode="decimal"
            defaultValue={centsToReaisInput(bucket.balance_cents)}
            required
            className="ff-input--compact ff-num"
            aria-label={`Saldo da caixinha ${bucket.name} (R$)`}
          />
        </div>
        <SubmitButton
          unstyled
          className="ff-chip-link"
          pendingLabel="Atualizando…"
        >
          Atualizar saldo
        </SubmitButton>
      </form>
      <div className="ff-actions">
        <BucketActionForm
          action={renameBucketAction}
          style={{
            display: "flex",
            gap: 8,
            alignItems: "center",
            flex: 1,
            minWidth: 180,
          }}
        >
          <input type="hidden" name="bucketId" value={bucket.id} />
          <Input
            type="text"
            name="name"
            defaultValue={bucket.name}
            required
            maxLength={60}
            className="ff-input--compact"
            aria-label={`Nome da caixinha ${bucket.name}`}
          />
          <SubmitButton className="ff-btn--ghost-sm" pendingLabel="Salvando…">
            Renomear
          </SubmitButton>
        </BucketActionForm>
        <BucketActionForm action={deleteBucketAction}>
          <input type="hidden" name="bucketId" value={bucket.id} />
          <SubmitButton variant="danger" pendingLabel="Excluindo…">
            Excluir
          </SubmitButton>
        </BucketActionForm>
      </div>
    </Card>
  );
}
