/**
 * CLOSE THE LOOP: stamp `skill_candidate.resulting_skill_id` on approvals whose skill has ACTUALLY
 * SHIPPED.
 *
 *     pnpm db:backfill:resulting-skill                                       # PLAN (writes nothing)
 *     pnpm db:backfill:resulting-skill --apply \
 *       --i-am-authorised-to-write-to-production                             # guarded write
 *     pnpm db:backfill:resulting-skill --run sdr_20260826-123559Z_phase5     # one run only
 *
 * ===========================================================================
 * WHY THE COLUMN IS NULL IN THE FIRST PLACE, WHICH IS THE WHOLE POINT
 * ===========================================================================
 * An `approved_create` decision RECORDS that a human wants a new canonical skill. It does not
 * create one. The corpus write stays in the offline gated chain — `db:export:approved-skills` ->
 * `validateTaxonomyCorpus` -> `taxonomyQualityVerdict` -> a HUMAN COMMIT of accepted-*.jsonl ->
 * `db:seed:domain-skills` -> `db:embed:skills` -> `db:eval:taxonomy` -> `db:promote:skills`
 * C1..C5 — and every one of those stages can refuse.
 *
 * So `resulting_skill_id` stays NULL on an approval, deliberately, and that NULL is the honest
 * answer to *"did this approval ever ship?"*. The API cannot write it: the `create` branch of the
 * decision schema has no field for it and `.strict()` makes sending one a 400. Nothing before
 * this runner is entitled to claim the skill exists.
 *
 * THIS RUNNER IS THE ONLY THING THAT MAY SAY IT DID, and it says so only by LOOKING.
 *
 * ===========================================================================
 * THE ID IS DERIVED, NEVER SUPPLIED
 * ===========================================================================
 * The candidate's target id is `taxonomySkillIdFor(proposed_skill_name)` — the same pure function
 * `approvedCandidateToCorpusSkill` mints with, so the id this runner looks for is by construction
 * the id the export path would have created. There is NO `--skill-id` flag and there must never
 * be one: an operator who can name the target can point an approval at any skill in the corpus,
 * which is `approved_map` without the review, the reason, or the reviewer.
 *
 * The consequence is worth stating plainly: if a reviewer's label and the shipped skill's label
 * disagree, this runner reports the approval as NOT SHIPPED rather than guessing which skill was
 * meant. That is the correct failure — a mismatch is a question for a human, and the run prints
 * the derived id so the human can see exactly what was looked for.
 *
 * ===========================================================================
 * WHAT IT WILL NOT WRITE
 * ===========================================================================
 *   * any row that is not `status = 'approved_create'`. A rejection, a hold, a map or a merge has
 *     either no resulting skill or one a human already named.
 *   * any row whose `resulting_skill_id` is already set. Re-stamping is not idempotence, it is
 *     overwriting a fact somebody else established; the guarded WHERE requires NULL.
 *   * an `mskill_*` target, refused by prefix AND by `MATCH_SKILLS` membership. The derived id
 *     could only collide with one if a reviewer's label canonicalized onto the closed match
 *     vocabulary — which `validateCandidate` already refuses as PROPOSED_LABEL_IS_MATCH_SKILL —
 *     so this is the belt to that braces, at the last point before a write.
 *   * a skill that is `deprecated`. A deprecated skill is not what the approval asked for, and
 *     pointing an approval at one would make the audit trail say a decision shipped as something
 *     the reviewer would not recognise.
 *   * ANY column other than `resulting_skill_id` and `updated_at`. Not `status` (the decision was
 *     already made), not the reviewer triple (a backfill is not a review), and none of the 19
 *     frozen provenance fields.
 *
 * ===========================================================================
 * SAFETY
 * ===========================================================================
 * PLAN BY DEFAULT. `--apply` alone is not enough against production: `enforceOpsGuard` classifies
 * the TARGET from the connection string, so a production write additionally needs
 * `--i-am-authorised-to-write-to-production` and `OPS_ALLOW_PRODUCTION=backfill:resulting-skill`.
 *
 * NO FRESHNESS CHECK, and that omission is deliberate rather than overlooked. Every other runner
 * in this workstream refuses a stale corpus fingerprint because it is about to put a MEASUREMENT
 * in front of a human. This one records an OBSERVATION about the corpus as it is right now — "the
 * skill this approval asked for exists" — and that observation is only ever true of the live
 * corpus. Gating it on a fingerprint from the run that produced the candidate would refuse to
 * record the very change the corpus was supposed to undergo.
 */
import { config } from "dotenv";
import { sql as dsql } from "drizzle-orm";

import { MATCH_SKILLS } from "@badabhai/taxonomy";

import { createDbClient } from "./client";
import { enforceOpsGuard, hostClass } from "./ops-guard";
import { taxonomySkillIdFor } from "./taxonomy-corpus";

config({ path: "../../.env" });
config();

const SCRIPT = "backfill:resulting-skill";

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit !== undefined) return hit.slice(name.length + 3);
  const idx = process.argv.indexOf(`--${name}`);
  const next = idx >= 0 ? process.argv[idx + 1] : undefined;
  return next !== undefined && !next.startsWith("--") ? next : undefined;
}
function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

/** The closed match vocabulary, lower-cased — the set `validateCandidate` tests membership against. */
const MATCH_SKILL_IDS: ReadonlySet<string> = new Set(
  MATCH_SKILLS.map((s) => s.skillId.toLowerCase()),
);
const MATCH_SKILL_PREFIX = "mskill_";

/** Why a candidate was not backfilled. Closed, so the summary can count without inventing buckets. */
type SkipReason =
  /** The skill the approved label mints does not exist yet — the ordinary case. */
  | "not_shipped_yet"
  /** It exists but is deprecated. Not what the approval asked for. */
  | "target_deprecated"
  /** It exists but is a match skill. Refused at the wall. */
  | "target_is_match_skill"
  /** `approved_create` with no label. `skill_candidate_create_label_chk` should make this unreachable. */
  | "no_label";

interface Row {
  candidate_id: string;
  run_id: string;
  proposed_skill_name: string | null;
  reviewed_at: string | null;
}

interface Decided {
  readonly candidate: Row;
  readonly derivedSkillId: string;
  readonly skip: SkipReason | null;
}

async function main(): Promise<void> {
  const apply = flag("apply");
  const runId = arg("run");

  const guard = enforceOpsGuard({
    script: SCRIPT,
    connectionString: process.env.DATABASE_URL,
    mutating: apply,
  });
  const { db, sql } = createDbClient(guard.connectionString, { max: 4 });

  try {
    // Does the staging layer even exist? Migration 0093 may not be applied, and "0 candidates"
    // read off a missing table is not the same fact as "0 candidates awaiting a backfill".
    const [presence] = (await db.execute(dsql`
      SELECT count(*)::int AS present FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'skill_candidate'`)) as unknown as {
      present: number;
    }[];
    if ((presence?.present ?? 0) === 0) {
      throw new Error(
        `[${SCRIPT}] table 'skill_candidate' does not exist on this target. Migration 0093 has ` +
          "not been applied here. Refusing, rather than reporting an empty backfill that would " +
          "read as 'nothing to do'.",
      );
    }

    const candidates = (await db.execute(dsql`
      SELECT candidate_id, run_id, proposed_skill_name, reviewed_at::text AS reviewed_at
        FROM skill_candidate
       WHERE status = 'approved_create'
         AND resulting_skill_id IS NULL
         ${runId !== undefined ? dsql`AND run_id = ${runId}` : dsql``}
       ORDER BY reviewed_at, candidate_id`)) as unknown as Row[];

    // One round trip for every derived id, not one per candidate. `kind` is read because the
    // `mskill_` prefix is only a PROXY for it: a match skill renamed out of the convention would
    // pass a prefix test and still be the thing the wall exists to refuse.
    const derived = new Map<string, string>();
    for (const c of candidates) {
      const label = (c.proposed_skill_name ?? "").trim();
      if (label !== "") derived.set(c.candidate_id, taxonomySkillIdFor(label));
    }
    const wanted = [...new Set(derived.values())];
    const shipped = new Map<string, { status: string; kind: string }>();
    if (wanted.length > 0) {
      const rows = (await db.execute(dsql`
        SELECT skill_id, status, kind FROM skill WHERE skill_id = ANY(${wanted})`)) as unknown as {
        skill_id: string;
        status: string;
        kind: string;
      }[];
      for (const r of rows) shipped.set(r.skill_id, { status: r.status, kind: r.kind });
    }

    const decided: Decided[] = candidates.map((c) => {
      const skillId = derived.get(c.candidate_id);
      if (skillId === undefined) {
        return { candidate: c, derivedSkillId: "", skip: "no_label" };
      }
      const live = shipped.get(skillId);
      if (live === undefined) return { candidate: c, derivedSkillId: skillId, skip: "not_shipped_yet" };
      if (live.kind === "match_skill" || skillId.toLowerCase().startsWith(MATCH_SKILL_PREFIX) ||
          MATCH_SKILL_IDS.has(skillId.toLowerCase())) {
        return { candidate: c, derivedSkillId: skillId, skip: "target_is_match_skill" };
      }
      if (live.status === "deprecated") {
        return { candidate: c, derivedSkillId: skillId, skip: "target_deprecated" };
      }
      return { candidate: c, derivedSkillId: skillId, skip: null };
    });

    const backfillable = decided.filter((d) => d.skip === null);
    const skipped = decided.filter((d) => d.skip !== null);

    console.log("");
    console.log(`  ${"=".repeat(76)}`);
    console.log(`  BACKFILL resulting_skill_id — ${apply ? "APPLY" : "PLAN (writes nothing)"}`);
    console.log(`  ${"=".repeat(76)}`);
    console.log("");
    console.log(`  target                        ${hostClass(guard.connectionString)}`);
    console.log(`  scope                         ${runId ?? "every run"}`);
    console.log(`  approvals awaiting a skill    ${candidates.length}`);
    console.log(`  shipped, ready to stamp       ${backfillable.length}`);
    console.log(`  still waiting / refused       ${skipped.length}`);

    if (skipped.length > 0) {
      const byReason = new Map<SkipReason, number>();
      for (const d of skipped) {
        byReason.set(d.skip as SkipReason, (byReason.get(d.skip as SkipReason) ?? 0) + 1);
      }
      console.log("");
      for (const [reason, n] of [...byReason.entries()].sort()) {
        console.log(`    ${reason.padEnd(26)} ${n}`);
      }
      // The refusals a human has to act on, named individually. `not_shipped_yet` is the ordinary
      // state of an approval waiting on the offline chain and is only counted; the other three
      // mean something is wrong and the operator needs the row.
      const actionable = skipped.filter((d) => d.skip !== "not_shipped_yet");
      if (actionable.length > 0) {
        console.log("");
        console.log(`  NEEDS A HUMAN (${actionable.length}):`);
        for (const d of actionable.slice(0, 20)) {
          console.log(
            `    ${d.skip}  ${d.candidate.candidate_id}  ` +
              `${JSON.stringify(d.candidate.proposed_skill_name)} -> ${d.derivedSkillId}`,
          );
        }
      }
    }

    if (backfillable.length > 0) {
      console.log("");
      console.log(`  ${apply ? "STAMPING" : "WOULD STAMP"}:`);
      for (const d of backfillable.slice(0, 20)) {
        console.log(`    ${d.candidate.candidate_id}  ->  ${d.derivedSkillId}`);
      }
      if (backfillable.length > 20) console.log(`    … and ${backfillable.length - 20} more`);
    }

    if (!apply) {
      console.log("");
      console.log(`  NOTHING WAS WRITTEN. Re-run with --apply to stamp ${backfillable.length} row(s).`);
      console.log("");
      return;
    }

    // ONE transaction. The guarded WHERE re-states every precondition the plan checked, because a
    // plan is a read and a read does not hold: between the SELECT above and this UPDATE somebody
    // could have decided the candidate again or stamped it. A racer therefore matches zero rows
    // and is reported as such, rather than overwriting whatever they wrote.
    let stamped = 0;
    let lost = 0;
    await db.transaction(async (tx) => {
      for (const d of backfillable) {
        const res = (await tx.execute(dsql`
          UPDATE skill_candidate
             SET resulting_skill_id = ${d.derivedSkillId}, updated_at = now()
           WHERE candidate_id = ${d.candidate.candidate_id}
             AND status = 'approved_create'
             AND resulting_skill_id IS NULL
          RETURNING candidate_id`)) as unknown as { candidate_id: string }[];
        if (res.length === 1) stamped += 1;
        else lost += 1;
      }
    });

    console.log("");
    console.log(`  stamped                       ${stamped}`);
    if (lost > 0) {
      console.log(`  lost to a concurrent write    ${lost}   (re-run to see their current state)`);
    }
    console.log("");
  } finally {
    await sql.end();
  }
}

if (require.main === module) {
  main().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
