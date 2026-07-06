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
  Button,
  Card,
  Field,
  Input,
  PageTitle,
  Select,
} from "../../../components/ui";
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

/** Mockup dot palette — cycled by list position (categories carry no color). */
const DOT_COLORS = [
  "var(--ff-accent)",
  "var(--ff-positive)",
  "var(--ff-negative)",
  "var(--ff-warn)",
  "var(--ff-accent-hover)",
] as const;

function dotColor(index: number): string {
  return DOT_COLORS[index % DOT_COLORS.length] as string;
}

/** "hortifrúti · padaria · 3 subcategorias" — per the Categorias mockup rows. */
function subsSummary(subs: SubcategoryRow[]): string | null {
  if (subs.length === 0) {
    return null;
  }
  const names = subs.map((s) => s.name).join(" · ");
  const count =
    subs.length === 1 ? "1 subcategoria" : `${subs.length} subcategorias`;
  return `${names} · ${count}`;
}

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
    <section style={{ maxWidth: 980, margin: "0 auto" }}>
      <PageTitle
        kicker="Nossa casa"
        title="Categorias"
        lead="Como a gente organiza os gastos — mexer aqui reorganiza tudo."
      />

      {loadError ? (
        <div role="alert" className="ff-alert ff-alert--warn" style={{ marginTop: 20 }}>
          Não foi possível carregar os dados do banco agora. Conecte o Supabase
          para gerenciar categorias. ({loadError})
        </div>
      ) : null}

      {/* Active categories list with archive */}
      <div className="ff-rows" style={{ marginTop: 26 }}>
        {activeCategories.length === 0 ? (
          <p className="ff-muted">Nenhuma categoria ativa.</p>
        ) : (
          activeCategories.map((c, index) => {
            const summary = subsSummary(subsByCategory.get(c.id) ?? []);
            return (
              <div key={c.id} className="ff-catrow">
                <span className="ff-dot" style={{ background: dotColor(index) }} />
                <div className="ff-catrow__main">
                  <div className="ff-catrow__name">{c.name}</div>
                  {summary ? <div className="ff-catrow__subs">{summary}</div> : null}
                </div>
                <form action={archiveCategoryAction}>
                  <input type="hidden" name="categoryId" value={c.id} />
                  <button type="submit" className="ff-btn ff-btn--ghost-sm">
                    Arquivar
                  </button>
                </form>
              </div>
            );
          })
        )}
      </div>

      {/* Merge categories */}
      <div style={{ marginTop: 20 }}>
        <Card>
          <h2 className="ff-h2">Mesclar categorias</h2>
          <p className="ff-sub">
            Move tudo da categoria de origem para a de destino e arquiva a
            origem.
          </p>
          <form
            action={mergeCategoryAction}
            style={{
              display: "flex",
              gap: 12,
              flexWrap: "wrap",
              alignItems: "flex-end",
              marginTop: 18,
            }}
          >
            <div style={{ flex: 1, minWidth: 160 }}>
              <Field label="Origem">
                <Select name="sourceCategoryId" required aria-label="Origem">
                  <option value="">Origem…</option>
                  {activeCategories.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <div style={{ flex: 1, minWidth: 160 }}>
              <Field label="Destino">
                <Select name="targetCategoryId" required aria-label="Destino">
                  <option value="">Destino…</option>
                  {activeCategories.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <Button variant="ghost" type="submit">
              Mesclar
            </Button>
          </form>
        </Card>
      </div>

      {/* Archived categories with restore */}
      {archivedCategories.length > 0 ? (
        <div style={{ marginTop: 20 }}>
          <Card>
            <h2 className="ff-h2">
              Categorias arquivadas ({archivedCategories.length})
            </h2>
            <div className="ff-rows" style={{ marginTop: 18 }}>
              {archivedCategories.map((c) => (
                <div key={c.id} className="ff-catrow ff-off">
                  <span
                    className="ff-dot"
                    style={{ background: "var(--ff-border)" }}
                  />
                  <div className="ff-catrow__main">
                    <div className="ff-catrow__name">{c.name}</div>
                  </div>
                  <form action={restoreCategoryAction}>
                    <input type="hidden" name="categoryId" value={c.id} />
                    <button type="submit" className="ff-btn ff-btn--ghost-sm">
                      Restaurar
                    </button>
                  </form>
                </div>
              ))}
            </div>
          </Card>
        </div>
      ) : null}

      {/* Categorization memory */}
      <div style={{ marginTop: 20 }}>
        <Card>
          <h2 className="ff-h2">Memória de categorização</h2>
          <p className="ff-sub">
            Padrões auditáveis. Ex.: descrição contém &quot;IFOOD&quot; →
            Alimentação &gt; Delivery. Use para mapear nomes antigos/importados
            nas categorias atuais.
          </p>

          <form
            action={createMemoryAction}
            style={{
              display: "flex",
              gap: 12,
              flexWrap: "wrap",
              alignItems: "flex-end",
              margin: "18px 0 20px",
            }}
          >
            <div style={{ flex: 1.4, minWidth: 200 }}>
              <Field label="Padrão">
                <Input
                  name="pattern"
                  required
                  placeholder="Padrão (ex.: IFOOD ou nome antigo)"
                  aria-label="Padrão"
                />
              </Field>
            </div>
            <div style={{ flex: 1, minWidth: 150 }}>
              <Field label="Categoria">
                <Select name="categoryId" required aria-label="Categoria">
                  <option value="">Categoria…</option>
                  {activeCategories.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <div style={{ flex: 1, minWidth: 170 }}>
              <Field label="Subcategoria">
                <Select name="subcategoryId" aria-label="Subcategoria">
                  <option value="">Subcategoria (opcional)…</option>
                  {subcategories
                    .filter((s) => s.is_active)
                    .map((s) => (
                      <option key={s.id} value={s.id}>
                        {categoryName.get(s.category_id) ?? "?"} &gt; {s.name}
                      </option>
                    ))}
                </Select>
              </Field>
            </div>
            <Button variant="ghost" type="submit">
              Adicionar memória
            </Button>
          </form>

          {memory.length === 0 ? (
            <p className="ff-muted">
              Nenhum padrão ainda. Correções e mapeamentos aparecerão aqui.
            </p>
          ) : (
            <ul className="ff-txlist">
              {memory.map((m) => {
                const target = m.category_id
                  ? m.subcategory_id
                    ? `${categoryName.get(m.category_id) ?? "?"} > ${subcategoryName.get(m.subcategory_id) ?? "?"}`
                    : (categoryName.get(m.category_id) ?? "?")
                  : "(sem categoria)";
                return (
                  <li
                    key={m.id}
                    className={m.is_active ? "ff-txrow" : "ff-txrow ff-off"}
                  >
                    <div className="ff-txrow__main">
                      <div className="ff-txrow__desc">
                        descrição contém <code className="ff-code">{m.pattern}</code>{" "}
                        → <strong>{target}</strong>
                      </div>
                      <div className="ff-txrow__meta">
                        confiança {Math.round(m.confidence * 100)}%
                        {m.is_active ? "" : " · desativado"}
                      </div>
                    </div>
                    {m.is_active ? (
                      <form action={disableMemoryAction}>
                        <input type="hidden" name="memoryId" value={m.id} />
                        <button type="submit" className="ff-btn ff-btn--ghost-sm">
                          Desativar
                        </button>
                      </form>
                    ) : (
                      <form action={enableMemoryAction}>
                        <input type="hidden" name="memoryId" value={m.id} />
                        <button type="submit" className="ff-btn ff-btn--ghost-sm">
                          Ativar
                        </button>
                      </form>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </Card>
      </div>
    </section>
  );
}
