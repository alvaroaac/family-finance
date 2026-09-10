import type { ReactElement } from "react";

import { Card } from "./primitives";
import { Skeleton } from "./skeleton";

export type RouteSkeletonVariant =
  | "default"
  | "resumo"
  | "dashboard"
  | "transactions"
  | "imports"
  | "categories"
  | "accounts"
  | "cards"
  | "obligations"
  | "investments"
  | "settings";

const THREE_ROWS = ["one", "two", "three"] as const;
const FOUR_ROWS = [...THREE_ROWS, "four"] as const;
const SIX_ROWS = [...FOUR_ROWS, "five", "six"] as const;

function PageHeading({ action = false }: { action?: boolean }): ReactElement {
  return (
    <div className="ff-skeleton-heading">
      <div className="ff-skeleton-heading__copy">
        <Skeleton width={150} height={11} />
        <Skeleton width={280} height={38} />
        <Skeleton width="min(520px, 86%)" height={15} />
      </div>
      {action ? <Skeleton width={146} height={42} /> : null}
    </div>
  );
}

function TextRows({ count = 3 }: { count?: 3 | 4 }): ReactElement {
  const rows = count === 4 ? FOUR_ROWS : THREE_ROWS;
  return (
    <div className="ff-skeleton-rows">
      {rows.map((row, index) => (
        <div className="ff-skeleton-row" key={row}>
          <Skeleton width={index % 2 === 0 ? "58%" : "72%"} height={13} />
          <Skeleton width={index % 2 === 0 ? 86 : 112} height={13} />
        </div>
      ))}
    </div>
  );
}

function FormFields({ count = 3 }: { count?: 2 | 3 | 4 }): ReactElement {
  return (
    <div className="ff-skeleton-fields">
      {Array.from({ length: count }, (_, index) => (
        <div className="ff-skeleton-field" key={`field-${index + 1}`}>
          <Skeleton width={index % 2 === 0 ? 82 : 108} height={10} />
          <Skeleton height={40} />
        </div>
      ))}
      <Skeleton width={122} height={40} />
    </div>
  );
}

function ResumoSkeleton(): ReactElement {
  return (
    <section className="ff-skeleton-page ff-skeleton-page--narrow">
      <Skeleton width={170} height={11} />
      <Skeleton width={220} height={42} className="ff-skeleton-gap-sm" />
      <Skeleton width={250} height={15} className="ff-skeleton-gap-xs" />
      <div className="ff-grid-resumo">
        <div className="ff-stack">
          <Card>
            <Skeleton width={120} height={11} />
            <Skeleton width={230} height={52} className="ff-skeleton-gap-md" />
            <Skeleton width="72%" height={14} className="ff-skeleton-gap-md" />
          </Card>
          <Skeleton width="100%" height={58} />
          <div>
            <Skeleton width={160} height={22} />
            <div className="ff-cards-grid ff-skeleton-gap-md">
              <Card>
                <Skeleton width={100} height={13} />
                <Skeleton
                  width={130}
                  height={28}
                  className="ff-skeleton-gap-md"
                />
              </Card>
              <Card>
                <Skeleton width={110} height={13} />
                <Skeleton
                  width={120}
                  height={28}
                  className="ff-skeleton-gap-md"
                />
              </Card>
            </div>
          </div>
        </div>
        <Card>
          <Skeleton width={170} height={22} />
          <TextRows count={4} />
        </Card>
      </div>
    </section>
  );
}

function DashboardSkeleton(): ReactElement {
  return (
    <section className="ff-skeleton-page">
      <PageHeading action />
      <div className="ff-grid-stats">
        {Array.from({ length: 5 }, (_, index) => (
          <div className="ff-stat" key={`stat-${index + 1}`}>
            <Skeleton width={index === 3 ? 130 : 82} height={10} />
            <Skeleton
              width={index % 2 === 0 ? 132 : 108}
              height={34}
              className="ff-skeleton-gap-md"
            />
            <Skeleton width="78%" height={11} className="ff-skeleton-gap-sm" />
          </div>
        ))}
      </div>
      <div className="ff-grid-2-1">
        <Card>
          <Skeleton width={190} height={22} />
          <Skeleton height={150} className="ff-skeleton-gap-lg" />
        </Card>
        <Card>
          <Skeleton width={110} height={22} />
          <TextRows />
        </Card>
      </div>
      <div className="ff-grid-2-1">
        <Card>
          <Skeleton width={170} height={22} />
          <TextRows count={4} />
        </Card>
        <Card>
          <Skeleton width={100} height={22} />
          <TextRows />
        </Card>
      </div>
    </section>
  );
}

function TransactionsSkeleton(): ReactElement {
  return (
    <section className="ff-skeleton-page">
      <PageHeading />
      <Skeleton width={175} height={42} className="ff-skeleton-gap-lg" />
      <div className="ff-filterbar">
        <Skeleton width={180} height={38} />
        <div className="ff-skeleton-filter-fields">
          {THREE_ROWS.map((row) => (
            <Skeleton width={145} height={40} key={row} />
          ))}
          <Skeleton width={190} height={40} />
        </div>
      </div>
      <div className="ff-skeleton-table">
        <div className="ff-skeleton-table__head">
          <Skeleton height={12} />
        </div>
        <TextRows count={4} />
        <TextRows count={3} />
      </div>
    </section>
  );
}

function ImportsSkeleton(): ReactElement {
  return (
    <section className="ff-skeleton-page ff-skeleton-page--narrow">
      <PageHeading />
      <div className="ff-skeleton-steps">
        {THREE_ROWS.map((row) => (
          <Skeleton width={150} height={28} key={row} />
        ))}
      </div>
      <Card>
        <Skeleton width={190} height={24} />
        <Skeleton width="64%" height={14} className="ff-skeleton-gap-sm" />
        <div className="ff-skeleton-upload ff-skeleton-gap-lg">
          <Skeleton width={44} height={44} />
          <Skeleton width={210} height={18} />
          <Skeleton width={160} height={12} />
        </div>
        <Skeleton height={44} className="ff-skeleton-gap-lg" />
      </Card>
    </section>
  );
}

function CategoriesSkeleton(): ReactElement {
  return (
    <section className="ff-skeleton-page ff-skeleton-page--narrow">
      <PageHeading />
      <div className="ff-skeleton-category-list">
        <TextRows count={4} />
      </div>
      <Card>
        <Skeleton width={180} height={22} />
        <FormFields count={2} />
      </Card>
      <Card>
        <Skeleton width={220} height={22} />
        <Skeleton width="70%" height={13} className="ff-skeleton-gap-sm" />
        <FormFields count={3} />
        <TextRows />
      </Card>
    </section>
  );
}

function CollectionSkeleton({
  variant,
}: {
  variant: "accounts" | "cards" | "investments";
}): ReactElement {
  const cards = variant === "cards" ? 2 : 3;
  return (
    <section className="ff-skeleton-page ff-skeleton-page--narrow">
      <PageHeading action={variant !== "accounts"} />
      <div className="ff-cards-grid ff-skeleton-gap-lg">
        {Array.from({ length: cards }, (_, index) => (
          <Card key={`${variant}-${index + 1}`}>
            <div className="ff-skeleton-card-head">
              <Skeleton width={42} height={42} />
              <div>
                <Skeleton width={140} height={17} />
                <Skeleton
                  width={105}
                  height={11}
                  className="ff-skeleton-gap-xs"
                />
              </div>
            </div>
            {variant === "investments" ? (
              <Skeleton
                width={150}
                height={34}
                className="ff-skeleton-gap-lg"
              />
            ) : null}
            <div className="ff-skeleton-actions">
              <Skeleton width="55%" height={38} />
              <Skeleton width={90} height={38} />
            </div>
          </Card>
        ))}
      </div>
      <Card>
        <Skeleton width={variant === "investments" ? 150 : 130} height={22} />
        <FormFields count={variant === "cards" ? 3 : 2} />
      </Card>
      {variant === "cards" ? (
        <Card>
          <Skeleton width={210} height={22} />
          <FormFields count={4} />
        </Card>
      ) : null}
    </section>
  );
}

function ObligationsSkeleton(): ReactElement {
  return (
    <section className="ff-skeleton-page ff-skeleton-page--narrow ff-has-sticky-cta">
      <PageHeading action />
      <div className="ff-oblig-stats">
        {Array.from({ length: 3 }, (_, index) => (
          <div className="ff-stat" key={`oblig-stat-${index + 1}`}>
            <Skeleton width={index === 1 ? 128 : 96} height={10} />
            <Skeleton
              width={index === 2 ? 110 : 168}
              height={30}
              className="ff-skeleton-gap-md"
            />
            <Skeleton width="76%" height={11} className="ff-skeleton-gap-sm" />
          </div>
        ))}
      </div>
      <Card className="ff-oblig-panel">
        <div className="ff-panel__head ff-oblig-panel__head">
          <Skeleton width={240} height={22} />
        </div>
        <div className="ff-checklist">
          {FOUR_ROWS.map((row) => (
            <div className="ff-checklist__row" key={row}>
              <Skeleton width={44} height={44} />
              <Skeleton width="62%" height={15} />
              <span />
              <Skeleton width={104} height={15} />
              <Skeleton width={146} height={34} />
            </div>
          ))}
        </div>
      </Card>
      <Card className="ff-oblig-panel">
        <div className="ff-panel__head ff-oblig-panel__head">
          <Skeleton width={190} height={22} />
        </div>
        <div className="ff-note ff-oblig-panel__note">
          <Skeleton width="72%" height={13} />
        </div>
        <div>
          {SIX_ROWS.map((row, index) => (
            <div className="ff-timeline__row" key={row}>
              <Skeleton width={64} height={14} />
              <div className="ff-timeline__badges">
                <Skeleton width={`${92 - index * 6}%`} height={10} />
              </div>
              <Skeleton width={110} height={15} />
              <span className="ff-timeline__chevron">
                <Skeleton width={18} height={18} />
              </span>
            </div>
          ))}
        </div>
      </Card>
      <div>
        <div className="ff-panel__head">
          <Skeleton width={190} height={22} />
        </div>
        <Card>
          <TextRows count={4} />
        </Card>
      </div>
    </section>
  );
}

function SettingsSkeleton(): ReactElement {
  return (
    <section className="ff-skeleton-page ff-skeleton-page--settings">
      <PageHeading />
      <Card>
        <Skeleton width={140} height={22} />
        <Skeleton width="60%" height={13} className="ff-skeleton-gap-sm" />
        <div className="ff-skeleton-theme-grid">
          <Skeleton height={100} />
          <Skeleton height={100} />
        </div>
      </Card>
      <Card>
        <Skeleton width={150} height={22} />
        <TextRows count={3} />
      </Card>
      <Card>
        <Skeleton width={170} height={22} />
        <div className="ff-skeleton-card-head ff-skeleton-gap-lg">
          <Skeleton width={42} height={42} />
          <div>
            <Skeleton width={180} height={14} />
            <Skeleton width={130} height={11} className="ff-skeleton-gap-xs" />
          </div>
        </div>
      </Card>
    </section>
  );
}

export function RouteSkeleton({
  variant,
}: {
  variant: RouteSkeletonVariant;
}): ReactElement {
  let content: ReactElement;
  switch (variant) {
    case "resumo":
      content = <ResumoSkeleton />;
      break;
    case "dashboard":
      content = <DashboardSkeleton />;
      break;
    case "transactions":
      content = <TransactionsSkeleton />;
      break;
    case "imports":
      content = <ImportsSkeleton />;
      break;
    case "categories":
      content = <CategoriesSkeleton />;
      break;
    case "accounts":
    case "cards":
    case "investments":
      content = <CollectionSkeleton variant={variant} />;
      break;
    case "obligations":
      content = <ObligationsSkeleton />;
      break;
    case "settings":
      content = <SettingsSkeleton />;
      break;
    default:
      content = <DashboardSkeleton />;
  }

  return (
    <div role="status" aria-live="polite" aria-label="Carregando conteúdo">
      {content}
      <span className="ff-sr-only">Carregando…</span>
    </div>
  );
}
