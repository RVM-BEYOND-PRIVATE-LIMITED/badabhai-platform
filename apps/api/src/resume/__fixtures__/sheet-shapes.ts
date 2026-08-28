import type { ResumeQualificationFacts, TradeSheetContext } from "../resume-render-input";
import type { WorkerEmploymentRecord } from "../resume-employment-rows";
import { buildResumeQrDataUri } from "../resume-qr";
import { RESUME_PROFILE_ORIGIN } from "../resume-sheet-footer";

/**
 * THE CONTENT-SHAPE MATRIX — fourteen profiles the `bb_trade` sheet has to survive.
 *
 * WHY A MATRIX RATHER THAN MORE UNIT TESTS. The page budgets were measured against the three
 * ratified sample sheets, and all three are well-formed mid-length résumés. None of them is a
 * stress case, so a budget that holds against them proves only that the design's own examples
 * fit. The shapes that break a one-page contract are the ones nobody drew: a worker who answered
 * every pack question, nine employers in four years, a name that wraps, a full credentials block.
 * Five of the fourteen (5, 6, 8, 9, 11) exist ONLY to overflow.
 *
 * THE NUMBERING IS STABLE AND IS QUOTED IN THE JOURNAL AND IN CI EVIDENCE. Append; never
 * renumber. Each shape names the guideline clause it exercises.
 *
 * EVERY VALUE HERE IS SOURCEABLE, which is what makes the fabrication gate meaningful. The gate
 * derives the worker-supplied set STRUCTURALLY from these fixtures — every free-text string
 * reachable from `snapshot` and `tradeSheet` — rather than from a hand-written list beside them.
 * A second list would drift from the first, and the drift would silently widen the gate. What is
 * left over after that derivation is exactly what the RENDERER added, which is the thing §8 is
 * about: the pipeline may reshape a worker's words, and may never add to them.
 */

export interface SheetShape {
  /** Stable index. Quoted in evidence; never renumbered. */
  readonly n: number;
  readonly name: string;
  /** The guideline clause(s) this shape exists to exercise. */
  readonly clause: string;
  /** True for the five shapes built to overflow the page. */
  readonly overflow: boolean;
  /** The `sourceProfileSnapshot` — a DraftProfile, as stored. */
  readonly snapshot: Record<string, unknown>;
  readonly displayName: string | null;
  readonly tradeSheet: TradeSheetContext | null;
}

export const SHEET_AS_OF = new Date("2026-08-28T09:00:00Z");

/**
 * THE REAL QR, from the real generator, injected into every shape by the suites that render.
 *
 * IT WAS `null` HERE, so none of the twenty-eight sheets carried a QR and every page-fit
 * result was taken against a footer production does not print. The correction is the fixture;
 * the CONCLUSION survived, and the difference between those two is worth stating exactly.
 *
 * MEASURED, BECAUSE THE OBVIOUS INFERENCE WAS WRONG. `.qr` reserves 18 mm x 18 mm and the
 * footer was the section overflowing, so the expected cost was ~12 mm of page and a re-broken
 * one-page contract. It costs ZERO: `.foot` is a flex ROW and `.foot-txt` is five lines at
 * 8.6 pt/1.43 — about 21.7 mm — so the text column is already taller than the QR box and the
 * image consumes width, not height. Re-measured in WeasyPrint across all 28 sheets, the
 * headroom delta with and without the QR is 0.00 mm on every one of them.
 *
 * Which is exactly why it is generated here rather than argued about: the reasoning that says
 * "18 mm box in the overflowing section" is entirely plausible and entirely wrong, and only a
 * render can tell the two apart. It also means any future change that makes the footer TEXT
 * shorter silently hands the 18 mm box back its ability to drive the page height.
 *
 * GENERATED, NOT PASTED. A hard-coded data URI would keep passing after a change to the error
 * correction level or the target URL, both of which move the module count and therefore the
 * printed size of a module. `RESUME_PROFILE_ORIGIN` is the same constant the render worker
 * passes, so the symbol under test is the shipped one.
 *
 * WHY A PRIME/INJECT PAIR RATHER THAN A CONSTANT. `buildResumeQrDataUri` is async and this
 * package compiles to CommonJS, where a top-level `await` is a compile error — it passes under
 * vitest's ESM transform and fails `tsc`, which is a good illustration of why the typecheck is a
 * separate gate. Callers `await primeSheetQr()` once and wrap with `withSheetQr`.
 */
let cachedQr: string | null = null;

export async function primeSheetQr(): Promise<void> {
  cachedQr ??= await buildResumeQrDataUri(RESUME_PROFILE_ORIGIN);
}

/**
 * The shape's context with the real QR in it.
 *
 * A NULL CONTEXT STAYS NULL. Shape 14 supplies none at all, which is a real state rather than an
 * oversight — the disclosure surface passes null when both of its loads fail — and the sheet has
 * to collapse the whole footer region cleanly rather than print a broken image.
 */
export function withSheetQr(context: TradeSheetContext | null): TradeSheetContext | null {
  if (context === null) return null;
  if (cachedQr === null) throw new Error("call `await primeSheetQr()` in beforeAll first");
  return { ...context, qrDataUri: cachedQr };
}

/** The footer/masthead slots every shape shares; none of them is worker content. */
const CHROME = {
  phone: "+91 98765 43210",
  nameDevanagari: null,
  trustBadge: null,
  qrDataUri: null,
  qrCaption: "Scan to open this worker's live profile",
  shortLink: "badabhai.ai",
  footerMeta: "Generated 28 August 2026 · Ref RK8M2Q",
  asOf: SHEET_AS_OF,
} as const;

function employment(over: Partial<WorkerEmploymentRecord> = {}): WorkerEmploymentRecord {
  return {
    employer: "Sandhar Technologies",
    employerCity: "Gurugram",
    employerState: "Haryana",
    startYm: "2023-01",
    endYm: null,
    durationStated: true,
    roles: [
      { roleLabel: "CNC Turner", startYm: null, endYm: null, workDone: "CNC turning, Fanuc" },
    ],
    ...over,
  };
}

/** A résumé container (the LLM-led path), defaulted to a plausible turner. */
function resumeProfile(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    resume_profile: {
      domain_label: "CNC machining",
      role_label: "CNC Turner",
      skills: ["CNC turning", "Tool offset setting"],
      experiences: [],
      shift: "rotational",
      current_city: "Faridabad",
      preferred_locations: ["Faridabad", "Gurugram"],
      availability: "immediate",
      expected_salary: 26000,
      ...over,
    },
  };
}

/** The fully-answered turner: every one of the pack's fourteen capability rows. */
const MAXED_ATTRIBUTES = {
  turning_machine: ["cnc_lathe", "conventional_lathe", "vtl", "sliding_head", "spm"],
  controller_brand: ["fanuc", "siemens", "mitsubishi", "haas", "mazak"],
  material_worked: ["mild_steel", "alloy_steel", "stainless", "aluminium", "brass", "cast_iron"],
  turning_operation: ["facing_od", "boring", "threading", "grooving", "drilling", "knurling"],
  workholding: ["three_jaw", "four_jaw", "collet", "soft_jaw", "tailstock", "steady_rest"],
  setting_operation: ["tool_offset", "work_offset", "nose_radius", "jaw_change", "first_piece"],
  measuring_tools: ["vernier", "micrometer", "bore_gauge", "height_gauge", "plug_gauge"],
  quality_work: ["first_piece_check", "in_process", "spc", "rejection"],
  troubleshooting: ["tool_wear", "chatter", "size_variation", "surface_finish", "alarm"],
  programming_level: "write_program",
  drawing_reading: "gdt",
  tolerance_band: "0.01",
  sector_worked: ["automotive", "general_engg", "pump_valve", "oil_gas"],
  advanced_capability: ["live_tooling", "bar_feeder", "sub_spindle", "c_axis", "y_axis"],
} as const;

const FULL_QUALIFICATION: ResumeQualificationFacts = {
  educationHeadline: "ITI — Turner",
  education: ["NCVT, 2014", "Government ITI Faridabad"],
  certifications: ["Forklift licence, 2021", "Safety training, 2023"],
  languages: ["Hindi", "Haryanvi", "English"],
  documents: ["Aadhaar", "PAN", "Bank account", "UAN / PF", "ITI certificate", "Experience letter"],
};

export const SHEET_SHAPES: readonly SheetShape[] = [
  {
    n: 1,
    name: "ITI fresher, zero employment rows",
    clause: "§11 #1 — never render an empty History heading",
    overflow: false,
    snapshot: resumeProfile({
      role_label: "CNC Turner (fresher)",
      experiences: [],
      expected_salary: 14000,
    }),
    displayName: "Rohit Kumar",
    tradeSheet: {
      ...CHROME,
      packId: "qp_cnc_turning",
      attributes: {
        turning_machine: ["conventional_lathe"],
        measuring_tools: ["vernier"],
        turning_operation: ["facing_od"],
      },
      employments: [],
      qualification: {
        educationHeadline: "ITI — Turner",
        education: ["NCVT, 2025"],
        documents: ["Aadhaar", "ITI certificate"],
      },
    },
  },
  {
    n: 2,
    name: "Twelve years on the machine, no ITI",
    clause: "§11 #2 — never flag the missing credential",
    overflow: false,
    snapshot: resumeProfile({
      experiences: [
        {
          role_label: "CNC Turner",
          duration_text: "12 saal",
          duration_months: 144,
          work_done: "CNC turning on Fanuc",
        },
      ],
    }),
    displayName: "Ramesh Kumar Yadav",
    tradeSheet: {
      ...CHROME,
      packId: "qp_cnc_turning",
      attributes: {
        turning_machine: ["cnc_lathe"],
        controller_brand: ["fanuc"],
        setting_operation: ["tool_offset", "first_piece"],
        measuring_tools: ["vernier", "micrometer"],
      },
      employments: [employment()],
      // No education at all. Nothing may flag its absence.
      qualification: { languages: ["Hindi"], documents: ["Aadhaar", "PAN"] },
    },
  },
  {
    n: 3,
    name: "Duration unknown throughout",
    clause: "§11 #3 — 'duration not stated', never estimated",
    overflow: false,
    snapshot: resumeProfile({
      experiences: [
        {
          role_label: "Turner",
          duration_text: "kuch saal",
          duration_months: null,
          work_done: "Lathe work",
        },
      ],
    }),
    displayName: "Suresh Pal",
    tradeSheet: {
      ...CHROME,
      packId: "qp_cnc_turning",
      attributes: { turning_machine: ["conventional_lathe"], measuring_tools: ["vernier"] },
      employments: [
        employment({ employer: "Bharat Engineering Works", startYm: null, durationStated: false }),
      ],
      qualification: {},
    },
  },
  {
    n: 4,
    name: "Contract / thekedar work, no company name",
    clause: "§11 #4 — the site or 'contract work', never blank, never invented",
    overflow: false,
    snapshot: resumeProfile({}),
    displayName: "Mukesh Sahni",
    tradeSheet: {
      ...CHROME,
      packId: "qp_cnc_turning",
      attributes: { turning_machine: ["conventional_lathe"], workholding: ["three_jaw"] },
      employments: [
        employment({
          employer: "Contract work",
          employerCity: "Manesar",
          employerState: null,
          roles: [
            { roleLabel: "Turner", startYm: null, endYm: null, workDone: "Job-shop turning" },
          ],
        }),
      ],
      qualification: { documents: ["Aadhaar"] },
    },
  },
  {
    n: 5,
    name: "OVERFLOW — employment gaps beside a fully-answered pack",
    clause: "§11 #5 + §6.3 one page",
    overflow: true,
    snapshot: resumeProfile({ expected_salary: 32000 }),
    displayName: "Jagdish Prasad Sharma",
    tradeSheet: {
      ...CHROME,
      packId: "qp_cnc_turning",
      attributes: MAXED_ATTRIBUTES,
      employments: [
        employment({ employer: "Rico Auto Industries", startYm: "2024-06", endYm: null }),
        employment({ employer: "Munjal Showa", startYm: "2019-02", endYm: "2022-04" }),
        employment({ employer: "Endurance Technologies", startYm: "2015-01", endYm: "2017-08" }),
        employment({ employer: "Minda Industries", startYm: "2011-05", endYm: "2013-09" }),
      ],
      qualification: FULL_QUALIFICATION,
    },
  },
  {
    n: 6,
    name: "OVERFLOW — nine employers in four years",
    clause: "§11 #6 + #7 — months for each, remainder to one counted line",
    overflow: true,
    snapshot: resumeProfile({}),
    displayName: "Anil Kumar",
    tradeSheet: {
      ...CHROME,
      packId: "qp_cnc_turning",
      attributes: MAXED_ATTRIBUTES,
      employments: (
        [
          ["2026-05", "2026-08"],
          ["2026-01", "2026-04"],
          ["2025-08", "2025-12"],
          ["2025-03", "2025-07"],
          ["2024-11", "2025-02"],
          ["2024-06", "2024-10"],
          ["2024-01", "2024-05"],
          ["2023-06", "2023-12"],
          ["2022-09", "2023-05"],
        ] as const
      ).map(([startYm, endYm], i) =>
        employment({
          employer: `Shakti Engineering Unit ${i + 1}`,
          startYm,
          endYm,
          roles: [
            { roleLabel: "CNC Turner", startYm: null, endYm: null, workDone: "CNC turning, Fanuc" },
          ],
        }),
      ),
      qualification: FULL_QUALIFICATION,
    },
  },
  {
    n: 7,
    name: "Promoted inside one employer",
    clause: "§11 #14 — one block, two dated function lines",
    overflow: false,
    snapshot: resumeProfile({}),
    displayName: "Deepak Verma",
    tradeSheet: {
      ...CHROME,
      packId: "qp_cnc_turning",
      attributes: {
        turning_machine: ["cnc_lathe"],
        controller_brand: ["fanuc", "siemens"],
        setting_operation: ["tool_offset", "work_offset", "first_piece"],
      },
      employments: [
        employment({
          employer: "Sandhar Technologies",
          startYm: "2021-04",
          endYm: null,
          roles: [
            {
              roleLabel: "Setter-cum-Operator",
              startYm: "2023-08",
              endYm: null,
              workDone: "Setting and first-piece approval",
            },
            {
              roleLabel: "CNC Operator",
              startYm: "2021-04",
              endYm: "2023-07",
              workDone: "CNC turning, Fanuc",
            },
          ],
        }),
      ],
      qualification: { educationHeadline: "ITI — Turner", languages: ["Hindi", "English"] },
    },
  },
  {
    n: 8,
    name: "OVERFLOW — every pack row answered, every chip at its cap",
    clause: "§4.3 per-row caps + §6.3 one page",
    overflow: true,
    snapshot: resumeProfile({
      skills: ["CNC turning", "Tool offset setting", "GD&T reading", "SPC", "Fixture setting"],
      expected_salary: 38000,
      preferred_locations: ["Faridabad", "Gurugram", "Manesar", "Bawal", "Neemrana"],
    }),
    displayName: "Balwinder Singh",
    tradeSheet: {
      ...CHROME,
      packId: "qp_cnc_turning",
      attributes: MAXED_ATTRIBUTES,
      employments: [
        employment(),
        employment({ employer: "Rico Auto Industries", startYm: "2018-02", endYm: "2022-12" }),
      ],
      qualification: FULL_QUALIFICATION,
    },
  },
  {
    n: 9,
    name: "OVERFLOW — very long name, long employers, five preferred cities",
    clause: "§11 #9 — auto-fit to the 18pt floor then wrap; never truncate a name",
    overflow: true,
    snapshot: resumeProfile({
      preferred_locations: ["Faridabad", "Gurugram", "Manesar", "Bawal", "Neemrana"],
    }),
    displayName: "Venkataramanan Subrahmanya Krishnamurthy Iyengar",
    tradeSheet: {
      ...CHROME,
      packId: "qp_cnc_turning",
      attributes: MAXED_ATTRIBUTES,
      employments: [
        employment({ employer: "Hindustan Aeronautics Limited, Foundry and Forge Division" }),
        employment({
          employer: "Bharat Heavy Electricals Limited, Ranipet Works",
          startYm: "2017-03",
          endYm: "2022-11",
        }),
        employment({
          employer: "Tamil Nadu Precision Engineering Components Private Limited",
          startYm: "2012-07",
          endYm: "2017-01",
        }),
      ],
      qualification: FULL_QUALIFICATION,
    },
  },
  {
    n: 10,
    name: "Single name, no surname",
    clause: "§11 #8 — render exactly as given; never assume two tokens",
    overflow: false,
    snapshot: resumeProfile({}),
    displayName: "Ramesh",
    tradeSheet: {
      ...CHROME,
      packId: "qp_cnc_turning",
      attributes: { turning_machine: ["cnc_lathe"], controller_brand: ["fanuc"] },
      employments: [employment()],
      qualification: { languages: ["Hindi"] },
    },
  },
  {
    n: 11,
    name: "OVERFLOW — overseas history plus a full credentials block",
    clause: "§11 #15 + §5.1 ranks 8-10 (ITI, documents, languages)",
    overflow: true,
    snapshot: resumeProfile({ expected_salary: 45000 }),
    displayName: "Mohammed Irfan Ansari",
    tradeSheet: {
      ...CHROME,
      packId: "qp_cnc_turning",
      attributes: MAXED_ATTRIBUTES,
      employments: [
        employment({
          employer: "Al Faris Engineering",
          employerCity: "Dubai",
          employerState: "UAE",
          startYm: "2022-09",
          endYm: null,
        }),
        employment({
          employer: "Zamil Industrial",
          employerCity: "Dammam",
          employerState: "Saudi Arabia",
          startYm: "2018-04",
          endYm: "2022-06",
        }),
        employment({ employer: "Sandhar Technologies", startYm: "2013-01", endYm: "2018-01" }),
      ],
      qualification: FULL_QUALIFICATION,
    },
  },
  {
    n: 12,
    name: "Two trades, the stronger by months leading",
    clause: "§11 #12 — both render in the Verdict Line, separated",
    overflow: false,
    snapshot: resumeProfile({
      role_label: "CNC Turner · Milling operator",
      skills: ["CNC turning", "Milling"],
    }),
    displayName: "Sanjay Yadav",
    tradeSheet: {
      ...CHROME,
      packId: "qp_cnc_turning",
      attributes: { turning_machine: ["cnc_lathe"], controller_brand: ["fanuc"] },
      employments: [employment()],
      qualification: {},
    },
  },
  {
    n: 13,
    name: "Off-pack trade — no capability map exists",
    clause: "§11 #11 — full résumé from raw phrases; §11 #16 — never gated",
    overflow: false,
    snapshot: resumeProfile({
      domain_label: "Tailoring",
      role_label: "Tailor",
      skills: ["Overlock machine", "Cutting"],
      experiences: [
        {
          role_label: "Tailor",
          duration_text: "6 saal",
          duration_months: 72,
          work_done: "Shirt stitching",
        },
      ],
      expected_salary: 16000,
    }),
    displayName: "Farida Begum",
    // No pack ran, so the capability section collapses entirely and the flat `experiences`
    // fallback carries Zone 4. This is the state 140-odd trades are in today.
    tradeSheet: { ...CHROME, packId: null, attributes: {}, employments: [] },
  },
  {
    n: 14,
    name: "Name only — everything else absent",
    clause: "§6.3 — a field with no value collapses; no placeholder text ever prints",
    overflow: false,
    snapshot: {},
    displayName: "Kamla Devi",
    tradeSheet: null,
  },
];

/**
 * THE CONTENT THAT IS COMING — Zone 4 and Zone 5 at the length real data actually has.
 *
 * WHY THE MATRIX IS NOT ENOUGH ON ITS OWN. Every shape above is SEEDED, and seeded data is
 * shorter and more regular than the real thing: "Sandhar Technologies" rather than "Sandhar
 * Technologies Limited, Plant II", "ITI Turner" rather than the full NCVT certificate string a
 * worker reads off the document in his hand. A degradation ladder tuned to seeded lengths passes
 * its own tests and breaks on first contact with production, which is precisely the failure the
 * QR fixture already demonstrated in this same file.
 *
 * TWO QUEUED FEATURES LAND HERE. Work-history capture fills `employments` from a real form, and
 * Phase C fills `qualification` from extraction. Both were measured (journal §9.2) to take the
 * worst R1 shape to two pages on their FIRST row. So the ladder is verified against this, not
 * against what exists today — the whole point of building it ahead of both.
 *
 * Lengths are drawn from the shapes real Indian manufacturing records take: a registered company
 * name with its suffix, a plant qualifier, an NCVT/NSQF certificate with issuer and year.
 */
const FUTURE_EMPLOYERS: readonly WorkerEmploymentRecord[] = [
  employment({
    employer: "Sandhar Technologies Limited, Plant II",
    employerCity: "Manesar",
    employerState: "Haryana",
    startYm: "2022-04",
    endYm: null,
    roles: [
      {
        roleLabel: "CNC Turner cum Setter",
        startYm: null,
        endYm: null,
        workDone:
          "Setting and running twin-spindle CNC lathes on steering knuckle housings, first-piece approval and in-process SPC",
      },
    ],
  }),
  employment({
    employer: "Rico Auto Industries Limited",
    employerCity: "Gurugram",
    employerState: "Haryana",
    startYm: "2019-06",
    endYm: "2022-03",
    roles: [
      {
        roleLabel: "CNC Turner",
        startYm: null,
        endYm: null,
        workDone: "Bar-fed turning of aluminium housings, offset correction and tool life tracking",
      },
    ],
  }),
  employment({
    employer: "Endurance Technologies Private Limited",
    employerCity: "Aurangabad",
    employerState: "Maharashtra",
    startYm: "2017-01",
    endYm: "2019-05",
    roles: [
      {
        roleLabel: "Machine Operator",
        startYm: null,
        endYm: null,
        workDone: "Second-operation turning on brake assemblies, gauge checks every twentieth part",
      },
    ],
  }),
  employment({
    employer: "Munjal Showa Limited",
    employerCity: "Manesar",
    employerState: "Haryana",
    startYm: "2015-08",
    endYm: "2016-12",
    roles: [
      {
        roleLabel: "Trainee Operator",
        startYm: null,
        endYm: null,
        workDone: "Loading and unloading conventional lathes under a setter",
      },
    ],
  }),
];

const FUTURE_QUALIFICATION: ResumeQualificationFacts = {
  educationHeadline: "ITI (NCVT) — Turner",
  education: ["Government Industrial Training Institute, Faridabad — NCVT — 2015"],
  certifications: [
    "National Trade Certificate (NTC) — Turner — NCVT — 2015",
    "NSQF Level 4 — Advanced CNC Turning — NIMI, Chennai — 2019",
    "Fire and Safety Awareness — Endurance Technologies internal — 2021",
  ],
  languages: ["Hindi (fluent)", "Haryanvi (mother tongue)", "English (basic reading)"],
  documents: [
    "aadhaar",
    "pan",
    "bank_account",
    "uan_pf",
    "iti_certificate",
    "experience_letter",
    "passport_photos",
  ],
};

/**
 * The same shape, with the queued Zone 4 and Zone 5 content in it.
 *
 * A NULL CONTEXT STAYS NULL — shape 14 has no sheet context at all, and inventing one for it
 * would quietly delete the only fixture that covers the fully-collapsed page.
 */
export function withFutureContent(context: TradeSheetContext | null): TradeSheetContext | null {
  if (context === null) return null;
  return {
    ...context,
    employments: FUTURE_EMPLOYERS,
    qualification: { ...(context.qualification ?? {}), ...FUTURE_QUALIFICATION },
  };
}
