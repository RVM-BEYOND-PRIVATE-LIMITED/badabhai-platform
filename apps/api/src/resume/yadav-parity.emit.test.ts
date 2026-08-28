import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

import { buildResumeRenderInput } from "./resume-render-input";
import { ResumeRenderer } from "./resume-renderer.service";
import type { WorkerEmploymentRecord } from "./resume-employment-rows";
import { buildResumeQrDataUri } from "./resume-qr";
import { RESUME_PROFILE_ORIGIN } from "./resume-sheet-footer";

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
 * turner pack defines FOURTEEN capability rows against a budget of NINE, so a fully-answered
 * worker is exactly the case R9 §5's conflict is about: the sheet that results is the one the
 * budget actually produces, not the one a convenient fixture produces.
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
        setting_operation: ["tool_offset", "work_offset", "nose_radius", "jaw_change", "first_piece"],
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
  it("reaches Yadav's density: nine Zone 2 rows, three employers, a promotion, a full Zone 5", () => {
    const input = buildParityInput();
    const zone2 =
      (input.capChipRows?.length ?? 0) +
      (input.capTickRows?.length ?? 0) +
      (input.capFactRows?.length ?? 0);
    // AT the budget, not below it — a fully-answered turner must not be able to under-fill Zone 2.
    expect(zone2, "Zone 2 must sit at the row budget").toBe(9);
    expect(input.employments).toHaveLength(3);
    expect(input.employments?.[0]!.roles, "the promotion must render as two dated roles").toHaveLength(2);
    expect(input.qualFactRows?.find((r) => r.label === "Education")?.value).toContain("NCVT");
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

  it("drops Tolerance held — the measured evidence behind the Q2 redline", () => {
    // `tolerance_band` is rank 62 of the turner map's FOURTEEN rows, so it is tenth by rank and
    // the budget of nine cuts immediately above it. A turner holding ±0.01 mm — the strongest pay
    // signal in the trade — gets a sheet that does not say so, while the ratified MILLING sample
    // prints tolerance at position eight of its nine. Asserted rather than described, so the
    // redline has a test behind it.
    const input = buildParityInput();
    const labels = [
      ...(input.capChipRows ?? []),
      ...(input.capTickRows ?? []),
      ...(input.capFactRows ?? []),
    ].map((r) => r.label);
    expect(labels).not.toContain("Tolerance held");
    expect(labels).not.toContain("Operations");
    expect(labels).not.toContain("Sector worked");
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
