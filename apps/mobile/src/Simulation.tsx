import { useState } from "react";
import { View, Switch, useWindowDimensions } from "react-native";
import Svg, {
  Path,
  Line,
  Circle,
  Defs,
  LinearGradient,
  Stop,
} from "react-native-svg";
import {
  Plus,
  ArrowUpRight,
  RotateCcw,
  Trash2,
  SlidersHorizontal,
  Pencil,
  X,
  Check,
  ArrowDownRight,
} from "lucide-react-native";
import {
  type Snapshot,
  type Assumption,
  project,
  money,
  parseMoney,
} from "./finance";
import { useTheme } from "./theme";
import { Label, Card, Button, Chip, Section, IconButton, Field, s } from "./ui";
export function ProjectionChart({
  points,
}: {
  points: ReturnType<typeof project>;
}) {
  const { tokens: t } = useTheme();
  const values = points.flatMap((p) => [p.baseline, p.simulated]);
  const min = Math.min(...values) - 100000,
    max = Math.max(...values) + 100000;
  const y = (value: number) => 140 - ((value - min) / (max - min)) * 116;
  const path = (key: "baseline" | "simulated") =>
    points
      .map((p, i) => `${i === 0 ? "M" : "L"} ${10 + i * 58} ${y(p[key])}`)
      .join(" ");
  return (
    <View
      accessible
      accessibilityLabel={`Projeção: ${points.map((p) => `${p.label}, base ${money(p.baseline)}, cenário ${money(p.simulated)}`).join("; ")}`}
    >
      <Svg width="100%" height={170} viewBox="0 0 310 170">
        <Defs>
          <LinearGradient id="fill" x1="0" y1="0" x2="0" y2="1">
            <Stop offset="0" stopColor={t.accent} stopOpacity="0.2" />
            <Stop offset="1" stopColor={t.accent} stopOpacity="0" />
          </LinearGradient>
        </Defs>
        {[40, 90, 140].map((y) => (
          <Line
            key={y}
            x1={0}
            x2={310}
            y1={y}
            y2={y}
            stroke={t.border}
            strokeWidth={0.5}
            strokeDasharray="3 6"
          />
        ))}
        <Path
          d={`${path("simulated")} L 300 165 L 10 165 Z`}
          fill="url(#fill)"
        />
        <Path
          d={path("baseline")}
          fill="none"
          stroke={t.muted}
          strokeWidth={2}
          strokeDasharray="5 6"
        />
        <Path
          d={path("simulated")}
          fill="none"
          stroke={t.accent}
          strokeWidth={3}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        {points.map((p, i) => (
          <Circle
            key={i}
            cx={10 + i * 58}
            cy={y(p.simulated)}
            r={3.5}
            fill={t.accent}
          />
        ))}
      </Svg>
      <View style={s.between}>
        {points.map((p) => (
          <Label key={p.label} muted size={10}>
            {p.label}
          </Label>
        ))}
      </View>
    </View>
  );
}
export function Simulation({
  liveSnapshot,
  basisDescription = "Base demonstrativa: receitas esperadas, faturas, contas e estimativa de gastos futuros.",
  assumptions,
  setAssumptions,
  snapshot,
  setSnapshot,
  onEdit,
}: {
  onEdit: () => void;
  liveSnapshot: Snapshot;
  basisDescription?: string;
  snapshot: Snapshot | null;
  setSnapshot: (s: Snapshot | null) => void;
  assumptions: Assumption[];
  setAssumptions: (a: Assumption[]) => void;
}) {
  const { tokens: t } = useTheme();
  const compact = useWindowDimensions().width < 370;
  const [editor, setEditor] = useState(false),
    [editingId, setEditingId] = useState<string | null>(null),
    [confirmDiscard, setConfirmDiscard] = useState(false);
  const [description, setDescription] = useState(""),
    [amount, setAmount] = useState(""),
    [kind, setKind] = useState<"expense" | "income">("expense"),
    [start, setStart] = useState(0),
    [months, setMonths] = useState(1);
  const baseline = snapshot ?? liveSnapshot;
  const points = project(baseline, assumptions);
  const final = points[points.length - 1]!;
  const lowest = Math.min(
    baseline.openingCashCents,
    ...points.map((p) => p.simulated),
  );
  function open(a?: Assumption) {
    setEditingId(a?.id ?? null);
    setDescription(a?.description ?? "");
    setAmount(a ? (a.amountCents / 100).toFixed(2).replace(".", ",") : "");
    setKind(a?.kind ?? "expense");
    setStart(a?.start ?? 0);
    setMonths(a?.months ?? 1);
    setEditor(true);
    onEdit();
  }
  function save() {
    const cents = parseMoney(amount);
    if (!cents || !description.trim()) return;
    const assumption: Assumption = {
      id: editingId ?? `scenario-${Date.now()}`,
      description: description.trim(),
      amountCents: cents,
      kind,
      start,
      months,
      enabled: assumptions.find((a) => a.id === editingId)?.enabled ?? true,
    };
    if (!snapshot) setSnapshot(liveSnapshot);
    setAssumptions(
      editingId
        ? assumptions.map((a) => (a.id === editingId ? assumption : a))
        : [...assumptions, assumption],
    );
    setEditor(false);
    onEdit();
  }
  function example() {
    if (!snapshot) setSnapshot(liveSnapshot);
    setAssumptions([
      ...assumptions,
      {
        id: `freela-${Date.now()}`,
        description: "Freela extra",
        amountCents: 250000,
        kind: "income",
        start: 1,
        months: 1,
        enabled: true,
      },
    ]);
  }
  if (editor)
    return (
      <Card>
        <View style={s.between}>
          <Label serif size={24}>
            {editingId ? "Ajustar possibilidade" : "Uma nova possibilidade"}
          </Label>
          <IconButton
            icon={X}
            label="Fechar possibilidade"
            onPress={() => setEditor(false)}
          />
        </View>
        <View style={s.wrap}>
          <Chip active={kind === "expense"} onPress={() => setKind("expense")}>
            Despesa
          </Chip>
          <Chip active={kind === "income"} onPress={() => setKind("income")}>
            Receita
          </Chip>
        </View>
        <Field
          label="O que você está planejando?"
          value={description}
          onChangeText={setDescription}
          placeholder="Ex.: viagem em família"
        />
        <Field
          label={months > 1 ? "Valor por mês (R$)" : "Valor (R$)"}
          value={amount}
          onChangeText={setAmount}
          keyboardType="decimal-pad"
          placeholder="0,00"
        />
        <Label muted size={12}>
          Começa em
        </Label>
        <View style={s.wrap}>
          {baseline.months.map((m, i) => (
            <Chip
              key={m.label}
              active={start === i}
              onPress={() => setStart(i)}
            >
              {m.label}
            </Chip>
          ))}
        </View>
        <Label muted size={12}>
          Frequência
        </Label>
        <View style={s.wrap}>
          {[1, 3, 6, 12].map((n) => (
            <Chip key={n} active={months === n} onPress={() => setMonths(n)}>
              {n === 1 ? "Uma vez" : `${n} meses`}
            </Chip>
          ))}
        </View>
        {start + months > 6 ? (
          <Label muted size={11}>
            A projeção mostra os primeiros 6 meses. Há pagamentos além desse
            período.
          </Label>
        ) : null}
        <Button
          icon={Check}
          disabled={!description.trim() || !parseMoney(amount)}
          onPress={save}
        >
          {editingId ? "Salvar ajuste" : "Incluir na simulação"}
        </Button>
      </Card>
    );
  return (
    <>
      <View style={{ gap: 8 }}>
        <Label color={t.accent} style={s.eyebrow}>
          UM ESPAÇO PARA POSSIBILIDADES
        </Label>
        <Label serif size={36}>
          E se…?
        </Label>
        <Label muted>Explore o amanhã, sem mudar o hoje.</Label>
      </View>
      <Card
        style={{ backgroundColor: t.tint, borderColor: t.accent, padding: 14 }}
      >
        <View style={s.row}>
          <SlidersHorizontal size={19} color={t.accent} />
          <View style={{ flex: 1 }}>
            <Label bold size={12}>
              Você está em uma simulação
            </Label>
            <Label muted size={11}>
              Seus lançamentos reais ficam como estão.
            </Label>
          </View>
        </View>
      </Card>
      <Card>
        <View style={s.between}>
          <Label muted size={12}>
            Saldo projetado · {baseline.months.at(-1)?.label}
          </Label>
          <Label color={t.accent} size={10}>
            6 MESES
          </Label>
        </View>
        <Label serif size={compact ? 29 : 37}>
          {money(final.simulated)}
        </Label>
        <View style={s.row}>
          {final.delta >= 0 ? (
            <ArrowUpRight size={16} color={t.positive} />
          ) : (
            <ArrowDownRight size={16} color={t.negative} />
          )}
          <Label color={final.delta >= 0 ? t.positive : t.negative} size={12}>
            {final.delta === 0
              ? "Seu ponto de partida, sem alterações"
              : `${money(Math.abs(final.delta))} ${final.delta > 0 ? "a mais" : "a menos"} que o cenário base`}
          </Label>
        </View>
        <ProjectionChart points={points} />
        <View
          style={{ flexDirection: "row", justifyContent: "center", gap: 20 }}
        >
          <Label muted size={11}>
            ┄ Cenário base
          </Label>
          <Label color={t.accent} size={11}>
            ━ Sua simulação
          </Label>
        </View>
        <View style={[s.divider, { backgroundColor: t.border }]} />
        <View style={s.between}>
          <Label muted size={12}>
            Menor saldo no período
          </Label>
          <Label color={lowest < 0 ? t.negative : t.ink} bold>
            {money(lowest)}
          </Label>
        </View>
        {lowest < 0 ? (
          <Label color={t.negative} size={12}>
            O saldo fica negativo. Experimente mudar o valor ou o mês.
          </Label>
        ) : null}
      </Card>
      <View style={{ gap: 12 }}>
        <Section
          title="Suas possibilidades"
          action={assumptions.length ? "Adicionar" : undefined}
          onPress={() => open()}
        />
        {assumptions.length === 0 ? (
          <Card>
            <Label serif size={22}>
              Uma viagem? Uma renda extra?
            </Label>
            <Label muted size={13}>
              Adicione uma ideia e descubra como ela cabe nos próximos meses.
            </Label>
            <Button icon={Plus} onPress={() => open()}>
              Adicionar possibilidade
            </Button>
            <Button secondary small onPress={example}>
              Experimentar: freela de R$ 2.500
            </Button>
          </Card>
        ) : (
          assumptions.map((a) => (
            <Card
              key={a.id}
              style={{ padding: 16, opacity: a.enabled ? 1 : 0.55 }}
            >
              <View style={s.between}>
                <View style={{ flex: 1 }}>
                  <Label bold>{a.description}</Label>
                  <Label muted size={11}>
                    {a.kind === "income" ? "Receita" : "Despesa"} ·{" "}
                    {baseline.months[a.start]?.label} ·{" "}
                    {a.months === 1 ? "Uma vez" : `${a.months} meses`}
                  </Label>
                </View>
                <Switch
                  accessibilityLabel={`Incluir ${a.description}`}
                  value={a.enabled}
                  onValueChange={(enabled) =>
                    setAssumptions(
                      assumptions.map((x) =>
                        x.id === a.id ? { ...x, enabled } : x,
                      ),
                    )
                  }
                  trackColor={{ false: t.border, true: t.accent }}
                  thumbColor={t.ink}
                />
              </View>
              <View style={s.between}>
                <Label
                  size={21}
                  serif
                  color={a.kind === "income" ? t.positive : t.ink}
                >
                  {a.kind === "income" ? "+" : "−"} {money(a.amountCents)}
                  {a.months > 1 ? "/mês" : ""}
                </Label>
                <View style={s.row}>
                  <IconButton
                    icon={Pencil}
                    label={`Editar ${a.description}`}
                    onPress={() => open(a)}
                  />
                  <IconButton
                    icon={Trash2}
                    label={`Excluir ${a.description}`}
                    onPress={() =>
                      setAssumptions(assumptions.filter((x) => x.id !== a.id))
                    }
                  />
                </View>
              </View>
            </Card>
          ))
        )}
      </View>

      <Card style={{ backgroundColor: "transparent" }}>
        <Label bold size={12}>
          De onde vem a projeção?
        </Label>
        <Label muted size={12}>
          Saldo inicial: {money(baseline.openingCashCents)}, em{" "}
          {new Intl.DateTimeFormat("pt-BR", {
            day: "2-digit",
            month: "2-digit",
            year: "numeric",
            timeZone: "UTC",
          }).format(new Date(`${baseline.asOf}T12:00:00Z`))}
          . {basisDescription}
        </Label>
        <Label muted size={11}>
          {snapshot
            ? "Base congelada ao iniciar. Novos lançamentos não mudam esta simulação."
            : "Ao adicionar uma possibilidade, a base fica congelada."}{" "}
          Valores estimados, sem garantia de saldo futuro.
        </Label>
        <View style={s.between}>
          <Label muted size={11}>
            Mês
          </Label>
          <Label muted size={11}>
            Receitas / saídas previstas
          </Label>
        </View>
        {baseline.months.map((m) => (
          <View key={m.label} style={s.between}>
            <Label size={11}>{m.label}</Label>
            <Label muted size={11}>
              {money(m.incomeCents)} / {money(m.outflowCents)}
            </Label>
          </View>
        ))}
      </Card>
      {snapshot ? (
        confirmDiscard ? (
          <Card>
            <Label bold>Descartar todas as possibilidades?</Label>
            <Label muted size={12}>
              A simulação será apagada. Seus lançamentos permanecem.
            </Label>
            <Button
              icon={Trash2}
              onPress={() => {
                setAssumptions([]);
                setSnapshot(null);
                setConfirmDiscard(false);
                setEditor(false);
              }}
            >
              Sim, descartar simulação
            </Button>
            <Button secondary onPress={() => setConfirmDiscard(false)}>
              Continuar planejando
            </Button>
          </Card>
        ) : (
          <Button
            secondary
            icon={RotateCcw}
            onPress={() => setConfirmDiscard(true)}
          >
            Descartar simulação
          </Button>
        )
      ) : null}
    </>
  );
}
