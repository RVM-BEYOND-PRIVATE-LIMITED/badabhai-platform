/**
 * FACTS BEFORE PAYING (#2747, ADR-0064 §3.2) — the six facts a company may see before it spends
 * a credit, and how they read.
 *
 * The server decides whether the part is on: while `APPLICANT_FACTS_ROLLOUT` is on for the company
 * every applicant/search row carries all six keys (a `null` means "not given"); while it is off it
 * carries none. Presence of the keys is therefore the ONLY switch this client reads. Nothing here
 * filters, sorts or infers — it formats what the server sent.
 *
 * `expectedSalary` is printed exactly as sent (the server builds it with the résumé's own
 * formatters). It is never rebuilt from numbers here.
 */

export const NOT_GIVEN = "not given";

/** The six keys, in the order the card prints them. */
export const PRE_PAY_FACT_KEYS = [
  "firstName",
  "tradeLine",
  "expectedSalary",
  "machines",
  "area",
  "lastActiveOn",
] as const;

export type PrePayFactKey = (typeof PRE_PAY_FACT_KEYS)[number];

/** #2747 — the two labels a card prints for where the applicant came from. */
export const SOURCE_LABEL = {
  rvm_student: "RVM student",
  badabhai_worker: "BadaBhai worker",
} as const;

export interface PrePayFactRow {
  firstName?: string | null;
  tradeLine?: string | null;
  expectedSalary?: string | null;
  machines?: string[] | null;
  area?: string | null;
  lastActiveOn?: string | null;
}

/** The labels the card prints beside each fact. */
export const PRE_PAY_FACT_LABEL: Record<PrePayFactKey, string> = {
  firstName: "Name",
  tradeLine: "Trade",
  expectedSalary: "Expected salary",
  machines: "Machines",
  area: "Area",
  lastActiveOn: "Last active",
};

/**
 * Is the facts part ON for this row? True when the server sent the keys at all — even when every
 * value is `null` (a worker whose consent does not cover them still appears, with six "not given"s).
 * An old server (or the switch off) sends none of the keys, and the card keeps today's shape.
 */
export function hasPrePayFacts(row: object): boolean {
  return PRE_PAY_FACT_KEYS.some((key) => key in row);
}

/** One fact as the card prints it: a missing value is "not given", never a blank. */
export function factText(value: string | null | undefined): string {
  if (value === null || value === undefined) return NOT_GIVEN;
  if (value.trim() === "") return NOT_GIVEN;
  return value;
}

/** The salary is printed EXACTLY as sent — never rebuilt, never trimmed into a different value. */
export function salaryText(value: string | null | undefined): string {
  return value === null || value === undefined ? NOT_GIVEN : value;
}

/** Machines as a readable list; none recorded reads "not given" (never an empty line). */
export function machinesText(value: ReadonlyArray<string> | null | undefined): string {
  if (value === null || value === undefined || value.length === 0) return NOT_GIVEN;
  return value.join(", ");
}

/** The six facts as label/value pairs, in the card's order. */
export function prePayFactLines(row: PrePayFactRow): Array<{ key: PrePayFactKey; label: string; value: string }> {
  return [
    { key: "firstName", label: PRE_PAY_FACT_LABEL.firstName, value: factText(row.firstName) },
    { key: "tradeLine", label: PRE_PAY_FACT_LABEL.tradeLine, value: factText(row.tradeLine) },
    {
      key: "expectedSalary",
      label: PRE_PAY_FACT_LABEL.expectedSalary,
      value: salaryText(row.expectedSalary),
    },
    { key: "machines", label: PRE_PAY_FACT_LABEL.machines, value: machinesText(row.machines) },
    { key: "area", label: PRE_PAY_FACT_LABEL.area, value: factText(row.area) },
    {
      key: "lastActiveOn",
      label: PRE_PAY_FACT_LABEL.lastActiveOn,
      value: factText(row.lastActiveOn),
    },
  ];
}
