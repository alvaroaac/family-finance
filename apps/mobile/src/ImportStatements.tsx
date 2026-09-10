import { displayDate } from "./dates";
import { randomUUID } from "expo-crypto";
import { ImportHistory } from "./ImportHistory";
import { DateField } from "./DateField";
import { useRef, useState } from "react";
import { Platform, View } from "react-native";
import * as DocumentPicker from "expo-document-picker";
import { File } from "expo-file-system";
import { dateSchema } from "@family-finance/mobile-contracts";
import type { Catalog } from "@family-finance/mobile-contracts";
import { CasaApi } from "./api";
import { Button, Card, Chip, Field, Label, s } from "./ui";
import { Choices } from "./LiveCapture";
import { money, parseMoney } from "./finance";
type Proposal = {
  rowKey: string;
  categoryName: string;
  subcategoryName: string | null;
  explanation: string;
};
type Override = { reason: string; claimId?: string; token?: string };
type Row = {
  cardLast4?: string;
  sourceCategory?: string;
  description: string;
  occurredOn: string;
  amount: { cents: number };
  kind: "expense" | "income";
  sourceLine: number;
};
type Group = {
  rowIndex: number;
  description: string;
  estimatedTotalCents: number;
  installmentCount: number;
  purchasedOn: string;
  status: string;
  cardLast4?: string;
};
type Preview = {
  ok: true;
  requestKey: string;
  previewToken: string;
  fileFingerprint: string;
  normalizedFingerprint: string;
  parserVersion: string;
  snapshot: unknown;
  preview: {
    rows: Row[];
    errors: { message: string; sourceLine: number }[];
    duplicates: { rowIndex: number }[];
  };
  mp?: { groups: Group[]; installmentRowIndices: number[] };
  priorDispositions: Record<number, string>;
  categorizationPlan?: {
    rows: {
      rowKey: string;
      status: string;
      selection: { categoryId: string; subcategoryId?: string } | null;
    }[];
  };
};
type Resolution = {
  dbDuplicateIndices: number[];
  groupDuplicateIndices: number[];
  claimIdsByIndex?: Record<number, string>;
  groupClaimIdsByIndex?: Record<number, string>;
};
export function ImportStatements({
  api,
  catalog,
  onImported,
}: {
  api: CasaApi;
  catalog: Catalog;
  onImported: () => Promise<void>;
}) {
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [cardMap, setCardMap] = useState<Record<string, string>>({});
  const [overrides, setOverrides] = useState<Record<number, Override>>({});
  const [groupOverrides, setGroupOverrides] = useState<
    Record<number, Override>
  >({});
  const [learning, setLearning] = useState<
    Record<
      number,
      { sourceCategory?: boolean; merchant?: boolean; suppress?: boolean }
    >
  >({});
  const [source, setSource] = useState("mercado-pago");
  const [target, setTarget] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [resolution, setResolution] = useState<Resolution | null>(null);
  const [selected, setSelected] = useState<number[]>([]);
  const [groups, setGroups] = useState<
    Record<number, { selected: boolean; total: string; purchasedOn: string }>
  >({});
  const [mapping, setMapping] = useState<
    Record<number, { categoryId?: string; subcategoryId?: string }>
  >({});
  const [edits, setEdits] = useState<
    Record<number, { description: string; occurredOn: string; amount: string }>
  >({});
  const [expanded, setExpanded] = useState<number | null>(null);
  const [page, setPage] = useState(0);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const [message, setMessage] = useState("");
  const [frozen, setFrozen] = useState(false);
  const targets = source === "mercado-pago" ? catalog.cards : catalog.accounts;
  async function run(fn: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setMessage("");
    try {
      await fn();
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Não foi possível concluir.");
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  async function pick() {
    await run(async () => {
      const result = await DocumentPicker.getDocumentAsync({
        type:
          source === "mercado-pago"
            ? "application/pdf"
            : [
                "text/csv",
                "text/comma-separated-values",
                "application/vnd.ms-excel",
                "text/plain",
              ],
        copyToCacheDirectory: true,
      });
      if (result.canceled) return;
      const asset = result.assets[0];
      if (!asset) return;
      if (
        asset.size &&
        asset.size > (source === "mercado-pago" ? 20 : 10) * 1024 * 1024
      )
        throw new Error(
          "Arquivo muito grande. Use PDF até 20 MB ou CSV até 10 MB.",
        );
      const form = new FormData();
      form.append("source", source);
      if (Platform.OS === "web") {
        if (!asset.file) throw new Error("Não foi possível abrir o arquivo.");
        form.append("file", asset.file, asset.name);
      } else form.append("file", new File(asset.uri), asset.name);
      const next = await api.request<Preview>("imports/preview", form);
      setPreview(next);
      setCardMap({});
      setOverrides({});
      setGroupOverrides({});
      setLearning({});
      setResolution(null);
      setSelected([]);
      setMapping(
        Object.fromEntries(
          (next.categorizationPlan?.rows ?? []).flatMap((row, i) =>
            row.status === "selected" && row.selection
              ? [
                  [
                    i,
                    {
                      categoryId: row.selection.categoryId,
                      subcategoryId: row.selection.subcategoryId,
                    },
                  ],
                ]
              : [],
          ),
        ),
      );
      setEdits({});
      setProposals([]);
      setGroups({});
      setPage(0);
      setFrozen(false);
    });
  }
  async function resolve() {
    if (!preview || !target) return;
    await run(async () => {
      const next = await api.request<Resolution>("imports/resolve", {
        previewToken: preview.previewToken,
        snapshot: preview.snapshot,
        ...(source === "mercado-pago"
          ? { creditCardId: target, creditCardByLast4: cardMap }
          : { accountId: target }),
      });
      setResolution(next);
      setOverrides({});
      setGroupOverrides({});
      const excluded = new Set([
        ...next.dbDuplicateIndices,
        ...(preview.mp?.installmentRowIndices ?? []),
        ...preview.preview.duplicates.map((d) => d.rowIndex),
      ]);
      setSelected(
        preview.preview.rows
          .map((_, i) => i)
          .filter(
            (i) =>
              !excluded.has(i) &&
              !["imported", "duplicate_existing", "duplicate_in_file"].includes(
                preview.priorDispositions[i] ?? "",
              ),
          ),
      );
      setGroups(
        Object.fromEntries(
          (preview.mp?.groups ?? []).map((g, i) => [
            i,
            {
              selected: false,
              total: String(g.estimatedTotalCents / 100).replace(".", ","),
              purchasedOn: g.purchasedOn,
            },
          ]),
        ),
      );
    });
  }
  async function suggestCategories() {
    if (!preview) return;
    await run(async () => {
      const result = await api.request<{
        proposals?: Proposal[];
        suggestions: {
          rowKey: string;
          categoryId: string;
          subcategoryId?: string;
        }[];
      }>("imports/suggest", {
        previewToken: preview.previewToken,
        snapshot: preview.snapshot,
      });
      setProposals(result.proposals ?? []);
      const next = { ...mapping };
      for (const suggestion of result.suggestions) {
        const index =
          preview.categorizationPlan?.rows.findIndex(
            (r) => r.rowKey === suggestion.rowKey,
          ) ?? -1;
        if (
          index >= 0 &&
          !next[index]?.categoryId &&
          catalog.categories.some((c) => c.id === suggestion.categoryId)
        )
          next[index] = {
            categoryId: suggestion.categoryId,
            subcategoryId: suggestion.subcategoryId,
          };
      }
      setMapping(next);
      setMessage(
        "Sugestões preenchidas. Revise as categorias antes de confirmar.",
      );
    });
  }
  async function acceptProposal(p: Proposal) {
    await run(async () => {
      const parent = catalog.categories.find(
        (c) =>
          c.name.toLocaleLowerCase() === p.categoryName.toLocaleLowerCase(),
      );
      const isSub = !!p.subcategoryName && !!parent;
      await api.action({
        action: isSub ? "subcategories.create" : "categories.create",
        fields: isSub
          ? { name: p.subcategoryName!, categoryId: parent!.id }
          : { name: p.categoryName },
      });
      await onImported();
      if (isSub || !p.subcategoryName)
        setProposals((all) => all.filter((x) => x.rowKey !== p.rowKey));
      setMessage("Categoria criada. Você pode escolhê-la nos itens abaixo.");
    });
  }
  async function confirm() {
    if (!preview || !target || !resolution) return;
    if (
      Object.entries(groups).some(
        ([, g]) =>
          g.selected &&
          ((parseMoney(g.total) ?? 0) <= 0 ||
            !dateSchema.safeParse(g.purchasedOn).success),
      ) ||
      Object.entries(edits).some(
        ([i, e]) =>
          selected.includes(Number(i)) &&
          (!e.description.trim() ||
            (parseMoney(e.amount) ?? 0) <= 0 ||
            !dateSchema.safeParse(e.occurredOn).success),
      )
    ) {
      setMessage("Confira os valores e datas antes de importar.");
      return;
    }
    setFrozen(true);
    await run(async () => {
      const chosenGroups = (preview.mp?.groups ?? []).flatMap((g, i) =>
        groups[i]?.selected
          ? [
              {
                sourceGroupIndex: i,
                description: g.description,
                totalAmountCents: parseMoney(groups[i]!.total),
                installmentCount: g.installmentCount,
                purchasedOn: groups[i]!.purchasedOn,
                creditCardId:
                  (g.cardLast4 ? cardMap[g.cardLast4] : undefined) ?? target,
                override: groupOverrides[i],
                cardLast4: g.cardLast4,
                categoryId: mapping[g.rowIndex]?.categoryId,
                subcategoryId: mapping[g.rowIndex]?.subcategoryId,
              },
            ]
          : [],
      );
      const result = await api.request<{ message: string }>("imports/confirm", {
        previewToken: preview.previewToken,
        snapshot: preview.snapshot,
        requestKey: preview.requestKey,
        fileFingerprint: preview.fileFingerprint,
        normalizedFingerprint: preview.normalizedFingerprint,
        parserVersion: preview.parserVersion,
        source,
        ...(source === "mercado-pago"
          ? { creditCardId: target, creditCardByLast4: cardMap }
          : { accountId: target }),
        selectedIndices: selected,
        mapping,
        overrides,
        learning,
        edits: Object.fromEntries(
          Object.entries(edits).map(([i, e]) => [
            i,
            {
              description: e.description,
              occurredOn: e.occurredOn,
              amountCents: parseMoney(e.amount),
            },
          ]),
        ),
        groups: chosenGroups,
      });
      setPreview(null);
      setResolution(null);
      setFrozen(false);
      setMessage(result.message);
      await onImported();
    });
  }
  const start = page * 20;
  const selectedCount =
    selected.length + Object.values(groups).filter((g) => g.selected).length;
  return (
    <View style={{ gap: 18 }}>
      <Label serif size={30}>
        Importar extrato
      </Label>
      <Label muted>
        Escolha o arquivo, confira o destino e revise antes de registrar.
      </Label>
      {message ? <Label>{message}</Label> : null}
      {!preview ? (
        <>
          <ImportHistory api={api} />
          <Choices
            label="Formato"
            value={source}
            onChange={(id) => {
              if (id) {
                setSource(id);
                setTarget(null);
              }
            }}
            items={[
              { id: "mercado-pago", name: "Mercado Pago · PDF" },
              { id: "nubank", name: "Nubank · CSV" },
              { id: "minhas-financas", name: "Minhas Finanças · CSV" },
            ]}
          />
          <Button disabled={busy} onPress={() => void pick()}>
            {busy ? "Lendo arquivo…" : "Escolher arquivo"}
          </Button>
        </>
      ) : (
        <>
          <View pointerEvents={busy || frozen ? "none" : "auto"}>
            <Choices
              label={
                source === "mercado-pago"
                  ? "Cartão de destino"
                  : "Conta de destino"
              }
              items={targets}
              value={target}
              onChange={(id) => {
                setTarget(id);
                setResolution(null);
                setSelected([]);
              }}
            />
          </View>
          {source === "mercado-pago" &&
            [
              ...new Set(
                [
                  ...preview.preview.rows.map((r) => r.cardLast4),
                  ...(preview.mp?.groups ?? []).map((g) => g.cardLast4),
                ].filter((id): id is string => !!id),
              ),
            ].map((last4) => (
              <View
                key={last4}
                pointerEvents={busy || frozen ? "none" : "auto"}
              >
                <Choices
                  label={`Cartão final ${last4}`}
                  items={catalog.cards}
                  value={cardMap[last4] ?? target}
                  onChange={(id) => {
                    if (id) {
                      setCardMap((all) => ({ ...all, [last4]: id }));
                      setResolution(null);
                    }
                  }}
                />
              </View>
            ))}
          {!resolution ? (
            <Button disabled={busy || !target} onPress={() => void resolve()}>
              {busy ? "Conferindo…" : "Conferir duplicatas neste destino"}
            </Button>
          ) : (
            <>
              <Card>
                <Label bold>{selectedCount} itens selecionados</Label>
                <Label muted>
                  {resolution.dbDuplicateIndices.length} lançamentos já
                  encontrados. Compras parceladas precisam de confirmação
                  individual.
                </Label>
                {source === "mercado-pago" && (
                  <Label muted>
                    Confira o cartão de cada final. Itens sem final usam o
                    cartão de destino principal.
                  </Label>
                )}
              </Card>
              <Button
                secondary
                disabled={busy || frozen}
                onPress={() => void suggestCategories()}
              >
                Sugerir categorias pendentes
              </Button>
              {proposals.map((p) => (
                <Card key={p.rowKey}>
                  <Label bold>
                    Proposta: {p.categoryName}
                    {p.subcategoryName ? ` / ${p.subcategoryName}` : ""}
                  </Label>
                  <Label muted>{p.explanation}</Label>
                  <Button
                    secondary
                    disabled={busy || frozen}
                    onPress={() => void acceptProposal(p)}
                  >
                    {p.subcategoryName &&
                    catalog.categories.some(
                      (c) =>
                        c.name.toLocaleLowerCase() ===
                        p.categoryName.toLocaleLowerCase(),
                    )
                      ? "Criar esta subcategoria"
                      : "Criar esta categoria"}
                  </Button>
                  <Button
                    secondary
                    small
                    disabled={busy || frozen}
                    onPress={() =>
                      setProposals((all) =>
                        all.filter((x) => x.rowKey !== p.rowKey),
                      )
                    }
                  >
                    Ignorar proposta
                  </Button>
                </Card>
              ))}
              {preview.preview.errors.map((e, i) => (
                <Label key={i}>
                  Linha {e.sourceLine}: {e.message}
                </Label>
              ))}
              {preview.preview.rows
                .slice(start, start + 20)
                .map((row, offset) => {
                  const i = start + offset;
                  const parcel = preview.mp?.installmentRowIndices.includes(i);
                  const duplicate =
                    resolution.dbDuplicateIndices.includes(i) ||
                    preview.preview.duplicates.some((d) => d.rowIndex === i);
                  return (
                    <Card key={i}>
                      <View style={s.between}>
                        <Label bold style={{ flex: 1 }}>
                          {row.description}
                        </Label>
                        <Label>{money(row.amount.cents)}</Label>
                      </View>
                      <Label muted>
                        {displayDate(row.occurredOn)} ·{" "}
                        {row.kind === "income" ? "Receita" : "Despesa"}
                      </Label>
                      {parcel ? (
                        <Label muted>
                          Revisar como compra parcelada abaixo.
                        </Label>
                      ) : duplicate && !overrides[i] ? (
                        <>
                          <Label muted>Duplicata · excluída</Label>
                          <OverrideControl
                            disabled={busy || frozen}
                            onConfirm={(reason) => {
                              const claimId = resolution.claimIdsByIndex?.[i];
                              setOverrides((all) => ({
                                ...all,
                                [i]: {
                                  reason,
                                  ...(claimId
                                    ? { claimId, token: randomUUID() }
                                    : {}),
                                },
                              }));
                              setSelected((all) => [...all, i]);
                            }}
                          />
                        </>
                      ) : (
                        <Chip
                          active={selected.includes(i)}
                          onPress={() => {
                            if (!busy && !frozen)
                              setSelected((s) =>
                                s.includes(i)
                                  ? s.filter((x) => x !== i)
                                  : [...s, i],
                              );
                          }}
                        >
                          {selected.includes(i)
                            ? "Selecionado"
                            : "Não importar"}
                        </Chip>
                      )}
                      <Button
                        secondary
                        small
                        onPress={() => setExpanded(expanded === i ? null : i)}
                      >
                        Categoria:{" "}
                        {catalog.categories.find(
                          (c) => c.id === mapping[i]?.categoryId,
                        )?.name ?? "Sem categoria"}
                      </Button>
                      {expanded === i && (
                        <View pointerEvents={busy || frozen ? "none" : "auto"}>
                          <Label muted size={12}>
                            Aprender com esta correção (opcional)
                          </Label>
                          <Chip
                            active={learning[i]?.merchant ?? false}
                            onPress={() =>
                              setLearning((all) => ({
                                ...all,
                                [i]: { ...all[i], merchant: !all[i]?.merchant },
                              }))
                            }
                          >
                            Lembrar este estabelecimento
                          </Chip>
                          {row.sourceCategory && (
                            <Chip
                              active={learning[i]?.sourceCategory ?? false}
                              onPress={() =>
                                setLearning((all) => ({
                                  ...all,
                                  [i]: {
                                    ...all[i],
                                    sourceCategory: !all[i]?.sourceCategory,
                                  },
                                }))
                              }
                            >
                              Lembrar categoria do arquivo
                            </Chip>
                          )}
                          <Chip
                            active={learning[i]?.suppress ?? false}
                            onPress={() =>
                              setLearning((all) => ({
                                ...all,
                                [i]: {
                                  ...all[i],
                                  merchant: true,
                                  suppress: !all[i]?.suppress,
                                },
                              }))
                            }
                          >
                            Não sugerir categoria para este estabelecimento
                          </Chip>
                          <Field
                            label="Descrição revisada"
                            value={edits[i]?.description ?? row.description}
                            editable={!busy && !frozen}
                            onChangeText={(description) =>
                              setEdits((all) => ({
                                ...all,
                                [i]: {
                                  description,
                                  occurredOn:
                                    all[i]?.occurredOn ?? row.occurredOn,
                                  amount:
                                    all[i]?.amount ??
                                    String(row.amount.cents / 100),
                                },
                              }))
                            }
                          />
                          <DateField
                            label="Data revisada (DD/MM/AAAA)"
                            value={edits[i]?.occurredOn ?? row.occurredOn}
                            editable={!busy && !frozen}
                            onChangeText={(occurredOn) =>
                              setEdits((all) => ({
                                ...all,
                                [i]: {
                                  description:
                                    all[i]?.description ?? row.description,
                                  occurredOn,
                                  amount:
                                    all[i]?.amount ??
                                    String(row.amount.cents / 100),
                                },
                              }))
                            }
                          />
                          <Field
                            label="Valor revisado (R$)"
                            value={
                              edits[i]?.amount ?? String(row.amount.cents / 100)
                            }
                            editable={!busy && !frozen}
                            onChangeText={(amount) =>
                              setEdits((all) => ({
                                ...all,
                                [i]: {
                                  description:
                                    all[i]?.description ?? row.description,
                                  occurredOn:
                                    all[i]?.occurredOn ?? row.occurredOn,
                                  amount,
                                },
                              }))
                            }
                          />
                          <Choices
                            label="Categoria"
                            value={mapping[i]?.categoryId ?? null}
                            items={catalog.categories}
                            optional
                            onChange={(id) =>
                              setMapping((m) => ({
                                ...m,
                                [i]: { categoryId: id ?? undefined },
                              }))
                            }
                          />
                          {mapping[i]?.categoryId && (
                            <Choices
                              label="Subcategoria"
                              value={mapping[i]?.subcategoryId ?? null}
                              items={catalog.subcategories.filter(
                                (c) => c.parentId === mapping[i]?.categoryId,
                              )}
                              optional
                              onChange={(id) =>
                                setMapping((m) => ({
                                  ...m,
                                  [i]: {
                                    ...m[i],
                                    subcategoryId: id ?? undefined,
                                  },
                                }))
                              }
                            />
                          )}
                        </View>
                      )}
                    </Card>
                  );
                })}
              <View style={s.between}>
                <Button
                  secondary
                  small
                  disabled={page === 0}
                  onPress={() => setPage((p) => p - 1)}
                >
                  Anterior
                </Button>
                <Label>
                  {page + 1} /{" "}
                  {Math.max(1, Math.ceil(preview.preview.rows.length / 20))}
                </Label>
                <Button
                  secondary
                  small
                  disabled={start + 20 >= preview.preview.rows.length}
                  onPress={() => setPage((p) => p + 1)}
                >
                  Próxima
                </Button>
              </View>
              {(preview.mp?.groups ?? []).map((g, i) => (
                <Card key={`g-${i}`}>
                  <Label bold>{g.description}</Label>
                  <Label muted>
                    {g.installmentCount} parcelas · total estimado{" "}
                    {money(g.estimatedTotalCents)}
                    {g.cardLast4 ? ` · final ${g.cardLast4}` : ""}
                  </Label>
                  {(resolution.groupDuplicateIndices.includes(i) ||
                    g.status === "exists") &&
                  !groupOverrides[i] ? (
                    <>
                      <Label muted>Compra já encontrada · excluída</Label>
                      <OverrideControl
                        disabled={busy || frozen}
                        onConfirm={(reason) => {
                          const claimId = resolution.groupClaimIdsByIndex?.[i];
                          setGroupOverrides((all) => ({
                            ...all,
                            [i]: {
                              reason,
                              ...(claimId
                                ? { claimId, token: randomUUID() }
                                : {}),
                            },
                          }));
                          setGroups((all) => ({
                            ...all,
                            [i]: { ...all[i]!, selected: true },
                          }));
                        }}
                      />
                    </>
                  ) : (
                    <>
                      <Chip
                        active={groups[i]?.selected ?? false}
                        onPress={() => {
                          if (!busy && !frozen)
                            setGroups((all) => ({
                              ...all,
                              [i]: { ...all[i]!, selected: !all[i]?.selected },
                            }));
                        }}
                      >
                        Confirmar nova compra parcelada
                      </Chip>
                      <Field
                        label="Valor total confirmado (R$)"
                        value={groups[i]?.total ?? ""}
                        editable={!busy && !frozen}
                        onChangeText={(total) =>
                          setGroups((all) => ({
                            ...all,
                            [i]: { ...all[i]!, total },
                          }))
                        }
                      />
                      <DateField
                        label="Data de compra confirmada (DD/MM/AAAA)"
                        value={groups[i]?.purchasedOn ?? ""}
                        editable={!busy && !frozen}
                        onChangeText={(purchasedOn) =>
                          setGroups((all) => ({
                            ...all,
                            [i]: { ...all[i]!, purchasedOn },
                          }))
                        }
                      />
                    </>
                  )}
                </Card>
              ))}
              {frozen && (
                <Label>
                  Repetir mantém a mesma importação e as mesmas escolhas. O
                  servidor evita gravá-la duas vezes.
                </Label>
              )}
              <Button
                disabled={busy || selectedCount === 0}
                onPress={() => void confirm()}
              >
                {busy
                  ? "Importando…"
                  : frozen
                    ? "Repetir confirmação"
                    : "Confirmar importação"}
              </Button>
            </>
          )}
          <Button
            secondary
            disabled={busy}
            onPress={() => {
              setPreview(null);
              setResolution(null);
            }}
          >
            Descartar revisão
          </Button>
        </>
      )}
    </View>
  );
}

function OverrideControl({
  disabled,
  onConfirm,
}: {
  disabled: boolean;
  onConfirm: (reason: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  return (
    <View style={{ gap: 10 }}>
      {open ? (
        <>
          <Label>
            Importar mesmo assim cria um novo registro real. Explique por que
            este item é diferente.
          </Label>
          <Field
            label="Justificativa da duplicata"
            value={reason}
            onChangeText={setReason}
            editable={!disabled}
            maxLength={200}
          />
          <Button
            secondary
            disabled={disabled || reason.trim().length < 5}
            onPress={() => onConfirm(reason.trim())}
          >
            Confirmar que é um novo lançamento
          </Button>
          <Button
            secondary
            small
            disabled={disabled}
            onPress={() => setOpen(false)}
          >
            Manter excluído
          </Button>
        </>
      ) : (
        <Button
          secondary
          small
          disabled={disabled}
          onPress={() => setOpen(true)}
        >
          Revisar possível duplicata
        </Button>
      )}
    </View>
  );
}
