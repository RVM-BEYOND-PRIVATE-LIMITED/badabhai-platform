import { beforeAll, describe, expect, it } from "vitest";

import { primeSheetQr, SHEET_SHAPES, withSheetQr } from "./__fixtures__/sheet-shapes";
import { buildResumeRenderInput } from "./resume-render-input";
import { ResumeRenderer, type ResumeRenderInput } from "./resume-renderer.service";
import { CAPABILITY_ROW_BUDGET } from "./trade-resume-map";
import { EMPLOYMENT_BLOCK_BUDGET } from "./resume-employment-rows";

/**
 * THE CONTENT-SHAPE MATRIX. All fourteen shapes, both audiences, end to end.
 *
 * WHY IT EXISTS. Every budget on this sheet was measured against the three ratified sample
 * résumés, and all three are well-formed and mid-length. A budget that holds only against the
 * design's own examples has been checked against the easy cases and nothing else. Shapes 5, 6,
 * 8, 9 and 11 were built specifically to break it — a fully-answered pack, nine employers, a
 * name that wraps, a full credentials block, overseas history.
 *
 * WHAT THIS FILE CAN AND CANNOT PROVE. It proves the CONTENT budgets, which is where the
 * guideline puts the one-page rule ("if a sheet overflows, the mapper is wrong, not the CSS").
 * It cannot measure a page: that needs WeasyPrint, which is Docker-only here. The Docker render
 * is a separate, manual evidence step recorded in docs/resume-engine-r1-journal.md, and the two
 * together are what "one page" is verified by.
 */

const renderer = new ResumeRenderer({} as never);

/**
 * THE QR IS PART OF THE PAGE, so it is part of every measurement in this file.
 *
 * Rendering these shapes without it collapses an 18 mm box out of the footer — the one section
 * that was overflowing — and every "fits" result would be taken against a shorter page than the
 * one production prints.
 */
beforeAll(primeSheetQr);

function inputFor(shape: (typeof SHEET_SHAPES)[number], audience: "worker" | "employer") {
  return buildResumeRenderInput(
    shape.snapshot,
    shape.displayName,
    "bb_trade",
    null,
    false,
    audience,
    withSheetQr(shape.tradeSheet),
  );
}

/**
 * The text a reader actually sees: `<body>` only, tags and comments removed, entities decoded.
 *
 * SCANNING THE WHOLE FILE IS THE WRONG TEST and fails against a correct template. The header
 * comment explains the honesty rules by quoting them, and the stylesheet is full of
 * `display: none` — neither is a placeholder on anybody's résumé.
 */
function printedText(html: string): string {
  const body = /<body>([^]*)<\/body>/.exec(html)?.[1] ?? "";
  return body
    .replace(/<!--[^]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#8220;|&#8221;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

/** Row counts per zone, the units the budgets are expressed in. */
function zoneCounts(input: ResumeRenderInput) {
  return {
    capability:
      (input.capChipRows?.length ?? 0) +
      (input.capTickRows?.length ?? 0) +
      (input.capFactRows?.length ?? 0),
    availability: input.availFactRows?.length ?? 0,
    qualification: (input.qualFactRows?.length ?? 0) + (input.qualTickRows?.length ?? 0),
    employments: input.employments?.length ?? 0,
    experiences: input.experiences.length,
  };
}

describe.each(SHEET_SHAPES)("shape $n — $name", (shape) => {
  it(`renders on both audiences (${shape.clause})`, () => {
    for (const audience of ["worker", "employer"] as const) {
      const html = renderer.buildResumeHtml(inputFor(shape, audience));
      expect(html).toContain("<html");
      // No unresolved slot may reach a printed page. `{{` surviving means a token the mapper
      // never filled, which prints as literal mustache on a worker's résumé.
      expect(html, `shape ${shape.n}/${audience} leaked a slot`).not.toMatch(/\{\{|\}\}/);
      expect(html).not.toMatch(/undefined|\[object Object\]|NaN/);
    }
  });

  it("holds every zone budget", () => {
    const counts = zoneCounts(inputFor(shape, "worker"));
    expect(counts.capability, "capability rows").toBeLessThanOrEqual(CAPABILITY_ROW_BUDGET);
    expect(counts.employments, "employer blocks").toBeLessThanOrEqual(EMPLOYMENT_BLOCK_BUDGET);
  });

  it("renders ONE work-history source, never both", () => {
    // The template holds both regions in one section. Populating both prints every job twice —
    // once dated with its employer, once as a bare role with the worker's own words.
    const counts = zoneCounts(inputFor(shape, "worker"));
    expect(counts.employments === 0 || counts.experiences === 0).toBe(true);
  });

  it("withholds exactly three things from the payer", () => {
    // Real name, photo, expected salary. Everything else — capability, terms, work history,
    // shift — is what the payer unlocked. A fourth omission or a third leak both fail here.
    const worker = inputFor(shape, "worker");
    const payer = inputFor(shape, "employer");
    expect(payer.photoDataUri).toBeNull();
    expect(payer.expectedSalary).toBeNull();
    expect(payer.nameDevanagari).toBeNull();
    expect(payer.employments).toEqual(worker.employments);
    expect(payer.capChipRows).toEqual(worker.capChipRows);
    expect(payer.qualFactRows).toEqual(worker.qualFactRows);
    // The phone crosses by owner ruling 2026-08-28 — asserted, not assumed.
    expect(payer.phone).toBe(worker.phone);
  });
});

describe("the five overflow shapes", () => {
  const overflow = SHEET_SHAPES.filter((s) => s.overflow);

  it("are shapes 5, 6, 8, 9 and 11", () => {
    // Pinned so a future edit cannot quietly reclassify a stress case as an ordinary one and
    // leave the budgets checked against fourteen easy profiles again.
    expect(overflow.map((s) => s.n)).toEqual([5, 6, 8, 9, 11]);
  });

  it("each genuinely EXCEEDS a budget before truncation — otherwise they prove nothing", () => {
    // THE POINT OF THE MATRIX. A "stress" fixture that fits under the budget on its own is not
    // a stress fixture; it would pass every assertion above while testing the easy path. Each of
    // these must supply more than the page holds, so the truncation is what is being measured.
    for (const shape of overflow) {
      const supplied =
        Object.keys(shape.tradeSheet?.attributes ?? {}).length +
        (shape.tradeSheet?.employments?.length ?? 0);
      const rendered = zoneCounts(inputFor(shape, "worker"));
      expect(
        supplied > CAPABILITY_ROW_BUDGET ||
          (shape.tradeSheet?.employments?.length ?? 0) > EMPLOYMENT_BLOCK_BUDGET,
        `shape ${shape.n} does not overflow anything`,
      ).toBe(true);
      expect(rendered.capability).toBeLessThanOrEqual(CAPABILITY_ROW_BUDGET);
    }
  });

  it("counts the employers it dropped rather than dropping them silently (§11 #7)", () => {
    const nine = SHEET_SHAPES.find((s) => s.n === 6)!;
    const input = inputFor(nine, "worker");
    expect(input.employments).toHaveLength(4);
    expect(input.employmentsMore).toMatch(/^5 earlier employers · \d+ months total · \d{4}–\d{4}$/);
  });
});

describe("shapes the guideline rules on by name", () => {
  it("#1 — a fresher's History heading is never empty", () => {
    // The section collapses ENTIRELY rather than printing a heading over nothing. Zone 4 is
    // reserved for training and workshop machines once those have a source; an empty heading is
    // the one outcome the ruling forbids outright.
    const fresher = SHEET_SHAPES.find((s) => s.n === 1)!;
    const html = renderer.buildResumeHtml(inputFor(fresher, "worker"));
    expect(html).toContain('<div class="sec sec-work"></div>');
  });

  it("#2 — twelve years and no ITI flags nothing", () => {
    // "Frequently our most valuable worker and the worst-looking resume under conventional
    // rules … never flag the missing credential." The section simply has no Education row.
    const veteran = SHEET_SHAPES.find((s) => s.n === 2)!;
    const input = inputFor(veteran, "worker");
    expect(input.qualFactRows?.map((r) => r.label)).toEqual(["Languages spoken"]);
    // THE BODY ONLY. Scanning the whole file matches the template's own prose and its CSS —
    // `display: none` is not a placeholder on anybody's résumé — so this asserts against what
    // actually prints, which is also the only thing the ruling is about.
    expect(printedText(renderer.buildResumeHtml(input))).not.toMatch(
      /not provided|\bnone\b|\bN\/A\b|no education|no ITI|unqualified/i,
    );
  });

  it("#8 — a single-token name renders exactly as given", () => {
    const single = SHEET_SHAPES.find((s) => s.n === 10)!;
    expect(inputFor(single, "worker").displayName).toBe("Ramesh");
  });

  it("#9 — a very long name auto-fits to the 18pt floor and is never truncated", () => {
    // "Auto-fit down to the 18pt floor, then wrap to two lines. Never truncate a person's name."
    // The auto-fit half was missing, and it is not cosmetic: MEASURED in WeasyPrint, shape 9's
    // worker copy rendered TWO PAGES at 20pt and one page at 18pt.
    const long = SHEET_SHAPES.find((s) => s.n === 9)!;
    const html = renderer.buildResumeHtml(inputFor(long, "worker"));
    expect(html).toContain("Venkataramanan Subrahmanya Krishnamurthy Iyengar");
    expect(html).not.toContain("…");
    expect(html, "a long name did not auto-fit").toContain('<h1 class="fit">');
  });

  it("#9 — an ordinary name keeps the full 20pt, so the fit is not applied to everyone", () => {
    // The half that makes the assertion above mean something: a rule that always fires is not a
    // fit, it is just a smaller heading.
    const ordinary = SHEET_SHAPES.find((s) => s.n === 2)!; // "Ramesh Kumar Yadav"
    expect(renderer.buildResumeHtml(inputFor(ordinary, "worker"))).toContain('<h1 class="">');
  });

  it("#9 — 18pt is the FLOOR: no smaller size exists anywhere in the sheet's headings", () => {
    // The failure this stops is the obvious next move when a sheet overflows — add a third,
    // smaller step. §6.3 makes 18pt a hard floor, and nothing may scale type to fit.
    const css = renderer.buildResumeHtml(inputFor(SHEET_SHAPES[0]!, "worker"));
    const h1Sizes = [...css.matchAll(/h1(?:\.\w+)?\s*\{[^}]*font-size:\s*([\d.]+)pt/g)].map((m) =>
      Number(m[1]),
    );
    expect(h1Sizes.length).toBeGreaterThanOrEqual(2);
    expect(Math.min(...h1Sizes)).toBeGreaterThanOrEqual(18);
  });

  it("#11 / #16 — an off-pack trade still gets a full résumé", () => {
    // "This is the entire resume-first thesis and it must never be gated." The capability
    // section collapses because no map exists; everything else renders.
    const offPack = SHEET_SHAPES.find((s) => s.n === 13)!;
    const input = inputFor(offPack, "worker");
    expect(input.capSectionTitle).toBeNull();
    expect(input.headlineLine).toBeTruthy();
    expect(input.experiences.length).toBeGreaterThan(0);
  });

  it("§6.3 — a name-only profile prints no placeholder text anywhere", () => {
    const bare = SHEET_SHAPES.find((s) => s.n === 14)!;
    const html = renderer.buildResumeHtml(inputFor(bare, "worker"));
    expect(html).toContain("Kamla Devi");
    // Every data-driven container collapsed. The five section containers are all present in the
    // skeleton and all must be empty.
    expect(html.match(/<div class="sec [a-z-]+[^>]*><\/div>/g) ?? []).toHaveLength(5);
  });
});
