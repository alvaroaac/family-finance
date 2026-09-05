/**
 * "Próximos 12 meses" — a change-only timeline.
 *
 * Server component. One `<details>` per month: the summary is the row (month,
 * proportional bar, badges for what CHANGES that month, total); opening it
 * lists the month's entries. Only the first changed month starts open, so the
 * page reads as "here is what moves", not as twelve identical lists.
 */

import type { ReactElement } from "react";

import { Badge, Card } from "../../../components/ui/primitives";
import { formatBrlCents } from "../../../lib/format";
import type { TimelineMonth } from "./queries";
import {
  barWidths,
  monthAbbrPtBr,
  type TimelineChange,
  type reliefNote,
} from "./view-model";

function changeBadge(change: TimelineChange, key: number): ReactElement {
  if (change.kind === "starts") {
    return (
      <Badge key={key} tone="accent">
        + {change.description} · {formatBrlCents(change.amountCents)}
      </Badge>
    );
  }
  if (change.kind === "last") {
    return (
      <Badge key={key} tone="neutral">
        última parcela · {change.description}
      </Badge>
    );
  }
  return (
    <Badge key={key} tone="positive">
      − {change.description} quitada · {formatBrlCents(change.amountCents)}
    </Badge>
  );
}

export function TimelineCard({
  timeline,
  changes,
  relief,
  paidByMonth,
}: {
  timeline: TimelineMonth[];
  changes: Map<string, TimelineChange[]>;
  relief: ReturnType<typeof reliefNote>;
  paidByMonth: Map<string, string[]>;
}): ReactElement {
  const currentMonth = timeline[0]?.month;
  const firstChanged = timeline.find((slot) => changes.has(slot.month))?.month;
  const maxTotalCents = timeline.reduce(
    (max, slot) => Math.max(max, slot.totalCents),
    0,
  );

  return (
    <Card className="ff-oblig-panel">
      <div className="ff-panel__head ff-oblig-panel__head">
        <h2 className="ff-h2">Próximos 12 meses</h2>
        {relief === null ? null : (
          <span className="ff-note ff-oblig-relief">
            ↓ alívio de {formatBrlCents(relief.amountCents)}/mês a partir de{" "}
            {monthAbbrPtBr(relief.fromMonth)}
          </span>
        )}
      </div>
      <p className="ff-note ff-oblig-panel__note">
        Só o que muda de um mês pro outro aparece marcado. Clique num mês pra
        ver o detalhe.
      </p>

      {timeline.length === 0 ? (
        <p className="ff-muted ff-oblig-panel__note">
          Nenhuma obrigação projetada para os próximos meses.
        </p>
      ) : null}

      {timeline.map((slot) => {
        const monthChanges = changes.get(slot.month) ?? [];
        const isNow = slot.month === currentMonth;
        const strong = isNow || monthChanges.length > 0;
        const { totalPct, paidPct } = barWidths(slot, maxTotalCents);
        const paidNames = paidByMonth.get(slot.month) ?? [];
        return (
          <details key={slot.month} open={slot.month === firstChanged}>
            <summary
              className={`ff-timeline__row${isNow ? " ff-timeline__row--now" : ""}`}
            >
              <div>
                <div
                  className={`ff-num ff-timeline__month${strong ? " ff-timeline__month--strong" : ""}`}
                >
                  {monthAbbrPtBr(slot.month)}
                </div>
                {isNow ? <div className="ff-timeline__now">agora</div> : null}
              </div>
              <div className="ff-timeline__badges">
                <div
                  className={`ff-timeline__bar${strong ? " ff-timeline__bar--strong" : ""}`}
                  style={{ width: `${totalPct}%` }}
                >
                  {paidPct > 0 ? (
                    <div
                      className="ff-timeline__bar-paid"
                      style={{ width: `${(paidPct / totalPct) * 100}%` }}
                    />
                  ) : null}
                </div>
                {isNow && slot.paidCents > 0 ? (
                  <span className="ff-note ff-num">
                    {formatBrlCents(slot.paidCents)} pago
                  </span>
                ) : null}
                {monthChanges.map(changeBadge)}
              </div>
              <div
                className={`ff-oblig-cell--amount ff-num${strong ? "" : " ff-oblig-cell--soft"}`}
              >
                {formatBrlCents(slot.totalCents)}
              </div>
              <span className="ff-timeline__chevron">
                <svg
                  aria-hidden="true"
                  fill="none"
                  height="16"
                  stroke="currentColor"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth="1.8"
                  viewBox="0 0 24 24"
                  width="16"
                >
                  <path d="M9 6l6 6-6 6" />
                </svg>
              </span>
            </summary>
            <div className="ff-timeline__detail">
              {slot.entries.map((entry) => (
                <div
                  className="ff-timeline__detail-item"
                  key={entry.obligationId}
                >
                  <span>{entry.description}</span>
                  <span className="ff-num">
                    {formatBrlCents(entry.amountCents)}
                  </span>
                </div>
              ))}
              {paidNames.map((name) => (
                <div className="ff-timeline__detail-item" key={`paid-${name}`}>
                  <span>{name}</span>
                  <Badge tone="positive">paga</Badge>
                </div>
              ))}
              {slot.entries.length === 0 && paidNames.length === 0 ? (
                <div className="ff-muted">Nada projetado neste mês.</div>
              ) : null}
            </div>
          </details>
        );
      })}
    </Card>
  );
}
