/**
 * Form presentational primitives — "Editorial acolhedor".
 *
 * Values copied verbatim from docs/design/2026-07-02-claude-design-mockups/
 * (Design System.dc.html inputs & selects, Transacoes.dc.html filter bar).
 * Design firewall: props in, markup out — no data, no server context.
 */
import Link from "next/link";
import type { ComponentProps, ReactElement, ReactNode } from "react";

function cx(...parts: Array<string | false | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

/** Uppercase mini-label (Inter 500 · 11px · 0.14em) wrapping its control. */
export function Field({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}): ReactElement {
  return (
    <div className="ff-field">
      <label className="ff-field__label">{label}</label>
      {children}
    </div>
  );
}

/** Text input on the soft surface; focus ring = 3px gold tint. */
export function Input(props: ComponentProps<"input">): ReactElement {
  const { className, ...rest } = props;
  return <input {...rest} className={cx("ff-input", className)} />;
}

/** Native select inside the mockups' styled shell with the gold caret. */
export function Select(props: ComponentProps<"select">): ReactElement {
  const { className, ...rest } = props;
  return (
    <span className={cx("ff-select", className)}>
      <select {...rest} className="ff-select__control" />
      <span className="ff-select__caret" aria-hidden>
        ▾
      </span>
    </span>
  );
}

/** Pill ‹ mês › stepper — Link-based so GET filters are preserved. */
export function MonthStepper({
  label,
  prevHref,
  nextHref,
}: {
  label: string;
  prevHref: string;
  nextHref: string;
}): ReactElement {
  return (
    <span className="ff-stepper">
      <Link className="ff-stepper__arrow" href={prevHref} aria-label="mês anterior">
        ‹
      </Link>
      <span className="ff-stepper__label">{label}</span>
      <Link className="ff-stepper__arrow" href={nextHref} aria-label="próximo mês">
        ›
      </Link>
    </span>
  );
}

/** Filter pill, e.g. "Só pendentes · 3" — warn wash when active. */
export function PillToggle({
  active,
  href,
  children,
}: {
  active: boolean;
  href: string;
  children: ReactNode;
}): ReactElement {
  return (
    <Link className={cx("ff-pill", active && "ff-pill--active")} href={href}>
      {children}
    </Link>
  );
}
