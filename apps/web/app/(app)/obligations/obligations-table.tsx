/**
 * "Suas obrigações" — the template list (desktop table + mobile row cards).
 *
 * Server component; the only interactive part is the per-row edit dialog. The
 * "Prazo" cell is the interesting one: indefinite templates get a badge,
 * future ones say when they start, running ones show progress + a track.
 * `?encerradas=1` appends the ended/canceled templates, faded and read-only.
 */

import Link from "next/link";
import type { ReactElement } from "react";

import {
  Badge,
  Card,
  IconDoc,
  RowCardList,
  Table,
  TableRow,
} from "../../../components/ui";
import { formatBrlCents } from "../../../lib/format";
import type { ObligationActionResult } from "./actions";
import { EditObligationDialog } from "./edit-obligation-dialog";
import type { OptionItem } from "./obligation-dialog-shell";
import type { ObligationListItem } from "./queries";
import {
  committedPerMonth,
  monthAbbrPtBr,
  termProgress,
  type TermProgress,
} from "./view-model";

const COLUMNS = [
  { key: "obligation", label: "Obrigação" },
  { key: "term", label: "Prazo" },
  { key: "amount", label: "Por mês", align: "right" as const },
  { key: "actions", label: "" },
];

/** Mockup grid, minus one of the two icon buttons (only "Editar" ships). */
const GRID = "minmax(0, 1fr) 260px 130px 48px";

function TermCell({ progress }: { progress: TermProgress }): ReactElement {
  if (progress.kind === "indefinite") {
    return <Badge tone="neutral">sem prazo</Badge>;
  }
  if (progress.kind === "future") {
    return (
      <Badge tone="accent">
        começa em {monthAbbrPtBr(progress.startMonth)}
        {progress.termMonths === null
          ? " · sem prazo"
          : ` · ${progress.termMonths} parcelas`}
      </Badge>
    );
  }
  const pct = Math.round((progress.elapsed / progress.total) * 1000) / 10;
  return (
    <div>
      <div className="ff-note ff-num ff-oblig-term-count">
        {progress.elapsed} de {progress.total} pagas · até{" "}
        {monthAbbrPtBr(progress.endMonth)}
      </div>
      <div className="ff-track ff-oblig-track">
        <div className="ff-track__fill" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export function ObligationsTable({
  items,
  ended,
  showEnded,
  currentMonth,
  accountName,
  categoryName,
  accounts,
  categories,
  updateAction,
  cancelAction,
}: {
  items: ObligationListItem[];
  ended: ObligationListItem[];
  showEnded: boolean;
  currentMonth: string;
  accountName: (id: string) => string;
  categoryName: (id: string | null) => string | null;
  accounts: OptionItem[];
  categories: OptionItem[];
  updateAction: (formData: FormData) => Promise<ObligationActionResult>;
  cancelAction: (formData: FormData) => Promise<ObligationActionResult>;
}): ReactElement {
  const committed = committedPerMonth(items, currentMonth);
  const listed = showEnded ? [...items, ...ended] : items;

  const subtitle = (item: ObligationListItem): string => {
    const category = categoryName(item.categoryId);
    const base = `vence dia ${item.dueDay} · ${accountName(item.accountId)}`;
    return category === null ? base : `${base} · ${category}`;
  };

  const isEnded = (item: ObligationListItem): boolean =>
    item.status !== "active";

  return (
    <div>
      <div className="ff-panel__head">
        <h2 className="ff-h2">Suas obrigações</h2>
        <span className="ff-note">
          {committed.activeCount === 1
            ? "1 ativa"
            : `${committed.activeCount} ativas`}{" "}
          · da maior pra menor
        </span>
      </div>

      <Table columns={COLUMNS} gridTemplate={GRID}>
        {listed.length === 0 ? (
          <TableRow>
            <span className="ff-muted">Nenhuma obrigação cadastrada.</span>
          </TableRow>
        ) : (
          listed.map((item) => (
            <TableRow
              key={item.id}
              className={isEnded(item) ? "ff-off" : undefined}
            >
              <div className="ff-oblig-row__name">
                <span className="ff-bubble">
                  <IconDoc size={16} />
                </span>
                <div>
                  <div className="ff-name">{item.description}</div>
                  <div className="ff-name-sub">{subtitle(item)}</div>
                </div>
              </div>
              {isEnded(item) ? (
                <Badge tone="neutral">encerrada</Badge>
              ) : (
                <TermCell progress={termProgress(item, currentMonth)} />
              )}
              <div className="ff-oblig-cell--amount ff-num">
                {formatBrlCents(item.amountCents)}
              </div>
              <div className="ff-oblig-cell--action">
                {isEnded(item) ? null : (
                  <EditObligationDialog
                    item={item}
                    progress={termProgress(item, currentMonth)}
                    currentMonth={currentMonth}
                    accounts={accounts}
                    categories={categories}
                    updateAction={updateAction}
                    cancelAction={cancelAction}
                  />
                )}
              </div>
            </TableRow>
          ))
        )}

        <div className="ff-table__foot">
          <span className="ff-table__foot-note">
            {showEnded
              ? "As encerradas aparecem no fim da lista. "
              : "Obrigações encerradas não aparecem aqui. "}
            <Link className="ff-link" href={showEnded ? "?" : "?encerradas=1"}>
              {showEnded ? "esconder encerradas" : "ver encerradas →"}
            </Link>
          </span>
          <span className="ff-table__foot-note ff-num">
            {committed.fromMonth === null
              ? "Total"
              : `Total a partir de ${monthAbbrPtBr(committed.fromMonth)}`}
            : {formatBrlCents(committed.totalCents)}/mês
          </span>
        </div>
      </Table>

      <RowCardList>
        {listed.map((item) => (
          <Card
            key={item.id}
            className={`ff-rowcard${isEnded(item) ? " ff-off" : ""}`}
            soft={false}
          >
            <div className="ff-oblig-rowcard__body">
              <div className="ff-name">{item.description}</div>
              <div className="ff-name-sub">{subtitle(item)}</div>
            </div>
            <div className="ff-oblig-cell--amount ff-num">
              {formatBrlCents(item.amountCents)}
            </div>
            {isEnded(item) ? null : (
              <EditObligationDialog
                item={item}
                progress={termProgress(item, currentMonth)}
                currentMonth={currentMonth}
                accounts={accounts}
                categories={categories}
                updateAction={updateAction}
                cancelAction={cancelAction}
              />
            )}
          </Card>
        ))}
      </RowCardList>
    </div>
  );
}
