/** Explicit, local-only UI harness. Never imported by the application entrypoint. */
import { View } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { useFonts } from "expo-font";
import { Inter_400Regular } from "@expo-google-fonts/inter/400Regular";
import { Inter_600SemiBold } from "@expo-google-fonts/inter/600SemiBold";
import { PlayfairDisplay_500Medium } from "@expo-google-fonts/playfair-display/500Medium";
import type { EntryInput, MobileData } from "@family-finance/mobile-contracts";
import { CasaApi } from "../src/api";
import { LiveApp } from "../src/LiveApp";
import { DesignSystemProvider } from "../src/theme";
import { themes } from "../src/design-system";
import { Label } from "../src/ui";
const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const data: MobileData = {
  version: 1,
  householdId: id(1),
  householdName: "Casa de teste",
  today: "2026-09-05",
  month: "2026-09",
  hasMore: false,
  recordedIncomeCents: 850000,
  spentCents: 18642,
  catalog: {
    accounts: [{ id: id(2), name: "Conta principal" }],
    cards: [{ id: id(3), name: "Nubank" }],
    categories: [
      { id: id(4), name: "Alimentação" },
      { id: id(5), name: "Receitas" },
    ],
    subcategories: [],
    members: [{ id: id(6), name: "Pessoa de teste" }],
  },
  entries: [
    {
      id: id(7),
      description: "Mercado de teste",
      amountCents: 18642,
      kind: "expense",
      category: "Alimentação",
      payment: "Nubank",
      date: "2026-09-05",
      categoryId: id(4),
      creditCardId: id(3),
    },
    {
      id: id(8),
      description: "Receita de teste",
      amountCents: 850000,
      kind: "income",
      category: "Receitas",
      payment: "Conta principal",
      date: "2026-09-04",
      accountId: id(2),
      categoryId: id(5),
    },
  ],
  future: Array.from({ length: 6 }, (_, i) => ({
    label: ["set", "out", "nov", "dez", "jan", "fev"][i]!,
    month: ["2026-09", "2026-10", "2026-11", "2026-12", "2027-01", "2027-02"][
      i
    ]!,
    incomeCents: 0,
    outflowCents: 100000,
  })),
  resources: {
    accounts: [{ id: id(2), name: "Conta principal", kind: "checking" }],
    cards: [{ id: id(3), name: "Nubank", closing_day: 20, due_day: 27 }],
    categories: [
      { id: id(4), name: "Alimentação", is_active: true },
      { id: id(5), name: "Receitas", is_active: true },
    ],
    obligations: [
      {
        id: id(9),
        description: "Internet de teste",
        amountCents: 12990,
        dueDay: 10,
        status: "active",
      },
    ],
    buckets: [{ id: id(10), name: "Reserva da casa", balance_cents: 200000 }],
    members: [
      {
        id: id(11),
        userId: id(6),
        displayName: "Pessoa de teste",
        telegramUsername: "pessoa_teste",
      },
    ],
    memory: [],
  },
};
class FixtureApi extends CasaApi {
  constructor() {
    super("http://fixture.invalid", async () => "fixture-only");
  }
  override async request<T>(path: string, body?: unknown): Promise<T> {
    let result: unknown;
    if (path.startsWith("bootstrap")) {
      const month = path.split("month=")[1] ?? "2026-09";
      result = {
        ...data,
        month,
        entries: data.entries.filter((e) => e.date.startsWith(month)),
      };
    } else if (path === "projection") result = data.future;
    else if (path.startsWith("design-system")) {
      const theme = path.includes("salvia") ? "salvia" : "esmeralda";
      result = { version: 1, tenantId: id(1), theme, tokens: themes[theme] };
    } else if (path === "draft")
      result = {
        description: "Mercado de teste",
        amountCents: 8500,
        date: data.today,
        kind: "expense",
        categoryId: id(4),
        subcategoryId: null,
        accountId: null,
        creditCardId: id(3),
        installmentCount: 1,
        candidates: [],
        explanation: "Sugestão local para teste de interface.",
        intent: "plain",
      };
    else if (path === "entries") {
      const e = body as EntryInput;
      if (!data.entries.some((row) => row.id === e.id)) {
        data.entries.unshift({
          ...e,
          category:
            data.catalog.categories.find((c) => c.id === e.categoryId)?.name ??
            "Sem categoria",
          payment: e.creditCardId ? "Nubank" : "Conta principal",
        });
        data.spentCents += e.kind === "expense" ? e.amountCents : 0;
      }
      result = { ok: true, id: e.id };
    } else if (path === "actions") {
      const input = body as { action: string; fields: Record<string, string> };
      if (input.action === "transactions.delete")
        data.entries = data.entries.filter(
          (e) => e.id !== input.fields.transactionId,
        );
      if (input.action === "transactions.update")
        data.entries = data.entries.map((e) =>
          e.id === input.fields.transactionId
            ? { ...e, description: input.fields.description ?? e.description }
            : e,
        );
      result = { ok: true };
    } else if (path === "imports/preview")
      result = {
        ok: true,
        requestKey: "test",
        previewToken: "test",
        fileFingerprint: "test",
        normalizedFingerprint: "test",
        parserVersion: "test",
        snapshot: {},
        priorDispositions: {},
        preview: {
          rows: [
            {
              description: "Café de teste",
              occurredOn: data.today,
              amount: { cents: 1850 },
              kind: "expense",
              sourceLine: 2,
            },
            {
              description: "Duplicata de teste",
              occurredOn: data.today,
              amount: { cents: 2500 },
              kind: "expense",
              sourceLine: 3,
            },
          ],
          errors: [],
          duplicates: [],
        },
      };
    else if (path === "imports/resolve")
      result = { dbDuplicateIndices: [1], groupDuplicateIndices: [] };
    else if (path === "imports/confirm")
      result = { ok: true, message: "1 lançamento importado no teste local." };
    else throw new Error("Rota não preparada no teste local.");
    return result as T;
  }
}
const api = new FixtureApi();
export default function Fixture() {
  const [loaded] = useFonts({
    Inter_400Regular,
    Inter_600SemiBold,
    PlayfairDisplay_500Medium,
  });
  if (!loaded) return null;
  return (
    <SafeAreaProvider>
      <DesignSystemProvider source={api.designSystem}>
        <View style={{ backgroundColor: "#16352b", padding: 4 }}>
          <Label size={10}>
            TESTE LOCAL · dados fictícios · nenhuma conexão externa
          </Label>
        </View>
        <LiveApp api={api} onSignOut={async () => {}} />
      </DesignSystemProvider>
    </SafeAreaProvider>
  );
}
