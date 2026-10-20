"use client";

import { useId, type ReactElement, type ReactNode } from "react";

import { parseReaisToCents } from "../lib/format";
import { Input, Segmented, Select } from "./ui";

/**
 * The controlled field set of a transaction draft, shared by "Novo lançamento"
 * on /transactions and the quick-capture sheet. Look and order follow the
 * Quick Capture design: Despesa/Receita, Valor · Data · Descrição ·
 * Conta / cartão · Quem · Categoria; Subcategoria, Forma and Parcelas appear
 * only when they apply. Fields the AI filled carry an "IA" pill and a tint.
 */

export type CategoryOption = {
  id: string;
  name: string;
  kind: "expense" | "income";
};
export type SubcategoryOption = {
  id: string;
  categoryId: string;
  name: string;
};
export type ResponsibleOption = { value: string; label: string };
export type PaymentOption = { id: string; name: string };

export type TransactionFieldValues = {
  kind: "expense" | "income";
  /** pt-BR reais text, e.g. "85,00". */
  amount: string;
  description: string;
  /** YYYY-MM-DD. */
  occurredOn: string;
  categoryId: string;
  subcategoryId: string;
  /** "account:<id>" | "card:<id>" | "". */
  payment: string;
  purchaseMode: "avista" | "parcelado";
  installmentCount: number;
  /** "household" or a member value from `responsibles`. */
  responsible: string;
};
export type TransactionFieldKey = keyof TransactionFieldValues;
export type TransactionFieldOptions = {
  accounts: PaymentOption[];
  cards: PaymentOption[];
  categories: CategoryOption[];
  subcategories: SubcategoryOption[];
  responsibles: ResponsibleOption[];
};

const KIND_OPTIONS: Array<{ value: TransactionFieldValues["kind"]; label: string }> = [
  { value: "expense", label: "Despesa" },
  { value: "income", label: "Receita" },
];

function cx(...parts: Array<string | false | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

function isCardExpense(values: TransactionFieldValues): boolean {
  return values.kind === "expense" && values.payment.startsWith("card:");
}

function firstAccountPayment(options: TransactionFieldOptions): string {
  const account = options.accounts[0];
  return account !== undefined ? `account:${account.id}` : "";
}

export function emptyTransactionFieldValues(
  options: TransactionFieldOptions,
  today: string,
): TransactionFieldValues {
  const card = options.cards[0];
  return {
    kind: "expense",
    amount: "",
    description: "",
    occurredOn: today,
    categoryId: "",
    subcategoryId: "",
    payment:
      firstAccountPayment(options) ||
      (card !== undefined ? `card:${card.id}` : ""),
    purchaseMode: "avista",
    installmentCount: 2,
    responsible: "household",
  };
}

/** Client-side pre-check; the server action re-validates everything. */
export function validateTransactionFields(
  values: TransactionFieldValues,
): string | null {
  const cents = parseReaisToCents(values.amount);
  if (cents === null || cents <= 0) {
    return 'Não entendi o valor — use algo como "56,13".';
  }
  if (values.description.trim() === "") {
    return "A descrição não pode ficar vazia.";
  }
  if (values.payment === "") {
    return "Escolha a conta ou o cartão do lançamento.";
  }
  if (
    isCardExpense(values) &&
    values.purchaseMode === "parcelado" &&
    values.installmentCount < 2
  ) {
    return "Informe pelo menos 2 parcelas.";
  }
  return null;
}

/** The FormData `createManualTransactionAction` expects. */
export function toTransactionFormData(values: TransactionFieldValues): FormData {
  const formData = new FormData();
  formData.set("kind", values.kind);
  formData.set("amount", values.amount);
  formData.set("description", values.description);
  formData.set("occurredOn", values.occurredOn);
  formData.set("categoryId", values.categoryId);
  formData.set("subcategoryId", values.subcategoryId);
  formData.set("payment", values.payment);
  formData.set(
    "purchaseMode",
    isCardExpense(values) ? values.purchaseMode : "avista",
  );
  formData.set("installmentCount", String(values.installmentCount));
  formData.set("responsible", values.responsible);
  return formData;
}

function AiPill(): ReactElement {
  return <span className="ff-txfields__ai-pill">IA</span>;
}

function FieldBlock({
  id,
  label,
  ai,
  wide,
  action,
  children,
}: {
  id: string;
  label: string;
  ai: boolean;
  wide?: boolean;
  action?: ReactNode;
  children: ReactNode;
}): ReactElement {
  return (
    <div className={cx("ff-txfields__field", wide && "ff-txfields__field--wide")}>
      <div className="ff-txfields__label-row">
        <label htmlFor={id} className="ff-field__label ff-txfields__label">
          {label}
          {ai ? <AiPill /> : null}
        </label>
        {action}
      </div>
      {children}
    </div>
  );
}

export function TransactionFields({
  values,
  onChange,
  options,
  aiFilled,
  categoryHighlight,
  categoryAction,
  categoryField,
}: {
  values: TransactionFieldValues;
  /**
   * May fire several times for one interaction (e.g. a kind change also
   * clears the category), each with `values` from the same render. Merge with
   * a functional update: `setValues((current) => ({ ...current, [key]: value }))`.
   */
  onChange: <K extends TransactionFieldKey>(
    key: K,
    value: TransactionFieldValues[K],
  ) => void;
  options: TransactionFieldOptions;
  aiFilled?: ReadonlySet<TransactionFieldKey>;
  categoryHighlight?: "warn";
  /** Rendered right of the Categoria label (e.g. "+ Nova categoria"). */
  categoryAction?: ReactNode;
  /** Replaces the Categoria select (e.g. an inline "new category" input). */
  categoryField?: ReactNode;
}): ReactElement {
  const idPrefix = useId();
  const id = (key: TransactionFieldKey) => `${idPrefix}-${key}`;
  const isAi = (key: TransactionFieldKey) => aiFilled?.has(key) ?? false;
  const aiClass = (key: TransactionFieldKey) => isAi(key) && "ff-txfields--ai";

  const paymentOptions = [
    ...options.accounts.map((a) => ({
      value: `account:${a.id}`,
      label: `Conta: ${a.name}`,
    })),
    ...(values.kind === "expense"
      ? options.cards.map((c) => ({
          value: `card:${c.id}`,
          label: `Cartão: ${c.name}`,
        }))
      : []),
  ];
  const visibleCategories = options.categories.filter(
    (c) => c.kind === values.kind,
  );
  const visibleSubcategories = options.subcategories.filter(
    (s) => s.categoryId === values.categoryId,
  );
  const cardExpense = isCardExpense(values);

  function changeKind(next: TransactionFieldValues["kind"]) {
    onChange("kind", next);
    const category = options.categories.find((c) => c.id === values.categoryId);
    if (values.categoryId !== "" && category?.kind !== next) {
      onChange("categoryId", "");
      if (values.subcategoryId !== "") onChange("subcategoryId", "");
    }
    if (next === "income" && values.payment.startsWith("card:")) {
      onChange("payment", firstAccountPayment(options));
      if (values.purchaseMode !== "avista") onChange("purchaseMode", "avista");
    }
  }

  function changeCategory(next: string) {
    onChange("categoryId", next);
    const subcategory = options.subcategories.find(
      (s) => s.id === values.subcategoryId,
    );
    if (values.subcategoryId !== "" && subcategory?.categoryId !== next) {
      onChange("subcategoryId", "");
    }
  }

  function changePayment(next: string) {
    onChange("payment", next);
    if (!next.startsWith("card:") && values.purchaseMode !== "avista") {
      onChange("purchaseMode", "avista");
    }
  }

  return (
    <div className="ff-txfields">
      <div className="ff-txfields__head">
        <span className="ff-txfields__heading">
          Detalhes
          {isAi("kind") ? <AiPill /> : null}
        </span>
        <div className={cx("ff-txfields__kind", `ff-txfields__kind--${values.kind}`)}>
          <Segmented
            value={values.kind}
            options={KIND_OPTIONS}
            onChange={changeKind}
            ariaLabel="Tipo"
          />
        </div>
      </div>

      <div className="ff-txfields__grid">
        <FieldBlock id={id("amount")} label="Valor" ai={isAi("amount")}>
          <div className={cx("ff-txfields__money", aiClass("amount"))}>
            <span className="ff-txfields__currency" aria-hidden>
              R$
            </span>
            <input
              id={id("amount")}
              name="amount"
              aria-label="Valor (R$)"
              className="ff-txfields__money-input"
              value={values.amount}
              placeholder="0,00"
              inputMode="decimal"
              onChange={(e) => onChange("amount", e.target.value)}
            />
          </div>
        </FieldBlock>

        <FieldBlock id={id("occurredOn")} label="Data" ai={isAi("occurredOn")}>
          <Input
            id={id("occurredOn")}
            type="date"
            name="occurredOn"
            className={cx(aiClass("occurredOn"))}
            value={values.occurredOn}
            onChange={(e) => onChange("occurredOn", e.target.value)}
          />
        </FieldBlock>

        <FieldBlock
          id={id("description")}
          label="Descrição"
          ai={isAi("description")}
          wide
        >
          <Input
            id={id("description")}
            name="description"
            className={cx(aiClass("description"))}
            value={values.description}
            placeholder="Ex.: Mercado Guanabara"
            onChange={(e) => onChange("description", e.target.value)}
          />
        </FieldBlock>

        <FieldBlock id={id("payment")} label="Conta / cartão" ai={isAi("payment")}>
          <Select
            id={id("payment")}
            name="payment"
            className={cx(aiClass("payment"))}
            value={values.payment}
            onChange={(e) => changePayment(e.target.value)}
          >
            <option value="">Escolha…</option>
            {paymentOptions.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </Select>
        </FieldBlock>

        <FieldBlock id={id("responsible")} label="Quem" ai={isAi("responsible")}>
          <Select
            id={id("responsible")}
            name="responsible"
            className={cx(aiClass("responsible"))}
            value={values.responsible}
            onChange={(e) => onChange("responsible", e.target.value)}
          >
            {options.responsibles.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </Select>
        </FieldBlock>

        {cardExpense ? (
          <FieldBlock
            id={id("purchaseMode")}
            label="Forma"
            ai={isAi("purchaseMode")}
          >
            <Select
              id={id("purchaseMode")}
              name="purchaseMode"
              className={cx(aiClass("purchaseMode"))}
              value={values.purchaseMode}
              onChange={(e) =>
                onChange(
                  "purchaseMode",
                  e.target.value === "parcelado" ? "parcelado" : "avista",
                )
              }
            >
              <option value="avista">À vista</option>
              <option value="parcelado">Parcelado</option>
            </Select>
          </FieldBlock>
        ) : null}

        {cardExpense && values.purchaseMode === "parcelado" ? (
          <FieldBlock
            id={id("installmentCount")}
            label="Parcelas"
            ai={isAi("installmentCount")}
          >
            <Input
              id={id("installmentCount")}
              type="number"
              name="installmentCount"
              className={cx(aiClass("installmentCount"))}
              min={2}
              max={48}
              step={1}
              value={values.installmentCount}
              onChange={(e) =>
                onChange(
                  "installmentCount",
                  Math.min(
                    48,
                    Math.max(2, Number.parseInt(e.target.value || "2", 10)),
                  ),
                )
              }
            />
          </FieldBlock>
        ) : null}

        <FieldBlock
          id={id("categoryId")}
          label="Categoria"
          ai={isAi("categoryId")}
          wide
          action={categoryAction}
        >
          {categoryField ?? (
            <Select
              id={id("categoryId")}
              name="categoryId"
              className={cx(
                aiClass("categoryId"),
                categoryHighlight === "warn" && "ff-txfields--warn",
              )}
              value={values.categoryId}
              onChange={(e) => changeCategory(e.target.value)}
            >
              <option value="">Escolha…</option>
              {visibleCategories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          )}
        </FieldBlock>

        {visibleSubcategories.length > 0 ? (
          <FieldBlock
            id={id("subcategoryId")}
            label="Subcategoria"
            ai={isAi("subcategoryId")}
            wide
          >
            <Select
              id={id("subcategoryId")}
              name="subcategoryId"
              className={cx(aiClass("subcategoryId"))}
              value={values.subcategoryId}
              onChange={(e) => onChange("subcategoryId", e.target.value)}
            >
              <option value="">—</option>
              {visibleSubcategories.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          </FieldBlock>
        ) : null}
      </div>
    </div>
  );
}
