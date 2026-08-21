/**
 * Deprecation crosswalk integrity — does re-tagging a retired skill change what a worker can
 * be matched to?
 *
 * ===========================================================================
 * THE QUESTION NOBODY ASKED
 * ===========================================================================
 * When a skill is deprecated with a successor, `db:retag:skills` moves every stored reference
 * onto the successor. The impact analysis that accompanies such a decision reliably asks
 * *"is any matching signal LOST?"* — and TD-03's does exactly that, concluding for
 * `skill_boring` that `ATTRIBUTE_TO_MATCH_SKILLS` "already maps this to no master-skill — no
 * matching signal is lost."
 *
 * That is true, and it is only half the question. Re-tagging replaces the id, so the worker
 * inherits the SUCCESSOR's bridge mapping. If the successor maps to more than the predecessor
 * did, the worker GAINS a posting-level claim they never made. Nothing is lost; something is
 * invented.
 *
 * For BadaBhai that is the worse direction. Product principle #2 is "never show irrelevant
 * candidates for a job", and a silent gain does precisely that — while a loss merely narrows
 * reach and is visible as a missing match.
 *
 * So this module computes the delta in BOTH directions for every crosswalk, and names the ones
 * that widen it.
 *
 * ===========================================================================
 * WHAT IT DOES NOT DO
 * ===========================================================================
 * It does not change a crosswalk, a status, or a mapping. Whether `skill_boring` should
 * inherit `mskill_cnc_turner` is a triage decision with product consequences and belongs to
 * the bridge owner. This reports it.
 *
 * NO IO. Inputs are values, so every rule is testable without a database.
 */

/** The minimum a corpus row must expose for this audit. */
export interface CrosswalkSkill {
  readonly skillId: string;
  readonly status?: string | undefined;
  readonly replacedBy?: string | undefined;
}

export interface CrosswalkFinding {
  readonly skillId: string;
  readonly replacedBy: string;
  /** Where the chain ends after following `replacedBy` repeatedly. */
  readonly terminal: string | null;
  readonly chainLength: number;
  readonly targetExists: boolean;
  /** A successor that is itself deprecated is a dead end — retagging lands on a retired id. */
  readonly targetIsServable: boolean;
  readonly cyclic: boolean;
  readonly matchSkillsBefore: readonly string[];
  readonly matchSkillsAfter: readonly string[];
  /** Match skills the worker ACQUIRES by being re-tagged. The dangerous direction. */
  readonly gained: readonly string[];
  /** Match skills the worker LOSES. Narrows reach; visible as a missing match. */
  readonly lost: readonly string[];
}

export interface CrosswalkReport {
  readonly findings: readonly CrosswalkFinding[];
  /** `replaced_by` pointing at an id the corpus does not contain. */
  readonly dangling: readonly string[];
  /** A pointer on a row that is not deprecated — the schema CHECK forbids this in the DB. */
  readonly activeWithReplacedBy: readonly string[];
  /** Chains that loop. Retagging one would not terminate. */
  readonly cycles: readonly string[];
  /** Crosswalks that ADD at least one match skill. Each needs an explicit triage decision. */
  readonly widening: readonly string[];
  /** Crosswalks whose successor is itself unservable. */
  readonly deadEnds: readonly string[];
}

const isActive = (s: CrosswalkSkill | undefined): boolean =>
  s !== undefined && (s.status ?? "active") === "active";

/**
 * Follow `replacedBy` to the end of the chain.
 *
 * Cycle-guarded because nothing in the corpus type prevents `a -> b -> a`, and the retag
 * runner would follow the same pointers. Returns the terminal, the number of hops, and
 * whether a loop stopped the walk.
 */
export function resolveTerminal(
  start: string,
  byId: ReadonlyMap<string, CrosswalkSkill>,
): { terminal: string | null; chainLength: number; cyclic: boolean } {
  const seen = new Set<string>([start]);
  let current = start;
  let hops = 0;
  for (;;) {
    const node = byId.get(current);
    if (node === undefined) return { terminal: null, chainLength: hops, cyclic: false };
    const next = node.replacedBy;
    if (next === undefined) return { terminal: current, chainLength: hops, cyclic: false };
    if (seen.has(next)) return { terminal: current, chainLength: hops, cyclic: true };
    seen.add(next);
    current = next;
    hops += 1;
  }
}

/**
 * Audit every crosswalk in the corpus against the runtime bridge.
 *
 * `bridge` is `ATTRIBUTE_TO_MATCH_SKILLS`. A skill absent from it contributes no match skills,
 * which is treated the same as an explicit empty mapping — for THIS question they are
 * identical, and conflating them here does not hide the difference, because the bridge's own
 * exhaustiveness test is what distinguishes them.
 */
export function auditCrosswalk(
  corpus: readonly CrosswalkSkill[],
  bridge: Readonly<Record<string, readonly string[]>>,
): CrosswalkReport {
  const byId = new Map(corpus.map((s) => [s.skillId, s]));
  const findings: CrosswalkFinding[] = [];
  const dangling: string[] = [];
  const activeWithReplacedBy: string[] = [];
  const cycles: string[] = [];
  const widening: string[] = [];
  const deadEnds: string[] = [];

  for (const s of corpus) {
    if (s.replacedBy === undefined) continue;
    if ((s.status ?? "active") !== "deprecated") activeWithReplacedBy.push(s.skillId);

    const target = byId.get(s.replacedBy);
    if (target === undefined) dangling.push(s.skillId);

    const { terminal, chainLength, cyclic } = resolveTerminal(s.skillId, byId);
    if (cyclic) cycles.push(s.skillId);

    const before = [...(bridge[s.skillId] ?? [])].sort();
    // The worker lands on the TERMINAL, not the immediate successor — a two-hop chain
    // inherits the end of the chain, so that is what the delta must be computed against.
    const after = [...(terminal === null ? [] : (bridge[terminal] ?? []))].sort();

    const gained = after.filter((m) => !before.includes(m));
    const lost = before.filter((m) => !after.includes(m));
    if (gained.length > 0) widening.push(s.skillId);

    const targetIsServable = isActive(target);
    if (!targetIsServable) deadEnds.push(s.skillId);

    findings.push({
      skillId: s.skillId,
      replacedBy: s.replacedBy,
      terminal,
      chainLength,
      targetExists: target !== undefined,
      targetIsServable,
      cyclic,
      matchSkillsBefore: before,
      matchSkillsAfter: after,
      gained,
      lost,
    });
  }

  findings.sort((a, b) => a.skillId.localeCompare(b.skillId));
  return {
    findings,
    dangling: dangling.sort(),
    activeWithReplacedBy: activeWithReplacedBy.sort(),
    cycles: cycles.sort(),
    widening: widening.sort(),
    deadEnds: deadEnds.sort(),
  };
}

/** The sentence a widening crosswalk must be reported with. */
export const WIDENING_NOTICE =
  "A widening crosswalk does not lose a matching signal — it invents one. Re-tagging moves a " +
  "stored reference onto the successor, so the worker inherits the successor's bridge mapping " +
  "and acquires a posting-level claim they never made. 'No signal is lost' does not answer it.";
