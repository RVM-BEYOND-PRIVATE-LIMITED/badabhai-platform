/**
 * E4 fixture — the wants→reach END-TO-END proof (issue #1844, `docs/agent/phases/E4_CHECK.md`
 * item 9).
 *
 * WHAT ITEM 9 NEEDS, AND WHY THIS EXISTS. E4 (the worker's exit from matching — the `wants`
 * toggle + clear-all) is built (#1832, 6b04dbc3) and its unit-level guard is green (item 4).
 * Item 9 is the INTEGRATION-level twin and answers a different question: seed a worker who
 * holds a match skill he wants, publish a live posting that reaches him THROUGH that skill,
 * and prove that when he turns the skill off the posting no longer reaches him. That proof
 * needs seeded local rows, which `db:seed:reach` never writes (it seeds workers/profiles/
 * consents/postings/jobs but not `worker_skill`/`job_reach`). This script writes exactly the
 * missing rows, deterministically, so a fresh CHECK session can run item 9 and record PASS.
 *
 * R-E4 APPLIES: this is SEEDED LOCAL TEST DATA against a schema Prakash has applied. It is
 * not evidence about real supply, and the `enforceOpsGuard` harness refuses to write it to a
 * production-like target without the two explicit signals. The fixture phone is a RESERVED
 * synthetic number, never a real one.
 *
 * WHAT IT SEEDS (idempotent — safe to re-run; re-running RESETS `wants` back to true):
 *   1. One worker, identified by the reserved synthetic phone {@link FIXTURE.phoneE164}. The
 *      worker is resolved BY `phone_hash` first (find-or-create), because the local worker-auth
 *      seam (`POST /auth/test-login`) also find-or-creates by `phone_hash` — so a token minted
 *      for this phone lands on THIS worker row whichever ran first.
 *   2. One non-revoked `worker_consents` row, so the `ConsentGuard` on the toggle route passes.
 *   3. One `worker_skill` row: ({@link FIXTURE.skillId}, `wants=true`, `source='interview'`).
 *      `source='interview'` is deliberate — the coarse backfill may never touch it, so the
 *      fixture survives a later `db:backfill:worker-skills` run. `setWants` returning 404 when
 *      the worker holds no such row is exactly why this must exist before item 9 runs.
 *   4. One live (`open`) `job_postings` row whose `match_skill_ids` name the skill and whose
 *      `reach_skill_ids` are the real tier-1∪tier-2 expansion (`expandReachSkillIds`).
 *   5. The materialized `job_reach` row for the (posting, worker) pair, produced by the SAME
 *      INSERT..SELECT the reach materializer runs — so the row is DERIVED, not asserted: it
 *      appears only if the worker genuinely holds the wanted skill the posting reaches.
 *
 * HOW A FRESH E4 CHECK SESSION RUNS ITEM 9 (all local):
 *   # 0. one-time: the match vocabulary must be seeded (this script fails closed if not)
 *   pnpm --filter @badabhai/db db:seed:match:vocabulary --apply
 *   # 1. seed the fixture
 *   pnpm --filter @badabhai/db db:seed:e4-fixture --apply
 *   # 2. confirm the reach row exists (before)
 *   #    SELECT match_tier, matched_skill_id FROM job_reach
 *   #      WHERE job_posting_id='<FIXTURE.postingId>' AND worker_id=<the fixture worker id>;
 *   #    -> exactly one row, tier 1, matched 'mskill_cnc_turner'
 *   # 3. get a WORKER bearer token from the running local API (no offline mint exists — the JWT
 *   #    is only valid while its Redis session lives). Use the committed local recipe in
 *   #    scripts/chat-cli.ps1 / scripts/chat-cli.sh (test-login seam) with THIS fixture phone.
 *   # 4. PUT /workers/me/match-skills/mskill_cnc_turner/wants   body {"wants": false}
 *   # 5. re-run the SELECT from step 2 -> ZERO rows. The posting no longer reaches him.
 *   #    (PUT ... {"wants": true} restores the row; re-running this seed does too.)
 *
 * PRIVACY: the only PII-shaped value is the reserved synthetic phone, encrypted at rest with
 * the SAME crypto the API uses (a full DB read never reveals plaintext). Every log line is
 * ids + counts. INVARIANT #4: the reach row is pure set membership from a deterministic rule.
 *
 *   pnpm --filter @badabhai/db db:seed:e4-fixture              # dry run (plan only)
 *   pnpm --filter @badabhai/db db:seed:e4-fixture --apply      # write the fixture
 *   pnpm --filter @badabhai/db db:seed:e4-fixture --unseed --apply   # remove the fixture
 */
import { and, eq, isNull, sql as dsql } from "drizzle-orm";

import { matchSkillIndustry, isMatchSkillId } from "@badabhai/taxonomy";
import { CONSENT_PURPOSES, CURRENT_CONSENT_VERSION, type ConsentPurpose } from "@badabhai/types";

import { createDbClient, type Database } from "./client";
import { encryptPii, hashPhone } from "./crypto";
import { expandReachSkillIds } from "./match-v1-derive";
import { jobPostings, jobReach, skills, workerConsents, workerSkills, workers } from "./schema";
import { argFlag, parseCommonCli, printCounts, printFooter, printHeader } from "./match-v1-cli";

const NAME = "seed:e4-fixture";

/**
 * The reserved synthetic worker-phone range the local test-login seam accepts
 * (`SYNTHETIC_TEST_PHONE_PATTERN` in `apps/api/src/auth/auth.dto.ts`): `+91` + five zeros +
 * five digits. Re-declared here (packages/db must not import from apps/api) and asserted
 * against {@link FIXTURE.phoneE164} in {@link assertFixtureValid} so a drift is caught by a test.
 */
const RESERVED_TEST_PHONE_PATTERN = /^\+910{5}\d{5}$/;

/** A syntactically valid uuid — the shape every fixed fixture id below must satisfy. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The fixture, as fixed literals (scripts cannot call `Math.random`/`Date.now`). The uuids
 * are clearly synthetic and carry the `e4f18440` marker; the phone encodes the issue number
 * (1844) inside the reserved range. `mskill_cnc_turner` is the launch-wedge skill and is
 * always present once the match vocabulary is seeded.
 */
export const FIXTURE = {
  workerId: "e4f18440-0000-4000-8000-000000000001",
  consentId: "e4f18440-0000-4000-8000-0000000000c0",
  postingId: "e4f18440-0000-4000-8000-0000000000b0",
  /** Opaque ops-actor id stamped on the posting (`job_postings.created_by`; no FK). */
  opsActorId: "e4f18440-0000-4000-8000-0000000000a0",
  /** RESERVED synthetic phone (never real); test-login accepts it, and it is `+91` + 1844. */
  phoneE164: "+910000019844",
  skillId: "mskill_cnc_turner",
  /** Bucketed months on the skill (>= 0). Arbitrary, realistic, deterministic. */
  monthsBucketed: 12,
  /** Any non-revoked consent passes the no-purpose route; use the real current version. */
  consentVersion: CURRENT_CONSENT_VERSION,
  /** A realistic worker onboarding set (the route checks no specific purpose). */
  consentPurposes: ["profiling", "resume_generation", "communication"] as ConsentPurpose[],
} as const;

/**
 * Fail closed on any fixture constant that would silently break the proof: an unknown skill id,
 * a skill with no industry, a phone outside the test-login range, or a malformed uuid. Pure, so
 * the unit test drives it and a stale constant turns a build red rather than a CHECK session.
 */
export function assertFixtureValid(): { industryId: string } {
  if (!isMatchSkillId(FIXTURE.skillId)) {
    throw new Error(`[${NAME}] ${FIXTURE.skillId} is not a match skill id (closed vocabulary).`);
  }
  const industryId = matchSkillIndustry(FIXTURE.skillId);
  if (!industryId) {
    throw new Error(`[${NAME}] ${FIXTURE.skillId} has no industry_id in the taxonomy.`);
  }
  if (!RESERVED_TEST_PHONE_PATTERN.test(FIXTURE.phoneE164)) {
    throw new Error(
      `[${NAME}] fixture phone ${FIXTURE.phoneE164} is outside the reserved test-login range ` +
        `${RESERVED_TEST_PHONE_PATTERN} — a token could not be minted for this worker.`,
    );
  }
  for (const [k, v] of [
    ["workerId", FIXTURE.workerId],
    ["consentId", FIXTURE.consentId],
    ["postingId", FIXTURE.postingId],
    ["opsActorId", FIXTURE.opsActorId],
  ] as const) {
    if (!UUID_PATTERN.test(v)) throw new Error(`[${NAME}] FIXTURE.${k} is not a valid uuid: ${v}`);
  }
  if (FIXTURE.monthsBucketed < 0) {
    throw new Error(`[${NAME}] FIXTURE.monthsBucketed must be >= 0.`);
  }
  if (FIXTURE.consentPurposes.length === 0) {
    throw new Error(`[${NAME}] the consent row needs at least one purpose.`);
  }
  const known = new Set<string>(CONSENT_PURPOSES);
  for (const p of FIXTURE.consentPurposes) {
    if (!known.has(p)) throw new Error(`[${NAME}] ${p} is not a known consent purpose.`);
  }
  return { industryId };
}

/** Read the shared PII crypto material, or fail closed (mirrors seed-reach-pool). */
function readCrypto(): { key: string; pepper: string } {
  const key = process.env.PII_ENCRYPTION_KEY;
  const pepper = process.env.PII_HASH_PEPPER;
  if (!key || !pepper) {
    throw new Error(
      `[${NAME}] PII_ENCRYPTION_KEY and PII_HASH_PEPPER must be set — the fixture phone is ` +
        `encrypted + hashed with the SAME crypto the API uses, so test-login resolves this ` +
        `worker by phone_hash.`,
    );
  }
  return { key, pepper };
}

/** Resolve the fixture worker by `phone_hash`; return its id, or undefined if it does not exist. */
async function findWorkerByPhoneHash(db: Database, phoneHash: string): Promise<string | undefined> {
  const rows = await db
    .select({ id: workers.id })
    .from(workers)
    .where(eq(workers.phoneHash, phoneHash))
    .limit(1);
  return rows[0]?.id;
}

async function unseed(db: Database, phoneHash: string): Promise<Record<string, number>> {
  // Posting first: its delete CASCADEs the (posting, *) job_reach rows. Then the worker's own
  // fixture rows. The worker row is removed only when WE created it (our fixed id) — a worker
  // test-login created under a different id is left alone but stripped of the fixture rows.
  const workerId = await findWorkerByPhoneHash(db, phoneHash);

  const posting = await db
    .delete(jobPostings)
    .where(eq(jobPostings.id, FIXTURE.postingId))
    .returning({ id: jobPostings.id });

  let skillRows = 0;
  let consentRows = 0;
  let workerRows = 0;
  if (workerId) {
    skillRows = (
      await db
        .delete(workerSkills)
        .where(and(eq(workerSkills.workerId, workerId), eq(workerSkills.skillId, FIXTURE.skillId)))
        .returning({ id: workerSkills.id })
    ).length;
    consentRows = (
      await db
        .delete(workerConsents)
        .where(eq(workerConsents.workerId, workerId))
        .returning({ id: workerConsents.id })
    ).length;
    if (workerId === FIXTURE.workerId) {
      workerRows = (
        await db.delete(workers).where(eq(workers.id, workerId)).returning({ id: workers.id })
      ).length;
    }
  }

  return {
    "job_postings deleted": posting.length,
    "worker_skill deleted": skillRows,
    "worker_consents deleted": consentRows,
    "workers deleted": workerRows,
  };
}

async function main(): Promise<void> {
  const opts = parseCommonCli(NAME);
  printHeader(NAME, opts);
  const unseedMode = argFlag("unseed");

  const { industryId } = assertFixtureValid();
  const { key, pepper } = readCrypto();
  const phoneHash = hashPhone(FIXTURE.phoneE164, pepper);

  const { db, sql } = createDbClient(opts.databaseUrl, { max: 1 });
  const now = new Date();
  try {
    if (unseedMode) {
      if (!opts.apply) {
        console.log(`[${NAME}] --unseed dry run: re-run with --apply to remove the fixture rows.`);
        printFooter(NAME, opts, 0);
        return;
      }
      const counts = await unseed(db, phoneHash);
      printCounts(NAME, counts);
      printFooter(
        NAME,
        opts,
        Object.values(counts).reduce((a, b) => a + b, 0),
      );
      return;
    }

    // Precondition: the match vocabulary must be seeded, or the skill FK has no target and the
    // reach expansion is empty. Fail closed with the exact fix rather than writing a dead fixture.
    const skillExists = await db
      .select({ skillId: skills.skillId })
      .from(skills)
      .where(eq(skills.skillId, FIXTURE.skillId))
      .limit(1);
    if (skillExists.length === 0) {
      throw new Error(
        `[${NAME}] ${FIXTURE.skillId} is not in the "skill" table — the match vocabulary is not ` +
          `seeded. Run: pnpm --filter @badabhai/db db:seed:match:vocabulary --apply`,
      );
    }

    const reach = await expandReachSkillIds(db, [FIXTURE.skillId]);
    const existingWorkerId = await findWorkerByPhoneHash(db, phoneHash);
    const workerId = existingWorkerId ?? FIXTURE.workerId;

    if (!opts.apply) {
      printCounts(NAME, {
        "match skill": FIXTURE.skillId,
        industry: industryId,
        "reach_skill_ids (tier1∪tier2)": reach.length,
        "worker resolved by phone_hash": existingWorkerId ? "EXISTS (reused)" : "NEW (will create)",
        "worker id": workerId,
        "posting id": FIXTURE.postingId,
      });
      console.log(
        `[${NAME}] DRY RUN — would ensure 1 worker + 1 consent + 1 worker_skill (wants=true) + ` +
          `1 open posting + 1 job_reach row. Re-run with --apply.`,
      );
      printFooter(NAME, opts, 5);
      return;
    }

    // 1. Worker — create only if absent (test-login may have made it first, under another id).
    if (!existingWorkerId) {
      await db.insert(workers).values({
        id: FIXTURE.workerId,
        phoneE164: encryptPii(FIXTURE.phoneE164, key), // AES-256-GCM ciphertext token
        phoneHash, // keyed HMAC — the test-login lookup key
        status: "active",
      });
    }

    // 2. Consent — one non-revoked row is enough for the no-purpose toggle route. Insert only if
    //    the worker has none live, so a re-run never stacks rows.
    const liveConsent = await db
      .select({ id: workerConsents.id })
      .from(workerConsents)
      .where(and(eq(workerConsents.workerId, workerId), isNull(workerConsents.revokedAt)))
      .limit(1);
    if (liveConsent.length === 0) {
      await db
        .insert(workerConsents)
        .values({
          id: FIXTURE.consentId,
          workerId,
          consentVersion: FIXTURE.consentVersion,
          purposes: FIXTURE.consentPurposes,
          acceptedAt: now,
        })
        .onConflictDoNothing({ target: workerConsents.id });
    }

    // 3. worker_skill — the reach driver. Upsert to (re)assert wants=true, so re-running the
    //    seed RESETS a worker whom item 9 turned off back to the pre-item-9 state.
    await db
      .insert(workerSkills)
      .values({
        workerId,
        skillId: FIXTURE.skillId,
        industryId,
        monthsBucketed: FIXTURE.monthsBucketed,
        wants: true,
        source: "interview",
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [workerSkills.workerId, workerSkills.skillId],
        set: {
          industryId,
          monthsBucketed: FIXTURE.monthsBucketed,
          wants: true,
          source: "interview",
          updatedAt: now,
        },
      });

    // 4. The live posting whose reach set names the skill.
    await db
      .insert(jobPostings)
      .values({
        id: FIXTURE.postingId,
        createdBy: FIXTURE.opsActorId,
        orgLabel: "SYNTHETIC — E4 fixture posting (#1844)",
        roleTitle: "CNC Turner — E4 fixture",
        vacancyBand: "1",
        status: "open",
        matchSkillIds: [FIXTURE.skillId],
        reachSkillIds: reach,
        publishedAt: now,
      })
      .onConflictDoUpdate({
        target: jobPostings.id,
        set: {
          status: "open",
          matchSkillIds: [FIXTURE.skillId],
          reachSkillIds: reach,
          publishedAt: now,
          updatedAt: now,
        },
      });

    // 5. Materialize job_reach for THIS (posting, worker) — the exact ③ statement the reach
    //    materializer runs, scoped to the pair. DERIVED: no row appears unless the worker holds
    //    the wanted skill the posting reaches, so a broken fixture is visible, not hidden.
    const postedParam = dsql.param([FIXTURE.skillId]);
    const reachParam = dsql.param(reach);
    await db.execute(dsql`
      INSERT INTO job_reach (job_posting_id, worker_id, match_tier, matched_skill_id)
      SELECT ${FIXTURE.postingId}::uuid,
             ws.worker_id,
             MIN(CASE WHEN ws.skill_id = ANY(${postedParam}::text[]) THEN 1 ELSE 2 END),
             (ARRAY_AGG(ws.skill_id ORDER BY (ws.skill_id = ANY(${postedParam}::text[])) DESC,
                                             ws.months_bucketed DESC))[1]
      FROM worker_skill ws
      WHERE ws.worker_id = ${workerId}::uuid
        AND ws.skill_id = ANY(${reachParam}::text[])
        AND ws.wants
      GROUP BY ws.worker_id
      ON CONFLICT (job_posting_id, worker_id) DO UPDATE
        SET match_tier       = EXCLUDED.match_tier,
            matched_skill_id = EXCLUDED.matched_skill_id,
            computed_at      = now()
    `);

    // Self-check: the reach row MUST exist now, or the fixture is not executable.
    const reachRow = await db
      .select({ tier: jobReach.matchTier, matched: jobReach.matchedSkillId })
      .from(jobReach)
      .where(and(eq(jobReach.jobPostingId, FIXTURE.postingId), eq(jobReach.workerId, workerId)))
      .limit(1);
    if (reachRow.length === 0) {
      throw new Error(
        `[${NAME}] materialization wrote no job_reach row for the fixture pair — the fixture is ` +
          `NOT executable. This is a bug in the fixture, not a normal outcome.`,
      );
    }

    printCounts(NAME, {
      "worker id": workerId,
      "worker created": existingWorkerId ? 0 : 1,
      "match skill (wants=true)": FIXTURE.skillId,
      industry: industryId,
      "reach_skill_ids (tier1∪tier2)": reach.length,
      "posting id": FIXTURE.postingId,
      "job_reach match_tier": reachRow[0]!.tier,
      "job_reach matched_skill": reachRow[0]!.matched,
    });
    console.log(
      `[${NAME}] READY. Fixture worker phone ${FIXTURE.phoneE164} (reserved synthetic). ` +
        `Item 9: mint a worker token for it (scripts/chat-cli.*), then ` +
        `PUT /workers/me/match-skills/${FIXTURE.skillId}/wants {"wants":false} and confirm the ` +
        `job_reach row above disappears. See this file's header for the full recipe.`,
    );
    printFooter(NAME, opts, 5);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

// GUARDED ENTRYPOINT (mirrors seed-match-vocabulary): the file exports `FIXTURE` +
// `assertFixtureValid` for the unit test, and importing those must never seed the fixture.
if (require.main === module) {
  main().catch((err) => {
    // nosemgrep: javascript.lang.security.audit.unsafe-formatstring.unsafe-formatstring -- `NAME` is a module-level string constant declared in this file, never input. This is the CLI's terminal error line; no user- or worker-supplied value reaches the template.
    console.error(`[${NAME}] failed:`, err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
