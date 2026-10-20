import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(
  join(import.meta.dirname, "..", "components", "ui", "ui.css"),
  "utf8",
);

/** The declarations of the first rule whose selector is exactly `selector`. */
function rule(source: string, selector: string): string {
  const start = source.indexOf(`${selector} {`);
  expect(start, `rule ${selector}`).toBeGreaterThanOrEqual(0);
  return source.slice(start, source.indexOf("}", start));
}

const MOBILE_QUERY = "@media (max-width: 720px) {";
/** Everything from the first 720px media query that declares `.ff-bottombar`. */
const mobile = css.slice(
  css.indexOf(MOBILE_QUERY, css.indexOf(".ff-bottombar")),
);

describe("safe areas for the installed app", () => {
  it("keeps the bottom bar above the home indicator", () => {
    expect(rule(css, ".ff-bottomnav")).toContain("env(safe-area-inset-bottom)");
  });

  it("pads the top of the mobile page below the status bar", () => {
    expect(rule(mobile, ".ff-main")).toContain("env(safe-area-inset-top)");
  });

  it("leaves the desktop layout alone", () => {
    expect(rule(css, ".ff-main")).not.toContain("env(");
    expect(rule(css, ".ff-sidebar")).not.toContain("env(");
  });
});
