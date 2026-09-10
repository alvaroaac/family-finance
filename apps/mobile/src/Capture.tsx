import React, { useState } from "react";
import {
  View,
  ScrollView,
  TextInput,
  KeyboardAvoidingView,
  Platform,
} from "react-native";
import { X, ArrowRight, Check, Sparkles, ArrowLeft } from "lucide-react-native";
import { useTheme } from "./theme";
import {
  categories,
  payments,
  demoDate,
  parseQuickEntry,
  parseMoney,
  money,
  type Entry,
} from "./finance";
import { Label, Button, IconButton, Field, Chip, Card, s } from "./ui";
export type CaptureDraft = {
  step: "entry" | "review";
  text: string;
  description: string;
  amount: string;
  category: string;
  payment: string;
  kind: "expense" | "income";
  date: string;
};
export const emptyCapture: CaptureDraft = {
  step: "entry",
  text: "",
  description: "",
  amount: "",
  category: "Outros",
  payment: "Conta principal",
  kind: "expense",
  date: demoDate,
};
export function Capture({
  onClose,
  onSave,
  draft,
  setDraft,
}: {
  onClose: () => void;
  onSave: (entry: Entry) => void;
  draft: CaptureDraft;
  setDraft: React.Dispatch<React.SetStateAction<CaptureDraft>>;
}) {
  const { tokens: t } = useTheme();
  const { step, text, description, amount, category, payment, kind, date } =
    draft;
  const update = <K extends keyof CaptureDraft>(
    key: K,
    value: CaptureDraft[K],
  ) => setDraft((d) => ({ ...d, [key]: value }));
  const setStep = (v: CaptureDraft["step"]) => update("step", v),
    setText = (v: string) => update("text", v),
    setDescription = (v: string) => update("description", v),
    setAmount = (v: string) => update("amount", v),
    setCategory = (v: string) => update("category", v),
    setPayment = (v: string) => update("payment", v),
    setKind = (v: CaptureDraft["kind"]) => update("kind", v),
    setDate = (v: string) => update("date", v);
  const [saved, setSaved] = useState(false);
  function interpret(value = text) {
    const draft = parseQuickEntry(value);
    setDescription(draft.description ?? "");
    setAmount(
      draft.amountCents
        ? (draft.amountCents / 100).toFixed(2).replace(".", ",")
        : "",
    );
    setCategory(draft.category ?? "Outros");
    setPayment(draft.payment ?? "Conta principal");
    setKind(draft.kind ?? "expense");
    setDate(draft.date ?? demoDate);
    setStep("review");
  }
  const cents = parseMoney(amount);
  const valid = cents !== null && description.trim().length > 0;
  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : "height"}
      style={{ flex: 1 }}
    >
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={s.content}
      >
        <View style={s.between}>
          <Label style={s.eyebrow} color={t.accent}>
            NOVO LANÇAMENTO
          </Label>
          <IconButton
            icon={X}
            label="Fechar lançamento; manter rascunho"
            onPress={onClose}
          />
        </View>
        {step === "entry" ? (
          <>
            <View style={{ gap: 8 }}>
              <Label serif size={36}>
                Conta pra Casa.
              </Label>
              <Label muted>Do seu jeito. A gente organiza os detalhes.</Label>
            </View>
            <View
              style={{
                backgroundColor: t.surface,
                borderRadius: 22,
                borderWidth: 1,
                borderColor: t.border,
                padding: 20,
                gap: 18,
              }}
            >
              <TextInput
                autoFocus
                value={text}
                onChangeText={setText}
                multiline
                accessibilityLabel="Descreva seu lançamento"
                placeholder={"Ex.: Giassi 180 no Nubank"}
                placeholderTextColor={t.muted}
                style={{
                  color: t.ink,
                  fontFamily: t.display,
                  fontSize: 25,
                  lineHeight: 36,
                  minHeight: 112,
                  textAlignVertical: "top",
                }}
              />
              <View style={s.row}>
                <Sparkles size={16} color={t.accent} />
                <Label muted size={11}>
                  Categoria e pagamento sugeridos para você
                </Label>
              </View>
            </View>
            <Button
              onPress={() => interpret()}
              disabled={!text.trim()}
              icon={ArrowRight}
            >
              Revisar lançamento
            </Button>
            <Label muted size={12}>
              Experimente um exemplo
            </Label>
            <View style={s.wrap}>
              {["Giassi 180 no Nubank", "Recebi freela 2500", "Uber 24,90"].map(
                (example) => (
                  <Chip
                    key={example}
                    onPress={() => {
                      setText(example);
                      interpret(example);
                    }}
                  >
                    {example}
                  </Chip>
                ),
              )}
            </View>
            <Button secondary onPress={() => setStep("review")}>
              Prefiro preencher os campos
            </Button>
            <Label muted size={11}>
              Protótipo com sugestões locais. Use o ditado do teclado para
              falar. Nenhum dado será enviado ou salvo na sua conta.
            </Label>
          </>
        ) : (
          <>
            <View style={{ gap: 6 }}>
              <Label serif size={32}>
                Tudo certinho?
              </Label>
              <Label muted>Ajuste o que precisar antes de adicionar.</Label>
            </View>
            <View style={s.wrap}>
              <Chip
                active={kind === "expense"}
                onPress={() => {
                  setKind("expense");
                  if (category === "Receitas") setCategory("Outros");
                }}
              >
                Despesa
              </Chip>
              <Chip
                active={kind === "income"}
                onPress={() => {
                  setKind("income");
                  setCategory("Receitas");
                  setPayment("Conta principal");
                }}
              >
                Receita
              </Chip>
            </View>
            <Field
              label="Valor (R$)"
              value={amount}
              onChangeText={setAmount}
              keyboardType="decimal-pad"
              placeholder="0,00"
              style={{ fontSize: 34, fontFamily: t.display, minHeight: 72 }}
            />
            <Field
              label="Descrição"
              value={description}
              onChangeText={setDescription}
              placeholder="Onde ou o quê?"
            />
            <View style={{ gap: 10 }}>
              <View style={s.row}>
                <Label muted size={12}>
                  Categoria
                </Label>
                <Sparkles size={13} color={t.accent} />
              </View>
              <View style={s.wrap}>
                {categories
                  .filter((c) =>
                    kind === "income"
                      ? c === "Receitas" || c === "Outros"
                      : c !== "Receitas",
                  )
                  .map((c) => (
                    <Chip
                      key={c}
                      active={category === c}
                      onPress={() => setCategory(c)}
                    >
                      {c}
                    </Chip>
                  ))}
              </View>
              {category === "Outros" ? (
                <Label muted size={11}>
                  Sem uma sugestão segura. Escolha a categoria acima.
                </Label>
              ) : null}
            </View>
            <View style={{ gap: 10 }}>
              <Label muted size={12}>
                Pagamento
              </Label>
              <View style={s.wrap}>
                {(kind === "income" ? ["Conta principal"] : payments).map(
                  (p) => (
                    <Chip
                      key={p}
                      active={payment === p}
                      onPress={() => setPayment(p)}
                    >
                      {p}
                    </Chip>
                  ),
                )}
              </View>
            </View>
            <View style={{ gap: 10 }}>
              <Label muted size={12}>
                Data · setembro de 2026 (demonstração)
              </Label>
              <View style={s.wrap}>
                <Chip
                  active={date === demoDate}
                  onPress={() => setDate(demoDate)}
                >
                  Hoje, 5 set
                </Chip>
                <Chip
                  active={date === "2026-09-04"}
                  onPress={() => setDate("2026-09-04")}
                >
                  Ontem, 4 set
                </Chip>
              </View>
            </View>
            <Card>
              <Label muted size={12}>
                Será adicionado apenas aos dados de demonstração.
              </Label>
              <Label bold>
                {cents ? money(cents) : "Informe um valor válido"} · {category}
              </Label>
            </Card>
            <Button secondary icon={ArrowLeft} onPress={() => setStep("entry")}>
              Voltar ao texto
            </Button>
          </>
        )}
      </ScrollView>
      {step === "review" ? (
        <View
          style={{
            padding: 16,
            paddingTop: 12,
            gap: 8,
            borderTopWidth: 0.5,
            borderTopColor: t.border,
            backgroundColor: t.bg,
          }}
        >
          <Label muted size={10} style={{ textAlign: "center" }}>
            Somente na demonstração
          </Label>{" "}
          <Button
            icon={Check}
            label="Adicionar lançamento"
            disabled={!valid || saved}
            onPress={() => {
              if (!cents || saved) return;
              setSaved(true);
              onSave({
                id: `demo-${Date.now()}`,
                description: description.trim(),
                amountCents: cents,
                category,
                payment,
                kind,
                date,
              });
            }}
          >
            {cents ? `Adicionar • ${money(cents)}` : "Adicionar lançamento"}
          </Button>
        </View>
      ) : null}
    </KeyboardAvoidingView>
  );
}
