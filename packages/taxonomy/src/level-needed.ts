import type { PostingTradeKind } from "./posting-trades";
import { isLevelConfirmed, type TradeLevel } from "./trade-levels";

/**
 * "LEVEL NEEDED" — the employer-side level sort (CEO ruling, 30 Oct 2026, Q3 = A: sort only,
 * never hide; ADR-0061).
 *
 * WHAT THIS IS. A posting may name one minimum rung ("Setter needed" = Setter and above). On the
 * applicant list, inside each trade group, workers then fall into three groups:
 *
 *   meets          his rung is the needed rung or above          → top
 *   not_confirmed  no rung stated, a rung this ladder does not   → middle, tagged
 *                  know, or an upper rung whose separating          "Level not confirmed"
 *                  question he answered "koi aur"
 *   below          his rung is under the needed rung             → bottom
 *
 * This file is the whole of that rule: which trades it is on for, each trade's rung order, and
 * the three-way fit. The SQL in `match-feed.repository.ts` and `rankKeyCompare` in
 * `@badabhai/match-engine` both consume the {@link LevelNeededSpec} built here, and
 * `rank-parity.test.ts` pins the two to each other.
 *
 * WHAT THIS IS NOT. It never decides who is listed — reach and visibility are untouched, and a
 * worker in any group is still on the list. It is not a score: three ordered groups, no weights.
 * It never reads the worker's live profile: the rung it is handed is the one frozen onto his
 * application at apply time (`applications.trade_level`, migration 0153).
 */

/**
 * The trades whose applicant list sorts by "Level needed" (30 Oct ruling Q4 step 1: "Turn on for
 * the 4 CNC trades"). The next trades join one at a time, each on the CEO's sign-off — a one-line
 * change here plus a {@link LEVEL_SORT_LADDERS} row, which the exhaustiveness test enforces.
 */
export const LEVEL_SORT_TRADE_KINDS = [
  "cnc_turner",
  "vmc_milling",
  "cnc_grinding",
  "cam_programmer",
] as const satisfies readonly PostingTradeKind[];

export type LevelSortTradeKind = (typeof LEVEL_SORT_TRADE_KINDS)[number];

/** Whether a posting's `role_kind` is one the level sort is on for. */
export function isLevelSortTradeKind(value: unknown): value is LevelSortTradeKind {
  return typeof value === "string" && (LEVEL_SORT_TRADE_KINDS as readonly string[]).includes(value);
}

/** One trade's sort ladder: rungs lowest first, plus the legacy keys that name one of them. */
export interface LevelSortLadder {
  /** The CEO ladder for the trade (Launch Plan Pack v1 sheets), lowest rung first. */
  readonly rungs: readonly TradeLevel[];
  /**
   * Stored keys that are not on the ladder but that a CEO ruling equates with a rung, so a worker
   * who answered an older pack — or a posting made from the older posting ladder — sorts where
   * that ruling puts him rather than in "not confirmed".
   */
  readonly aliases: Readonly<Partial<Record<TradeLevel, TradeLevel>>>;
}

/**
 * Launch Pack v1 §2 (shared level words): "helper, trainee, fresher … → `trainee`". Older packs
 * and the posting ladder still carry `helper`; it sorts as a trainee.
 */
const HELPER_IS_TRAINEE = { helper: "trainee" } as const satisfies LevelSortLadder["aliases"];

/** Sheets 1 and 2 (CNC Turner, VMC/HMC): one ladder, confirmed from `setter`. */
const CNC_MACHINE_LADDER: LevelSortLadder = {
  rungs: ["trainee", "operator", "setter", "setter_programmer", "programmer", "supervisor"],
  aliases: HELPER_IS_TRAINEE,
};

/**
 * The rung order per trade. Rungs are the CEO sheets' keys, in the sheets' order:
 *  - sheet 15 (CNC Grinding) stops at `setter_programmer` — there is no programmer rung;
 *  - sheet 3 (CAM) is `trainee → programmer → senior → lead → supervisor`. `qp_cam_programming@3`
 *    stored `junior_programmer` / `senior_programmer`, and the posting catalogue offered them
 *    until #2550 (older postings still carry them, as legacy rungs); the CEO reconciliation (2 Nov) rules bare "junior" a trainee claim, and sheet 3 labels
 *    the `senior` rung "Senior Programmer".
 * A key on neither the ladder nor its aliases (a turner's `setter` on a CAM post) is never
 * guessed into a position: it sorts as "not confirmed".
 */
export const LEVEL_SORT_LADDERS: Readonly<Record<LevelSortTradeKind, LevelSortLadder>> = {
  cnc_turner: CNC_MACHINE_LADDER,
  vmc_milling: CNC_MACHINE_LADDER,
  cnc_grinding: {
    rungs: ["trainee", "operator", "setter", "setter_programmer", "supervisor"],
    aliases: HELPER_IS_TRAINEE,
  },
  cam_programmer: {
    rungs: ["trainee", "programmer", "senior", "lead", "supervisor"],
    aliases: { junior_programmer: "trainee", senior_programmer: "senior" },
  },
};

/**
 * One posting's level sort, as stored keys. The SQL tests membership with these arrays verbatim
 * and {@link levelFitFor} does the same, so the two cannot disagree about a key.
 */
export interface LevelNeededSpec {
  /** The needed rung, on the trade's ladder (an alias already resolved). */
  readonly needed: TradeLevel;
  /** Keys under the needed rung → `below`. */
  readonly below: readonly TradeLevel[];
  /** Keys at or above it that carry no separating question → `meets`. */
  readonly meets: readonly TradeLevel[];
  /**
   * Keys at or above it that DO carry a separating question (Setter and above on the CNC
   * ladders) → `meets` only when the frozen `level_confirmed` is true, `not_confirmed` otherwise
   * (owner ruling 2026-11-04: a "koi aur" answer is not a confirmed level).
   */
  readonly meetsIfConfirmed: readonly TradeLevel[];
}

/**
 * The level sort for a posting, or null when it has none — "Any level" (no rung), a trade the sort
 * is not on for, or a rung the trade's ladder does not know. Null means the list is ordered
 * exactly as it was before this rule existed (ruling Q2: "everything behaves exactly as today").
 */
export function levelNeededSpec(
  roleKind: string | null | undefined,
  neededRung: string | null | undefined,
): LevelNeededSpec | null {
  if (!isLevelSortTradeKind(roleKind) || typeof neededRung !== "string") return null;
  const ladder = LEVEL_SORT_LADDERS[roleKind];
  const needed = rungOn(ladder, neededRung.trim());
  if (needed === null) return null;
  const neededAt = ladder.rungs.indexOf(needed);

  const below: TradeLevel[] = [];
  const meets: TradeLevel[] = [];
  const meetsIfConfirmed: TradeLevel[] = [];
  for (const key of keysOf(ladder)) {
    const rung = rungOn(ladder, key)!;
    if (ladder.rungs.indexOf(rung) < neededAt) below.push(key);
    else if (isLevelConfirmed(rung)) meetsIfConfirmed.push(key);
    else meets.push(key);
  }
  return { needed, below, meets, meetsIfConfirmed };
}

/** Where a worker's frozen rung puts him against a posting's level sort. */
export type LevelFit = "meets" | "not_confirmed" | "below";

/** The sort position of each fit — lower sorts first. Ordered groups, not points. */
export const LEVEL_FIT_ORDER: Readonly<Record<LevelFit, 0 | 1 | 2>> = {
  meets: 0,
  not_confirmed: 1,
  below: 2,
};

/**
 * THE REFERENCE FIT — the SQL `CASE` in `levelSortKey` (match-feed.repository.ts) spells the same
 * three tests in the same order: below, meets, meets-if-confirmed, else not confirmed.
 */
export function levelFitFor(
  spec: LevelNeededSpec,
  rung: string | null,
  levelConfirmed: boolean | null,
): LevelFit {
  if (rung === null) return "not_confirmed";
  if (includes(spec.below, rung)) return "below";
  if (includes(spec.meets, rung)) return "meets";
  if (levelConfirmed === true && includes(spec.meetsIfConfirmed, rung)) return "meets";
  return "not_confirmed";
}

/** A key → its rung on this ladder, or null when the ladder does not know it. */
function rungOn(ladder: LevelSortLadder, key: string): TradeLevel | null {
  if (includes(ladder.rungs, key)) return key as TradeLevel;
  return ladder.aliases[key as TradeLevel] ?? null;
}

/** Every key the ladder places: its rungs, then its aliases. */
function keysOf(ladder: LevelSortLadder): TradeLevel[] {
  return [...ladder.rungs, ...(Object.keys(ladder.aliases) as TradeLevel[])];
}

function includes(list: readonly string[], key: string): boolean {
  return list.includes(key);
}
