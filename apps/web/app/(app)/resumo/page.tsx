import Link from "next/link";

import { requireAuthorizedUser } from "../../../lib/auth";
import { currentMemberName } from "../../../lib/member";
import { formatBrlCents } from "../../../lib/format";
import { RecentTransactions } from "../../../components/recent-transactions";
import { Badge, Card, Delta, IconCard, IconTag, Kicker } from "../../../components/ui";
import {
  loadResumoData,
  monthLabelPtBr,
  spendingComparisonLabel,
} from "./queries";
import { shiftMonth } from "../transactions/filters";

export const metadata = {
  title: "Resumo — Casa",
};

// Per-request, RLS-scoped data; never statically prerender.
export const dynamic = "force-dynamic";


/** Split "R$ 4.812,90" into ["R$ 4.812", ",90"] for the hero's smaller cents. */
function splitCents(value: string): [string, string] {
  const idx = value.lastIndexOf(",");
  return idx === -1 ? [value, ""] : [value.slice(0, idx), value.slice(idx)];
}

/**
 * "/resumo" — read-only daily summary, optimized for a 10-second phone check:
 * gasto do mês + comparison, fatura projetada per card, pendentes chip and
 * the last 5 lançamentos. Skinned per Resumo.dc.html ("Editorial acolhedor").
 */
export default async function ResumoPage() {
  const { email } = await requireAuthorizedUser();
  const data = await loadResumoData();
  const {
    month,
    totalSpentCents,
    accountSpentCents,
    cardSpentCents,
    deltaVsPreviousCents,
    cards,
    obligationsCents,
    pendingCount,
    recent,
    loadError,
  } = data;
  const previousMonth = shiftMonth(month, -1);
  const name = await currentMemberName(email);
  const [spentMain, spentCentsPart] = splitCents(formatBrlCents(totalSpentCents));
  const comparison = spendingComparisonLabel(deltaVsPreviousCents, previousMonth);

  return (
    <section style={{ maxWidth: 980, margin: "0 auto" }}>
      <Kicker>Nossa casa · {monthLabelPtBr(month)}</Kicker>
      <h1 className="ff-hello">Oi, {name}</h1>
      <p className="ff-hello-lead">Como estão as contas da casa?</p>

      {loadError ? (
        <div role="alert" className="ff-alert ff-alert--negative" style={{ marginTop: 20 }}>
          Não foi possível carregar o resumo agora; mostrando tudo zerado.{" "}
          ({loadError})
        </div>
      ) : null}

      <div className="ff-grid-resumo">
        {/* Left column */}
        <div className="ff-stack">
          {/* Gasto do mês */}
          <Card>
            <div className="ff-hero__kicker">Gasto do mês</div>
            <div className="ff-hero__value ff-serif ff-num">
              {spentMain}
              {spentCentsPart ? (
                <span className="ff-hero__cents">{spentCentsPart}</span>
              ) : null}
            </div>
            <div className="ff-hero__split ff-num">
              <span>
                <strong>{formatBrlCents(accountSpentCents)}</strong> em conta
              </span>
              <span className="ff-hero__split-sep">·</span>
              <span>
                <strong>{formatBrlCents(cardSpentCents)}</strong> no cartão
              </span>
            </div>
            {obligationsCents > 0 ? (
              <div className="ff-hero__split ff-num">
                <span>
                  <strong>{formatBrlCents(obligationsCents)}</strong> em
                  obrigações fixas no mês
                </span>
              </div>
            ) : null}
            <div className="ff-hero__delta">
              {deltaVsPreviousCents === 0 ? (
                <span className="ff-delta ff-delta--positive ff-num">
                  {comparison}
                </span>
              ) : (
                <Delta
                  direction={deltaVsPreviousCents > 0 ? "down" : "up"}
                  tone={deltaVsPreviousCents > 0 ? "positive" : "negative"}
                >
                  {comparison}
                </Delta>
              )}
            </div>
          </Card>

          {/* Pendentes de revisão */}
          {pendingCount > 0 ? (
            <Link href="/transactions?pending=1" className="ff-callout ff-callout--warn">
              <span className="ff-callout__bubble">
                <IconTag size={17} />
              </span>
              <span className="ff-callout__text">
                Falta categorizar{" "}
                <strong>
                  {pendingCount === 1
                    ? "1 lançamento"
                    : `${pendingCount} lançamentos`}
                </strong>
              </span>
              <span className="ff-callout__arrow">→</span>
            </Link>
          ) : (
            <div className="ff-callout ff-callout--positive">
              <span className="ff-callout__text">Tudo revisado por aqui ✨</span>
            </div>
          )}

          {/* Faturas dos cartões */}
          <div>
            <h2 className="ff-h2" style={{ margin: "8px 0 12px" }}>
              Faturas dos cartões
            </h2>
            {cards.length === 0 ? (
              <p className="ff-muted">Nenhum cartão cadastrado.</p>
            ) : (
              <div className="ff-cards-grid">
                {cards.map((card) => (
                  <Card key={card.id} hoverable className="ff-icard">
                    <div className="ff-icard__head">
                      <span className="ff-bubble">
                        <IconCard size={17} />
                      </span>
                      <div className="ff-icard__name">
                        {card.name}
                        {card.settled ? <Badge tone="positive">paga ✅</Badge> : null}
                      </div>
                    </div>
                    <div className="ff-icard__value ff-serif ff-num">
                      {formatBrlCents(card.projectedCents)}
                    </div>
                  </Card>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Right column: últimos lançamentos */}
        <div className="ff-listcard">
          <div className="ff-listcard__head">
            <h2 className="ff-h2">Últimos lançamentos</h2>
            <Link href="/transactions" className="ff-link">
              ver tudo →
            </Link>
          </div>
          <div className="ff-listcard__body">
            <RecentTransactions transactions={recent} formatCents={formatBrlCents} />
          </div>
        </div>
      </div>
    </section>
  );
}
