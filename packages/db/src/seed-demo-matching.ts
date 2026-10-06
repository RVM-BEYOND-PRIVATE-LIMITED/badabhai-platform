/**
 * Matching V1 stakeholder DEMO seed — synthetic payers, 1,200 OPEN postings across the 9 role
 * kinds that have a real match skill, 10 personas, and the ANSWER KEY that proves each feed shows only the jobs its skills reach.
 * Runbook: docs/demo/matching-demo-runbook.md.
 *
 * WHAT IT WRITES (DIRECT inserts; NO events — seeded demo data, not business activity; every id
 * is namespaced `de30…`, see `demo-matching-plan.ts`):
 *   payers          25 synthetic employers (org name + `.invalid` email, encrypted + hashed)
 *   workers         one per persona: RESERVED synthetic phone (+9100000 26xxx, the test-login
 *                   range), synthetic name — both encrypted with the API's crypto
 *   worker_profiles one confirmed profile per persona (city, total years, skill labels)
 *   worker_consents one live consent per persona (`employer_sharing` on a LOCAL target only)
 *   worker_skill    1-2 rows per persona (wants=true, source='ops', varied months)
 *   job_postings    OPEN, `role_kind` set, realistic card fields, `published_at` over 30 days,
 *                   ~3% boosted; `match_skill_ids` = the skills onboarding derives for the trade
 *                   and `reach_skill_ids` resolved by the publish rule (`resolveReachSet` + the
 *                   live `match_config`), cross-checked against the seeded `skill_related`
 *   job_reach       materialized by D5's own `materializePostingReach` — the statement is NOT
 *                   forked; a posting D5 would skip fails this seed instead
 *
 * Re-running is idempotent (upserts) and SYNCS: demo rows outside the current plan are removed.
 *
 * MODES
 *   (default)              dry run: the plan + each persona's expected direct/related/hidden split
 *   --apply                write, materialize, print + self-check the answer key
 *   --answer-key-only      read-only: recompute the answer key from the database
 *   --report-trades        read-only: per occupation (chat role / trade form), the open postings a
 *                          FRESH worker with that occupation's derived skills would see
 *   --unseed | --cleanup   (with --apply) delete every `de30…` row, cascading reach/applications.
 *                          REFUSES while non-demo workers hold applications to demo postings,
 *                          unless --delete-real-applications; `--close-only` instead closes the
 *                          demo postings (off every feed, nothing deleted)
 *   --reset-live-worker --phone=<E.164> --allow-phones=<file>
 *                          (with --apply) delete ONE live demo worker's profile, worker_skill and
 *                          job_reach so the onboarding chat extracts again. Local: the phone must
 *                          be in the demo block AND in the file. Production: the file is the only
 *                          authority (a real number may be reset iff the owner listed it).
 *
 * THE ANSWER KEY is read back after materialization: per persona the visible total, direct
 * (tier 1) vs related (tier 2), the hidden demo set, and the top 10 cards in FEED ORDER, computed
 * by `feedOrderSql` — a mirror of `MatchFeedRepository.listFeed` — then `interleaveMaxPerCompany`
 * with the live config, exactly as `MatchFeedService.getFeed` does. The mirror is PINNED to the
 * real service by `apps/api/src/match/demo-matching-seed.db.test.ts` (a CI DB gate); if the V1
 * feed order changes, that gate fails until this mirror follows.
 *
 * GUARDS
 *   - `parseCommonCli` → `enforceOpsGuard` (as the E4 fixture): a WRITE to a production-like
 *     target, or with NODE_ENV=production, needs `--i-am-authorised-to-write-to-production` AND
 *     `OPS_ALLOW_PRODUCTION=seed:demo-matching`.
 *   - On top: ANY run against a production-like target (even read-only) needs `--target=production`,
 *     and `--target=production` against a local database is refused as a mismatch.
 *   - Every worker-visible string is screened (ADR-0024) before anything is written.
 *   - Logs carry ids, counts, titles and the reserved synthetic phones only.
 *
 *   pnpm --filter @badabhai/db db:seed:demo-matching --apply --answer-key=/tmp/key.json
 *   pnpm --filter @badabhai/db db:unseed:demo-matching --apply
 *
 * Options: --personas=N (1..10) --postings=N (>= one per trade) --rng-seed=N --anchor=<ISO>
 *          --feed-limit=N (the `GET /feed` limit to simulate; default 50, the API default)
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { and, eq, inArray, notInArray, sql as dsql } from "drizzle-orm";

import {
  interleaveMaxPerCompany,
  parseMatchConfig,
  resolveReachSet,
  type MatchConfig,
} from "@badabhai/match-engine";
import { ROLE_TO_MATCH_SKILL, matchSkillIndustry, matchSkillLabel } from "@badabhai/taxonomy";
import {
  CURRENT_CONSENT_VERSION,
  TRADE_FORM_KINDS_ALL,
  type ConsentPurpose,
} from "@badabhai/types";
import { workerVisibleTextScreens } from "@badabhai/validators";

import { createDbClient, type Database } from "./client";
import { encryptPii, hashPhone } from "./crypto";
import {
  buildDemoPlan,
  DEFAULT_DEMO_PLAN,
  DEMO_TRADES,
  MAX_DEMO_PERSONAS,
  DEMO_PHONE_PATTERN,
  demoIdLikePattern,
  personaExpectation,
  workerVisibleFields,
  type DemoPlan,
  type DemoPosting,
} from "./demo-matching-plan";
import { expandReachSkillIds } from "./match-v1-derive";
import {
  argFlag,
  argValue,
  parseCommonCli,
  printCounts,
  printFooter,
  printHeader,
} from "./match-v1-cli";
import { materializePostingReach } from "./materialize-job-reach";
import { hostClass, isProductionLike } from "./ops-guard";
import {
  jobPostings,
  matchConfig,
  payers,
  skills,
  workerConsents,
  workerProfiles,
  workerSkills,
  workers,
} from "./schema";

const NAME = "seed:demo-matching";

/**
 * Persona consent purposes. `employer_sharing` (the unlock gate) is granted only on a LOCAL target:
 * on production a real employer whose posting reaches a persona could otherwise spend a credit
 * unlocking a worker who does not exist. The feed itself needs no consent purpose.
 */
export function personaConsentPurposes(target: "local" | "production"): ConsentPurpose[] {
  const base: ConsentPurpose[] = ["profiling", "resume_generation", "communication"];
  return target === "production" ? base : [...base, "employer_sharing"];
}

/** How long a seeded boost lasts past the anchor. Re-run the seed to refresh it. */
const BOOST_DAYS = 14;
/** The `GET /feed` default limit (`applications.dto.ts`). */
const DEFAULT_FEED_LIMIT = 50;
/** `MatchFeedService` overfetch — mirrored, pinned by the apps/api DB gate. */
const OVERFETCH_MULTIPLIER = 3;
const OVERFETCH_CAP = 300;
const TOP_N = 10;
const INSERT_CHUNK = 200;

// ---------------------------------------------------------------------------
// Plan validation (pure)
// ---------------------------------------------------------------------------

/** Fail closed if any worker-visible string trips the ADR-0024 screens. Names fields, never text. */
export function assertWorkerVisibleTextClean(postings: readonly DemoPosting[]): void {
  for (const p of postings) {
    for (const [field, text] of workerVisibleFields(p)) {
      const screens = workerVisibleTextScreens(text);
      if (screens.length > 0) {
        throw new Error(
          `[${NAME}] worker-visible text screen tripped — posting ${p.postingId} field ${field} ` +
            `(${screens.join(",")}); aborting before any write.`,
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Reach resolution — the publish rule, cross-checked against the seeded vocabulary
// ---------------------------------------------------------------------------

async function loadMatchConfig(db: Database): Promise<MatchConfig> {
  const rows = await db
    .select({ config: matchConfig.config })
    .from(matchConfig)
    .where(eq(matchConfig.isActive, true))
    .limit(1);
  // Same value path as MatchConfigService: no row or a bad row → the typed defaults.
  return parseMatchConfig(rows[0]?.config);
}

/**
 * Resolve every posting's `reach_skill_ids` exactly as `MatchSkillsService.resolveForPublish`
 * does (no unticks). Fails closed when the database vocabulary is missing a skill or its
 * `skill_related` edges disagree with the taxonomy publish reads — either would make the demo
 * prove something other than what production does.
 */
export async function resolveDemoReachSets(
  db: Database,
  plan: DemoPlan,
  config: MatchConfig,
): Promise<Map<string, string[]>> {
  const allSkills = [
    ...new Set(
      plan.postings
        .flatMap((p) => p.matchSkillIds)
        .concat(plan.personas.flatMap((p) => p.skills.map((s) => s.skillId))),
    ),
  ].sort();
  const present = await db
    .select({ skillId: skills.skillId })
    .from(skills)
    .where(inArray(skills.skillId, allSkills));
  const missing = allSkills.filter((id) => !present.some((r) => r.skillId === id));
  if (missing.length > 0) {
    throw new Error(
      `[${NAME}] match skills missing from the "skill" table: ${missing.join(", ")}. ` +
        `Run: pnpm --filter @badabhai/db db:seed:match:vocabulary --apply`,
    );
  }

  const bySet = new Map<string, string[]>();
  const out = new Map<string, string[]>();
  for (const p of plan.postings) {
    const key = [...p.matchSkillIds].sort().join(",");
    let reach = bySet.get(key);
    if (reach === undefined) {
      const resolved = resolveReachSet({
        postedSkillIds: p.matchSkillIds,
        relatedDefault: config.relatedSkillsDefault,
        untickedIds: [],
      });
      if (resolved.postedSkillIds.length !== p.matchSkillIds.length) {
        throw new Error(`[${NAME}] posting ${p.postingId} names a non-match skill id.`);
      }
      reach = [...resolved.reachSkillIds];
      if (config.relatedSkillsDefault === "on") {
        const fromDb = await expandReachSkillIds(db, [...p.matchSkillIds]);
        if (fromDb.join(",") !== [...reach].sort().join(",")) {
          throw new Error(
            `[${NAME}] skill_related in the database disagrees with the taxonomy for {${key}} ` +
              `(db=${fromDb.join(",")} taxonomy=${reach.join(",")}). Re-run db:seed:match:vocabulary.`,
          );
        }
      }
      bySet.set(key, reach);
    }
    out.set(p.postingId, reach);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Writer
// ---------------------------------------------------------------------------

export interface DemoCrypto {
  key: string;
  pepper: string;
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

const excluded = (col: string) => dsql.raw(`excluded.${col}`);

/**
 * A reserved demo phone must belong to its demo worker or to nobody. If test-login already
 * created a worker for one of them under a random id, refuse: the namespaced unseed could not
 * remove that worker, and two rows cannot share a `phone_hash`.
 */
async function assertPhonesUnclaimed(db: Database, plan: DemoPlan, pepper: string): Promise<void> {
  const hashes = plan.personas.map((p) => hashPhone(p.phoneE164, pepper));
  const owners = await db
    .select({ id: workers.id, phoneHash: workers.phoneHash })
    .from(workers)
    .where(inArray(workers.phoneHash, hashes));
  const foreign = owners.filter((o) => !plan.personas.some((p) => p.workerId === o.id));
  if (foreign.length > 0) {
    throw new Error(
      `[${NAME}] ${foreign.length} reserved demo phone(s) already belong to non-demo worker(s) ` +
        `${foreign.map((f) => f.id).join(", ")} (created by a login before seeding?). Remove ` +
        `those workers, then re-run. Nothing was written.`,
    );
  }
}

export interface ApplyDemoSeedResult {
  payers: number;
  workers: number;
  workerSkills: number;
  postings: number;
  boosted: number;
  staleRemoved: number;
}

export async function applyDemoSeed(
  db: Database,
  plan: DemoPlan,
  reach: ReadonlyMap<string, string[]>,
  crypto: DemoCrypto,
  anchor: Date,
  target: "local" | "production" = "local",
): Promise<ApplyDemoSeedResult> {
  const consentPurposes = personaConsentPurposes(target);
  assertWorkerVisibleTextClean(plan.postings);
  await assertPhonesUnclaimed(db, plan, crypto.pepper);
  const boostedUntil = new Date(anchor.getTime() + BOOST_DAYS * 86_400_000);

  return db.transaction(async (tx) => {
    // 1. Payers.
    for (const p of plan.payers) {
      await tx
        .insert(payers)
        .values({
          id: p.payerId,
          role: "employer",
          emailEnc: encryptPii(p.email, crypto.key),
          emailHash: hashPhone(p.email, crypto.pepper),
          orgNameEnc: encryptPii(p.orgName, crypto.key),
          status: "active",
        })
        .onConflictDoUpdate({
          target: payers.id,
          set: {
            emailEnc: encryptPii(p.email, crypto.key),
            emailHash: hashPhone(p.email, crypto.pepper),
            orgNameEnc: encryptPii(p.orgName, crypto.key),
            status: "active",
            updatedAt: anchor,
          },
        });
    }

    // 2. Personas: worker + profile + consent + skills.
    let skillRows = 0;
    for (const w of plan.personas) {
      const phoneEnc = encryptPii(w.phoneE164, crypto.key);
      const nameEnc = encryptPii(w.name, crypto.key);
      await tx
        .insert(workers)
        .values({
          id: w.workerId,
          phoneE164: phoneEnc,
          phoneHash: hashPhone(w.phoneE164, crypto.pepper),
          fullName: nameEnc,
          status: "active",
          currentCity: w.city,
        })
        .onConflictDoUpdate({
          target: workers.id,
          set: {
            phoneHash: hashPhone(w.phoneE164, crypto.pepper),
            phoneE164: phoneEnc,
            fullName: nameEnc,
            status: "active",
            currentCity: w.city,
            updatedAt: anchor,
          },
        });

      const profile = {
        profileStatus: "confirmed",
        skills: w.skills.map((s) => matchSkillLabel(s.skillId) ?? s.skillId),
        experience: { total_years: w.totalYears },
        locationPreference: { city: w.citySlug, preferred_cities: [w.citySlug] },
        availability: { status: "immediate" },
        confirmedAt: anchor,
        updatedAt: anchor,
      } as const;
      await tx
        .insert(workerProfiles)
        .values({ id: w.profileId, workerId: w.workerId, ...profile, skills: [...profile.skills] })
        .onConflictDoUpdate({
          target: workerProfiles.id,
          set: { ...profile, skills: [...profile.skills] },
        });

      await tx
        .insert(workerConsents)
        .values({
          id: w.consentId,
          workerId: w.workerId,
          consentVersion: CURRENT_CONSENT_VERSION,
          purposes: consentPurposes,
          acceptedAt: anchor,
        })
        .onConflictDoUpdate({
          target: workerConsents.id,
          set: {
            consentVersion: CURRENT_CONSENT_VERSION,
            purposes: consentPurposes,
            revokedAt: null,
          },
        });

      const wanted = w.skills.map((s) => s.skillId);
      await tx
        .delete(workerSkills)
        .where(
          and(eq(workerSkills.workerId, w.workerId), notInArray(workerSkills.skillId, wanted)),
        );
      for (const s of w.skills) {
        const industryId = matchSkillIndustry(s.skillId);
        if (!industryId) throw new Error(`[${NAME}] ${s.skillId} has no industry in the taxonomy.`);
        const row = {
          industryId,
          monthsBucketed: s.months,
          wants: true,
          source: "ops" as const,
          updatedAt: anchor,
        };
        await tx
          .insert(workerSkills)
          .values({ workerId: w.workerId, skillId: s.skillId, ...row })
          .onConflictDoUpdate({ target: [workerSkills.workerId, workerSkills.skillId], set: row });
        skillRows += 1;
      }
    }

    // 3. Postings, in chunks.
    for (const batch of chunks(plan.postings, INSERT_CHUNK)) {
      await tx
        .insert(jobPostings)
        .values(
          batch.map((p) => {
            const payer = plan.payers[p.payerIndex]!;
            return {
              id: p.postingId,
              createdBy: payer.payerId,
              payerId: payer.payerId,
              orgLabel: `SYNTHETIC — Demo Employer ${String(p.payerIndex + 1).padStart(2, "0")}`,
              roleTitle: p.roleTitle,
              locationLabel: `${p.area}, ${p.city}`,
              description: p.description,
              vacancyBand: p.vacancyBand,
              status: "open" as const,
              industryId: p.industryId,
              roleKind: p.roleKind,
              matchSkillIds: p.matchSkillIds,
              reachSkillIds: reach.get(p.postingId)!,
              city: p.city,
              area: p.area,
              payMin: p.payMin,
              payMax: p.payMax,
              payType: p.payType,
              shift: p.shift,
              neededBy: p.neededBy,
              minExperienceYears: p.minExperienceYears,
              maxExperienceYears: p.maxExperienceYears,
              benefits: p.benefits,
              requirements: p.requirements,
              publishedAt: new Date(anchor.getTime() - p.publishedMinutesAgo * 60_000),
              boostedUntil: p.boosted ? boostedUntil : null,
              updatedAt: anchor,
            };
          }),
        )
        .onConflictDoUpdate({
          target: jobPostings.id,
          set: Object.fromEntries(
            [
              ["createdBy", "created_by"],
              ["payerId", "payer_id"],
              ["orgLabel", "org_label"],
              ["roleTitle", "role_title"],
              ["locationLabel", "location_label"],
              ["description", "description"],
              ["vacancyBand", "vacancy_band"],
              ["status", "status"],
              ["industryId", "industry_id"],
              ["roleKind", "role_kind"],
              ["matchSkillIds", "match_skill_ids"],
              ["reachSkillIds", "reach_skill_ids"],
              ["city", "city"],
              ["area", "area"],
              ["payMin", "pay_min"],
              ["payMax", "pay_max"],
              ["payType", "pay_type"],
              ["shift", "shift"],
              ["neededBy", "needed_by"],
              ["minExperienceYears", "min_experience_years"],
              ["maxExperienceYears", "max_experience_years"],
              ["benefits", "benefits"],
              ["requirements", "requirements"],
              ["publishedAt", "published_at"],
              ["boostedUntil", "boosted_until"],
              ["updatedAt", "updated_at"],
            ].map(([k, col]) => [k, excluded(col!)]),
          ),
        });
    }

    // 4. Sync: drop demo rows a previous, larger plan left behind.
    const staleRemoved = await removeDemoRowsOutside(tx as unknown as Database, plan);

    return {
      payers: plan.payers.length,
      workers: plan.personas.length,
      workerSkills: skillRows,
      postings: plan.postings.length,
      boosted: plan.postings.filter((p) => p.boosted).length,
      staleRemoved,
    };
  });
}

function rowsOf<T>(result: unknown): T[] {
  return Array.isArray(result) ? (result as T[]) : [];
}

async function removeDemoRowsOutside(db: Database, plan: DemoPlan): Promise<number> {
  const keepPostings = dsql.param(plan.postings.map((p) => p.postingId));
  const keepWorkers = dsql.param(plan.personas.map((p) => p.workerId));
  const keepPayers = dsql.param(plan.payers.map((p) => p.payerId));
  const a = rowsOf(
    await db.execute(dsql`
      DELETE FROM job_postings
      WHERE id::text LIKE ${demoIdLikePattern("posting")} AND NOT (id = ANY(${keepPostings}::uuid[]))
      RETURNING 1`),
  ).length;
  const b = rowsOf(
    await db.execute(dsql`
      DELETE FROM workers
      WHERE id::text LIKE ${demoIdLikePattern("worker")} AND NOT (id = ANY(${keepWorkers}::uuid[]))
      RETURNING 1`),
  ).length;
  const c = rowsOf(
    await db.execute(dsql`
      DELETE FROM payers
      WHERE id::text LIKE ${demoIdLikePattern("payer")} AND NOT (id = ANY(${keepPayers}::uuid[]))
      RETURNING 1`),
  ).length;
  return a + b + c;
}

/** Applications REAL (non-demo) workers made to demo postings — what a hard cleanup would delete. */
export async function countRealApplicationsToDemo(db: Database): Promise<number> {
  return (
    rowsOf<{ n: number }>(
      await db.execute(dsql`
        SELECT count(*)::int AS n FROM applications a
        WHERE a.job_posting_id::text LIKE ${demoIdLikePattern("posting")}
          AND a.worker_id::text NOT LIKE ${demoIdLikePattern("worker")}`),
    )[0]?.n ?? 0
  );
}

/**
 * The SOFT cleanup: close every open demo posting (off every feed at once, `job_reach` and any
 * real worker's application rows kept, so no business record is deleted and no event is
 * orphaned). Run the hard `--cleanup` later, once those applications are dealt with.
 */
export async function closeDemoPostings(db: Database, now: Date): Promise<number> {
  return rowsOf(
    await db.execute(dsql`
      UPDATE job_postings
      SET status = 'closed', closed_at = ${now.toISOString()}::timestamptz,
          updated_at = ${now.toISOString()}::timestamptz
      WHERE id::text LIKE ${demoIdLikePattern("posting")} AND status <> 'closed'
      RETURNING 1`),
  ).length;
}

/**
 * Remove every demo row. Postings first (cascades job_reach / applications / learn_labels / …),
 * then workers, payers. The CLI refuses this while real workers hold applications to demo
 * postings unless `--delete-real-applications` is passed (see the runbook); `--close-only` is
 * the non-destructive alternative.
 */
export async function unseedDemo(db: Database): Promise<Record<string, number>> {
  return db.transaction(async (tx) => {
    const del = async (
      table: "job_postings" | "workers" | "payers",
      kind: "posting" | "worker" | "payer",
    ) =>
      rowsOf(
        await tx.execute(
          dsql`DELETE FROM ${dsql.identifier(table)} WHERE id::text LIKE ${demoIdLikePattern(kind)} RETURNING 1`,
        ),
      ).length;
    return {
      "job_postings deleted": await del("job_postings", "posting"),
      "workers deleted (cascades profile/consent/skills/reach)": await del("workers", "worker"),
      "payers deleted": await del("payers", "payer"),
    };
  });
}

// ---------------------------------------------------------------------------
// Materialization — D5's own function, per demo posting
// ---------------------------------------------------------------------------

export interface DemoMaterializeResult {
  materialized: number;
  rowsInserted: number;
  rowsUpdated: number;
  rowsDeleted: number;
}

export async function materializeDemoReach(
  db: Database,
  plan: DemoPlan,
): Promise<DemoMaterializeResult> {
  const out: DemoMaterializeResult = {
    materialized: 0,
    rowsInserted: 0,
    rowsUpdated: 0,
    rowsDeleted: 0,
  };
  for (const p of plan.postings) {
    const outcome = await materializePostingReach(db, p.postingId, { apply: true });
    if (outcome.kind === "skipped") {
      // D5 would skip it too — the seed wrote an unmaterializable posting. That is a bug here.
      throw new Error(`[${NAME}] D5 skipped demo posting ${p.postingId} (${outcome.reason}).`);
    }
    out.materialized += 1;
    out.rowsInserted += outcome.rowsInserted;
    out.rowsUpdated += outcome.rowsUpdated;
    out.rowsDeleted += outcome.rowsDeleted;
  }
  return out;
}

/**
 * D5 refreshes only DEMO postings, so a persona that dropped a skill would keep `job_reach` rows on
 * OTHER (real) postings. Remove them with D5's own stale predicate — the posting's STORED reach
 * set no longer holds any skill the persona wants — scoped to persona workers. Never adds a row
 * and never touches a non-persona worker.
 */
export async function prunePersonaStaleReach(db: Database, plan: DemoPlan): Promise<number> {
  const personaIds = dsql.param(plan.personas.map((p) => p.workerId));
  return rowsOf(
    await db.execute(dsql`
      DELETE FROM job_reach jr
      USING job_postings jp
      WHERE jr.job_posting_id = jp.id
        AND jr.worker_id = ANY(${personaIds}::uuid[])
        AND NOT EXISTS (
          SELECT 1 FROM worker_skill ws
          WHERE ws.worker_id = jr.worker_id AND ws.wants AND jp.reach_skill_ids ? ws.skill_id
        )
      RETURNING 1`),
  ).length;
}

// ---------------------------------------------------------------------------
// Answer key
// ---------------------------------------------------------------------------

/**
 * MIRROR OF `MatchFeedRepository.listFeed` (apps/api/src/match/match-feed.repository.ts) with
 * every worker filter OFF — its FROM/WHERE/ORDER BY, column for column. Pinned to the real
 * service by `apps/api/src/match/demo-matching-seed.db.test.ts`; change both together.
 */
function feedOrderSql(workerId: string, limit: number) {
  return dsql`
    SELECT jp.id::text                                  AS job_posting_id,
           COALESCE(jp.payer_id, jp.created_by)::text   AS payer_key,
           jr.match_tier                                AS match_tier,
           jr.matched_skill_id                          AS matched_skill_id,
           (jp.boosted_until IS NOT NULL AND jp.boosted_until > now()) AS boosted,
           jp.published_at                              AS published_at,
           jp.role_title                                AS role_title,
           jp.city                                      AS city
    FROM job_reach jr
    JOIN job_postings jp ON jp.id = jr.job_posting_id
    WHERE jr.worker_id = ${workerId}::uuid
      AND jp.status = 'open'
      AND NOT EXISTS (
        SELECT 1 FROM applications a
        WHERE a.worker_id = ${workerId}::uuid
          AND a.job_posting_id = jp.id
      )
    ORDER BY (jp.boosted_until IS NOT NULL AND jp.boosted_until > now()) DESC,
             jp.published_at DESC NULLS LAST,
             jp.id ASC
    LIMIT ${limit}
  `;
}

export interface AnswerKeyCard {
  rank: number;
  jobPostingId: string;
  title: string;
  city: string | null;
  tier: 1 | 2;
  matchedSkillId: string;
  boosted: boolean;
  publishedAt: string | null;
  /** Demo employer number (01..25), or "non-demo" for a posting this seed did not write. */
  employer: string;
}

export interface AnswerKeyPersona {
  key: string;
  name: string;
  city: string;
  showcase: boolean;
  story: string;
  workerId: string;
  /** RESERVED synthetic phone — log in with it (see the runbook). */
  phoneE164: string;
  skills: Array<{ skillId: string; label: string; months: number }>;
  visible: number;
  direct: number;
  related: number;
  /** Of `visible`, cards this seed wrote vs cards from other (real/staging) postings. */
  visibleDemo: number;
  visibleOther: number;
  /** Open demo postings this persona does NOT see (their reach misses every wanted skill). */
  hidden: number;
  boostedVisible: number;
  /** True when the max-per-employer interleave changed this persona's top 10 (it is visible). */
  interleaveChangedTop10: boolean;
  top10: AnswerKeyCard[];
}

export interface AnswerKey {
  generatedAt: string;
  /** The `--anchor` the seed used for `published_at` / boosts (pass it back to reproduce). */
  anchor: string | null;
  feedLimit: number;
  maxConsecutiveSameCompany: number;
  demoOpenPostings: number;
  orderSource: string;
  personas: AnswerKeyPersona[];
}

/**
 * Read the answer key back from the database, and SELF-CHECK it against the plan: the demo
 * postings a persona sees must be EXACTLY the plan's direct ∪ related-only set, with tier 1 for
 * direct and tier 2 for related-only. Any mismatch throws — the demo would be lying.
 */
export async function computeDemoAnswerKey(
  db: Database,
  plan: DemoPlan,
  reach: ReadonlyMap<string, string[]>,
  opts: { feedLimit: number; now: Date; anchor?: Date },
): Promise<AnswerKey> {
  const config = await loadMatchConfig(db);
  const demoPostings = plan.postings.map((p) => ({
    postingId: p.postingId,
    matchSkillIds: p.matchSkillIds,
    reachSkillIds: reach.get(p.postingId) ?? [],
  }));
  const demoIds = new Set(demoPostings.map((p) => p.postingId));
  const payerNo = new Map(
    plan.payers.map((p) => [p.payerId, String(p.index + 1).padStart(2, "0")]),
  );
  // Counted against the PLAN's postings, so `--answer-key-only` with a smaller plan than the
  // database holds does not inflate `hidden` with demo rows outside it.
  const planIds = dsql.param([...demoIds]);
  const openDemo =
    rowsOf<{ n: number }>(
      await db.execute(dsql`
      SELECT count(*)::int AS n FROM job_postings
      WHERE id = ANY(${planIds}::uuid[]) AND status = 'open'`),
    )[0]?.n ?? 0;

  const personas: AnswerKeyPersona[] = [];
  for (const w of plan.personas) {
    const reached = rowsOf<{ id: string; tier: number; reach: string[]; boosted: boolean }>(
      await db.execute(dsql`
        SELECT jp.id::text AS id, jr.match_tier AS tier, jp.reach_skill_ids AS reach,
               (jp.boosted_until IS NOT NULL AND jp.boosted_until > now()) AS boosted
        FROM job_reach jr JOIN job_postings jp ON jp.id = jr.job_posting_id
        WHERE jr.worker_id = ${w.workerId}::uuid AND jp.status = 'open'
          AND NOT EXISTS (SELECT 1 FROM applications a
                          WHERE a.worker_id = ${w.workerId}::uuid AND a.job_posting_id = jp.id)`),
    );

    // ── Self-check against the plan (the proof) ──
    const expected = personaExpectation(w, demoPostings);
    const tierById = new Map(reached.filter((r) => demoIds.has(r.id)).map((r) => [r.id, r.tier]));
    const problems: string[] = [];
    for (const id of expected.direct)
      if (tierById.get(id) !== 1)
        problems.push(`${id} expected tier 1, got ${tierById.get(id) ?? "hidden"}`);
    for (const id of expected.relatedOnly)
      if (tierById.get(id) !== 2)
        problems.push(`${id} expected tier 2, got ${tierById.get(id) ?? "hidden"}`);
    const allowed = new Set([...expected.direct, ...expected.relatedOnly]);
    for (const id of tierById.keys())
      if (!allowed.has(id)) problems.push(`${id} visible but outside the persona's reach`);
    // Every visible row — demo or not — must be reachable through its STORED set.
    const wants = new Set(w.skills.map((s) => s.skillId));
    for (const r of reached)
      if (!r.reach.some((id) => wants.has(id)))
        problems.push(`${r.id} visible but its stored reach set holds no wanted skill`);
    if (problems.length > 0) {
      throw new Error(
        `[${NAME}] answer-key self-check FAILED for ${w.key}: ${problems.slice(0, 5).join("; ")}` +
          (problems.length > 5 ? ` (+${problems.length - 5} more)` : ""),
      );
    }

    // ── Feed order: listFeed mirror → interleave → page → top 10 ──
    const overfetch = Math.min(opts.feedLimit * OVERFETCH_MULTIPLIER, OVERFETCH_CAP);
    const candidates = rowsOf<{
      job_posting_id: string;
      payer_key: string;
      match_tier: number;
      matched_skill_id: string;
      boosted: boolean;
      published_at: Date | string | null;
      role_title: string;
      city: string | null;
    }>(await db.execute(feedOrderSql(w.workerId, overfetch))).map((r) => ({
      ...r,
      payerKey: r.payer_key,
    }));
    const page = interleaveMaxPerCompany(candidates, config.maxConsecutiveSameCompany).slice(
      0,
      opts.feedLimit,
    );

    const visibleDemo = reached.filter((r) => demoIds.has(r.id)).length;
    personas.push({
      key: w.key,
      name: w.name,
      city: w.city,
      showcase: w.showcase,
      story: w.story,
      workerId: w.workerId,
      phoneE164: w.phoneE164,
      skills: w.skills.map((s) => ({
        skillId: s.skillId,
        label: matchSkillLabel(s.skillId) ?? s.skillId,
        months: s.months,
      })),
      visible: reached.length,
      direct: reached.filter((r) => r.tier === 1).length,
      related: reached.filter((r) => r.tier === 2).length,
      visibleDemo,
      visibleOther: reached.length - visibleDemo,
      hidden: openDemo - visibleDemo,
      boostedVisible: reached.filter((r) => r.boosted).length,
      interleaveChangedTop10:
        page
          .slice(0, TOP_N)
          .map((r) => r.job_posting_id)
          .join() !==
        candidates
          .slice(0, TOP_N)
          .map((r) => r.job_posting_id)
          .join(),
      top10: page.slice(0, TOP_N).map((r, i) => ({
        rank: i + 1,
        jobPostingId: r.job_posting_id,
        title: r.role_title,
        city: r.city,
        tier: r.match_tier === 1 ? 1 : 2,
        matchedSkillId: r.matched_skill_id,
        boosted: Boolean(r.boosted),
        publishedAt: r.published_at === null ? null : new Date(r.published_at).toISOString(),
        employer: payerNo.get(r.payer_key) ?? "non-demo",
      })),
    });
  }

  return {
    generatedAt: opts.now.toISOString(),
    anchor: opts.anchor?.toISOString() ?? null,
    feedLimit: opts.feedLimit,
    maxConsecutiveSameCompany: config.maxConsecutiveSameCompany,
    demoOpenPostings: openDemo,
    orderSource:
      "listFeed mirror (boost, published_at DESC, id) + interleaveMaxPerCompany; pinned by apps/api demo-matching-seed.db.test.ts",
    personas,
  };
}

function printAnswerKey(key: AnswerKey): void {
  console.log(
    `[${NAME}] ANSWER KEY — ${key.demoOpenPostings} open demo postings; feed limit ${key.feedLimit}; ` +
      `max ${key.maxConsecutiveSameCompany} consecutive per employer`,
  );
  console.log(
    `  ${"persona".padEnd(30)} ${"city".padEnd(10)} ${"visible".padStart(7)} ${"direct".padStart(6)} ` +
      `${"related".padStart(7)} ${"hidden".padStart(6)} ${"boost".padStart(5)}  phone`,
  );
  for (const p of key.personas) {
    console.log(
      `  ${(p.showcase ? "★ " : "  ") + p.key.padEnd(28)} ${p.city.padEnd(10)} ${String(p.visible).padStart(7)} ` +
        `${String(p.direct).padStart(6)} ${String(p.related).padStart(7)} ${String(p.hidden).padStart(6)} ` +
        `${String(p.boostedVisible).padStart(5)}  ${p.phoneE164}`,
    );
  }
  for (const p of key.personas.filter((x) => x.showcase)) {
    console.log(`\n  ★ ${p.key} — top ${p.top10.length} as served:`);
    for (const c of p.top10) {
      console.log(
        `    ${String(c.rank).padStart(2)}. ${c.jobPostingId}  T${c.tier}${c.boosted ? " BOOST" : "      "} ` +
          `emp ${c.employer}  ${c.title} — ${c.city ?? "?"}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Target declaration — a production-like database needs `--target=production` on top of the
// ops-guard's two signals; a plain run against it refuses even read-only.
// ---------------------------------------------------------------------------

/** Pure: why this (target, declaration) pair must not run, or null. Never echoes the URL. */
export function targetDeclarationProblem(
  databaseUrl: string,
  declared: string | undefined,
): string | null {
  const target = declared ?? "local";
  if (target !== "local" && target !== "production") {
    return `--target must be "local" or "production" (got "${target}").`;
  }
  const prodLike = isProductionLike(databaseUrl);
  if (prodLike && target !== "production") {
    return (
      `DATABASE_URL is ${hostClass(databaseUrl)} — a production-like target. This demo seed ` +
      `writes synthetic postings REAL WORKERS WILL SEE. Re-run with --target=production (plus, ` +
      `for a write, the ops-guard flag + OPS_ALLOW_PRODUCTION=${NAME}) only if the owner asked.`
    );
  }
  if (!prodLike && target === "production") {
    return `--target=production was declared but DATABASE_URL is ${hostClass(databaseUrl)}; refusing the mismatch.`;
  }
  return null;
}

function assertTargetDeclared(databaseUrl: string, declared: string | undefined): void {
  const problem = targetDeclarationProblem(databaseUrl, declared);
  if (problem !== null) throw new Error(`[${NAME}] ${problem}`);
}

// ---------------------------------------------------------------------------
// --reset-live-worker — let the owner re-run LIVE onboarding for one allow-listed phone
// ---------------------------------------------------------------------------

/** One E.164 per line; blank lines and `#` comments ignored. */
export function parseAllowPhones(text: string): Set<string> {
  return new Set(
    text
      .split(/\r?\n/)
      .map((l) => l.replace(/#.*/, "").trim())
      .filter((l) => l.length > 0),
  );
}

/** E.164: `+`, a non-zero country digit, 8–15 digits in all. */
const E164_PATTERN = /^\+[1-9]\d{7,14}$/;

/**
 * Pure gate for `--reset-live-worker` (owner decision, 2026-10-06):
 *   - LOCAL target: the phone must be in the reserved DEMO block AND on the allow-list;
 *   - PRODUCTION target: the allow-list file the owner creates on the server is the ONLY
 *     authority — a real number may be reset iff it is listed; everything else is refused.
 * The phone must be well-formed E.164 in both cases. Personas keep the demo block.
 */
export function resetPhoneProblem(
  phone: string,
  allowed: ReadonlySet<string>,
  target: "local" | "production" = "local",
): string | null {
  if (!E164_PATTERN.test(phone)) return `--phone must be an E.164 number (e.g. +91XXXXXXXXXX).`;
  if (target === "local" && !DEMO_PHONE_PATTERN.test(phone)) {
    return `--phone is outside the demo block ${DEMO_PHONE_PATTERN} of the reserved synthetic range — refusing to touch any other worker.`;
  }
  if (!allowed.has(phone)) return `--phone is not listed in the --allow-phones file — refusing.`;
  return null;
}

/**
 * Remove ONLY the worker's profile, worker_skill and job_reach rows, so the chat extracts again
 * (extraction is skipped for a worker who already has a profile). The worker row, consents,
 * chat history and applications stay.
 */
export async function resetLiveWorkerRows(
  db: Database,
  phoneHash: string,
): Promise<Record<string, number>> {
  const found = await db
    .select({ id: workers.id })
    .from(workers)
    .where(eq(workers.phoneHash, phoneHash))
    .limit(1);
  const workerId = found[0]?.id;
  if (workerId === undefined)
    throw new Error(`[${NAME}] no worker holds that phone — nothing to reset.`);
  return db.transaction(async (tx) => {
    const reach = rowsOf(
      await tx.execute(dsql`DELETE FROM job_reach WHERE worker_id = ${workerId}::uuid RETURNING 1`),
    ).length;
    const skillRows = (
      await tx
        .delete(workerSkills)
        .where(eq(workerSkills.workerId, workerId))
        .returning({ id: workerSkills.id })
    ).length;
    const profiles = (
      await tx
        .delete(workerProfiles)
        .where(eq(workerProfiles.workerId, workerId))
        .returning({ id: workerProfiles.id })
    ).length;
    return {
      [`worker ${workerId}: job_reach deleted`]: reach,
      "worker_skill deleted": skillRows,
      "worker_profiles deleted": profiles,
    };
  });
}

// ---------------------------------------------------------------------------
// --report-trades — what a FRESH worker of each occupation would see
// ---------------------------------------------------------------------------

export interface TradeReportRow {
  label: string;
  path: string;
  skills: string[];
}

/**
 * The occupations onboarding can produce, with the match skills each derives (traced
 * 2026-10-06; see `DemoTrade`). Chat rows come straight from `ROLE_TO_MATCH_SKILL` so they track
 * the bridge; the form rows record that only the turning form bridges today.
 */
export function tradeReportRows(): TradeReportRow[] {
  const chat = Object.entries(ROLE_TO_MATCH_SKILL).map(([roleId, skillId]) => ({
    label: roleId.replace(/^role_/, ""),
    path: "chat (role)",
    skills: [skillId],
  }));
  const forms = TRADE_FORM_KINDS_ALL.map((kind) => ({
    label: kind,
    path: "trade form",
    skills: kind === "cnc_turner" ? ["mskill_cnc_turner"] : [],
  }));
  return [...chat, ...forms];
}

async function printTradeReport(db: Database): Promise<void> {
  console.log(`[${NAME}] TRADE REPORT — open postings a fresh worker of each occupation would see`);
  console.log(
    `  ${"occupation".padEnd(30)} ${"path".padEnd(12)} ${"direct".padStart(6)} ${"related".padStart(7)}  (demo d/r)  skills`,
  );
  for (const row of tradeReportRows()) {
    let c = { direct: 0, related: 0, demo_direct: 0, demo_related: 0 };
    if (row.skills.length > 0) {
      const ids = dsql.param(row.skills);
      c =
        rowsOf<typeof c>(
          await db.execute(dsql`
            SELECT count(*) FILTER (WHERE match_skill_ids ?| ${ids}::text[])::int AS direct,
                   count(*) FILTER (WHERE NOT (match_skill_ids ?| ${ids}::text[])
                                      AND reach_skill_ids ?| ${ids}::text[])::int AS related,
                   count(*) FILTER (WHERE id::text LIKE ${demoIdLikePattern("posting")}
                                      AND match_skill_ids ?| ${ids}::text[])::int AS demo_direct,
                   count(*) FILTER (WHERE id::text LIKE ${demoIdLikePattern("posting")}
                                      AND NOT (match_skill_ids ?| ${ids}::text[])
                                      AND reach_skill_ids ?| ${ids}::text[])::int AS demo_related
            FROM job_postings WHERE status = 'open'`),
        )[0] ?? c;
    }
    console.log(
      `  ${row.label.padEnd(30)} ${row.path.padEnd(12)} ${String(c.direct).padStart(6)} ${String(c.related).padStart(7)}` +
        `  (${c.demo_direct}/${c.demo_related})  ${row.skills.length > 0 ? row.skills.join(",") : "— derives no match skill (sees nothing)"}`,
    );
  }
  console.log(
    `  Note: chat with STRUCTURED answers writes no role/skills (profile-extraction.processor.ts); the free-text ` +
      `chat path above is what a live demo uses. Role kinds with no real match skill get no demo postings.`,
  );
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function intArg(flag: string, fallback: number, min: number, max: number): number {
  const raw = argValue(flag);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new Error(`[${NAME}] --${flag} must be an integer in ${min}..${max}`);
  }
  return n;
}

function readCrypto(): DemoCrypto {
  const key = process.env.PII_ENCRYPTION_KEY;
  const pepper = process.env.PII_HASH_PEPPER;
  if (!key || !pepper) {
    throw new Error(
      `[${NAME}] PII_ENCRYPTION_KEY and PII_HASH_PEPPER must be set — demo phones/names are ` +
        `encrypted + hashed with the SAME crypto the API uses, so test-login resolves each ` +
        `persona by phone_hash.`,
    );
  }
  return { key, pepper };
}

async function main(): Promise<void> {
  const opts = parseCommonCli(NAME);
  printHeader(NAME, opts);
  assertTargetDeclared(opts.databaseUrl, argValue("target"));
  const unseedMode = argFlag("unseed") || argFlag("cleanup");
  const reportTrades = argFlag("report-trades");
  const resetLiveWorker = argFlag("reset-live-worker");
  const answerKeyOnly = argFlag("answer-key-only");
  const answerKeyPath = argValue("answer-key");
  const feedLimit = intArg("feed-limit", DEFAULT_FEED_LIMIT, 1, 50);
  const anchorRaw = argValue("anchor");
  const anchor = anchorRaw === undefined ? new Date() : new Date(anchorRaw);
  if (Number.isNaN(anchor.getTime()))
    throw new Error(`[${NAME}] --anchor must be an ISO timestamp`);

  const plan = buildDemoPlan({
    personas: intArg("personas", DEFAULT_DEMO_PLAN.personas, 1, MAX_DEMO_PERSONAS),
    postings: intArg("postings", DEFAULT_DEMO_PLAN.postings, DEMO_TRADES.length, 20_000),
    rngSeed: intArg("rng-seed", DEFAULT_DEMO_PLAN.rngSeed, 0, 2 ** 31 - 1),
  });
  assertWorkerVisibleTextClean(plan.postings);

  const { db, sql } = createDbClient(opts.databaseUrl, { max: 1 });
  try {
    if (resetLiveWorker) {
      const phone = argValue("phone");
      const allowFile = argValue("allow-phones");
      if (phone === undefined || allowFile === undefined) {
        throw new Error(
          `[${NAME}] --reset-live-worker needs --phone=<E.164> and --allow-phones=<file>.`,
        );
      }
      const allowed = parseAllowPhones(readFileSync(allowFile, "utf8"));
      const problem = resetPhoneProblem(
        phone,
        allowed,
        argValue("target") === "production" ? "production" : "local",
      );
      if (problem !== null) throw new Error(`[${NAME}] ${problem}`);
      if (!opts.apply) {
        console.log(`[${NAME}] --reset-live-worker dry run for ${phone}: re-run with --apply.`);
        printFooter(NAME, opts, 0);
        return;
      }
      const counts = await resetLiveWorkerRows(db, hashPhone(phone, readCrypto().pepper));
      printCounts(NAME, counts);
      printFooter(
        NAME,
        opts,
        Object.values(counts).reduce((a, b) => a + b, 0),
      );
      return;
    }

    if (reportTrades) {
      await printTradeReport(db);
      printFooter(NAME, opts, 0);
      return;
    }

    if (unseedMode) {
      if (!opts.apply) {
        console.log(
          `[${NAME}] --unseed dry run: re-run with --apply to remove every de30… demo row.`,
        );
        printFooter(NAME, opts, 0);
        return;
      }
      if (argFlag("close-only")) {
        const closed = await closeDemoPostings(db, new Date());
        printCounts(NAME, { "demo postings closed (rows kept)": closed });
        printFooter(NAME, opts, closed);
        return;
      }
      const realApplications = await countRealApplicationsToDemo(db);
      if (realApplications > 0 && !argFlag("delete-real-applications")) {
        throw new Error(
          `[${NAME}] ${realApplications} application(s) by NON-demo workers point at demo postings; a ` +
            `hard cleanup would delete them (their events would stay, orphaned). Run with --close-only ` +
            `to take the demo off every feed without deleting anything, or pass ` +
            `--delete-real-applications if the owner has decided they go. Nothing was written.`,
        );
      }
      const counts = await unseedDemo(db);
      printCounts(NAME, { ...counts, "real applications deleted (cascade)": realApplications });
      printFooter(
        NAME,
        opts,
        Object.values(counts).reduce((a, b) => a + b, 0),
      );
      return;
    }

    const config = await loadMatchConfig(db);
    const reach = await resolveDemoReachSets(db, plan, config);
    const reachRows = plan.postings.map((p) => ({
      postingId: p.postingId,
      matchSkillIds: p.matchSkillIds,
      reachSkillIds: reach.get(p.postingId)!,
    }));

    if (!opts.apply && !answerKeyOnly) {
      printCounts(NAME, {
        personas: plan.personas.length,
        payers: plan.payers.length,
        postings: plan.postings.length,
        "two-skill postings": plan.postings.filter((p) => p.matchSkillIds.length > 1).length,
        boosted: plan.postings.filter((p) => p.boosted).length,
        "related skills default": config.relatedSkillsDefault,
      });
      console.log(`[${NAME}] expected split per persona (plan-level, before materialization):`);
      for (const w of plan.personas) {
        const e = personaExpectation(w, reachRows);
        console.log(
          `  ${w.key.padEnd(30)} direct=${e.direct.length} related-only=${e.relatedOnly.length} hidden=${e.hidden.length}`,
        );
      }
      printFooter(NAME, opts, plan.payers.length + plan.personas.length * 4 + plan.postings.length);
      return;
    }

    if (opts.apply && !answerKeyOnly) {
      const crypto = readCrypto();
      const seeded = await applyDemoSeed(
        db,
        plan,
        reach,
        crypto,
        anchor,
        argValue("target") === "production" ? "production" : "local",
      );
      let mat: DemoMaterializeResult;
      let prunedOther: number;
      try {
        mat = await materializeDemoReach(db, plan);
        prunedOther = await prunePersonaStaleReach(db, plan);
      } catch (err) {
        // The postings are committed; their reach may be stale. A re-run repairs it idempotently.
        throw new Error(
          `${err instanceof Error ? err.message : String(err)} — postings are written but reach may be ` +
            `stale; fix the cause and re-run with --apply (idempotent).`,
        );
      }
      printCounts(NAME, {
        "payers upserted": seeded.payers,
        "workers upserted": seeded.workers,
        "worker_skill upserted": seeded.workerSkills,
        "job_postings upserted (open)": seeded.postings,
        "job_postings boosted": seeded.boosted,
        "stale demo rows removed": seeded.staleRemoved,
        "postings materialized (D5)": mat.materialized,
        "job_reach inserted": mat.rowsInserted,
        "job_reach refreshed": mat.rowsUpdated,
        "job_reach deleted (stale)": mat.rowsDeleted,
        "persona reach pruned (other postings)": prunedOther,
      });
    }

    const key = await computeDemoAnswerKey(db, plan, reach, {
      feedLimit,
      now: new Date(),
      anchor: opts.apply && !answerKeyOnly ? anchor : undefined,
    });
    printAnswerKey(key);
    if (answerKeyPath !== undefined) {
      const out = resolve(answerKeyPath);
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(out, `${JSON.stringify(key, null, 2)}\n`);
      console.log(`[${NAME}] answer key written to ${out}`);
    }
    printFooter(NAME, opts, opts.apply && !answerKeyOnly ? plan.postings.length : 0);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

if (require.main === module) {
  main().catch((err) => {
    // nosemgrep: javascript.lang.security.audit.unsafe-formatstring.unsafe-formatstring -- `NAME` is a module-level string constant declared in this file, never input. This is the CLI's terminal error line; no user- or worker-supplied value reaches the template.
    console.error(`[${NAME}] failed:`, err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
