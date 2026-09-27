import { ownBriefUsable } from "../resume-brief";
import type { WorkerEmploymentRecord } from "../resume-employment-rows";
import type { TradeSheetContext } from "../resume-render-input";

/**
 * THE GENERAL ROAD'S RÉSUMÉ FIXTURES (ADR-0045 Phase 5) — shared by every suite that renders a
 * road sheet: the persona renders (`bb-general-sheet.render.test.ts`), the fabrication gate and
 * the withheld-salary pin.
 *
 * ONE SET, NOT THREE, for the reason `sheet-shapes.ts` gives for its matrix: the fabrication gate
 * derives what the worker supplied STRUCTURALLY from these objects, so a second copy of a persona
 * in another suite would drift from this one, and the drift would silently widen the gate.
 *
 * NOT `SHEET_SHAPES`, deliberately. The fourteen shapes are quoted by count in the matrix, the QR
 * gate, the emit manifest and the README evidence, and they render as `bb_trade`, where the road
 * is off by construction — a road shape there would be a shape that tests nothing.
 *
 * WHAT A ROAD SNAPSHOT IS. Exactly what Phase 4's zero-model build writes
 * (`general-road-profile.ts`): the stamp's certified role and domain labels, its skills in
 * `skill_labels` only, `experience.total_years` frozen at build time, and `resume_profile: null`.
 * The frozen total is deliberately WRONG here (eleven years against a 7 yrs 4 mo history): the
 * road recomputes the years live from the dated jobs (R5), and a fixture whose stale figure
 * happened to equal the live one could not tell the two rules apart.
 *
 * EVERY OWN BRIEF HERE IS ONE THE FORM WOULD HAVE STORED — `screenBrief` passes each against its
 * persona's name (asserted in `bb-general-sheet.render.test.ts`), so no persona prints a line the
 * write-time walls would have refused.
 */

/** The render clock every road persona is drawn against: 27 Sep 2026, noon in India. */
export const ROAD_AS_OF = new Date("2026-09-27T06:30:00Z");

/** The stamp's role label, as the chat certified it (lower case, as workers type it). */
export const ROAD_ROLE_LABEL = "house electrician";

/**
 * The ONE cased role the sheet prints — Verdict Line, profile headline and the brief's {R} alike.
 * Spelled out rather than derived, so a casing change is a visible fixture diff.
 */
export const ROAD_ROLE = "House Electrician";

/** The skills the worker confirmed at the gate, in the gate's order. */
export const ROAD_SKILLS: readonly string[] = [
  "House wiring",
  "Panel fitting",
  "MCB installation",
  "Earthing",
  "Conduit work",
];

/** The snapshot Phase 4 writes for a handed-over session. See the header. */
export function roadSnapshot(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    role_label: ROAD_ROLE_LABEL,
    domain_label: "Electrical work",
    skills: [],
    skill_labels: [...ROAD_SKILLS],
    // STALE ON PURPOSE — see the header. The road must never print it.
    experience: { total_years: 11 },
    resume_profile: null,
    ...over,
  };
}

/**
 * Two DATED jobs: Apr 2019 – Mar 2022 (36 months) and Jun 2022 – current (52 months against
 * {@link ROAD_AS_OF}). 88 months is 7.3 years, printed "7 yrs 4 mo".
 */
export const ROAD_DATED_EMPLOYMENTS: readonly WorkerEmploymentRecord[] = [
  {
    employer: "Bharat Electricals",
    employerCity: "Faridabad",
    employerState: "Haryana",
    startYm: "2019-04",
    endYm: "2022-03",
    durationStated: true,
    roles: [
      {
        roleLabel: "Electrician",
        startYm: null,
        endYm: null,
        workDone: "House wiring and DB fitting",
      },
    ],
  },
  {
    employer: "Shree Ganesh Builders",
    employerCity: "Gurugram",
    employerState: "Haryana",
    startYm: "2022-06",
    endYm: null,
    durationStated: true,
    roles: [
      {
        roleLabel: "Site Electrician",
        startYm: null,
        endYm: null,
        workDone: "Conduit and panel work on residential towers",
      },
    ],
  },
];

/** The same history with the first job's dates not given — so no total exists (§11 #3). */
export const ROAD_UNDATED_EMPLOYMENTS: readonly WorkerEmploymentRecord[] = [
  { ...ROAD_DATED_EMPLOYMENTS[0]!, startYm: null, endYm: null, durationStated: false },
  ROAD_DATED_EMPLOYMENTS[1]!,
];

/** The fallback line for a worker whose jobs are all dated, spelled out by hand. */
export const ROAD_FALLBACK_DATED =
  "House Electrician with 7 yrs 4 mo of experience in House wiring, Panel fitting and MCB installation.";
/** The fallback line for a worker with no job stored. */
export const ROAD_FALLBACK_FRESHER =
  "Fresher House Electrician with skills in House wiring, Panel fitting and MCB installation.";
/** The fallback line for a worker whose jobs exist but are not all dated. */
export const ROAD_FALLBACK_UNDATED =
  "House Electrician with skills in House wiring, Panel fitting and MCB installation.";

export interface RoadPersona {
  readonly name: string;
  /** The worker's real name — what the worker's copy prints and the employer copy masks. */
  readonly displayName: string;
  readonly snapshot: Record<string, unknown>;
  /** The pack-less rows the general form wrote, WITHOUT the brief (see {@link storedBrief}). */
  readonly attributes: Readonly<Record<string, unknown>>;
  /** The stored `profile_brief` value; ABSENT means the worker never reached the question. */
  readonly storedBrief?: unknown;
  readonly employments: readonly WorkerEmploymentRecord[];
  /** What the brief slot must print, spelled out — the own line or the fixed fallback line. */
  readonly expectedBrief: string | null;
}

/** An answered brief, as the form stores it. */
const answered = (text: string) => ({ status: "answered", text }) as const;
const DECLINED = { status: "declined" } as const;

/** 160 code points exactly — the write bound, and so the longest line the slot ever prints. */
export const ROAD_DENSE_BRIEF =
  "Ghar, dukaan, office aur factory ki wiring, DB aur panel fitting, MCB aur RCCB lagana, earthing, conduit aur casing-capping ka kaam; puraani wiring ki marammat.";

export const ROAD_PERSONAS: readonly RoadPersona[] = [
  {
    // The worker's own line, every term answered, a start date still ahead of the render.
    name: "road-answered",
    displayName: "Rajesh Kumar Verma",
    snapshot: roadSnapshot(),
    attributes: {
      has_work_history: true,
      salary_expected_min: 18000,
      salary_expected_max: 22000,
      availability: { available_from: "2026-10-12" },
      shift_preference: "day",
      work_types: ["permanent", "contract"],
    },
    storedBrief: answered(
      "Ghar, dukaan aur office ki wiring karta hoon. DB aur MCB fitting bhi aata hai.",
    ),
    employments: ROAD_DATED_EMPLOYMENTS,
    expectedBrief: "Ghar, dukaan aur office ki wiring karta hoon. DB aur MCB fitting bhi aata hai.",
  },
  {
    // He skipped the brief: the fixed line, composed from the dated total and his first skills.
    name: "road-declined",
    displayName: "Sunil Yadav",
    snapshot: roadSnapshot(),
    attributes: {
      has_work_history: true,
      salary_expected_min: 16000,
      salary_expected_max: 20000,
      availability: { status: "serving_notice", notice_period_days: 30 },
      shift_preference: "night",
      work_types: ["daily_wage"],
    },
    storedBrief: DECLINED,
    employments: ROAD_DATED_EMPLOYMENTS,
    expectedBrief: ROAD_FALLBACK_DATED,
  },
  {
    // No job stored: "Fresher" on the headline and in the fixed line. No band, no shift answer.
    name: "road-fresher",
    displayName: "Pooja Kumari",
    snapshot: roadSnapshot({ experience: { total_years: 2 } }),
    attributes: {
      has_work_history: false,
      availability: { status: "within_week" },
    },
    storedBrief: DECLINED,
    employments: [],
    expectedBrief: ROAD_FALLBACK_FRESHER,
  },
  {
    // Jobs exist, one undated: no total, so "duration not stated" and the skills-only line. No
    // brief row at all (he closed the form before the last page), and a start date already past.
    name: "road-undated",
    displayName: "Mohd Arif",
    snapshot: roadSnapshot(),
    attributes: {
      has_work_history: true,
      salary_expected_min: 17000,
      availability: { status: "within_month", available_from: "2026-09-01" },
      work_types: ["contract"],
    },
    employments: ROAD_UNDATED_EMPLOYMENTS,
    expectedBrief: ROAD_FALLBACK_UNDATED,
  },
  {
    // His own line in Devanagari — the font fallback the `.deva` name line already relies on.
    name: "road-devanagari",
    displayName: "Ramesh Prasad",
    snapshot: roadSnapshot(),
    attributes: {
      has_work_history: true,
      availability: { status: "immediate" },
      shift_preference: "rotational",
    },
    storedBrief: answered(
      "मैं आठ साल से घरों और दुकानों की वायरिंग, पैनल और एमसीबी का काम करता हूँ।",
    ),
    employments: ROAD_DATED_EMPLOYMENTS,
    expectedBrief: "मैं आठ साल से घरों और दुकानों की वायरिंग, पैनल और एमसीबी का काम करता हूँ।",
  },
  {
    // THE DENSEST ROAD SHEET: a 160-code-point brief, twelve skills, two machines, every term.
    name: "road-dense",
    displayName: "Dinesh Chauhan",
    snapshot: roadSnapshot({
      skill_labels: [
        ...ROAD_SKILLS,
        "Distribution board wiring",
        "Three-phase motor connection",
        "Inverter and battery installation",
        "Solar panel wiring",
        "Fault finding with multimeter",
        "Meter board installation",
        "Street light maintenance",
      ],
      machines: ["Drill machine", "Megger"],
    }),
    attributes: {
      has_work_history: true,
      salary_expected_min: 24000,
      salary_expected_max: 30000,
      availability: { status: "serving_notice", notice_period_days: 45 },
      shift_preference: "any",
      work_types: ["permanent", "contract", "daily_wage"],
    },
    storedBrief: answered(ROAD_DENSE_BRIEF),
    employments: ROAD_DATED_EMPLOYMENTS,
    expectedBrief: ROAD_DENSE_BRIEF,
  },
  {
    // Only the lower end of the band: a point figure, and the worker's own asking price.
    name: "road-band-min-only",
    displayName: "Anil Sharma",
    snapshot: roadSnapshot(),
    attributes: { has_work_history: true, salary_expected_min: 15000 },
    storedBrief: DECLINED,
    employments: ROAD_DATED_EMPLOYMENTS,
    expectedBrief: ROAD_FALLBACK_DATED,
  },
  {
    // Only the upper end: still his number, printed as the band's single figure.
    name: "road-band-max-only",
    displayName: "Vijay Singh",
    snapshot: roadSnapshot(),
    attributes: { has_work_history: true, salary_expected_max: 25000 },
    storedBrief: DECLINED,
    employments: ROAD_DATED_EMPLOYMENTS,
    expectedBrief: ROAD_FALLBACK_DATED,
  },
];

/** A persona by name; throws on a typo so a suite cannot silently test nothing. */
export function roadPersona(name: string): RoadPersona {
  const found = ROAD_PERSONAS.find((p) => p.name === name);
  if (!found) throw new Error(`no road persona "${name}"`);
  return found;
}

/**
 * The context a CALLER builds for this persona — pack-less rows, the dated clock, the registered
 * city, and the road marker with the caller's re-check decided exactly as production decides it
 * (`ownBriefUsable` against the worker's real name, never passed in the context itself).
 */
export function roadContext(
  persona: RoadPersona,
  over: Partial<TradeSheetContext> = {},
): TradeSheetContext {
  return {
    packId: null,
    attributes: {
      ...persona.attributes,
      ...(persona.storedBrief === undefined ? {} : { profile_brief: persona.storedBrief }),
    },
    employments: persona.employments,
    employmentsUnavailable: false,
    asOf: ROAD_AS_OF,
    currentCity: "Faridabad",
    currentState: "Haryana",
    generalRoad: { ownBriefUsable: ownBriefUsable(persona.storedBrief, persona.displayName) },
    ...over,
  };
}
