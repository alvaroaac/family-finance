import {
  findHouseholdIdForCurrentUser,
  listAccounts,
  type AccountRow,
} from "@family-finance/db";

import { requireAuthorizedUser } from "../../../lib/auth";
import {
  createAccountAction,
  updateAccountAction,
  deleteAccountAction,
} from "./actions";

export const metadata = {
  title: "Contas — Casa",
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

const btnGhost = {
  ...btn,
  background: "#fff",
  color: "#11271f",
} as const;

const btnDanger = {
  ...btn,
  background: "#fff",
  color: "#8a2020",
  border: "1px solid #e0b4b4",
} as const;

const KIND_LABEL: Record<AccountRow["kind"], string> = {
  checking: "Conta corrente",
  investment: "Conta investimento",
};

type AccountsData = {
  accounts: AccountRow[];
  loadError: string | null;
};

/**
 * Load the household accounts. On a build-time prerender or when Supabase is
 * unreachable (placeholder secrets), return an empty dataset instead of
 * throwing, so the route stays renderable.
 */
async function loadData(): Promise<AccountsData> {
  try {
    const { createServerSupabaseClient } = await import("../../../lib/supabase");
    const client = await createServerSupabaseClient();
    const householdId = await findHouseholdIdForCurrentUser(client);
    if (householdId === null) {
      return { accounts: [], loadError: null };
    }
    const accounts = await listAccounts(client, householdId);
    return { accounts, loadError: null };
  } catch (error) {
    return {
      accounts: [],
      loadError:
        error instanceof Error
          ? error.message
          : "Não foi possível carregar as contas.",
    };
  }
}

export default async function AccountsPage() {
  await requireAuthorizedUser();
  const { accounts, loadError } = await loadData();

  const checking = accounts.filter((a) => a.kind === "checking");
  const investment = accounts.filter((a) => a.kind === "investment");

  return (
    <section>
      <h1 style={{ marginTop: 0 }}>Contas</h1>
      <p style={{ color: "#555", maxWidth: 720 }}>
        Modele as contas da casa de forma simples: <strong>conta corrente</strong>{" "}
        para o dia a dia e <strong>conta investimento</strong> para agrupar
        poupança e aplicações. Transações e importações escolhem uma destas
        contas como destino.
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
        <h2 style={{ marginTop: 0, fontSize: 18 }}>Nova conta</h2>
        <form
          action={createAccountAction}
          style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}
        >
          <input
            type="text"
            name="name"
            placeholder="Nome da conta"
            required
            style={inputStyle}
            aria-label="Nome da conta"
          />
          <select name="kind" defaultValue="checking" style={inputStyle} aria-label="Tipo">
            <option value="checking">Conta corrente</option>
            <option value="investment">Conta investimento</option>
          </select>
          <button type="submit" style={btn}>
            Adicionar conta
          </button>
        </form>
      </div>

      {/* List grouped by kind */}
      {([
        ["Contas correntes", checking, "checking"] as const,
        ["Contas investimento", investment, "investment"] as const,
      ]).map(([title, list]) => (
        <div style={card} key={title}>
          <h2 style={{ marginTop: 0, fontSize: 18 }}>
            {title} ({list.length})
          </h2>
          {list.length === 0 ? (
            <p style={{ color: "#6b7280", fontSize: 14, marginTop: 0 }}>
              Nenhuma conta cadastrada.
            </p>
          ) : (
            <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
              {list.map((account) => (
                <li
                  key={account.id}
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
                      color: "#15633a",
                      background: "#e9f7ef",
                      borderRadius: 6,
                      padding: "2px 8px",
                    }}
                  >
                    {KIND_LABEL[account.kind]}
                  </span>
                  <form
                    action={updateAccountAction}
                    style={{ display: "flex", gap: 8, alignItems: "center", flex: 1 }}
                  >
                    <input type="hidden" name="accountId" value={account.id} />
                    <input
                      type="text"
                      name="name"
                      defaultValue={account.name}
                      required
                      style={{ ...inputStyle, flex: 1, minWidth: 160 }}
                      aria-label={`Nome da conta ${account.name}`}
                    />
                    <button type="submit" style={btnGhost}>
                      Salvar
                    </button>
                  </form>
                  <form action={deleteAccountAction}>
                    <input type="hidden" name="accountId" value={account.id} />
                    <button type="submit" style={btnDanger}>
                      Excluir
                    </button>
                  </form>
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
    </section>
  );
}
