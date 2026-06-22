"use client";

import { useMemo, useState, useTransition } from "react";

import {
  previewCardPurchase,
  saveCardPurchase,
  type ParcelPreview,
  type SaveResult,
} from "./actions";

/**
 * Card purchase entry. Lets the user record an expense on a card as à vista
 * (single charge) or parcelado (N installments). The generated parcels are shown
 * BEFORE saving via a server-side preview that runs the pure domain installment
 * generator — so no financial rule lives in this component.
 */

type CardOption = { id: string; name: string };
type CategoryOption = { id: string; name: string };
type SubcategoryOption = { id: string; categoryId: string; name: string };

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

function formatBrl(cents: number): string {
  return (cents / 100).toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
  });
}

/** Parse a pt-BR or dot-decimal reais string into integer cents (>0). */
function parseReaisToCents(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }
  // Accept "1.234,56" (BR) and "1234.56" (dot-decimal).
  let normalized = trimmed.replace(/\s/g, "");
  if (normalized.includes(",")) {
    normalized = normalized.replace(/\./g, "").replace(",", ".");
  }
  const reais = Number.parseFloat(normalized);
  if (!Number.isFinite(reais) || reais <= 0) {
    return null;
  }
  return Math.round(reais * 100);
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
  const [isPending, startTransition] = useTransition();

  const effectiveCount = mode === "avista" ? 1 : installmentCount;

  const subsForCategory = useMemo(
    () => subcategories.filter((s) => s.categoryId === categoryId),
    [subcategories, categoryId],
  );

  function buildInput() {
    const totalCents = parseReaisToCents(amount);
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
      }
    });
  }

  const totalCents = parseReaisToCents(amount);

  return (
    <div style={card}>
      <h2 style={{ marginTop: 0, fontSize: 18 }}>Lançar compra no cartão</h2>
      <p style={{ color: "#6b7280", fontSize: 14, marginTop: 0 }}>
        Escolha <strong>à vista</strong> ou <strong>parcelado</strong>. As
        parcelas geradas aparecem abaixo <strong>antes</strong> de salvar.
      </p>

      {cards.length === 0 ? (
        <p style={{ color: "#8a6d00", fontSize: 13 }}>
          Cadastre um cartão acima antes de lançar uma compra.
        </p>
      ) : (
        <>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
              gap: 12,
            }}
          >
            <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13 }}>
              Cartão
              <select
                value={creditCardId}
                onChange={(e) => setCreditCardId(e.target.value)}
                style={inputStyle}
              >
                {cards.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>

            <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13 }}>
              Descrição
              <input
                type="text"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Ex.: Geladeira"
                style={inputStyle}
              />
            </label>

            <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13 }}>
              Valor total (R$)
              <input
                type="text"
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="1.299,90"
                style={inputStyle}
              />
            </label>

            <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13 }}>
              Data da compra
              <input
                type="date"
                value={purchasedOn}
                onChange={(e) => setPurchasedOn(e.target.value)}
                style={inputStyle}
              />
            </label>

            <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13 }}>
              Forma
              <select
                value={mode}
                onChange={(e) => setMode(e.target.value as "avista" | "parcelado")}
                style={inputStyle}
              >
                <option value="avista">À vista</option>
                <option value="parcelado">Parcelado</option>
              </select>
            </label>

            {mode === "parcelado" ? (
              <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13 }}>
                Nº de parcelas
                <input
                  type="number"
                  min={2}
                  max={48}
                  step={1}
                  value={installmentCount}
                  onChange={(e) =>
                    setInstallmentCount(Math.max(2, Number.parseInt(e.target.value || "2", 10)))
                  }
                  style={inputStyle}
                />
              </label>
            ) : null}

            <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13 }}>
              Categoria (opcional)
              <select
                value={categoryId}
                onChange={(e) => {
                  setCategoryId(e.target.value);
                  setSubcategoryId("");
                }}
                style={inputStyle}
              >
                <option value="">(sem categoria)</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>

            <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13 }}>
              Subcategoria (opcional)
              <select
                value={subcategoryId}
                onChange={(e) => setSubcategoryId(e.target.value)}
                disabled={categoryId === ""}
                style={inputStyle}
              >
                <option value="">(nenhuma)</option>
                {subsForCategory.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div style={{ display: "flex", gap: 12, marginTop: 16, flexWrap: "wrap" }}>
            <button type="button" onClick={onPreview} style={btnGhost}>
              Ver parcelas
            </button>
            <button
              type="button"
              onClick={onSave}
              disabled={isPending || creditCardId === ""}
              style={btn}
            >
              {isPending ? "Salvando…" : "Salvar compra"}
            </button>
          </div>

          {previewError ? (
            <div
              role="alert"
              style={{
                background: "#fdecec",
                border: "1px solid #f3b4b4",
                color: "#8a2020",
                borderRadius: 10,
                padding: 12,
                marginTop: 12,
                fontSize: 14,
              }}
            >
              {previewError}
            </div>
          ) : null}

          {saveResult ? (
            <div
              role="status"
              style={{
                background: saveResult.ok ? "#e9f7ef" : "#fff6e6",
                border: `1px solid ${saveResult.ok ? "#9bd9b4" : "#f0d28a"}`,
                color: saveResult.ok ? "#15633a" : "#7a5a00",
                borderRadius: 10,
                padding: 12,
                marginTop: 12,
                fontSize: 14,
              }}
            >
              {saveResult.message}
            </div>
          ) : null}

          {parcels ? (
            <div style={{ marginTop: 16 }}>
              <h3 style={{ fontSize: 15, marginBottom: 8 }}>
                Parcelas geradas ({parcels.length}){" "}
                {totalCents !== null ? (
                  <span style={{ color: "#6b7280", fontWeight: 400 }}>
                    · total {formatBrl(totalCents)}
                  </span>
                ) : null}
              </h3>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                <thead>
                  <tr style={{ textAlign: "left", color: "#6b7280" }}>
                    <th style={{ padding: "6px 8px" }}>Parcela</th>
                    <th style={{ padding: "6px 8px" }}>Mês (atribuição)</th>
                    <th style={{ padding: "6px 8px", textAlign: "right" }}>Valor</th>
                  </tr>
                </thead>
                <tbody>
                  {parcels.map((p) => (
                    <tr key={p.number} style={{ borderTop: "1px solid #f0f2f4" }}>
                      <td style={{ padding: "6px 8px" }}>
                        {p.number}/{p.installmentCount}
                      </td>
                      <td style={{ padding: "6px 8px" }}>{p.dueMonth}</td>
                      <td style={{ padding: "6px 8px", textAlign: "right" }}>
                        {formatBrl(p.amountCents)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </>
      )}
    </div>
  );
}
