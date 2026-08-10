import { describe, expect, it } from "vitest";

import {
  HOUSEHOLD_TIME_ZONE,
  currentHouseholdDate,
  currentHouseholdMonth,
} from "./calendar.js";

describe("Casa calendar", () => {
  it("uses the configured Sao Paulo timezone", () => {
    expect(HOUSEHOLD_TIME_ZONE).toBe("America/Sao_Paulo");
  });

  it("does not roll the date or month forward at late-evening UTC boundaries", () => {
    const lateJulyEvening = new Date("2026-08-01T01:30:00Z");

    expect(currentHouseholdDate(lateJulyEvening)).toBe("2026-07-31");
    expect(currentHouseholdMonth(lateJulyEvening)).toBe("2026-07");
  });

  it("rolls over after local midnight", () => {
    const augustAfterMidnight = new Date("2026-08-01T03:30:00Z");

    expect(currentHouseholdDate(augustAfterMidnight)).toBe("2026-08-01");
    expect(currentHouseholdMonth(augustAfterMidnight)).toBe("2026-08");
  });
});
