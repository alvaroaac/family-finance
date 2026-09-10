import { createCaptureCategory } from "./createCaptureCategory";
import { DateField } from "./DateField";
import { VoiceCapture } from "./VoiceCapture";
import { useRef, useState } from "react";
import { View, ScrollView, KeyboardAvoidingView, Platform } from "react-native";
import { randomUUID } from "expo-crypto";
import type {
  Catalog,
  Choice,
  EntryInput,
} from "@family-finance/mobile-contracts";
import { entrySchema } from "@family-finance/mobile-contracts";
import { CasaApi, ApiError } from "./api";
import { Button, Card, Chip, Field, Label, s } from "./ui";
import { parseMoney, money } from "./finance";
export function Choices({
  label,
  items,
  value,
  onChange,
  optional = false,
}: {
  label: string;
  items: Choice[];
  value: string | null;
  onChange: (id: string | null) => void;
  optional?: boolean;
}) {
  return (
    <View style={{ gap: 8 }}>
      <Label muted size={12}>
        {label}
      </Label>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ gap: 8 }}
      >
        {optional && (
          <Chip active={!value} onPress={() => onChange(null)}>
            Nenhum
          </Chip>
        )}
        {items
          .filter((i) => i.isActive !== false || i.id === value)
          .map((i) => (
            <Chip
              key={i.id}
              active={value === i.id}
              onPress={() => onChange(i.id)}
            >
              {i.name}
            </Chip>
          ))}
      </ScrollView>
    </View>
  );
}
export function useLiveCaptureState() {
  const [draft, setDraft] = useState<EntryInput>(() => ({
    id: randomUUID(),
    description: "",
    amountCents: 0,
    kind: "expense",
    date: "",
    categoryId: null,
    subcategoryId: null,
    accountId: null,
    creditCardId: null,
    responsibleUserId: null,
    installmentCount: 1,
  }));
  const [text, setText] = useState("");
  const [amount, setAmount] = useState("");
  const [count, setCount] = useState("1");
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const [message, setMessage] = useState("");
  const [uncertain, setUncertain] = useState(false);
  return {
    draft,
    setDraft,
    text,
    setText,
    amount,
    setAmount,
    count,
    setCount,
    busy,
    setBusy,
    lock,
    message,
    setMessage,
    uncertain,
    setUncertain,
  };
}
export function LiveCapture({
  api,
  catalog,
  state,
  onSaved,
  onClose,
  onCatalogRefresh,
}: {
  api: CasaApi;
  catalog: Catalog;
  state: ReturnType<typeof useLiveCaptureState>;
  onSaved: () => void;
  onClose: () => void;
  onCatalogRefresh?: () => Promise<Catalog>;
}) {
  const {
    draft,
    setDraft,
    text,
    setText,
    amount,
    setAmount,
    count,
    setCount,
    busy,
    setBusy,
    lock,
    message,
    setMessage,
    uncertain,
    setUncertain,
  } = state;
  const [addingCategory, setAddingCategory] = useState(false);
  const [categoryName, setCategoryName] = useState("");
  const [categoryError, setCategoryError] = useState("");
  const [createdCategories, setCreatedCategories] = useState<Choice[]>([]);
  async function addCategory() {
    if (lock.current || uncertain) return;
    lock.current = true;
    setBusy(true);
    setCategoryError("");
    try {
      const category = await createCaptureCategory(
        categoryName,
        async () => (onCatalogRefresh ? await onCatalogRefresh() : (await api.load()).catalog).categories,
        (name) => api.action({ action: "categories.create", fields: { name } }),
      );
      setCreatedCategories((rows) => [...rows.filter((row) => row.id !== category.id), category]);
      setDraft((value) => ({ ...value, categoryId: category.id, subcategoryId: null }));
      setAddingCategory(false);
      setCategoryName("");
    } catch (error) {
      setCategoryError(error instanceof Error ? error.message : "Não foi possível criar a categoria. Tente novamente.");
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  const patch = (p: Partial<EntryInput>) => setDraft((d) => ({ ...d, ...p }));
  async function suggest() {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setMessage("");
    try {
      const result = await api.suggest(text);
      if (
        result.intent &&
        !["plain", "card_installment"].includes(result.intent)
      ) {
        setMessage(
          "Este pedido é sobre um compromisso. Abra Mais → Compromissos para revisar e registrar.",
        );
        return;
      }
      patch({
        description: result.description,
        amountCents: result.amountCents ?? 0,
        date: result.date,
        kind: result.kind,
        categoryId: result.categoryId,
        subcategoryId: result.subcategoryId,
        accountId: result.accountId,
        creditCardId: result.creditCardId,
        installmentCount: result.installmentCount,
      });
      setAmount(
        result.amountCents
          ? String(result.amountCents / 100).replace(".", ",")
          : "",
      );
      setCount(String(result.installmentCount));
      setMessage(result.explanation);
    } catch (e) {
      setMessage(
        e instanceof Error
          ? e.message
          : "Não foi possível interpretar. Preencha abaixo.",
      );
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  async function save() {
    if (lock.current) return;
    const parsed = entrySchema.safeParse({
      ...draft,
      amountCents: parseMoney(amount),
      installmentCount: Number(count),
    });
    if (!parsed.success) {
      setMessage(parsed.error.issues[0]?.message ?? "Confira os campos.");
      return;
    }
    lock.current = true;
    setBusy(true);
    setMessage("");
    try {
      await api.save(parsed.data);
      onSaved();
    } catch (e) {
      setUncertain(
        !(e instanceof ApiError) ||
          e.status === 0 ||
          e.status >= 500 ||
          e.status === 409,
      );
      setMessage(e instanceof Error ? e.message : "Não foi possível salvar.");
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <KeyboardAvoidingView
      style={{ flex: 1 }}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={s.content}
      >
        <View style={s.between}>
          <Label serif size={29}>
            Nova movimentação
          </Label>
          <Button secondary small onPress={onClose} disabled={busy}>
            Fechar
          </Button>
        </View>
        <Label muted>Conte como foi. Revise os detalhes e confirme.</Label>
        <Card>
          <Field
            label="O que aconteceu?"
            value={text}
            onChangeText={setText}
            placeholder="Gastei 85 no mercado, no Nubank"
            editable={!busy && !uncertain}
            multiline
          />
          <Button
            secondary
            onPress={() => void suggest()}
            disabled={busy || !text.trim() || uncertain}
          >
            {busy ? "Aguarde…" : "Preencher para mim"}
          </Button>
        </Card>
        {Platform.OS !== "web" && (
          <VoiceCapture
            api={api}
            disabled={busy || uncertain}
            onText={setText}
            onBusy={setBusy}
          />
        )}
        <View style={s.row}>
          {(["expense", "income"] as const).map((k) => (
            <Chip
              key={k}
              active={draft.kind === k}
              onPress={() => {
                if (!busy && !uncertain) {
                  patch({ kind: k, creditCardId: null, installmentCount: 1 });
                  setCount("1");
                }
              }}
            >
              {k === "expense" ? "Despesa" : "Receita"}
            </Chip>
          ))}
        </View>
        <Field
          label="Valor total (R$)"
          value={amount}
          onChangeText={setAmount}
          keyboardType="decimal-pad"
          editable={!busy && !uncertain}
        />
        <Field
          label="Descrição"
          value={draft.description}
          onChangeText={(description) => patch({ description })}
          editable={!busy && !uncertain}
        />
        <DateField
          label="Data (DD/MM/AAAA)"
          value={draft.date}
          onChangeText={(date) => patch({ date })}
          editable={!busy && !uncertain}
        />
        <View
          pointerEvents={busy || uncertain ? "none" : "auto"}
          style={{ gap: 18 }}
        >
          <Choices
            label="Categoria"
            items={[...catalog.categories, ...createdCategories.filter((row) => !catalog.categories.some((item) => item.id === row.id))]}
            value={draft.categoryId}
            onChange={(categoryId) =>
              patch({ categoryId, subcategoryId: null })
            }
            optional
          />
          {addingCategory ? (
            <Card>
              <Field
                label="Nome da nova categoria"
                placeholder="Ex.: Educação"
                value={categoryName}
                onChangeText={setCategoryName}
                maxLength={100}
                editable={!busy}
                returnKeyType="done"
                onSubmitEditing={() => void addCategory()}
              />
              {categoryError ? <Label>{categoryError}</Label> : null}
              <Button disabled={busy || !categoryName.trim()} onPress={() => void addCategory()}>
                {busy ? "Criando categoria…" : "Criar e selecionar"}
              </Button>
              <Button secondary disabled={busy} onPress={() => { setAddingCategory(false); setCategoryError(""); }}>
                Cancelar
              </Button>
            </Card>
          ) : (
            <Button secondary small disabled={busy || uncertain} onPress={() => { setAddingCategory(true); setCategoryError(""); }}>
              Nova categoria
            </Button>
          )}
          {draft.categoryId && (
            <Choices
              label="Subcategoria"
              items={catalog.subcategories.filter(
                (i) => i.parentId === draft.categoryId,
              )}
              value={draft.subcategoryId}
              onChange={(subcategoryId) => patch({ subcategoryId })}
              optional
            />
          )}
          <Choices
            label="Conta"
            items={catalog.accounts}
            value={draft.accountId}
            onChange={(accountId) => {
              patch({ accountId, creditCardId: null, installmentCount: 1 });
              setCount("1");
            }}
          />
          {draft.kind === "expense" && (
            <Choices
              label="Cartão"
              items={catalog.cards}
              value={draft.creditCardId}
              onChange={(creditCardId) =>
                patch({ creditCardId, accountId: null })
              }
            />
          )}
          <Choices
            label="Responsável"
            items={catalog.members}
            value={draft.responsibleUserId}
            onChange={(responsibleUserId) => patch({ responsibleUserId })}
            optional
          />
        </View>
        {draft.creditCardId && (
          <Field
            label="Número de parcelas"
            value={count}
            onChangeText={setCount}
            keyboardType="number-pad"
            editable={!busy && !uncertain}
          />
        )}
        <Label muted>
          {Number(count) > 1
            ? `${count} parcelas · total ${money(parseMoney(amount) ?? 0)}`
            : "Um lançamento"}
        </Label>
        {uncertain && (
          <Label muted>
            Os detalhes ficaram bloqueados para repetir com a mesma
            identificação, sem duplicar. Fechar mantém este rascunho.
          </Label>
        )}
      </ScrollView>
      <View style={{ padding: 20, gap: 10 }}>
        {message ? <Label>{message}</Label> : null}
        <Button onPress={() => void save()} disabled={busy || addingCategory}>
          {busy
            ? "Aguarde…"
            : uncertain
              ? "Tentar salvar o mesmo lançamento"
              : "Confirmar lançamento"}
        </Button>
      </View>
    </KeyboardAvoidingView>
  );
}
