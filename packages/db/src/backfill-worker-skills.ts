/**
 * D2 — Matching V1 worker-skill + industry-tenure backfill (migration 0053).
 *
 * Derives every worker's MATCHABLE inventory from their LATEST `worker_profiles` row,
 * using the COARSE launch rule (owner ruling 2026-07-30: worker history is coarse at
 * launch — there are no per-job stints yet).
 *
 * THE COARSE RULE (deterministic; no LLM — invariant #4):
 *   skills  = ROLE BRIDGE ∪ SECONDARY-ROLE BRIDGE ∪ ATTRIBUTE BRIDGE ∪ PACK-ANSWER BRIDGE
 *             role bridge      : ROLE_TO_MATCH_SKILL[worker_profiles.canonical_role_id]
 *             secondary bridge : ROLE_TO_MATCH_SKILL[each worker_occupation.role_id]  (Layer A (f))
 *             attribute bridge : ATTRIBUTE_TO_MATCH_SKILLS[each id in worker_profiles.skills]
 *             pack-answer bridge: PACK_ANSWER_SKILLS[pack][key][option] over `worker_attributes`
 *                                 → corpus ids (attribute bridge) + role ids (role bridge)
 *                                 + pack-only mskill ids (#2022)
 *             generic-pack chat : GENERIC_PACK_MATCH_SKILLS over the profile's source session's
 *                                 worker-only answer map → pack-only mskill ids (#2075)
 *
 * WHO IS DERIVED — the SAME guard as the live rebuild (`WorkerSkillsService.rebuildForWorker`):
 *   a worker with NO profile row, NO pack evidence and NO declared occupation is skipped (his
 *   rows are left alone, not pruned). Any one of the three is evidence. A trade-FORM worker has
 *   pack answers and no profile row — this runner used to skip him outright, and for a worker
 *   who had both it derived WITHOUT the pack answers and pruned the rows the live path wrote.
 *   months  = floor(experience.total_years * 12 / month_bucket) * month_bucket
 *             — the SAME coarse number on every derived skill, because coarse history
 *               cannot attribute time to one skill over another. Claiming otherwise
 *               would be fabricating experience.
 *             #2753 item 2, ONLY with FORM_TENURE_MONTHS_ENABLED=true in THIS process's
 *             environment: where that number is 0, a skill a trade form derived takes that form's
 *             experience band (and, with FORM_TYPED_TENURE_DERIVE_ENABLED=true too, a typed
 *             tenure) through the same bucketing — `loadFormTenureFills`, the read the live rebuild
 *             runs, one query per batch. Run it with the values production runs with, or this
 *             repair and the live path write different months. `--apply` REFUSES to start unless
 *             FORM_TENURE_MONTHS_ENABLED is set explicitly (and FORM_TYPED_TENURE_DERIVE_ENABLED
 *             too when the first is true): an unset shell must not quietly write 0 months over
 *             every form worker. A dry run assumes false for an unset one and says so.
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
 * experience jsonb, the closed `worker_occupation` role ids, `worker_attributes` pack id /
 * key / text values, and the profile's source session's pack id / answer map / provenance stamps;
 * answer values are matched only against closed option keys; with FORM_TENURE_MONTHS_ENABLED on,
 * also each trade form's tenure answer in `worker_pack_answer` — a status and a number, and the
 * typed words only with FORM_TYPED_TENURE_DERIVE_ENABLED on, parsed for one figure and never
 * printed). It never reads phone/name and never logs anything but ids + counts.
 *
 *   pnpm db:backfill:worker-skills                      # dry run
 *   FORM_TENURE_MONTHS_ENABLED=false pnpm db:backfill:worker-skills --apply      # write
 *   FORM_TENURE_MONTHS_ENABLED=true FORM_TYPED_TENURE_DERIVE_ENABLED=false \
 *     pnpm db:backfill:worker-skills --apply --batch-size=1000 --start-after=<uuid>
 *   (the switch values are production's; --apply refuses while either one it needs is unset)
 */
import { and, asc, eq, gt, inArray, isNotNull, notInArray } from "drizzle-orm";

import {
  computeIndustryTenure,
  deriveWorkerSkills,
  DEFAULT_MATCH_CONFIG,
  workerSkillDeriveInput,
  type WorkerSkillRow,
} from "@badabhai/match-engine";
import {
  packAnswerFromStoredRow,
  type IndustryId,
  type MatchSkillId,
  type PackAnswer,
} from "@badabhai/taxonomy";

import { createDbClient, type Database } from "./client";
import { CURRENT_PROFILE_ORDER, PROFILE_SOURCE_SESSION_ANSWERS } from "./current-profile";
import { formTenureSwitchesForRun, loadFormTenureFills } from "./form-tenure";
import {
  matchConfig,
  workerAttributes,
  workerIndustryTenure,
  workerOccupations,
  workerProfiles,
  workerSkills,
  workers,
} from "./schema";
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

/**
 * Every pack answer for one batch of workers, grouped by worker — ONE query per batch, not per
 * worker. Only rows that carry a `pack_id` can match the pack-answer bridge, so the rest are not
 * read. Normalised by the same `packAnswerFromStoredRow` the live repository uses.
 */
async function loadPackAnswers(
  db: Database,
  workerIds: readonly string[],
): Promise<Map<string, PackAnswer[]>> {
  const byWorker = new Map<string, PackAnswer[]>();
  if (workerIds.length === 0) return byWorker;
  const rows = await db
    .select({
      workerId: workerAttributes.workerId,
      packId: workerAttributes.packId,
      attributeKey: workerAttributes.attributeKey,
      valueText: workerAttributes.valueText,
      valueTextList: workerAttributes.valueTextList,
    })
    .from(workerAttributes)
    .where(
      and(inArray(workerAttributes.workerId, [...workerIds]), isNotNull(workerAttributes.packId)),
    );
  for (const row of rows) {
    const answer = packAnswerFromStoredRow(row);
    if (answer === null) continue;
    const list = byWorker.get(row.workerId);
    if (list) list.push(answer);
    else byWorker.set(row.workerId, [answer]);
  }
  return byWorker;
}

async function main(): Promise<void> {
  const opts = parseCommonCli(NAME);
  printHeader(NAME, opts);
  // #2753 item 2 — read BEFORE any database work. `--apply` with FORM_TENURE_MONTHS_ENABLED unset
  // (or, when it is true, FORM_TYPED_TENURE_DERIVE_ENABLED unset) throws here, so `main().catch`
  // exits 1 with one line naming the variable and nothing has been written. A dry run proceeds and
  // prints what it assumed. Names and booleans only, never another env value.
  const run = formTenureSwitchesForRun(process.env, { apply: opts.apply });
  const formTenure = run.switches;
  const assumedNote = (name: string): string =>
    run.assumed.includes(name) ? " (assumed: unset)" : "";
  console.log(
    `[${NAME}] form tenure fill: FORM_TENURE_MONTHS_ENABLED=${formTenure.months}` +
      assumedNote("FORM_TENURE_MONTHS_ENABLED") +
      ` FORM_TYPED_TENURE_DERIVE_ENABLED=${formTenure.typed}` +
      assumedNote("FORM_TYPED_TENURE_DERIVE_ENABLED") +
      (formTenure.months ? "" : " (off: months come from the profile alone, as before #2753)"),
  );

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
    let workersDerivedFromPackOnly = 0;
    let workersWithNoDerivedSkills = 0;
    let skillsUpserted = 0;
    let skillsDeleted = 0;
    let skillsSkippedHumanAuthored = 0;
    let tenureRowsWritten = 0;
    let workersWithFormTenure = 0;
    // #3052 §2 — dry-run per-skill workers before/after (counts only, no PII).
    const beforeBySkill = new Map<string, number>();
    const afterBySkill = new Map<string, number>();

    for (;;) {
      const batch: { id: string }[] = await db
        .select({ id: workers.id })
        .from(workers)
        .where(cursor === undefined ? undefined : gt(workers.id, cursor))
        .orderBy(asc(workers.id))
        .limit(opts.batchSize);
      if (batch.length === 0) break;
      const packAnswersByWorker = await loadPackAnswers(
        db,
        batch.map((w) => w.id),
      );
      // #2753 item 2 — ONE query for the whole batch, and none at all while the switch is off.
      const formTenureByWorker = await loadFormTenureFills(
        db,
        batch.map((w) => w.id),
        formTenure,
      );

      for (const w of batch) {
        workersSeen += 1;
        lastId = w.id;

        // CURRENT profile per worker — the shared `CURRENT_PROFILE_ORDER`, byte-identical to
        // what `WorkerSkillsRepository.findLatestProfileSignals` resolves on the live path.
        // The two used to hold the same total order by copy; a batch that rebuilt a worker's
        // skills from a different row than the live path reads is a silent divergence no test
        // would have caught, so they now share one definition instead of agreeing by hand.
        const profileRows = await db
          .select({
            canonicalRoleId: workerProfiles.canonicalRoleId,
            skills: workerProfiles.skills,
            experience: workerProfiles.experience,
            // #2075 — the SAME source-session read as `WorkerSkillsRepository`: one SQL definition.
            sourceSession: PROFILE_SOURCE_SESSION_ANSWERS,
          })
          .from(workerProfiles)
          .where(eq(workerProfiles.workerId, w.id))
          .orderBy(...CURRENT_PROFILE_ORDER)
          .limit(1);
        const profile = profileRows[0];

        // Layer A (f) — declared secondary occupations join the role bridge, exactly as the live
        // path reads them (`WorkerSkillsRepository.findSecondaryRoleIds`). Without this the batch
        // would prune the extra rows the endpoint derived, silently rolling a worker's reach back.
        const secondaryRoleIds = (
          await db
            .select({ roleId: workerOccupations.roleId })
            .from(workerOccupations)
            .where(eq(workerOccupations.workerId, w.id))
            .orderBy(asc(workerOccupations.sortOrder))
        ).map((row) => row.roleId);

        // THE SAME ASSEMBLY AS THE LIVE REBUILD (`workerSkillDeriveInput`, @badabhai/match-engine):
        // profile signals ∪ declared occupations ∪ pack answers, and the same "nothing to derive
        // from" guard. This runner used to skip every worker with no profile row and never read
        // pack answers — so a trade-form worker was never repaired, and one who ALSO had a profile
        // had his pack-derived rows pruned by the stale-row delete below.
        const exp = asObject(profile?.experience);
        const totalYears = exp ? (finiteOrNull(exp.total_years) ?? 0) : 0;
        const input = workerSkillDeriveInput({
          profile: profile
            ? {
                canonicalRoleId: profile.canonicalRoleId,
                profileSkills: asStringArray(profile.skills),
                totalYears,
                sourceSession: profile.sourceSession ?? null,
              }
            : null,
          secondaryRoleIds,
          packAnswers: packAnswersByWorker.get(w.id) ?? [],
          // Absent while the switch is off, exactly as the live rebuild omits it.
          ...(formTenure.months ? { formTenure: formTenureByWorker.get(w.id) ?? [] } : {}),
        });
        // No profile, no pack evidence, no declared occupation → leave his rows exactly as they are.
        if (input === null) continue;
        if (profile) workersWithProfile += 1;
        else workersDerivedFromPackOnly += 1;
        if (input.formTenureYears !== undefined) workersWithFormTenure += 1;

        // TD120 (paid 2026-08-01): the coarse rule lives in `@badabhai/match-engine` and
        // NOWHERE ELSE. This block used to be a hand-rolled second implementation that
        // agreed with the engine only by coincidence — nothing held them equal, so a future
        // edit to a bridge or a bucket would land in one and not the other, the backfill
        // would write one set of months and the worker's next chat turn would re-derive a
        // different set through moment ①, and a man's rank would change for a reason no ops
        // person could explain. Parity at the swap was measured, not assumed: 7,854 cases
        // (14 roles x 51 attribute sets x 11 experience values), 0 mismatches.
        const derived: DerivedSkill[] = deriveWorkerSkills(input, {
          ...DEFAULT_MATCH_CONFIG,
          monthBucket,
        }).map((r) => ({
          skillId: r.skillId,
          industryId: r.industryId,
          monthsBucketed: r.monthsBucketed,
        }));

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
          // so an interview-authored skill is honoured by the clamp too. `computeIndustryTenure`
          // is the SAME function `WorkerSkillsService.rebuildForWorker` calls on the live path —
          // a hand-rolled max-by-industry loop used to live here, and it treated a worker's FIRST
          // skill at `monthsBucketed = 0` as "no industry at all" (its running max started at 0,
          // so `0 > 0` never promoted the industry into the map), silently deleting the industry's
          // tenure row instead of writing it. The shared function has no such sentinel.
          const liveRowsRaw = await db
            .select({
              skillId: workerSkills.skillId,
              industryId: workerSkills.industryId,
              monthsBucketed: workerSkills.monthsBucketed,
              wants: workerSkills.wants,
              startedAt: workerSkills.startedAt,
              endedAt: workerSkills.endedAt,
            })
            .from(workerSkills)
            .where(eq(workerSkills.workerId, w.id));
          // Cast, not validate: the FK on `worker_skill.skill_id` (and the matching one on
          // `industry_id`) already pins every row to the closed vocabulary.
          const liveRows: WorkerSkillRow[] = liveRowsRaw.map((r) => ({
            ...r,
            skillId: r.skillId as MatchSkillId,
            industryId: r.industryId as IndustryId,
          }));

          const tenure = computeIndustryTenure(liveRows, totalYears, monthBucket);
          for (const [industryId, calendarMonths] of tenure) {
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
            tenure.size === 0
              ? eq(workerIndustryTenure.workerId, w.id)
              : and(
                  eq(workerIndustryTenure.workerId, w.id),
                  notInArray(workerIndustryTenure.industryId, [...tenure.keys()]),
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
          for (const id of existingDerived) {
            beforeBySkill.set(id, (beforeBySkill.get(id) ?? 0) + 1);
            if (!derivedSet.has(id)) skillsDeleted += 1;
          }
          for (const d of derived) afterBySkill.set(d.skillId, (afterBySkill.get(d.skillId) ?? 0) + 1);
          // Approximation from `derived` alone (see comment above the apply branch for why that
          // differs from the live rebuild) — but via the SAME tenure function, not a second one.
          const previewTenure = computeIndustryTenure(
            derived.map((d) => ({
              ...d,
              skillId: d.skillId as MatchSkillId,
              industryId: d.industryId as IndustryId,
              wants: true,
              startedAt: null,
              endedAt: null,
            })),
            totalYears,
            monthBucket,
          );
          tenureRowsWritten += previewTenure.size;
        }
      }

      if (batch.length < opts.batchSize) break;
      cursor = batch[batch.length - 1]!.id;
    }

    printCounts(NAME, {
      "month_bucket in force": monthBucket,
      "workers scanned": workersSeen,
      "workers with a profile": workersWithProfile,
      "workers derived from pack answers only": workersDerivedFromPackOnly,
      "workers deriving 0 skills": workersWithNoDerivedSkills,
      "workers with a form tenure fill": formTenure.months ? workersWithFormTenure : "(switch off)",
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
    if (!opts.apply) {
      // #3052 §2 — per skill workers before/after, counts only. A skill with
      // after < before loses workers on rebuild and stops the seed (§3).
      const skills = [...new Set([...beforeBySkill.keys(), ...afterBySkill.keys()])].sort();
      console.log(`[${NAME}] per skill workers before/after (dry run, counts only):`);
      for (const skill of skills) {
        const before = beforeBySkill.get(skill) ?? 0;
        const after = afterBySkill.get(skill) ?? 0;
        console.log(`  ${skill}  before=${before} after=${after} delta=${after - before}`);
      }
    }
    printFooter(NAME, opts, skillsUpserted + skillsDeleted + tenureRowsWritten);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  // nosemgrep: javascript.lang.security.audit.unsafe-formatstring.unsafe-formatstring -- `SCRIPT` is a module-level string constant declared in this file, never input. This is the CLI's terminal error line; no user- or worker-supplied value reaches the template.
  console.error(`[${NAME}] failed:`, err instanceof Error ? err.message : err);
  process.exit(1);
});
