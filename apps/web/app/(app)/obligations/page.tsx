import {
  findAccountsByHousehold,
  findCategoriesByHousehold,
  findHouseholdIdForCurrentUser,
  type AccountRow,
  type CategoryRow,
} from "@family-finance/db";

import { requireAuthorizedUser } from "../../../lib/auth";
import { formatBrlCents } from "../../../lib/format";
import {
  Button,
  Card,
  Field,
  Input,
  PageTitle,
  Select,
} from "../../../components/ui";
import { monthLabelPtBr } from "../resumo/queries";
import { loadObligationsData, type ObligationsData } from "./queries";
import {
  cancelObligationAction,
  createObligationAction,
  markObligationPaidAction,
  updateObligationAction,
} from "./actions";

export const metadata = {
  title: "Obrigações — Casa",
};

// This page reads per-request, RLS-scoped data; never statically prerender it.
export const dynamic = "force-dynamic";

const MONTH_ABBR_PT = [
  "jan",
  "fev",
  "mar",
  "abr",
  "mai",
  "jun",
  "jul",
  "ago",
  "set",
  "out",
  "nov",
  "dez",
];

/** "2026-10" -> "out/2026". */
function monthAbbrPtBr(month: string): string {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  if (match === null) return month;
  const idx = Number.parseInt(match[2] as string, 10) - 1;
  return `${MONTH_ABBR_PT[idx] ?? month}/${match[1]}`;
}

type FormLookups = {
  accounts: AccountRow[];
  categories: CategoryRow[];
};

async function loadFormLookups(): Promise<FormLookups> {
  try {
    const { createServerSupabaseClient } = await import("../../../lib/supabase");
    const client = await createServerSupabaseClient();
    const householdId = await findHouseholdIdForCurrentUser(client);
    if (householdId === null) {
      return { accounts: [], categories: [] };
    }
    const [accounts, categories] = await Promise.all([
      findAccountsByHousehold(client, householdId),
      findCategoriesByHousehold(client, householdId),
    ]);
    return { accounts, categories };
  } catch {
    return { accounts: [], categories: [] };
  }
}

function termLabel(item: ObligationsData["obligations"][number]): string {
  if (item.termMonths === null) {
    return "sem prazo (recorrente)";
  }
  const range = `${monthAbbrPtBr(item.startMonth)} → ${monthAbbrPtBr(item.endMonth ?? item.startMonth)}`;
  const remaining = item.remainingMonths ?? 0;
  return `${remaining} de ${item.termMonths} restantes · ${range}`;
}

export default async function ObligationsPage() {
  await requireAuthorizedUser();
  const data = await loadObligationsData();
  const { accounts, categories } = await loadFormLookups();
  const accountName = (id: string): string =>
    accounts.find((a) => a.id === id)?.name ?? "Conta";

  return (
    <section style={{ maxWidth: 980, margin: "0 auto" }}>
      <PageTitle
        kicker="Nossa casa"
        title="Obrigações fixas"
        lead="Financiamentos e contas que se repetem todo mês — projetadas, não lançadas."
      />

      {data.loadError ? (
        <div
          role="alert"
          className="ff-alert ff-alert--negative"
          style={{ marginTop: 20 }}
        >
          {data.loadError}
        </div>
      ) : null}

      {/* Current month: mark-paid */}
      <div style={{ marginTop: 26 }}>
      <Card>
        <h2 className="ff-name">Este mês · {monthLabelPtBr(data.month)}</h2>
        {data.thisMonth.unpaid.length === 0 &&
        data.thisMonth.paid.length === 0 ? (
          <p className="ff-muted">Nenhuma obrigação projetada para este mês.</p>
        ) : (
          <ul style={{ listStyle: "none", padding: 0, margin: "12px 0 0" }}>
            {data.thisMonth.unpaid.map((entry) => (
              <li
                key={entry.obligationId}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  padding: "8px 0",
                }}
              >
                <span style={{ flex: 1 }}>
                  {entry.description} · vence dia {entry.dueDay}
                </span>
                <strong>{formatBrlCents(entry.amountCents)}</strong>
                <form action={markObligationPaidAction}>
                  <input
                    type="hidden"
                    name="obligationId"
                    value={entry.obligationId}
                  />
                  <input type="hidden" name="month" value={entry.month} />
                  <Button type="submit">Marcar como pago</Button>
                </form>
              </li>
            ))}
            {data.thisMonth.paid.map((paidEntry) => (
              <li
                key={paidEntry.obligationId}
                className="ff-muted"
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  padding: "8px 0",
                }}
              >
                <span style={{ flex: 1 }}>{paidEntry.description}</span>
                <span>{formatBrlCents(paidEntry.amountCents)}</span>
                <span aria-label="pago">✓ pago</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
      </div>

      {/* Active obligations */}
      <div className="ff-cards-grid" style={{ marginTop: 26 }}>
        {data.obligations.length === 0 ? (
          <p className="ff-muted">Nenhuma obrigação cadastrada.</p>
        ) : (
          data.obligations.map((item) => (
            <Card key={item.id} hoverable>
              <div className="ff-head-row">
                <div>
                  <div className="ff-name">{item.description}</div>
                  <div className="ff-name-sub">
                    {formatBrlCents(item.amountCents)}/mês · vence dia{" "}
                    {item.dueDay}
                  </div>
                  <div className="ff-name-sub">{termLabel(item)}</div>
                  <div className="ff-name-sub">
                    Pago via: {accountName(item.accountId)}
                  </div>
                </div>
              </div>
              <div className="ff-actions">
                <form
                  action={updateObligationAction}
                  style={{
                    display: "flex",
                    gap: 8,
                    alignItems: "center",
                    flexWrap: "wrap",
                    flex: 1,
                    minWidth: 220,
                  }}
                >
                  <input type="hidden" name="obligationId" value={item.id} />
                  <Input
                    type="text"
                    name="description"
                    defaultValue={item.description}
                    required
                    className="ff-input--compact"
                    aria-label={`Descrição de ${item.description}`}
                  />
                  <Input
                    type="text"
                    name="amount"
                    defaultValue={(item.amountCents / 100)
                      .toFixed(2)
                      .replace(".", ",")}
                    required
                    className="ff-input--compact"
                    aria-label={`Valor mensal de ${item.description}`}
                    style={{ maxWidth: 110 }}
                  />
                  <Input
                    type="number"
                    name="dueDay"
                    min={1}
                    max={28}
                    defaultValue={item.dueDay}
                    required
                    className="ff-input--compact"
                    aria-label={`Dia de vencimento de ${item.description}`}
                    style={{ maxWidth: 80 }}
                  />
                  <button type="submit" className="ff-btn ff-btn--ghost-sm">
                    Salvar
                  </button>
                </form>
                <form action={cancelObligationAction}>
                  <input type="hidden" name="obligationId" value={item.id} />
                  <Button variant="danger" type="submit">
                    Cancelar
                  </Button>
                </form>
              </div>
            </Card>
          ))
        )}
      </div>

      {/* Create form */}
      <div style={{ marginTop: 26 }}>
      <Card>
        <h2 className="ff-name">Nova obrigação</h2>
        <form
          action={createObligationAction}
          style={{
            display: "grid",
            gap: 12,
            gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
            marginTop: 12,
          }}
        >
          <Field label="Descrição">
            <Input type="text" name="description" required placeholder="Parcela solar" />
          </Field>
          <Field label="Valor mensal (R$)">
            <Input type="text" name="amount" required placeholder="710,44" />
          </Field>
          <Field label="Primeiro mês">
            <Input type="month" name="startMonth" required />
          </Field>
          <Field label="Prazo (meses, vazio = sem prazo)">
            <Input type="number" name="termMonths" min={1} placeholder="72" />
          </Field>
          <Field label="Dia de vencimento (1–28)">
            <Input type="number" name="dueDay" min={1} max={28} required />
          </Field>
          <Field label="Conta de pagamento">
            <Select name="accountId" required defaultValue="">
              <option value="" disabled>
                Escolha a conta
              </option>
              {accounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Categoria (opcional)">
            <Select name="categoryId" defaultValue="">
              <option value="">Sem categoria (a definir)</option>
              {categories.map((category) => (
                <option key={category.id} value={category.id}>
                  {category.name}
                </option>
              ))}
            </Select>
          </Field>
          <div style={{ alignSelf: "end" }}>
            <Button type="submit">Criar obrigação</Button>
          </div>
        </form>
      </Card>
      </div>

      {/* 12-month projection timeline */}
      <div style={{ marginTop: 26 }}>
      <Card>
        <h2 className="ff-name">Próximos 12 meses</h2>
        <ul style={{ listStyle: "none", padding: 0, margin: "12px 0 0" }}>
          {data.timeline.map((slot) => (
            <li
              key={slot.month}
              style={{
                display: "flex",
                gap: 12,
                padding: "6px 0",
                borderBottom: "1px solid var(--ff-border, #eee)",
              }}
            >
              <span style={{ minWidth: 84, fontWeight: 600 }}>
                {monthAbbrPtBr(slot.month)}
              </span>
              <span className="ff-muted" style={{ flex: 1 }}>
                {slot.entries.length === 0 && slot.paidCents === 0
                  ? "—"
                  : [
                      ...slot.entries.map(
                        (e) =>
                          `${e.description} ${formatBrlCents(e.amountCents)}`,
                      ),
                      ...(slot.paidCents > 0
                        ? [`pago ${formatBrlCents(slot.paidCents)} ✓`]
                        : []),
                    ].join(" · ")}
              </span>
              <strong>{formatBrlCents(slot.totalCents)}</strong>
            </li>
          ))}
        </ul>
      </Card>
      </div>
    </section>
  );
}
