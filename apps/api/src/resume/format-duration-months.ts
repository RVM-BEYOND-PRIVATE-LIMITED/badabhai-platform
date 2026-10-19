/**
 * A job's duration in whole months, as résumé print text (#2358).
 *
 * OWNER RULING 2026-10-19: the Work History duration reads "{x} years {y} months".
 * Only years known → "{x} years". Under a year → "{y} months". Nothing resolvable → ""
 * (no raw Hinglish on the résumé). Singular "1 year" / "1 month", plural otherwise.
 *
 * PURE. A number in, a string out. No I/O, no prompt, no transcript read. The worker's
 * verbatim `duration_text` stays stored and stays what the parse gates check — this formats
 * the resolved month count at the render layer only.
 *
 * Whole months only: a fractional input is rounded to the nearest month first, so a
 * float can never print as "3.5 years".
 */
export function formatDurationMonths(months: number | null | undefined): string {
  if (typeof months !== "number" || !Number.isFinite(months)) return "";
  const total = Math.round(months);
  if (total <= 0) return "";
  const years = Math.floor(total / 12);
  const rest = total % 12;
  const yearPart = years > 0 ? `${years} ${years === 1 ? "year" : "years"}` : null;
  const monthPart = rest > 0 ? `${rest} ${rest === 1 ? "month" : "months"}` : null;
  if (yearPart && monthPart) return `${yearPart} ${monthPart}`;
  return yearPart ?? monthPart ?? "";
}
