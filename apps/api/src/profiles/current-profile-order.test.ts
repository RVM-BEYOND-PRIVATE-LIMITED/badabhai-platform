import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { inArray } from "drizzle-orm";
import { createDbClient, workerProfiles, workers, type DbClient } from "@badabhai/db";

import { AdminEntitiesRepository } from "../admin/admin-entities.repository";
import { WorkerSkillsRepository } from "../match/worker-skills.repository";
import { ReachRepository } from "../reach/reach.repository";
import { WorkersRepository } from "../workers/workers.repository";
import { hasExtractedContent } from "./profile-content";

/**
 * B-8b — ONE definition of "which `worker_profiles` row is this worker's profile", proven
 * against Postgres over the REAL repositories.
 *
 * WHY THIS CANNOT BE A UNIT TEST. Every claim here is a property of an `ORDER BY` — which row
 * a `LIMIT 1` returns, and whether `DISTINCT ON` collapses a worker's two rows into one. A fake
 * db can assert the ordering expression is PRESENT in the query object; only Postgres can say
 * it EVALUATES the way the fix claims. That is the same reasoning the three Matching V1 gates
 * beside this one are written from, and this file joins them in the CI step that asserts
 * per-file that it EXECUTED rather than skipped.
 *
 * THE DEFECT. `ProfilesRepository.create` is insert-only per `ai_job_id` and nothing constrains
 * a worker to one row, so a worker accumulates one row per extraction. When the ai-service is
 * unreachable `AiService.extractProfile` returns `DraftProfileSchema.parse({})` — an EMPTY
 * profile — and it is persisted as a real row, newer than everything before it. Seven readers
 * then resolved "the" profile independently and none agreed: five ordered by `created_at DESC`
 * alone, `ReachRepository.findSignalRowByWorkerId` had NO `ORDER BY` whatsoever, and
 * `ReachRepository.listSignalRows` had neither ordering nor dedup — so a re-interviewed worker
 * entered the payer applicant pool twice and was counted twice in PACE supply.
 *
 * The fixture is that exact history: a good profile, then an outage.
 *
 * ── HOW TO RUN ────────────────────────────────────────────────────────────────
 *   pnpm db:up && pnpm db:migrate
 *   RUN_DB_TESTS=1 pnpm --filter @badabhai/api run test current-profile-order
 */

const RUN = process.env.RUN_DB_TESTS === "1";
const DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgresql://badabhai:badabhai@localhost:5432/badabhai";

function uuid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

/** Interviewed successfully, then re-extracted during an ai-service outage. */
const WORKER_SHADOWED = uuid(8801);
/** Two rows that extracted content in the SAME millisecond — the total-order probe. */
const WORKER_TIE = uuid(8802);
/** His only extraction ran during the outage. Must still read as unprofiled (self-heal). */
const WORKER_ONLY_EMPTY = uuid(8803);

const GOOD = uuid(8901);
const PLACEHOLDER = uuid(8902);
const TIE_LOW = uuid(8903);
const TIE_HIGH = uuid(8904);
const ONLY_EMPTY = uuid(8905);

const OLDER = new Date("2026-01-01T00:00:00.000Z");
const NEWER = new Date("2026-06-01T00:00:00.000Z");
/** One instant, two rows — `created_at DESC` alone cannot separate these. */
const SAME_INSTANT = new Date("2026-03-01T00:00:00.000Z");

const GOOD_ROLE = "role_welder";
const GOOD_TRADE = "trade_welding";
const GOOD_SKILLS = ["mskill_arc_welding"];

/**
 * The AI-down fallback as it is actually persisted: `DraftProfileSchema.parse({})` — null
 * canonical ids, empty skills/machines, empty jsonb objects, no rich draft. `profile_status`
 * is `"draft"` because `decideProfileStatus` ran `hasExtractedContent` over exactly this shape
 * and got false. The `hasExtractedContent` assertion below pins that premise rather than
 * trusting the comment.
 */
const EMPTY_ROW = {
  profileStatus: "draft" as const,
  canonicalTradeId: null,
  canonicalRoleId: null,
  skills: [],
  machines: [],
  richProfileDraft: null,
};

const CONTENTFUL_ROW = {
  profileStatus: "extracted" as const,
  canonicalTradeId: GOOD_TRADE,
  canonicalRoleId: GOOD_ROLE,
  skills: GOOD_SKILLS,
  machines: [],
  richProfileDraft: null,
};

describe.skipIf(!RUN)("B-8b — an empty extraction never shadows a real profile", () => {
  let client: DbClient;
  let workersRepo: WorkersRepository;
  let reach: ReachRepository;
  let skills: WorkerSkillsRepository;
  let admin: AdminEntitiesRepository;

  beforeAll(async () => {
    client = createDbClient(DATABASE_URL, { max: 1 });
    // The REAL production readers, not re-implementations of their queries. Each takes only
    // the Drizzle handle, so constructing them directly exercises the shipped SQL.
    workersRepo = new WorkersRepository(client.db);
    reach = new ReachRepository(client.db);
    skills = new WorkerSkillsRepository(client.db);
    admin = new AdminEntitiesRepository(client.db);

    await cleanup();
    await client.db.insert(workers).values(
      [WORKER_SHADOWED, WORKER_TIE, WORKER_ONLY_EMPTY].map((id, i) => ({
        id,
        phoneE164: `v1.b8b-${i}`,
        phoneHash: uuid(8700 + i),
        status: "active" as const,
      })),
    );

    // INSERT ORDER IS PART OF THE FIXTURE, not incidental. A single multi-row INSERT lays the
    // rows down in VALUES order, and on a table this small Postgres returns them in that
    // physical order for an unordered read. The placeholder therefore goes FIRST, so a reader
    // with no ORDER BY — which is what `findSignalRowByWorkerId` actually was — returns the
    // WRONG row and the test reddens. With the good row first these assertions passed against
    // the unfixed code, i.e. they were vacuous; that was measured, not guessed.
    await client.db.insert(workerProfiles).values([
      // The outage row, physically first and chronologically LAST.
      { id: PLACEHOLDER, workerId: WORKER_SHADOWED, createdAt: NEWER, ...EMPTY_ROW },
      // The good interview — older, and the answer every reader must reach.
      { id: GOOD, workerId: WORKER_SHADOWED, createdAt: OLDER, ...CONTENTFUL_ROW },
      // Same instant, both real: only the id tiebreak can order these.
      { id: TIE_LOW, workerId: WORKER_TIE, createdAt: SAME_INSTANT, ...CONTENTFUL_ROW },
      { id: TIE_HIGH, workerId: WORKER_TIE, createdAt: SAME_INSTANT, ...CONTENTFUL_ROW },
      { id: ONLY_EMPTY, workerId: WORKER_ONLY_EMPTY, createdAt: NEWER, ...EMPTY_ROW },
    ]);
  });

  afterAll(async () => {
    await cleanup();
    await client.sql.end({ timeout: 5 });
  });

  async function cleanup(): Promise<void> {
    const ids = [WORKER_SHADOWED, WORKER_TIE, WORKER_ONLY_EMPTY];
    // Profiles first — `worker_profiles.worker_id` is ON DELETE CASCADE, so this is belt and
    // braces, but it keeps the teardown readable in the order a human would reason about it.
    await client.db.delete(workerProfiles).where(inArray(workerProfiles.workerId, ids));
    await client.db.delete(workers).where(inArray(workers.id, ids));
  }

  it("PREMISE: the placeholder row really does read as contentless, and the good row does not", () => {
    // If this ever flips, every assertion below would still pass while proving something else.
    // `hasExtractedContent` is the definition `decideProfileStatus` stamps into
    // `profile_status`, which is what the shared ordering reads — so the chain starts here.
    const asFields = (row: typeof EMPTY_ROW | typeof CONTENTFUL_ROW) => ({
      canonicalTradeId: row.canonicalTradeId,
      canonicalRoleId: row.canonicalRoleId,
      skills: row.skills,
      machines: row.machines,
      experience: {},
      salaryExpectation: {},
      locationPreference: {},
      availability: {},
      richProfileDraft: row.richProfileDraft,
    });
    expect(hasExtractedContent(asFields(EMPTY_ROW))).toBe(false);
    expect(hasExtractedContent(asFields(CONTENTFUL_ROW))).toBe(true);
  });

  it("WorkersRepository.latestProfile returns the profile, not the newer placeholder", async () => {
    const p = await workersRepo.latestProfile(WORKER_SHADOWED);
    expect(p?.id).toBe(GOOD);
    expect(p?.canonicalRoleId).toBe(GOOD_ROLE);
  });

  it("WorkersRepository.list shows the same row the worker's own profile read shows", async () => {
    const rows = await workersRepo.list(500);
    const row = rows.find((r) => r.id === WORKER_SHADOWED);
    // The ops console and `GET /workers/me/profile` disagreeing about one worker was a
    // user-visible symptom of the seven-readers problem, not a hypothetical.
    expect(row?.canonical_role_id).toBe(GOOD_ROLE);
    expect(row?.profile_status).toBe("extracted");
  });

  it("AdminEntitiesRepository.findWorker reports extracted, not draft", async () => {
    const detail = await admin.findWorker(WORKER_SHADOWED);
    expect(detail?.profile_status).toBe("extracted");
  });

  it("WorkerSkillsRepository rebuilds derived skills from the real profile", async () => {
    // Reading the placeholder here does not merely mislabel a status: it rebuilds the
    // worker's `derived_coarse` skill rows from an empty array, deleting his match signal.
    const signals = await skills.findLatestProfileSignals(WORKER_SHADOWED);
    expect(signals?.canonicalRoleId).toBe(GOOD_ROLE);
    expect(signals?.profileSkills).toEqual(GOOD_SKILLS);
  });

  it("ReachRepository.findSignalRowByWorkerId is deterministic AND picks the real profile", async () => {
    const row = await reach.findSignalRowByWorkerId(WORKER_SHADOWED);
    expect(row?.canonicalRoleId).toBe(GOOD_ROLE);
    // It had no ORDER BY at all, so identical requests could return different rows as the
    // planner's choice changed. Ten reads, one answer.
    const repeats = await Promise.all(
      Array.from({ length: 10 }, () => reach.findSignalRowByWorkerId(WORKER_SHADOWED)),
    );
    expect(new Set(repeats.map((r) => r?.canonicalRoleId))).toEqual(new Set([GOOD_ROLE]));
  });

  it("ReachRepository.listSignalRows yields ONE row per worker — the payer pool double-count", async () => {
    const rows = await reach.listSignalRows();
    const mine = rows.filter((r) => r.workerId === WORKER_SHADOWED);
    expect(mine).toHaveLength(1);
    expect(mine[0]?.canonicalRoleId).toBe(GOOD_ROLE);

    // WORKER_TIE has two CONTENTFUL rows — the case a status-only dedup would still
    // double-count, and the one PACE supply counts twice.
    expect(rows.filter((r) => r.workerId === WORKER_TIE)).toHaveLength(1);
  });

  it("resolves a same-instant tie the same way everywhere, so no two readers disagree", async () => {
    // `created_at DESC` alone is not a total order. Postgres is free to return either row, and
    // two readers picking differently is exactly the class of bug this closes — so the tie is
    // broken by `id DESC` and every reader must land on the same one.
    const winner = TIE_HIGH > TIE_LOW ? TIE_HIGH : TIE_LOW;
    const p = await workersRepo.latestProfile(WORKER_TIE);
    expect(p?.id).toBe(winner);

    const viaList = (await workersRepo.list(500)).find((r) => r.id === WORKER_TIE);
    const viaReach = await reach.findSignalRowByWorkerId(WORKER_TIE);
    const viaAdmin = await admin.findWorker(WORKER_TIE);
    // All four read the same row, so they cannot report different profiles for one worker.
    expect(viaList?.profile_status).toBe("extracted");
    expect(viaReach?.canonicalRoleId).toBe(GOOD_ROLE);
    expect(viaAdmin?.profile_status).toBe("extracted");
  });

  it("still surfaces the placeholder when it is the worker's ONLY row — the self-heal", async () => {
    // The content preference must not hide a contentless profile that is all a worker has:
    // `ChatService.autoTriggerExtraction` and `ProfilesService.extract` both re-run extraction
    // precisely when `latestProfile` + `hasExtractedContent` says there is nothing yet. Return
    // `undefined` here instead and that worker would never be re-extracted.
    const p = await workersRepo.latestProfile(WORKER_ONLY_EMPTY);
    expect(p?.id).toBe(ONLY_EMPTY);
    expect(hasExtractedContent(p ?? null)).toBe(false);
  });
});
