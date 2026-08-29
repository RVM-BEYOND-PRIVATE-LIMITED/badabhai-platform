import type { ResumeEmployment, ResumeRoleStint } from "./resume-renderer.service";

/**
 * ZONE 4 — WORK HISTORY. The `worker_employment` rows as the sheet prints them. PURE: no I/O,
 * no DI, and no clock except the `asOf` the caller passes.
 *
 * THE READER SHIPS BEFORE THE WRITER, DELIBERATELY. Nothing writes `worker_employment` yet —
 * the capture surface is a post-interview form and how work history is captured is still an
 * open owner ruling (a pack cannot do it: MAX_ENGINE_ASKS is 24 and a multi-employer loop
 * needs ~6 keys each). That blocks the WRITER and nothing else. Building the render block now
 * against seeded rows means the capture surface, whenever it lands, flips workers over ONE AT A
 * TIME with no cutover and no backfill: {@link buildEmploymentBlock} returns an empty block for
 * a worker with no rows, and `resume-render-input.ts` then falls back to the tag-derived
 * role + duration line every existing profile already renders.
 *
 * THAT FALLBACK IS INTERIM, NOT DONE. See docs/resume-engine-r1-journal.md. It exists so Zone 4
 * is populated today; it is not the designed shape and must not be mistaken for it.
 *
 * WHAT THE GUIDELINE FIXES HERE, clause by clause, because every one of these is a rule about
 * honesty rather than about layout:
 *   §11 #3  — an unstated duration prints the literal "Duration not stated". Never estimated,
 *             never rounded, never silently omitted.
 *   §11 #4  — contract work with no company name arrives already resolved to the site or the
 *             literal "Contract work"; the column is NOT NULL, so this file never invents one.
 *   §11 #5  — gaps render as they are. No explanation, no filler, no "career break" label.
 *   §11 #6  — months for each employment, even at nine employers in four years. Never
 *             editorialise: job-hopping is not scored anywhere in the system and must not be
 *             scored typographically either.
 *   §11 #7  — four most recent in full; the remainder collapse to ONE counted line. Never a
 *             second page, and never a silent drop.
 *   §11 #14 — a promotion is ONE employer block with two dated function lines.
 *   §11 #15 — overseas experience renders its country (carried in `employer_state`; see
 *             {@link locationSuffix}).
 */

/** One employment as the repository reads it back — employer name already DECRYPTED. */
export interface WorkerEmploymentRecord {
  /** Already resolved by capture: a company, a site, or the literal "Contract work" (§11 #4). */
  readonly employer: string;
  readonly employerCity: string | null;
  /**
   * The state, OR THE COUNTRY for overseas work (§11 #15).
   *
   * There is no `country` column and adding one is a migration this branch is not making. Gulf
   * experience is a genuine differentiator in this market, so capture writes "UAE" / "Saudi
   * Arabia" here and the suffix prints it verbatim. Recorded as interim in the journal.
   */
  readonly employerState: string | null;
  /** 'YYYY-MM'. */
  readonly startYm: string | null;
  /** 'YYYY-MM', or null meaning CURRENT — a real state, not missing data. */
  readonly endYm: string | null;
  /** False when the worker could not give dates at all (§11 #3). */
  readonly durationStated: boolean;
  readonly roles: readonly WorkerEmploymentRoleRecord[];
}

export interface WorkerEmploymentRoleRecord {
  /** The row id, so a polisher can write its result back to the stint it read. */
  readonly id?: string;
  readonly roleLabel: string;
  readonly startYm: string | null;
  readonly endYm: string | null;
  /** The worker's own words. The system of record, and the fallback. */
  readonly workDone: string | null;
  /**
   * The same description rephrased into professional English by the model (#1350).
   *
   * BOTH ARE CARRIED, and that is deliberate. `workDone` stays what the worker actually
   * wrote — it is what a dispute is settled by and what prints whenever this is null, which
   * is the ordinary state for every row written before #1350 and every row where the model
   * was unavailable, declined, or produced something the far side rejected.
   */
  readonly workDonePolished?: string | null;
  /**
   * The worker looked at the rewrite and chose their own words (#1354).
   *
   * KEPT BESIDE THE POLISH RATHER THAN CLEARING IT, so the decision survives a re-render and
   * the worker can change their mind without paying for another model call.
   */
  readonly workDonePolishDeclined?: boolean;
}

/**
 * Employments rendered in full before the tail collapses. §11 #7, quoted not chosen.
 *
 * Zone 4 is 62–86% of the page and the guideline's zone map says "up to four employers,
 * reverse chronological". A fifth block is how this sheet reaches page two, which is fatal on a
 * phone (§13 decision 5).
 */
export const EMPLOYMENT_BLOCK_BUDGET = 4;

/**
 * Distinct work-done descriptions joined onto the employment's single work line.
 *
 * TWO, NOT ONE, AND NOT ALL. The template gives an employment ONE work line — the zone map
 * allocates "machine run" a line, not a paragraph — but a promotion usually carries the same
 * description twice, and taking only the most recent would silently drop a genuinely different
 * second description. Distinct-then-capped keeps everything in the overwhelming case and makes
 * the loss explicit and tested in the rare one.
 */
const WORK_LINE_MAX_PARTS = 2;

export interface EmploymentBlock {
  readonly employments: ResumeEmployment[];
  /** "5 earlier employers · 61 months total · 2011-2016", or null. */
  readonly employmentsMore: string | null;
}

/**
 * Build Zone 4. Input is in DISPLAY ORDER (most recent first) — `sort_order`, never dates.
 *
 * ORDER IS NOT RE-DERIVED HERE and that is the schema's decision, not this file's: two jobs can
 * start in the same month and a worker whose dates are unstated still described them in an
 * order, so sorting by date would reshuffle rows between renders and make every regenerated PDF
 * a false diff.
 *
 * `asOf` IS OPTIONAL AND ITS ABSENCE IS HONEST, not a default. A current job's tenure can only
 * be computed against a clock; with no clock the span still prints "Jan 2023 - Present" and the
 * months tail is simply absent, because a tenure figure is a number and §8 forbids printing one
 * nobody can source.
 */
export function buildEmploymentBlock(
  records: readonly WorkerEmploymentRecord[],
  opts: { readonly asOf?: Date | null } = {},
): EmploymentBlock {
  const kept = records.slice(0, EMPLOYMENT_BLOCK_BUDGET);
  const dropped = records.slice(EMPLOYMENT_BLOCK_BUDGET);
  return {
    employments: kept.map((r) => toEmployment(r, opts.asOf ?? null)),
    employmentsMore: overflowLine(dropped, opts.asOf ?? null),
  };
}

function toEmployment(record: WorkerEmploymentRecord, asOf: Date | null): ResumeEmployment {
  const stints = roleStints(record, asOf);
  // ── A LONE UNDATED ROLE MOVES ONTO THE EMPLOYER LINE ──────────────────────────────
  //
  // MEASURED, NOT TIDIED. With one role line per employment, a worker with four employers, a
  // fully-answered pack and a full credentials block rendered TWO PAGES — the content fit and
  // the FOOTER did not, by a few millimetres. Content shapes 5, 6 and 9 all failed this way, and
  // "one page" is a product contract (§13 decision 5: "Two pages is fatal on a phone").
  //
  // It is also what the zone map actually asks for: Zone 4 is "employer · role and function ·
  // city · months · machine run", i.e. all of that on ONE line plus the machine run. A role
  // carrying no dates of its own added a line and one word.
  //
  // §11 #14 IS UNTOUCHED, and that is the whole reason this is conditional. A promotion is two
  // or more stints, each with its own range; those keep their own dated lines, because
  // progression is a strong signal and flattening it is what makes a tenure read as job-hopping.
  // The condition is deliberately "exactly one stint AND it renders no dates" — a single stint
  // whose dates differ from the employment's is a real, separate fact and keeps its line.
  const inlineOnly = stints.length === 1 && stints[0]!.when === "";
  return {
    employer: record.employer,
    location_suffix: locationSuffix(record),
    // The separator is part of the value, exactly like `location_suffix`, so an absent role
    // cannot leave a stray dash on the page.
    role_inline: inlineOnly ? ` — ${stints[0]!.role}` : "",
    when: spanText(record.startYm, record.endYm, record.durationStated, asOf),
    work: workLine(record.roles),
    // THE SAME LINE FROM THE WORKER'S OWN WORDS, so a client can show what the printed text
    // was rewritten FROM (#1354). Composed through the identical joiner rather than
    // concatenated separately: a comparison between two differently-built strings would show
    // differences the rewrite did not cause.
    work_own_words: workLine(record.roles, { ownWordsOnly: true }),
    roles: inlineOnly ? [] : stints,
  };
}

/**
 * " · Gurugram, Haryana" / " · Dubai, UAE" (§11 #15), or "" when neither is known.
 *
 * THE SEPARATOR IS PART OF THE VALUE, so an absent city cannot leave a stray dot on the page.
 * The template renders this immediately after the employer name with no separator of its own,
 * which is the only shape that makes a missing value cost nothing.
 */
function locationSuffix(record: WorkerEmploymentRecord): string {
  const where = [record.employerCity, record.employerState]
    .map((v) => v?.trim())
    .filter((v): v is string => Boolean(v))
    .join(", ");
  return where ? ` · ${where}` : "";
}

/**
 * The role stints (§11 #14).
 *
 * A SINGLE STINT WHOSE SPAN EQUALS THE EMPLOYMENT'S PRINTS NO DATES. One employer, one role,
 * one date range — repeating that range under the block would read as a second, identical fact
 * and cost a line in a zone that has 24% of the page. Two stints always carry their own dates,
 * because that is the whole signal a promotion produces.
 */
function roleStints(record: WorkerEmploymentRecord, asOf: Date | null): ResumeRoleStint[] {
  const employmentSpan = spanText(record.startYm, record.endYm, record.durationStated, asOf);
  const single = record.roles.length === 1;
  return record.roles.map((role) => {
    const own = role.startYm
      ? spanText(role.startYm, role.endYm, true, asOf)
      : // A stint with no dates of its own inherits nothing: an inherited range would assert the
        // worker held THAT title for the whole tenure, which is exactly what a promotion did not
        // do. It prints the title alone.
        "";
    return {
      role: role.roleLabel,
      when: single && own === employmentSpan ? "" : own,
    };
  });
}

/**
 * "Jan 2023 - Present · 3 yrs 8 mo", "Mar 2019 - Nov 2021 · 2 yrs 9 mo", or
 * "Duration not stated" (§11 #3).
 */
function spanText(
  startYm: string | null,
  endYm: string | null,
  durationStated: boolean,
  asOf: Date | null,
): string {
  if (!durationStated || !startYm) return DURATION_NOT_STATED;
  const start = formatYm(startYm);
  if (!start) return DURATION_NOT_STATED;
  const end = endYm ? formatYm(endYm) : "Present";
  if (!end) return DURATION_NOT_STATED;
  const months = monthsBetween(startYm, endYm ?? ymOf(asOf));
  const tenure = months === null ? null : tenureText(months);
  return tenure ? `${start} – ${end} · ${tenure}` : `${start} – ${end}`;
}

/** §11 #3, verbatim. Exported so the fabrication gate can allow it by identity, not by pattern. */
export const DURATION_NOT_STATED = "Duration not stated";

/**
 * "3 yrs 8 mo" / "11 mo" / "1 yr".
 *
 * §11 #6 REQUIRES MONTHS FOR EACH, including at nine employers in four years, and the shape is
 * the same at every tenure length so nothing about the sheet's typography scores job-hopping.
 */
function tenureText(months: number): string | null {
  if (months <= 0) return null;
  const years = Math.floor(months / 12);
  const rest = months % 12;
  const parts = [
    years > 0 ? `${years} ${years === 1 ? "yr" : "yrs"}` : null,
    rest > 0 ? `${rest} mo` : null,
  ].filter((p): p is string => Boolean(p));
  return parts.join(" ");
}

/**
 * The overflow tail (§11 #7): the count, and the total months.
 *
 * THE MONTHS SEGMENT IS ALL-OR-NOTHING, and that is the honesty rule doing real work. A "total"
 * that quietly excludes the two dropped employments whose dates the worker could not give is a
 * false number on a printed page — worse than no number, because it reads as complete. When any
 * dropped row has no stated duration the count still prints (nothing is silently dropped) and
 * the total does not. The year span rides the same condition for the same reason.
 */
function overflowLine(
  dropped: readonly WorkerEmploymentRecord[],
  asOf: Date | null,
): string | null {
  if (dropped.length === 0) return null;
  const count = `${dropped.length} earlier ${dropped.length === 1 ? "employer" : "employers"}`;

  const spans = dropped.map((r) =>
    r.durationStated && r.startYm ? monthsBetween(r.startYm, r.endYm ?? ymOf(asOf)) : null,
  );
  if (spans.some((m) => m === null)) return count;

  const total = spans.reduce((sum: number, m) => sum + (m ?? 0), 0);
  const years = dropped
    .flatMap((r) => [r.startYm, r.endYm ?? ymOf(asOf)])
    .filter((ym): ym is string => Boolean(ym))
    .map((ym) => Number(ym.slice(0, 4)))
    .filter((y) => Number.isFinite(y));
  const span = years.length > 0 ? `${Math.min(...years)}–${Math.max(...years)}` : null;
  return [count, `${total} months total`, span].filter((p): p is string => Boolean(p)).join(" · ");
}

/** The employment's one work line — see {@link WORK_LINE_MAX_PARTS}. */
function workLine(
  roles: readonly WorkerEmploymentRoleRecord[],
  opts: { readonly ownWordsOnly?: boolean } = {},
): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const role of roles) {
    // THE POLISHED LINE WHEN THERE IS ONE AND THE WORKER KEPT IT, their own words otherwise
    // (#1350, #1354). The fallback is not a degradation to apologise for: it is what this sheet
    // printed before the owner ruling, what it must keep printing on every path where the model
    // did not run or was overruled by the far side's checks, and — since #1354 — what the
    // worker themselves can choose. A refusal outranks a rewrite; nobody else is in a position
    // to know whether a sentence about their work is true.
    const usePolished =
      !opts.ownWordsOnly && role.workDonePolished != null && role.workDonePolishDeclined !== true;
    const text = (usePolished ? role.workDonePolished : role.workDone)?.trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    parts.push(text);
    if (parts.length === WORK_LINE_MAX_PARTS) break;
  }
  return parts.join(" · ");
}

const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

/** 'YYYY-MM' -> "Mar 2019". Returns null for anything the column's CHECK would have rejected. */
function formatYm(ym: string): string | null {
  const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(ym);
  if (!m) return null;
  return `${MONTHS[Number(m[2]) - 1]} ${m[1]}`;
}

/** A Date as 'YYYY-MM' in UTC, or null. Only ever used to close an open-ended span. */
function ymOf(at: Date | null): string | null {
  if (!at || Number.isNaN(at.getTime())) return null;
  return `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * Whole months from `startYm` to `endYm`, INCLUSIVE of both.
 *
 * Inclusive because a worker who joined in January and left in January worked a month, and a
 * sheet that prints "0 mo" for it has called a real job nothing. Null when either bound is
 * missing or malformed, or when the range is inverted — the CHECK constraints make an inverted
 * range unstorable, so this is a belt on a brace rather than a live case.
 */
function monthsBetween(startYm: string | null, endYm: string | null): number | null {
  if (!startYm || !endYm) return null;
  const s = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(startYm);
  const e = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(endYm);
  if (!s || !e) return null;
  const months = (Number(e[1]) - Number(s[1])) * 12 + (Number(e[2]) - Number(s[2])) + 1;
  return months > 0 ? months : null;
}
