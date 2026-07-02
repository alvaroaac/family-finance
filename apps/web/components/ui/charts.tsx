/**
 * Chart presentational primitives — "Editorial acolhedor".
 *
 * PressureBars = the "Pressão dos cartões" pure-CSS bar chart from
 * Dashboard.dc.html — heights proportional to the max value, gold bar for
 * the active month. Design firewall: props in, markup out.
 */
import type { ReactElement } from "react";

function cx(...parts: Array<string | false | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

/** Pure CSS bar chart: value on top, bar, uppercase month label below. */
export function PressureBars({
  bars,
}: {
  bars: Array<{ label: string; value: number; display: string; active?: boolean }>;
}): ReactElement {
  const max = Math.max(0, ...bars.map((bar) => bar.value));
  return (
    <div className="ff-bars">
      {bars.map((bar) => (
        <div
          key={bar.label}
          className={cx("ff-bar", bar.active && "ff-bar--active")}
        >
          <span className="ff-bar__value ff-num">{bar.display}</span>
          <span className="ff-bar__track">
            <span
              className="ff-bar__fill"
              style={{ height: `${max > 0 ? (bar.value / max) * 100 : 0}%` }}
            />
          </span>
          <span className="ff-bar__label">{bar.label}</span>
        </div>
      ))}
    </div>
  );
}
