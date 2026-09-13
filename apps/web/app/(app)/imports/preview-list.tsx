"use client";

import { useState } from "react";
import type { ReactElement, ReactNode } from "react";

import type { NormalizedImportRow } from "@family-finance/importers";

import { Badge, Button, Input, Select } from "../../../components/ui";
import type {
  CategoryOption,
  ImportAiSuggestion,
  SubcategoryOption,
} from "./actions";
import {
  countLabel,
  formatGroupDates,
  summarizeGroup,
  type MerchantGroup,
  type PreviewFilter,
} from "./merchant-groups";

/** Everything the list needs to know about one preview row, resolved by the page. */
export type PreviewRowView = {
  index: number;
  row: NormalizedImportRow;
  occurredOn: string;
  description: string;
  amountCents: number;
  kind: "expense" | "income";
  excluded: boolean;
  duplicate: boolean;
  dbDuplicate: boolean;
  /** Row belongs to a Mercado Pago installment group; it enters through that panel. */
  installmentRow: boolean;
  suppressed: boolean;
  categoryId: string;
  subcategoryId: string;
  /** The user chose a category for this row alone ("mudar só esta"). */
  detached: boolean;
  rememberMerchant: boolean;
  learnSourceCategory: boolean;
  aiSuggestion?: ImportAiSuggestion;
  priorDisposition?: string;
  recentlyChanged: boolean;
};

export type RowEditPatch = {
  occurredOn?: string;
  description?: string;
  amountCents?: number;
  kind?: "expense" | "income";
};

export type PreviewListProps = {
  groups: MerchantGroup[];
  rowsByIndex: ReadonlyMap<number, PreviewRowView>;
  totalGroupCount: number;
  categories: CategoryOption[];
  subsByCategory: ReadonlyMap<string, SubcategoryOption[]>;
  providerLabel: (provider: ImportAiSuggestion["provider"]) => string;
  comparison: "ok" | "pending" | "failed";
  toolbar: {
    filter: PreviewFilter;
    onFilter: (filter: PreviewFilter) => void;
    counts: Record<PreviewFilter, number>;
    search: string;
    onSearch: (value: string) => void;
    period: string;
    canUndo: boolean;
    onUndo: () => void;
  };
  onToggleRow: (index: number) => void;
  onToggleGroup: (group: MerchantGroup, selected: boolean) => void;
  onGroupCategory: (group: MerchantGroup, categoryId: string) => void;
  onGroupSubcategory: (group: MerchantGroup, subcategoryId: string) => void;
  onGroupRemember: (group: MerchantGroup, remember: boolean) => void;
  onRowCategory: (index: number, categoryId: string) => void;
  onRowSubcategory: (index: number, subcategoryId: string) => void;
  onDetachRow: (index: number) => void;
  onAttachRow: (group: MerchantGroup, index: number) => void;
  onRowEdit: (index: number, patch: RowEditPatch) => void;
  onLearnSourceCategory: (index: number, checked: boolean) => void;
  onApplyAiSuggestion: (index: number) => void;
  footer: {
    summary: ReactNode;
    pendenciasCount: number;
    onOpenPendencias: () => void;
    draftSavedAt: string | null;
    onContinueLater: () => void;
    destination: ReactNode;
    onBack: () => void;
    onConfirm: () => void;
    confirmLabel: string;
    isPending: boolean;
  };
};

const COLLAPSED_OCCURRENCES = 3;

const FILTER_CHIPS: Array<{ key: PreviewFilter; label: string }> = [
  { key: "uncategorized", label: "Sem categoria" },
  { key: "all", label: "Todos" },
  { key: "duplicates", label: "Duplicatas" },
  { key: "installments", label: "Parcelas" },
];

function formatBrl(cents: number): string {
  return (cents / 100).toLocaleString("pt-BR", {
    style: "currency",
    currency: "BRL",
  });
}

function formatDayMonth(iso: string): string {
  const [, month, day] = iso.split("-");
  return `${day}/${month}`;
}

/** Rows whose category the group controls: attached and not installment-bound. */
function editableRows(
  group: MerchantGroup,
  rowsByIndex: ReadonlyMap<number, PreviewRowView>,
): PreviewRowView[] {
  return group.indices
    .map((index) => rowsByIndex.get(index))
    .filter(
      (view): view is PreviewRowView =>
        view !== undefined && !view.detached && !view.installmentRow,
    );
}

function uniform<T>(values: T[]): T | "mixed" | undefined {
  if (values.length === 0) return undefined;
  return values.every((value) => value === values[0]) ? values[0] : "mixed";
}

/**
 * Grouped preview (option A): one row per merchant with the category that
 * applies to the whole group, occurrences underneath. Same markup on desktop
 * (grid) and mobile (stacked cards) — CSS decides.
 */
export function PreviewList(props: PreviewListProps): ReactElement {
  const { groups, rowsByIndex, toolbar, footer } = props;
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [showAll, setShowAll] = useState<Set<string>>(() => new Set());
  const [editing, setEditing] = useState<Set<number>>(() => new Set());

  const toggleIn = <T,>(set: Set<T>, value: T): Set<T> => {
    const next = new Set(set);
    if (next.has(value)) next.delete(value);
    else next.add(value);
    return next;
  };

  return (
    <div className="ff-preview" data-testid="preview-list">
      <div className="ff-preview__toolbar">
        <Input
          className="ff-input--compact ff-preview__search"
          type="search"
          placeholder="Buscar estabelecimento"
          value={toolbar.search}
          onChange={(event) => toolbar.onSearch(event.target.value)}
          aria-label="Buscar estabelecimento"
        />
        {toolbar.period !== "" ? (
          <span className="ff-pill ff-preview__period">{toolbar.period}</span>
        ) : null}
        <div className="ff-preview__chips" role="group" aria-label="Filtrar">
          {FILTER_CHIPS.map((chip) => (
            <button
              key={chip.key}
              type="button"
              className={`ff-pill${toolbar.filter === chip.key ? " ff-pill--active" : ""}`}
              aria-pressed={toolbar.filter === chip.key}
              onClick={() => toolbar.onFilter(chip.key)}
            >
              {chip.label}{" "}
              <span className="ff-num">{toolbar.counts[chip.key]}</span>
            </button>
          ))}
        </div>
        {toolbar.canUndo ? (
          <Button variant="ghost" onClick={toolbar.onUndo}>
            Desfazer
          </Button>
        ) : null}
      </div>

      <div className="ff-preview__head" aria-hidden="true">
        <span />
        <span>Estabelecimento</span>
        <span className="ff-preview__right">Total</span>
        <span>Categoria (vale pro grupo)</span>
        <span>Subcategoria</span>
        <span>Lembrar</span>
        <span />
      </div>

      <div className="ff-preview__scroll">
        {groups.length === 0 ? (
          <p className="ff-note ff-preview__empty">
            {props.totalGroupCount === 0
              ? "Nenhum lançamento na prévia."
              : "Nenhum estabelecimento bate com esse filtro."}
          </p>
        ) : null}
        {groups.map((group) => (
          <MerchantGroupRow
            key={group.key}
            group={group}
            props={props}
            expanded={expanded.has(group.key)}
            onToggleExpanded={() =>
              setExpanded((current) => toggleIn(current, group.key))
            }
            showAll={showAll.has(group.key)}
            onShowAll={() =>
              setShowAll((current) => new Set(current).add(group.key))
            }
            editing={editing}
            onToggleEditing={(index) =>
              setEditing((current) => toggleIn(current, index))
            }
          />
        ))}
      </div>

      <div className="ff-preview__foot">
        <div className="ff-preview__foot-info">
          {footer.summary}
          {footer.pendenciasCount > 0 ? (
            <button
              type="button"
              className="ff-btn ff-btn--link ff-preview__pendencias"
              onClick={footer.onOpenPendencias}
            >
              {countLabel(footer.pendenciasCount, "pendência", "pendências")}{" "}
              antes de gravar ›
            </button>
          ) : null}
          {props.comparison === "pending" ? (
            <span className="ff-note" role="status">
              Comparando com o banco…
            </span>
          ) : null}
          {footer.draftSavedAt !== null ? (
            <span className="ff-note ff-preview__draft">
              Rascunho salvo às {footer.draftSavedAt}
              {" · "}
              <button
                type="button"
                className="ff-btn ff-btn--link"
                onClick={footer.onContinueLater}
              >
                Continuar depois
              </button>
            </span>
          ) : null}
        </div>
        <div className="ff-preview__foot-actions">
          <span className="ff-preview__destination">{footer.destination}</span>
          <Button variant="ghost" onClick={footer.onBack}>
            ‹ Voltar
          </Button>
          <Button
            variant="primary"
            className="ff-preview__confirm"
            onClick={footer.onConfirm}
            disabled={footer.isPending}
            loading={footer.isPending}
            loadingText="Importando…"
          >
            {footer.confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}

function MerchantGroupRow({
  group,
  props,
  expanded,
  onToggleExpanded,
  showAll,
  onShowAll,
  editing,
  onToggleEditing,
}: {
  group: MerchantGroup;
  props: PreviewListProps;
  expanded: boolean;
  onToggleExpanded: () => void;
  showAll: boolean;
  onShowAll: () => void;
  editing: Set<number>;
  onToggleEditing: (index: number) => void;
}): ReactElement {
  const { rowsByIndex, categories, subsByCategory } = props;
  const views = group.indices
    .map((index) => rowsByIndex.get(index))
    .filter((view): view is PreviewRowView => view !== undefined);
  const editable = editableRows(group, rowsByIndex);
  const categoryId = uniform(editable.map((view) => view.categoryId));
  const subcategoryId = uniform(editable.map((view) => view.subcategoryId));
  const remember = editable.some((view) => view.rememberMerchant);
  const mixed = categoryId === "mixed";
  const groupCategory = categoryId === undefined || mixed ? "" : categoryId;
  const summary = summarizeGroup(
    views.map((view) => ({
      occurredOn: view.occurredOn,
      amount: { cents: view.amountCents },
      kind: view.kind,
    })),
  );
  const subs = subsByCategory.get(groupCategory) ?? [];

  const selectable = views.filter(
    (view) => !view.installmentRow && !view.duplicate && !view.dbDuplicate,
  );
  const selectedCount = selectable.filter((view) => !view.excluded).length;
  const allSelected =
    selectable.length > 0 && selectedCount === selectable.length;
  const noneSelected = views.every((view) => view.excluded);
  const recentlyChanged = views.some((view) => view.recentlyChanged);

  const aiCandidate = editable.find(
    (view) => view.aiSuggestion !== undefined && view.categoryId === "",
  );
  const aiCategoryName =
    aiCandidate?.aiSuggestion === undefined
      ? undefined
      : categories.find((c) => c.id === aiCandidate.aiSuggestion?.categoryId)
          ?.name;
  const priorDisposition = views.find(
    (view) => view.priorDisposition !== undefined,
  )?.priorDisposition;
  const singleInstallment =
    views.length === 1 ? views[0]?.row.installment : undefined;

  const state: ReactNode =
    categoryId === "mixed" ? (
      <span>misto</span>
    ) : groupCategory === "" && aiCandidate !== undefined && aiCategoryName ? (
      <button
        type="button"
        className="ff-btn ff-btn--link"
        onClick={() => {
          for (const view of editable) {
            if (view.aiSuggestion !== undefined)
              props.onApplyAiSuggestion(view.index);
          }
        }}
        title={aiCandidate.aiSuggestion?.explanation}
      >
        usar {aiCategoryName} ·{" "}
        {props.providerLabel(aiCandidate.aiSuggestion!.provider)}
      </button>
    ) : groupCategory === "" && priorDisposition !== undefined ? (
      <span>antes: {priorDisposition}</span>
    ) : groupCategory === "" && editable.length > 0 ? (
      <span className="ff-preview__warn">sem categoria</span>
    ) : singleInstallment !== undefined ? (
      <span>
        {singleInstallment.number}/{singleInstallment.count}
      </span>
    ) : null;

  const visible = showAll ? views : views.slice(0, COLLAPSED_OCCURRENCES);
  const hidden = views.length - visible.length;

  return (
    <div
      className={`ff-preview__group${noneSelected ? " ff-off" : ""}${recentlyChanged ? " ff-import-updated" : ""}`}
      data-merchant={group.key}
    >
      <div className="ff-preview__row">
        <input
          className="ff-check"
          type="checkbox"
          checked={allSelected}
          ref={(element) => {
            if (element)
              element.indeterminate = !allSelected && selectedCount > 0;
          }}
          disabled={selectable.length === 0}
          onChange={() => props.onToggleGroup(group, !allSelected)}
          aria-label={`Importar estabelecimento ${group.label}`}
        />
        <div className="ff-preview__merchant-cell">
          <button
            type="button"
            className="ff-preview__merchant"
            onClick={onToggleExpanded}
            aria-expanded={expanded}
          >
            <span className="ff-preview__label">{group.label}</span>
            <span className="ff-preview__sub">
              {countLabel(views.length, "lançamento", "lançamentos")}
              {" · "}
              {formatGroupDates(
                summary.firstDate,
                summary.lastDate,
                summary.dateCount,
              )}
            </span>
          </button>
          {state !== null ? (
            <span className="ff-preview__sub">{state}</span>
          ) : null}
        </div>
        <span className="ff-preview__right ff-num ff-preview__total">
          {formatBrl(summary.totalCents)}
        </span>
        <span>
          {editable.length === 0 ? (
            <span className="ff-dim">—</span>
          ) : (
            <Select
              className={`ff-select--compact${groupCategory === "" ? " ff-select--warn" : ""}`}
              value={groupCategory}
              onChange={(event) =>
                props.onGroupCategory(group, event.target.value)
              }
              aria-label={`Categoria do grupo ${group.label}`}
            >
              <option value="">
                {categoryId === "mixed" ? "misto…" : "escolher…"}
              </option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          )}
        </span>
        <span>
          {editable.length === 0 ? null : (
            <Select
              className="ff-select--compact"
              value={subcategoryId === "mixed" ? "" : (subcategoryId ?? "")}
              onChange={(event) =>
                props.onGroupSubcategory(group, event.target.value)
              }
              disabled={groupCategory === ""}
              aria-label={`Subcategoria do grupo ${group.label}`}
            >
              <option value="">
                {subcategoryId === "mixed" ? "misto…" : "(nenhuma)"}
              </option>
              {subs.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          )}
        </span>
        <label
          className="ff-preview__remember"
          title="Guardar essa categoria pra esse estabelecimento nas próximas importações"
        >
          <input
            type="checkbox"
            checked={remember}
            disabled={editable.length === 0 || groupCategory === ""}
            onChange={(event) =>
              props.onGroupRemember(group, event.target.checked)
            }
            aria-label={`Lembrar ${group.label}`}
          />
          <span className="ff-preview__remember-text">
            Lembrar pra próxima fatura
          </span>
        </label>
        <button
          type="button"
          className="ff-preview__expand"
          onClick={onToggleExpanded}
          aria-expanded={expanded}
          aria-label={
            expanded
              ? `Recolher ${group.label}`
              : `Ver lançamentos de ${group.label}`
          }
        >
          {expanded ? "▲" : "▼"}
        </button>
      </div>

      {expanded ? (
        <div className="ff-preview__occurrences">
          {visible.map((view) => (
            <OccurrenceRow
              key={view.index}
              view={view}
              group={group}
              groupCategory={groupCategory}
              mixed={mixed}
              props={props}
              editing={editing.has(view.index)}
              onToggleEditing={() => onToggleEditing(view.index)}
            />
          ))}
          {hidden > 0 ? (
            <button
              type="button"
              className="ff-btn ff-btn--link ff-preview__more"
              onClick={onShowAll}
            >
              ver {hidden === 1 ? "a outra" : `as outras ${hidden}`} →
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function OccurrenceRow({
  view,
  group,
  groupCategory,
  mixed,
  props,
  editing,
  onToggleEditing,
}: {
  view: PreviewRowView;
  group: MerchantGroup;
  groupCategory: string;
  /** Attached rows disagree, so each one shows its own category. */
  mixed: boolean;
  props: PreviewListProps;
  editing: boolean;
  onToggleEditing: () => void;
}): ReactElement {
  const { categories, subsByCategory } = props;
  const line = view.row.sourceLine;
  const subs = subsByCategory.get(view.categoryId) ?? [];
  const canLearn = !view.installmentRow && view.categoryId !== "";

  const status: ReactNode = view.installmentRow ? (
    <span className="ff-note">entra pelo parcelamento</span>
  ) : view.detached ? (
    <span className="ff-preview__own">
      <Select
        className={`ff-select--compact${view.categoryId === "" ? " ff-select--warn" : ""}`}
        value={view.categoryId}
        onChange={(event) =>
          props.onRowCategory(view.index, event.target.value)
        }
        aria-label={`Categoria linha ${line}`}
      >
        <option value="">escolher…</option>
        {categories.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
          </option>
        ))}
      </Select>
      <Select
        className="ff-select--compact"
        value={view.subcategoryId}
        onChange={(event) =>
          props.onRowSubcategory(view.index, event.target.value)
        }
        disabled={view.categoryId === ""}
        aria-label={`Subcategoria linha ${line}`}
      >
        <option value="">(nenhuma)</option>
        {subs.map((s) => (
          <option key={s.id} value={s.id}>
            {s.name}
          </option>
        ))}
      </Select>
      <button
        type="button"
        className="ff-btn ff-btn--link"
        onClick={() => props.onAttachRow(group, view.index)}
      >
        segue o grupo
      </button>
    </span>
  ) : (
    <span className="ff-preview__follows">
      <span className="ff-dim">
        {mixed
          ? (categories.find((c) => c.id === view.categoryId)?.name ??
            "sem categoria")
          : groupCategory === ""
            ? "sem categoria"
            : "segue o grupo"}
      </span>
      {" · "}
      <button
        type="button"
        className="ff-btn ff-btn--link"
        onClick={() => props.onDetachRow(view.index)}
      >
        mudar só esta
      </button>
    </span>
  );

  return (
    <div className={`ff-preview__occurrence${view.excluded ? " ff-off" : ""}`}>
      <input
        className="ff-check"
        type="checkbox"
        checked={!view.excluded}
        onChange={() => props.onToggleRow(view.index)}
        disabled={view.installmentRow}
        title={
          view.installmentRow
            ? "Parcelas entram pelo painel de parcelamentos"
            : undefined
        }
        aria-label={`Importar linha ${line}`}
      />
      <span className="ff-num ff-preview__date">
        {formatDayMonth(view.occurredOn)}
      </span>
      <span className="ff-preview__desc">
        {view.description}
        {view.row.installment !== undefined ? (
          <Badge tone="accent">
            {view.row.installment.number}/{view.row.installment.count}
          </Badge>
        ) : null}
      </span>
      <span
        className={`ff-num ff-preview__amount${view.kind === "income" ? " ff-preview__amount--in" : ""}`}
      >
        {view.kind === "income" ? "+" : ""}
        {formatBrl(view.amountCents)}
      </span>
      <span className="ff-preview__status">
        {view.duplicate ? (
          <Badge tone="negative">duplicata provável</Badge>
        ) : null}
        {view.dbDuplicate ? <Badge tone="neutral">já importada</Badge> : null}
        {props.comparison === "failed" && !view.installmentRow ? (
          <Badge tone="warn">sem comparar</Badge>
        ) : null}
        {view.suppressed ? (
          <Badge tone="neutral">sem categoria por memória</Badge>
        ) : null}
        {status}
        {canLearn && view.row.sourceCategory ? (
          <label
            className="ff-note"
            title="Opcional: mapear esta categoria do arquivo"
          >
            <input
              type="checkbox"
              checked={view.learnSourceCategory}
              onChange={(event) =>
                props.onLearnSourceCategory(view.index, event.target.checked)
              }
            />{" "}
            ensinar categoria da origem
          </label>
        ) : null}
        <button
          type="button"
          className="ff-btn ff-btn--link"
          onClick={onToggleEditing}
          aria-expanded={editing}
          aria-label={`Editar linha ${line}`}
        >
          {editing ? "fechar" : "editar"}
        </button>
      </span>
      {editing ? (
        <div className="ff-preview__edit">
          <Input
            className="ff-input--compact ff-num"
            type="date"
            value={view.occurredOn}
            onChange={(event) =>
              props.onRowEdit(view.index, { occurredOn: event.target.value })
            }
            aria-label={`Data linha ${line}`}
          />
          <Input
            className="ff-input--compact"
            value={view.description}
            maxLength={200}
            onChange={(event) =>
              props.onRowEdit(view.index, { description: event.target.value })
            }
            aria-label={`Descrição linha ${line}`}
          />
          <Input
            className="ff-input--compact ff-num"
            type="number"
            min={0.01}
            step={0.01}
            value={(view.amountCents / 100).toFixed(2)}
            onChange={(event) =>
              props.onRowEdit(view.index, {
                amountCents: Math.round(Number(event.target.value) * 100),
              })
            }
            aria-label={`Valor linha ${line}`}
          />
          <Select
            className="ff-select--compact"
            value={view.kind}
            onChange={(event) =>
              props.onRowEdit(view.index, {
                kind: event.target.value as "expense" | "income",
              })
            }
            aria-label={`Tipo linha ${line}`}
          >
            <option value="expense">saída</option>
            <option value="income">entrada</option>
          </Select>
        </div>
      ) : null}
    </div>
  );
}
