/**
 * Middle-Way trade level (P1, additive; moved to taxonomy in P5 so the C6 crosswalk,
 * the persist writer and the headline share one union with the column).
 *
 * Per worker per trade, stored on the `worker_profile_skill` row whose skillId is the
 * trade's `mskill_*`. NULL = not stated, never guessed. Closed per-trade ladders live
 * in `docs/middle-way/LADDERS.md`; validation is app-level so new ladders never need
 * a migration. Old `level` column is untouched.
 */
export type TradeLevel =
  | "helper"
  | "trainee"
  | "operator"
  | "draughtsman"
  | "trainee_modeller"
  | "cad_designer"
  | "setter"
  | "setter_programmer"
  | "programmer"
  | "junior_programmer"
  | "senior_programmer"
  | "senior_draughtsman"
  | "senior_designer"
  | "lead_checker"
  | "design_engineer_lead"
  | "supervisor"
  // CEO Launch Pack v1 (RULED 2026-11-02, reconciled) — the shared rung vocabulary.
  // `helper`, `junior_programmer` and the CAD keys above stay for history (stored rows
  // keep rendering); new packs use these. "Do not invent new keys" — these are the
  // CEO's, not ours.
  | "skilled"
  | "senior"
  | "technician"
  | "senior_technician"
  | "inspector"
  | "senior_inspector"
  | "qc_engineer"
  | "designer"
  | "lead"
  // Track B #1 (CEO Launch Plan Pack v1, sheet 6) — the fitter rungs. `fitter`
  // is Lower (operator rung), `senior_fitter` Higher; both stored by
  // qp_fitter@1 already, rendered null until this extension.
  | "fitter"
  | "senior_fitter"
  // Track B #2 (CEO Launch Plan Pack v1, sheet 7) — the electrician operator
  // rung. Lower; stored by qp_industrial_electrician@1 already, rendered null
  // until this extension.
  | "electrician"
  // Track B #3 (CEO Launch Plan Pack v1, sheet 8) — the welder operator rung.
  // Lower; stored by qp_welding_trade@1 already, rendered null until now.
  | "welder";

/**
 * C6 CROSSWALK — pack level answers → trade skill + `trade_level` (Middle Way P5).
 *
 * WHAT THIS IS. The sample names its rungs per trade ("Setter", "Programmer"); the
 * code stores one `TradeLevel` key per worker per trade on the `worker_profile_skill`
 * row whose skill is the trade's `mskill_*`. This file is the whole of that mapping:
 * which pack answers carry a level, which trade skill each pack's level attaches to,
 * how a stored answer normalises to a `TradeLevel`, which rungs count as confirmed,
 * and which price tier a rung prices at.
 *
 * WHAT THIS IS NOT. It is never read by the match engine — `PACK_ANSWER_SKILLS` is
 * the only table the derive path reads, and nothing here is imported by it. Writing
 * a level row changes zero reach rows and zero rank positions (P5 DoD §7.7/8): the
 * rows are display-only, same contract as P1's columns.
 *
 * KEY CANONICALISATION. Packs author `option_key: setter_cum_programmer` but store
 * `value_text: setter_programmer` (qp_cnc_turning@3); either spelling — and the
 * label the worker tapped — must land on the one `TradeLevel`. Unknown strings
 * return null rather than guessing: NULL is "not stated", never a wrong rung.
 */

/** A pack whose level answer carries a trade rung, and the trade it attaches to. */
export interface TradeLevelPack {
  /** The trade skill the level row is written against. */
  readonly skillId: string;
  /** The `worker_attributes` key holding the level answer (the pack's `target_field`). */
  readonly levelKey: string;
  /**
   * Per-trade display labels, when the trade's own words differ from the shared
   * crosswalk (CEO Launch Plan Pack v1, Track A #5): the 2D sheet headlines
   * "Senior Draughtsman", never "Senior Designer". Absent = shared labels.
   */
  readonly labels?: Readonly<Partial<Record<TradeLevel, string>>>;
}

export const TRADE_LEVEL_PACKS: Readonly<Record<string, TradeLevelPack>> = {
  qp_cnc_turning: { skillId: "mskill_cnc_turner", levelKey: "turning_level" },
  qp_vmc_milling: { skillId: "mskill_vmc_operator", levelKey: "milling_level" },
  qp_cnc_grinding: { skillId: "mskill_cnc_grinding_operator", levelKey: "grinding_level" },
  qp_cam_programming: { skillId: "mskill_cam_programmer", levelKey: "cam_level" },
  // Track A #4 — the 3D CAD Designer (CEO Launch Plan Pack v1, sheet 4).
  qp_cad_design_3d: { skillId: "mskill_cad_designer_3d", levelKey: "design_level" },
  // Track A #5 — the 2D Draughtsman (CEO Launch Plan Pack v1, sheet 5). Labels
  // are the trade's own words (sheet headline "Senior Draughtsman").
  qp_cad_drafting: {
    skillId: "mskill_designer",
    levelKey: "cad_level",
    labels: {
      trainee: "Trainee",
      designer: "Draughtsman",
      senior_designer: "Senior Draughtsman",
      lead: "Lead",
      supervisor: "Head",
    },
  },
  // Track B #1 — the fitter (CEO Launch Plan Pack v1, sheet 6). Shared labels
  // already print the trade's words (Fitter / Skilled / Senior Fitter).
  qp_fitter: { skillId: "mskill_fitter", levelKey: "fitter_level" },
  // Track B #2 — the electrician (CEO Launch Plan Pack v1, sheet 7). The
  // stored `senior` key IS the sheet's senior_technician rung (Higher,
  // confirmed); shared labels print it. Supervisor by rule (no confirm item).
  qp_industrial_electrician: { skillId: "mskill_industrial_electrician", levelKey: "electrician_level" },
  // Track B #3 — the welder (CEO Launch Plan Pack v1, sheet 8). Shared labels
  // already print the trade's words (Welder / Skilled / Senior / Supervisor).
  qp_welding_trade: { skillId: "mskill_welder", levelKey: "welder_level" },
  // Track B #4 — the conventional machinist (CEO Launch Plan Pack v1,
  // sheet 9). No union extension: `skilled`/`senior` already confirm,
  // helper/operator already Lower. Supervisor by rule (no confirm item).
  qp_conventional_machining: { skillId: "mskill_conventional_machinist", levelKey: "machining_level" },
  // Track B #5 — the sheet-metal operator (CEO Launch Plan Pack v1,
  // sheet 10). No union extension either. Supervisor by rule.
  qp_sheet_metal_fab: { skillId: "mskill_sheet_metal_worker", levelKey: "sheet_metal_level" },
};

/** Legacy/alias spellings that name a `TradeLevel` without being one. */
const LEVEL_KEY_ALIASES: Readonly<Record<string, TradeLevel>> = {
  setter_cum_programmer: "setter_programmer",
  settercumprogrammer: "setter_programmer",
  "setter-cum-programmer": "setter_programmer",
  // Track B #3 (CEO Launch Plan Pack v1, sheet 8): qp_welding_trade@1 stored
  // `certified_welder` for the skilled rung; @2 keeps the key as a history
  // chip. The alias lands old answers on `skilled` (confirmed, Higher).
  certified_welder: "skilled",
  // CEO Launch Pack v1 (RULED 2026-11-02, reconciled): bare "junior" is a trainee
  // claim now (no ladder carries `junior_programmer` anymore; that key stays for
  // history). Bare "senior" needs no alias: it IS a union member and the union
  // check runs first — the old `senior → senior_programmer` row is deleted, not
  // left to mislead.
  junior: "trainee",
};

/** A stored level answer → its `TradeLevel`, or null when it names no rung. */
export function normalizeTradeLevelKey(raw: unknown): TradeLevel | null {
  if (typeof raw !== "string") return null;
  const folded = raw
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "_");
  if ((Object.keys(TRADE_LEVEL_LABELS) as string[]).includes(folded)) {
    return folded as TradeLevel;
  }
  const aliased = LEVEL_KEY_ALIASES[folded] ?? LEVEL_KEY_ALIASES[raw.trim().toLowerCase()];
  return aliased ?? null;
}

/** The display label for a rung — the closed vocabulary the headline prints. */
export const TRADE_LEVEL_LABELS: Readonly<Record<TradeLevel, string>> = {
  helper: "Helper",
  trainee: "Trainee",
  operator: "Operator",
  draughtsman: "Draughtsman",
  trainee_modeller: "Trainee Modeller",
  cad_designer: "CAD Designer",
  setter: "Setter",
  setter_programmer: "Setter-cum-Programmer",
  programmer: "Programmer",
  junior_programmer: "Junior Programmer",
  senior_programmer: "Senior Programmer",
  senior_draughtsman: "Senior Draughtsman",
  senior_designer: "Senior Designer",
  lead_checker: "Lead Checker",
  design_engineer_lead: "Design Engineer Lead",
  supervisor: "Supervisor",
  // CEO shared vocabulary — display labels from the trade sheets (chip-adjacent,
  // not chip text: chips vary by trade, keys do not).
  skilled: "Skilled",
  senior: "Senior",
  technician: "Technician",
  senior_technician: "Senior Technician",
  inspector: "Inspector",
  senior_inspector: "Senior Inspector",
  qc_engineer: "QC Engineer",
  designer: "Designer",
  lead: "Lead",
  // Track B #1 — the fitter rungs (CEO Launch Plan Pack v1, sheet 6).
  fitter: "Fitter",
  senior_fitter: "Senior Fitter",
  // Track B #2 — the electrician operator rung (sheet 7).
  electrician: "Electrician",
  // Track B #3 — the welder operator rung (sheet 8).
  welder: "Welder",
};

/**
 * Rungs that confirm the level (P1 column contract: "Setter and above only").
 *
 * PER LADDER, stated once. Turner/VMC: setter and up. Grinding stops at
 * setter-cum-programmer (no programmer rung exists). CAM: programmer and up —
 * a junior is still proving out. CAD ladders: senior/lead rungs only.
 *
 * CEO Launch Pack v1 (RULED 2026-11-02, reconciled) — one separating rung per
 * sheet: skilled-ladder trades confirm from `skilled`; technician ladders from
 * `senior_technician`; QC from `senior_inspector`; design ladders from
 * `senior_designer`; `lead` and `senior` confirm everywhere they appear (all
 * Higher). Supervisor confirms in every trade (Q4).
 */
const CONFIRMED_RUNGS: ReadonlySet<string> = new Set([
  "setter",
  "setter_programmer",
  "programmer",
  "senior_programmer",
  "supervisor",
  "senior_draughtsman",
  "senior_designer",
  "lead_checker",
  "design_engineer_lead",
  "skilled",
  "senior",
  "senior_technician",
  "senior_inspector",
  "qc_engineer",
  "lead",
  // Track B #1 — the fitter senior rung confirms (sheet 6: Senior Fitter Higher).
  "senior_fitter",
]);

/** True once the separating question was answered (Setter and above only). */
export function isLevelConfirmed(level: TradeLevel | null): boolean {
  return level !== null && CONFIRMED_RUNGS.has(level);
}

/**
 * The unlock price tier for a rung (spec §4.1 — HOOK ONLY, ₹40 flat stays live).
 *
 * Higher: Setter and above (+ Senior/Lead equivalents). Lower: Helper, Operator,
 * null and the CAD trainee/draughtsman/modeller equivalents. Null prices Lower —
 * an unstated level must never price a worker up.
 */
export function priceTierForTradeLevel(level: TradeLevel | null): "higher" | "lower" {
  if (level === null) return "lower";
  return levelTier(level);
}

/**
 * The unlock price tier for a worker's stated rungs (spec §4.1 — hook input).
 *
 * HIGHER if any rung prices Higher, else Lower. An empty list — or a worker who
 * never stated a rung — prices Lower: an unstated level must never price a worker up.
 */
export function priceTierForLevels(levels: readonly (TradeLevel | null)[]): "higher" | "lower" {
  return levels.some((level) => priceTierForTradeLevel(level) === "higher") ? "higher" : "lower";
}

function levelTier(level: TradeLevel): "higher" | "lower" {
  // CEO Launch Pack v1 (RULED 2026-11-02, reconciled) — per-sheet tiers. Lower: the
  // trainee/operator/designer rungs. Everything else Higher.
  // Track B #1 — the fitter operator rung is Lower (sheet 6).
  // Track B #2 — the electrician operator rung is Lower (sheet 7).
  // Track B #3 — the welder operator rung is Lower (sheet 8).
  switch (level) {
    case "helper":
    case "trainee":
    case "operator":
    case "draughtsman":
    case "trainee_modeller":
    case "cad_designer":
    case "junior_programmer":
    case "technician":
    case "inspector":
    case "designer":
    case "fitter":
    case "electrician":
    case "welder":
      return "lower";
    default:
      return "higher";
  }
}

/**
 * The headline label for one pack's stored level answer, or null when the worker
 * stated no rung. Read by the Verdict Line and the profile headline — the same
 * closed vocabulary on both, so the sheet and the headline can never disagree.
 *
 * A pack with its own `labels` (2D Draughtsman today) prints the trade's own
 * words; every other pack prints the shared crosswalk labels.
 */
export function tradeLevelLabelFor(packId: string, rawValue: unknown): string | null {
  if (!(packId in TRADE_LEVEL_PACKS)) return null;
  const entry = TRADE_LEVEL_PACKS[packId]!;
  const level = normalizeTradeLevelKey(rawValue);
  if (level === null) return null;
  const own = entry.labels?.[level];
  if (own !== undefined) return own;
  // `noUncheckedIndexedAccess` widens the lookup; the key is known-good, so a miss
  // is a type-system artefact rather than a second null path — still, never undefined.
  return TRADE_LEVEL_LABELS[level] ?? null;
}

/** One level answer, as the extraction projection carries it. */
export interface LevelAnswerInput {
  readonly attributeKey: string;
  readonly value: unknown;
}

/** A `worker_profile_skill` row the level answer earns. */
export interface TradeLevelEntry {
  readonly skillId: string;
  readonly tradeLevel: TradeLevel;
  readonly levelConfirmed: boolean;
}

/**
 * Separating-confirm items (CEO Launch Plan Pack v1, Track A #1): rung → the
 * pack item that asks the separating question for it. Turner @6 ships four;
 * later retags add their packs' rows here (VMC, CAM, ...), never a new
 * mechanism.
 *
 * The answers are `self` (khud — confirms) or `other` (koi aur — disconfirms).
 * Anything else stored under a confirm key (e.g. the supervisor's free-text
 * team count) counts as an answer, hence confirmed: the worker engaged the
 * separating question instead of skipping it.
 */
export const TRADE_LEVEL_CONFIRM_ITEMS: Readonly<
  Record<string, Readonly<Record<string, string>>>
> = {
  qp_cnc_turning: {
    setter: "setting_confirm",
    setter_programmer: "program_edit_confirm",
    programmer: "program_write_confirm",
    supervisor: "team_confirm",
  },
  // Track A #2 — the VMC/HMC confirms (CEO Launch Plan Pack v1, sheet 2).
  qp_vmc_milling: {
    setter: "milling_setting_confirm",
    setter_programmer: "milling_program_edit_confirm",
    programmer: "milling_program_write_confirm",
    supervisor: "milling_team_confirm",
  },
  // Track A #3 — the CAM confirms (CEO Launch Plan Pack v1, sheet 3).
  // Confirmed from `programmer`: programmer, senior, lead, supervisor.
  qp_cam_programming: {
    programmer: "cam_program_confirm",
    senior: "cam_senior_confirm",
    lead: "cam_lead_confirm",
    supervisor: "cam_team_confirm",
  },
  // Track A #4 — the 3D design confirms (CEO Launch Plan Pack v1, sheet 4).
  // Confirmed from `senior_designer`: senior_designer, lead, supervisor.
  qp_cad_design_3d: {
    senior_designer: "design_senior_confirm",
    lead: "design_lead_confirm",
    supervisor: "design_team_confirm",
  },
  // Track A #5 — the 2D draughtsman confirms (CEO Launch Plan Pack v1, sheet 5).
  // Confirmed from `senior_designer`: senior_designer, lead, supervisor.
  qp_cad_drafting: {
    senior_designer: "cad_senior_confirm",
    lead: "cad_lead_confirm",
    supervisor: "cad_team_confirm",
  },
  // Track B #1 — the fitter confirms (CEO Launch Plan Pack v1, sheet 6).
  // Confirmed from `skilled`: skilled, senior_fitter; supervisor by rule.
  qp_fitter: {
    skilled: "fitter_skilled_confirm",
    senior_fitter: "fitter_team_confirm",
  },
  // Track B #2 — the electrician confirm (CEO Launch Plan Pack v1, sheet 7).
  // Confirmed from `senior` (the sheet's senior_technician rung): senior only;
  // supervisor by rule.
  qp_industrial_electrician: {
    senior: "electrician_senior_confirm",
  },
  // Track B #3 — the welder confirms (CEO Launch Plan Pack v1, sheet 8).
  // Confirmed from `skilled`: skilled, senior; supervisor by rule.
  qp_welding_trade: {
    skilled: "welder_skilled_confirm",
    senior: "welder_senior_confirm",
  },
  // Track B #4 — the conventional confirms (CEO Launch Plan Pack v1, sheet 9).
  // Confirmed from `skilled`: skilled, senior; supervisor by rule.
  qp_conventional_machining: {
    skilled: "machining_skilled_confirm",
    senior: "machining_senior_confirm",
  },
  // Track B #5 — the sheet-metal confirms (CEO Launch Plan Pack v1, sheet 10).
  // Confirmed from `skilled`: skilled, senior; supervisor by rule.
  qp_sheet_metal_fab: {
    skilled: "sheet_skilled_confirm",
    senior: "sheet_senior_confirm",
  },
};

/**
 * The authored skill rows for one pack's projected answers (Middle Way P5 persist).
 *
 * AT MOST ONE ENTRY: v1 packs ask one level question each. Unknown packs, unstated
 * rungs and unmapped spellings yield nothing — NULL is "not stated", and a row is
 * never written for a rung the worker did not claim. Version suffixes (`@3`) are
 * stripped: the crosswalk is keyed by pack, and packs are immutable per version.
 *
 * `levelConfirmed` follows the P1 column contract (Setter and above only); the
 * trade skill comes from the pack, never from the worker's words.
 *
 * CEO Launch Pack v1 (Track A #1): a separating-confirm answer OVERRIDES the
 * rung rule for the rung it asks about — `self` confirms, `other` disconfirms,
 * no confirm answer falls back to the rung rule. The worker's own answer about
 * his own rung outranks the ladder's presumption.
 */
export function tradeLevelEntriesForPackAnswers(
  packId: string | null | undefined,
  attributes: readonly LevelAnswerInput[],
): TradeLevelEntry[] {
  if (packId == null) return [];
  const entry = TRADE_LEVEL_PACKS[packId.split("@")[0]!];
  if (entry === undefined) return [];
  const raw = attributes.find((a) => a.attributeKey === entry.levelKey)?.value;
  const level = normalizeTradeLevelKey(singleText(raw));
  if (level === null) return [];
  return [{ skillId: entry.skillId, tradeLevel: level, levelConfirmed: isConfirmed(packId, level, attributes) }];
}

/**
 * The `level_confirmed` bit for one stated rung: the separating-confirm answer
 * wins when there is one, the rung rule otherwise.
 */
function isConfirmed(
  packId: string,
  level: TradeLevel,
  attributes: readonly LevelAnswerInput[],
): boolean {
  const confirmKey = TRADE_LEVEL_CONFIRM_ITEMS[packId.split("@")[0]!]?.[level];
  if (confirmKey !== undefined) {
    const raw = attributes.find((a) => a.attributeKey === confirmKey)?.value;
    const text = singleText(raw);
    if (text !== null) {
      if (text === "self") return true;
      if (text === "other") return false;
      // A non-chip answer (the supervisor's team count) is still an engagement
      // with the separating question — confirmed, never guessed-against.
      return true;
    }
  }
  return isLevelConfirmed(level);
}

/** A single-select answer's text, or null when it is not one clean string. */
function singleText(raw: unknown): string | null {
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw) && raw.length === 1 && typeof raw[0] === "string") return raw[0];
  return null;
}
