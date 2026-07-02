import {
  findHouseholdIdForCurrentUser,
  listInvestmentBuckets,
  type InvestmentBucketRow,
  type InvestmentBucketSlug,
} from "@family-finance/db";

import { requireAuthorizedUser } from "../../../lib/auth";
import { formatBrlCents } from "../../../lib/format";
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

const card = {
  background: "#fff",
  border: "1px solid #e3e6ea",
  borderRadius: 12,
  padding: 20,
  marginTop: 20,
} as const;

const inputStyle = {
  padding: "8px 10px",
  border: "1px solid #cbd2d9",
  borderRadius: 8,
  fontSize: 14,
} as const;

const btn = {
  padding: "8px 14px",
  borderRadius: 8,
  border: "1px solid #11271f",
  background: "#11271f",
  color: "#fff",
  fontSize: 14,
  cursor: "pointer",
} as const;

const btnGhost = { ...btn, background: "#fff", color: "#11271f" } as const;
const btnDanger = {
  ...btn,
  background: "#fff",
  color: "#8a2020",
  border: "1px solid #e0b4b4",
} as const;

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

  return (
    <section>
      <h1 style={{ marginTop: 0 }}>Investimentos · Caixinhas</h1>
      <p style={{ color: "#555", maxWidth: 720 }}>
        Caixinhas são objetivos de poupança/investimento da casa. No MVP existem
        três: <strong>filhos</strong>, <strong>casa</strong> e{" "}
        <strong>independência financeira / aposentadoria</strong>. O nome exibido
        pode ser ajustado.
      </p>

      {loadError ? (
        <div
          role="alert"
          style={{
            background: "#fdecec",
            border: "1px solid #f3b4b4",
            color: "#8a2020",
            borderRadius: 10,
            padding: 12,
            marginTop: 16,
            fontSize: 14,
          }}
        >
          {loadError}
        </div>
      ) : null}

      {/* Create */}
      <div style={card}>
        <h2 style={{ marginTop: 0, fontSize: 18 }}>Nova caixinha</h2>
        {availableSlugs.length === 0 ? (
          <p style={{ color: "#6b7280", fontSize: 14, marginTop: 0 }}>
            Todas as caixinhas do MVP já foram criadas.
          </p>
        ) : (
          <form
            action={createBucketAction}
            style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}
          >
            <select name="slug" defaultValue={availableSlugs[0]?.slug} style={inputStyle} aria-label="Tipo de caixinha">
              {availableSlugs.map((o) => (
                <option key={o.slug} value={o.slug}>
                  {o.label}
                </option>
              ))}
            </select>
            <input
              type="text"
              name="name"
              placeholder="Nome exibido"
              required
              style={inputStyle}
              aria-label="Nome da caixinha"
            />
            <button type="submit" style={btn}>
              Adicionar caixinha
            </button>
          </form>
        )}
      </div>

      {/* List */}
      <div style={card}>
        <h2 style={{ marginTop: 0, fontSize: 18 }}>
          Caixinhas ({buckets.length})
          {buckets.length > 0 ? (
            <span style={{ fontWeight: 400, color: "#6b7280", fontSize: 14 }}>
              {" "}
              · total{" "}
              {formatBrlCents(
                buckets.reduce((sum, b) => sum + b.balance_cents, 0),
              )}
            </span>
          ) : null}
        </h2>
        {buckets.length === 0 ? (
          <p style={{ color: "#6b7280", fontSize: 14, marginTop: 0 }}>
            Nenhuma caixinha cadastrada.
          </p>
        ) : (
          <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {buckets.map((bucket) => (
              <li
                key={bucket.id}
                style={{
                  borderTop: "1px solid #f0f2f4",
                  padding: "12px 0",
                  display: "flex",
                  gap: 12,
                  flexWrap: "wrap",
                  alignItems: "center",
                }}
              >
                <span
                  style={{
                    fontSize: 11,
                    color: "#1d4ed8",
                    background: "#e6efff",
                    borderRadius: 6,
                    padding: "2px 8px",
                  }}
                >
                  {SLUG_LABEL[bucket.slug]}
                </span>
                <form
                  action={updateBucketAction}
                  style={{ display: "flex", gap: 8, alignItems: "center", flex: 1 }}
                >
                  <input type="hidden" name="bucketId" value={bucket.id} />
                  <input
                    type="text"
                    name="name"
                    defaultValue={bucket.name}
                    required
                    style={{ ...inputStyle, flex: 1, minWidth: 160 }}
                    aria-label={`Nome da caixinha ${bucket.name}`}
                  />
                  <button type="submit" style={btnGhost}>
                    Salvar
                  </button>
                </form>
                <form action={deleteBucketAction}>
                  <input type="hidden" name="bucketId" value={bucket.id} />
                  <button type="submit" style={btnDanger}>
                    Excluir
                  </button>
                </form>
                <form
                  action={updateBucketBalanceAction}
                  style={{
                    display: "flex",
                    gap: 8,
                    alignItems: "center",
                    flexBasis: "100%",
                    flexWrap: "wrap",
                  }}
                >
                  <input type="hidden" name="bucketId" value={bucket.id} />
                  <span style={{ fontSize: 13, color: "#6b7280" }}>
                    Saldo atual:{" "}
                    <strong style={{ color: "#11271f" }}>
                      {formatBrlCents(bucket.balance_cents)}
                    </strong>
                  </span>
                  <input
                    type="text"
                    name="balance"
                    inputMode="decimal"
                    defaultValue={centsToReaisInput(bucket.balance_cents)}
                    required
                    style={{ ...inputStyle, width: 120 }}
                    aria-label={`Saldo da caixinha ${bucket.name} (R$)`}
                  />
                  <button type="submit" style={btnGhost}>
                    Atualizar saldo
                  </button>
                </form>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
