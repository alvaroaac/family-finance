"use client";

import { useMemo, useState, useTransition } from "react";

import {
  previewCardPurchase,
  saveCardPurchase,
  type ParcelPreview,
  type SaveResult,
} from "./actions";
import { parseReaisToCents } from "../../../lib/format";
import {
  Button,
  Card,
  Field,
  Input,
  RowCardList,
  Select,
  Table,
  TableRow,
  useToast,
} from "../../../components/ui";

/**
 * Card purchase entry. Lets the user record an expense on a card as à vista
 * (single charge) or parcelado (N installments). The generated parcels are shown
 * BEFORE saving via a server-side preview that runs the pure domain installment
 * generator — so no financial rule lives in this component.
 */

type CardOption = { id: string; name: string };
type CategoryOption = { id: string; name: string };
type SubcategoryOption = { id: string; categoryId: string; name: string };

function formatBrl(cents: number): string {
  return (cents / 100).toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
  });
}

/**
 * Parse a pt-BR or dot-decimal reais string into integer cents (>0).
 * Purchases must be strictly positive, so 0 is rejected on top of the shared
 * parser (which allows 0 for caixinha balances).
 */
function parsePositiveReaisToCents(value: string): number | null {
  const cents = parseReaisToCents(value);
  return cents === null || cents === 0 ? null : cents;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export function CardPurchaseForm({
  cards,
  categories,
  subcategories,
}: {
  cards: CardOption[];
  categories: CategoryOption[];
  subcategories: SubcategoryOption[];
}) {
  const [creditCardId, setCreditCardId] = useState<string>(cards[0]?.id ?? "");
  const [description, setDescription] = useState<string>("");
  const [amount, setAmount] = useState<string>("");
  const [mode, setMode] = useState<"avista" | "parcelado">("avista");
  const [installmentCount, setInstallmentCount] = useState<number>(2);
  const [purchasedOn, setPurchasedOn] = useState<string>(todayIso());
  const [categoryId, setCategoryId] = useState<string>("");
  const [subcategoryId, setSubcategoryId] = useState<string>("");

  const [parcels, setParcels] = useState<ParcelPreview[] | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [saveResult, setSaveResult] = useState<SaveResult | null>(null);
  const [isPreviewing, setIsPreviewing] = useState(false);
  const [isPending, startTransition] = useTransition();
  const toast = useToast();

  const effectiveCount = mode === "avista" ? 1 : installmentCount;

  const subsForCategory = useMemo(
    () => subcategories.filter((s) => s.categoryId === categoryId),
    [subcategories, categoryId],
  );

  function buildInput() {
    const totalCents = parsePositiveReaisToCents(amount);
    return { totalCents, creditCardId, description, purchasedOn };
  }

  async function onPreview() {
    setSaveResult(null);
    setPreviewError(null);
    const { totalCents } = buildInput();
    if (totalCents === null) {
      setParcels(null);
      setPreviewError("Informe um valor total válido maior que zero.");
      return;
    }
    setIsPreviewing(true);
    try {
      const result = await previewCardPurchase({
        creditCardId,
        description,
        totalCents,
        installmentCount: effectiveCount,
        purchasedOn,
        categoryId: categoryId || undefined,
        subcategoryId: subcategoryId || undefined,
      });
      if (!result.ok) {
        setParcels(null);
        setPreviewError(result.message);
        return;
      }
      setParcels(result.parcels);
    } finally {
      setIsPreviewing(false);
    }
  }

  function onSave() {
    setSaveResult(null);
    setPreviewError(null);
    const { totalCents } = buildInput();
    if (totalCents === null) {
      setPreviewError("Informe um valor total válido maior que zero.");
      return;
    }
    if (creditCardId === "") {
      setSaveResult({ ok: false, message: "Escolha o cartão antes de salvar." });
      return;
    }
    startTransition(async () => {
      const result = await saveCardPurchase({
        creditCardId,
        description,
        totalCents,
        installmentCount: effectiveCount,
        purchasedOn,
        categoryId: categoryId || undefined,
        subcategoryId: subcategoryId || undefined,
      });
      setSaveResult(result);
      if (result.ok) {
        setParcels(null);
        setDescription("");
        setAmount("");
        toast.success("Compra salva.");
      } else {
        toast.error(result.message);
      }
    });
  }

  const totalCents = parsePositiveReaisToCents(amount);

  return (
    <div id="compra" style={{ marginTop: 20 }}>
      <Card>
        <h2 className="ff-h2">Lançar compra no cartão</h2>
        <p className="ff-sub">
          Escolha <strong>à vista</strong> ou <strong>parcelado</strong>. As
          parcelas geradas aparecem abaixo <strong>antes</strong> de salvar.
        </p>

        {cards.length === 0 ? (
          <p className="ff-muted" style={{ marginTop: 14 }}>
            Cadastre um cartão acima antes de lançar uma compra.
          </p>
        ) : (
          <>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
                gap: 12,
                marginTop: 18,
              }}
            >
              <Field label="Cartão">
                <Select
                  value={creditCardId}
                  onChange={(e) => setCreditCardId(e.target.value)}
                >
                  {cards.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </Select>
              </Field>

              <Field label="Descrição">
                <Input
                  type="text"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Ex.: Geladeira"
                />
              </Field>

              <Field label="Valor total (R$)">
                <Input
                  type="text"
                  inputMode="decimal"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  placeholder="1.299,90"
                />
              </Field>

              <Field label="Data da compra">
                <Input
                  type="date"
                  value={purchasedOn}
                  onChange={(e) => setPurchasedOn(e.target.value)}
                />
              </Field>

              <Field label="Forma">
                <Select
                  value={mode}
                  onChange={(e) => setMode(e.target.value as "avista" | "parcelado")}
                >
                  <option value="avista">À vista</option>
                  <option value="parcelado">Parcelado</option>
                </Select>
              </Field>

              {mode === "parcelado" ? (
                <Field label="Nº de parcelas">
                  <Input
                    type="number"
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

              <Field label="Categoria (opcional)">
                <Select
                  value={categoryId}
                  onChange={(e) => {
                    setCategoryId(e.target.value);
                    setSubcategoryId("");
                  }}
                >
                  <option value="">(sem categoria)</option>
                  {categories.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </Select>
              </Field>

              <Field label="Subcategoria (opcional)">
                <Select
                  value={subcategoryId}
                  onChange={(e) => setSubcategoryId(e.target.value)}
                  disabled={categoryId === ""}
                >
                  <option value="">(nenhuma)</option>
                  {subsForCategory.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>

            <div style={{ display: "flex", gap: 12, marginTop: 18, flexWrap: "wrap" }}>
              <Button
                variant="ghost"
                loading={isPreviewing}
                loadingText="Gerando…"
                disabled={isPending}
                onClick={onPreview}
              >
                Ver parcelas
              </Button>
              <Button
                variant="primary"
                onClick={onSave}
                disabled={isPreviewing || creditCardId === ""}
                loading={isPending}
                loadingText="Salvando…"
              >
                Salvar compra
              </Button>
            </div>

            {previewError ? (
              <div
                role="alert"
                className="ff-alert ff-alert--negative"
                style={{ marginTop: 14 }}
              >
                {previewError}
              </div>
            ) : null}

            {saveResult ? (
              <div
                role="status"
                className={
                  saveResult.ok
                    ? "ff-alert ff-alert--positive"
                    : "ff-alert ff-alert--warn"
                }
                style={{ marginTop: 14 }}
              >
                {saveResult.message}
              </div>
            ) : null}

            {parcels ? (
              <div style={{ marginTop: 18 }}>
                <h3 className="ff-name" style={{ margin: "0 0 10px" }}>
                  Parcelas geradas ({parcels.length}){" "}
                  {totalCents !== null ? (
                    <span className="ff-note ff-num">
                      · total {formatBrl(totalCents)}
                    </span>
                  ) : null}
                </h3>
                <Table
                  columns={[
                    { key: "parcela", label: "Parcela" },
                    { key: "mes", label: "Mês (atribuição)" },
                    { key: "valor", label: "Valor", align: "right" },
                  ]}
                  gridTemplate="1fr 1.4fr 1fr"
                >
                  {parcels.map((p) => (
                    <TableRow key={p.number}>
                      <span className="ff-num">
                        {p.number}/{p.installmentCount}
                      </span>
                      <span className="ff-dim ff-num">{p.dueMonth}</span>
                      <span
                        className="ff-num"
                        style={{ textAlign: "right", fontWeight: 600 }}
                      >
                        {formatBrl(p.amountCents)}
                      </span>
                    </TableRow>
                  ))}
                </Table>
                <RowCardList>
                  {parcels.map((p) => (
                    <Card key={p.number} className="ff-rowcard">
                      <div className="ff-txrow__main">
                        <div className="ff-txrow__desc ff-num">
                          {p.number}/{p.installmentCount}
                        </div>
                        <div className="ff-txrow__meta ff-num">{p.dueMonth}</div>
                      </div>
                      <div className="ff-txrow__amount ff-num">
                        {formatBrl(p.amountCents)}
                      </div>
                    </Card>
                  ))}
                </RowCardList>
              </div>
            ) : null}
          </>
        )}
      </Card>
    </div>
  );
}
