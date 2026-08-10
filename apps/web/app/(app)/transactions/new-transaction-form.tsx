"use client";

import { useEffect, useId, useRef, useState, useTransition } from "react";
import { currentHouseholdDate } from "@family-finance/domain";

import { Button, Field, Input, Select, useToast } from "../../../components/ui";
import { parseReaisToCents } from "../../../lib/format";
import { createManualTransactionAction } from "./actions";
import type {
  CategoryOption,
  PaymentOption,
  ResponsibleOption,
  SubcategoryOption,
} from "./transactions-table";

/**
 * Focused "Novo lançamento" modal for /transactions. Client-side pre-checks
 * give instant pt-BR feedback, but the server action re-validates everything
 * through the domain draft/card-purchase flow.
 */

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
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();
  const [open, setOpen] = useState(initiallyOpen);
  const [isSaving, startTransition] = useTransition();
  const [kind, setKind] = useState<"expense" | "income">("expense");
  const [amount, setAmount] = useState("");
  const [description, setDescription] = useState("");
  const [occurredOn, setOccurredOn] = useState(currentHouseholdDate());
  const [categoryId, setCategoryId] = useState("");
  const [subcategoryId, setSubcategoryId] = useState("");
  const defaultExpensePayment =
    accounts[0] !== undefined
      ? `account:${accounts[0].id}`
      : cards[0] !== undefined
        ? `card:${cards[0].id}`
        : "";
  const [payment, setPayment] = useState(defaultExpensePayment);
  const [purchaseMode, setPurchaseMode] = useState<"avista" | "parcelado">(
    "avista",
  );
  const [installmentCount, setInstallmentCount] = useState(2);
  const [responsible, setResponsible] = useState("household");
  const [fieldError, setFieldError] = useState<string | null>(null);

  const paymentOptions = [
    ...accounts.map((a) => ({ value: `account:${a.id}`, label: `Conta: ${a.name}` })),
    ...(kind === "expense"
      ? cards.map((c) => ({ value: `card:${c.id}`, label: `Cartão: ${c.name}` }))
      : []),
  ];
  const visibleSubcategories = subcategories.filter(
    (s) => s.categoryId === categoryId,
  );
  const isCardExpense = kind === "expense" && payment.startsWith("card:");

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!open || dialog === null || dialog.open) {
      return;
    }
    dialog.showModal();
  }, [open]);

  function reset() {
    setKind("expense");
    setAmount("");
    setDescription("");
    setOccurredOn(currentHouseholdDate());
    setCategoryId("");
    setSubcategoryId("");
    setPayment(defaultExpensePayment);
    setPurchaseMode("avista");
    setInstallmentCount(2);
    setResponsible("household");
    setFieldError(null);
  }

  function openDialog() {
    setOpen(true);
  }

  function closeDialog() {
    dialogRef.current?.close();
    setOpen(false);
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
    if (isCardExpense && purchaseMode === "parcelado" && installmentCount < 2) {
      setFieldError("Informe pelo menos 2 parcelas.");
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
      formData.set("purchaseMode", isCardExpense ? purchaseMode : "avista");
      formData.set("installmentCount", String(installmentCount));
      formData.set("responsible", responsible);
      const result = await createManualTransactionAction(formData);
      if (!result.ok) {
        const message = result.error ?? "Não foi possível salvar o lançamento.";
        setFieldError(message);
        toast.error(message);
      } else {
        toast.success(
          isCardExpense && purchaseMode === "parcelado"
            ? "Compra parcelada salva."
            : "Lançamento salvo.",
        );
        reset();
        closeDialog();
      }
    });
  }

  if (!open) {
    return (
      <div style={{ marginTop: 16 }}>
        <Button variant="primary" type="button" onClick={openDialog}>
          + Lançamento
        </Button>
      </div>
    );
  }

  return (
    <div style={{ marginTop: 16 }}>
      <dialog
        ref={dialogRef}
        className="ff-dialog ff-dialog--transaction"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        onClose={() => setOpen(false)}
        onClick={(event) => {
          if (event.target === event.currentTarget) closeDialog();
        }}
      >
        <div className="ff-dialog__surface">
          <div className="ff-dialog__header">
            <div>
              <div className="ff-kicker">Novo lançamento</div>
              <h2 id={titleId} className="ff-dialog__title ff-serif">
                Registrar despesa ou entrada
              </h2>
            </div>
            <button
              type="button"
              className="ff-dialog__close"
              aria-label="Fechar"
              onClick={closeDialog}
            >
              ×
            </button>
          </div>

          <p id={descriptionId} className="ff-dialog__description">
            Preencha os dados do lançamento. Se escolher um cartão, selecione se
            a compra foi à vista ou parcelada.
          </p>

          <div className="ff-form-grid">
            <Field label="Tipo">
              <Select
                value={kind}
                aria-label="Tipo"
                onChange={(e) => {
                  const next = e.target.value === "income" ? "income" : "expense";
                  setKind(next);
                  if (next === "income" && payment.startsWith("card:")) {
                    setPayment(
                      accounts[0] !== undefined ? `account:${accounts[0].id}` : "",
                    );
                    setPurchaseMode("avista");
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
                onChange={(e) => {
                  const next = e.target.value;
                  setPayment(next);
                  if (!next.startsWith("card:")) {
                    setPurchaseMode("avista");
                  }
                }}
              >
                {paymentOptions.map((p) => (
                  <option key={p.value} value={p.value}>
                    {p.label}
                  </option>
                ))}
              </Select>
            </Field>

            {isCardExpense ? (
              <>
                <Field label="Forma">
                  <Select
                    name="purchaseMode"
                    value={purchaseMode}
                    onChange={(e) =>
                      setPurchaseMode(
                        e.target.value === "parcelado" ? "parcelado" : "avista",
                      )
                    }
                  >
                    <option value="avista">À vista</option>
                    <option value="parcelado">Parcelado</option>
                  </Select>
                </Field>

                {purchaseMode === "parcelado" ? (
                  <Field label="Parcelas">
                    <Input
                      type="number"
                      name="installmentCount"
                      min={2}
                      max={48}
                      step={1}
                      value={installmentCount}
                      onChange={(e) =>
                        setInstallmentCount(
                          Math.max(2, Number.parseInt(e.target.value || "2", 10)),
                        )
                      }
                    />
                  </Field>
                ) : null}
              </>
            ) : null}

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
            <div role="alert" className="ff-alert ff-alert--negative">
              {fieldError}
            </div>
          ) : null}

          <div className="ff-dialog__actions">
            <Button
              variant="ghost"
              type="button"
              disabled={isSaving}
              onClick={closeDialog}
            >
              Cancelar
            </Button>
            <Button
              variant="primary"
              type="button"
              loading={isSaving}
              loadingText="Salvando…"
              onClick={save}
            >
              Salvar lançamento
            </Button>
          </div>
        </div>
      </dialog>
    </div>
  );
}
