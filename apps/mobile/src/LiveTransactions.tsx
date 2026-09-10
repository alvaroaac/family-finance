import { displayDate } from "./dates";
import { DateField } from "./DateField";
import { useRef, useState } from "react";
import { FlatList, View, Pressable, Modal, ScrollView } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import type { MobileEntry, MobileData } from "@family-finance/mobile-contracts";
import { CasaApi } from "./api";
import { Button, Card, Chip, Field, Label, s, useReducedMotion } from "./ui";
import { Choices } from "./LiveCapture";
import { useTheme } from "./theme";
import { money } from "./finance";
export function LiveTransactions({
  api,
  data,
  onRefresh,
}: {
  api: CasaApi;
  data: MobileData;
  onRefresh: () => Promise<void>;
}) {
  const reduceMotion = useReducedMotion();
  const { tokens: t } = useTheme();
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [entry, setEntry] = useState<MobileEntry | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [deleting, setDeleting] = useState(false);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const [message, setMessage] = useState("");
  function edit(e: MobileEntry) {
    setEntry(e);
    setFields({
      description: e.description,
      amount: String(e.amountCents / 100).replace(".", ","),
      occurredOn: e.date,
      categoryId: e.categoryId ?? "",
      subcategoryId: e.subcategoryId ?? "",
      responsible: e.responsibleUserId ?? "household",
      payment: e.creditCardId
        ? `card:${e.creditCardId}`
        : `account:${e.accountId}`,
    });
    setDeleting(false);
    setMessage("");
  }
  async function save() {
    if (!entry || lock.current) return;
    lock.current = true;
    setBusy(true);
    setMessage("");
    try {
      const patch = { ...fields };
      if (entry.kind === "transfer") delete patch.payment;
      await api.action({
        action: deleting ? "transactions.delete" : "transactions.update",
        fields: deleting
          ? { transactionId: entry.id }
          : { ...patch, transactionId: entry.id },
      });
      setEntry(null);
      await onRefresh();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Não foi possível concluir.");
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  const entries = data.entries.filter(
    (e) =>
      (filter === "all" || e.kind === filter) &&
      `${e.description} ${e.category} ${e.payment}`
        .toLocaleLowerCase()
        .includes(search.toLocaleLowerCase()),
  );
  return (
    <View style={{ flex: 1 }}>
      <View style={{ paddingHorizontal: 24, gap: 12, paddingBottom: 12 }}>
        <Field
          label="Buscar movimentações"
          value={search}
          onChangeText={setSearch}
          placeholder="Descrição, categoria ou conta"
        />
        <View style={s.row}>
          {[
            ["all", "Todos"],
            ["expense", "Gastos"],
            ["income", "Receitas"],
            ["transfer", "Transf."],
          ].map(([id, label]) => (
            <Chip
              key={id}
              active={filter === id}
              onPress={() => setFilter(id!)}
            >
              {label}
            </Chip>
          ))}
        </View>
      </View>
      <FlatList
        data={entries}
        keyExtractor={(e) => e.id}
        contentContainerStyle={{
          paddingHorizontal: 24,
          paddingBottom: 24,
          gap: 10,
        }}
        ListEmptyComponent={<Label muted>Nenhuma movimentação encontrada.</Label>}
        renderItem={({ item }) => (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Revisar ${item.description}`}
            onPress={() => edit(item)}
          >
            <Card>
              <View style={s.between}>
                <Label bold style={{ flex: 1 }}>
                  {item.description}
                </Label>
                <Label color={item.kind === "income" ? t.positive : t.ink}>
                  {item.kind === "income" ? "+" : ""}
                  {money(item.amountCents)}
                </Label>
              </View>
              <Label muted size={11}>
                {displayDate(item.date)} · {item.category} · {item.payment}
              </Label>
            </Card>
          </Pressable>
        )}
      />
      <Modal
        visible={!!entry}
        animationType={reduceMotion ? "none" : "slide"}
        presentationStyle="pageSheet"
        onRequestClose={() => setEntry(null)}
      >
        <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }}>
          <ScrollView
            contentContainerStyle={s.content}
            keyboardShouldPersistTaps="handled"
            automaticallyAdjustKeyboardInsets
          >
            <Label serif size={30}>
              {deleting ? "Excluir movimentação?" : "Revisar movimentação"}
            </Label>
            {entry?.installmentId ? (
              <Label>
                Este lançamento faz parte de um parcelamento. A edição
                individual não está disponível para preservar o total da compra.
              </Label>
            ) : (
              <>
                <View
                  pointerEvents={busy ? "none" : "auto"}
                  style={{ gap: 18 }}
                >
                  {deleting ? (
                    <Label>
                      Excluir {entry?.description} de{" "}
                      {money(entry?.amountCents ?? 0)}? A alteração será
                      aplicada à sua casa.
                    </Label>
                  ) : (
                    <>
                      <Field
                        label="Descrição"
                        value={fields.description ?? ""}
                        onChangeText={(v) =>
                          setFields((f) => ({ ...f, description: v }))
                        }
                      />
                      <Field
                        label="Valor (R$)"
                        keyboardType="decimal-pad"
                        value={fields.amount ?? ""}
                        onChangeText={(v) =>
                          setFields((f) => ({ ...f, amount: v }))
                        }
                      />
                      <DateField
                        label="Data (DD/MM/AAAA)"
                        value={fields.occurredOn ?? ""}
                        onChangeText={(v) =>
                          setFields((f) => ({ ...f, occurredOn: v }))
                        }
                      />
                      <Choices
                        label="Categoria"
                        items={data.catalog.categories}
                        value={fields.categoryId ?? null}
                        optional
                        onChange={(id) =>
                          setFields((f) => ({
                            ...f,
                            categoryId: id ?? "",
                            subcategoryId: "",
                          }))
                        }
                      />
                      <Choices
                        label="Subcategoria"
                        items={data.catalog.subcategories.filter(
                          (c) => c.parentId === fields.categoryId,
                        )}
                        value={fields.subcategoryId ?? null}
                        optional
                        onChange={(id) =>
                          setFields((f) => ({ ...f, subcategoryId: id ?? "" }))
                        }
                      />
                      <Choices
                        label="Responsável"
                        items={[
                          { id: "household", name: "Casa" },
                          ...data.catalog.members,
                        ]}
                        value={fields.responsible ?? null}
                        onChange={(id) =>
                          setFields((f) => ({
                            ...f,
                            responsible: id ?? "household",
                          }))
                        }
                      />
                      {entry?.kind !== "transfer" && (
                        <Choices
                          label="Pagamento"
                          items={[
                            ...data.catalog.accounts.map((a) => ({
                              ...a,
                              id: `account:${a.id}`,
                            })),
                            ...(entry?.kind === "expense"
                              ? data.catalog.cards.map((c) => ({
                                  ...c,
                                  id: `card:${c.id}`,
                                }))
                              : []),
                          ]}
                          value={fields.payment ?? null}
                          onChange={(id) =>
                            setFields((f) => ({ ...f, payment: id ?? "" }))
                          }
                        />
                      )}
                    </>
                  )}
                </View>
                {message ? <Label>{message}</Label> : null}
                <Button disabled={busy} onPress={() => void save()}>
                  {busy
                    ? "Salvando…"
                    : deleting
                      ? "Confirmar exclusão"
                      : "Salvar alterações"}
                </Button>
                {!deleting && (
                  <Button
                    secondary
                    disabled={busy}
                    onPress={() => setDeleting(true)}
                  >
                    Excluir movimentação
                  </Button>
                )}
              </>
            )}
            <Button secondary disabled={busy} onPress={() => setEntry(null)}>
              Fechar
            </Button>
          </ScrollView>
        </SafeAreaView>
      </Modal>
    </View>
  );
}
