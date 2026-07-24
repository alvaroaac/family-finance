import {
  findHouseholdIdForCurrentUser,
  listAccounts,
  type AccountRow,
} from "@family-finance/db";

import { requireAuthorizedUser } from "../../../lib/auth";
import {
  Card,
  Field,
  IconBank,
  IconJar,
  Input,
  PageTitle,
  Select,
  SubmitButton,
} from "../../../components/ui";
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

const KIND_LABEL: Record<AccountRow["kind"], string> = {
  checking: "Conta corrente",
  investment: "Conta investimento",
};

/** Warm kind copy from the Contas mockup cards. */
const KIND_COPY: Record<AccountRow["kind"], string> = {
  checking: "movimento do dia a dia",
  investment: "onde moram as caixinhas",
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

  return (
    <section style={{ maxWidth: 980, margin: "0 auto" }}>
      <PageTitle
        kicker="Nossa casa"
        title="Contas"
        lead="O dinheiro do dia a dia e o que está guardado."
      />

      {loadError ? (
        <div role="alert" className="ff-alert ff-alert--negative" style={{ marginTop: 20 }}>
          {loadError}
        </div>
      ) : null}

      {/* Accounts grid */}
      <div className="ff-cards-grid" style={{ marginTop: 26 }}>
        {accounts.length === 0 ? (
          <p className="ff-muted">Nenhuma conta cadastrada.</p>
        ) : (
          accounts.map((account) => (
            <Card key={account.id} hoverable>
              <div className="ff-head-row">
                <span className="ff-bubble ff-bubble--lg">
                  {account.kind === "checking" ? (
                    <IconBank size={18} />
                  ) : (
                    <IconJar size={18} />
                  )}
                </span>
                <div>
                  <div className="ff-name">
                    {account.name} · {KIND_LABEL[account.kind].toLowerCase()}
                  </div>
                  <div className="ff-name-sub">{KIND_COPY[account.kind]}</div>
                </div>
              </div>
              <div className="ff-actions">
                <form
                  action={updateAccountAction}
                  style={{
                    display: "flex",
                    gap: 8,
                    alignItems: "center",
                    flex: 1,
                    minWidth: 200,
                  }}
                >
                  <input type="hidden" name="accountId" value={account.id} />
                  <Input
                    type="text"
                    name="name"
                    defaultValue={account.name}
                    required
                    className="ff-input--compact"
                    aria-label={`Nome da conta ${account.name}`}
                  />
                  <SubmitButton className="ff-btn--ghost-sm" pendingLabel="Salvando…">
                    Salvar
                  </SubmitButton>
                </form>
                <form action={deleteAccountAction}>
                  <input type="hidden" name="accountId" value={account.id} />
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
          <h2 className="ff-h2">Nova conta</h2>
          <form
            action={createAccountAction}
            style={{
              display: "flex",
              gap: 12,
              flexWrap: "wrap",
              alignItems: "flex-end",
              marginTop: 18,
            }}
          >
            <div style={{ flex: 1.4, minWidth: 180 }}>
              <Field label="Nome da conta">
                <Input
                  type="text"
                  name="name"
                  placeholder="Nome da conta"
                  required
                  aria-label="Nome da conta"
                />
              </Field>
            </div>
            <div style={{ flex: 1, minWidth: 160 }}>
              <Field label="Tipo">
                <Select name="kind" defaultValue="checking" aria-label="Tipo">
                  <option value="checking">Conta corrente</option>
                  <option value="investment">Conta investimento</option>
                </Select>
              </Field>
            </div>
            <SubmitButton variant="ghost" pendingLabel="Criando…">
              + Nova conta
            </SubmitButton>
          </form>
        </Card>
      </div>
    </section>
  );
}
