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
 *
 * ── THE 2026-09-03 OWNER RULING — CONTENT PRESERVATION NOW OUTRANKS PAGE COUNT ────────
 *
 * "Single page stays the TARGET. The degradation ladder still compresses as hard as it can — but
 * when a sheet STILL will not fit, it SPILLS ONTO PAGE 2 instead of shedding a ratified row."
 *
 * WHY IT WAS NEEDED, AND IT IS A MEASUREMENT RATHER THAN A PREFERENCE. The ratified corpus
 * (`BadaBhai_21_Role_Resumes.pdf`) contains sheets this module could not reproduce EITHER WAY.
 * The grinder's page prints ten capability rows ending in "Sector worked"; at
 * `CAPABILITY_ROW_BUDGET = 9` that row was shed before the ladder ever ran, and at 10 the sheet
 * measures 41.19 lines against a budget of 41 and the ladder shed it again — the only step that
 * cleared the overflow being the one that deletes the very row the budget raise restored. A
 * fully-answered turner reaches the same 41.19 and paid for it with "Languages spoken", which
 * every one of the twenty-one pages prints. `SHEET_LINE_BUDGET` is FITTED (see below) and
 * recorded as un-raiseable without a second page, so there was no third option.
 *
 * WHAT IT DOES NOT MEAN. Two pages are not acceptable in general. A sheet that could have fitted
 * by compressing MUST still be compressed to one, which is why the compressing steps still run,
 * still run in the ruled order, and still stop at the first stage that fits. What changed is the
 * END of the ladder: it now returns an OVERFLOWING sheet — flagged as such on the result, see
 * {@link DegradationResult.overflows} — instead of walking on into steps that delete rows a human
 * signed off.
 *
 * AND A COMPRESSION IS ONLY CHARGED WHEN IT BUYS THE PAGE. The corollary, and it is the ruling
 * applied to the ladder's own instrument: a step that shortens a sheet which spills anyway has
 * cost a worker real content — an employer's name, dates and work line — in exchange for nothing,
 * since page 2 exists either way. So `degradeToFit` discards a compression that fails to achieve
 * the fit and hands the sheet back as it arrived. See its own header for the measurement, which
 * puts the SAME step on both sides of that line within one shape.
 *
 * NOT VISUALLY CONFIRMED. This module models the page in LINES; only WeasyPrint measures
 * millimetres, and it is Docker-only on the development host (see `templates/README.md`). The
 * spill is believed correct because `bb_trade.v1.html` sets `@page { size: A4; margin: 12mm }`
 * and its footer is a NORMAL-FLOW element carrying no positioning, so a long sheet breaks and the
 * footer lands at the end of page 2 — read from the template, not assumed. A real two-page render
 * is still required before release.
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

/**
 * The quotes block's cost, in lines.
 *
 * ONE LINE PER PHRASE, READ OFF THE SHIPPED TEMPLATE RATHER THAN ASSUMED. `.quotes > li` is
 * `display: inline-block`, which reads as "these flow together in one row" — but the region is
 * `{{#own_words}}<ul class="quotes">…</ul>{{/own_words}}`, so the `<ul>` REPEATS and each phrase
 * gets its own block-level list. The inline-block only governs the single item inside it.
 *
 * The distinction is a factor of three on a three-quote sheet, and guessing it from the CSS
 * property would have under-counted by exactly that. `bb_trade.v1` is shipped and therefore
 * immutable, so the model matches the template rather than the other way round.
 */
function ownWordsLines(phrases: readonly string[] | undefined): number {
  return (
    (phrases ?? [])
      .filter((p) => p.trim().length > 0)
      // The rendered item carries a pair of curly quotes the phrase itself does not.
      .reduce((n, p) => n + rowLines("", `“${p}”`), 0)
  );
}

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
  /**
   * §8.4's verbatim quotes. MODELLED HERE EVEN THOUGH THE LADDER NEVER DROPS THEM — see
   * `fitOwnWords`. Counting them is what stops a future author from populating this field
   * before `degradeToFit` runs and silently spending a page the ladder thought it had.
   */
  ownWords?: string[];
}

/** Total rendered lines the page must find room for — masthead, section chrome and content. */
export function sheetContentLines(s: DegradableSheet): number {
  const sections =
    (s.capSectionTitle ? 1 : 0) +
    ((s.availFactRows ?? []).length > 0 ? 1 : 0) +
    ((s.employments ?? []).length > 0 || (s.experiences ?? []).length > 0 ? 1 : 0) +
    ((s.qualFactRows ?? []).length + (s.qualTickRows ?? []).length > 0 ? 1 : 0) +
    ((s.ownWords ?? []).length > 0 ? 1 : 0);
  return (
    nameLines(s.displayName) +
    (s.nameDevanagari ? 1 : 0) +
    sections * SECTION_CHROME_LINES +
    ownWordsLines(s.ownWords) +
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
  "top_qualification", // R4 ruling on Q2 — the credential floor, one line, never dropped
] as const;

/**
 * Indian trade-credential markers. A CLOSED vocabulary, matched as whole words.
 *
 * This is the whole definition of "a credential" for the protection below, and it is deliberately
 * narrow: a worker whose education line reads "10th pass" has no ITI/NCVT credential to protect,
 * so nothing is reserved for him and the rider costs his sheet nothing. Protecting any education
 * text would be a different, larger promise than the one that was ruled.
 */
const CREDENTIAL_MARKERS = ["ITI", "NCVT", "SCVT", "NTC", "NSQF"] as const;

const NON_WORD_RE = /[^A-Z0-9]+/;

/** True when a segment names one of them as a WHOLE word, case-insensitively. */
function namesACredential(segment: string): boolean {
  const words = new Set(segment.toUpperCase().split(NON_WORD_RE));
  return CREDENTIAL_MARKERS.some((marker) => words.has(marker));
}

/** How `buildQualificationRows` joins the parts of one row. */
const QUAL_SEGMENT_SEP = " · ";

/** The row the reserved line is re-inserted as, if its own row was dropped. */
const PROTECTED_QUAL_LABEL = "Qualification";

/**
 * The one credential line the ladder may never take, per the Q2 ruling.
 *
 * EDUCATION IS SEARCHED FIRST, and that is not arbitrary: the Education row's leading segment is
 * `humanizeEducationLevel(education_level)`, a single field holding the worker's HIGHEST stated
 * qualification. So "first credential segment in Education" already means "his highest" without
 * anyone inventing a seniority ordering across ITI, NCVT and NSQF — which would be a derived
 * claim about his credentials rather than a restatement of one (§8).
 *
 * Returns null when there is no credential at all, in which case nothing is protected.
 */
export function topQualificationLine(s: DegradableSheet): string | null {
  for (const label of ["Education", "Certificates", PROTECTED_QUAL_LABEL]) {
    const row = (s.qualFactRows ?? []).find((r) => r.label === label);
    if (!row) continue;
    const segment = row.value
      .split(QUAL_SEGMENT_SEP)
      .map((part) => part.trim())
      .find((part) => namesACredential(part));
    if (segment) return segment;
  }
  return null;
}

/**
 * Put the reserved credential line back if the step that just ran removed it.
 *
 * Runs after EVERY ladder step rather than only after the two that drop credential rows, so a
 * step added later cannot quietly take it: the invariant is enforced by the loop, not by every
 * future author remembering it.
 */
function preserveTopQualification(s: DegradableSheet, line: string): void {
  const rows = s.qualFactRows ?? [];
  if (rows.some((r) => r.value.includes(line))) return;
  s.qualFactRows = [...rows, { label: PROTECTED_QUAL_LABEL, value: line }];
}

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
 *
 * WHY THE FULL ORDER SURVIVES THE 2026-09-03 RULING EVEN THOUGH MOST OF IT NO LONGER RUNS. The
 * order is the ruled artefact; the ruling forbade EXECUTING the steps that delete a ratified row,
 * it did not re-rank them. So every step keeps its place and carries an {@link LadderEffect} tag,
 * and what `degradeToFit` walks is {@link COMPRESSING_LADDER} — a filter on that tag, never an
 * index range. Re-permitting a step is then one tag, and the precedence it re-enters is still the
 * one the shop floor ruled on.
 */
const OPTIONAL_VOLUNTEERED = ["surface_finish_ra", "fit_class_held", "bar_diameter_range_mm"];

/** The widest capability section any trade map can produce — the ladder must be able to empty it. */
const MAX_CAPABILITY_ROWS = TRADE_RESUME_MAPS.reduce((n, m) => Math.max(n, m.capability.length), 0);

/**
 * WHAT A STEP DOES TO THE SHEET, and therefore whether the 2026-09-03 ruling still lets it run.
 *
 * `compresses` — the step makes the sheet shorter WITHOUT deleting a row any ratified page
 *   prints. It may still run, and under the ruling it is the only thing that may.
 *
 * `sheds-a-ratified-row` — the step removes a row that `BadaBhai_21_Role_Resumes.pdf` prints.
 *   FORBIDDEN. The step stays in the list, tagged and reasoned, so its status is READ off the
 *   source rather than inferred from where it sits in an array.
 *
 * THE TAG IS EVIDENCE, NOT POSITION. It was decided per step against the twenty-one ratified
 * pages and against the measured `gain` each step produces on the two sheets that actually
 * overflow, which is why it does not follow the ladder's order: step 9 compresses while steps 3
 * and 4 — earlier, and therefore "cheaper" by the old reading — do not. Each step's `why`
 * carries that evidence.
 */
export type LadderEffect = "compresses" | "sheds-a-ratified-row";

interface LadderStep {
  readonly what: string;
  /** Whether this step may still run. See {@link LadderEffect}. */
  readonly effect: LadderEffect;
  /**
   * The EVIDENCE behind {@link effect} — which ratified pages print the row this step touches,
   * and what the step measurably gains. Present on every step so that re-classifying one means
   * arguing with a recorded measurement rather than editing a bare enum.
   */
  readonly why: string;
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
  {
    what: "optional volunteered fields",
    effect: "compresses",
    why:
      "No ratified page prints these three. `surface_finish_ra`, `fit_class_held` and " +
      "`bar_diameter_range_mm` appear in no pack JSON and no trade map, so the step matches " +
      "nothing and measures a gain of 0.00 on both overflowing sheets. IT IS A COMPRESSION ONLY " +
      "WHILE THAT IS TRUE: page 2 prints a 'Surface finish held' row, which today comes from the " +
      "DIFFERENT key `surface_finish` (grinding, rank 63). If `surface_finish_ra` ever lands and " +
      "maps to that row, this tag must flip to `sheds-a-ratified-row` in the same change.",
    apply: (s) => dropByKey(s, OPTIONAL_VOLUNTEERED),
  },
  {
    what: "production mode",
    effect: "compresses",
    why:
      "Same as the step above and for the same reason: `production_mode` is defined by no pack " +
      "and no map, no ratified page prints such a row, and the measured gain is 0.00.",
    apply: (s) => dropByKey(s, ["production_mode"]),
  },
  {
    what: "sector worked",
    effect: "sheds-a-ratified-row",
    why:
      "ALL TWENTY-ONE ratified pages end their capability block with a sector row — twenty print " +
      "'Sector worked', the CAD fresher's prints 'Sector studied'. It is also the exact row " +
      "`CAPABILITY_ROW_BUDGET = 10` exists to restore, so leaving it runnable makes the fix " +
      "circular: the budget admits the grinder's tenth row and this step deletes it again, for a " +
      "gain of 1.00 that lands the sheet back where the raise found it.",
    apply: (s) => dropByKey(s, ["sector_worked"]),
  },
  {
    what: "materials chips beyond two",
    effect: "sheds-a-ratified-row",
    why:
      "IT KEEPS THE ROW AND STILL DELETES THE WORKER'S CLAIMS, and it buys nothing: measured " +
      "gain 0.00 lines on BOTH overflowing sheets, because four short chips and two short chips " +
      "wrap to the same single line. On the fully-answered turner the old ladder ran this step, " +
      "gained nothing, and then shed 'Languages spoken' anyway. Unlike `collapseEmployments` it " +
      "leaves NO count of what it removed, which is precisely the silent deletion §11 #7 " +
      "forbids — and pages 2, 3 and 4 each print four material chips.",
    apply: (s) => {
      s.capChipRows = (s.capChipRows ?? []).map((r) =>
        (r as { key?: string }).key === "material_worked" && r.values.length > 2
          ? { ...r, values: r.values.slice(0, 2) }
          : r,
      );
    },
  },
  // Zone 5, reverse §5.1: languages (10), documents (9), certificates then education (8).
  {
    what: "languages",
    effect: "sheds-a-ratified-row",
    why:
      "All twenty-one ratified pages print 'Languages spoken'. This is the step that fired on " +
      "the fully-answered turner and took Haryanvi off his sheet — the loss the ruling names.",
    apply: (s) => dropQual(s, "Languages spoken"),
  },
  {
    what: "documents ready",
    effect: "sheds-a-ratified-row",
    why: "All twenty-one ratified pages print 'Documents ready'. Whole-row deletion, gain 2.00.",
    apply: (s) => dropQual(s, "Documents ready"),
  },
  {
    what: "certificates",
    effect: "sheds-a-ratified-row",
    why:
      "Fifteen of the twenty-one ratified pages print 'Certificates'. The six that do not are " +
      "workers who hold none, so the row is suppressed as empty under §11 #1 — an absence, not " +
      "a precedent for deleting the row from the fifteen who earned it.",
    apply: (s) => dropQual(s, "Certificates"),
  },
  {
    what: "education",
    effect: "sheds-a-ratified-row",
    why:
      "All twenty-one ratified pages print 'Education'. `preserveTopQualification` softens this " +
      "step but does not undo it: it re-inserts the credential SEGMENT alone, so the issuer and " +
      "the year still leave the sheet.",
    apply: (s) => dropQual(s, "Education"),
  },
  // Zone 4, §5.1 rank 7. Collapse to the count line rather than deleting silently — §11 #7.
  {
    what: "employers beyond three",
    effect: "compresses",
    why:
      "THREE IS THE RATIFIED CEILING: no page in the corpus prints a fourth employer block, so " +
      "this step can only fire on a shape the ratified pages do not contain. And a COUNT LINE " +
      "ALONGSIDE THREE BLOCKS is itself ratified presentation — page 16 (welder) is the one page " +
      "in the corpus that prints one, and it prints exactly that shape. §11 #7's " +
      "collapse-to-a-count, verified against a page rather than assumed from the comment. " +
      "WHAT PAGE 16 DOES NOT RATIFY IS THE LINE THIS STEP EMITS: its line reads '2 earlier " +
      "employers · 44 months total · 2015-2019' and `collapseEmployments` produces '6 earlier " +
      "employers' — the aggregates go, for the §8 reason argued in that function's doc-comment, " +
      "which must be read together with this tag. The page ratifies the FORM, not the string.",
    apply: (s) => collapseEmployments(s, 3),
  },
  {
    what: "employers beyond two",
    effect: "sheds-a-ratified-row",
    why:
      "UNLIKE THE STEP ABOVE, this one can only fire by taking a block off a sheet that has " +
      "three or fewer — the ratified shape, printed by pages 2, 3, 4, 15 and 16. It turns an " +
      "employer's name, dates and work line into a bare count: §11 #7's anti-deception property " +
      "survives, the §5.1 rank-7 CONTENT it exists for does not. OPEN QUESTION FOR THE OWNER — " +
      "if this and the step below are ruled compression, both overflowing sheets fit at 39.19 " +
      "and nothing spills at all, which would leave the spill path unexercised by the corpus. " +
      "That consequence is why it is put rather than decided here.",
    apply: (s) => collapseEmployments(s, 2),
  },
  {
    what: "employers beyond one",
    effect: "sheds-a-ratified-row",
    why: "The same argument as 'employers beyond two', twice over: gain 5.00, three blocks to one.",
    apply: (s) => collapseEmployments(s, 1),
  },
  // Capability, by descending rank. One step per row so the ladder sheds a single row at a time
  // and can still shed ALL of them.
  //
  // DERIVED FROM THE MAPS, NOT TYPED IN. A hard 12 was written here first and the turner pack has
  // 14 rows, so a maxed-out worker would have run out of ladder two rows before running out of
  // sheet — the ladder would have returned a still-overflowing page and reported a stage as if it
  // had succeeded. Counting the widest map means adding a row to a pack cannot reintroduce that.
  //
  // ALL OF THEM SHED BY CONSTRUCTION. A capability row is what the ratified pages are mostly MADE
  // of, so there is no reverse-rank position at which taking one stops being the loss the ruling
  // forbids. They remain, in order, as the record of which row would go first if a future ruling
  // ever re-permits the rung.
  ...Array.from({ length: MAX_CAPABILITY_ROWS }, (_, i) => ({
    what: `capability row ${i + 1} by reverse §5.1 rank`,
    effect: "sheds-a-ratified-row" as const,
    why:
      "Deletes a whole capability row. Every ratified page prints between seven and ten of " +
      "them, and `dropHighestRank` takes one from whichever persona it is handed.",
    apply: dropHighestRank,
  })),
];

/**
 * WHAT `degradeToFit` ACTUALLY WALKS — the steps the 2026-09-03 ruling still permits.
 *
 * A FILTER ON THE TAG, NEVER A SLICE. The permitted steps are not contiguous — 1, 2 and 9 —
 * because the classification is evidence about each step's effect on the ratified corpus and not
 * a prefix of the drop order. Any index arithmetic here would silently re-admit a forbidden step
 * the next time a row is inserted into the ladder.
 */
export const COMPRESSING_LADDER: readonly LadderStep[] = LADDER.filter(
  (step) => step.effect === "compresses",
);

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
 *
 * THE AGGREGATE SEGMENTS GO, AND THEIR LOSS IS THE HONESTY RULE RATHER THAN AN OVERSIGHT. The
 * mapper's own count line reads "5 earlier employers · 61 months total · 2011-2016", and those
 * two trailing segments describe THE EMPLOYERS ALREADY DROPPED. Fold one more employer in and
 * they no longer describe the set they are printed against, so carrying them forward would print
 * a stale total as if it were complete — precisely what `overflowLine` refuses to do when a
 * dropped record has no stated duration. Rebuilding them is not available either: this layer
 * holds rendered strings, and deriving "44 months total" back out of them would be the renderer
 * inventing a number (§8). So the line degrades to the part that is still true.
 */
function collapseEmployments(s: DegradableSheet, keep: number): void {
  const all = s.employments ?? [];
  if (all.length <= keep) return;
  const dropped = all.length - keep;
  s.employments = all.slice(0, keep);
  const existing = /^(\d+) earlier employers?/.exec(s.employmentsMore ?? "");
  const total = dropped + (existing ? Number(existing[1]) : 0);
  // SINGULAR WHEN IT IS ONE. `overflowLine` already agrees, and the two must: a sheet that prints
  // "1 earlier employers" is a printed grammatical error on a worker's résumé. It was unreachable
  // while the ladder rarely got this far and became ordinary under the 2026-09-03 ruling, which
  // made this the FIRST step with anything left to spend.
  s.employmentsMore = `${total} earlier ${total === 1 ? "employer" : "employers"}`;
}

/** One applied ladder step, with what it cost the sheet and what the sheet needed. */
export interface DegradationStep {
  readonly what: string;
  /** Lines the sheet was OVER budget before this step ran. */
  readonly over: number;
  /** Lines this step removed. */
  readonly gain: number;
}

export interface DegradationResult<T> {
  readonly sheet: T;
  /** 0 = nothing dropped. Stamped on the artifact so a PDF reproduces exactly (§7.4). */
  readonly stage: number;
  /** What each applied stage removed, for the provenance stamp and for the tests. */
  readonly dropped: readonly string[];
  /**
   * Per-step cost, for reading the ladder's GRANULARITY rather than just its order.
   *
   * The ladder always drops in decreasing order of what the guideline ranks, so it can never
   * shed something more decisive while something less decisive was still available. What it CAN
   * do is overshoot: a step whose `gain` far exceeds the `over` it was answering has taken a
   * whole block off the sheet where trimming inside that block would have cleared the floor.
   * That is a granularity finding, not a bug, and it is only visible if the numbers are kept.
   */
  readonly trace: readonly DegradationStep[];
  /**
   * TRUE WHEN THE SHEET SPILLS PAST ONE PAGE — the 2026-09-03 ruling's outcome, stated rather
   * than left silent.
   *
   * Before the ruling this could not happen without the ladder having run to exhaustion, so
   * "stage" carried the whole story and callers needed no other signal. Now a sheet can come
   * back at stage 0 and still not fit, because every step that would have cleared it deletes a
   * row a human signed off. A caller that cannot tell those apart would report a two-page résumé
   * as a clean render, so the flag rides on the result rather than being re-derived from
   * `sheetContentLines` by every consumer that remembers to.
   */
  readonly overflows: boolean;
  /**
   * How far past {@link SHEET_LINE_BUDGET} the returned sheet is, in lines. 0 when it fits.
   *
   * THE HARNESS ASSERTION NEEDS THE MAGNITUDE, NOT JUST THE FLAG. "One page unless a ratified row
   * required two" has to keep failing when sheets balloon for no reason, and a boolean cannot
   * tell 0.19 lines of overflow — the whole of what the ratified corpus produces — from five.
   *
   * READ IT FOR WHAT IT IS. 0.19 lines is 0.93 mm. `SHEET_LINE_BUDGET` was fitted at 41.7 and
   * ROUNDED DOWN, so a 41.19-line sheet occupies 201.4 mm of the worst measured C = 209.0 and
   * still clears `HEADROOM_FLOOR_MM`. Such a sheet overflows the integer budget while remaining
   * inside the millimetre model the integer came from; it very probably renders on one page. The
   * conservatism is deliberate and must not be fractionalised away to make the number disappear.
   */
  readonly overBudgetLines: number;
}

/**
 * Close off a result: measure what the ladder actually achieved and say so.
 *
 * ONE PLACE, because `degradeToFit` has three exits — fits immediately, fits mid-ladder, runs out
 * of permitted steps — and an overflow flag computed at two of the three is the bug this function
 * exists to make unwritable.
 */
function settle<T extends DegradableSheet>(
  sheet: T,
  dropped: readonly string[],
  trace: readonly DegradationStep[],
): DegradationResult<T> {
  const over = sheetContentLines(sheet) - SHEET_LINE_BUDGET;
  return {
    sheet,
    stage: dropped.length,
    dropped,
    trace,
    overflows: over > 0,
    overBudgetLines: over > 0 ? Number(over.toFixed(2)) : 0,
  };
}

/**
 * Compress until the content fits, and stop there — or hand back a sheet that spills, INTACT.
 *
 * RUNS OUT OF LADDER RATHER THAN OUT OF CONTENT. If every permitted step has been applied and the
 * sheet is still over budget, it returns rather than throwing: a worker with a pathological
 * profile gets a two-page résumé, which is a bad sheet, and an exception gets them NO sheet at
 * all. The harness is what catches this in CI; the runtime degrades.
 *
 * SINCE THE 2026-09-03 RULING THAT EXIT IS THE ORDINARY ONE, not the pathological one. The ladder
 * walks {@link COMPRESSING_LADDER} — the steps that shorten the sheet without deleting a row the
 * ratified pages print — and when those are exhausted it stops and SAYS SO through
 * {@link DegradationResult.overflows}, rather than continuing into steps that would buy the page
 * back with a row a human signed off.
 *
 * ── A COMPRESSION IS COMMITTED ONLY IF IT BUYS THE PAGE ────────────────────────────────
 *
 * THE FALL-THROUGH RETURNS THE SHEET AS IT ARRIVED, not the compressed one, and that is the
 * ruling applied to the ladder's own instrument rather than a shortcut. Every permitted step
 * still costs the worker something real: `collapseEmployments` turns an employer's name, dates
 * and work line into a count, and folding one more employer in also strips the "· N months total
 * · YYYY–YYYY" aggregates off that count (see its doc-comment). That price is worth paying FOR A
 * PAGE. It buys nothing at all on a sheet that spills anyway — the second page is already there,
 * it has ~41 lines of room, and the compression merely leaves more of it blank.
 *
 * MEASURED, WHICH IS WHY IT IS WRITTEN THIS WAY ROUND RATHER THAN AS "NEVER COMPRESS A SPILLING
 * SHEET". The same step lands on both sides of this line within one shape. The EMPLOYER copies of
 * matrix shapes 5 and 6 measure 42.19 and 43.19 lines, and collapsing to three employers brings
 * them to 40.19 — one page, bought, committed. The WORKER copies of those two shapes carry one
 * line more (the asking price the payer's copy withholds), so the same collapse lands them on
 * 41.19, which still spills; before this rule they paid an employer block for a page they did not
 * get. Discarding `working` on the fall-through is what makes the cost conditional on the benefit.
 *
 * MONOTONICITY IS WHAT MAKES THE PREFIX THE MINIMUM. Every step only ever shortens the sheet, so
 * the first prefix of the ladder that fits is also the cheapest prefix that fits, and no other
 * ordering of the permitted steps would have fitted for less. It follows that a sheet returned
 * overflowing could not have been saved by ANY subset of them — which is the property
 * `sheet-shape-matrix.test.ts` asserts rather than trusting this paragraph.
 *
 * IT IS NOT A PAGE-COUNT MODEL. The only question this function answers is "does it fit ONE
 * page", because that is the only question `SHEET_LINE_BUDGET` was fitted to answer: the budget
 * prices page 1 with its masthead and section chrome, and page 2's chrome is different and
 * unmeasured. A sheet far enough over to reach a THIRD page would therefore not be compressed
 * either. No corpus shape comes close — the worst is 2.93 lines over a 41-line budget — and
 * `sheet-shape-matrix.test.ts` asserts that bound, so the gap fails loudly rather than silently
 * if content ever grows into it.
 */
export function degradeToFit<T extends DegradableSheet>(input: T): DegradationResult<T> {
  const working: T = { ...input };
  const dropped: string[] = [];
  const trace: DegradationStep[] = [];
  // Captured BEFORE the first step, because the step that drops the row is also the step that
  // would destroy the evidence of what was in it.
  const reservedQualification = topQualificationLine(working);
  if (sheetContentLines(working) <= SHEET_LINE_BUDGET) {
    return settle(working, dropped, trace);
  }
  for (let i = 0; i < COMPRESSING_LADDER.length; i += 1) {
    const before = sheetContentLines(working);
    const shapeBefore = JSON.stringify(working);
    COMPRESSING_LADDER[i]!.apply(working);
    if (reservedQualification) preserveTopQualification(working, reservedQualification);
    const after = sheetContentLines(working);
    // Only a step that actually CHANGED THE SHEET counts as a stage — steps 1 and 2 match nothing
    // today, and a stage number that moved without the page changing would be a lie on the
    // provenance stamp.
    //
    // The test used to be `after < before`, using the line count as a proxy for "did anything
    // change". The credential rider broke that proxy: dropping an Education row and reserving its
    // qualification line costs one line and returns one, so the count is unchanged while the row
    // lost its issuer and year. Comparing the sheet itself asks the question directly, and a
    // `gain` of 0 in the trace below is then the honest number rather than a missing stage.
    if (JSON.stringify(working) !== shapeBefore) {
      dropped.push(COMPRESSING_LADDER[i]!.what);
      trace.push({
        what: COMPRESSING_LADDER[i]!.what,
        over: Number((before - SHEET_LINE_BUDGET).toFixed(2)),
        gain: Number((before - after).toFixed(2)),
      });
    }
    if (after <= SHEET_LINE_BUDGET) {
      return settle(working, dropped, trace);
    }
  }
  // OUT OF PERMITTED STEPS AND STILL OVER BUDGET, so `working` is DISCARDED and the sheet goes
  // back as it arrived. The compressions above were spent and bought no page; under the
  // 2026-09-03 ruling they are therefore not charged to the worker. See the header for the
  // measurement that separates this case from the one where the same step does buy the page.
  //
  // `dropped` and `trace` are empty because nothing WAS dropped. Reporting the abandoned attempts
  // as applied stages would stamp the artifact with a drop no reader could find on the sheet, and
  // `settle` would then be measuring a different sheet from the one it returns.
  return settle({ ...input }, [], []);
}

/**
 * Add §8.4's verbatim quotes into whatever room the sheet has LEFT, and no further.
 *
 * WHY IT RUNS AFTER THE LADDER RATHER THAN INSIDE IT. The drop order is a ruled artefact — it
 * is reverse §5.1 decisiveness with the turner additions slotted per R1 §3, flagged for RVM
 * redline as trade truth. Inserting a new item into it would be a change to that ruling, made
 * by whoever happened to build this block. So the block never enters the competition: it takes
 * the space nobody ranked, which is exactly the space a junior's sheet is made of.
 *
 * THE RESULT ON THE TWO ENDS OF THE LADDER, AND IT IS THE INTENDED ONE. The two-year operator's
 * sheet measures 163 mm of a 297 mm page, so he gets every quote he earned — the case §8.4
 * exists for, and the reason the guideline calls this what makes off-wedge résumés work on day
 * one. The eight-year setter is already over budget before this runs, so he gets none, and the
 * quotes cost his sheet nothing.
 *
 * NO PARTIAL PHRASE, EVER. It adds whole quotes while they fit and stops at the first that does
 * not; a truncated quote with an ellipsis would be the renderer editing a worker's words, which
 * is the one thing this block may not do.
 */
export function fitOwnWords<T extends DegradableSheet>(sheet: T, phrases: readonly string[]): T {
  const kept: string[] = [];
  for (const phrase of phrases) {
    const next = [...kept, phrase];
    if (sheetContentLines({ ...sheet, ownWords: next }) > SHEET_LINE_BUDGET) break;
    kept.push(phrase);
  }
  return { ...sheet, ownWords: kept };
}
