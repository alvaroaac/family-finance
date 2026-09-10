import { useState } from "react";
import {
  View,
  Pressable,
  TextInput,
  FlatList,
  useWindowDimensions,
} from "react-native";
import {
  ArrowUpRight,
  ChevronRight,
  CalendarDays,
  House,
  Search,
  Wallet,
  CreditCard,
  Leaf,
  Sun,
  Moon,
  Upload,
  Settings,
  X,
} from "lucide-react-native";
import { type Entry, money, totals, snapshotWithEntries } from "./finance";
import { useTheme } from "./theme";
import {
  Label,
  Card,
  Button,
  EntryRow,
  Section,
  Chip,
  IconButton,
  Stat,
  categoryIcons,
  s,
} from "./ui";
export function Home({
  entries,
  onTransactions,
  onSimulate,
}: {
  entries: Entry[];
  onTransactions: () => void;
  onSimulate: () => void;
}) {
  const { tokens: t } = useTheme();
  const compact = useWindowDimensions().width < 370;
  const snapshot = snapshotWithEntries(entries);
  const sums = totals(entries);
  const future = snapshot.months[0]!;
  return (
    <>
      <View style={{ gap: 5 }}>
        <Label color={t.accent} style={s.eyebrow}>
          SÁBADO, 5 DE SETEMBRO
        </Label>
        <Label serif size={35}>
          Mais leve, em casa.
        </Label>
        <Label muted size={13}>
          Um olhar tranquilo para o seu dinheiro.
        </Label>
      </View>
      <Card style={{ padding: 24, overflow: "hidden" }}>
        <View
          style={{
            position: "absolute",
            right: -35,
            top: -45,
            width: 180,
            height: 180,
            borderRadius: 100,
            borderWidth: 1,
            borderColor: t.border,
          }}
        />
        <View
          style={{
            position: "absolute",
            right: -10,
            top: -20,
            width: 130,
            height: 130,
            borderRadius: 100,
            borderWidth: 1,
            borderColor: t.border,
          }}
        />
        <View style={s.between}>
          <Label muted size={12}>
            Disponível nas contas
          </Label>
          <Wallet size={20} color={t.accent} strokeWidth={1.4} />
        </View>
        <Label serif size={compact ? 30 : 43}>
          {money(snapshot.openingCashCents)}
        </Label>
        <View style={s.row}>
          <View
            style={{
              width: 6,
              height: 6,
              backgroundColor: t.positive,
              borderRadius: 3,
            }}
          />
          <Label muted size={11}>
            Saldo demonstrativo · 5 set 2026
          </Label>
        </View>
        <View
          style={[s.divider, { backgroundColor: t.border, marginVertical: 4 }]}
        />
        <View style={s.row}>
          <Stat label="Entrou no mês" value={sums.income} positive />
          <View style={{ width: 1, height: 36, backgroundColor: t.border }} />
          <Stat label="Saiu no mês¹" value={sums.expense} />
        </View>
      </Card>
      <View style={{ gap: 12 }}>
        <Section title="O mês pela frente" />
        <View style={s.row}>
          <Card style={{ flex: 1, padding: 16, minHeight: 125 }}>
            <CalendarDays size={20} color={t.accent} strokeWidth={1.5} />
            <Label muted size={11}>
              Saídas previstas
            </Label>
            <Label bold size={compact ? 15 : 20}>
              {money(future.outflowCents)}
            </Label>
          </Card>
          <Card style={{ flex: 1, padding: 16, minHeight: 125 }}>
            <ArrowUpRight size={20} color={t.positive} strokeWidth={1.5} />
            <Label muted size={11}>
              Ainda vai entrar
            </Label>
            <Label bold size={compact ? 15 : 20}>
              {money(future.incomeCents)}
            </Label>
          </Card>
        </View>
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Explorar uma simulação"
        onPress={onSimulate}
        style={({ pressed }) => ({
          backgroundColor: t.tint,
          borderWidth: 1,
          borderColor: t.border,
          borderRadius: t.radius,
          padding: 20,
          opacity: pressed ? 0.75 : 1,
        })}
      >
        <View style={s.row}>
          <View
            style={{
              height: 42,
              width: 42,
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Leaf color={t.accent} size={29} strokeWidth={1.25} />
          </View>
          <View style={{ flex: 1, gap: 4 }}>
            <Label serif size={21}>
              E se couber nos planos?
            </Label>
            <Label muted size={11}>
              Experimente uma ideia para o futuro.
            </Label>
          </View>
          <ArrowUpRight size={20} color={t.accent} />
        </View>
      </Pressable>
      <View>
        <Section
          title="Últimas movimentações"
          action="Ver todos"
          onPress={onTransactions}
        />
        {entries.slice(0, 3).map((e) => (
          <EntryRow key={e.id} entry={e} />
        ))}
      </View>
      <Label muted size={10}>
        ¹ Compras registradas, inclusive no cartão. Não representa apenas saída
        de caixa. Todos os valores são exemplos.
      </Label>
    </>
  );
}
export function Transactions({ entries }: { entries: Entry[] }) {
  const { tokens: t } = useTheme();
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("Todos");
  const filtered = entries.filter(
    (e) =>
      (filter === "Todos" ||
        e.kind === (filter === "Receitas" ? "income" : "expense")) &&
      `${e.description} ${e.category} ${e.payment}`
        .toLocaleLowerCase("pt-BR")
        .includes(search.toLocaleLowerCase("pt-BR")),
  );
  return (
    <View style={{ flex: 1 }}>
      <View style={[s.content, { paddingBottom: 16 }]}>
        <View style={{ gap: 4 }}>
          <Label color={t.accent} style={s.eyebrow}>
            CADA DETALHE CONTA
          </Label>
          <Label serif size={34}>
            Movimentações
          </Label>
        </View>
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 10,
            borderWidth: 1,
            borderColor: t.border,
            borderRadius: 15,
            backgroundColor: t.surface,
            paddingHorizontal: 16,
          }}
        >
          <Search size={18} color={t.muted} />
          <TextInput
            accessibilityLabel="Buscar movimentações"
            placeholder="Buscar descrição, categoria ou conta"
            placeholderTextColor={t.muted}
            value={search}
            onChangeText={setSearch}
            style={{
              flex: 1,
              height: 52,
              color: t.ink,
              fontFamily: t.body,
              fontSize: 12,
            }}
          />
        </View>
        <View style={s.wrap}>
          {["Todos", "Despesas", "Receitas"].map((f) => (
            <Chip key={f} active={filter === f} onPress={() => setFilter(f)}>
              {f}
            </Chip>
          ))}
        </View>
        <View style={s.between}>
          <Label muted size={12}>
            Setembro 2026
          </Label>
          <Label muted size={11}>
            {filtered.length} lançamentos
          </Label>
        </View>
      </View>
      <FlatList
        data={filtered}
        keyExtractor={(e) => e.id}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingHorizontal: 24, paddingBottom: 30 }}
        renderItem={({ item }) => (
          <View>
            <Label muted size={10}>
              {item.date.slice(8)} SET
            </Label>
            <EntryRow entry={item} />
            <View
              style={[
                s.divider,
                { backgroundColor: t.border, marginBottom: 14 },
              ]}
            />
          </View>
        )}
        ListEmptyComponent={
          <Card>
            <Label serif size={23}>
              Nenhuma movimentação por aqui.
            </Label>
            <Label muted>
              Tente outra busca ou adicione um lançamento no botão +.
            </Label>
            <Button
              secondary
              onPress={() => {
                setSearch("");
                setFilter("Todos");
              }}
            >
              Limpar filtros
            </Button>
          </Card>
        }
      />
    </View>
  );
}
export function Reports({
  entries,
  subtitle = "Setembro 2026 · dados de demonstração",
}: {
  entries: Entry[];
  subtitle?: string;
}) {
  const { tokens: t } = useTheme();
  const [selected, setSelected] = useState<string | null>(null);
  const sums = totals(entries);
  const grouped = Object.entries(
    entries
      .filter((e) => e.kind === "expense")
      .reduce<
        Record<string, number>
      >((a, e) => ({ ...a, [e.category]: (a[e.category] ?? 0) + e.amountCents }), {}),
  ).sort((a, b) => b[1] - a[1]);
  return (
    <>
      <View style={{ gap: 6 }}>
        <Label color={t.accent} style={s.eyebrow}>
          ENXERGUE O QUE IMPORTA
        </Label>
        <Label serif size={36}>
          Seu dinheiro, claro.
        </Label>
        <Label muted>{subtitle}</Label>
      </View>
      <Card>
        <Label muted size={12}>
          Receitas menos gastos registrados
        </Label>
        <Label serif size={35}>
          {money(sums.income - sums.expense)}
        </Label>
        <Label muted size={11}>
          Este resultado não é seu saldo bancário.
        </Label>
        <View style={[s.divider, { backgroundColor: t.border }]} />
        <View style={s.row}>
          <Stat label="Receitas" value={sums.income} positive />
          <Stat label="Despesas" value={sums.expense} />
        </View>
      </Card>
      <View style={{ gap: 14 }}>
        <Section title="Para onde foi?" />
        <Label muted size={12}>
          Toque em uma categoria para ver os lançamentos.
        </Label>
        {grouped.map(([category, value]) => {
          const Icon = categoryIcons[category] ?? House;
          const active = selected === category;
          return (
            <Pressable
              key={category}
              accessibilityRole="button"
              accessibilityState={{ expanded: active }}
              accessibilityLabel={`Ver gastos em ${category}`}
              onPress={() => setSelected(active ? null : category)}
            >
              <Card style={{ gap: 12 }}>
                <View style={s.between}>
                  <View style={s.row}>
                    <Icon color={t.accent} size={18} />
                    <Label bold size={13}>
                      {category}
                    </Label>
                  </View>
                  <Label size={13}>{money(value)}</Label>
                </View>
                <View
                  style={{
                    height: 5,
                    backgroundColor: t.soft,
                    borderRadius: 10,
                  }}
                >
                  <View
                    style={{
                      width: `${sums.expense ? (value / sums.expense) * 100 : 0}%`,
                      height: 5,
                      backgroundColor: t.accent,
                      borderRadius: 10,
                    }}
                  />
                </View>
                <View style={s.between}>
                  <Label muted size={11}>
                    {Math.round((value / sums.expense) * 100)}% das despesas
                  </Label>
                  <ChevronRight size={14} color={t.muted} />
                </View>
                {active
                  ? entries
                      .filter(
                        (e) => e.category === category && e.kind === "expense",
                      )
                      .map((e) => <EntryRow key={e.id} entry={e} />)
                  : null}
              </Card>
            </Pressable>
          );
        })}
      </View>
      <Card>
        <View style={s.row}>
          <CreditCard color={t.accent} size={20} />
          <Label serif size={22}>
            Compras por pagamento
          </Label>
        </View>
        {[...new Set(entries.map((e) => e.payment))].map((p) => (
          <View key={p} style={s.between}>
            <Label size={12}>{p}</Label>
            <Label bold size={12}>
              {money(
                entries
                  .filter((e) => e.payment === p && e.kind === "expense")
                  .reduce((s, e) => s + e.amountCents, 0),
              )}
            </Label>
          </View>
        ))}
        <Label muted size={11}>
          Compras do período selecionado. Não é o valor completo das faturas.
        </Label>
      </Card>
    </>
  );
}
export function More({ onClose }: { onClose: () => void }) {
  const { tokens: t, theme, toggle, fallback } = useTheme();
  return (
    <View style={s.content}>
      <View style={s.between}>
        <Label serif size={34}>
          Sua Casa
        </Label>
        <IconButton icon={X} label="Fechar configurações" onPress={onClose} />
      </View>
      <Card>
        <Label serif size={25}>
          Do seu jeito.
        </Label>
        <Label muted size={13}>
          A mesma identidade do dashboard, com espaço para cada família.
        </Label>
        <Button
          secondary
          icon={theme === "esmeralda" ? Sun : Moon}
          onPress={toggle}
        >
          {theme === "esmeralda"
            ? "Experimentar Sálvia"
            : "Voltar para Esmeralda"}
        </Button>
        {fallback ? (
          <Label muted size={11}>
            Usando o tema Casa padrão. O tema remoto está indisponível.
          </Label>
        ) : null}
      </Card>
      <Card>
        <Label bold>Protótipo de experiência</Label>
        <Label muted size={13}>
          Explore entrada rápida, relatórios e simulações com exemplos.
          Alterações duram até recarregar o aplicativo.
        </Label>
      </Card>
      <Label serif size={24}>
        Próximas entregas do MVP
      </Label>
      <Label muted size={13}>
        Estes recursos ainda não estão conectados neste protótipo.
      </Label>
      {[
        {
          icon: Upload,
          text: "Importar e revisar faturas",
          detail: "Mercado Pago PDF · Nubank CSV · Minhas Finanças CSV",
        },
        {
          icon: CreditCard,
          text: "Cartões e parcelas",
          detail: "Compras parceladas, vencimentos e pagamento de faturas",
        },
        {
          icon: CalendarDays,
          text: "Contas recorrentes",
          detail: "Obrigações, pagamentos e compromissos",
        },
        {
          icon: Settings,
          text: "Gestão da casa",
          detail: "Contas, caixinhas, categorias, responsáveis e regras do bot",
        },
      ].map(({ icon: Icon, text, detail }) => (
        <View key={text} style={s.row}>
          <Icon size={22} color={t.accent} />
          <View style={{ flex: 1, gap: 3 }}>
            <Label bold>{text}</Label>
            <Label muted size={11}>
              {detail}
            </Label>
          </View>
        </View>
      ))}
    </View>
  );
}
