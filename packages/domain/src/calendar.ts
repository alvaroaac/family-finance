/** Calendar semantics for the single Casa household. */
export const HOUSEHOLD_TIME_ZONE = "America/Sao_Paulo";

const householdDateFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: HOUSEHOLD_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

function formattedPart(
  parts: Intl.DateTimeFormatPart[],
  type: "year" | "month" | "day",
): string {
  const value = parts.find((part) => part.type === type)?.value;
  if (value === undefined) {
    throw new Error(`Could not resolve ${type} in ${HOUSEHOLD_TIME_ZONE}`);
  }
  return value;
}

/** Current Casa calendar date as `YYYY-MM-DD`, independent of process timezone. */
export function currentHouseholdDate(now: Date = new Date()): string {
  const parts = householdDateFormatter.formatToParts(now);
  const year = formattedPart(parts, "year");
  const month = formattedPart(parts, "month");
  const day = formattedPart(parts, "day");
  return `${year}-${month}-${day}`;
}

/** Current Casa calendar month as `YYYY-MM`, independent of process timezone. */
export function currentHouseholdMonth(now: Date = new Date()): string {
  return currentHouseholdDate(now).slice(0, 7);
}
