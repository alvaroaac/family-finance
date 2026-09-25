"use client";

import { useRef, useTransition } from "react";

import type { CategoryKind } from "@family-finance/db";

import {
  Badge,
  Button,
  Card,
  Field,
  IconPlusCircle,
  Input,
  Select,
  useToast,
} from "../../../components/ui";
import { createCategoryAction, createSubcategoryAction } from "./actions";

type CategoryOption = {
  id: string;
  name: string;
  kind: CategoryKind;
};

function kindLabel(kind: CategoryKind): string {
  return kind === "income" ? "Entradas" : "Despesas";
}

export function CategoryCreationPanel({
  categories,
}: {
  categories: CategoryOption[];
}) {
  const toast = useToast();
  const categoryForm = useRef<HTMLFormElement>(null);
  const subcategoryForm = useRef<HTMLFormElement>(null);
  const [categoryPending, startCategoryTransition] = useTransition();
  const [subcategoryPending, startSubcategoryTransition] = useTransition();

  function submitCategory(formData: FormData) {
    startCategoryTransition(async () => {
      const result = await createCategoryAction(formData);
      if (result.ok) {
        categoryForm.current?.reset();
        toast.success(result.message);
      } else {
        toast.error(result.message);
      }
    });
  }

  function submitSubcategory(formData: FormData) {
    startSubcategoryTransition(async () => {
      const result = await createSubcategoryAction(formData);
      if (result.ok) {
        subcategoryForm.current?.reset();
        toast.success(result.message);
      } else {
        toast.error(result.message);
      }
    });
  }

  return (
    <section
      className="ff-category-create"
      aria-labelledby="category-create-title"
    >
      <div className="ff-category-create__heading">
        <div>
          <div className="ff-kicker">Organizar</div>
          <h2 id="category-create-title" className="ff-h2">
            Adicionar ao catálogo
          </h2>
        </div>
        <Badge tone="accent" dot>
          Disponível agora
        </Badge>
      </div>

      <div className="ff-category-create__grid">
        <Card className="ff-category-create__card" accentEdge>
          <div className="ff-category-create__intro">
            <span className="ff-category-create__icon" aria-hidden="true">
              <IconPlusCircle size={20} />
            </span>
            <div>
              <h3 className="ff-category-create__title">Nova categoria</h3>
              <p className="ff-category-create__description">
                Crie um destino para despesas ou entradas.
              </p>
            </div>
          </div>
          <form
            ref={categoryForm}
            action={submitCategory}
            className="ff-category-create__form"
          >
            <Field label="Nome">
              <Input
                name="name"
                required
                maxLength={60}
                autoComplete="off"
                placeholder="Ex.: Pets"
                aria-label="Nome da categoria"
                disabled={categoryPending}
              />
            </Field>
            <Field label="Tipo">
              <Select
                name="kind"
                defaultValue="expense"
                aria-label="Tipo da categoria"
                disabled={categoryPending}
              >
                <option value="expense">Despesa</option>
                <option value="income">Entrada</option>
              </Select>
            </Field>
            <Button
              type="submit"
              variant="primary"
              loading={categoryPending}
              loadingText="Criando…"
              className="ff-category-create__submit"
            >
              Criar categoria
            </Button>
          </form>
        </Card>

        <Card className="ff-category-create__card">
          <div className="ff-category-create__intro">
            <span
              className="ff-category-create__icon ff-category-create__icon--soft"
              aria-hidden="true"
            >
              <IconPlusCircle size={20} />
            </span>
            <div>
              <h3 className="ff-category-create__title">Nova subcategoria</h3>
              <p className="ff-category-create__description">
                Detalhe uma categoria sem fragmentar o orçamento.
              </p>
            </div>
          </div>
          <form
            ref={subcategoryForm}
            action={submitSubcategory}
            className="ff-category-create__form"
          >
            <Field label="Categoria principal">
              <Select
                name="categoryId"
                required
                defaultValue=""
                aria-label="Categoria principal"
                disabled={subcategoryPending || categories.length === 0}
              >
                <option value="">Escolha uma categoria…</option>
                {(["expense", "income"] as const).map((kind) => {
                  const options = categories.filter(
                    (category) => category.kind === kind,
                  );
                  return options.length > 0 ? (
                    <optgroup key={kind} label={kindLabel(kind)}>
                      {options.map((category) => (
                        <option key={category.id} value={category.id}>
                          {category.name}
                        </option>
                      ))}
                    </optgroup>
                  ) : null;
                })}
              </Select>
            </Field>
            <Field label="Nome">
              <Input
                name="name"
                required
                maxLength={60}
                autoComplete="off"
                placeholder="Ex.: Veterinário"
                aria-label="Nome da subcategoria"
                disabled={subcategoryPending || categories.length === 0}
              />
            </Field>
            <Button
              type="submit"
              variant="ghost"
              loading={subcategoryPending}
              loadingText="Criando…"
              disabled={categories.length === 0}
              className="ff-category-create__submit"
            >
              Criar subcategoria
            </Button>
          </form>
        </Card>
      </div>
    </section>
  );
}
