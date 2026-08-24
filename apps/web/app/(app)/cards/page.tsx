import {
  findHouseholdIdForCurrentUser,
  listCreditCards,
  findInstallmentPurchasesFiltered,
  findCategoriesByHousehold,
  findSubcategoriesByCategory,
  type CreditCardRow,
  type InstallmentPurchaseListItem,
} from "@family-finance/db";

import { requireAuthorizedUser } from "../../../lib/auth";
import {
  Card,
  Field,
  Input,
  PageTitle,
  SubmitButton,
} from "../../../components/ui";
import {
  createCardAction,
  updateCardAction,
  deleteCardAction,
} from "./actions";
import { CardPurchaseForm } from "./purchase-form";

export const metadata = {
  title: "Cartões — Casa",
};

// This page reads per-request, RLS-scoped data; never statically prerender it.
export const dynamic = "force-dynamic";

type CardsData = {
  cards: CreditCardRow[];
  purchases: InstallmentPurchaseListItem[];
  categories: { id: string; name: string }[];
  subcategories: { id: string; categoryId: string; name: string }[];
  loadError: string | null;
};

async function loadData(): Promise<CardsData> {
  try {
    const { createServerSupabaseClient } =
      await import("../../../lib/supabase");
    const client = await createServerSupabaseClient();
    const householdId = await findHouseholdIdForCurrentUser(client);
    if (householdId === null) {
      return {
        cards: [],
        purchases: [],
        categories: [],
        subcategories: [],
        loadError: null,
      };
    }
    const [cards, categories, purchases] = await Promise.all([
      listCreditCards(client, householdId),
      findCategoriesByHousehold(client, householdId),
      findInstallmentPurchasesFiltered(client, householdId),
    ]);
    // Card purchases are expenses — income categories don't apply here.
    const expenseCategories = categories.filter((c) => c.kind === "expense");
    const subLists = await Promise.all(
      expenseCategories.map((c) =>
        findSubcategoriesByCategory(client, householdId, c.id),
      ),
    );
    const subcategories = subLists.flat();
    return {
      cards,
      purchases,
      categories: expenseCategories.map((c) => ({ id: c.id, name: c.name })),
      subcategories: subcategories.map((s) => ({
        id: s.id,
        categoryId: s.category_id,
        name: s.name,
      })),
      loadError: null,
    };
  } catch (error) {
    return {
      cards: [],
      purchases: [],
      categories: [],
      subcategories: [],
      loadError:
        error instanceof Error
          ? error.message
          : "Não foi possível carregar os cartões.",
    };
  }
}

/** "fecha dia 28 · vence dia 05" — per the Cartões mockup cards. */
function cardDaysLabel(card: CreditCardRow): string | null {
  const parts: string[] = [];
  if (card.closing_day !== null) {
    parts.push(`fecha dia ${String(card.closing_day).padStart(2, "0")}`);
  }
  if (card.due_day !== null) {
    parts.push(`vence dia ${String(card.due_day).padStart(2, "0")}`);
  }
  return parts.length > 0 ? parts.join(" · ") : null;
}

function formatBrl(cents: number): string {
  return (cents / 100).toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
  });
}

function formatDate(iso: string): string {
  const [year, month, day] = iso.split("-");
  return `${day}/${month}/${year}`;
}

function formatMonth(ym: string): string {
  const [year, month] = ym.split("-");
  return `${month}/${year}`;
}

function purchaseInstallmentLabel(
  purchase: InstallmentPurchaseListItem,
): string {
  const perInstallment =
    purchase.firstInstallmentCents !== null
      ? ` de ${formatBrl(purchase.firstInstallmentCents)}`
      : "";
  const range =
    purchase.firstDueMonth !== null && purchase.lastDueMonth !== null
      ? ` · ${formatMonth(purchase.firstDueMonth)} a ${formatMonth(purchase.lastDueMonth)}`
      : "";
  return `${purchase.installmentCount}x${perInstallment}${range}`;
}

export default async function CardsPage() {
  await requireAuthorizedUser();
  const { cards, purchases, categories, subcategories, loadError } =
    await loadData();
  const cardNames = new Map(cards.map((card) => [card.id, card.name]));
  const categoryNames = new Map(
    categories.map((category) => [category.id, category.name]),
  );

  return (
    <section style={{ maxWidth: 980, margin: "0 auto" }}>
      <PageTitle
        kicker="Nossa casa"
        title="Cartões"
        lead="Faturas, fechamentos e as compras parceladas."
        actions={
          <a
            href="#compra"
            className="ff-btn ff-btn--primary"
            style={{ textDecoration: "none" }}
          >
            + Compra parcelada
          </a>
        }
      />

      {loadError ? (
        <div
          role="alert"
          className="ff-alert ff-alert--negative"
          style={{ marginTop: 20 }}
        >
          {loadError}
        </div>
      ) : null}

      {/* Registered cards */}
      <div className="ff-cards-grid" style={{ marginTop: 26 }}>
        {cards.length === 0 ? (
          <p className="ff-muted">Nenhum cartão cadastrado.</p>
        ) : (
          cards.map((c) => {
            const days = cardDaysLabel(c);
            return (
              <Card key={c.id} accentEdge>
                <div>
                  <div className="ff-name ff-name--lg">{c.name}</div>
                  {days ? <div className="ff-name-sub">{days}</div> : null}
                </div>
                <div className="ff-actions">
                  <form
                    action={updateCardAction}
                    style={{
                      display: "flex",
                      gap: 8,
                      alignItems: "flex-end",
                      flexWrap: "wrap",
                      flex: 1,
                    }}
                  >
                    <input type="hidden" name="cardId" value={c.id} />
                    <div style={{ flex: 1, minWidth: 130 }}>
                      <Field label="Nome">
                        <Input
                          type="text"
                          name="name"
                          defaultValue={c.name}
                          required
                          className="ff-input--compact"
                          aria-label={`Nome do cartão ${c.name}`}
                        />
                      </Field>
                    </div>
                    <div style={{ width: 82 }}>
                      <Field label="Fecha">
                        <Input
                          type="number"
                          name="closingDay"
                          min={1}
                          max={31}
                          defaultValue={c.closing_day ?? ""}
                          className="ff-input--compact"
                          aria-label="Dia de fechamento"
                        />
                      </Field>
                    </div>
                    <div style={{ width: 82 }}>
                      <Field label="Vence">
                        <Input
                          type="number"
                          name="dueDay"
                          min={1}
                          max={31}
                          defaultValue={c.due_day ?? ""}
                          className="ff-input--compact"
                          aria-label="Dia de vencimento"
                        />
                      </Field>
                    </div>
                    <SubmitButton
                      className="ff-btn--ghost-sm"
                      pendingLabel="Salvando…"
                    >
                      Salvar
                    </SubmitButton>
                  </form>
                  <form action={deleteCardAction}>
                    <input type="hidden" name="cardId" value={c.id} />
                    <SubmitButton variant="danger" pendingLabel="Excluindo…">
                      Excluir
                    </SubmitButton>
                  </form>
                </div>
              </Card>
            );
          })
        )}
      </div>

      <div style={{ marginTop: 20 }}>
        <Card>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              gap: 12,
              alignItems: "baseline",
              flexWrap: "wrap",
            }}
          >
            <h2 className="ff-h2">Compras no cartão</h2>
            <span className="ff-note ff-num">
              {purchases.length === 1
                ? "1 compra parcelada"
                : `${purchases.length} compras parceladas`}
            </span>
          </div>
          {purchases.length === 0 ? (
            <p className="ff-muted" style={{ marginTop: 14 }}>
              Nenhuma compra parcelada registrada ainda.
            </p>
          ) : (
            <div className="ff-card-purchases" style={{ marginTop: 14 }}>
              {purchases.map((purchase) => (
                <div key={purchase.id} className="ff-card-purchase">
                  <div style={{ minWidth: 0 }}>
                    <div className="ff-card-purchase__title">
                      {purchase.description}
                    </div>
                    <div className="ff-card-purchase__meta">
                      {formatDate(purchase.purchasedOn)} ·{" "}
                      {cardNames.get(purchase.creditCardId) ?? "cartão"} ·{" "}
                      {purchase.categoryId !== null
                        ? (categoryNames.get(purchase.categoryId) ??
                          "categoria")
                        : "sem categoria"}
                    </div>
                    <div className="ff-card-purchase__meta">
                      {purchaseInstallmentLabel(purchase)}
                    </div>
                  </div>
                  <strong className="ff-num">
                    {formatBrl(purchase.totalAmountCents)}
                  </strong>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      {/* Create card */}
      <div style={{ marginTop: 20 }}>
        <Card>
          <h2 className="ff-h2">Novo cartão</h2>
          <form
            action={createCardAction}
            style={{
              display: "flex",
              gap: 12,
              flexWrap: "wrap",
              alignItems: "flex-end",
              marginTop: 18,
            }}
          >
            <div style={{ flex: 1.4, minWidth: 170 }}>
              <Field label="Nome">
                <Input
                  type="text"
                  name="name"
                  placeholder="Ex.: Nubank"
                  required
                  aria-label="Nome do cartão"
                />
              </Field>
            </div>
            <div style={{ width: 150 }}>
              <Field label="Fechamento (opcional)">
                <Input
                  type="number"
                  name="closingDay"
                  min={1}
                  max={31}
                  aria-label="Dia de fechamento"
                />
              </Field>
            </div>
            <div style={{ width: 150 }}>
              <Field label="Vencimento (opcional)">
                <Input
                  type="number"
                  name="dueDay"
                  min={1}
                  max={31}
                  aria-label="Dia de vencimento"
                />
              </Field>
            </div>
            <SubmitButton variant="ghost" pendingLabel="Adicionando…">
              Adicionar cartão
            </SubmitButton>
          </form>
        </Card>
      </div>

      {/* Card purchase entry with visible parcel preview */}
      <CardPurchaseForm
        cards={cards.map((c) => ({ id: c.id, name: c.name }))}
        categories={categories}
        subcategories={subcategories}
      />
    </section>
  );
}
