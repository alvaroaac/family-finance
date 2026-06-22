import {
  findHouseholdIdForCurrentUser,
  listAllCategories,
  listAllSubcategories,
  listCategorizationMemory,
  type CategoryRow,
  type SubcategoryRow,
  type CategorizationMemoryRow,
} from "@family-finance/db";

import { requireAuthorizedUser } from "../../../lib/auth";
import {
  archiveCategoryAction,
  restoreCategoryAction,
  mergeCategoryAction,
  createMemoryAction,
  disableMemoryAction,
  enableMemoryAction,
} from "./actions";

export const metadata = {
  title: "Categorias — Casa",
};

// This page reads per-request, RLS-scoped data; never statically prerender it.
export const dynamic = "force-dynamic";

type CategoriesData = {
  categories: CategoryRow[];
  subcategories: SubcategoryRow[];
  memory: CategorizationMemoryRow[];
  loadError: string | null;
};

/**
 * Load the cleanup data for the household. On a build-time prerender or when
 * Supabase is unreachable (placeholder secrets), this returns an empty,
 * error-flagged dataset instead of throwing, so the route stays renderable.
 */
async function loadData(): Promise<CategoriesData> {
  try {
    const { createServerSupabaseClient } = await import("../../../lib/supabase");
    const client = await createServerSupabaseClient();
    const householdId = await findHouseholdIdForCurrentUser(client);
    if (householdId === null) {
      return {
        categories: [],
        subcategories: [],
        memory: [],
        loadError: null,
      };
    }
    const [categories, subcategories, memory] = await Promise.all([
      listAllCategories(client, householdId),
      listAllSubcategories(client, householdId),
      listCategorizationMemory(client, householdId),
    ]);
    return { categories, subcategories, memory, loadError: null };
  } catch (error) {
    return {
      categories: [],
      subcategories: [],
      memory: [],
      loadError: error instanceof Error ? error.message : "Erro ao carregar.",
    };
  }
}

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
  padding: "8px 12px",
  borderRadius: 8,
  border: "1px solid #11271f",
  background: "#11271f",
  color: "#fff",
  fontSize: 13,
  cursor: "pointer",
} as const;

const btnGhost = {
  ...btn,
  background: "#fff",
  color: "#11271f",
} as const;

export default async function CategoriesPage() {
  await requireAuthorizedUser();
  const { categories, subcategories, memory, loadError } = await loadData();

  const activeCategories = categories.filter((c) => c.is_active);
  const archivedCategories = categories.filter((c) => !c.is_active);
  const subsByCategory = new Map<string, SubcategoryRow[]>();
  for (const sub of subcategories) {
    const list = subsByCategory.get(sub.category_id) ?? [];
    list.push(sub);
    subsByCategory.set(sub.category_id, list);
  }
  const categoryName = new Map(categories.map((c) => [c.id, c.name]));
  const subcategoryName = new Map(subcategories.map((s) => [s.id, s.name]));

  return (
    <section>
      <h1 style={{ marginTop: 0 }}>Categorias</h1>
      <p style={{ color: "#555", maxWidth: 720 }}>
        Limpe a taxonomia: <strong>mescle</strong> categorias duplicadas,{" "}
        <strong>arquive</strong> as que não usa mais, e crie{" "}
        <strong>memória</strong> para mapear nomes antigos/importados nas
        categorias atuais. Novas categorias sugeridas por IA ou importação ficam
        pendentes — nunca são criadas automaticamente.
      </p>

      {loadError ? (
        <div
          role="alert"
          style={{
            background: "#fff6e6",
            border: "1px solid #f0d28a",
            color: "#7a5a00",
            borderRadius: 10,
            padding: 14,
            marginTop: 16,
            fontSize: 14,
          }}
        >
          Não foi possível carregar os dados do banco agora. Conecte o Supabase
          para gerenciar categorias. ({loadError})
        </div>
      ) : null}

      {/* Merge categories */}
      <div style={card}>
        <h2 style={{ marginTop: 0, fontSize: 18 }}>Mesclar categorias</h2>
        <p style={{ color: "#6b7280", fontSize: 14, marginTop: 0 }}>
          Move tudo da categoria de origem para a de destino e arquiva a origem.
        </p>
        <form
          action={mergeCategoryAction}
          style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}
        >
          <select name="sourceCategoryId" required style={inputStyle} aria-label="Origem">
            <option value="">Origem…</option>
            {activeCategories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <span aria-hidden>→</span>
          <select name="targetCategoryId" required style={inputStyle} aria-label="Destino">
            <option value="">Destino…</option>
            {activeCategories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <button type="submit" style={btn}>
            Mesclar
          </button>
        </form>
      </div>

      {/* Active categories list with archive */}
      <div style={card}>
        <h2 style={{ marginTop: 0, fontSize: 18 }}>
          Categorias ativas ({activeCategories.length})
        </h2>
        {activeCategories.length === 0 ? (
          <p style={{ color: "#9aa1a9", fontSize: 14 }}>Nenhuma categoria ativa.</p>
        ) : (
          <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {activeCategories.map((c) => {
              const subs = subsByCategory.get(c.id) ?? [];
              return (
                <li
                  key={c.id}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    padding: "10px 0",
                    borderTop: "1px solid #f0f2f4",
                  }}
                >
                  <div>
                    <div style={{ fontWeight: 600 }}>{c.name}</div>
                    {subs.length > 0 ? (
                      <div style={{ fontSize: 12, color: "#6b7280", marginTop: 2 }}>
                        {subs.map((s) => s.name).join(" · ")}
                      </div>
                    ) : null}
                  </div>
                  <form action={archiveCategoryAction}>
                    <input type="hidden" name="categoryId" value={c.id} />
                    <button type="submit" style={btnGhost}>
                      Arquivar
                    </button>
                  </form>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* Archived categories with restore */}
      {archivedCategories.length > 0 ? (
        <div style={card}>
          <h2 style={{ marginTop: 0, fontSize: 18 }}>
            Categorias arquivadas ({archivedCategories.length})
          </h2>
          <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {archivedCategories.map((c) => (
              <li
                key={c.id}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  padding: "10px 0",
                  borderTop: "1px solid #f0f2f4",
                  color: "#9aa1a9",
                }}
              >
                <span>{c.name}</span>
                <form action={restoreCategoryAction}>
                  <input type="hidden" name="categoryId" value={c.id} />
                  <button type="submit" style={btnGhost}>
                    Restaurar
                  </button>
                </form>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* Categorization memory */}
      <div style={card}>
        <h2 style={{ marginTop: 0, fontSize: 18 }}>Memória de categorização</h2>
        <p style={{ color: "#6b7280", fontSize: 14, marginTop: 0 }}>
          Padrões auditáveis. Ex.: descrição contém &quot;IFOOD&quot; → Alimentação
          &gt; Delivery. Use para mapear nomes antigos/importados nas categorias
          atuais.
        </p>

        <form
          action={createMemoryAction}
          style={{
            display: "flex",
            gap: 8,
            flexWrap: "wrap",
            alignItems: "center",
            marginBottom: 16,
          }}
        >
          <input
            name="pattern"
            required
            placeholder="Padrão (ex.: IFOOD ou nome antigo)"
            style={{ ...inputStyle, minWidth: 240 }}
            aria-label="Padrão"
          />
          <select name="categoryId" required style={inputStyle} aria-label="Categoria">
            <option value="">Categoria…</option>
            {activeCategories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <select name="subcategoryId" style={inputStyle} aria-label="Subcategoria">
            <option value="">Subcategoria (opcional)…</option>
            {subcategories
              .filter((s) => s.is_active)
              .map((s) => (
                <option key={s.id} value={s.id}>
                  {categoryName.get(s.category_id) ?? "?"} &gt; {s.name}
                </option>
              ))}
          </select>
          <button type="submit" style={btn}>
            Adicionar memória
          </button>
        </form>

        {memory.length === 0 ? (
          <p style={{ color: "#9aa1a9", fontSize: 14 }}>
            Nenhum padrão ainda. Correções e mapeamentos aparecerão aqui.
          </p>
        ) : (
          <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {memory.map((m) => {
              const target = m.category_id
                ? m.subcategory_id
                  ? `${categoryName.get(m.category_id) ?? "?"} > ${subcategoryName.get(m.subcategory_id) ?? "?"}`
                  : (categoryName.get(m.category_id) ?? "?")
                : "(sem categoria)";
              return (
                <li
                  key={m.id}
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    padding: "10px 0",
                    borderTop: "1px solid #f0f2f4",
                    opacity: m.is_active ? 1 : 0.55,
                  }}
                >
                  <div>
                    <div style={{ fontSize: 14 }}>
                      descrição contém{" "}
                      <code
                        style={{
                          background: "#f0f2f4",
                          padding: "1px 6px",
                          borderRadius: 6,
                        }}
                      >
                        {m.pattern}
                      </code>{" "}
                      → <strong>{target}</strong>
                    </div>
                    <div style={{ fontSize: 12, color: "#6b7280", marginTop: 2 }}>
                      confiança {Math.round(m.confidence * 100)}%
                      {m.is_active ? "" : " · desativado"}
                    </div>
                  </div>
                  {m.is_active ? (
                    <form action={disableMemoryAction}>
                      <input type="hidden" name="memoryId" value={m.id} />
                      <button type="submit" style={btnGhost}>
                        Desativar
                      </button>
                    </form>
                  ) : (
                    <form action={enableMemoryAction}>
                      <input type="hidden" name="memoryId" value={m.id} />
                      <button type="submit" style={btnGhost}>
                        Ativar
                      </button>
                    </form>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}
