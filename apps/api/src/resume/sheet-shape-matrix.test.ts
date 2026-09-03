import { beforeAll, describe, expect, it } from "vitest";

import { primeSheetQr, SHEET_SHAPES, withSheetQr } from "./__fixtures__/sheet-shapes";
import { buildResumeRenderInput } from "./resume-render-input";
import { ResumeRenderer, type ResumeRenderInput } from "./resume-renderer.service";
import { CAPABILITY_ROW_BUDGET } from "./trade-resume-map";
import { EMPLOYMENT_BLOCK_BUDGET } from "./resume-employment-rows";
import {
  COMPRESSING_LADDER,
  SHEET_LINE_BUDGET,
  sheetContentLines,
  type DegradableSheet,
} from "./resume-degradation";

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
    expect(payer.capChipRows).toEqual(worker.capChipRows);

    // ── ZONE 4, AND WHY IT IS NOT A FLAT `toEqual` EITHER ─────────────────────────────────
    //
    // THE SAME ONE-LINE DIFFERENCE THAT DRIVES ZONE 5 BELOW, LANDING IN A DIFFERENT ZONE. It used
    // to buy the payer a Zone-5 rung; since the 2026-09-03 ruling forbade those rungs it buys the
    // payer a FIT instead. Shape 6: the payer's copy is 43.19 lines and reaches 40.19 by folding
    // a fourth employer block into the count, so it compresses and fits; the worker's copy is one
    // line longer, would still spill at 41.19, and therefore declines to pay — keeping four
    // blocks and the full aggregate count line on a sheet that spills.
    //
    // SO THE PAYER'S COPY CAN BE THE SHORTER ONE, WHICH IS THE OPPOSITE OF A LEAK, and the
    // property to assert is direction rather than equality: the payer's blocks must be a PREFIX
    // of the worker's — never a block the worker's copy does not have, never reordered — and any
    // shortfall must be explained by the ladder having spent a step, not by the disclosure rule
    // quietly acquiring a fourth omission. `collapseEmployments` slices from the front, so a
    // prefix is what a legitimate difference looks like and anything else fails here.
    const payerEmployments = payer.employments ?? [];
    const workerEmployments = worker.employments ?? [];
    expect(payerEmployments.length).toBeLessThanOrEqual(workerEmployments.length);
    expect(payerEmployments).toEqual(workerEmployments.slice(0, payerEmployments.length));
    if (payerEmployments.length < workerEmployments.length) {
      expect(
        payer.degradationDropped,
        "the payer lost an employer block with no ladder step to explain it",
      ).toContain("employers beyond three");
      // AND EVERY MISSING BLOCK IS STILL COUNTED (§11 #7). A shorter Zone 4 on the payer's copy
      // is only acceptable while it still says how many employers it stands for.
      expect(payer.employmentsMore).toMatch(/^\d+ earlier employers?/);
    }

    // ── ZONE 5, AND WHY IT IS NOT A FLAT `toEqual` ────────────────────────────────────────
    //
    // WITHHOLDING THE ASKING PRICE MAKES THE PAYER'S COPY ONE LINE SHORTER, and on the densest
    // shapes that one line used to buy it a rung of the degradation ladder the worker's own copy
    // could not afford. MEASURED, not supposed: shape 6 (nine employers, every turner question
    // answered) rendered at 40.19 lines of a 41-line page on BOTH audiences — the worker having
    // paid for his asking price with the Certificates row, at ladder stage 4 against stage 3.
    //
    // SINCE THE 2026-09-03 RULING THE DIVERGENCE NO LONGER ARISES, and the branch below is dead
    // on today's fixtures: shedding a Zone-5 row is forbidden, so no payer copy can hold a
    // qualification row its worker copy lost. On shape 6 the one line now decides something else
    // entirely — the payer's copy fits at 40.19 once a fourth employer block is folded in, so it
    // compresses (stage 1) while the worker's would still spill at 41.19, declines to pay, and
    // comes back at stage 0 with all four blocks.
    //
    // WHICH INVERTS THE STAGE COMPARISON INSIDE THE BRANCH, AND THAT IS WORTH SAYING OUT LOUD:
    // the payer's stage is now the HIGHER of the two, so if a Zone-5 rung is ever re-permitted
    // this guard must be re-derived rather than trusted as written. THE BRANCH ITSELF STAYS. It
    // is what would catch the divergence returning, and an assertion that only exists while a
    // ruling holds is exactly the kind that must not be deleted the moment the ruling quiets it.
    //
    // IT WAS THE LADDER HONOURING §5.1, NOT A DISCLOSURE DIFFERENCE. A certificate is rank 8;
    // the capability rows it is shed for are ranks 2–6, and `LADDER` drops Zone 5 before it
    // touches them. Nothing reaches the payer that the worker's own answers did not authorise —
    // his copy is the SHORTER of the two, which is the opposite of a leak.
    //
    // SO THE ASSERTION STATES THE PROPERTY INSTEAD OF THE BYTES: the payer may never be missing a
    // row the worker has (that would be the fourth omission), and any row it holds that the
    // worker's copy has shed must be one the ladder is allowed to shed and must be explained by a
    // lower degradation stage. Both directions are still closed.
    // JSON, NOT A DELIMITER CHARACTER: a separator byte that can never occur in a label or a
    // value is exactly the kind of thing `source-hygiene.test.ts` exists to keep out of source.
    const key = (row: { label: string; value: string }) => JSON.stringify([row.label, row.value]);
    const workerQual = new Set((worker.qualFactRows ?? []).map(key));
    const payerQual = new Set((payer.qualFactRows ?? []).map(key));
    const missingFromPayer = (worker.qualFactRows ?? []).filter((r) => !payerQual.has(key(r)));
    expect(missingFromPayer, "the payer is missing a qualification row the worker has").toEqual([]);
    const gainedByPayer = (payer.qualFactRows ?? []).filter((r) => !workerQual.has(key(r)));
    if (gainedByPayer.length > 0) {
      expect(
        payer.degradationStage ?? 0,
        "an extra payer row with no ladder difference",
      ).toBeLessThan(worker.degradationStage ?? 0);
      // The Zone-5 rows `LADDER` may shed, in its own order. A row outside this set appearing on
      // the payer's copy alone is a real divergence and must fail.
      expect(gainedByPayer.map((r) => r.label).sort()).toEqual(
        gainedByPayer
          .map((r) => r.label)
          .filter((l) => ["Certificates", "Education", "Languages spoken"].includes(l))
          .sort(),
      );
    }
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
    // NINE EMPLOYERS IN, FOUR BLOCKS OUT, AND ALL NINE STILL ACCOUNTED FOR — `overflowLine`'s
    // full form, aggregates included, which is the shape page 16 of the ratified corpus prints.
    //
    // THE LADDER LEAVES THIS SHEET ALONE, AND THAT IS THE 2026-09-03 RULING RATHER THAN THE
    // ABSENCE OF PRESSURE. This copy is 44.19 lines against a 41-line budget. "Employers beyond
    // three" is the only compression the ruling still permits it, and collapsing a fourth block
    // in would reach 41.19 — STILL over. So the step buys no page here, `degradeToFit` declines
    // to charge it, and the worker keeps the block and the aggregates while the sheet spills.
    // The payer's copy of the same shape is one line shorter and therefore DOES fit after the
    // collapse; it is asserted below, because the two together are the rule.
    const nine = SHEET_SHAPES.find((s) => s.n === 6)!;
    const input = inputFor(nine, "worker");
    expect(input.employments).toHaveLength(4);
    expect(input.employmentsMore).toMatch(/^5 earlier employers · \d+ months total · \d{4}–\d{4}$/);
  });

  it("collapses a fourth block only where that actually buys the page", () => {
    // THE OTHER HALF OF THE RULE, on the same fixture. Withholding the asking price makes the
    // payer's copy one line shorter, which is exactly the line that decides whether the collapse
    // is worth its price: 43.19 → 40.19 fits, so the step runs and is committed.
    //
    // THE AGGREGATES GO WHEN IT DOES, AND THAT IS THE HONESTY RULE RATHER THAN A LOSS. "· N
    // months total · YYYY–YYYY" described the FIVE employers the mapper dropped; fold a sixth in
    // and the same string is a stale total printed as if it were complete — the thing
    // `overflowLine` itself refuses to do when a dropped record has no stated duration. The
    // count, which is the whole of §11 #7's promise, survives intact.
    const nine = SHEET_SHAPES.find((s) => s.n === 6)!;
    const payer = inputFor(nine, "employer");
    expect(payer.employments).toHaveLength(3);
    expect(payer.employmentsMore).toBe("6 earlier employers");
    expect(payer.degradationDropped).toEqual(["employers beyond three"]);
    expect(payer.degradationOverflows, "the collapse must have bought the page").toBe(false);
  });

  it("never prints '1 earlier employers'", () => {
    // A PRINTED GRAMMATICAL ERROR ON A MAN'S RÉSUMÉ, and the ruling is what made it reachable:
    // shape 5's payer copy keeps three of four employers and lands on exactly one. Pinned here
    // rather than in the unit test because this is the file that renders the string a reader sees.
    // The WORKER copy of the same shape spills instead of collapsing, so it never forms the line.
    const four = SHEET_SHAPES.find((s) => s.n === 5)!;
    expect(inputFor(four, "employer").employmentsMore).toBe("1 earlier employer");
    expect(inputFor(four, "worker").employments).toHaveLength(4);
  });
});

/**
 * THE ONE-PAGE INVARIANT, AS THE 2026-09-03 OWNER RULING RESTATED IT.
 *
 * It used to read "every sheet fits one page", full stop, and the ladder guaranteed it by shedding
 * whatever was needed. The ruling narrowed that: "the ladder still compresses as hard as it can —
 * but when a sheet STILL will not fit, it SPILLS ONTO PAGE 2 instead of shedding a ratified row."
 *
 * SO THE INVARIANT IS RESTATED, NOT DROPPED. Deleting it would leave nothing at all watching the
 * page, and a sheet that doubles in length for an unrelated reason would pass in silence. What is
 * asserted instead is the ruling itself, in four parts: a spilling sheet must be one that NO
 * permitted compression could have saved, it must be handed over UNCOMPRESSED, it must SAY that
 * it spilled, and it must never need a third page.
 *
 * THE FIRST TWO ARE A PAIR, AND THEY BITE IN OPPOSITE DIRECTIONS. "No compression could have
 * saved it" fails if the ladder stops early — a sheet spilling with room left to shrink. "Handed
 * over uncompressed" fails if the ladder charges a worker an employer block for a page it did not
 * buy, which is what shipped before `degradeToFit` was made to discard a fruitless compression.
 * Asserting only one of them passes a ladder that is wrong in the other direction.
 */
describe("one page unless preserving a ratified row required two", () => {
  // BUILT INSIDE EACH TEST, not at collection time: the QR is primed in `beforeAll`, and a sheet
  // measured without it is ~18 mm shorter than the one production prints — which is most of the
  // margin these assertions are about.
  const everySheet = () =>
    SHEET_SHAPES.flatMap((shape) =>
      (["worker", "employer"] as const).map((audience) => ({
        label: `shape ${shape.n}/${audience}`,
        input: inputFor(shape, audience),
      })),
    );

  it("reports a spill rather than leaving it silent", () => {
    // The flag has to MEAN the measurement, or every consumer downstream is reading a decoration.
    for (const { label, input } of everySheet()) {
      const over = sheetContentLines(input) > SHEET_LINE_BUDGET;
      expect(input.degradationOverflows, `${label}: flag disagrees with the line model`).toBe(over);
      expect(Boolean(input.degradationOverBudgetLines), `${label}: magnitude`).toBe(over);
    }
  });

  it("spills only where NO permitted compression could have bought the page", () => {
    // THE ASSERTION THAT REPLACES "IT FITS". Running the whole compressing ladder over a sheet
    // that came back overflowing must still leave it over budget. If it lands inside, the ladder
    // stopped early and the second page was never forced by content preservation at all.
    //
    // MONOTONE, WHICH IS WHY APPLYING ALL OF THEM SETTLES IT. Every permitted step only shortens
    // the sheet, so "all of them together do not fit" implies no subset of them fits either —
    // this one probe therefore covers every ordering the ladder could have taken.
    for (const { label, input } of everySheet()) {
      if (!input.degradationOverflows) continue;
      const probe = JSON.parse(JSON.stringify(input)) as DegradableSheet;
      for (const step of COMPRESSING_LADDER) step.apply(probe);
      expect(
        sheetContentLines(probe),
        `${label}: spilled although compression would have fitted it`,
      ).toBeGreaterThan(SHEET_LINE_BUDGET);
    }
  });

  it("hands a spilling sheet back UNCOMPRESSED, charging nothing for a page it did not buy", () => {
    // THE COUNTERPART, and the one that catches the regression this file was written against. A
    // compression is a real cost — `collapseEmployments` turns an employer's name, dates and work
    // line into a bare count and strips the count's aggregates — and the 2026-09-03 ruling makes
    // content preservation outrank page count. A sheet that spills anyway has bought nothing with
    // that cost, so it must not have paid it: stage 0, nothing dropped, nothing traced.
    for (const { label, input } of everySheet()) {
      if (!input.degradationOverflows) continue;
      expect(input.degradationStage, `${label}: paid for a page it did not get`).toBe(0);
      expect(input.degradationDropped, `${label}: dropped something for nothing`).toEqual([]);
    }
  });

  it("compresses whenever compression DOES buy the page", () => {
    // Without this, "hand a spilling sheet back uncompressed" is satisfied by a ladder that never
    // runs. Shape 6's payer copy is 43.19 lines and fits at 40.19 once a fourth employer block is
    // folded in, so the ladder must spend that step — the ruling narrowed the ladder, it did not
    // switch it off.
    const fitted = everySheet().filter(
      (s) => !s.input.degradationOverflows && (s.input.degradationStage ?? 0) > 0,
    );
    expect(fitted.map((s) => s.label)).toEqual(["shape 5/employer", "shape 6/employer"]);
    for (const { label, input } of fitted) {
      expect(input.degradationDropped, `${label}`).toEqual(["employers beyond three"]);
    }
  });

  it("never needs a THIRD page", () => {
    // The ruling bought ONE page, not an unbounded document. A sheet that runs past two pages is
    // not preserving a ratified row any more; it is a mapper defect wearing the ruling's clothes.
    for (const { label, input } of everySheet()) {
      expect(input.degradationOverBudgetLines ?? 0, `${label}: past a second page`).toBeLessThan(
        SHEET_LINE_BUDGET,
      );
    }
  });

  it("names the shapes that spill, so a new one cannot appear unnoticed", () => {
    // PINNED, exactly as `the five overflow shapes` pins its own list. "Overflow" there means
    // "supplies more content than a budget holds"; spilling means "the page could not be bought
    // back without deleting a ratified row", and the two sets are deliberately different — shapes
    // 8 and 11 supply too much and still compress onto one page.
    const spilling = everySheet()
      .filter((s) => s.input.degradationOverflows)
      .map((s) => s.label);
    expect(spilling).toEqual([
      // 2.19 and 3.19 lines over. Each is one line past what its collapsed form would have
      // reached (41.19), which is why neither pays for the collapse — see the two assertions
      // above. The employer's copy of each is one line shorter (no asking price), which is
      // exactly enough for the same collapse to fit it, so neither payer copy appears here.
      "shape 5/worker",
      "shape 6/worker",
      // 2.93 and 1.93 lines over, from the wrapped 18pt name (§11 #9) on both audiences. This
      // shape has three employers and nothing else the ladder may touch, so it cannot compress at
      // all. It used to be bought back by shedding Zone 5; under the ruling the rows stay.
      "shape 9/worker",
      "shape 9/employer",
    ]);
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
    //
    // THAT MEASUREMENT PREDATES THE 2026-09-03 RULING AND NO LONGER DESCRIBES WHAT SHIPS. It was
    // taken on a sheet the old ladder had already stripped of its Zone 5 rows to buy the page;
    // with those rows preserved this shape comes back 2.93 lines over on the worker copy and 1.93
    // on the payer's, and `names the shapes that spill` pins both. What the measurement still
    // proves is the half this test asserts — that 18pt is worth ~2.9 lines against 20pt, so
    // dropping the auto-fit would make the spill far worse. Shape 9 is one of the sheets the
    // Docker render named in `templates/README.md` must re-measure before release.
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
