/**
 * Table presentational primitives — "Editorial acolhedor".
 *
 * Desktop: hairline-rounded grid table (Transacoes.dc.html). Mobile:
 * pages render BOTH `Table` and `RowCardList`; a CSS media query at 720px
 * picks which one shows (no JS, server-rendered).
 * Design firewall: props in, markup out — no data, no server context.
 */
import type { CSSProperties, ReactElement, ReactNode } from "react";

function cx(...parts: Array<string | false | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

/**
 * Desktop grid table. `gridTemplate` feeds a CSS variable consumed by the
 * header and every `TableRow`, so rows stay aligned to the same columns.
 */
export function Table({
  columns,
  gridTemplate,
  children,
}: {
  columns: Array<{ key: string; label: string; align?: "right" }>;
  gridTemplate: string;
  children: ReactNode;
}): ReactElement {
  return (
    <div
      className="ff-table"
      style={{ "--ff-table-grid": gridTemplate } as CSSProperties}
    >
      <div className="ff-table__head">
        {columns.map((column) => (
          <span
            key={column.key}
            className={cx(
              "ff-table__th",
              column.align === "right" && "ff-table__th--right",
            )}
          >
            {column.label}
          </span>
        ))}
      </div>
      {children}
    </div>
  );
}

/** One grid row; `pending` adds the warn inset stripe from the mockup. */
export function TableRow({
  children,
  pending,
  className,
}: {
  children: ReactNode;
  pending?: boolean;
  className?: string;
}): ReactElement {
  return (
    <div className={cx("ff-row", pending && "ff-row--pending", className)}>
      {children}
    </div>
  );
}

/** Mobile stack of row cards — children are `Card`s (Transacoes mobile). */
export function RowCardList({ children }: { children: ReactNode }): ReactElement {
  return <div className="ff-rowcards">{children}</div>;
}
