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
  | "supervisor";

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
}

export const TRADE_LEVEL_PACKS: Readonly<Record<string, TradeLevelPack>> = {
  qp_cnc_turning: { skillId: "mskill_cnc_turner", levelKey: "turning_level" },
  qp_vmc_milling: { skillId: "mskill_vmc_operator", levelKey: "milling_level" },
  qp_cnc_grinding: { skillId: "mskill_cnc_grinding_operator", levelKey: "grinding_level" },
  qp_cam_programming: { skillId: "mskill_cam_programmer", levelKey: "cam_level" },
};

/** Legacy/alias spellings that name a `TradeLevel` without being one. */
const LEVEL_KEY_ALIASES: Readonly<Record<string, TradeLevel>> = {
  setter_cum_programmer: "setter_programmer",
  settercumprogrammer: "setter_programmer",
  "setter-cum-programmer": "setter_programmer",
  junior: "junior_programmer",
  senior: "senior_programmer",
};

/** A stored level answer → its `TradeLevel`, or null when it names no rung. */
export function normalizeTradeLevelKey(raw: unknown): TradeLevel | null {
  if (typeof raw !== "string") return null;
  const folded = raw.trim().toLowerCase().replace(/[\s_]+/g, "_");
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
};

/**
 * Rungs that confirm the level (P1 column contract: "Setter and above only").
 *
 * PER LADDER, stated once. Turner/VMC: setter and up. Grinding stops at
 * setter-cum-programmer (no programmer rung exists). CAM: programmer and up —
 * a junior is still proving out. CAD ladders: senior/lead rungs only.
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
  switch (level) {
    case "helper":
    case "trainee":
    case "operator":
    case "draughtsman":
    case "trainee_modeller":
    case "cad_designer":
    case "junior_programmer":
      return "lower";
    default:
      return "higher";
  }
}

/**
 * The headline label for one pack's stored level answer, or null when the worker
 * stated no rung. Read by the Verdict Line and the profile headline — the same
 * closed vocabulary on both, so the sheet and the headline can never disagree.
 */
export function tradeLevelLabelFor(packId: string, rawValue: unknown): string | null {
  if (!(packId in TRADE_LEVEL_PACKS)) return null;
  const level = normalizeTradeLevelKey(rawValue);
  if (level === null) return null;
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
 * The authored skill rows for one pack's projected answers (Middle Way P5 persist).
 *
 * AT MOST ONE ENTRY: v1 packs ask one level question each. Unknown packs, unstated
 * rungs and unmapped spellings yield nothing — NULL is "not stated", and a row is
 * never written for a rung the worker did not claim. Version suffixes (`@3`) are
 * stripped: the crosswalk is keyed by pack, and packs are immutable per version.
 *
 * `levelConfirmed` follows the P1 column contract (Setter and above only); the
 * trade skill comes from the pack, never from the worker's words.
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
  return [{ skillId: entry.skillId, tradeLevel: level, levelConfirmed: isLevelConfirmed(level) }];
}

/** A single-select answer's text, or null when it is not one clean string. */
function singleText(raw: unknown): string | null {
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw) && raw.length === 1 && typeof raw[0] === "string") return raw[0];
  return null;
}
