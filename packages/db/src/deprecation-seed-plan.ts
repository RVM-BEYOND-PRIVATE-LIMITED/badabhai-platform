/**
 * D-7C-2 — the rules a SELECTIVE deprecation seed must satisfy before it may write.
 *
 * ===========================================================================
 * WHY A SEPARATE MECHANISM AT ALL
 * ===========================================================================
 * `db:seed:skills` lands the WHOLE corpus. Running it to deprecate three rows also upserts 165
 * skills and inserts every corpus + wedge alias, and on production it needs
 * `--preserve-existing-status`, which exists precisely to STOP it changing statuses. So the
 * stock seeder can either change all four drifting statuses or none, and D-7C's three-vs-four
 * split is the entire decision: `skill_boring` is held (D-7A) and the other three are not.
 *
 * A runner whose blast radius is "the three skills you named" is a different runner from one
 * whose blast radius is "the corpus". They get different names, different ops-guard tokens and
 * different reviews.
 *
 * ===========================================================================
 * WHAT THIS MODULE IS
 * ===========================================================================
 * Pure decision rules. No database handle, no IO, no clock. Everything the runner refuses on is
 * decided here so the refusal matrix is unit-testable — which matters more than usual, because
 * the interesting behaviour of a guard is what it does NOT do, and "we ran it and nothing
 * happened" is indistinguishable from a no-op bug.
 *
 * ===========================================================================
 * FAIL CLOSED ON THE SET, NOT PER ROW
 * ===========================================================================
 * A request naming a forbidden skill does not get the forbidden one dropped and the rest
 * applied. It is refused whole. A caller who asked for the wrong set has demonstrated their
 * intent does not match the allow-list, and silently executing the safe subset would leave
 * everyone believing the run did what was asked.
 */
import { D7C_NEUTRAL_SUBJECTS, D7C_SEED_EXCLUSIONS } from "./deprecation-hop0";

/** A `skill` row as the guard needs to see it. */
export interface LiveSkill {
  readonly skill_id: string;
  readonly status: string;
  readonly replaced_by: string | null;
}

/** What the corpus says about one subject. */
export interface CorpusDeprecation {
  readonly skillId: string;
  readonly status: string;
  readonly replacedBy?: string;
}

/** One row the seed would write, after every precondition passed. */
export interface DeprecationWrite {
  readonly skill_id: string;
  readonly from_status: string;
  readonly to_status: "deprecated";
  readonly from_replaced_by: string | null;
  readonly to_replaced_by: string;
}

export interface DeprecationSeedPlan {
  /** Empty means the run may proceed. Non-empty REFUSES the whole run. */
  readonly refusals: readonly string[];
  /** Rows that would change. A subject already deprecated with the right pointer is absent. */
  readonly writes: readonly DeprecationWrite[];
  /** Requested subjects that are already in the target state — reported, not written. */
  readonly alreadyDone: readonly string[];
}

/**
 * The allow-list. Narrower than "whatever the corpus marks deprecated", on purpose.
 *
 * The corpus marks FOUR rows deprecated. Three are the owner-approved D-7C set and the fourth
 * is `skill_boring`, held under D-7A. Deriving the set from the corpus would therefore quietly
 * re-include the held row the day someone re-runs this — the corpus is not where that decision
 * lives.
 */
export const D7C_APPROVED_SUBJECTS: readonly string[] = D7C_NEUTRAL_SUBJECTS;

/**
 * What a seed costs the vocabulary, split by WHO is responsible.
 *
 * `coverageLoss` is the ordinary, expected consequence of deprecating a skill: its own phrases
 * stop being retrievable. Every deprecation does this, HOP-0 already quantifies it, and
 * refusing on it would mean no deprecation could ever run.
 *
 * `crossDecisionOrphans` is the D-7C-1a conflict and is a different thing entirely: a phrase
 * that **would have survived** this deprecation, because another active skill also holds it,
 * and does not — because a SEPARATE ratified decision de-elects that other holder. The
 * 2026-08-21 elections hand `GD&T` and `geometric dimensioning and tolerancing` to
 * `skill_gdt_reading`; this seed deprecates `skill_gdt_reading`. Each is safe alone, neither
 * file mentions the other, and nothing in the repository connects them — which is why the
 * check reads LIVE ROWS rather than either file's beliefs.
 *
 * The split is the whole point. Reporting them together produced a refusal that named five
 * phrases, three of which were simply what the owner approved.
 *
 * `pendingElections` are ids an operator intends to NULL but has not yet. A ratified-and-
 * unapplied election reaches the same end state as an applied one, so counting only the applied
 * half would let the pair be created by doing the two writes in the other order.
 *
 * @param holders every live embedded alias row on an active skill, for the phrases in scope
 */
export interface VocabularyImpact {
  /** Phrases whose only live holder is a subject of this seed. Expected; reported. */
  readonly coverageLoss: readonly string[];
  /** Phrases lost ONLY because an election removed the surviving holder. Refuses the run. */
  readonly crossDecisionOrphans: readonly string[];
}

export function vocabularyImpactOfSeed(
  holders: readonly { readonly norm: string; readonly skill_id: string; readonly alias_id: string }[],
  subjects: readonly string[],
  pendingElections: ReadonlySet<string>,
): VocabularyImpact {
  const doomed = new Set(subjects);
  const byNorm = new Map<string, typeof holders>();
  for (const h of holders) byNorm.set(h.norm, [...(byNorm.get(h.norm) ?? []), h]);

  const coverageLoss: string[] = [];
  const crossDecisionOrphans: string[] = [];
  for (const [norm, rows] of byNorm) {
    // Would it survive the DEPRECATION alone, ignoring every election?
    const survivesDeprecation = rows.some((r) => !doomed.has(r.skill_id));
    // And does it survive once the elections are also applied?
    const survivesBoth = rows.some(
      (r) => !doomed.has(r.skill_id) && !pendingElections.has(r.alias_id),
    );
    if (survivesBoth) continue;
    if (survivesDeprecation) crossDecisionOrphans.push(norm);
    else coverageLoss.push(norm);
  }
  return { coverageLoss: coverageLoss.sort(), crossDecisionOrphans: crossDecisionOrphans.sort() };
}

/**
 * Decide whether a selective deprecation seed may run, and what it would write.
 *
 * Order matters: the identity of the request is checked before its consequences, so an operator
 * who named the wrong skill is told that rather than being handed a report about phrases.
 */
export function planDeprecationSeed(input: {
  readonly requested: readonly string[];
  readonly corpus: readonly CorpusDeprecation[];
  readonly live: readonly LiveSkill[];
  /** ONLY the cross-decision orphans. Ordinary coverage loss is reported, not refused. */
  readonly crossDecisionOrphans: readonly string[];
  readonly allowList?: readonly string[];
  readonly exclusions?: Readonly<Record<string, string>>;
}): DeprecationSeedPlan {
  const allow = new Set(input.allowList ?? D7C_APPROVED_SUBJECTS);
  const excluded = input.exclusions ?? D7C_SEED_EXCLUSIONS;
  const refusals: string[] = [];

  if (input.requested.length === 0) {
    refusals.push(
      "--only=<skill_id,...> is required. There is no default set: a deprecation seed that " +
        "picks its own scope is the failure D-7A exists to prevent.",
    );
  }

  const seen = new Set<string>();
  for (const id of input.requested) {
    if (seen.has(id)) refusals.push(`${id} is named twice`);
    seen.add(id);

    // 1. IDENTITY — is this skill allowed to be in a request at all?
    const why = excluded[id];
    if (why !== undefined) {
      refusals.push(`${id} is EXCLUDED from the D-7C seed and cannot be requested: ${why}`);
      continue;
    }
    if (!allow.has(id)) {
      refusals.push(
        `${id} is not in the approved D-7C set (${[...allow].join(", ")}). Widening the set is ` +
          `an owner decision, not a command-line argument.`,
      );
      continue;
    }

    // 2. THE CORPUS must actually say this is a deprecation with a successor.
    const c = input.corpus.find((x) => x.skillId === id);
    if (c === undefined) {
      refusals.push(`${id} is not in SKILL_CORPUS; there is nothing to seed from`);
      continue;
    }
    if (c.status !== "deprecated") {
      refusals.push(`${id} is "${c.status}" in the corpus, not "deprecated"`);
      continue;
    }
    if (c.replacedBy === undefined) {
      refusals.push(
        `${id} is deprecated in the corpus with NO successor. Retirement-without-successor is ` +
          `legal in the schema and is a different decision from a crosswalk; this runner only ` +
          `applies crosswalked deprecations.`,
      );
      continue;
    }

    // 3. THE DATABASE must be in a state the write makes sense from.
    const row = input.live.find((x) => x.skill_id === id);
    if (row === undefined) {
      refusals.push(`${id} does not exist on the target`);
      continue;
    }
    const successor = input.live.find((x) => x.skill_id === c.replacedBy);
    if (successor === undefined) {
      refusals.push(`${id}: successor ${c.replacedBy} does not exist on the target`);
      continue;
    }
    // A pointer at a row that is itself deprecated makes a chain the retag runner must resolve.
    // Legal, but not something this runner should create silently.
    if (successor.status !== "active") {
      refusals.push(
        `${id}: successor ${c.replacedBy} is "${successor.status}", not active — this would ` +
          `create a deprecation chain`,
      );
    }
  }

  // 4. CONSEQUENCES — checked once, over the whole set, because the subjects are seeded
  //    together and a phrase's survival depends on all of them at once.
  for (const p of input.crossDecisionOrphans) {
    refusals.push(
      `the phrase "${p}" would SURVIVE this deprecation, and does not: a separate ratified ` +
        `election removes the other holder, so retrieval keeps neither. Two safe decisions, ` +
        `one lost phrase. See OWNER DECISION D-7C-1a.`,
    );
  }

  const writes: DeprecationWrite[] = [];
  const alreadyDone: string[] = [];
  if (refusals.length === 0) {
    for (const id of input.requested) {
      const c = input.corpus.find((x) => x.skillId === id)!;
      const row = input.live.find((x) => x.skill_id === id)!;
      if (row.status === "deprecated" && row.replaced_by === c.replacedBy) {
        alreadyDone.push(id);
        continue;
      }
      writes.push({
        skill_id: id,
        from_status: row.status,
        to_status: "deprecated",
        from_replaced_by: row.replaced_by,
        to_replaced_by: c.replacedBy!,
      });
    }
  }

  return { refusals, writes: writes.sort((a, b) => a.skill_id.localeCompare(b.skill_id)), alreadyDone };
}

/**
 * The statement the runner would issue, rendered for a plan.
 *
 * Status and pointer move in ONE statement because the CHECK is
 * `replaced_by IS NULL OR status = 'deprecated'` and it evaluates the whole new tuple; writing
 * the pointer first would violate it, and writing the status first leaves a window in which the
 * row is deprecated with no successor.
 *
 * `version` is deliberately untouched. `db:seed:skills` does not write it either, and
 * introducing a version bump here would be this runner inventing a lifecycle semantic that no
 * decision record establishes.
 */
export function renderDeprecationSql(w: DeprecationWrite): string {
  return (
    `UPDATE skill SET status = 'deprecated', replaced_by = '${w.to_replaced_by}', ` +
    `updated_at = now() WHERE skill_id = '${w.skill_id}';`
  );
}
