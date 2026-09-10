import { describe, expect, it } from "vitest";
import { displayDate, inputDate, displayMonth, inputMonth } from "../src/dates";
import { dateSchema } from "@family-finance/mobile-contracts";
describe("Brazilian date presentation", () => {
  it("keeps day and month distinct across display and API boundaries", () => {
    expect(displayDate("2026-09-05")).toBe("05/09/2026");
    expect(inputDate("05/09/2026")).toBe("2026-09-05");
  });
  it("preserves partial input so dates can be edited", () => {
    expect(inputDate("05/09/")).toBe("05/09/");
    expect(displayDate(inputDate("05/09/"))).toBe("05/09/");
  });
  it("does not normalize impossible dates into another day", () => {
    expect(dateSchema.safeParse(inputDate("31/02/2026")).success).toBe(false);
    expect(dateSchema.safeParse(inputDate("29/02/2024")).success).toBe(true);
  });
  it("uses the same convention for month-only fields", () => {
    expect(displayMonth("2026-09")).toBe("09/2026");
    expect(inputMonth("09/2026")).toBe("2026-09");
  });
});
