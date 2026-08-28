import type { ResumeEmployment, ResumeFactRow, ResumeListRow } from "./resume-renderer.service";
import { TRADE_RESUME_MAPS } from "./trade-resume-map";

/**
 * THE DEGRADATION STAGE — what comes off the sheet when the content will not fit one page.
 *
 * WHY IT EXISTS AS ITS OWN THING, AHEAD OF THE FEATURES THAT NEED IT. Measured on the R1
 * matrix, the worst content shape had 0.00 mm of headroom: it fit at exactly 297 mm and spilled
 * at 296.75. Two features are queued that both add rows INSIDE the sheet — work-history capture
 * (Zone 4) and Phase C qualification extraction (Zone 5) — and each of them takes that shape to
 * two pages on its FIRST row. Leaving the ladder to whichever lands first would hand the §5.1
 * drop order to an unrelated feature, designed under that feature's schedule pressure, and the
 * loser of the race would inherit a contract it did not write. So it is built here, first, and
 * both of them arrive into a page that already knows how to shed.
 *
 * WHY A CONTENT BUDGET RATHER THAN "RENDER AND SEE". The mapper is pure and WeasyPrint lives in
 * another process behind a kill-switch, so "does this fit" is not a question this layer can ask.
 * It is answered instead by counting rendered LINES against a budget, with the line cost
 * calibrated from real renders (see the constants below) and the calibration itself verified by
 * the out-of-process harness that measures all 28 sheets in millimetres. The model decides; the
 * harness is what proves the model is still telling the truth.
 *
 * DETERMINISTIC. The stage is a pure function of the input: the same worker always yields the
 * same drop set, so two renders of one profile are byte-identical and a diff means something
 * actually changed.
 *
 * MINIMAL. The ladder stops at the FIRST stage that fits. A sheet that needs one row dropped
 * loses one row, never the whole tail of the order.
 */

/**
 * One rendered text line, in millimetres. MEASURED, not derived from the font metrics.
 *
 * WeasyPrint's own box tree on the shipped template: every `.emp-when`, `.emp-work`, `.lab`,
 * `.ticks` and `.chips` line lays out at 4.89 mm, and each extra wrapped line in a `.row` adds
 * exactly 4.89 mm (10.58 → 15.47 → 20.36 across a widening row). It is the atomic unit of this
 * page, which is why the budget is denominated in it rather than in rows: rows are not all the
 * same height, and a chips row that wraps to three lines costs three times a fact row.
 */
export const LINE_MM = 4.89;

/**
 * The headroom every sheet must keep, in millimetres. ONE SPARE LINE, near enough.
 *
 * MEASURED RATHER THAN CHOSEN. Rendering the matrix across WeasyPrint 63.1, 66.0 and 69.0 gives
 * byte-identical headroom on all 28 sheets — renderer version is not the risk. The variance is
 * FONT FALLBACK: with `fonts-noto-core` absent the stack falls to DejaVu Sans and the numbers
 * move by up to 3.64 mm (shape 5 loses 3.64; most sheets gain ~1.25 — it goes both ways). 5 mm
 * sits above the largest observed movement, and lands within a rounding error of one line, which
 * is the smallest unit this page can actually shed.
 *
 * A zero-margin pass is not a pass. It says the sheet fits THIS renderer with THESE fonts, and
 * breaks silently across all 28 sheets on a patch release or a changed base image.
 */
export const HEADROOM_FLOOR_MM = 5;

/**
 * Characters per rendered line at the 10.5 pt body size across the 186 mm content width.
 *
 * MEASURED by widening one row and reading where it broke: 90 chars stayed on one line, 107 went
 * to two, 182 was still two, 223 went to three, 307 to four — a threshold of ~91. Pinned at 88,
 * DELIBERATELY LOW: over-estimating a row's height makes the ladder drop slightly early, which
 * costs a row. Under-estimating puts a worker's sheet on two pages.
 */
export const CHARS_PER_LINE = 88;

/**
 * The line budget for one A4 sheet. FITTED against real renders, not reasoned from the page size.
 *
 * The model predicts `headroom = C - LINE_MM x lines`. Solving C per shape from the 28 measured
 * sheets clusters it at 209-216 mm once the masthead and section terms are included (it ranged
 * 156-232 before them, which is what said those terms were missing rather than negligible).
 * Taking the WORST observed C = 209.0 and requiring the floor:
 *
 *     budget = (209.0 - 5) / 4.89 = 41.7  ->  41
 *
 * Rounded DOWN, and the direction matters: the residual spread across shapes is ~7 mm, so a
 * budget fitted to the average would put the tightest shapes under the floor. This costs a row
 * on a couple of sheets and buys the guarantee on all of them.
 */
export const SHEET_LINE_BUDGET = 41;

/** Rendered lines one label+values row occupies, including its wrap. */
export function rowLines(label: string, text: string): number {
  const chars = label.length + 2 + text.length;
  return Math.max(1, Math.ceil(chars / CHARS_PER_LINE));
}

function listRowLines(rows: readonly ResumeListRow[] | undefined): number {
  return (rows ?? []).reduce((n, r) => n + rowLines(r.label, r.values.join(" · ")), 0);
}

function factRowLines(rows: readonly ResumeFactRow[] | undefined): number {
  return (rows ?? []).reduce((n, r) => n + rowLines(r.label, r.value), 0);
}

/**
 * One employer block: the employer line, the dates line, the work line, and any dated role
 * stints. A role that renders inline on the employer line costs nothing extra — which is exactly
 * the §11 #9 fix R1 measured as load-bearing, and the reason it is modelled rather than assumed.
 */
function employmentLines(employments: readonly ResumeEmployment[] | undefined): number {
  return (employments ?? []).reduce((n, e) => {
    const head = rowLines(e.employer, `${e.location_suffix}${e.role_inline ?? ""}`);
    const when = e.when ? 1 : 0;
    const work = e.work ? rowLines("", e.work) : 0;
    const roles = (e.roles ?? []).reduce((m, r) => m + rowLines(r.role, r.when), 0);
    return n + head + when + work + roles;
  }, 0);
}

/**
 * The masthead's name line, in body-line equivalents.
 *
 * NOT CHROME, EVEN THOUGH IT LOOKS LIKE IT. A first pass counted only the four content sections
 * and predicted shape 9 — the very long name — as roomier than shape 5, when it measured 0.00 mm
 * against shape 5's 9.87. The whole difference is up here: a name past the one-line limit
 * auto-fits to 18 pt (§11 #9) and then WRAPS, and an 18 pt line is 8.53 mm against the body's
 * 4.89. Leaving it out makes the model confidently wrong on precisely the shape that needs it.
 */
const NAME_LINE_MM = 8.53;
const NAME_ONE_LINE_MAX = 27;
const NAME_CHARS_PER_LINE_FIT = 46;

export function nameLines(displayName: string | null | undefined): number {
  const n = displayName?.trim().length ?? 0;
  if (n === 0) return 0;
  if (n <= NAME_ONE_LINE_MAX) return NAME_LINE_MM / LINE_MM;
  return (Math.ceil(n / NAME_CHARS_PER_LINE_FIT) * NAME_LINE_MM) / LINE_MM;
}

/**
 * Each rendered section costs its own heading, rule and margins before a single row lands.
 *
 * ~9.1 mm from the stylesheet: a 9 pt letter-spaced heading, 0.9 mm padding, a hairline rule,
 * 1.4 mm below and 2.6 mm above. A sheet whose trade has no capability map (shape 13) or whose
 * profile is name-only (shape 14) pays for fewer of them, which is exactly why those two looked
 * like outliers until this term existed.
 */
const SECTION_CHROME_LINES = 9.1 / LINE_MM;

/** The shape the ladder operates on — every variable region of the sheet, and nothing else. */
export interface DegradableSheet {
  displayName?: string | null;
  nameDevanagari?: string | null;
  capSectionTitle?: string | null;
  capChipRows?: ResumeListRow[];
  capTickRows?: ResumeListRow[];
  capFactRows?: ResumeFactRow[];
  availFactRows?: ResumeFactRow[];
  qualFactRows?: ResumeFactRow[];
  qualTickRows?: ResumeListRow[];
  employments?: ResumeEmployment[];
  employmentsMore?: string | null;
  experiences?: { role: string; duration: string; work: string }[];
}

/** Total rendered lines the page must find room for — masthead, section chrome and content. */
export function sheetContentLines(s: DegradableSheet): number {
  const sections =
    (s.capSectionTitle ? 1 : 0) +
    ((s.availFactRows ?? []).length > 0 ? 1 : 0) +
    ((s.employments ?? []).length > 0 || (s.experiences ?? []).length > 0 ? 1 : 0) +
    ((s.qualFactRows ?? []).length + (s.qualTickRows ?? []).length > 0 ? 1 : 0);
  return (
    nameLines(s.displayName) +
    (s.nameDevanagari ? 1 : 0) +
    sections * SECTION_CHROME_LINES +
    listRowLines(s.capChipRows) +
    listRowLines(s.capTickRows) +
    factRowLines(s.capFactRows) +
    factRowLines(s.availFactRows) +
    factRowLines(s.qualFactRows) +
    listRowLines(s.qualTickRows) +
    employmentLines(s.employments) +
    (s.employmentsMore ? 1 : 0) +
    (s.experiences ?? []).reduce(
      (n, e) => n + rowLines(e.role, e.duration) + rowLines("", e.work),
      0,
    )
  );
}

/**
 * WHAT MAY NEVER BE DROPPED, as a list rather than as an absence.
 *
 * Stated positively and asserted in the tests, because "we just never wrote a step for it" is
 * not a guarantee — it is the absence of one, and the next person adding a stage under page
 * pressure has nothing to read. Each is either §5.1 rank 1, one of the four things that actually
 * REJECT a candidate (§6.2), or the acquisition loop Part 12.2 measures the whole free-résumé
 * investment by.
 */
export const NEVER_DROPPED = [
  "verdict_line", // §5.1 rank 1 — the sheet's entire triage value
  "display_name", // a résumé without a name is not a résumé
  "availability", // §5.1 rank 6 — one of the four real rejection filters
  "expected_salary", // §5.1 rank 6 — the other one
  "trust_badge", // Part 10.2: absence must read as neutral, never as doubt
  "qr_footer", // Part 12.2: the acquisition loop
] as const;

/**
 * THE LADDER. Index is the stage; stage 0 is "nothing dropped".
 *
 * ORDER IS REVERSE §5.1 DECISIVENESS, with the turner-pack additions slotted per the R1 §3
 * default: the optional volunteered fields go first, then production mode, then sector tag, then
 * materials beyond two — and only after all of that does anything the guideline ranks reach the
 * block. Flagged for RVM redline (NEEDS_PRAKASH Q2): it is trade truth, not layout preference.
 *
 * TWO STEPS ARE CURRENTLY UNREACHABLE AND THAT IS STATED RATHER THAN HIDDEN. `surface_finish_ra`,
 * `fit_class_held`, `bar_diameter_range_mm` and `production_mode` exist in neither
 * `qp_cnc_turning.json` nor `trade-resume-map.ts`, so steps 1 and 2 match nothing today. They are
 * built in their correct positions anyway: when those fields land they must drop FIRST, and a
 * ladder that acquires them later would otherwise acquire them at the end.
 */
const OPTIONAL_VOLUNTEERED = ["surface_finish_ra", "fit_class_held", "bar_diameter_range_mm"];

/** The widest capability section any trade map can produce — the ladder must be able to empty it. */
const MAX_CAPABILITY_ROWS = TRADE_RESUME_MAPS.reduce((n, m) => Math.max(n, m.capability.length), 0);

interface LadderStep {
  readonly what: string;
  readonly apply: (s: DegradableSheet) => void;
}

function dropByKey(s: DegradableSheet, keys: readonly string[]): void {
  const gone = (r: { key?: string }) => !(r.key !== undefined && keys.includes(r.key));
  s.capChipRows = (s.capChipRows ?? []).filter(gone);
  s.capTickRows = (s.capTickRows ?? []).filter(gone);
  s.capFactRows = (s.capFactRows ?? []).filter(gone);
}

/** Capability rows by DESCENDING §5.1 rank — the least decisive fact goes first. */
function dropHighestRank(s: DegradableSheet): void {
  const all = [...(s.capChipRows ?? []), ...(s.capTickRows ?? []), ...(s.capFactRows ?? [])] as {
    key?: string;
    rank?: number;
  }[];
  const ranked = all.filter((r) => typeof r.rank === "number");
  if (ranked.length === 0) return;
  const worst = ranked.reduce((a, b) => ((b.rank ?? 0) > (a.rank ?? 0) ? b : a));
  if (worst.key !== undefined) dropByKey(s, [worst.key]);
}

export const LADDER: readonly LadderStep[] = [
  { what: "optional volunteered fields", apply: (s) => dropByKey(s, OPTIONAL_VOLUNTEERED) },
  { what: "production mode", apply: (s) => dropByKey(s, ["production_mode"]) },
  { what: "sector worked", apply: (s) => dropByKey(s, ["sector_worked"]) },
  {
    what: "materials chips beyond two",
    apply: (s) => {
      s.capChipRows = (s.capChipRows ?? []).map((r) =>
        (r as { key?: string }).key === "material_worked" && r.values.length > 2
          ? { ...r, values: r.values.slice(0, 2) }
          : r,
      );
    },
  },
  // Zone 5, reverse §5.1: languages (10), documents (9), certificates then education (8).
  { what: "languages", apply: (s) => dropQual(s, "Languages spoken") },
  { what: "documents ready", apply: (s) => dropQual(s, "Documents ready") },
  { what: "certificates", apply: (s) => dropQual(s, "Certificates") },
  { what: "education", apply: (s) => dropQual(s, "Education") },
  // Zone 4, §5.1 rank 7. Collapse to the count line rather than deleting silently — §11 #7.
  { what: "employers beyond three", apply: (s) => collapseEmployments(s, 3) },
  { what: "employers beyond two", apply: (s) => collapseEmployments(s, 2) },
  { what: "employers beyond one", apply: (s) => collapseEmployments(s, 1) },
  // Capability, by descending rank. One step per row so the ladder sheds a single row at a time
  // and can still shed ALL of them.
  //
  // DERIVED FROM THE MAPS, NOT TYPED IN. A hard 12 was written here first and the turner pack has
  // 14 rows, so a maxed-out worker would have run out of ladder two rows before running out of
  // sheet — the ladder would have returned a still-overflowing page and reported a stage as if it
  // had succeeded. Counting the widest map means adding a row to a pack cannot reintroduce that.
  ...Array.from({ length: MAX_CAPABILITY_ROWS }, (_, i) => ({
    what: `capability row ${i + 1} by reverse §5.1 rank`,
    apply: dropHighestRank,
  })),
];

function dropQual(s: DegradableSheet, label: string): void {
  s.qualFactRows = (s.qualFactRows ?? []).filter((r) => r.label !== label);
  s.qualTickRows = (s.qualTickRows ?? []).filter((r) => r.label !== label);
}

/**
 * Keep the first `keep` employers and fold the rest into the count line.
 *
 * NEVER A SILENT DELETION. §11 #7 is explicit that dropped employers are COUNTED, because a man
 * with nine jobs in four years reads as unstable if his sheet shows four and says nothing, and
 * reads as honest if it says "5 earlier employers". The count line is one line and is what makes
 * this step worth taking at all.
 */
function collapseEmployments(s: DegradableSheet, keep: number): void {
  const all = s.employments ?? [];
  if (all.length <= keep) return;
  const dropped = all.length - keep;
  s.employments = all.slice(0, keep);
  const existing = /^(\d+) earlier employers/.exec(s.employmentsMore ?? "");
  const total = dropped + (existing ? Number(existing[1]) : 0);
  s.employmentsMore = `${total} earlier employers`;
}

export interface DegradationResult<T> {
  readonly sheet: T;
  /** 0 = nothing dropped. Stamped on the artifact so a PDF reproduces exactly (§7.4). */
  readonly stage: number;
  /** What each applied stage removed, for the provenance stamp and for the tests. */
  readonly dropped: readonly string[];
}

/**
 * Walk the ladder until the content fits, and stop there.
 *
 * RUNS OUT OF LADDER RATHER THAN OUT OF CONTENT. If every step has been applied and the sheet is
 * still over budget, it returns the last stage rather than throwing: a worker with a pathological
 * profile gets a two-page résumé, which is a bad sheet, and an exception gets them NO sheet at
 * all. The harness is what catches this in CI; the runtime degrades.
 */
export function degradeToFit<T extends DegradableSheet>(input: T): DegradationResult<T> {
  const working: T = { ...input };
  const dropped: string[] = [];
  if (sheetContentLines(working) <= SHEET_LINE_BUDGET) {
    return { sheet: working, stage: 0, dropped };
  }
  for (let i = 0; i < LADDER.length; i += 1) {
    const before = sheetContentLines(working);
    LADDER[i]!.apply(working);
    const after = sheetContentLines(working);
    // Only a step that actually removed something counts as a stage — steps 1 and 2 match
    // nothing today, and a stage number that moved without the page changing would be a lie on
    // the provenance stamp.
    if (after < before) dropped.push(LADDER[i]!.what);
    if (after <= SHEET_LINE_BUDGET) {
      return { sheet: working, stage: dropped.length, dropped };
    }
  }
  return { sheet: working, stage: dropped.length, dropped };
}
