/**
 * Core presentational primitives — "Editorial acolhedor".
 *
 * All visuals come from `ui.css` classes whose values are copied verbatim
 * from docs/design/2026-07-02-claude-design-mockups/. Design firewall:
 * props/children in, markup out — no data, no server context.
 */
import type { ReactElement, ReactNode } from "react";

function cx(...parts: Array<string | false | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

/** Gold uppercase micro-label (Inter 600 · 11px · 0.24em). */
export function Kicker({ children }: { children: ReactNode }): ReactElement {
  return <div className="ff-kicker">{children}</div>;
}

/** Page header: kicker + Playfair title + optional lead, actions on the right. */
export function PageTitle({
  kicker,
  title,
  lead,
  actions,
}: {
  kicker: string;
  title: string;
  lead?: string;
  actions?: ReactNode;
}): ReactElement {
  return (
    <header className="ff-page-title">
      <div>
        <Kicker>{kicker}</Kicker>
        <h1 className="ff-page-title__heading">{title}</h1>
        {lead ? <p className="ff-page-title__lead">{lead}</p> : null}
      </div>
      {actions ? <div className="ff-page-title__actions">{actions}</div> : null}
    </header>
  );
}

/** Hairline-bordered surface card; modifiers per mockups. */
export function Card({
  children,
  soft,
  hoverable,
  warnEdge,
  accentEdge,
  className,
}: {
  children: ReactNode;
  soft?: boolean;
  hoverable?: boolean;
  warnEdge?: boolean;
  accentEdge?: boolean;
  className?: string;
}): ReactElement {
  return (
    <div
      className={cx(
        "ff-card",
        soft && "ff-card--soft",
        hoverable && "ff-card--hoverable",
        warnEdge && "ff-card--warn-edge",
        accentEdge && "ff-card--accent-edge",
        className,
      )}
    >
      {children}
    </div>
  );
}

/** Stat card: uppercase kicker + Playfair tabular value + optional hint. */
export function StatCard({
  kicker,
  value,
  hint,
  tone = "default",
}: {
  kicker: string;
  value: string;
  hint?: ReactNode;
  tone?: "default" | "positive";
}): ReactElement {
  return (
    <div className="ff-stat">
      <div className="ff-stat__kicker">{kicker}</div>
      <div
        className={cx(
          "ff-stat__value",
          "ff-serif",
          "ff-num",
          tone === "positive" && "ff-stat__value--positive",
        )}
      >
        {value}
      </div>
      {hint ? <div className="ff-stat__hint">{hint}</div> : null}
    </div>
  );
}

export type BadgeTone = "warn" | "negative" | "positive" | "accent" | "neutral";

/** 999px pill on the tone's wash background (mockup: 5px 12px, Inter 600 11px). */
export function Badge({
  tone,
  children,
  dot,
}: {
  tone: BadgeTone;
  children: ReactNode;
  dot?: boolean;
}): ReactElement {
  return (
    <span className={cx("ff-badge", `ff-badge--${tone}`)}>
      {dot ? <span className="ff-badge__dot" /> : null}
      {children}
    </span>
  );
}

/** Button voices from the design system: primary / ghost / danger / link. */
export function Button({
  variant = "ghost",
  type = "button",
  onClick,
  disabled,
  children,
}: {
  variant?: "primary" | "ghost" | "danger" | "link";
  type?: "button" | "submit";
  onClick?: () => void;
  disabled?: boolean;
  children: ReactNode;
}): ReactElement {
  return (
    <button
      className={cx("ff-btn", `ff-btn--${variant}`)}
      type={type}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}

/** Comparison chip, e.g. "↓ R$ 320 a menos que junho 🌱". */
export function Delta({
  direction,
  tone,
  children,
}: {
  direction: "down" | "up";
  tone: "positive" | "negative";
  children: ReactNode;
}): ReactElement {
  return (
    <span className={cx("ff-delta", `ff-delta--${tone}`, "ff-num")}>
      {direction === "down" ? "↓" : "↑"} {children}
    </span>
  );
}

/** Dashed-border empty state with icon bubble, serif title and optional action. */
export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  action?: ReactNode;
}): ReactElement {
  return (
    <div className="ff-empty">
      <span className="ff-empty__icon">{icon}</span>
      <div className="ff-empty__title ff-serif">{title}</div>
      <div className="ff-empty__description">{description}</div>
      {action ? <div className="ff-empty__action">{action}</div> : null}
    </div>
  );
}
