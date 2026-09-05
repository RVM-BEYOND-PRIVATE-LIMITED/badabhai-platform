import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

import { buildResumeRenderInput } from "./resume-render-input";
import { ResumeRenderer } from "./resume-renderer.service";
import type { WorkerEmploymentRecord } from "./resume-employment-rows";
import { buildResumeQrDataUri } from "./resume-qr";
import { RESUME_PROFILE_ORIGIN } from "./resume-sheet-footer";
import { CAPABILITY_ROW_BUDGET } from "./trade-resume-map";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════
 * R9 §7 — THE ACCEPTANCE SHEET. A turner built to Yadav's completeness, emitted for a real
 * WeasyPrint render so the two can be held side by side.
 * ══════════════════════════════════════════════════════════════════════════════════════
 *
 * HAND-AUTHORED, AND THAT IS CORRECT HERE. The five persona sheets test the EXTRACTION — they
 * start from a real model call and show what survives it. This one tests the SHEET: given a
 * turner whose every field is answered, does the layout reach Yadav's density with no holes?
 * Running it through an extraction would measure the model instead, which R7 and R8 already do.
 *
 * EVERY VALUE IS A LEGAL ONE. The chips are `qp_cnc_turning` slugs, the preference values are the
 * finishing form's vocabulary, the employments are the work-history form's shape, and the three
 * education components are the ones R9 §3 added. Nothing here is a field that cannot be captured
 * today — which is the difference between an acceptance sheet and a mock-up.
 *
 * WHY EVERY ZONE 2 ROW IS ANSWERED. A sparse fixture would fit trivially and prove nothing. The
 * turner pack defines FOURTEEN capability rows against a budget of TEN, so a fully-answered
 * worker is exactly the case R9 §5's conflict is about: the sheet that results is the one the
 * budget actually produces, not the one a convenient fixture produces.
 *
 * THIS SHEET IS ONE OF THE TWO THE 2026-09-03 RULING WAS TAKEN FOR. At the raised budget it
 * measures 41.19 lines against `SHEET_LINE_BUDGET = 41`, and every ladder step that would clear
 * those 0.19 lines deletes a row the twenty-one ratified pages print. Under the ruling it now
 * SPILLS instead — the assertions below are what stop the page being bought back with his
 * languages row, which is exactly what the old ladder did.
 *
 *   EMIT_PARITY=<dir> pnpm --filter @badabhai/api run test yadav-parity.emit
 *   docker run --rm -v "$PWD/<dir>:/w" -w /w bb-weasy:local weasyprint turner-parity.html out.pdf
 */
const OUT_DIR = process.env.EMIT_PARITY;

const AS_OF = new Date("2026-08-27T00:00:00Z");

// The QR degrades to null when the generator fails, and an absent image measures ~18 mm short.
// Falling back to empty keeps the fixture renderable; the emit assertion below would catch a
// sheet that silently lost its footer.
let QR = "";
beforeAll(async () => {
  QR = (await buildResumeQrDataUri(RESUME_PROFILE_ORIGIN)) ?? "";
});

/** Yadav's Sandhar block as a turner: one employer, two dated roles, one detail line. */
const TURNER_HISTORY: WorkerEmploymentRecord[] = [
  {
    employer: "Harsha Precision Turned Components",
    employerCity: "Faridabad",
    employerState: "Haryana",
    startYm: "2022-09",
    endYm: null,
    durationStated: true,
    roles: [
      {
        roleLabel: "CNC Setter-cum-Operator",
        startYm: "2024-04",
        endYm: null,
        workDone:
          "CNC lathe, bar feeder and live tooling, Fanuc · EN8, EN31, SS316 · oil and gas fittings",
      },
      {
        roleLabel: "CNC Turner",
        startYm: "2022-09",
        endYm: "2024-03",
        workDone:
          "CNC lathe, bar feeder and live tooling, Fanuc · EN8, EN31, SS316 · oil and gas fittings",
      },
    ],
  },
  {
    employer: "Kalyani Turned Parts",
    employerCity: "Manesar",
    employerState: "Haryana",
    startYm: "2020-04",
    endYm: "2022-08",
    durationStated: true,
    roles: [
      {
        roleLabel: "CNC Turner",
        startYm: null,
        endYm: null,
        workDone: "CNC lathe, Siemens · alloy steel · automotive shafts",
      },
    ],
  },
  {
    employer: "National Engineering Works",
    employerCity: "Faridabad",
    employerState: "Haryana",
    startYm: "2018-05",
    endYm: "2020-03",
    durationStated: true,
    roles: [
      {
        roleLabel: "Lathe Operator",
        startYm: null,
        endYm: null,
        workDone: "Conventional lathe and VTL, Mitsubishi · MS and cast iron · general engineering",
      },
    ],
  },
];

function buildParityInput() {
  return buildResumeRenderInput(
    {
      experience: { total_years: 8 },
      education_level: "iti_diploma",
      education_field: "Turner",
      certifications: ["CNC Turning & Setting"],
      salary_expectation: { amount_min: 32000 },
      location_preference: { current_city: "Faridabad" },
      availability: { status: "notice_period", notice_period_days: 15 },
      resume_profile: {
        domain_label: "Manufacturing",
        role_label: "CNC Setter-cum-Operator",
        skills: ["CNC turning", "canned cycles", "GD&T"],
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
        // ── ZONE 2 — every row the pack can produce ────────────────────────────────────
        turning_machine: ["cnc_lathe", "conventional_lathe", "vtl"],
        controller_brand: ["fanuc", "siemens", "mitsubishi"],
        material_worked: ["mild_steel", "alloy_steel", "stainless", "cast_iron"],
        turning_operation: ["facing_od", "boring", "threading", "grooving", "drilling"],
        workholding: ["three_jaw", "four_jaw", "collet", "soft_jaw", "steady_rest"],
        setting_operation: [
          "tool_offset",
          "work_offset",
          "nose_radius",
          "jaw_change",
          "first_piece",
        ],
        measuring_tools: ["vernier", "micrometer", "bore_gauge", "height_gauge"],
        quality_work: ["first_piece_check", "in_process", "spc"],
        troubleshooting: ["tool_wear", "chatter", "size_variation"],
        programming_level: ["edit_program"],
        drawing_reading: ["gdt"],
        tolerance_band: ["0.01"],
        sector_worked: ["automotive"],
        advanced_capability: ["live_tooling", "bar_feeder", "sub_spindle"],
        // ── ZONE 3 + ZONE 5 — the finishing form, including R9 §3's three new components ──
        // SCALARS where the form writes a scalar. `answer-capture` wraps a `multi_select` and
        // leaves a `single_select` bare, so these two land in `value_text` and are read back
        // through `scalar()`, which correctly refuses a one-element array.
        languages: ["hindi", "haryanvi", "english"],
        documents_ready: [
          "aadhaar",
          "pan",
          "bank_account",
          "uan_pf",
          "iti_certificate",
          "experience_letter",
          "passport_photos",
        ],
        preferred_locations: ["Faridabad", "Gurugram", "Manesar"],
        shift_preference: "rotational",
        job_type: "permanent",
        relocation_willingness: true,
        education_council: "ncvt",
        education_year: 2018,
        education_institute: "Govt. ITI, Faridabad",
      },
      employments: TURNER_HISTORY,
      asOf: AS_OF,
      phone: "+91 98765 43210",
      // THE REAL QR, not a placeholder. The footer's flex row reserves the image's own box, and
      // a sheet measured without it comes out ~18 mm shorter than the one production prints —
      // which is the whole margin this acceptance test is about.
      qrDataUri: QR,
      qrCaption: "Scan to open this worker's live profile",
      shortLink: "badabhai.ai",
      footerMeta: "Generated 27 August 2026 · Self-declared · Ref RK8M2Q",
    },
  );
}

describe("R9 §7 — the turner parity sheet", () => {
  it("reaches Yadav's density: a full Zone 2, three employers, a promotion, a full Zone 5", () => {
    const input = buildParityInput();
    const zone2 =
      (input.capChipRows?.length ?? 0) +
      (input.capTickRows?.length ?? 0) +
      (input.capFactRows?.length ?? 0);
    // AT the budget, not below it — a fully-answered turner must not be able to under-fill Zone 2.
    //
    // AGAINST THE CONSTANT RATHER THAN THE LITERAL 9 IT USED TO NAME, and that is the fix rather
    // than a relaxation: the property this line has always asserted is "he fills the budget", and
    // hard-coding the budget's value meant the assertion silently became "he fills NINE rows" —
    // which failed the moment the budget was re-measured against all twenty-one ratified pages
    // and came out at ten. `toBeLessThanOrEqual` would be the relaxation; this is still equality.
    expect(zone2, "Zone 2 must sit at the row budget").toBe(CAPABILITY_ROW_BUDGET);
    expect(input.employments).toHaveLength(3);
    expect(
      input.employments?.[0]!.roles,
      "the promotion must render as two dated roles",
    ).toHaveLength(2);
    expect(input.qualFactRows?.find((r) => r.label === "Education")?.value).toContain("NCVT");
    // UNCHANGED, AND LOAD-BEARING. This sheet measures 41.19 lines against a budget of 41, so
    // under the old ladder the "languages" step fired and Haryanvi left the page — a row all
    // twenty-one ratified pages print. What keeps this line green is the ruling: the ladder now
    // runs out of PERMITTED steps and spills instead. A change that puts it red has re-admitted
    // a forbidden step, not merely moved a row.
    expect(input.qualFactRows?.find((r) => r.label === "Languages spoken")?.value).toContain(
      "Haryanvi",
    );
    expect(input.qualTickRows?.find((r) => r.label === "Documents ready")?.values).toHaveLength(7);
    expect(input.availFactRows?.find((r) => r.label === "Shift")?.value).toBe(
      "Rotational shifts · Permanent",
    );
    // No hole anywhere: every zone the sample fills, this fills.
    expect(input.headlineLine).toContain("8 yrs");
    expect(input.subheadLine).toContain("Faridabad");
    expect(input.phone).toBeTruthy();
    expect(input.footerMeta).toContain("Ref");
  });

  it("now PRINTS Tolerance held — the Q2 redline, partly answered by the re-measured budget", () => {
    // ── READ THIS BEFORE ASSUMING AN ASSERTION WAS FLIPPED TO REACH GREEN ────────────────
    //
    // THIS TEST USED TO ASSERT THE OPPOSITE, and the inversion is the redline being ANSWERED
    // rather than an expectation bent to match output. What it recorded was a defect: at
    // `CAPABILITY_ROW_BUDGET = 9`, `tolerance_band` (rank 62, tenth of the turner map's fourteen
    // rows) fell one place below the cut, so a turner holding ±0.01 mm — the strongest pay signal
    // in the trade — got a sheet that did not say so, while the ratified MILLING sample printed
    // tolerance at position eight of its nine. The complaint was always that NINE WAS TOO LOW.
    //
    // Re-measuring the budget across all twenty-one ratified pages put it at ten, and ten is
    // exactly where `tolerance_band` sits. So the row prints, and the assertion states that.
    // Deleting this test would delete the evidence; leaving it inverted-but-silent would hide
    // that a ruled redline moved. Both halves are therefore asserted together below.
    const input = buildParityInput();
    const labels = [
      ...(input.capChipRows ?? []),
      ...(input.capTickRows ?? []),
      ...(input.capFactRows ?? []),
    ].map((r) => r.label);
    expect(labels, "the raised budget must reach rank 62").toContain("Tolerance held");
    // STILL SHED, and the redline is therefore only PARTLY answered. `Operations` is rank 63 and
    // `Sector worked` rank 81 — eleventh and fourteenth — so a fully-answered turner still loses
    // them. That remains an open pack/ruling question and must not be read as settled.
    expect(labels).not.toContain("Operations");
    expect(labels).not.toContain("Sector worked");
  });

  it("spills onto a second page rather than shedding a ratified row, and says that it did", () => {
    // THE RULING'S OUTCOME, ASSERTED ON THE SHEET IT WAS TAKEN FOR. The compressing steps are all
    // no-ops here (no volunteered fields exist, and he has exactly three employers), so the
    // ladder cannot spend anything: stage 0, nothing dropped, and 0.19 lines over budget.
    //
    // THE MAGNITUDE IS THE INVARIANT, not just the flag. 0.19 lines is 0.93 mm — the residue of
    // rounding `SHEET_LINE_BUDGET` down from a fitted 41.7 — and a sheet that starts overflowing
    // by whole lines is ballooning for some other reason and must fail here.
    const input = buildParityInput();
    expect(input.degradationStage, "nothing may be shed to buy this page back").toBe(0);
    expect(input.degradationDropped).toEqual([]);
    expect(input.degradationOverflows, "a spill must be reported, never silent").toBe(true);
    expect(input.degradationOverBudgetLines).toBeGreaterThan(0);
    expect(input.degradationOverBudgetLines, "overflowing by more than rounding").toBeLessThan(1);
  });

  it.skipIf(!OUT_DIR)("writes the sheet for a side-by-side render", () => {
    const input = buildParityInput();
    mkdirSync(OUT_DIR!, { recursive: true });
    const renderer = new ResumeRenderer(null as never);
    writeFileSync(join(OUT_DIR!, "turner-parity.html"), renderer.buildResumeHtml(input), "utf8");
    writeFileSync(
      join(OUT_DIR!, "turner-parity.render.json"),
      JSON.stringify(input, null, 2),
      "utf8",
    );
    expect(input.degradationStage).toBe(0);
  });
});
