/**
 * The promotion HOLD register — the thing that makes a partial promotion describable.
 *
 * ===========================================================================
 * WHY THIS EXISTS, AND WHY IT IS NOT A WAIVER
 * ===========================================================================
 * `promote-skills` is fail-closed for a whole batch, and its refusal says why:
 *
 *   "promoting the passing subset would leave the corpus half live, with no single
 *    description of what is retrievable"
 *
 * Read that carefully — the objection is not to promoting a subset. It is to promoting a
 * subset that NOTHING DESCRIBES. This file is that description. With it, a partial promotion
 * has a reviewable boundary in git: a named set, a measured reason per member, and the ruling
 * that authorised it. Without it, the fail-closed rule is exactly right and must stand.
 *
 * So the register narrows the SELECTION. It does not touch the JUDGEMENT:
 *
 *   - Every held skill is still judged against every criterion, in full.
 *   - Its verdict is still written to the promotion report.
 *   - Its failure is still a failure; `RESOLVABLE_ABOVE_FLOOR` still fails for all 34.
 *   - The floor does not move, no criterion is waived, and `CRITERIA` is untouched.
 *   - Within the selected set the all-or-nothing rule is unchanged: one blocked skill there
 *     still refuses the entire run.
 *
 * A WAIVER SAYS "this failure does not count". A HOLD SAYS "this failure counts, and the
 * skill therefore is not in the batch." The first promotes a skill that cannot be assigned;
 * the second leaves it provisional — the state that already correctly describes it.
 *
 * ===========================================================================
 * WHY THE REGISTER CANNOT QUIETLY BECOME A SILENCER
 * ===========================================================================
 * The obvious failure mode of any exclusion list is that it grows into a way to make
 * inconvenient failures disappear. Three properties stop that, and each is enforced here
 * rather than left to review:
 *
 *  1. A HOLD AUTHORISES EXACTLY ONE CRITERION. An entry names the criterion it covers. If the
 *     skill is blocked by anything else as well — an unembedded alias, a lost active edge, a
 *     status somebody changed — the hold does not cover it: `UNAUTHORISED`, refused on apply.
 *     A hold for a below-floor score can never hide a corpus-integrity defect.
 *
 *  2. A HOLD MUST STILL BE TRUE. If a held skill now passes everything, the register is
 *     stale and no longer describes the batch: `RELEASABLE`, refused on apply. The ruling
 *     authorised 62-and-34 as MEASURED, so a drifted register means the authorisation no
 *     longer matches reality. The fix is to delete the entry — which is also exactly how a
 *     skill returns to the batch after its corpus work lands.
 *
 *  3. OMISSION IS SELF-CORRECTING. A mistyped or missing id does not silently promote
 *     anything: the real skill stays in the selected set, fails its criterion there, and the
 *     unchanged fail-closed rule refuses the whole run. The register can only ever cause harm
 *     by COMMISSION, and commission is bounded by (1) and (2).
 *
 * PURE: no database, no clock, no filesystem beyond one explicit read. Same reason `judge` is
 * pure — the policy has to be assertable without a corpus.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

import type { Verdict } from "./promote-skills";
import { CRITERIA, isCriterion, type Criterion } from "./promotion-criteria";

/** Git-tracked, beside the corpus it describes — same convention as `decollided-aliases.json`. */
export const DEFAULT_HOLD_REGISTER = join(__dirname, "..", "data", "taxonomy", "held-skills.json");

const REPO_ROOT = join(__dirname, "..", "..", "..");

/**
 * How the register is NAMED in a promotion report.
 *
 * Resolution stays absolute — that is the only way to be sure which file was read — but the
 * artifact records a repo-relative, forward-slashed path. A committed audit record should not
 * carry an operator's home directory, and a reader on another machine has to be able to open
 * the file it names. Falls back to the absolute path for a register outside the repo, because
 * an unopenable honest path beats a tidy misleading one.
 */
export function displayRegisterPath(path: string): string {
  const rel = relative(REPO_ROOT, path);
  return rel === "" || rel.startsWith("..") ? path : rel.split(sep).join("/");
}

export interface HoldEntry {
  skill_id: string;
  /** The ONE criterion this hold authorises a failure of. */
  criterion: Criterion;
  /** Grouping for the improvement queue, e.g. CORRECT_BUT_BELOW_FLOOR. */
  category: string;
  /** What was measured when the hold was recorded. `null` where nothing resolved at all. */
  best_correct_score: number | null;
  gap_to_floor: number | null;
  detail: string;
}

export interface HoldRegister {
  kind: "promotion-holds";
  why: string;
  /** The owner decision that authorised these exclusions. Required and non-empty. */
  ruling: string;
  recorded_at: string;
  measured_from: Record<string, unknown>;
  improvement_queue: string;
  holds: HoldEntry[];
}

export type HoldState = "HELD" | "RELEASABLE" | "UNAUTHORISED";

export interface HoldDisposition {
  skill_id: string;
  state: HoldState;
  /** The criterion the register authorises a failure of. */
  authorised: Criterion;
  /** What the skill is ACTUALLY blocked by right now. Empty when it passes everything. */
  actually_blocking: Criterion[];
  category: string;
}

export interface HoldReconciliation {
  /** Verdicts that stay in the batch and are judged for promotion. */
  selected: Verdict[];
  /** Verdicts excluded by the register — legitimately or not; see `dispositions`. */
  held: Verdict[];
  dispositions: HoldDisposition[];
  /** Held skills that now pass everything: the register no longer describes the batch. */
  releasable: HoldDisposition[];
  /** Held skills blocked by something the hold does not authorise. */
  unauthorised: HoldDisposition[];
  /**
   * Register ids absent from this batch's scope. INFORMATIONAL, not a refusal: one register
   * may legitimately span batches, and an id that should have matched but does not cannot
   * cause an over-promotion — see property (3) in the header.
   */
  unknown: string[];
}

/**
 * Read and validate a register. Throws rather than degrading: a malformed exclusion list must
 * resolve to neither "exclude nothing" nor "exclude something nobody named".
 */
export function loadHoldRegister(path: string): HoldRegister {
  if (!existsSync(path)) {
    throw new Error(
      `[promotion-holds] ${path} does not exist. Pass --hold-register <path>, or write an ` +
        `empty register (holds: []) to state explicitly that nothing is held. A missing file ` +
        `is not the same claim as an empty one.`,
    );
  }
  const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<HoldRegister>;
  if (raw.kind !== "promotion-holds") {
    throw new Error(
      `[promotion-holds] ${path}: kind must be "promotion-holds", got ${String(raw.kind)}`,
    );
  }
  if (typeof raw.ruling !== "string" || raw.ruling.trim().length === 0) {
    throw new Error(
      `[promotion-holds] ${path}: "ruling" is required and must name the owner decision that ` +
        `authorised these exclusions. An unattributed exclusion list is a waiver with no signature.`,
    );
  }
  if (!Array.isArray(raw.holds)) {
    throw new Error(`[promotion-holds] ${path}: "holds" must be an array`);
  }
  const seen = new Set<string>();
  for (const [i, h] of raw.holds.entries()) {
    const where = `${path} holds[${i}]`;
    if (typeof h?.skill_id !== "string" || h.skill_id.length === 0) {
      throw new Error(`[promotion-holds] ${where}: missing skill_id`);
    }
    if (seen.has(h.skill_id)) {
      // Two entries could authorise two different criteria for one skill, which is a broader
      // permission than either states. Refused rather than merged.
      throw new Error(
        `[promotion-holds] ${where}: ${h.skill_id} is held twice — ambiguous authorisation`,
      );
    }
    seen.add(h.skill_id);
    if (typeof h.criterion !== "string" || !isCriterion(h.criterion)) {
      throw new Error(
        `[promotion-holds] ${where}: criterion ${String(h.criterion)} is not a promotion ` +
          `criterion. One of: ${CRITERIA.join(", ")}`,
      );
    }
  }
  return raw as HoldRegister;
}

/** Partition a batch's verdicts against the register. PURE. */
export function reconcileHolds(
  verdicts: readonly Verdict[],
  register: HoldRegister,
): HoldReconciliation {
  const byId = new Map(register.holds.map((h) => [h.skill_id, h]));
  const selected: Verdict[] = [];
  const held: Verdict[] = [];
  const dispositions: HoldDisposition[] = [];

  for (const v of verdicts) {
    const entry = byId.get(v.skill_id);
    if (entry === undefined) {
      selected.push(v);
      continue;
    }
    held.push(v);
    // The subset test is the whole safety property: the hold covers `entry.criterion` and
    // nothing else, so any OTHER blocking criterion escapes it.
    const escaped = v.blocking.filter((c) => c !== entry.criterion);
    const state: HoldState = v.eligible
      ? "RELEASABLE"
      : escaped.length > 0
        ? "UNAUTHORISED"
        : "HELD";
    dispositions.push({
      skill_id: v.skill_id,
      state,
      authorised: entry.criterion,
      actually_blocking: [...v.blocking],
      category: entry.category,
    });
  }

  const inScope = new Set(verdicts.map((v) => v.skill_id));
  return {
    selected,
    held,
    dispositions,
    releasable: dispositions.filter((d) => d.state === "RELEASABLE"),
    unauthorised: dispositions.filter((d) => d.state === "UNAUTHORISED"),
    unknown: register.holds
      .map((h) => h.skill_id)
      .filter((id) => !inScope.has(id))
      .sort(),
  };
}

/**
 * The refusal message, or null when the register still describes the batch.
 *
 * Shaped like `vocabularyTripwireError`: reported in PLAN so an operator can see the whole
 * gate report at once, enforced where the mutation is.
 */
export function holdTripwireError(
  rec: HoldReconciliation,
  script: string,
  path: string,
): string | null {
  if (rec.releasable.length === 0 && rec.unauthorised.length === 0) return null;
  const lines = [`[${script}] THE HOLD REGISTER NO LONGER DESCRIBES THIS BATCH — ${path}`];
  if (rec.releasable.length > 0) {
    lines.push(
      ``,
      `  RELEASABLE (${rec.releasable.length}) — held, but now passes EVERY criterion. The ruling`,
      `  authorised a MEASURED split; these are no longer on the side it put them. Delete the`,
      `  entry to return the skill to the batch — that is the intended way out of the queue.`,
      ...rec.releasable.map((d) => `     ${d.skill_id}`),
    );
  }
  if (rec.unauthorised.length > 0) {
    lines.push(
      ``,
      `  UNAUTHORISED (${rec.unauthorised.length}) — held for one criterion, blocked by another. A`,
      `  hold covers exactly the failure it names; it is not a general exemption, and this is`,
      `  the case it exists to catch. Fix the new failure, or record it explicitly.`,
      ...rec.unauthorised.map(
        (d) =>
          `     ${d.skill_id.padEnd(46)} authorised ${d.authorised} · blocked by ${d.actually_blocking.join(", ")}`,
      ),
    );
  }
  lines.push(
    ``,
    `  NOT WAIVABLE. Nothing here is a judgement about a number; it is the register disagreeing`,
    `  with the measurement. Re-measure or re-record, then run again.`,
  );
  return lines.join("\n");
}
