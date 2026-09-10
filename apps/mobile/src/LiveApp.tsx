import { randomUUID } from "expo-crypto";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Modal,
  Pressable,
  RefreshControl,
  ScrollView,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import {
  House,
  ArrowLeftRight,
  Plus,
  Sprout,
  ChartNoAxesCombined,
  SlidersHorizontal,
} from "lucide-react-native";
import type { MobileData } from "@family-finance/mobile-contracts";
import { CasaApi } from "./api";
import {
  Label,
  Button,
  Card,
  Field,
  IconButton,
  s,
  useReducedMotion,
} from "./ui";
import { useTheme } from "./theme";
import {
  money,
  parseMoney,
  type Assumption,
  type Snapshot,
  type Entry,
} from "./finance";
import { Reports } from "./Screens";
import { Simulation } from "./Simulation";
import { LiveCapture, useLiveCaptureState } from "./LiveCapture";
import { LiveTransactions } from "./LiveTransactions";
import { Management } from "./Management";
import { ImportStatements } from "./ImportStatements";
type Tab =
  | "home"
  | "transactions"
  | "simulation"
  | "reports"
  | "more"
  | "imports";
const tabs = [
  { id: "home", name: "Início", icon: House },
  { id: "transactions", name: "Movimentações", icon: ArrowLeftRight },
  { id: "add", name: "Adicionar", icon: Plus },
  { id: "simulation", name: "Simular", icon: Sprout },
  { id: "reports", name: "Relatórios", icon: ChartNoAxesCombined },
] as const;
export function LiveApp({
  api,
  onSignOut,
}: {
  api: CasaApi;
  onSignOut: () => Promise<void>;
}) {
  const reduceMotion = useReducedMotion();
  const { tokens: t, theme, toggle, fallback } = useTheme();
  const [tab, setTab] = useState<Tab>("home");
  const [data, setData] = useState<MobileData | null>(null);
  const [month, setMonth] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const generation = useRef(0);
  const [capture, setCapture] = useState(false);
  const captureState = useLiveCaptureState();
  function openCapture() {
    if (!captureState.draft.date && data)
      captureState.setDraft((d) => ({
        ...d,
        date: data.today,
        accountId:
          data.catalog.accounts.length === 1
            ? data.catalog.accounts[0]!.id
            : null,
      }));
    setCapture(true);
  }
  const [cash, setCash] = useState("");
  const [future, setFuture] = useState<MobileData["future"]>([]);
  const [projectionBusy, setProjectionBusy] = useState(false);
  async function startScenario() {
    const amount = parseMoney(cash);
    if (amount === null || projectionBusy) return;
    setProjectionBusy(true);
    setError("");
    try {
      setFuture(await api.request<MobileData["future"]>("projection"));
      setOpeningCash(amount);
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "Não foi possível preparar a simulação.",
      );
    } finally {
      setProjectionBusy(false);
    }
  }
  const [openingCash, setOpeningCash] = useState<number | null>(null);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [assumptions, setAssumptions] = useState<Assumption[]>([]);
  const scroll = useRef<ScrollView>(null);
  const refresh = useCallback(async () => {
    const id = ++generation.current;
    setLoading(true);
    setError("");
    try {
      const next = await api.load(month || undefined);
      if (id === generation.current) setData(next);
    } catch (e) {
      if (id === generation.current)
        setError(
          e instanceof Error ? e.message : "Não foi possível atualizar.",
        );
      throw e;
    } finally {
      if (id === generation.current) setLoading(false);
    }
  }, [api, month]);
  useEffect(() => {
    void refresh().catch(() => {});
    return () => {
      generation.current++;
    };
  }, [refresh]);
  const navigate = (next: Tab) => {
    setTab(next);
    scroll.current?.scrollTo({ y: 0, animated: false });
  };
  const entries: Entry[] = (data?.entries ?? []).filter(
    (e): e is typeof e & { kind: "expense" | "income" } =>
      e.kind !== "transfer",
  );
  const liveSnapshot: Snapshot = {
    asOf: data?.today ?? "",
    openingCashCents: openingCash ?? 0,
    months: future,
  };
  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }}>
      <StatusBar style={theme === "esmeralda" ? "light" : "dark"} />
      <View
        style={{ flex: 1, maxWidth: 620, width: "100%", alignSelf: "center" }}
      >
        <View
          style={[s.between, { paddingHorizontal: 24, paddingVertical: 12 }]}
        >
          <View>
            <Label serif size={29}>
              casa
            </Label>
            <Label muted size={10}>
              {data?.householdName ?? "Bem-vindo à sua casa"}
            </Label>
          </View>
          <IconButton
            icon={SlidersHorizontal}
            label="Mais recursos"
            onPress={() => navigate("more")}
          />
        </View>
        {error && (
          <View style={{ padding: 16, gap: 8 }}>
            <Label>{error}</Label>
            <Button
              secondary
              small
              onPress={() => void refresh().catch(() => {})}
            >
              Tentar atualizar
            </Button>
          </View>
        )}
        {fallback && (
          <Label muted style={{ paddingHorizontal: 24 }}>
            Tema padrão enquanto a conexão se recupera.
          </Label>
        )}
        {!data ? (
          <View
            style={{
              flex: 1,
              justifyContent: "center",
              alignItems: "center",
              gap: 20,
            }}
          >
            {loading && <ActivityIndicator color={t.accent} />}
            <Label muted>
              {loading
                ? "Carregando sua casa…"
                : "Seus dados aparecerão quando a conexão voltar."}
            </Label>
            <Button
              secondary
              onPress={() =>
                void onSignOut().catch(() => setError("Não foi possível sair."))
              }
            >
              Sair
            </Button>
          </View>
        ) : (
          <>
            {tab === "transactions" ? (
              <View style={{ flex: 1 }}>
                <View style={{ paddingHorizontal: 24, paddingBottom: 12 }}>
                  <MonthPicker month={data.month} onChange={setMonth} />
                </View>
                <LiveTransactions api={api} data={data} onRefresh={refresh} />
              </View>
            ) : (
              <ScrollView
                ref={scroll}
                keyboardShouldPersistTaps="handled"
                automaticallyAdjustKeyboardInsets
                refreshControl={
                  <RefreshControl
                    refreshing={loading}
                    onRefresh={() => void refresh().catch(() => {})}
                    tintColor={t.accent}
                  />
                }
                contentContainerStyle={s.content}
              >
                {tab === "home" ? (
                  <>
                    <Label serif size={34}>
                      Um olhar sobre o mês
                    </Label>
                    <MonthPicker month={data.month} onChange={setMonth} />
                    <Card>
                      <Label muted>Receitas registradas</Label>
                      <Label serif size={33}>
                        {money(data.recordedIncomeCents)}
                      </Label>
                      <View style={s.between}>
                        <Label muted>Despesas e parcelas</Label>
                        <Label>{money(data.spentCents)}</Label>
                      </View>
                      <View style={s.between}>
                        <Label muted>Diferença no mês</Label>
                        <Label
                          color={
                            data.recordedIncomeCents >= data.spentCents
                              ? t.positive
                              : t.negative
                          }
                        >
                          {money(data.recordedIncomeCents - data.spentCents)}
                        </Label>
                      </View>
                      <Label muted size={11}>
                        Movimentações do mês, incluindo parcelas. Esta diferença
                        não representa o saldo disponível nas contas.
                      </Label>
                    </Card>
                    <Button onPress={() => openCapture()}>
                      Adicionar movimentação
                    </Button>
                    <Card>
                      <Label serif size={24}>
                        E se o próximo mês fosse diferente?
                      </Label>
                      <Label muted>
                        Parta do caixa disponível, veja os compromissos e
                        experimente seus planos.
                      </Label>
                      <Button secondary onPress={() => navigate("simulation")}>
                        Abrir simulação
                      </Button>
                    </Card>
                    <Button secondary onPress={() => navigate("imports")}>
                      Importar extrato ou fatura
                    </Button>
                    <Button secondary onPress={() => navigate("transactions")}>
                      Ver movimentações
                    </Button>
                  </>
                ) : tab === "reports" ? (
                  <>
                    <MonthPicker month={data.month} onChange={setMonth} />
                    <Reports
                      entries={entries}
                      subtitle="Movimentações registradas no mês selecionado"
                    />
                    {data.hasMore && (
                      <Label>
                        O limite de registros foi atingido. Este relatório está
                        incompleto.
                      </Label>
                    )}
                  </>
                ) : tab === "simulation" ? (
                  <>
                    {openingCash === null ? (
                      <>
                        <Label serif size={32}>
                          Planeje a partir de agora
                        </Label>
                        <Label muted>
                          Quanto você tem disponível nas contas hoje? O
                          histórico não tem saldo inicial, então confirme esse
                          ponto de partida.
                        </Label>
                        <Field
                          label="Caixa disponível hoje (R$)"
                          value={cash}
                          onChangeText={setCash}
                          keyboardType="decimal-pad"
                        />
                        <Button
                          disabled={parseMoney(cash) === null || projectionBusy}
                          onPress={() => void startScenario()}
                        >
                          {projectionBusy
                            ? "Preparando cenário…"
                            : "Começar simulação"}
                        </Button>
                      </>
                    ) : (
                      <>
                        <Label muted>
                          Base: caixa informado hoje + receitas futuras
                          registradas, compromissos em aberto e faturas ainda
                          não liquidadas. Gastos variáveis e novas receitas
                          entram como hipóteses.
                        </Label>
                        <Simulation
                          liveSnapshot={liveSnapshot}
                          basisDescription="Caixa informado, receitas futuras registradas, despesas futuras em conta, compromissos em aberto e faturas não liquidadas."
                          snapshot={snapshot}
                          setSnapshot={setSnapshot}
                          assumptions={assumptions}
                          setAssumptions={setAssumptions}
                          onEdit={() =>
                            scroll.current?.scrollTo({ y: 0, animated: false })
                          }
                        />
                        <Button
                          secondary
                          onPress={() => {
                            setOpeningCash(null);
                            setSnapshot(null);
                            setAssumptions([]);
                          }}
                        >
                          Descartar tudo e escolher novo saldo
                        </Button>
                      </>
                    )}
                  </>
                ) : tab === "imports" ? (
                  <ImportStatements
                    api={api}
                    catalog={data.catalog}
                    onImported={refresh}
                  />
                ) : (
                  <>
                    <Button secondary onPress={() => navigate("imports")}>
                      Importar extrato ou fatura
                    </Button>
                    <Management api={api} data={data} onRefresh={refresh} />
                    <Button secondary onPress={toggle}>
                      Trocar tema
                    </Button>
                    <Button
                      secondary
                      onPress={() =>
                        void onSignOut().catch(() =>
                          setError("Não foi possível sair."),
                        )
                      }
                    >
                      Sair da Casa
                    </Button>
                  </>
                )}
              </ScrollView>
            )}
            <View
              style={{
                flexDirection: "row",
                borderTopWidth: 0.5,
                borderColor: t.border,
                paddingTop: 8,
              }}
            >
              {tabs.map((item) => {
                const Icon = item.icon;
                return (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={item.name}
                    accessibilityState={{ selected: tab === item.id }}
                    key={item.id}
                    onPress={() =>
                      item.id === "add" ? openCapture() : navigate(item.id)
                    }
                    style={{
                      flex: 1,
                      minHeight: 65,
                      alignItems: "center",
                      justifyContent: "center",
                      gap: 6,
                    }}
                  >
                    <View
                      style={
                        item.id === "add"
                          ? {
                              backgroundColor: t.accent,
                              padding: 12,
                              borderRadius: 18,
                              marginTop: -14,
                            }
                          : undefined
                      }
                    >
                      <Icon
                        size={22}
                        color={
                          item.id === "add"
                            ? t.onAccent
                            : tab === item.id
                              ? t.accent
                              : t.muted
                        }
                      />
                    </View>
                    {item.id !== "add" && (
                      <Label
                        size={9}
                        color={tab === item.id ? t.accent : t.muted}
                      >
                        {item.name}
                      </Label>
                    )}
                  </Pressable>
                );
              })}
            </View>
            <Modal
              visible={capture}
              animationType={reduceMotion ? "none" : "slide"}
              presentationStyle="pageSheet"
              onRequestClose={() => {
                if (!captureState.busy) setCapture(false);
              }}
            >
              <SafeAreaView style={{ flex: 1, backgroundColor: t.bg }}>
                <LiveCapture
                  api={api}
                  catalog={data.catalog}
                  onCatalogRefresh={async () => {
                    const next = await api.load(data.month);
                    setData(next);
                    return next.catalog;
                  }}
                  state={captureState}
                  onClose={() => setCapture(false)}
                  onSaved={() => {
                    setCapture(false);
                    captureState.setDraft((d) => ({
                      ...d,
                      id: randomUUID(),
                      description: "",
                      amountCents: 0,
                      date: "",
                      categoryId: null,
                      subcategoryId: null,
                      accountId: null,
                      creditCardId: null,
                      responsibleUserId: null,
                      installmentCount: 1,
                    }));
                    captureState.setText("");
                    captureState.setAmount("");
                    captureState.setCount("1");
                    captureState.setUncertain(false);
                    captureState.setMessage("");
                    void refresh().catch(() => {});
                  }}
                />
              </SafeAreaView>
            </Modal>
          </>
        )}
      </View>
    </SafeAreaView>
  );
}
function MonthPicker({
  month,
  onChange,
}: {
  month: string;
  onChange: (month: string) => void;
}) {
  function move(delta: number) {
    const date = new Date(`${month}-01T12:00:00Z`);
    date.setUTCMonth(date.getUTCMonth() + delta);
    onChange(date.toISOString().slice(0, 7));
  }
  return (
    <View style={s.between}>
      <Button secondary small label="Mês anterior" onPress={() => move(-1)}>
        ‹
      </Button>
      <Label bold>
        {new Intl.DateTimeFormat("pt-BR", {
          month: "long",
          year: "numeric",
          timeZone: "UTC",
        }).format(new Date(`${month}-01T12:00:00Z`))}
      </Label>
      <Button secondary small label="Próximo mês" onPress={() => move(1)}>
        ›
      </Button>
    </View>
  );
}
