"use client";

import { useState, useTransition } from "react";

import { Button, Card, Field, Input, Select, useToast } from "../../../components/ui";
import { parseReaisToCents } from "../../../lib/format";
import { createManualTransactionAction } from "./actions";
import type {
  CategoryOption,
  PaymentOption,
  ResponsibleOption,
  SubcategoryOption,
} from "./transactions-table";

/**
 * Inline "Novo lançamento" panel for /transactions (spec 2026-07-03): manual
 * expense/income entry. Collapsed by default; `?novo=1` (dashboard button)
 * renders it open. Client-side pre-checks give instant pt-BR feedback, but
 * the server action re-validates everything through the domain draft.
 */

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export function NewTransactionForm({
  accounts,
  cards,
  categories,
  subcategories,
  responsibles,
  initiallyOpen,
}: {
  accounts: PaymentOption[];
  cards: PaymentOption[];
  categories: CategoryOption[];
  subcategories: SubcategoryOption[];
  responsibles: ResponsibleOption[];
  initiallyOpen: boolean;
}) {
  const toast = useToast();
  const [open, setOpen] = useState(initiallyOpen);
  const [isSaving, startTransition] = useTransition();
  const [kind, setKind] = useState<"expense" | "income">("expense");
  const [amount, setAmount] = useState("");
  const [description, setDescription] = useState("");
  const [occurredOn, setOccurredOn] = useState(todayIso());
  const [categoryId, setCategoryId] = useState("");
  const [subcategoryId, setSubcategoryId] = useState("");
  const [payment, setPayment] = useState(
    accounts[0] !== undefined ? `account:${accounts[0].id}` : "",
  );
  const [responsible, setResponsible] = useState("household");
  const [fieldError, setFieldError] = useState<string | null>(null);

  const paymentOptions = [
    ...accounts.map((a) => ({ value: `account:${a.id}`, label: `Conta: ${a.name}` })),
    // Entrada é sempre numa conta — cartões saem da lista.
    ...(kind === "expense"
      ? cards.map((c) => ({ value: `card:${c.id}`, label: `Cartão: ${c.name}` }))
      : []),
  ];
  const visibleSubcategories = subcategories.filter(
    (s) => s.categoryId === categoryId,
  );

  function reset() {
    setKind("expense");
    setAmount("");
    setDescription("");
    setOccurredOn(todayIso());
    setCategoryId("");
    setSubcategoryId("");
    setPayment(accounts[0] !== undefined ? `account:${accounts[0].id}` : "");
    setResponsible("household");
    setFieldError(null);
  }

  function save() {
    const cents = parseReaisToCents(amount);
    if (cents === null || cents <= 0) {
      setFieldError('Não entendi o valor — use algo como "56,13".');
      return;
    }
    if (description.trim() === "") {
      setFieldError("A descrição não pode ficar vazia.");
      return;
    }
    if (payment === "") {
      setFieldError("Escolha a conta ou o cartão do lançamento.");
      return;
    }
    setFieldError(null);
    startTransition(async () => {
      const formData = new FormData();
      formData.set("kind", kind);
      formData.set("amount", amount);
      formData.set("description", description);
      formData.set("occurredOn", occurredOn);
      formData.set("categoryId", categoryId);
      formData.set("subcategoryId", subcategoryId);
      formData.set("payment", payment);
      formData.set("responsible", responsible);
      const result = await createManualTransactionAction(formData);
      if (!result.ok) {
        const message = result.error ?? "Não foi possível salvar o lançamento.";
        setFieldError(message);
        toast.error(message);
      } else {
        toast.success("Lançamento salvo.");
        reset();
        setOpen(false);
      }
    });
  }

  if (!open) {
    return (
      <div style={{ marginTop: 16 }}>
        <Button variant="primary" type="button" onClick={() => setOpen(true)}>
          + Lançamento
        </Button>
      </div>
    );
  }

  return (
    <div style={{ marginTop: 16 }}>
      <Card>
        <h2 className="ff-card__title">Novo lançamento</h2>

        <div className="ff-form-grid">
          <Field label="Tipo">
            <Select
              value={kind}
              aria-label="Tipo"
              onChange={(e) => {
                const next = e.target.value === "income" ? "income" : "expense";
                setKind(next);
                // Entrada não pode ficar apontando pra um cartão.
                if (next === "income" && payment.startsWith("card:")) {
                  setPayment(accounts[0] !== undefined ? `account:${accounts[0].id}` : "");
                }
              }}
            >
              <option value="expense">Despesa</option>
              <option value="income">Entrada</option>
            </Select>
          </Field>

          <Field label="Valor (R$)">
            <Input
              name="amount"
              value={amount}
              placeholder="56,13"
              inputMode="decimal"
              onChange={(e) => setAmount(e.target.value)}
            />
          </Field>

          <Field label="Descrição">
            <Input
              name="description"
              value={description}
              placeholder="ex.: mercado"
              onChange={(e) => setDescription(e.target.value)}
            />
          </Field>

          <Field label="Data">
            <Input
              type="date"
              name="occurredOn"
              value={occurredOn}
              onChange={(e) => setOccurredOn(e.target.value)}
            />
          </Field>

          <Field label="Categoria">
            <Select
              name="categoryId"
              value={categoryId}
              onChange={(e) => {
                setCategoryId(e.target.value);
                setSubcategoryId("");
              }}
            >
              <option value="">— sem categoria —</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="Subcategoria">
            <Select
              name="subcategoryId"
              value={subcategoryId}
              disabled={categoryId === ""}
              onChange={(e) => setSubcategoryId(e.target.value)}
            >
              <option value="">—</option>
              {visibleSubcategories.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="Pagamento">
            <Select
              name="payment"
              value={payment}
              onChange={(e) => setPayment(e.target.value)}
            >
              {paymentOptions.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="Responsável">
            <Select
              name="responsible"
              value={responsible}
              onChange={(e) => setResponsible(e.target.value)}
            >
              {responsibles.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        {fieldError !== null ? (
          <div role="alert" className="ff-alert ff-alert--negative" style={{ marginTop: 12 }}>
            {fieldError}
          </div>
        ) : null}

        <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
          <Button
            variant="primary"
            type="button"
            loading={isSaving}
            loadingText="Salvando…"
            onClick={save}
          >
            Salvar lançamento
          </Button>
          <Button
            variant="ghost"
            type="button"
            disabled={isSaving}
            onClick={() => setOpen(false)}
          >
            Cancelar
          </Button>
        </div>
      </Card>
    </div>
  );
}
