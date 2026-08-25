/**
 * Q1 — every promotable skill must carry a MATCH-VOCABULARY DECISION before it can go live.
 *
 * ===========================================================================
 * THE HOLE THIS CLOSES
 * ===========================================================================
 * `ATTRIBUTE_TO_MATCH_SKILLS` is the only bridge from an extracted attribute skill to a
 * posting-level `mskill_*`. A test in `@badabhai/taxonomy` asserts that bridge is EXHAUSTIVE,
 * which reads like full protection and is not:
 *
 *     its universe is SKILL_CORPUS — 49 hand-authored seeds.
 *
 * A skill that never entered `SKILL_CORPUS` is not "unmapped and failing". It is **outside the
 * question the test asks**. So a growth batch can promote to `active`, become visible to
 * canonicalization and to retrieval, reach nothing at match time, and **no test anywhere
 * fails**. Measured: 96 of 96 promotable skills sit in exactly that blind spot.
 *
 * This module changes the universe. The question is asked of **the batch that would actually
 * promote**, not of the seed corpus.
 *
 * ===========================================================================
 * THE DISTINCTION THAT IS THE WHOLE POINT
 * ===========================================================================
 * "Reaches no match skill" is TWO different states, and collapsing them is what made the gap
 * invisible:
 *
 *   MISSING_DECISION            no key in the bridge. Nobody ever triaged it. **Must fail.**
 *   INTENTIONALLY_UNMATCHED     key present, value `[]`. Somebody looked and said no. **Passes.**
 *
 * At runtime both reach nothing. At review time they are opposites: one is an unanswered
 * question, the other is an answer. The existing bridge already uses the empty array as a
 * deliberate signal — "THE EMPTY ONES ARE THE POINT", per its own header — so this reuses that
 * idiom rather than inventing a second register for the same fact.
 *
 * ===========================================================================
 * WHAT THIS MODULE REFUSES TO DO
 * ===========================================================================
 * It does not decide anything. It cannot propose a mapping, and it must never be extended to
 * generate one: mapping eagerly is precisely how a lathe hand is reached for a programmer's
 * vacancy. Whether a skill implies an `mskill_*` is a product judgement owned by the bridge
 * owner. This module asks whether the judgement has been MADE.
 *
 * NO IO. The runner and the report live elsewhere so this rule can be tested without a batch
 * file or a database.
 */

export type VocabularyDecision =
  /** Mapped to at least one match skill, and every target exists. */
  | "MATCHED"
  /** Key present, value `[]` — an explicit, reviewable "this stays an attribute". */
  | "INTENTIONALLY_UNMATCHED"
  /** No key at all. The question was never asked. */
  | "MISSING_DECISION"
  /** Mapped, but to an `mskill_*` that does not exist. A decision was made against nothing. */
  | "INVALID_TARGET";

/**
 * Classify one skill.
 *
 * `INVALID_TARGET` is separated from `MATCHED` because "has a mapping" and "has a mapping that
 * resolves" are different claims, and only the second means the skill is reachable. A typo in
 * a match-skill id would otherwise read as full coverage while reaching nothing at all — the
 * same silent-nothing failure this module exists to catch, one level down.
 */
export function classifyVocabularyDecision(
  skillId: string,
  bridge: Readonly<Record<string, readonly string[]>>,
  validMatchSkills: ReadonlySet<string>,
): VocabularyDecision {
  if (!Object.prototype.hasOwnProperty.call(bridge, skillId)) return "MISSING_DECISION";
  const targets = bridge[skillId] ?? [];
  if (targets.length === 0) return "INTENTIONALLY_UNMATCHED";
  return targets.every((t) => validMatchSkills.has(t)) ? "MATCHED" : "INVALID_TARGET";
}

export interface VocabularyCoverage {
  /** The promotable universe actually examined. */
  readonly total: number;
  readonly counts: Readonly<Record<VocabularyDecision, number>>;
  readonly byDecision: Readonly<Record<VocabularyDecision, readonly string[]>>;
  /** Ids that block promotion: no decision, or a decision pointing at nothing. */
  readonly blocking: readonly string[];
  /** True when every promotable skill carries a decision that resolves. */
  readonly passed: boolean;
}

/**
 * Run the tripwire over a promotable universe.
 *
 * `skillIds` MUST be the batch that would promote. Passing `SKILL_CORPUS` here reproduces the
 * exact blind spot this module was written to remove, and the result would look clean.
 */
export function vocabularyCoverage(
  skillIds: readonly string[],
  bridge: Readonly<Record<string, readonly string[]>>,
  validMatchSkills: ReadonlySet<string>,
): VocabularyCoverage {
  const byDecision: Record<VocabularyDecision, string[]> = {
    MATCHED: [],
    INTENTIONALLY_UNMATCHED: [],
    MISSING_DECISION: [],
    INVALID_TARGET: [],
  };

  for (const id of skillIds) {
    byDecision[classifyVocabularyDecision(id, bridge, validMatchSkills)].push(id);
  }
  for (const k of Object.keys(byDecision) as VocabularyDecision[]) byDecision[k].sort();

  const blocking = [...byDecision.MISSING_DECISION, ...byDecision.INVALID_TARGET].sort();

  return {
    total: skillIds.length,
    counts: {
      MATCHED: byDecision.MATCHED.length,
      INTENTIONALLY_UNMATCHED: byDecision.INTENTIONALLY_UNMATCHED.length,
      MISSING_DECISION: byDecision.MISSING_DECISION.length,
      INVALID_TARGET: byDecision.INVALID_TARGET.length,
    },
    byDecision,
    blocking,
    passed: blocking.length === 0,
  };
}

/**
 * The operator-facing refusal.
 *
 * Deliberately NOT waivable, and deliberately not a member of the per-skill `CRITERIA` set.
 *
 * Not waivable: every other criterion answers "is this skill ready?", and a human who has
 * reviewed the evidence may reasonably override one. This one answers "has anyone decided what
 * this skill MEANS at match time?" — and a waiver would promote a skill whose meaning is still
 * unknown, which is the exact failure the tripwire exists to prevent. There is no version of
 * "I have reviewed the missing decision" that is not just making the decision.
 *
 * Not a criterion: the criteria list is closed and a test pins it at seven, with a recorded
 * decision to fold new invariants into existing composites rather than grow it. Nothing here
 * belongs inside an existing composite — coverage is a property of the BATCH, not of a skill's
 * readiness — so it is enforced as a batch-level precondition, the same shape as the
 * `--sweep` and `--eval` artifact requirements.
 */
export function vocabularyTripwireError(
  coverage: VocabularyCoverage,
  script: string,
  batchDir: string,
): string | null {
  if (coverage.passed) return null;
  const sample = coverage.blocking.slice(0, 10);
  const rest = coverage.blocking.length - sample.length;
  return (
    `[${script}] MATCH-VOCABULARY COVERAGE: ${coverage.blocking.length} of ${coverage.total} ` +
    `promotable skill(s) in ${batchDir} have no usable match-vocabulary decision.\n` +
    `  missing a decision entirely : ${coverage.counts.MISSING_DECISION}\n` +
    `  mapped to an unknown mskill : ${coverage.counts.INVALID_TARGET}\n` +
    `\n  Promoting these makes them live and unreachable at match time, with no test failing:\n` +
    `${sample.map((s) => `     ${s}`).join("\n")}\n` +
    (rest > 0 ? `     (${rest} more)\n` : "") +
    `\n  Each needs ONE of, recorded in ATTRIBUTE_TO_MATCH_SKILLS:\n` +
    `     <skill_id>: ["mskill_..."]   a mapping into the match vocabulary\n` +
    `     <skill_id>: []               an explicit "stays an attribute"\n` +
    `\n  This is a product judgement for the bridge owner. It is NOT waivable and nothing here\n` +
    `  will generate it: mapping eagerly is how an unrelated worker reaches a specialist vacancy.`
  );
}
