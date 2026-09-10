/** Display-only conversions: API dates remain ISO, without timezone shifts. */
export function displayDate(value: string): string {
  return value.replace(/^(\d{4})-(\d{2})-(\d{2})$/, "$3/$2/$1");
}
export function inputDate(value: string): string {
  return value.replace(/^(\d{2})\/(\d{2})\/(\d{4})$/, "$3-$2-$1");
}
export function displayMonth(value: string): string {
  return value.replace(/^(\d{4})-(\d{2})$/, "$2/$1");
}
export function inputMonth(value: string): string {
  return value.replace(/^(\d{2})\/(\d{4})$/, "$2-$1");
}
