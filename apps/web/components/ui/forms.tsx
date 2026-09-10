/**
 * Form presentational primitives — "Editorial acolhedor".
 *
 * Values copied verbatim from docs/design/2026-07-02-claude-design-mockups/
 * (Design System.dc.html inputs & selects, Transacoes.dc.html filter bar).
 * Design firewall: props in, markup out — no data, no server context.
 */
import Link from "next/link";
import type {
  ComponentProps,
  KeyboardEvent,
  ReactElement,
  ReactNode,
} from "react";

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

/**
 * Pill segmented control (Obrigacoes mockups `.seg`) — a radiogroup whose
 * arrow keys move the selection and wrap around, as ARIA prescribes.
 */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
}: {
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (value: T) => void;
  ariaLabel: string;
}): ReactElement {
  const activeIndex = options.findIndex((option) => option.value === value);
  // With no match the group would be unreachable by keyboard, so keep the
  // first option in the tab order.
  const focusIndex = activeIndex < 0 ? 0 : activeIndex;

  // Re-selecting the current option is not a change, so stay quiet.
  function report(next: T): void {
    if (next === value) return;
    onChange(next);
  }

  function select(group: HTMLElement, step: number): void {
    const index = (focusIndex + step + options.length) % options.length;
    const option = options[index];
    if (!option) return;
    const target = group.children[index];
    if (target instanceof HTMLElement) target.focus();
    report(option.value);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    const step =
      event.key === "ArrowLeft" || event.key === "ArrowUp"
        ? -1
        : event.key === "ArrowRight" || event.key === "ArrowDown"
          ? 1
          : 0;
    if (step === 0) return;
    event.preventDefault();
    select(event.currentTarget, step);
  }

  return (
    <div
      className="ff-seg"
      role="radiogroup"
      aria-label={ariaLabel}
      onKeyDown={handleKeyDown}
    >
      {options.map((option, index) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          tabIndex={index === focusIndex ? 0 : -1}
          className={cx(
            "ff-seg__item",
            option.value === value && "ff-seg__item--on",
          )}
          onClick={() => report(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
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
