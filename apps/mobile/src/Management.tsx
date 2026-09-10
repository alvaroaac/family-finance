import { DateField } from "./DateField";
import { displayMonth, inputMonth } from "./dates";
import { useRef, useState } from "react";
import { View } from "react-native";
import type { Choice, MobileData } from "@family-finance/mobile-contracts";
import { CasaApi, ApiError } from "./api";
import { dateSchema, monthSchema } from "@family-finance/mobile-contracts";
import { Button, Card, Field, Label } from "./ui";
import { Choices } from "./LiveCapture";
import { money, parseMoney } from "./finance";
type Input = {
  key: string;
  label: string;
  choices?: Choice[];
  optional?: boolean;
};
type Editor = {
  title: string;
  action: string;
  fields: Record<string, string>;
  inputs: Input[];
  destructive?: boolean;
};
const kinds = [
  { id: "checking", name: "Conta corrente" },
  { id: "investment", name: "Investimento" },
];
const slugs = [
  { id: "casa", name: "Casa" },
  { id: "filhos", name: "Filhos" },
  { id: "independencia_financeira", name: "Independência financeira" },
];
const sections = [
  ["accounts", "Contas"],
  ["cards", "Cartões"],
  ["obligations", "Compromissos"],
  ["buckets", "Investimentos"],
  ["categories", "Categorias"],
  ["memory", "Regras de categoria"],
  ["members", "Pessoas"],
] as const;
export function Management({
  api,
  data,
  onRefresh,
}: {
  api: CasaApi;
  data: MobileData;
  onRefresh: () => Promise<void>;
}) {
  const [section, setSection] = useState<string>("accounts");
  const [editor, setEditor] = useState<Editor | null>(null);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const [message, setMessage] = useState("");
  const [uncertain, setUncertain] = useState(false);
  const open = (e: Editor) => {
    setEditor(e);
    setMessage("");
    setUncertain(false);
  };
  const basic = (
    title: string,
    action: string,
    fields: Record<string, string>,
    inputs: Input[],
    destructive = false,
  ) => open({ title, action, fields, inputs, destructive });
  async function save() {
    if (!editor || lock.current) return;
    const missing = editor.inputs.find(
      (input) =>
        !input.optional &&
        !["termMonths", "telegram"].includes(input.key) &&
        !editor.fields[input.key]?.trim(),
    );
    if (missing) {
      setMessage(`Preencha: ${missing.label}.`);
      return;
    }
    for (const input of editor.inputs) {
      const value = editor.fields[input.key] ?? "";
      const cents = parseMoney(value);
      if (
        ["amount", "balance"].includes(input.key) &&
        (cents === null ||
          !Number.isFinite(cents) ||
          cents < (input.key === "balance" ? 0 : 1))
      ) {
        setMessage(`Informe um valor válido em ${input.label}.`);
        return;
      }
      if (
        ["dueDay", "closingDay"].includes(input.key) &&
        (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 31)
      ) {
        setMessage("Escolha um dia entre 1 e 31.");
        return;
      }
      if (
        input.key === "termMonths" &&
        value &&
        (!/^\d+$/.test(value) || Number(value) < 1)
      ) {
        setMessage("Informe um prazo em meses válido.");
        return;
      }
      if (
        ["month", "startMonth", "billMonth"].includes(input.key) &&
        !monthSchema.safeParse(value).success
      ) {
        setMessage("Informe o mês no formato MM/AAAA.");
        return;
      }
      if (input.key === "paidOn" && !dateSchema.safeParse(value).success) {
        setMessage("Informe uma data de pagamento válida.");
        return;
      }
    }
    lock.current = true;
    setBusy(true);
    setMessage("");
    try {
      await api.action({
        action: editor.action,
        fields:
          editor.action === "cards.pay"
            ? {
                ...editor.fields,
                amountCents: parseMoney(editor.fields.amount ?? ""),
              }
            : editor.fields,
      });
      setEditor(null);
      await onRefresh();
      setMessage("Alteração salva.");
    } catch (e) {
      setUncertain(
        !(e instanceof ApiError && e.status >= 400 && e.status < 500),
      );
      setMessage(e instanceof Error ? e.message : "Não foi possível concluir.");
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  const text = (key: string, label: string): Input => ({ key, label });
  function create() {
    if (section === "categories")
      basic("Nova categoria", "categories.create", { name: "" }, [
        text("name", "Nome"),
      ]);
    if (section === "accounts")
      basic("Nova conta", "accounts.create", { name: "", kind: "checking" }, [
        text("name", "Nome"),
        { key: "kind", label: "Tipo", choices: kinds },
      ]);
    if (section === "cards")
      basic(
        "Novo cartão",
        "cards.create",
        { name: "", closingDay: "", dueDay: "" },
        [
          text("name", "Nome"),
          text("closingDay", "Dia de fechamento"),
          text("dueDay", "Dia de vencimento"),
        ],
      );
    if (section === "buckets")
      basic("Nova caixinha", "investments.create", { name: "", slug: "casa" }, [
        text("name", "Nome"),
        { key: "slug", label: "Objetivo", choices: slugs },
      ]);
    if (section === "obligations")
      basic(
        "Novo compromisso",
        "obligations.create",
        {
          description: "",
          amount: "",
          startMonth: data.month,
          termMonths: "",
          dueDay: "",
          accountId: "",
          categoryId: "",
        },
        [
          text("description", "Descrição"),
          text("amount", "Valor mensal (R$)"),
          text("startMonth", "Primeiro mês (MM/AAAA)"),
          text("termMonths", "Prazo em meses (vazio = contínuo)"),
          text("dueDay", "Dia do vencimento"),
          { key: "accountId", label: "Conta", choices: data.catalog.accounts },
          {
            key: "categoryId",
            label: "Categoria",
            choices: data.catalog.categories,
            optional: true,
          },
        ],
      );
    if (section === "memory")
      basic(
        "Nova regra",
        "memory.create",
        { pattern: "", categoryId: "", subcategoryId: "" },
        [
          text("pattern", "Texto a reconhecer"),
          {
            key: "categoryId",
            label: "Categoria",
            choices: data.catalog.categories,
          },
          {
            key: "subcategoryId",
            label: "Subcategoria",
            choices: data.catalog.subcategories,
            optional: true,
          },
        ],
      );
  }
  return (
    <View style={{ gap: 18 }}>
      <Label serif size={30}>
        Sua casa, organizada
      </Label>
      <Choices
        label="Gerenciar"
        items={sections.map(([id, name]) => ({ id, name }))}
        value={section}
        onChange={(id) => {
          if (id) {
            setSection(id);
            setEditor(null);
          }
        }}
      />
      {message ? <Label>{message}</Label> : null}
      {editor ? (
        <Card>
          <Label serif size={24}>
            {editor.title}
          </Label>
          {editor.destructive && (
            <Label>
              Confirme para aplicar esta alteração aos dados reais da sua casa.
            </Label>
          )}
          {editor.inputs.map((input) =>
            input.choices ? (
              <Choices
                key={input.key}
                label={input.label}
                items={input.choices}
                value={editor.fields[input.key] ?? null}
                optional={input.optional}
                onChange={(id) => {
                  if (!busy && !uncertain)
                    setEditor({
                      ...editor,
                      fields: { ...editor.fields, [input.key]: id ?? "" },
                    });
                }}
              />
            ) : input.key === "paidOn" ? (
              <DateField
                key={input.key}
                label={input.label}
                value={editor.fields[input.key] ?? ""}
                editable={!busy && !uncertain}
                onChangeText={(value) =>
                  setEditor({
                    ...editor,
                    fields: { ...editor.fields, [input.key]: value },
                  })
                }
              />
            ) : (
              <Field
                key={input.key}
                label={input.label}
                value={
                  ["month", "startMonth", "billMonth"].includes(input.key)
                    ? displayMonth(editor.fields[input.key] ?? "")
                    : (editor.fields[input.key] ?? "")
                }
                editable={!busy && !uncertain}
                onChangeText={(value) =>
                  setEditor({
                    ...editor,
                    fields: {
                      ...editor.fields,
                      [input.key]: [
                        "month",
                        "startMonth",
                        "billMonth",
                      ].includes(input.key)
                        ? inputMonth(value)
                        : value,
                    },
                  })
                }
              />
            ),
          )}
          {uncertain ? (
            <Button
              secondary
              disabled={busy}
              onPress={() => {
                void onRefresh()
                  .then(() => {
                    setEditor(null);
                    setUncertain(false);
                  })
                  .catch(() =>
                    setMessage("Ainda sem conexão. Tente atualizar novamente."),
                  );
              }}
            >
              Atualizar e conferir antes de tentar de novo
            </Button>
          ) : (
            <Button disabled={busy} onPress={() => void save()}>
              {busy ? "Salvando…" : "Confirmar"}
            </Button>
          )}
          <Button secondary disabled={busy} onPress={() => setEditor(null)}>
            Cancelar
          </Button>
        </Card>
      ) : (
        <>
          {section !== "members" && (
            <Button secondary onPress={create}>
              Adicionar
            </Button>
          )}
          {(data.resources[section] ?? []).map((row) => {
            const id = String(row.id);
            const name = String(
              row.name ??
                row.description ??
                row.pattern ??
                row.displayName ??
                (section === "members" ? "Pessoa da casa" : ""),
            );
            const value = (key: string) => String(row[key] ?? "");
            return (
              <Card key={id}>
                <Label bold>{name}</Label>
                {section === "accounts" && (
                  <>
                    <Label muted>
                      {value("kind") === "investment"
                        ? "Investimento"
                        : "Conta corrente"}
                    </Label>
                    <Button
                      secondary
                      small
                      onPress={() =>
                        basic(
                          "Editar conta",
                          "accounts.update",
                          { accountId: id, name },
                          [text("name", "Nome")],
                        )
                      }
                    >
                      Editar
                    </Button>
                    <Button
                      secondary
                      small
                      onPress={() =>
                        basic(
                          "Excluir conta",
                          "accounts.delete",
                          { accountId: id },
                          [],
                          true,
                        )
                      }
                    >
                      Excluir
                    </Button>
                  </>
                )}
                {section === "cards" && (
                  <>
                    <Button
                      secondary
                      small
                      onPress={() =>
                        basic(
                          "Registrar pagamento de fatura",
                          "cards.pay",
                          {
                            creditCardId: id,
                            accountId: "",
                            billMonth: data.month,
                            amount: "",
                            paidOn: data.today,
                          },
                          [
                            {
                              key: "accountId",
                              label: "Conta de pagamento",
                              choices: data.catalog.accounts,
                            },
                            text("billMonth", "Mês da fatura (MM/AAAA)"),
                            text("amount", "Valor pago (R$)"),
                            text("paidOn", "Data do pagamento (DD/MM/AAAA)"),
                          ],
                        )
                      }
                    >
                      Registrar pagamento de fatura
                    </Button>
                    <Label muted>
                      Fecha dia {value("closing_day")} · vence dia{" "}
                      {value("due_day")}
                    </Label>
                    <Button
                      secondary
                      small
                      onPress={() =>
                        basic(
                          "Editar cartão",
                          "cards.update",
                          {
                            cardId: id,
                            name,
                            closingDay: value("closing_day"),
                            dueDay: value("due_day"),
                          },
                          [
                            text("name", "Nome"),
                            text("closingDay", "Dia de fechamento"),
                            text("dueDay", "Dia do vencimento"),
                          ],
                        )
                      }
                    >
                      Editar
                    </Button>
                    <Button
                      secondary
                      small
                      onPress={() =>
                        basic(
                          "Excluir cartão",
                          "cards.delete",
                          { cardId: id },
                          [],
                          true,
                        )
                      }
                    >
                      Excluir
                    </Button>
                  </>
                )}
                {section === "buckets" && (
                  <>
                    <Label serif size={24}>
                      {money(Number(row.balance_cents ?? 0))}
                    </Label>
                    <Button
                      secondary
                      small
                      onPress={() =>
                        basic(
                          "Atualizar saldo",
                          "investments.balance",
                          {
                            bucketId: id,
                            balance: String(
                              Number(row.balance_cents ?? 0) / 100,
                            ),
                          },
                          [text("balance", "Saldo atual (R$)")],
                        )
                      }
                    >
                      Atualizar saldo
                    </Button>
                    <Button
                      secondary
                      small
                      onPress={() =>
                        basic(
                          "Renomear caixinha",
                          "investments.update",
                          { bucketId: id, name },
                          [text("name", "Nome")],
                        )
                      }
                    >
                      Renomear
                    </Button>
                    <Button
                      secondary
                      small
                      onPress={() =>
                        basic(
                          "Excluir caixinha",
                          "investments.delete",
                          { bucketId: id },
                          [],
                          true,
                        )
                      }
                    >
                      Excluir
                    </Button>
                  </>
                )}
                {section === "obligations" && (
                  <>
                    <Label>
                      {money(Number(row.amount_cents ?? 0))} por mês · dia{" "}
                      {value("due_day")}
                    </Label>
                    <Label muted>
                      {value("status") === "active"
                        ? "Ativo"
                        : value("status") === "canceled"
                          ? "Cancelado"
                          : "Encerrado"}
                    </Label>
                    <Button
                      secondary
                      small
                      disabled={row.paidThisMonth === true}
                      onPress={() =>
                        basic(
                          "Registrar pagamento",
                          "obligations.pay",
                          {
                            obligationId: id,
                            month: data.month,
                            amount: String(Number(row.amount_cents ?? 0) / 100),
                          },
                          [
                            text("month", "Mês (MM/AAAA)"),
                            text("amount", "Valor pago (R$)"),
                          ],
                        )
                      }
                    >
                      {row.paidThisMonth === true
                        ? "Pago neste mês"
                        : "Marcar como pago"}
                    </Button>
                    <Button
                      secondary
                      small
                      onPress={() =>
                        basic(
                          "Editar compromisso",
                          "obligations.update",
                          {
                            obligationId: id,
                            description: name,
                            amount: String(Number(row.amount_cents ?? 0) / 100),
                            dueDay: value("due_day"),
                          },
                          [
                            text("description", "Descrição"),
                            text("amount", "Valor mensal (R$)"),
                            text("dueDay", "Dia do vencimento"),
                          ],
                        )
                      }
                    >
                      Editar
                    </Button>
                    <Button
                      secondary
                      small
                      onPress={() =>
                        basic(
                          "Cancelar compromisso",
                          "obligations.cancel",
                          { obligationId: id },
                          [],
                          true,
                        )
                      }
                    >
                      Cancelar compromisso
                    </Button>
                  </>
                )}
                {section === "members" && (
                  <>
                    <Label muted>
                      {value("telegramUsername")
                        ? `@${value("telegramUsername")}`
                        : value("telegramUserId")}
                    </Label>
                    <Button
                      secondary
                      small
                      onPress={() =>
                        basic(
                          "Editar pessoa",
                          "members.update",
                          {
                            memberId: id,
                            displayName: name,
                            telegram: value("telegramUsername")
                              ? `@${value("telegramUsername")}`
                              : value("telegramUserId"),
                          },
                          [
                            text("displayName", "Nome"),
                            text("telegram", "Telegram (@usuário ou ID)"),
                          ],
                        )
                      }
                    >
                      Editar
                    </Button>
                  </>
                )}
                {section === "categories" && (
                  <>
                    <Button
                      secondary
                      small
                      onPress={() =>
                        basic(
                          "Nova subcategoria",
                          "subcategories.create",
                          { categoryId: id, name: "" },
                          [text("name", "Nome")],
                        )
                      }
                    >
                      Adicionar subcategoria
                    </Button>
                    <Label muted>{row.is_active ? "Ativa" : "Arquivada"}</Label>
                    <Button
                      secondary
                      small
                      onPress={() =>
                        basic(
                          row.is_active
                            ? "Arquivar categoria"
                            : "Restaurar categoria",
                          row.is_active
                            ? "categories.archive"
                            : "categories.restore",
                          { categoryId: id },
                          [],
                          true,
                        )
                      }
                    >
                      {row.is_active ? "Arquivar" : "Restaurar"}
                    </Button>
                    <Button
                      secondary
                      small
                      onPress={() =>
                        basic(
                          "Unificar categoria",
                          "categories.merge",
                          { sourceCategoryId: id, targetCategoryId: "" },
                          [
                            {
                              key: "targetCategoryId",
                              label: "Mover todos os lançamentos para",
                              choices: data.catalog.categories.filter(
                                (c) => c.id !== id,
                              ),
                            },
                          ],
                          true,
                        )
                      }
                    >
                      Unificar com outra
                    </Button>
                  </>
                )}
                {section === "memory" && (
                  <>
                    <Label muted>{row.is_active ? "Ativa" : "Pausada"}</Label>
                    <Button
                      secondary
                      small
                      onPress={() =>
                        basic(
                          row.is_active ? "Pausar regra" : "Ativar regra",
                          row.is_active ? "memory.disable" : "memory.enable",
                          { memoryId: id },
                          [],
                          true,
                        )
                      }
                    >
                      {row.is_active ? "Pausar" : "Ativar"}
                    </Button>
                  </>
                )}
              </Card>
            );
          })}
          {!data.resources[section]?.length && (
            <Label muted>
              Nenhum item por aqui. Adicione o primeiro quando precisar.
            </Label>
          )}
        </>
      )}
    </View>
  );
}
