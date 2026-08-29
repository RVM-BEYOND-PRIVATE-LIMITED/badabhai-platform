import { beforeAll, describe, expect, it } from "vitest";

import { primeSheetQr, SHEET_SHAPES, withSheetQr } from "./__fixtures__/sheet-shapes";

// Render exactly what the other suites render. The QR is an attribute rather than printed
// text, so it changes nothing this gate reads — which is itself worth having asserted.
beforeAll(primeSheetQr);
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
  "Languages spoken",
  "Documents ready",
  "Duration not stated",
  "Present",
];

const CLOSED_VOCABULARY: ReadonlySet<string> = new Set([...DICTIONARY, ...SHEET_LABELS]);

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
];

/** Chrome: the masthead, the footer and the fixed disclaimer. Not worker content, not a claim. */
const CHROME_TEXT: readonly RegExp[] = [
  /^BadaBhai$/,
  /^Scan to open this worker's live profile$/,
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

/** Every string this render puts on the page, before the template wraps it in markup. */
function printedStrings(shape: (typeof SHEET_SHAPES)[number], audience: "worker" | "employer") {
  const input = buildResumeRenderInput(
    shape.snapshot,
    shape.displayName,
    "bb_trade",
    null,
    false,
    audience,
    withSheetQr(shape.tradeSheet),
  );
  const out: string[] = [];
  const push = (v: string | null | undefined) => {
    if (v && v.trim()) out.push(v.trim());
  };
  push(input.headlineLine);
  push(input.subheadLine);
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
  return supplied.some((said) => said.includes(atom));
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
    const salary = (shape.snapshot.resume_profile as { expected_salary?: number } | undefined)
      ?.expected_salary;
    if (salary) {
      digits.add(String(salary));
      for (const g of new Intl.NumberFormat("en-IN").format(salary).split(",")) digits.add(g);
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
