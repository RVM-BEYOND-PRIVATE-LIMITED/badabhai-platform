import { beforeAll, describe, expect, it } from "vitest";

import { primeSheetQr, SHEET_SHAPES, withSheetQr } from "./__fixtures__/sheet-shapes";

// Render exactly what the other suites render. The QR is an attribute rather than printed
// text, so it changes nothing this gate reads — which is itself worth having asserted.
beforeAll(primeSheetQr);
import {
  AVAILABILITY_STATUSES,
  SHIFTS,
  WORK_TYPES,
} from "../profiles/worker-preferences.vocabulary";
import {
  ROAD_PERSONAS,
  ROAD_ROLE,
  roadContext,
  roadPersona,
  type RoadPersona,
} from "./__fixtures__/general-road";
import { buildResumeRenderInput } from "./resume-render-input";
import { TRADE_RESUME_MAPS } from "./trade-resume-map";

/**
 * ── THE FABRICATION GATE ──────────────────────────────────────────────────────────────
 *
 * §8, the governing rule, verbatim: "The model extracts, normalises and classifies. It never
 * composes. Every printed string on a BadaBhai resume originates from one of exactly three
 * sources: a closed vocabulary label, a number the worker stated, or the worker's own words
 * rendered verbatim. THERE IS NO FOURTH SOURCE."
 *
 * THAT SENTENCE HAS TO BE EXECUTABLE, not a review habit. A review habit catches a fabrication
 * the day someone looks; this catches it the moment it is written, on every shape in the matrix,
 * on both audiences. The failure it exists for is the quiet one — an adjective added to a label
 * to make a sheet read better, a tenure rounded up, a "Skilled" or an "Experienced" that no
 * worker ever said — because at the machine trial the fabrication is discovered and the employer
 * stops trusting BadaBhai, not the worker.
 *
 * HOW IT WORKS. Every string the mapper contributes to the page is split into ATOMS on the
 * composition separators the design uses, and each atom must resolve to one of:
 *
 *   1. {@link CLOSED_VOCABULARY} — a reviewed label. Built by ENUMERATING `TRADE_RESUME_MAPS`
 *      rather than by listing strings by hand, so a dictionary entry added tomorrow is allowed
 *      automatically and a label invented in the renderer is not.
 *   2. {@link COMPOSED_PHRASES} — a deterministic phrase the sheet's own code composes, each
 *      pinned to the guideline clause that authorises it. Numbers inside these are checked
 *      separately by the digit rule below.
 *   3. The worker's own words — a substring of something the fixture actually supplies to the
 *      renderer. workerSupplied() walks the fixture rather than reading a list beside it: a
 *      hand-written list would drift from the fixture, and every drift widens the gate.
 *      The containment is ONE-DIRECTIONAL — the printed atom must sit inside a supplied string,
 *      never the reverse. Reversed, "Highly skilled CNC turning" would pass because it contains
 *      "CNC turning", which is exactly the fabrication this gate exists to catch.
 *
 * AND EVERY DIGIT RUN must appear in a worker-stated string or be arithmetic over stated dates.
 * Without that rule the phrase templates would launder any number at all: "3 yrs 8 mo" matches
 * the pattern whether the tenure is right or invented.
 */

/**
 * Every reviewed English label in the trade maps — row labels, value labels AND config labels.
 *
 * `configValues` WAS MISSING, and R16 §1 is what made that matter. The gate enumerated
 * `row.values` only, so "3-axis" and "4-axis" were outside the closed vocabulary — dormant
 * purely because every sheet fixture is a turner or pack-less, and the turner pack asks no
 * configuration question. Wiring the axis labels into the Verdict Line put them on a second
 * surface, and the gate would have called the sheet's own reviewed dictionary a fabrication the
 * first time a milling shape was added. A vocabulary that omits part of its own source is not a
 * narrower gate, it is a wrong one.
 */
const DICTIONARY: ReadonlySet<string> = new Set(
  TRADE_RESUME_MAPS.flatMap((m) => [
    m.section_title,
    ...m.capability.flatMap((row) => [
      row.label,
      ...Object.values(row.values ?? {}),
      ...Object.values(row.configValues ?? {}),
    ]),
  ]),
);

/**
 * Labels the sheet's own row builders emit. Listed because they live in three small files and
 * enumerating them from source would mean parsing TypeScript; each one is a fixed English label
 * with no worker content in it, and adding one here is a deliberate, reviewable act.
 */
const SHEET_LABELS: readonly string[] = [
  "Available from",
  "Salary expected",
  "Preferred locations",
  "Shift",
  "Accommodation",
  "Required",
  "Willing to relocate",
  "Education",
  "Certificates",
  "Training",
  "Languages spoken",
  "Documents ready",
  // Layer A (f)/(i) — the declared secondary occupations row. The VALUES are taxonomy display
  // labels (closed vocabulary from @badabhai/taxonomy), the label is this fixed English string.
  "Also works as",
  "Duration not stated",
  // §6.2's TENURE STATUS, emitted by `tenurePhrase` when the role's own fresher rung was tapped.
  // A CLOSED-VOCABULARY LABEL, which is §8's first permitted source — not a figure and not a
  // sentence — and it is only reachable for a worker whose chip said it (see
  // `fresherTenureLabel`). LISTED WHILE NO FIXTURE PRINTS IT, deliberately: the shape matrix has
  // no drawing-office shape at all, so this is dormant exactly the way `configValues` was before
  // a milling shape existed — and that dormancy is what made the gate call the sheet's own
  // reviewed dictionary a fabrication the first time one was added. The vocabulary should not
  // omit a word the renderer can emit.
  "Fresher",
  // NO TENURE BANDS HERE, AND THAT ABSENCE IS THE RULING. A revision of 2026-09-09 briefly
  // printed the tier gate's rungs as bands ("1–3 yrs", "7+ yrs") and listed them in this
  // vocabulary; the owner ruled the same day that experience is not a range taken from any
  // question — it is the sum of the work history — so the renderer emits no such string and this
  // gate must not license one. If a band ever appears in a printed atom again, the fabrication
  // gate going red is the correct outcome, not a missing dictionary entry.
  "Present",
];

/**
 * THE GENERAL FORM'S CLOSED ANSWERS AS THE SHEET PRINTS THEM (ADR-0045 Phase 5) — the shift, the
 * work types and the availability status. ENUMERATED from the vocabulary the form is bounded by,
 * like {@link DICTIONARY}, so an option added tomorrow is licensed automatically and a label
 * invented in the renderer is not. The general road is the first sheet this gate scans that
 * prints them: its Shift row is "{shift} · {work types}", and its Available from row speaks the
 * status vocabulary ("Within a week").
 */
const FORM_VOCABULARY: readonly string[] = [
  ...Object.values(SHIFTS),
  ...Object.values(WORK_TYPES),
  ...Object.values(AVAILABILITY_STATUSES),
];

const CLOSED_VOCABULARY: ReadonlySet<string> = new Set([
  ...DICTIONARY,
  ...SHEET_LABELS,
  ...FORM_VOCABULARY,
]);

/**
 * Deterministic compositions, each with the clause that authorises it.
 *
 * NOTHING HERE MAY ADMIT A WORD THE CODE DOES NOT ALREADY EMIT. A pattern like `/^\w+$/` would
 * make this whole file vacuous, which is why every entry is anchored and spelled out.
 */
const COMPOSED_PHRASES: readonly { re: RegExp; why: string }[] = [
  { re: /^\d+ yrs?( \d+ mo)?$/, why: "§6.2 total years / §11 #6 tenure" },
  { re: /^\d+ mo$/, why: "§11 #6 tenure under a year" },
  { re: /^duration not stated$/i, why: "§11 #3" },
  { re: /^available immediately$/, why: "§6.2 availability segment" },
  { re: /^available in \d+ days$/, why: "§6.2 availability segment" },
  { re: /^available in Notice period$/, why: "§6.2 availability, notice with no day count" },
  { re: /^\d+ days$/, why: "§4.4 notice period" },
  { re: /^Notice period$/, why: "§4.4 notice period with no day count" },
  { re: /^Immediate$/, why: "§4.4 availability" },
  { re: /^expects ₹[\d,]+ \/ month$/, why: "§6.2 expected pay" },
  { re: /^₹[\d,]+ \/ month$/, why: "§4.4 expected pay" },
  { re: /^[A-Z][a-z]{2} \d{4}$/, why: "§11 #6 month-year bound" },
  { re: /^\d+ earlier employers?$/, why: "§11 #7 overflow count" },
  { re: /^\d+ months total$/, why: "§11 #7 overflow total" },
  { re: /^\d{4}–\d{4}$/, why: "§11 #7 overflow year span" },
  { re: /^±[\d.]+ mm( or finer)?$/, why: "§4.3 tolerance band" },
  { re: /^Day$|^Night$|^Rotational$|^Any shift$/, why: "§4.3 shift_willingness" },
  // ── ADR-0045 Phase 5 — the general road's terms rows. Each is the worker's own figure or date
  // in a fixed frame; the digit rule below still has to find every number in what he stated.
  {
    // "₹18,000 – ₹22,000 / month" splits on " – ": the band's LOWER end stands alone.
    re: /^₹[\d,]+$/,
    why: "§4.4 expected pay, the lower end of a band",
  },
  { re: /^expects ₹[\d,]+$/, why: "§6.2 expected pay, the lower end of a band" },
  {
    re: /^From \d{1,2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4}$/,
    why: "ADR-0045 §3.4 Available from, a stated date still ahead",
  },
  { re: /^Serving notice \(\d+ days?\)$/, why: "ADR-0045 §3.4 Available from, notice with days" },
];

/** Chrome: the masthead, the footer and the fixed disclaimer. Not worker content, not a claim. */
const CHROME_TEXT: readonly RegExp[] = [
  /^BadaBhai$/,
  /^Scan to visit BadaBhai$/,
  /^badabhai\.ai$/,
  /^Generated \d{1,2} [A-Z][a-z]+ \d{4}$/,
  /^Ref [A-Z0-9]{6}$/,
  /^Details as stated by the worker\. BadaBhai does not guarantee hiring\.$/,
];

/** The separators the sheet composes with. Splitting on them is what exposes an added word. */
function atomsOf(text: string): string[] {
  return text
    .split(/\s+·\s+|\s+–\s+|,\s+|"|“|”/)
    .map((t) => t.trim())
    .filter(Boolean);
}

/** The render input this gate reads — `bb_trade` for the matrix, `bb_general` for the road. */
function renderFor(
  shape: (typeof SHEET_SHAPES)[number],
  audience: "worker" | "employer",
  templateId = "bb_trade",
) {
  return buildResumeRenderInput(
    shape.snapshot,
    shape.displayName,
    templateId,
    null,
    false,
    audience,
    withSheetQr(shape.tradeSheet),
  );
}

/**
 * Every string this render puts on the page, before the template wraps it in markup.
 *
 * NOT THE BRIEF (ADR-0045 R6). The general road's one line of prose has its own licence —
 * {@link briefLicensed}, checked WHOLE before any atom splitting — because an atom rule would
 * either refuse the worker's own sentence or, to accept it, have to widen for every other string.
 */
function printedStrings(
  shape: (typeof SHEET_SHAPES)[number],
  audience: "worker" | "employer",
  templateId = "bb_trade",
) {
  const input = renderFor(shape, audience, templateId);
  const out: string[] = [];
  const push = (v: string | null | undefined) => {
    if (v && v.trim()) out.push(v.trim());
  };
  push(input.headlineLine);
  push(input.subheadLine);
  // LAYER A (h) — the generic headline and summary slots. They print on the classic layouts
  // rather than on bb_trade, but they are composed from the same confirmed values as the verdict
  // line and they are exactly the kind of composition this gate exists to hold to §8: every atom
  // is a stated label, a licensed figure or a worker-stated city.
  push(input.profileHeadline);
  push(input.summary);
  // THE MASTHEAD's LOCATION LINE (owner ruling 2026-09-08). SCANNED AS CONTENT, unlike the name
  // and the phone below: those are single caller-supplied values printed verbatim, while this is
  // COMPOSED — two columns joined with a separator — and anything composed is exactly what this
  // gate exists to hold to §8. `atomsOf` splits on ", ", so each half must independently resolve
  // to something the worker stated.
  push(input.locationLine);
  push(input.capSectionTitle);
  for (const r of [
    ...(input.capChipRows ?? []),
    ...(input.capTickRows ?? []),
    ...(input.qualTickRows ?? []),
  ]) {
    push(r.label);
    r.values.forEach(push);
  }
  for (const r of [
    ...(input.capFactRows ?? []),
    ...(input.availFactRows ?? []),
    ...(input.qualFactRows ?? []),
  ]) {
    push(r.label);
    push(r.value);
  }
  for (const e of input.employments ?? []) {
    push(e.employer);
    push(e.location_suffix?.replace(/^ · /, ""));
    push(e.when);
    push(e.work);
    for (const role of e.roles) {
      push(role.role);
      push(role.when);
    }
  }
  push(input.employmentsMore);
  for (const e of input.experiences) {
    push(e.role);
    push(e.duration);
    push(e.work);
  }
  (input.ownWords ?? []).forEach(push);
  // `bb_general` PRINTS THE THREE LISTS IN FULL as its Skills section (`bb_trade` shows three
  // tools in the headline, which the headline line above already carries) — so on that layout
  // every entry is a printed string and has to have a source.
  if (templateId === "bb_general") {
    for (const list of [input.skills, input.machines, input.controllers]) list.forEach(push);
  }
  push(input.qrCaption);
  push(input.shortLink);
  push(input.footerMeta);
  push(input.trustBadge);
  // The name and the phone are identity, supplied by the caller and never composed — they are
  // deliberately NOT scanned as content. Their own guards live in the disclosure tests.
  return out;
}

/**
 * Every free-text string this fixture HANDS the renderer.
 *
 * WALKED, NOT LISTED. The gate measures the difference between what went in and what came out,
 * so the "went in" side has to be the fixture itself. A parallel hand-written list would go stale
 * the first time a fixture changed, and a stale list only ever makes the gate weaker.
 *
 * ATTRIBUTE SLUGS ARE DELIBERATELY EXCLUDED. `cnc_lathe` is an input, but it must NEVER print --
 * it reaches the page only after `trade-resume-map.ts` translates it to a reviewed English label,
 * and treating the slug as a printable source would license printing the slug itself.
 */
function workerSupplied(shape: (typeof SHEET_SHAPES)[number]): string[] {
  const out: (string | undefined)[] = [];
  const rp = shape.snapshot.resume_profile as Record<string, unknown> | undefined;
  if (rp) {
    for (const key of ["domain_label", "role_label", "current_city", "shift"]) {
      if (typeof rp[key] === "string") out.push(rp[key] as string);
    }
    for (const key of ["skills", "preferred_locations"]) {
      out.push(...((rp[key] as string[] | undefined) ?? []));
    }
    for (const e of (rp.experiences as Record<string, string>[] | undefined) ?? []) {
      out.push(e.role_label, e.duration_text, e.work_done);
    }
  }
  // THE LEGACY DRAFT'S OWN FREE TEXT (ADR-0045 Phase 5). A general-road snapshot carries no
  // container: its role and domain are the chat's certified labels, its skills the list the worker
  // confirmed at the gate (`skill_labels`), its machines the draft's own. Walked for the reason the
  // container's fields are — every matrix shape is container-only, so this licenses nothing new
  // there.
  const draft = shape.snapshot;
  for (const key of ["role_label", "domain_label"]) {
    if (typeof draft[key] === "string") out.push(draft[key] as string);
  }
  for (const key of ["skill_labels", "machines"]) {
    const list = draft[key];
    if (Array.isArray(list)) out.push(...list.filter((v): v is string => typeof v === "string"));
  }
  // The worker's own registration answer — `workers.current_city` / `current_state`, typed on the
  // onboarding screen beside his name. A value the worker stated, which is §8's second permitted
  // source; the renderer only joins the two halves.
  out.push(shape.tradeSheet?.currentCity ?? undefined, shape.tradeSheet?.currentState ?? undefined);
  for (const e of shape.tradeSheet?.employments ?? []) {
    out.push(e.employer, e.employerCity ?? undefined, e.employerState ?? undefined);
    for (const r of e.roles) {
      // ── THE ONE NAMED EXCEPTION TO SECTION 8 (#1350) ──────────────────────────────────
      //
      // `workDonePolished` is text the MODEL COMPOSED. Admitting it here is admitting a fourth
      // source, which is exactly what this gate was built to make impossible — so it is written
      // as one named field on one row type, never as a relaxation of `sourced()`.
      //
      // WHAT STILL HOLDS. Every other atom on the sheet — every label, number, city, education
      // line, certificate, tolerance and duration — is unchanged and still has to resolve to a
      // closed-vocabulary label, a worker-stated number, or verbatim worker words. The override
      // buys exactly one field.
      //
      // WHAT NO LONGER HOLDS, stated plainly so nobody has to infer it from a diff: this gate
      // can no longer prove a work description is something the worker said. The guarantees
      // that replaced it live on the far side of `/profiling/work-history/polish` — a prompt
      // written as prohibitions, a digit-grounding check, a length cap and a pseudonymize
      // re-certification — and they are weaker than this one was, because they are checks on a
      // model rather than a proof about bytes. #1350 records that trade being made knowingly.
      out.push(r.roleLabel, r.workDone ?? undefined, r.workDonePolished ?? undefined);
    }
  }
  const q = shape.tradeSheet?.qualification;
  if (q) {
    out.push(q.educationHeadline ?? undefined);
    for (const list of [q.education, q.certifications, q.languages, q.documents]) {
      out.push(...(list ?? []));
    }
  }
  return out.filter((v): v is string => typeof v === "string" && v.trim().length > 0);
}

function sourced(atom: string, supplied: readonly string[]): boolean {
  if (CLOSED_VOCABULARY.has(atom)) return true;
  if (COMPOSED_PHRASES.some((p) => p.re.test(atom))) return true;
  if (CHROME_TEXT.some((re) => re.test(atom))) return true;
  // ONE-DIRECTIONAL: `said.includes(atom)`, never the reverse. See the header note.
  //
  // CASE-INSENSITIVE SINCE THE 2026-09-08 CASING RULING, and that is a widening of exactly one
  // dimension. An employer name and a place are now printed as proper nouns — `sandhar
  // technologies` renders as `Sandhar Technologies` — which is the pipeline RESHAPING the
  // worker's words, the thing this fixture's own header says it may do. It is not a widening of
  // the containment: an atom must still be a substring of something this worker actually
  // supplied, so "Highly skilled" is refused exactly as before, in any casing.
  const lower = atom.toLowerCase();
  return supplied.some((said) => said.toLowerCase().includes(lower));
}

/**
 * ── THE GENERAL ROAD'S PASS (ADR-0045 Phase 5) ────────────────────────────────────────────
 *
 * The matrix above renders every shape as `bb_trade`, where the road is off by construction, so
 * without this pass the road's sheet — its brief, its skills-first headline, its Skills lists,
 * its band and its dated "Available from" — would never be scanned at all. Rendered as
 * `bb_general` WITH the road context, from the shared road personas (`__fixtures__/general-road`),
 * never as new `SHEET_SHAPES`: the matrix's shape count is quoted across the suite.
 */
type RoadShape = (typeof SHEET_SHAPES)[number] & { readonly persona: RoadPersona };

const ROAD_SHAPES: readonly RoadShape[] = ROAD_PERSONAS.map((persona, i) => ({
  n: 101 + i,
  name: persona.name,
  clause: "ADR-0045 R5/R6 — the general road",
  overflow: false,
  snapshot: persona.snapshot,
  displayName: persona.displayName,
  tradeSheet: roadContext(persona),
  persona,
}));

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** "A, B and C" / "A and B" / "A" — the fixed line's joiner, restated here rather than imported. */
function joinedAsTheLineJoins(skills: readonly string[]): string {
  return skills.length <= 1
    ? skills.join("")
    : `${skills.slice(0, -1).join(", ")} and ${skills[skills.length - 1]}`;
}

/**
 * The fixture's employment total as the headline writes it ("7 yrs 4 mo"), RECOMPUTED here from
 * the stated dates with the pipeline's own rounding — inclusive months, summed, one-decimal
 * years, then the whole/remainder split — or null when any job is undated or none exists.
 */
function yearsAsTheHeadlineWrites(shape: RoadShape): string | null {
  const employments = shape.tradeSheet?.employments ?? [];
  const asOf = shape.tradeSheet?.asOf ?? null;
  if (employments.length === 0) return null;
  let months = 0;
  for (const e of employments) {
    const end =
      e.endYm ??
      (asOf ? `${asOf.getUTCFullYear()}-${String(asOf.getUTCMonth() + 1).padStart(2, "0")}` : null);
    if (!e.durationStated || !e.startYm || !end) return null;
    months +=
      (Number(end.slice(0, 4)) - Number(e.startYm.slice(0, 4))) * 12 +
      (Number(end.slice(5, 7)) - Number(e.startYm.slice(5, 7))) +
      1;
  }
  const years = Math.round((months / 12) * 10) / 10;
  const whole = Math.floor(years);
  const mo = Math.round((years - whole) * 12);
  const parts = [
    whole > 0 ? `${whole} ${whole === 1 ? "yr" : "yrs"}` : null,
    mo > 0 ? `${mo} mo` : null,
  ];
  const kept = parts.filter((p): p is string => p !== null);
  return kept.length > 0 ? kept.join(" ") : null;
}

/**
 * THE BRIEF'S LICENCE (ADR-0045 §4.3) — checked WHOLE, before any atom splitting.
 *
 * NEVER BY ADDING THE BRIEF TO `workerSupplied`. The containment rule would then license every
 * substring of it for every OTHER printed string: a brief saying "experienced" would make the
 * adjective sourced on any label on the page — the fabrication this file exists to stop.
 *
 * EXACTLY TWO WAYS TO PASS:
 *   (a) EXACT equality with the worker's stored text. Not containment: a truncated line, or his
 *       line with words appended, is a sentence he did not write.
 *   (b) a STRICT parse of the ONE fixed-line sentence the fixture's facts select — years known:
 *       "{R} with {Y} of experience in {S}." or "{R} with {Y} of experience."; no job stored:
 *       "Fresher {R} with skills in {S}."; jobs not all dated: "{R} with skills in {S}." — with R
 *       the fixture's cased role, Y recomputed from its dates, and S a prefix (at most three) of
 *       its skills, joined. NOT by calling `composeFallbackBrief`: a gate that asks the code under
 *       test for the answer approves whatever the code does.
 * DIGITS need no rule of their own here: (a)'s are the worker's own words, (b)'s are Y, compared
 * whole against arithmetic over his stated dates.
 */
function briefLicensed(text: string, shape: RoadShape): boolean {
  const stored = shape.persona.storedBrief as { status?: unknown; text?: unknown } | undefined;
  if (stored?.status === "answered" && text === stored.text) return true;
  const role = escapeRegExp(ROAD_ROLE);
  const skills = (shape.snapshot.skill_labels as string[] | undefined) ?? [];
  const lists = [1, 2, 3]
    .filter((k) => k <= skills.length)
    .map((k) => joinedAsTheLineJoins(skills.slice(0, k)));
  const years = yearsAsTheHeadlineWrites(shape);
  if (years !== null) {
    const m = new RegExp(`^${role} with (.+?) of experience in (.+)\\.$`).exec(text);
    if (m) return m[1] === years && lists.includes(m[2]!);
    return text === `${ROAD_ROLE} with ${years} of experience.`;
  }
  const fresher = (shape.tradeSheet?.employments ?? []).length === 0;
  const m = new RegExp(
    fresher ? `^Fresher ${role} with skills in (.+)\\.$` : `^${role} with skills in (.+)\\.$`,
  ).exec(text);
  return m !== null && lists.includes(m[1]!);
}

describe("§8 — every printed string has one of exactly three sources", () => {
  it.each(SHEET_SHAPES)("shape $n — $name", (shape) => {
    const supplied = workerSupplied(shape);
    for (const audience of ["worker", "employer"] as const) {
      for (const text of printedStrings(shape, audience)) {
        // THE WHOLE STRING FIRST. A reviewed label may itself contain the separators the design
        // composes with — "Machines, controllers & capability" is one string, not three — so
        // splitting unconditionally would reject the dictionary's own entries.
        if (sourced(text, supplied)) continue;
        for (const atom of atomsOf(text)) {
          expect(
            sourced(atom, supplied),
            `shape ${shape.n}/${audience}: "${atom}" (in "${text}") has no source — it is not a ` +
              `closed-vocabulary label, not a composed phrase the guideline authorises, and not ` +
              `something this worker supplied. §8: there is no fourth source.`,
          ).toBe(true);
        }
      }
    }
  });

  it.each(ROAD_SHAPES)("general road $n — $name (bb_general, ADR-0045)", (shape) => {
    const supplied = workerSupplied(shape);
    for (const audience of ["worker", "employer"] as const) {
      // THE BRIEF FIRST, WHOLE, under its own licence — and never vacuously: every road persona
      // prints one, on both copies.
      const brief = renderFor(shape, audience, "bb_general").profileBrief;
      expect(brief, `${shape.name}/${audience}: no brief printed`).toBeTruthy();
      expect(
        briefLicensed(brief!, shape),
        `${shape.name}/${audience}: the brief "${brief}" is neither the worker's stored line nor ` +
          `the fixed line the fixture's own facts compose. ADR-0045 §4.3.`,
      ).toBe(true);
      for (const text of printedStrings(shape, audience, "bb_general")) {
        if (sourced(text, supplied)) continue;
        for (const atom of atomsOf(text)) {
          expect(
            sourced(atom, supplied),
            `${shape.name}/${audience}: "${atom}" (in "${text}") has no source. §8.`,
          ).toBe(true);
        }
      }
    }
  });
});

describe("§8 — every printed digit is stated or is arithmetic over stated dates", () => {
  /** Digit runs the worker supplied, plus every number derivable from their stated months. */
  function statedDigits(shape: (typeof SHEET_SHAPES)[number]): Set<string> {
    const digits = new Set<string>();
    for (const said of workerSupplied(shape)) {
      for (const run of said.match(/\d+/g) ?? []) digits.add(run);
    }
    for (const e of shape.tradeSheet?.employments ?? []) {
      for (const ym of [e.startYm, e.endYm, ...e.roles.flatMap((r) => [r.startYm, r.endYm])]) {
        if (!ym) continue;
        digits.add(ym.slice(0, 4)); // the year, as printed
        digits.add(String(Number(ym.slice(5, 7)))); // the month, unpadded
      }
    }
    const attributes = shape.tradeSheet?.attributes ?? {};
    const salaries = [
      (shape.snapshot.resume_profile as { expected_salary?: number } | undefined)?.expected_salary,
      // ADR-0045 — the general form's band, both ends as the worker stated them.
      attributes.salary_expected_min,
      attributes.salary_expected_max,
    ];
    for (const salary of salaries) {
      if (typeof salary !== "number" || !salary) continue;
      digits.add(String(salary));
      for (const g of new Intl.NumberFormat("en-IN").format(salary).split(",")) digits.add(g);
    }
    // ADR-0045 — the general form's availability: the stated date's day (unpadded, as "From 12 Oct
    // 2026" prints it) and year, and the notice period's day count.
    const availability = attributes.availability as
      | { available_from?: string; notice_period_days?: number }
      | undefined;
    const from = /^(\d{4})-\d{2}-(\d{2})$/.exec(availability?.available_from ?? "");
    if (from) {
      digits.add(from[1]!);
      digits.add(String(Number(from[2])));
    }
    if (typeof availability?.notice_period_days === "number") {
      digits.add(String(availability.notice_period_days));
    }
    return digits;
  }

  /**
   * Tenure figures the block is ALLOWED to compute — §8 stage 4 is deterministic normalisation,
   * so months derived from two stated dates are sourced even though nobody said them aloud.
   *
   * RECOMPUTED HERE FROM THE FIXTURE, not read back from the render. Trusting the render's own
   * arithmetic would make this rule circular: an off-by-one in the mapper would validate itself.
   */
  function derivedTenureDigits(shape: (typeof SHEET_SHAPES)[number]): Set<string> {
    const out = new Set<string>();
    const asOf = shape.tradeSheet?.asOf ?? null;
    const spans: [string, string][] = [];
    for (const e of shape.tradeSheet?.employments ?? []) {
      const close = (s: string | null, t: string | null) => {
        const end =
          t ??
          (asOf
            ? `${asOf.getUTCFullYear()}-${String(asOf.getUTCMonth() + 1).padStart(2, "0")}`
            : null);
        if (s && end) spans.push([s, end]);
      };
      close(e.startYm, e.endYm);
      for (const r of e.roles) close(r.startYm, r.endYm);
    }
    let overflowTotal = 0;
    spans.forEach(([s, t], i) => {
      const months =
        (Number(t.slice(0, 4)) - Number(s.slice(0, 4))) * 12 +
        (Number(t.slice(5, 7)) - Number(s.slice(5, 7))) +
        1;
      out.add(String(months));
      out.add(String(Math.floor(months / 12)));
      out.add(String(months % 12));
      if (i >= 4) overflowTotal += months;
    });
    out.add(String(overflowTotal));
    out.add(String(Math.max(0, (shape.tradeSheet?.employments?.length ?? 0) - 4)));
    // Total years, summed by the mapper from the container's `duration_months`.
    const exps =
      (shape.snapshot.resume_profile as { experiences?: { duration_months: number | null }[] })
        ?.experiences ?? [];
    const totalMonths = exps.reduce((s, e) => s + (e.duration_months ?? 0), 0);
    if (totalMonths > 0) {
      out.add(String(Math.floor(totalMonths / 12)));
      out.add(String(Math.round((totalMonths / 12 - Math.floor(totalMonths / 12)) * 12)));
    }

    // ── AND THE SAME TOTAL FROM THE OTHER SOURCE (#1377) ──────────────────────────────
    //
    // A FORM-FIRST WORKER HAS NO `duration_months` AT ALL. The router can hand them the form on
    // their first message, so the universal experience question is never asked and extraction
    // never runs — while the work-history screen they then fill collects exact dated employments.
    // The headline now sums THOSE when the container's own figure is absent.
    //
    // THIS IS A WIDENING OF THE GATE, so it is deliberately narrow. It admits exactly one more
    // number — the sum over TOP-LEVEL employment spans, which is the same deterministic
    // arithmetic over stated dates that the per-employment figures above already are (§8 stage 4).
    // Role stints are excluded because they subdivide an employment the loop has already counted;
    // including them would double-count a promotion and quietly admit a number nobody can derive.
    //
    // RECOMPUTED FROM THE FIXTURE, like everything else here. Reading the mapper's own total back
    // would make the rule circular and an off-by-one would validate itself.
    const employmentMonths = (shape.tradeSheet?.employments ?? []).map((e) => {
      const end =
        e.endYm ??
        (asOf
          ? `${asOf.getUTCFullYear()}-${String(asOf.getUTCMonth() + 1).padStart(2, "0")}`
          : null);
      if (!e.durationStated || !e.startYm || !end) return null;
      return (
        (Number(end.slice(0, 4)) - Number(e.startYm.slice(0, 4))) * 12 +
        (Number(end.slice(5, 7)) - Number(e.startYm.slice(5, 7))) +
        1
      );
    });
    if (employmentMonths.length > 0 && employmentMonths.every((m) => m !== null)) {
      const months = employmentMonths.reduce((s: number, m) => s + (m ?? 0), 0);
      // The pipeline's own rounding, step for step: months → one-decimal years
      // (`totalEmployedYears`) → whole/remainder split (`yearsPhrase`). Doing the split off the
      // raw months instead would admit a different pair of digits from the one that prints.
      const years = Math.round((months / 12) * 10) / 10;
      const whole = Math.floor(years);
      out.add(String(whole));
      out.add(String(Math.round((years - whole) * 12)));
    }
    return out;
  }

  it.each(SHEET_SHAPES)("shape $n — $name", (shape) => {
    const allowed = new Set([...statedDigits(shape), ...derivedTenureDigits(shape)]);
    for (const audience of ["worker", "employer"] as const) {
      for (const text of printedStrings(shape, audience)) {
        for (const atom of atomsOf(text)) {
          // A REVIEWED LABEL'S DIGITS BELONG TO THE LABEL. "EN8 / EN31" and "±0.02 mm" are
          // closed-vocabulary entries; their numerals are a material grade and a tolerance, not
          // claims about this worker. Chrome — the generated date, the ref code — is skipped for
          // the same reason: it says nothing about him either.
          if (CLOSED_VOCABULARY.has(atom)) continue;
          if (CHROME_TEXT.some((re) => re.test(atom))) continue;
          for (const run of atom.match(/\d+/g) ?? []) {
            expect(
              allowed.has(run),
              `shape ${shape.n}/${audience}: the number ${run} in "${atom}" was never stated by ` +
                `this worker and is not arithmetic over dates they gave. §8 allows no invented ` +
                `figure.`,
            ).toBe(true);
          }
        }
      }
    }
  });

  it.each(ROAD_SHAPES)("general road $n — $name (bb_general, ADR-0045)", (shape) => {
    // The brief is not scanned here: it is licensed WHOLE above, digits included.
    const allowed = new Set([...statedDigits(shape), ...derivedTenureDigits(shape)]);
    for (const audience of ["worker", "employer"] as const) {
      for (const text of printedStrings(shape, audience, "bb_general")) {
        for (const atom of atomsOf(text)) {
          if (CLOSED_VOCABULARY.has(atom)) continue;
          if (CHROME_TEXT.some((re) => re.test(atom))) continue;
          for (const run of atom.match(/\d+/g) ?? []) {
            expect(
              allowed.has(run),
              `${shape.name}/${audience}: the number ${run} in "${atom}" was never stated. §8.`,
            ).toBe(true);
          }
        }
      }
    }
  });
});

describe("the gate itself is capable of failing", () => {
  // A gate nobody has watched fail is a comment. These pin the three fabrications it exists to
  // stop, using the SAME predicate the assertions above call.
  const shape = SHEET_SHAPES.find((s) => s.n === 5)!;
  const supplied = workerSupplied(shape);

  it("rejects an invented adjective", () => {
    expect(sourced("Highly skilled", supplied)).toBe(false);
    expect(sourced("Experienced", supplied)).toBe(false);
    expect(sourced("Hardworking", supplied)).toBe(false);
  });

  it("rejects a real value with an adjective bolted on", () => {
    // The one-directional containment, asserted directly. Reversed, all three would pass.
    expect(sourced("Skilled CNC turning", supplied)).toBe(false);
    expect(sourced("Senior Rico Auto Industries", supplied)).toBe(false);
    expect(sourced("Fanuc expert", supplied)).toBe(false);
  });

  it("rejects a raw slug that never reached the dictionary", () => {
    expect(sourced("cnc_lathe", supplied)).toBe(false);
    expect(sourced("live_tooling", supplied)).toBe(false);
  });

  it("accepts the three real sources", () => {
    expect(sourced("Fanuc", supplied)).toBe(true); // closed vocabulary
    expect(sourced("3 yrs 8 mo", supplied)).toBe(true); // composed, guideline-authorised
    expect(sourced("Rico Auto Industries", supplied)).toBe(true); // the worker's own words
  });
});

describe("the brief's licence is capable of failing (ADR-0045 §4.3)", () => {
  // The same predicate the road pass calls, pointed at the fabrications it exists to stop.
  const shapeOf = (name: string) => ROAD_SHAPES.find((s) => s.name === name)!;
  const DATED = shapeOf("road-declined");
  const FRESHER = shapeOf("road-fresher");
  const UNDATED = shapeOf("road-undated");
  const ANSWERED = shapeOf("road-answered");
  const OWN = (roadPersona("road-answered").storedBrief as { text: string }).text;

  it("accepts the lines the fixtures' own facts compose — and the cap's shorter lists", () => {
    const tail = "of experience in House wiring, Panel fitting and MCB installation.";
    expect(briefLicensed(`House Electrician with 7 yrs 4 mo ${tail}`, DATED)).toBe(true);
    expect(
      briefLicensed("House Electrician with 7 yrs 4 mo of experience in House wiring.", DATED),
    ).toBe(true);
    expect(briefLicensed("House Electrician with 7 yrs 4 mo of experience.", DATED)).toBe(true);
    expect(
      briefLicensed(
        "Fresher House Electrician with skills in House wiring and Panel fitting.",
        FRESHER,
      ),
    ).toBe(true);
    expect(briefLicensed("House Electrician with skills in House wiring.", UNDATED)).toBe(true);
    expect(briefLicensed(OWN, ANSWERED)).toBe(true);
  });

  it("refuses an adjective on the role", () => {
    expect(briefLicensed("Skilled House Electrician with 7 yrs 4 mo of experience.", DATED)).toBe(
      false,
    );
    expect(
      briefLicensed("Experienced House Electrician with skills in House wiring.", UNDATED),
    ).toBe(false);
  });

  it("refuses a fourth skill, a skill he never gave, and his skills out of order", () => {
    for (const s of [
      "House wiring, Panel fitting, MCB installation and Earthing",
      "Welding",
      "Panel fitting and House wiring",
      "House wiring, Panel fitting and Welding",
    ]) {
      expect(
        briefLicensed(`House Electrician with 7 yrs 4 mo of experience in ${s}.`, DATED),
        s,
      ).toBe(false);
    }
  });

  it("refuses a total his dates do not add up to", () => {
    for (const y of ["8 yrs", "7 yrs 5 mo", "7 yrs", "11 yrs"]) {
      expect(briefLicensed(`House Electrician with ${y} of experience.`, DATED), y).toBe(false);
    }
  });

  it('refuses "Fresher" over a worker with a job, and a total over a worker with none', () => {
    expect(briefLicensed("Fresher House Electrician with skills in House wiring.", DATED)).toBe(
      false,
    );
    expect(briefLicensed("Fresher House Electrician with skills in House wiring.", UNDATED)).toBe(
      false,
    );
    expect(briefLicensed("House Electrician with 1 yr of experience.", FRESHER)).toBe(false);
    expect(briefLicensed("House Electrician with skills in House wiring.", FRESHER)).toBe(false);
  });

  it("refuses a truncated own line, his line with words appended, and another worker's line", () => {
    expect(briefLicensed(OWN.slice(0, -10), ANSWERED)).toBe(false);
    expect(briefLicensed(`${OWN} Best worker in Faridabad.`, ANSWERED)).toBe(false);
    expect(briefLicensed(`Very good worker. ${OWN}`, ANSWERED)).toBe(false);
    // Stored for ANSWERED, printed for DATED: not his words.
    expect(briefLicensed(OWN, DATED)).toBe(false);
  });

  it('refuses the fixed line\'s filler words anywhere but the brief slot — "with skills in"', () => {
    // The atom rule is what any OTHER printed string answers to, and the fixed line fails it.
    const supplied = workerSupplied(FRESHER);
    const line =
      "Fresher House Electrician with skills in House wiring, Panel fitting and MCB installation.";
    expect(sourced(line, supplied)).toBe(false);
    expect(atomsOf(line).some((atom) => !sourced(atom, supplied))).toBe(true);
    expect(sourced("House Electrician with skills in House wiring", supplied)).toBe(false);
  });
});
