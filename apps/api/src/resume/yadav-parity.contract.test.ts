import { describe, expect, it } from "vitest";

import { buildEmploymentBlock, type WorkerEmploymentRecord } from "./resume-employment-rows";
import { buildQualificationRows, buildVerdictLine } from "./resume-sheet-rows";
import { buildSheetFooterMeta } from "./resume-sheet-footer";
import { buildTradeCapabilityRows } from "./trade-resume-map";
import { ResumeRenderer } from "./resume-renderer.service";
import { buildResumeRenderInput } from "./resume-render-input";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════
 * THE YADAV PARITY CONTRACT (R9 §6) — the eight render rules the ratified sheet displays,
 * asserted one by one against the shipped mapper and the shipped template.
 * ══════════════════════════════════════════════════════════════════════════════════════
 *
 * THE TARGET. `Ramesh-Kumar-Yadav_VMC-Setter-cum-Operator_Faridabad_BadaBhai.pdf` — a real CNC
 * turner's sheet has to sit beside it and read as the same document with different trade content.
 * Q8 ratified STRUCTURAL and DENSITY parity, not identical rows: same zones, same order, same
 * typography, same one-page density, same absence of holes — with Zone 2 carrying the rows that
 * are decisive for turning rather than the ones decisive for milling.
 *
 * WHY SOME OF THESE ARE `it.fails` AND THAT IS DELIBERATE.
 *
 * Five of the eight rules do not hold today. Writing them as `it.todo` would make them a note
 * nothing enforces; deleting them would lose the specification; asserting them as `it` would
 * leave the suite red and unmergeable. `it.fails` is the honest third option: the test RUNS, the
 * assertion is real and executable, and the suite is green — but the moment someone implements
 * the rule the test goes RED and forces them to flip `it.fails` to `it`. The gap cannot rot into
 * a stale doc row, because the gap is the assertion.
 *
 * Each `it.fails` names exactly what is absent and where it would have to land. That list IS the
 * §2 gap table's executable half, and the two must agree — docs/profiling/yadav-parity-gap.md.
 *
 * VERBATIM FROM THE SAMPLE. Every expected string below is quoted from the extracted PDF text,
 * not paraphrased. Where the sample and our output differ, the difference is the finding.
 */

/** The Sandhar block — one employer, TWO dated roles. §11 #14, and the sample's hardest case. */
const PROMOTION: WorkerEmploymentRecord = {
  employer: "Sandhar Technologies Ltd",
  employerCity: "Gurugram",
  employerState: "Haryana",
  startYm: "2023-01",
  endYm: null,
  durationStated: true,
  roles: [
    {
      roleLabel: "VMC Setter-cum-Operator",
      startYm: "2024-07",
      endYm: null,
      workDone: "VMC 3 & 4-axis, Fanuc · EN8, EN31 · automotive components",
    },
    {
      roleLabel: "VMC Operator",
      startYm: "2023-01",
      endYm: "2024-06",
      workDone: "VMC 3 & 4-axis, Fanuc · EN8, EN31 · automotive components",
    },
  ],
};

/** The Amtek block — one employer, ONE role. The sample puts role and detail on one line. */
const SINGLE_ROLE: WorkerEmploymentRecord = {
  employer: "Amtek Auto Components Ltd",
  employerCity: "Faridabad",
  employerState: "Haryana",
  startYm: "2020-09",
  endYm: "2022-12",
  durationStated: true,
  roles: [
    {
      roleLabel: "VMC Operator",
      startYm: null,
      endYm: null,
      workDone: "VMC 3-axis Siemens, SPM · MS, aluminium",
    },
  ],
};

const AS_OF = new Date("2026-08-27T00:00:00Z");

describe("R9 §6 rule 1 — role and detail placement", () => {
  it("multi-role breaks the employer line, indents the roles, then prints the detail line", () => {
    // The sample's Sandhar block:
    //   Sandhar Technologies Ltd · Gurugram, Haryana        Jan 2023 – Present · 3 yrs 6 mo
    //       VMC Setter-cum-Operator  ·  Jul 2024 – Present · 2 yrs
    //       VMC Operator             ·  Jan 2023 – Jun 2024 · 1 yr 6 mo
    //       VMC 3 & 4-axis, Fanuc · EN8, EN31 · automotive components
    const { employments } = buildEmploymentBlock([PROMOTION], { asOf: AS_OF });
    const emp = employments[0]!;
    expect(emp.role_inline, "a promotion must NOT collapse onto the employer line").toBe("");
    expect(emp.roles.map((r) => r.role)).toEqual(["VMC Setter-cum-Operator", "VMC Operator"]);
    // Each role carries its OWN range — that is the entire progression signal.
    expect(emp.roles[0]!.when).toContain("Jul 2024");
    expect(emp.roles[1]!.when).toContain("Jan 2023 – Jun 2024");
    expect(emp.work).toBe("VMC 3 & 4-axis, Fanuc · EN8, EN31 · automotive components");
  });

  it.fails("single-role puts the role and the detail on ONE line, below the employer", () => {
    // THE SAMPLE:
    //   Amtek Auto Components Ltd · Faridabad, Haryana      Sep 2020 – Dec 2022 · 2 yrs
    //       VMC Operator  ·  VMC 3-axis Siemens, SPM · MS, aluminium
    //
    // OURS: the role is appended to the EMPLOYER line as `role_inline` (" — VMC Operator") and
    // the detail gets its own line. Same line count, same information, different placement.
    //
    // AND THE DIFFERENCE WAS MEASURED, NOT CARELESS. `toEmployment`'s comment records that with
    // one role line per employment, content shapes 5, 6 and 9 rendered TWO PAGES — the content
    // fit and the FOOTER did not. Moving the lone role onto the employer line is what bought the
    // millimetre back. So this is not a bug to fix in isolation: it is coupled to the line
    // budget, and R9 §5's re-fit is what decides whether the sample's shape is affordable.
    const { employments } = buildEmploymentBlock([SINGLE_ROLE], { asOf: AS_OF });
    const emp = employments[0]!;
    expect(emp.role_inline).toBe("");
    expect(emp.roles).toHaveLength(1);
    expect(emp.roles[0]!.role).toBe("VMC Operator · VMC 3-axis Siemens, SPM · MS, aluminium");
  });
});

describe("R9 §6 rule 2 — where the months sit", () => {
  it("puts the employer total on the employer line and per-role months on the role lines", () => {
    const { employments } = buildEmploymentBlock([PROMOTION], { asOf: AS_OF });
    const emp = employments[0]!;
    expect(emp.when).toBe("Jan 2023 – Present · 3 yrs 8 mo");
    expect(emp.roles[0]!.when).toBe("Jul 2024 – Present · 2 yrs 2 mo");
    expect(emp.roles[1]!.when).toBe("Jan 2023 – Jun 2024 · 1 yr 6 mo");
  });

  it("right-aligns the employer dates in the rendered HTML", () => {
    // Structural rather than pixel-level: `.emp-head` is a flex row with space-between and the
    // date span is its last child, which is what right-alignment IS in this layout.
    const renderer = new ResumeRenderer(null as never);
    const html = renderer.buildResumeHtml({
      templateId: "bb_trade",
      displayName: "Ramesh Kumar Yadav",
      canonicalRole: null,
      location: null,
      experienceYears: null,
      availability: null,
      summary: null,
      skills: [],
      machines: [],
      controllers: [],
      educationLevel: null,
      educationField: null,
      education: [],
      certifications: [],
      responsibilities: [],
      trade: null,
      experiences: [],
      preferredLocations: [],
      expectedSalary: null,
      employments: buildEmploymentBlock([PROMOTION], { asOf: AS_OF }).employments,
    });
    expect(html).toContain("justify-content: space-between");
    // The date span closes the head row — nothing may follow it inside `.emp-head`.
    expect(html).toMatch(/<span class="emp-when">[^<]*<\/span><\/div>/);
  });
});

describe("R9 §6 rule 3 — configuration appends to the machine chip", () => {
  it.fails('renders "VMC · 3-axis", not "VMC" and a separate axis row', () => {
    // THE SAMPLE:  Machines    VMC · 3-axis | VMC · 4-axis | SPM
    //
    // MISSING LINK: `buildTradeCapabilityRows` iterates ONE attribute's `values` dictionary per
    // row (trade-resume-map.ts). There is no mechanism for a row to append a SECOND attribute's
    // value to each of its chips, so the axis capability — which the turner pack captures as its
    // own key — can only ever be its own row or nothing.
    //
    // WHERE IT WOULD LAND: a `configFrom` field on `TradeRowSpec`, read inside the chip loop.
    const rows = buildTradeCapabilityRows("qp_cnc_turning", {
      turning_machine: ["cnc_lathe"],
      turning_configuration: ["bar_fed"],
    });
    const machines = rows.chipRows.find((r) => r.label === "Machines");
    expect(machines?.values.some((v) => v.includes(" · "))).toBe(true);
  });
});

describe("R9 §6 rule 4 — the Verdict Line compresses adjacent axes", () => {
  it.fails('appends "3 & 4-axis" as a fourth segment', () => {
    // THE SAMPLE:
    //   VMC Setter-cum-Operator · 8 yrs · Fanuc, Siemens, Mitsubishi · 3 & 4-axis
    //
    // MISSING LINK: `buildVerdictLine` composes exactly three segments — role, years, tools —
    // and has no axis parameter at all. The compression ("3-axis" + "4-axis" → "3 & 4-axis") has
    // no implementation anywhere either.
    const line = buildVerdictLine({
      role: "VMC Setter-cum-Operator",
      years: 8,
      tools: ["Fanuc", "Siemens", "Mitsubishi"],
      city: "Faridabad",
      availability: "15 days",
      salary: null,
    });
    expect(line.headlineLine).toBe(
      "VMC Setter-cum-Operator · 8 yrs · Fanuc, Siemens, Mitsubishi · 3 & 4-axis",
    );
  });

  it("does cap the controllers at three, which the sample also does", () => {
    const line = buildVerdictLine({
      role: "R",
      years: 8,
      tools: ["Fanuc", "Siemens", "Mitsubishi", "Haas"],
      city: null,
      availability: null,
      salary: null,
    });
    expect(line.headlineLine).toContain("Fanuc, Siemens, Mitsubishi");
    expect(line.headlineLine).not.toContain("Haas");
  });
});

describe("R9 §6 rule 5 — certificates carry issuer, city and year", () => {
  it.fails('renders "Name (Issuer, City, Year)" joined by a middot', () => {
    // THE SAMPLE:
    //   Certificates  CNC / VMC Programming & Setting (RVM CAD, Faridabad, 2021)
    //                 · Fire & Safety Awareness (Sandhar Technologies Ltd, 2023)
    //
    // MISSING LINK: `certifications` is a `string[]` on DraftProfileSchema — one opaque label per
    // certificate with no issuer, city or year field to put anywhere. `buildQualificationRows`
    // joins the strings and can only print what it is given. The composition rule is not the
    // problem; the SHAPE is. Structured rows are a contract change (a joint TS + Python + fixture
    // PR), which is why this is a gap-table row rather than an edit.
    const rows = buildQualificationRows({
      educationHeadline: null,
      education: [],
      certifications: ["CNC / VMC Programming & Setting", "Fire & Safety Awareness"],
      languages: [],
    });
    expect(rows.find((r) => r.label === "Certificates")?.value).toBe(
      "CNC / VMC Programming & Setting (RVM CAD, Faridabad, 2021) · " +
        "Fire & Safety Awareness (Sandhar Technologies Ltd, 2023)",
    );
  });
});

describe("R9 §6 rule 6 — education is four components plus the institute's city", () => {
  it("composes level, trade, council, year and institute into one line", () => {
    // R9 §3 BUILT THE THREE MISSING COMPONENTS. The level and the trade are interview answers
    // riding the crosswalk; the council, year and institute are the finishing form's, because a
    // closed council set is the only way §4.5's "never collapse NCVT and SCVT" is enforceable —
    // before this, nothing in the system could even represent the distinction.
    const input = buildResumeRenderInput(
      { education_level: "iti_diploma", education_field: "Machinist" },
      "Ramesh Kumar Yadav",
      "bb_trade",
      null,
      false,
      "worker",
      {
        packId: "qp_cnc_turning",
        attributes: {
          education_council: "ncvt",
          education_year: 2018,
          education_institute: "Govt. ITI, Faridabad",
        },
      },
    );
    // NOTE THE LEVEL LABEL: "ITI ya diploma", not "ITI". See the language-conflict test below —
    // this assertion pins what the code ACTUALLY prints, so the conflict is visible rather than
    // hidden behind an expectation nobody reads.
    expect(input.qualFactRows?.find((r) => r.label === "Education")?.value).toBe(
      "ITI ya diploma — Machinist · NCVT · 2018 · Govt. ITI, Faridabad",
    );
  });

  it("drops each absent segment WITH its separator", () => {
    // A worker who gave only the council must not get "ITI · NCVT ·  · ".
    const input = buildResumeRenderInput(
      { education_level: "iti_diploma" },
      "R",
      "bb_trade",
      null,
      false,
      "worker",
      { packId: "qp_cnc_turning", attributes: { education_council: "scvt" } },
    );
    const value = input.qualFactRows?.find((r) => r.label === "Education")?.value;
    expect(value).toBe("ITI ya diploma · SCVT");
    expect(value).not.toMatch(/·\s*·/);
  });

  it("keeps NCVT and SCVT distinct, which §4.5 requires and nothing could do before", () => {
    const of = (council: string) =>
      buildResumeRenderInput({ education_level: "iti_diploma" }, "R", "bb_trade", null, false, "worker", {
        packId: "qp_cnc_turning",
        attributes: { education_council: council },
      }).qualFactRows?.find((r) => r.label === "Education")?.value;
    expect(of("ncvt")).toContain("NCVT");
    expect(of("scvt")).toContain("SCVT");
    expect(of("ncvt")).not.toBe(of("scvt"));
  });

  it.fails("prints the education LEVEL in English, as the rest of Zone 5 does", () => {
    // A REAL CONFLICT BETWEEN TWO REASONED DECISIONS, sitting on one row of the sheet.
    //
    //   `KNOWN_EDUCATION_LEVELS` prints the pack's own Hinglish chip label — "ITI ya diploma",
    //   "Dasvi paas", "Barhvi paas" — and its comment argues the résumé should say back to the
    //   worker the words he tapped. #963 names "10th se kam" explicitly and `education_label.dart`
    //   shows the same string in the app.
    //
    //   `worker-preferences.vocabulary.ts` prints ENGLISH and says why: "this half of the sheet is
    //   read by a hiring supervisor".
    //
    // Both are on the SAME LINE: "ITI ya diploma — Machinist · NCVT · 2018 · Govt. ITI". The
    // ratified sheet settles it in English ("ITI — Machinist · NCVT · 2018 · Govt. ITI,
    // Faridabad") — but flipping it changes every existing résumé, contradicts a named issue, and
    // would make the app and the PDF disagree for the one population that currently agrees. It is
    // an owner ruling, not an edit, and it is recorded here rather than taken.
    const input = buildResumeRenderInput(
      { education_level: "iti_diploma", education_field: "Machinist" },
      "R",
      "bb_trade",
      null,
      false,
      "worker",
      { packId: "qp_cnc_turning", attributes: { education_council: "ncvt" } },
    );
    expect(input.qualFactRows?.find((r) => r.label === "Education")?.value).toBe(
      "ITI — Machinist · NCVT",
    );
  });

  it.fails("prints the institute's CITY as its own trailing segment", () => {
    // THE SAMPLE: "Govt. ITI, Faridabad" — institute and city. Ours stores ONE free-text
    // institute field, so a worker who types only "Govt. ITI" gets no city and nothing can
    // supply one. Splitting it into two fields is a form change with no owner ruling behind it,
    // and guessing a city from an institute name would be the derived claim §8 forbids.
    const input = buildResumeRenderInput(
      { education_level: "iti_diploma" },
      "R",
      "bb_trade",
      null,
      false,
      "worker",
      {
        packId: "qp_cnc_turning",
        attributes: { education_council: "ncvt", education_institute: "Govt. ITI" },
      },
    );
    expect(input.qualFactRows?.find((r) => r.label === "Education")?.value).toContain(
      "Govt. ITI, Faridabad",
    );
  });
});

describe("R9 §6 rule 7 — the documents row wraps with its tick prefix preserved", () => {
  it("renders every document as its own ticked item", () => {
    // The sample wraps seven documents across two lines and every one keeps its tick. Ours are
    // list items inside `ul.ticks`, so the marker is per-item by construction and a wrap cannot
    // strip it — which is exactly why it is a list row rather than a joined sentence.
    const renderer = new ResumeRenderer(null as never);
    const html = renderer.buildResumeHtml({
      templateId: "bb_trade",
      displayName: "Ramesh Kumar Yadav",
      canonicalRole: null,
      location: null,
      experienceYears: null,
      availability: null,
      summary: null,
      skills: [],
      machines: [],
      controllers: [],
      educationLevel: null,
      educationField: null,
      education: [],
      certifications: [],
      responsibilities: [],
      trade: null,
      experiences: [],
      preferredLocations: [],
      expectedSalary: null,
      qualTickRows: [
        {
          label: "Documents ready",
          values: [
            "Aadhaar",
            "PAN",
            "Bank account",
            "UAN / PF",
            "ITI certificate",
            "Experience letter",
            "Passport photos",
          ],
        },
      ],
    });
    expect(html).toContain('class="ticks"');
    for (const doc of ["Aadhaar", "PAN", "UAN / PF", "Passport photos"]) {
      expect(html).toContain(`<li>${doc}</li>`);
    }
    // The tick is a CSS marker on the item, so it survives any wrap.
    expect(html).toMatch(/\.ticks\s*>\s*li[^}]*content:/);
  });
});

describe("R9 §6 rule 8 — the verification state appears twice", () => {
  it("has a masthead slot and a footer segment, and they take the same value", () => {
    const renderer = new ResumeRenderer(null as never);
    const footer = buildSheetFooterMeta({
      generatedAt: new Date("2026-08-27T00:00:00Z"),
      trustBadge: "RVM-attested",
      refCode: "RK8M2Q",
    });
    expect(footer).toContain("RVM-attested");
    expect(footer).toContain("Ref RK8M2Q");

    const html = renderer.buildResumeHtml({
      templateId: "bb_trade",
      displayName: "Ramesh Kumar Yadav",
      canonicalRole: null,
      location: null,
      experienceYears: null,
      availability: null,
      summary: null,
      skills: [],
      machines: [],
      controllers: [],
      educationLevel: null,
      educationField: null,
      education: [],
      certifications: [],
      responsibilities: [],
      trade: null,
      experiences: [],
      preferredLocations: [],
      expectedSalary: null,
      trustBadge: "RVM-attested",
      footerMeta: footer,
    });
    // Twice on the page: the masthead's right slot and the footer meta line.
    expect(html.split("RVM-attested").length - 1).toBeGreaterThanOrEqual(2);
  });

  it.fails("is reachable for a real worker — something must be able to SET it", () => {
    // The two slots exist and both render. NOTHING CAN FILL THEM: there is no verification column
    // on `workers` or `worker_profiles`, and `resume-render.processor.ts` hardcodes
    // `trustBadge: null` with the comment "No verification tier exists in the schema yet".
    //
    // So Yadav's "RVM-attested" is unreachable for every worker in the database, and the
    // unverified state — a blank right slot — is the only state the product can currently
    // produce. That is Phase 2 by ruling 3, and it is recorded here so the slot is not mistaken
    // for a working feature.
    const source = String(buildSheetFooterMeta);
    expect(source).toContain("VERIFICATION_IS_REACHABLE");
  });
});

describe("R9 §7 — the sheet assembles end to end at Yadav's density", () => {
  it("renders all six zones for a fully-populated turner without a hole", () => {
    // Not a parity assertion — a NO-HOLES assertion. Every zone that the sample fills must be
    // non-empty when the equivalent turner data is present, because §1's acceptance test is
    // "same zones, same density, no holes" rather than "same rows".
    const input = buildResumeRenderInput(
      {
        experience: { total_years: 8 },
        education_level: "iti_diploma",
        education_field: "Turner",
        certifications: ["CNC Programming & Setting"],
        salary_expectation: { amount_min: 32000 },
        location_preference: { current_city: "Faridabad" },
        availability: { status: "notice_period", notice_period_days: 15 },
        resume_profile: {
          role_label: "CNC Setter-cum-Operator",
          skills: ["CNC turning"],
          experiences: [],
          current_city: "Faridabad",
          availability: "15_days",
          expected_salary: 32000,
        },
      },
      "Ramesh Kumar Yadav",
      "bb_trade",
      null,
      false,
      "worker",
      {
        packId: "qp_cnc_turning",
        attributes: {
          turning_machine: ["cnc_lathe", "conventional_lathe"],
          controller_brand: ["fanuc", "siemens"],
          material_worked: ["mild_steel", "alloy_steel"],
          setting_operation: ["tool_offset", "work_offset"],
          measuring_tools: ["vernier", "micrometer"],
          programming_level: ["edit_program"],
          drawing_reading: ["gdt"],
          tolerance_band: ["0.02"],
          languages: ["hindi", "english"],
          documents_ready: ["aadhaar", "pan"],
          // SCALARS, NOT ONE-ELEMENT ARRAYS, and the difference is real rather than cosmetic.
          // `answer-capture.ts:162` wraps a `multi_select` and leaves a `single_select` bare, so
          // the two land in different columns (`value_text_list` vs `value_text`) and
          // `worker-attributes.repository.ts` reads each back in its own shape.
          // `readPreferenceFacts` reads these two through `scalar()`, which correctly refuses an
          // array. The persona harness fixtures wrap every chip in an array, which is harmless
          // for the capability rows (`slugsOf` accepts both) and WRONG here — that mismatch is
          // what this fixture originally had, and it looked like a missing Shift row.
          shift_preference: "rotational",
          job_type: "permanent",
        },
        employments: [PROMOTION, SINGLE_ROLE],
        asOf: AS_OF,
        phone: "+91 98765 43210",
        qrDataUri: "data:image/png;base64,AAA",
        qrCaption: "Scan to open this worker's live profile",
        shortLink: "badabhai.ai",
        footerMeta: "Generated 27 August 2026 · Self-declared · Ref RK8M2Q",
      },
    );

    // Zone 1
    expect(input.headlineLine).toContain("8 yrs");
    expect(input.subheadLine).toContain("Faridabad");
    expect(input.phone).toBe("+91 98765 43210");
    // Zone 2
    expect(input.capSectionTitle).toBeTruthy();
    expect((input.capChipRows?.length ?? 0) + (input.capTickRows?.length ?? 0)).toBeGreaterThan(3);
    expect(input.capFactRows?.some((r) => r.label === "Tolerance held")).toBe(true);
    // Zone 3
    expect(input.availFactRows?.some((r) => r.label === "Available from")).toBe(true);
    expect(input.availFactRows?.some((r) => r.label === "Shift")).toBe(true);
    // Zone 4
    expect(input.employments).toHaveLength(2);
    // Zone 5
    expect(input.qualFactRows?.some((r) => r.label === "Education")).toBe(true);
    expect(input.qualFactRows?.some((r) => r.label === "Languages spoken")).toBe(true);
    expect(input.qualTickRows?.some((r) => r.label === "Documents ready")).toBe(true);
    // Zone 6
    expect(input.qrDataUri).toBeTruthy();
    expect(input.footerMeta).toContain("Ref RK8M2Q");
  });
});
