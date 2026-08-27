/**
 * D-7C-2 — SELECTIVE deprecation seed. Applies the corpus status + crosswalk pointer to an
 * explicitly named, allow-listed set of skills, and nothing else.
 *
 * ===========================================================================
 * WHAT IT WRITES, EXHAUSTIVELY
 * ===========================================================================
 *     UPDATE skill SET status = 'deprecated', replaced_by = $2, updated_at = now()
 *      WHERE skill_id = $1
 *
 * Two columns and a timestamp, on rows the operator named. It never inserts, never deletes,
 * never touches `skill_alias`, never embeds, and never runs the corpus seed.
 *
 * ===========================================================================
 * WHY IT REFUSES MORE THAN IT WRITES
 * ===========================================================================
 * The whole point of D-7C is a three-vs-four split: the corpus marks four rows deprecated and
 * `skill_boring` is HELD under D-7A because seeding it lands "boring" on `skill_drilling` at
 * 0.7556 — above the floor, a different operation, and not the corpus's named successor. A
 * runner that derives its scope from the corpus re-includes the held row the first time anyone
 * re-runs it. So the scope is an ALLOW-LIST in code, `--only` is mandatory, and a request
 * naming anything outside it is refused WHOLE rather than trimmed to the safe subset.
 *
 * It also refuses on a consequence no file could tell it about. The 2026-08-21 elections hand
 * `GD&T` and `geometric dimensioning and tolerancing` to `skill_gdt_reading`; this seed
 * deprecates `skill_gdt_reading`. Both decisions are ratified, neither mentions the other, and
 * together they remove both phrases from retrieval. The check reads LIVE ROWS and counts a
 * ratified-but-unapplied election as applied, because the end state is the same and refusing
 * only on the applied half would let the pair be created by reversing the order.
 *
 * ===========================================================================
 * SAFETY
 * ===========================================================================
 * DRY RUN IS THE DEFAULT. `--apply` is required to write, and on a production target
 * `enforceOpsGuard` additionally demands `--i-am-authorised-to-write-to-production` AND
 * `OPS_ALLOW_PRODUCTION=seed:deprecations`. Every write is read back and verified.
 *
 *   pnpm db:seed:deprecations --only=skill_gdt_reading,skill_cad_interpretation   # plan
 *   pnpm db:seed:deprecations --only=... --apply --i-am-authorised-to-write-to-production
 */
import { sql as dsql } from "drizzle-orm";
import { config } from "dotenv";

import { SKILL_CORPUS } from "@badabhai/taxonomy";

import { excludedAliasIds } from "./alias-exclusions";
import { createDbClient } from "./client";
import { D7C_SEED_EXCLUSIONS } from "./deprecation-hop0";
import {
  D7C_APPROVED_SUBJECTS,
  planDeprecationSeed,
  renderDeprecationSql,
  vocabularyImpactOfSeed,
  type LiveSkill,
} from "./deprecation-seed-plan";
import { enforceOpsGuard } from "./ops-guard";

config({ path: "../../.env" });
config();

const SCRIPT = "seed:deprecations";

function arg(n: string): string | undefined {
  return process.argv.find((x) => x.startsWith(`--${n}=`))?.slice(n.length + 3);
}

const inList = (xs: readonly string[]) =>
  dsql`(${dsql.join(
    xs.map((x) => dsql`${x}`),
    dsql`, `,
  )})`;

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const { connectionString: url } = enforceOpsGuard({
    script: SCRIPT,
    connectionString: process.env["DATABASE_URL"],
    mutating: apply,
  });

  const requested = (arg("only") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");

  console.log(`[${SCRIPT}] ${apply ? "APPLY (writes)" : "PLAN (default — pass --apply to write)"}`);
  console.log(`  approved set  = ${D7C_APPROVED_SUBJECTS.join(", ")}`);
  console.log(
    `  excluded      = ${Object.keys(D7C_SEED_EXCLUSIONS).join(", ") || "(none)"}   ` +
      `<- cannot be requested at all`,
  );
  console.log(`  requested     = ${requested.join(", ") || "(nothing)"}\n`);

  const { db, sql } = createDbClient(url, { max: 1 });
  try {
    const live = (await db.execute(dsql`
      SELECT skill_id, status, replaced_by FROM skill
    `)) as unknown as LiveSkill[];

    // Every live holder of a shared phrase. Only rows that are actually retrievable count —
    // a provisional or unembedded row cannot keep a phrase alive.
    const holders = (await db.execute(dsql`
      SELECT lower(btrim(sa.text)) AS norm, sa.skill_id, sa.id AS alias_id
      FROM skill_alias sa JOIN skill s ON s.skill_id = sa.skill_id
      WHERE s.status = 'active' AND sa.embedding IS NOT NULL
        AND lower(btrim(sa.text)) IN (
          SELECT lower(btrim(x.text)) FROM skill_alias x
          JOIN skill xs ON xs.skill_id = x.skill_id
          WHERE xs.status = 'active' AND x.embedding IS NOT NULL
            AND x.skill_id IN ${inList(requested.length > 0 ? requested : ["__none__"])}
        )
    `)) as unknown as { norm: string; skill_id: string; alias_id: string }[];

    // Ratified-but-unapplied elections count as applied: same end state, and refusing only on
    // the applied half would let the orphan be created by doing the writes in the other order.
    const pending = new Set(excludedAliasIds("data/taxonomy/decollided-aliases.json"));
    const impact = vocabularyImpactOfSeed(holders, requested, pending);

    const plan = planDeprecationSeed({
      requested,
      corpus: SKILL_CORPUS.map((s) => ({
        skillId: s.skillId,
        status: s.status,
        ...(s.replacedBy !== undefined ? { replacedBy: s.replacedBy } : {}),
      })),
      live,
      crossDecisionOrphans: impact.crossDecisionOrphans,
    });

    // Reported, never refused: a deprecation taking its OWN phrases out of retrieval is what a
    // deprecation IS. HOP-0 already quantifies where those phrases land instead. Printed before
    // the verdict either way, so a refusal and a clean plan describe the same cost.
    const retires = (): void => {
      console.log(
        `  vocabulary the seed retires (expected): ${impact.coverageLoss.length} phrase(s)`,
      );
      if (impact.coverageLoss.length > 0) console.log(`    ${impact.coverageLoss.join(", ")}`);
      console.log(`  cross-decision orphans (refuses):      ${impact.crossDecisionOrphans.length}`);
    };

    if (plan.refusals.length > 0) {
      retires();
      console.log(`  REFUSED — ${plan.refusals.length} precondition(s) failed:`);
      for (const r of plan.refusals) console.log(`    x ${r}`);
      console.log(
        `\n  Nothing was written. A partial run of a set that was requested wrongly is worse ` +
          `than none: it leaves the corpus in a state nobody described.`,
      );
      process.exitCode = 1;
      return;
    }

    retires();
    console.log(`\n  preconditions PASS. ${plan.writes.length} row(s) would change:`);
    for (const w of plan.writes) {
      console.log(
        `    ${w.skill_id.padEnd(32)} status ${w.from_status} -> deprecated   ` +
          `replaced_by ${w.from_replaced_by ?? "NULL"} -> ${w.to_replaced_by}`,
      );
      console.log(`      ${renderDeprecationSql(w)}`);
    }
    for (const d of plan.alreadyDone) console.log(`    ${d.padEnd(32)} already in the target state`);

    if (!apply) {
      console.log(
        `\n  PLAN ONLY — nothing written. Re-run with --apply (a production target also needs ` +
          `the two ops-guard signals).`,
      );
      return;
    }

    for (const w of plan.writes) {
      await db.execute(dsql`
        UPDATE skill SET status = 'deprecated', replaced_by = ${w.to_replaced_by},
                         updated_at = now()
        WHERE skill_id = ${w.skill_id}
      `);
    }

    // READ BACK. A write that reports success without being observed is a claim, not a fact.
    const after = (await db.execute(dsql`
      SELECT skill_id, status, replaced_by FROM skill
      WHERE skill_id IN ${inList(plan.writes.map((w) => w.skill_id).concat("__none__"))}
    `)) as unknown as LiveSkill[];
    const bad = plan.writes.filter((w) => {
      const r = after.find((x) => x.skill_id === w.skill_id);
      return r?.status !== "deprecated" || r.replaced_by !== w.to_replaced_by;
    });
    if (bad.length > 0) {
      throw new Error(
        `[${SCRIPT}] read-back FAILED for ${bad.map((b) => b.skill_id).join(", ")} — the rows do ` +
          `not hold the values that were written.`,
      );
    }
    console.log(`\n  APPLIED and verified: ${plan.writes.length} row(s).`);
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
