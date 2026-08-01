import "reflect-metadata";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDbClient, type DbClient } from "@badabhai/db";
import { DEFAULT_MATCH_CONFIG } from "@badabhai/match-engine";
import { MatchApplyService, type RankSnapshot } from "./match-apply.service";
import { MatchConfigRepository } from "./match-config.repository";
import { MatchConfigService } from "./match-config.service";
import { MatchFeedRepository } from "./match-feed.repository";
import { WorkerSkillsRepository } from "./worker-skills.repository";

/**
 * ═══════════════════════════════════════════════════════════════════════════════
 * THE E16 SNAPSHOT-FREEZE GATE (ADR-0036 §5, spec Part 6).
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 * E16: "Worker updates his profile after applying → the company's list does not move."
 *
 * That guarantee is implemented in exactly ONE place — the `ON CONFLICT DO UPDATE` in
 * `MatchApplyService.upsertDecision`, where each of the five snapshot columns is wrapped
 * in `CASE WHEN applications.action <> 'applied' AND EXCLUDED.action = 'applied'`. The
 * snapshot is written on a genuinely NEW decision (an insert, or a skip→apply flip) and
 * never on a repeat of one already recorded.
 *
 * ── WHY THIS FILE HAD TO EXIST ────────────────────────────────────────────────
 * Until it did, E16 was proven only "by construction". The unit suite
 * (`match-apply.service.test.ts`) captures the compiled statement against a fake db and
 * asserts the CASE text is PRESENT on all five columns. That is a real guard against a
 * column silently losing its wrapper, and it is all a mock can do — a string containing
 * `CASE WHEN …` is not evidence that Postgres evaluates it the way the comment claims.
 * The remaining questions are all semantic, and all of them need a real database:
 *
 *   - does the CASE actually KEEP the stored value on a re-apply, or does the update
 *     land anyway (a mis-parenthesised predicate still contains the substring);
 *   - does it actually WRITE on a skip→apply flip — a freeze that never unfreezes would
 *     pass every "did not move" assertion while quietly discarding real rank inputs;
 *   - under CONCURRENCY, can two racing applies leave a TORN row — `match_tier` from one
 *     snapshot beside `skill_months` from another? The service's doc comment claims they
 *     cannot ("one statement, no read-then-write"), which is a claim about Postgres.
 *
 * ── AND WHY IT IS NOT rank-parity.test.ts ─────────────────────────────────────
 * `match-apply.service.test.ts` used to point at `rank-parity.test.ts` for this proof.
 * It does not own it: that file seeds `applications` with plain INSERTs and compares the
 * candidate-list `ORDER BY` against `rankKeyCompare`. It never calls `upsertDecision`, so it never
 * exercises an ON CONFLICT DO UPDATE on `applications` — the only ON CONFLICT in that file
 * is a `DO NOTHING` on the `workers` seed (rank-parity.test.ts:210), which proves nothing
 * about the freeze. The attribution has been corrected and the proof lives here.
 *
 * ── EVERY TEST IS GUARDED AGAINST PASSING VACUOUSLY ───────────────────────────
 * A freeze test trivially passes when nothing would have changed anyway. So each case
 * that asserts "it did not move" is preceded by an assertion that the re-derived value
 * genuinely DID move — `buildSnapshot` is re-run through the real service after the
 * profile edit and asserted to differ from what is stored. Delete the CASE wrappers and
 * these tests fail; leave them and the vacuity guards fail if the fixture stops biting.
 *
 * ── HOW TO RUN ────────────────────────────────────────────────────────────────
 * It needs a real Postgres with the 0052–0059 train applied, so it SKIPS by default and
 * `pnpm --filter @badabhai/api test` stays DB-free:
 *
 *   pnpm db:up && pnpm db:migrate
 *   RUN_DB_TESTS=1 pnpm --filter @badabhai/api run test apply-freeze
 *
 * In CI it runs in the `e2e` job's "Matching V1 DB gates" step, which asserts per-file
 * that it EXECUTED rather than skipped. A skipped gate is a disclosed gap, not a pass.
 */

const RUN = process.env.RUN_DB_TESTS === "1";
const DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgresql://badabhai:badabhai@localhost:5432/badabhai";

function uuid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

const POSTING = uuid(7101);
const PAYER = uuid(7201);
const WORKER_A = uuid(7301); // the worker who edits his profile after applying
const WORKER_B = uuid(7302); // a second applicant, so list ORDER is observable

const SKILL = "mskill_vmc_operator";
/** Must match `matchSkillIndustry(SKILL)` — the industry `buildSnapshot` looks tenure up by. */
const INDUSTRY = "ind_industrial_manufacturing";
const FLOOR = DEFAULT_MATCH_CONFIG.tierFloorMonths;

/** A's months before the edit, and after. Both below the floor is irrelevant here — what
 *  matters is only that they DIFFER, so a leaked recompute is visible. */
const BASE_MONTHS = 12;
const EDITED_MONTHS = 240;
/** B sits between them: before A's edit B leads the list, after it A *would* lead — so a
 *  leaked recompute would REORDER the list, not merely change a number nobody reads. */
const B_MONTHS = 24;

describe.skipIf(!RUN)("Matching V1 — the E16 snapshot freeze, against Postgres (ADR-0036 §5)", () => {
  // TWO pools, deliberately. postgres.js pipelines concurrent queries down a single
  // connection, so `Promise.all` over one client would serialise and the concurrency
  // cases below would prove nothing. Two clients = two backends = a genuine race.
  let clientA: DbClient;
  let clientB: DbClient;
  let applyA: MatchApplyService;
  let applyB: MatchApplyService;
  let feed: MatchFeedRepository;

  beforeAll(async () => {
    clientA = createDbClient(DATABASE_URL, { max: 1 });
    clientB = createDbClient(DATABASE_URL, { max: 1 });
    applyA = buildApplyService(clientA);
    applyB = buildApplyService(clientB);
    feed = new MatchFeedRepository(clientA.db);
    await seed(clientA);
  }, 60_000);

  afterAll(async () => {
    if (clientA) {
      await cleanup(clientA);
      await clientA.sql.end({ timeout: 5 });
    }
    if (clientB) await clientB.sql.end({ timeout: 5 });
  });

  // Every case starts from the same known state: no decisions, both profiles at their
  // baseline months. Without this the file would be order-dependent and a failure in one
  // case would cascade into unrelated ones.
  beforeEach(async () => {
    await clearDecisions(clientA);
    await setProfileMonths(clientA, WORKER_A, BASE_MONTHS);
    await setProfileMonths(clientA, WORKER_B, B_MONTHS);
  });

  it("writes the snapshot on INSERT — the baseline the rest of this file freezes", async () => {
    const snapshot = await applyA.buildSnapshot(WORKER_A, POSTING);
    expect(snapshot.matchTier).toBe(1);
    expect(snapshot.skillMonths).toBe(BASE_MONTHS);
    expect(snapshot.industryMonths).toBe(BASE_MONTHS);
    // E4 — "duration unknown". Null at launch for every worker: coarse history carries
    // no last-worked date, and this pins that the column is not being invented.
    expect(snapshot.lastWorkedAt).toBeNull();

    const result = await applyA.upsertDecision({
      workerId: WORKER_A,
      jobPostingId: POSTING,
      action: "applied",
      reason: null,
      sourceSurface: "feed",
      rank: 1,
      snapshot,
      previousAction: null,
    });

    expect(result.inserted).toBe(true);
    expect(await storedSnapshot(clientA, WORKER_A)).toEqual({
      match_tier: 1,
      skill_months: BASE_MONTHS,
      industry_months: BASE_MONTHS,
      engine_version: snapshot.engineVersion,
    });
  });

  it("VACUITY GUARD — a profile edit genuinely changes what buildSnapshot recomputes", async () => {
    const before = await applyA.buildSnapshot(WORKER_A, POSTING);
    await setProfileMonths(clientA, WORKER_A, EDITED_MONTHS);
    const after = await applyA.buildSnapshot(WORKER_A, POSTING);

    // If this ever fails, every "did not move" assertion below has stopped meaning
    // anything — the fixture would be freezing a value that was never going to change.
    expect(after.skillMonths).toBe(EDITED_MONTHS);
    expect(after.industryMonths).toBe(EDITED_MONTHS);
    expect(after.skillMonths).not.toBe(before.skillMonths);
  });

  it("E16 — a re-apply after a profile edit does NOT move the frozen snapshot", async () => {
    const original = await applyA.buildSnapshot(WORKER_A, POSTING);
    await applyA.upsertDecision({
      workerId: WORKER_A, jobPostingId: POSTING, action: "applied", reason: null,
      sourceSurface: "feed", rank: 1, snapshot: original, previousAction: null,
    });

    // The worker edits his profile, then taps apply again (a double tap, a client retry).
    await setProfileMonths(clientA, WORKER_A, EDITED_MONTHS);
    const recomputed = await applyA.buildSnapshot(WORKER_A, POSTING);
    expect(recomputed.skillMonths).toBe(EDITED_MONTHS); // the edit really did land

    const result = await applyA.upsertDecision({
      workerId: WORKER_A, jobPostingId: POSTING, action: "applied", reason: null,
      sourceSurface: "feed", rank: 1, snapshot: recomputed, previousAction: "applied",
    });

    // THE ROW ITSELF, read back from SQL — not the service's return value, which could
    // be right while the write was wrong.
    expect(await storedSnapshot(clientA, WORKER_A)).toEqual({
      match_tier: 1,
      skill_months: BASE_MONTHS,
      industry_months: BASE_MONTHS,
      engine_version: original.engineVersion,
    });
    // …and the caller is told what the database KEPT, never what it passed in. Echoing
    // the input here would make the freeze cosmetic while every assertion still passed.
    expect(result.snapshot?.skillMonths).toBe(BASE_MONTHS);
    expect(result.inserted).toBe(false);
  });

  it("E16 — the company's already-frozen candidate list does not reorder", async () => {
    // Both apply. B has more months, so B leads.
    await applyDecision(applyA, WORKER_A, "applied", null);
    await applyDecision(applyB, WORKER_B, "applied", null);

    const before = await feed.listCandidates(POSTING, FLOOR, 500);
    expect(before.map((r) => r.workerId)).toEqual([WORKER_B, WORKER_A]);

    // A now edits his profile to twenty years and re-applies. On recomputed inputs he
    // would lead the list — which is precisely the reorder E16 forbids.
    await setProfileMonths(clientA, WORKER_A, EDITED_MONTHS);
    const recomputed = await applyA.buildSnapshot(WORKER_A, POSTING);
    expect(recomputed.skillMonths).toBeGreaterThan(B_MONTHS); // he WOULD have overtaken B
    await applyA.upsertDecision({
      workerId: WORKER_A, jobPostingId: POSTING, action: "applied", reason: null,
      sourceSurface: "feed", rank: 1, snapshot: recomputed, previousAction: "applied",
    });

    const after = await feed.listCandidates(POSTING, FLOOR, 500);
    // BYTE-IDENTICAL, not merely same-order: the company paid to see this list.
    expect(JSON.stringify(after)).toEqual(JSON.stringify(before));
    expect(after.map((r) => r.workerId)).toEqual([WORKER_B, WORKER_A]);
  });

  it("a skip→apply FLIP does write the snapshot — the freeze is not a blanket refusal", async () => {
    await applyDecision(applyA, WORKER_A, "skipped", null);
    // A skip carries no rank inputs at all.
    expect(await storedSnapshot(clientA, WORKER_A)).toEqual({
      match_tier: null, skill_months: null, industry_months: null, engine_version: null,
    });

    await setProfileMonths(clientA, WORKER_A, EDITED_MONTHS);
    const snapshot = await applyA.buildSnapshot(WORKER_A, POSTING);
    await applyA.upsertDecision({
      workerId: WORKER_A, jobPostingId: POSTING, action: "applied", reason: null,
      sourceSurface: "feed", rank: 1, snapshot, previousAction: "skipped",
    });

    // The flip IS a new decision, so it snapshots — with the CURRENT profile, because
    // this is the first moment the worker actually applied. A CASE that never wrote
    // would pass every freeze assertion above while silently discarding this.
    expect(await storedSnapshot(clientA, WORKER_A)).toEqual({
      match_tier: 1,
      skill_months: EDITED_MONTHS,
      industry_months: EDITED_MONTHS,
      engine_version: snapshot.engineVersion,
    });
  });

  it("CONCURRENCY — two racing applies leave ONE row and no TORN snapshot", async () => {
    // Two different snapshots, dispatched down two different connections against a row
    // that does not exist yet. Postgres serialises them on `applications_worker_posting_uq`:
    // one INSERTs, the other takes the DO UPDATE branch and — both being 'applied' — keeps
    // the stored values.
    const first: RankSnapshot = {
      matchTier: 1, skillMonths: BASE_MONTHS, industryMonths: BASE_MONTHS,
      lastWorkedAt: null, engineVersion: "v1.0",
    };
    const second: RankSnapshot = {
      matchTier: 2, skillMonths: EDITED_MONTHS, industryMonths: EDITED_MONTHS,
      lastWorkedAt: null, engineVersion: "v9.9",
    };

    const [a, b] = await Promise.all([
      applyA.upsertDecision({
        workerId: WORKER_A, jobPostingId: POSTING, action: "applied", reason: null,
        sourceSurface: "feed", rank: 1, snapshot: first, previousAction: null,
      }),
      applyB.upsertDecision({
        workerId: WORKER_A, jobPostingId: POSTING, action: "applied", reason: null,
        sourceSurface: "feed", rank: 1, snapshot: second, previousAction: null,
      }),
    ]);

    // E15 — one application per (worker, posting), enforced by the partial unique index.
    expect(await countDecisions(clientA, WORKER_A)).toBe(1);

    // Exactly one of the two won, and it won WHOLE. A row carrying `match_tier` from one
    // snapshot beside `skill_months` from the other is the failure mode a read-then-write
    // implementation would produce, and the single-statement CASE is the claim that it
    // cannot happen. Assert against the two legal rows, not field by field.
    const stored = await storedSnapshot(clientA, WORKER_A);
    const legal = [
      { match_tier: 1, skill_months: BASE_MONTHS, industry_months: BASE_MONTHS, engine_version: "v1.0" },
      { match_tier: 2, skill_months: EDITED_MONTHS, industry_months: EDITED_MONTHS, engine_version: "v9.9" },
    ];
    expect(legal).toContainEqual(stored);

    // Both callers are told the same thing — the row as it now stands. If one of them
    // echoed its own input, two clients would disagree about a frozen value.
    expect(a.snapshot?.skillMonths).toBe(stored.skill_months);
    expect(b.snapshot?.skillMonths).toBe(stored.skill_months);
    expect(a.applicationId).toBe(b.applicationId);
    // Exactly one insert — the other necessarily took the conflict branch.
    expect([a.inserted, b.inserted].filter(Boolean)).toHaveLength(1);
  });

  it("CONCURRENCY — a profile edit racing the apply cannot leave the row mid-edit", async () => {
    // The worker taps apply on one connection while his `worker_skill` row is rewritten
    // on another. Which of the two month values the snapshot captures is a genuine race
    // and either answer is correct — he really did hold each of them at some instant.
    // What must NOT happen: a value that was never true, or a row that keeps moving.
    const [, snapshot] = await Promise.all([
      setProfileMonths(clientB, WORKER_A, EDITED_MONTHS),
      applyA.buildSnapshot(WORKER_A, POSTING),
    ]);
    await applyA.upsertDecision({
      workerId: WORKER_A, jobPostingId: POSTING, action: "applied", reason: null,
      sourceSurface: "feed", rank: 1, snapshot, previousAction: null,
    });

    const settled = await storedSnapshot(clientA, WORKER_A);
    // Both columns hold a value the worker genuinely had — never an interpolation.
    expect([BASE_MONTHS, EDITED_MONTHS]).toContain(settled.skill_months);
    expect([BASE_MONTHS, EDITED_MONTHS]).toContain(settled.industry_months);
    // The E8 clamp survives the race. NOT asserted: that the two came from the same
    // instant — `buildSnapshot` reads `worker_skill` and `worker_industry_tenure` in two
    // separate statements outside a transaction, so an edit landing between them can
    // legitimately produce skill months from before and industry months from after.
    // That is benign (both were true, and `Math.max` keeps industry ≥ skill, which is
    // the invariant the rank tuple actually depends on) but it IS real, and asserting
    // equality here would make this test flaky rather than make the code safer.
    expect(settled.industry_months!).toBeGreaterThanOrEqual(settled.skill_months!);

    // AND IT IS NOW FROZEN. A third, distinct set of inputs cannot move it — this is the
    // assertion that makes the race benign rather than merely undetermined.
    await setProfileMonths(clientA, WORKER_A, 999);
    const third = await applyA.buildSnapshot(WORKER_A, POSTING);
    expect(third.skillMonths).toBe(999); // the edit landed, so the re-apply is not a no-op
    await applyA.upsertDecision({
      workerId: WORKER_A, jobPostingId: POSTING, action: "applied", reason: null,
      sourceSurface: "feed", rank: 1, snapshot: third, previousAction: "applied",
    });
    expect(await storedSnapshot(clientA, WORKER_A)).toEqual(settled);
  });
});

/** The real service graph — no mocks. `MatchConfigService` falls back to the typed
 *  defaults when `match_config` has no active row, which is the state of a bare
 *  migrated database (D1 has not run), so this needs no seed of its own. */
function buildApplyService(client: DbClient): MatchApplyService {
  const config = new MatchConfigService(new MatchConfigRepository(client.db));
  return new MatchApplyService(client.db, new WorkerSkillsRepository(client.db), config);
}

/** Apply or skip with a freshly-built snapshot (null for a skip — a skip has no inputs). */
async function applyDecision(
  svc: MatchApplyService,
  workerId: string,
  action: "applied" | "skipped",
  previousAction: string | null,
): Promise<void> {
  const snapshot = action === "applied" ? await svc.buildSnapshot(workerId, POSTING) : null;
  await svc.upsertDecision({
    workerId, jobPostingId: POSTING, action, reason: null,
    sourceSurface: "feed", rank: 1, snapshot, previousAction,
  });
}

/** The five frozen columns, read straight from SQL rather than through the service. */
async function storedSnapshot(
  client: DbClient,
  workerId: string,
): Promise<{
  match_tier: number | null;
  skill_months: number | null;
  industry_months: number | null;
  engine_version: string | null;
}> {
  const rows = await client.sql<
    {
      match_tier: number | null;
      skill_months: number | null;
      industry_months: number | null;
      engine_version: string | null;
    }[]
  >`
    SELECT match_tier, skill_months, industry_months, engine_version
    FROM applications
    WHERE worker_id = ${workerId}::uuid AND job_posting_id = ${POSTING}::uuid
  `;
  expect(rows).toHaveLength(1);
  return rows[0]!;
}

async function countDecisions(client: DbClient, workerId: string): Promise<number> {
  const rows = await client.sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM applications
    WHERE worker_id = ${workerId}::uuid AND job_posting_id = ${POSTING}::uuid
  `;
  return rows[0]?.n ?? 0;
}

/**
 * "The worker edits his profile." Writes the same two rows the live derivation writes —
 * `worker_skill.months_bucketed` (what `skillMonthsFor` reads) and
 * `worker_industry_tenure.calendar_months` (what `findIndustryMonths` reads) — so
 * `buildSnapshot` recomputes exactly as it would after a real re-profiling.
 */
async function setProfileMonths(client: DbClient, workerId: string, months: number): Promise<void> {
  await client.sql`
    UPDATE worker_skill SET months_bucketed = ${months}, updated_at = now()
     WHERE worker_id = ${workerId}::uuid AND skill_id = ${SKILL}
  `;
  await client.sql`
    UPDATE worker_industry_tenure SET calendar_months = ${months}, computed_at = now()
     WHERE worker_id = ${workerId}::uuid AND industry_id = ${INDUSTRY}
  `;
}

async function clearDecisions(client: DbClient): Promise<void> {
  await client.sql`DELETE FROM applications WHERE job_posting_id = ${POSTING}::uuid`;
}

async function seed(client: DbClient): Promise<void> {
  const { sql } = client;
  await cleanup(client);

  // `worker_skill.skill_id` and `job_reach.matched_skill_id` both FK to `skill`. On a
  // database where D1 has run this row exists already; the upsert makes the fixture
  // self-sufficient on a bare migrated one and is a no-op otherwise.
  await sql`
    INSERT INTO skill (skill_id, label_en, domain_id, source, status, kind, industry_id)
    VALUES (${SKILL}, 'VMC Operator', 'cnc-machining', 'rvm', 'active', 'match_skill', ${INDUSTRY})
    ON CONFLICT (skill_id) DO NOTHING
  `;

  for (const [id, tag, months] of [
    [WORKER_A, "a", BASE_MONTHS],
    [WORKER_B, "b", B_MONTHS],
  ] as const) {
    // `phone_e164` (encrypted) and `phone_hash` (HMAC) are both NOT NULL. Synthetic
    // markers only — no real phone number exists in this fixture, so it cannot leak or
    // resemble PII even in a shared database.
    await sql`
      INSERT INTO workers (id, phone_e164, phone_hash, status)
      VALUES (${id}::uuid, ${`enc:apply-freeze-${tag}`}, ${`hash:apply-freeze-${tag}`}, 'active')
      ON CONFLICT (id) DO NOTHING
    `;
    await sql`
      INSERT INTO worker_skill (worker_id, skill_id, industry_id, months_bucketed, wants, source)
      VALUES (${id}::uuid, ${SKILL}, ${INDUSTRY}, ${months}, true, 'derived_coarse')
      ON CONFLICT (worker_id, skill_id) DO UPDATE SET months_bucketed = EXCLUDED.months_bucketed
    `;
    await sql`
      INSERT INTO worker_industry_tenure (worker_id, industry_id, calendar_months)
      VALUES (${id}::uuid, ${INDUSTRY}, ${months})
      ON CONFLICT (worker_id, industry_id) DO UPDATE SET calendar_months = EXCLUDED.calendar_months
    `;
  }

  await sql`
    INSERT INTO job_postings (id, created_by, payer_id, org_label, role_title, vacancy_band,
                              status, match_skill_ids, reach_skill_ids, published_at)
    VALUES (${POSTING}::uuid, ${PAYER}::uuid, ${PAYER}::uuid, 'Apply Freeze Fixture',
            'VMC Operator', '1', 'open', ${`["${SKILL}"]`}::jsonb, ${`["${SKILL}"]`}::jsonb, now())
  `;

  // The reach rows ARE the apply gate — `buildSnapshot` 404s without one.
  await sql`
    INSERT INTO job_reach (job_posting_id, worker_id, match_tier, matched_skill_id)
    VALUES (${POSTING}::uuid, ${WORKER_A}::uuid, 1, ${SKILL}),
           (${POSTING}::uuid, ${WORKER_B}::uuid, 1, ${SKILL})
  `;
}

async function cleanup(client: DbClient): Promise<void> {
  const { sql } = client;
  await sql`DELETE FROM applications WHERE job_posting_id = ${POSTING}::uuid`;
  await sql`DELETE FROM job_reach WHERE job_posting_id = ${POSTING}::uuid`;
  await sql`DELETE FROM job_postings WHERE id = ${POSTING}::uuid`;
  for (const id of [WORKER_A, WORKER_B]) {
    await sql`DELETE FROM worker_skill WHERE worker_id = ${id}::uuid`;
    await sql`DELETE FROM worker_industry_tenure WHERE worker_id = ${id}::uuid`;
    await sql`DELETE FROM workers WHERE id = ${id}::uuid`;
  }
}
