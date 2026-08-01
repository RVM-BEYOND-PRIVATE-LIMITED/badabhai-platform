/**
 * D2 — Matching V1 worker-skill + industry-tenure backfill (migration 0053).
 *
 * Derives every worker's MATCHABLE inventory from their LATEST `worker_profiles` row,
 * using the COARSE launch rule (owner ruling 2026-07-30: worker history is coarse at
 * launch — there are no per-job stints yet).
 *
 * THE COARSE RULE (deterministic; no LLM — invariant #4):
 *   skills  = ROLE BRIDGE ∪ ATTRIBUTE BRIDGE
 *             role bridge      : ROLE_TO_MATCH_SKILL[worker_profiles.canonical_role_id]
 *             attribute bridge : ATTRIBUTE_TO_MATCH_SKILLS[each id in worker_profiles.skills]
 *   months  = floor(experience.total_years * 12 / month_bucket) * month_bucket
 *             — the SAME coarse number on every derived skill, because coarse history
 *               cannot attribute time to one skill over another. Claiming otherwise
 *               would be fabricating experience.
 *   wants   = true          (opt-out is a worker action, not a backfill guess)
 *   started_at / ended_at = NULL   (no stints at launch)
 *   source  = 'derived_coarse'
 *
 * OWNERSHIP DISCIPLINE — the property that makes this safe to re-run forever:
 *   this script OWNS `source='derived_coarse'` rows and ONLY those. It upserts them,
 *   and it DELETES the ones whose skill left the derived set. It NEVER reads-to-modify,
 *   overwrites, or deletes a row with source='interview' or source='ops' — those are
 *   what a human/worker actually said, and a re-derivation must never silently replace
 *   them. The upsert's `setWhere` enforces that at the DB, not just in the loop.
 *
 * THEN `worker_industry_tenure` is REBUILT per (worker, industry):
 *   calendar_months = max(experience months, max skill months)      ← the E8 clamp
 *   A worker cannot have 5 years on a skill but 2 years in the industry; the clamp
 *   makes that contradiction unrepresentable instead of letting it rank someone wrongly.
 *
 * BATCHED + RESUMABLE: workers are processed in id order in `--batch-size` chunks and the
 * last id processed is printed, so `--start-after=<uuid>` resumes an interrupted run.
 * DRY-RUN IS THE DEFAULT; `--apply` writes.
 *
 * PRIVACY: reads ONLY faceless signal columns (worker id, canonical_role_id, skills jsonb,
 * experience jsonb). It never reads phone/name and never logs anything but ids + counts.
 *
 *   pnpm db:backfill:worker-skills                      # dry run
 *   pnpm db:backfill:worker-skills --apply              # write
 *   pnpm db:backfill:worker-skills --apply --batch-size=1000 --start-after=<uuid>
 */
import { and, asc, eq, gt, notInArray, sql as dsql } from "drizzle-orm";

import { bucketMonths, deriveWorkerSkills, DEFAULT_MATCH_CONFIG } from "@badabhai/match-engine";

import { createDbClient, type Database } from "./client";
import { matchConfig, workerIndustryTenure, workerProfiles, workerSkills, workers } from "./schema";
import { loadMatchTaxonomy, validateMatchTaxonomy } from "./match-taxonomy";
import {
  asObject,
  asStringArray,
  finiteOrNull,
  parseCommonCli,
  printCounts,
  printFooter,
  printHeader,
} from "./match-v1-cli";

const NAME = "backfill:worker-skills";

/** Fallback bucket if `match_config` has not been seeded yet (D1 seeds 6). */
const FALLBACK_MONTH_BUCKET = 6;

interface DerivedSkill {
  skillId: string;
  industryId: string;
  monthsBucketed: number;
}

/** Read `month_bucket` off the single active `match_config` row. */
async function readMonthBucket(db: Database): Promise<number> {
  const rows = await db
    .select({ config: matchConfig.config })
    .from(matchConfig)
    .where(eq(matchConfig.isActive, true))
    .limit(1);
  const cfg = asObject(rows[0]?.config);
  const bucket = cfg ? finiteOrNull(cfg.month_bucket) : null;
  if (bucket === null || !Number.isInteger(bucket) || bucket < 1) {
    console.warn(
      `[${NAME}] no usable match_config.month_bucket — falling back to ${FALLBACK_MONTH_BUCKET}. ` +
        `Run db:seed:match:vocabulary first for the ratified value.`,
    );
    return FALLBACK_MONTH_BUCKET;
  }
  return bucket;
}

async function main(): Promise<void> {
  const opts = parseCommonCli(NAME);
  printHeader(NAME, opts);

  const taxonomy = loadMatchTaxonomy(NAME);
  const problems = validateMatchTaxonomy(taxonomy);
  if (problems.length > 0) {
    throw new Error(`[${NAME}] match vocabulary invalid:\n  - ${problems.join("\n  - ")}`);
  }

  const { db, sql } = createDbClient(opts.databaseUrl, { max: 1 });
  const now = new Date();
  try {
    const monthBucket = await readMonthBucket(db);

    // NOTE: the per-skill industry lookup that used to live here is gone — `deriveWorkerSkills`
    // resolves `industry_id` itself, from the same `MATCH_SKILLS` table, so the row still
    // carries its industry without a per-row join on the hot path. `taxonomy` above is still
    // loaded and validated on purpose: `validateMatchTaxonomy` is the fail-closed integrity
    // check on the bridges this script depends on, and it must run before any write.
    let cursor = opts.startAfter;
    let lastId: string | undefined = cursor;
    let workersSeen = 0;
    let workersWithProfile = 0;
    let workersWithNoDerivedSkills = 0;
    let skillsUpserted = 0;
    let skillsDeleted = 0;
    let skillsSkippedHumanAuthored = 0;
    let tenureRowsWritten = 0;

    for (;;) {
      const batch: { id: string }[] = await db
        .select({ id: workers.id })
        .from(workers)
        .where(cursor === undefined ? undefined : gt(workers.id, cursor))
        .orderBy(asc(workers.id))
        .limit(opts.batchSize);
      if (batch.length === 0) break;

      for (const w of batch) {
        workersSeen += 1;
        lastId = w.id;

        // LATEST profile per worker — created_at DESC, id DESC as the total-order tiebreak.
        const profileRows = await db
          .select({
            canonicalRoleId: workerProfiles.canonicalRoleId,
            skills: workerProfiles.skills,
            experience: workerProfiles.experience,
          })
          .from(workerProfiles)
          .where(eq(workerProfiles.workerId, w.id))
          .orderBy(dsql`${workerProfiles.createdAt} DESC`, dsql`${workerProfiles.id} DESC`)
          .limit(1);
        const profile = profileRows[0];
        if (!profile) continue;
        workersWithProfile += 1;

        // ── The coarse derivation ────────────────────────────────────────────
        const exp = asObject(profile.experience);
        const totalYears = exp ? (finiteOrNull(exp.total_years) ?? 0) : 0;

        // TD120 (paid 2026-08-01): the coarse rule lives in `@badabhai/match-engine` and
        // NOWHERE ELSE. This block used to be a hand-rolled second implementation that
        // agreed with the engine only by coincidence — nothing held them equal, so a future
        // edit to a bridge or a bucket would land in one and not the other, the backfill
        // would write one set of months and the worker's next chat turn would re-derive a
        // different set through moment ①, and a man's rank would change for a reason no ops
        // person could explain. Parity at the swap was measured, not assumed: 7,854 cases
        // (14 roles x 51 attribute sets x 11 experience values), 0 mismatches.
        const derived: DerivedSkill[] = deriveWorkerSkills(
          {
            canonicalRoleId: profile.canonicalRoleId,
            profileSkills: asStringArray(profile.skills),
            totalYears,
          },
          { ...DEFAULT_MATCH_CONFIG, monthBucket },
        ).map((r) => ({
          skillId: r.skillId,
          industryId: r.industryId,
          monthsBucketed: r.monthsBucketed,
        }));

        // The worker's own experience in months — the OTHER half of the E8 clamp below.
        // Sourced from the engine's `bucketMonths` so the backfill has exactly one bucketing
        // implementation, the same one moment ① uses.
        const months = bucketMonths(totalYears, monthBucket);
        if (derived.length === 0) workersWithNoDerivedSkills += 1;

        if (opts.apply) {
          for (const d of derived) {
            // setWhere pins the ownership rule at the DB: a conflicting row that a human
            // authored (interview/ops) is LEFT EXACTLY AS IT IS. RETURNING tells us which
            // it was, so the counts are honest rather than assumed.
            const written = await db
              .insert(workerSkills)
              .values({
                workerId: w.id,
                skillId: d.skillId,
                industryId: d.industryId,
                monthsBucketed: d.monthsBucketed,
                wants: true,
                source: "derived_coarse",
                updatedAt: now,
              })
              .onConflictDoUpdate({
                target: [workerSkills.workerId, workerSkills.skillId],
                set: {
                  industryId: d.industryId,
                  monthsBucketed: d.monthsBucketed,
                  updatedAt: now,
                },
                setWhere: eq(workerSkills.source, "derived_coarse"),
              })
              .returning({ id: workerSkills.id });
            if (written.length > 0) skillsUpserted += 1;
            else skillsSkippedHumanAuthored += 1;
          }

          // Stale derived rows: a skill that left the derived set. ONLY derived_coarse
          // rows are ever deleted.
          const staleWhere =
            derived.length === 0
              ? and(eq(workerSkills.workerId, w.id), eq(workerSkills.source, "derived_coarse"))
              : and(
                  eq(workerSkills.workerId, w.id),
                  eq(workerSkills.source, "derived_coarse"),
                  notInArray(
                    workerSkills.skillId,
                    derived.map((d) => d.skillId),
                  ),
                );
          const removed = await db
            .delete(workerSkills)
            .where(staleWhere)
            .returning({ id: workerSkills.id });
          skillsDeleted += removed.length;

          // ── Rebuild tenure (E8 clamp) ──────────────────────────────────────
          // Recomputed from the LIVE rows (derived + human-authored), not from `derived`,
          // so an interview-authored skill is honoured by the clamp too.
          const liveRows = await db
            .select({
              industryId: workerSkills.industryId,
              monthsBucketed: workerSkills.monthsBucketed,
            })
            .from(workerSkills)
            .where(eq(workerSkills.workerId, w.id));

          const maxByIndustry = new Map<string, number>();
          for (const r of liveRows) {
            const prev = maxByIndustry.get(r.industryId) ?? 0;
            if (r.monthsBucketed > prev) maxByIndustry.set(r.industryId, r.monthsBucketed);
          }
          // The worker's stated experience applies to every industry they hold a skill in;
          // the clamp takes whichever is larger.
          for (const [industryId, maxSkillMonths] of maxByIndustry) {
            const calendarMonths = Math.max(months, maxSkillMonths);
            await db
              .insert(workerIndustryTenure)
              .values({ workerId: w.id, industryId, calendarMonths, computedAt: now })
              .onConflictDoUpdate({
                target: [workerIndustryTenure.workerId, workerIndustryTenure.industryId],
                set: { calendarMonths, computedAt: now },
              });
            tenureRowsWritten += 1;
          }
          // Tenure for an industry the worker no longer holds any skill in is removed, so
          // the projection can never outlive its inputs.
          const tenureStaleWhere =
            maxByIndustry.size === 0
              ? eq(workerIndustryTenure.workerId, w.id)
              : and(
                  eq(workerIndustryTenure.workerId, w.id),
                  notInArray(workerIndustryTenure.industryId, [...maxByIndustry.keys()]),
                );
          await db.delete(workerIndustryTenure).where(tenureStaleWhere);
        } else {
          // Dry run: count what WOULD change without touching a row.
          const existing = await db
            .select({ skillId: workerSkills.skillId, source: workerSkills.source })
            .from(workerSkills)
            .where(eq(workerSkills.workerId, w.id));
          const existingDerived = new Set(
            existing.filter((e) => e.source === "derived_coarse").map((e) => e.skillId),
          );
          const humanAuthored = new Set(
            existing.filter((e) => e.source !== "derived_coarse").map((e) => e.skillId),
          );
          for (const d of derived) {
            if (humanAuthored.has(d.skillId)) skillsSkippedHumanAuthored += 1;
            else skillsUpserted += 1;
          }
          const derivedSet = new Set(derived.map((d) => d.skillId));
          for (const id of existingDerived) if (!derivedSet.has(id)) skillsDeleted += 1;
          tenureRowsWritten += new Set(derived.map((d) => d.industryId)).size;
        }
      }

      if (batch.length < opts.batchSize) break;
      cursor = batch[batch.length - 1]!.id;
    }

    printCounts(NAME, {
      "month_bucket in force": monthBucket,
      "workers scanned": workersSeen,
      "workers with a profile": workersWithProfile,
      "workers deriving 0 skills": workersWithNoDerivedSkills,
      "worker_skill upserted": skillsUpserted,
      "worker_skill deleted (stale)": skillsDeleted,
      "worker_skill left alone (human)": skillsSkippedHumanAuthored,
      "tenure rows written": tenureRowsWritten,
      "resume cursor (--start-after)": lastId ?? "(none)",
    });
    if (workersWithNoDerivedSkills > 0) {
      console.log(
        `[${NAME}] NOTE: ${workersWithNoDerivedSkills} worker(s) derive NO match skill — they ` +
          `reach nothing until the interview writes one. That is FAIL-CLOSED, not an error; ` +
          `it usually means the profile has no canonical_role_id and no bridgeable attribute.`,
      );
    }
    printFooter(NAME, opts, skillsUpserted + skillsDeleted + tenureRowsWritten);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error(`[${NAME}] failed:`, err instanceof Error ? err.message : err);
  process.exit(1);
});
