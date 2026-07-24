import {
  findHouseholdIdForCurrentUser,
  listInvestmentBuckets,
  type InvestmentBucketRow,
  type InvestmentBucketSlug,
} from "@family-finance/db";

import { requireAuthorizedUser } from "../../../lib/auth";
import { formatBrlCents } from "../../../lib/format";
import {
  Card,
  Field,
  IconHome,
  IconJar,
  IconPlusCircle,
  Input,
  PageTitle,
  Select,
  SubmitButton,
} from "../../../components/ui";
import {
  createBucketAction,
  updateBucketAction,
  updateBucketBalanceAction,
  deleteBucketAction,
} from "./actions";

export const metadata = {
  title: "Investimentos — Casa",
};

// This page reads per-request, RLS-scoped data; never statically prerender it.
export const dynamic = "force-dynamic";

/** MVP caixinha slugs and their default Portuguese labels. */
const BUCKET_OPTIONS: ReadonlyArray<{
  slug: InvestmentBucketSlug;
  label: string;
}> = [
  { slug: "filhos", label: "Filhos" },
  { slug: "casa", label: "Casa" },
  {
    slug: "independencia_financeira",
    label: "Independência financeira / aposentadoria",
  },
];

const SLUG_LABEL: Record<InvestmentBucketSlug, string> = {
  filhos: "Filhos",
  casa: "Casa",
  independencia_financeira: "Independência financeira / aposentadoria",
};

/** Line-art icon per caixinha (Mais Telas: casa → home, IF → plus circle). */
function BucketIcon({ slug }: { slug: InvestmentBucketSlug }) {
  switch (slug) {
    case "casa":
      return <IconHome size={17} />;
    case "independencia_financeira":
      return <IconPlusCircle size={17} />;
    default:
      return <IconJar size={17} />;
  }
}

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

async function loadData(): Promise<InvestmentsData> {
  try {
    const { createServerSupabaseClient } = await import("../../../lib/supabase");
    const client = await createServerSupabaseClient();
    const householdId = await findHouseholdIdForCurrentUser(client);
    if (householdId === null) {
      return { buckets: [], loadError: null };
    }
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

export default async function InvestmentsPage() {
  await requireAuthorizedUser();
  const { buckets, loadError } = await loadData();

  // A caixinha slug can exist at most once per household; offer only free slugs.
  const usedSlugs = new Set(buckets.map((b) => b.slug));
  const availableSlugs = BUCKET_OPTIONS.filter((o) => !usedSlugs.has(o.slug));
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

      {/* Caixinha cards */}
      <div className="ff-cards-grid" style={{ marginTop: 26 }}>
        {buckets.length === 0 ? (
          <p className="ff-muted">Nenhuma caixinha cadastrada.</p>
        ) : (
          buckets.map((bucket) => (
            <Card key={bucket.id} hoverable>
              <div className="ff-head-row">
                <span className="ff-bubble ff-bubble--md">
                  <BucketIcon slug={bucket.slug} />
                </span>
                <div>
                  <div className="ff-name">{bucket.name}</div>
                  <div className="ff-name-sub">{SLUG_LABEL[bucket.slug]}</div>
                </div>
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
                <form
                  action={updateBucketAction}
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
                    className="ff-input--compact"
                    aria-label={`Nome da caixinha ${bucket.name}`}
                  />
                  <SubmitButton className="ff-btn--ghost-sm" pendingLabel="Salvando…">
                    Salvar
                  </SubmitButton>
                </form>
                <form action={deleteBucketAction}>
                  <input type="hidden" name="bucketId" value={bucket.id} />
                  <SubmitButton variant="danger" pendingLabel="Excluindo…">
                    Excluir
                  </SubmitButton>
                </form>
              </div>
            </Card>
          ))
        )}
      </div>

      {/* Create */}
      <div style={{ marginTop: 20 }}>
        <Card>
          <h2 className="ff-h2">Nova caixinha</h2>
          {availableSlugs.length === 0 ? (
            <p className="ff-sub">Todas as caixinhas do MVP já foram criadas.</p>
          ) : (
            <form
              action={createBucketAction}
              style={{
                display: "flex",
                gap: 12,
                flexWrap: "wrap",
                alignItems: "flex-end",
                marginTop: 18,
              }}
            >
              <div style={{ flex: 1, minWidth: 200 }}>
                <Field label="Tipo de caixinha">
                  <Select
                    name="slug"
                    defaultValue={availableSlugs[0]?.slug}
                    aria-label="Tipo de caixinha"
                  >
                    {availableSlugs.map((o) => (
                      <option key={o.slug} value={o.slug}>
                        {o.label}
                      </option>
                    ))}
                  </Select>
                </Field>
              </div>
              <div style={{ flex: 1, minWidth: 170 }}>
                <Field label="Nome exibido">
                  <Input
                    type="text"
                    name="name"
                    placeholder="Nome exibido"
                    required
                    aria-label="Nome da caixinha"
                  />
                </Field>
              </div>
              <SubmitButton variant="ghost" pendingLabel="Adicionando…">
                Adicionar caixinha
              </SubmitButton>
            </form>
          )}
        </Card>
      </div>
    </section>
  );
}
