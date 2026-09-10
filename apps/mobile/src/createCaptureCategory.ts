import type { Choice } from "@family-finance/mobile-contracts";

const normalized = (name: string) => name.trim().normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase();

/** Reconcile before retrying so a lost response does not duplicate a category. */
export async function createCaptureCategory(
  name: string,
  list: () => Promise<Choice[]>,
  create: (name: string) => Promise<unknown>,
): Promise<Choice> {
  const value = name.trim();
  if (!value || value.length > 100)
    throw new Error("Informe um nome de categoria com até 100 caracteres.");
  function find(rows: Choice[]) {
    const match = rows.find((row) => normalized(row.name) === normalized(value));
    if (match?.isActive === false)
      throw new Error("Esta categoria está arquivada. Restaure-a em Categorias para usá-la.");
    return match;
  }
  const existing = find(await list());
  if (existing) return existing;
  try {
    await create(value);
  } catch (error) {
    // The write may have succeeded even if its response was interrupted.
    const recovered = await list().then(find).catch(() => undefined);
    if (recovered) return recovered;
    throw error;
  }
  const category = find(await list());
  if (!category) throw new Error("A categoria foi criada, mas não apareceu na lista. Tente novamente para atualizar.");
  return category;
}
