import {
  findHouseholdIdForCurrentUser,
  listCreditCards,
  findCategoriesByHousehold,
  findSubcategoriesByCategory,
  type CreditCardRow,
} from "@family-finance/db";

import { requireAuthorizedUser } from "../../../lib/auth";
import { createCardAction, updateCardAction, deleteCardAction } from "./actions";
import { CardPurchaseForm } from "./purchase-form";

export const metadata = {
  title: "Cartões — Casa",
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

type CardsData = {
  cards: CreditCardRow[];
  categories: { id: string; name: string }[];
  subcategories: { id: string; categoryId: string; name: string }[];
  loadError: string | null;
};

async function loadData(): Promise<CardsData> {
  try {
    const { createServerSupabaseClient } = await import("../../../lib/supabase");
    const client = await createServerSupabaseClient();
    const householdId = await findHouseholdIdForCurrentUser(client);
    if (householdId === null) {
      return { cards: [], categories: [], subcategories: [], loadError: null };
    }
    const [cards, categories] = await Promise.all([
      listCreditCards(client, householdId),
      findCategoriesByHousehold(client, householdId),
    ]);
    const subLists = await Promise.all(
      categories.map((c) => findSubcategoriesByCategory(client, householdId, c.id)),
    );
    const subcategories = subLists.flat();
    return {
      cards,
      categories: categories.map((c) => ({ id: c.id, name: c.name })),
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
      categories: [],
      subcategories: [],
      loadError:
        error instanceof Error
          ? error.message
          : "Não foi possível carregar os cartões.",
    };
  }
}

export default async function CardsPage() {
  await requireAuthorizedUser();
  const { cards, categories, subcategories, loadError } = await loadData();

  return (
    <section>
      <h1 style={{ marginTop: 0 }}>Cartões</h1>
      <p style={{ color: "#555", maxWidth: 720 }}>
        Cadastre cartões de crédito simples (sem a complexidade bancária completa)
        e lance compras <strong>à vista</strong> ou <strong>parceladas</strong>.
        As parcelas mensais são geradas pelo núcleo financeiro e ficam{" "}
        <strong>visíveis antes de salvar</strong>.
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

      {/* Create card */}
      <div style={card}>
        <h2 style={{ marginTop: 0, fontSize: 18 }}>Novo cartão</h2>
        <form
          action={createCardAction}
          style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-end" }}
        >
          <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13 }}>
            Nome
            <input
              type="text"
              name="name"
              placeholder="Ex.: Nubank"
              required
              style={inputStyle}
              aria-label="Nome do cartão"
            />
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13 }}>
            Dia de fechamento (opcional)
            <input
              type="number"
              name="closingDay"
              min={1}
              max={31}
              style={inputStyle}
              aria-label="Dia de fechamento"
            />
          </label>
          <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13 }}>
            Dia de vencimento (opcional)
            <input
              type="number"
              name="dueDay"
              min={1}
              max={31}
              style={inputStyle}
              aria-label="Dia de vencimento"
            />
          </label>
          <button type="submit" style={btn}>
            Adicionar cartão
          </button>
        </form>
      </div>

      {/* List cards */}
      <div style={card}>
        <h2 style={{ marginTop: 0, fontSize: 18 }}>Cartões cadastrados ({cards.length})</h2>
        {cards.length === 0 ? (
          <p style={{ color: "#6b7280", fontSize: 14, marginTop: 0 }}>
            Nenhum cartão cadastrado.
          </p>
        ) : (
          <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {cards.map((c) => (
              <li
                key={c.id}
                style={{
                  borderTop: "1px solid #f0f2f4",
                  padding: "12px 0",
                  display: "flex",
                  gap: 12,
                  flexWrap: "wrap",
                  alignItems: "flex-end",
                }}
              >
                <form
                  action={updateCardAction}
                  style={{ display: "flex", gap: 8, alignItems: "flex-end", flexWrap: "wrap", flex: 1 }}
                >
                  <input type="hidden" name="cardId" value={c.id} />
                  <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12 }}>
                    Nome
                    <input
                      type="text"
                      name="name"
                      defaultValue={c.name}
                      required
                      style={{ ...inputStyle, minWidth: 160 }}
                      aria-label={`Nome do cartão ${c.name}`}
                    />
                  </label>
                  <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12 }}>
                    Fechamento
                    <input
                      type="number"
                      name="closingDay"
                      min={1}
                      max={31}
                      defaultValue={c.closing_day ?? ""}
                      style={{ ...inputStyle, width: 90 }}
                      aria-label="Dia de fechamento"
                    />
                  </label>
                  <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12 }}>
                    Vencimento
                    <input
                      type="number"
                      name="dueDay"
                      min={1}
                      max={31}
                      defaultValue={c.due_day ?? ""}
                      style={{ ...inputStyle, width: 90 }}
                      aria-label="Dia de vencimento"
                    />
                  </label>
                  <button type="submit" style={btnGhost}>
                    Salvar
                  </button>
                </form>
                <form action={deleteCardAction}>
                  <input type="hidden" name="cardId" value={c.id} />
                  <button type="submit" style={btnDanger}>
                    Excluir
                  </button>
                </form>
              </li>
            ))}
          </ul>
        )}
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
