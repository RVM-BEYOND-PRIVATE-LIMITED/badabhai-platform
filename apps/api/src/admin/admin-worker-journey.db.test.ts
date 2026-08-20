import "reflect-metadata";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  chatSessions,
  createDbClient,
  workerPackAnswers,
  workers,
  type DbClient,
} from "@badabhai/db";
import type { ServerConfig } from "@badabhai/config";

import type { EventsService } from "../events/events.service";
import type { RequestContext } from "../common/request-context";
import { AdminEventsRepository } from "./admin-events.repository";
import { AdminWorkerJourneyRepository } from "./admin-worker-journey.repository";
import { AdminWorkerJourneyService } from "./admin-worker-journey.service";
import type { AdminJourneyProfilingStep } from "./admin-worker-journey.dto";

/**
 * The PROFILING DENOMINATOR, against a REAL database with the REAL seeded pack corpus.
 *
 * ── WHY THE UNIT SUITE COULD NOT CATCH THIS ─────────────────────────────────────────────
 * Every fixture in `admin-worker-journey.service.test.ts` describes a SELF-CONSISTENT world:
 * a worker's answers are stamped with the pack that owns those question keys. Production is
 * not that world, and the difference is the bug.
 *
 * The interview merges TWO packs — the worker's occupation pack and the universal tail — but
 * `packAnswerRowFor` takes ONE `packId` per call and both of its callers pass the SESSION'S
 * pack, which is the OCCUPATION pin. So a universal answer is written with
 * `pack_id = 'qp_welding'`. The pack corpus is the only place that knows `current_city`
 * belongs to `qp_universal`, and no fake can be wrong about that on the seeder's behalf.
 *
 * Measured on the verification database when this suite was written: **17 of 21**
 * `(worker, pack)` rows held MORE answers than their stamped pack has items. `12 of 6` was
 * the modal reading — a progress figure larger than its own denominator, reported as `done`.
 *
 * ── WHAT THIS SEEDS ─────────────────────────────────────────────────────────────────────
 * One worker in exactly that shape: twelve settled answers, all stamped `qp_welding` v1,
 * covering `qp_welding`'s six question keys AND six of `qp_universal`'s eight. The two
 * universal questions deliberately left out — `current_city` and `salary_expected` — are the
 * signal this whole screen exists to show, and the pre-fix denominator could not represent
 * them at all.
 *
 * Nothing here asserts a number the SEEDER does not already own: the expected total is read
 * back out of `question_pack_item` in the same run, so re-authoring a pack changes the
 * expectation with it rather than reddening this file.
 *
 * ── HOW TO RUN ──────────────────────────────────────────────────────────────────────────
 *   pnpm db:migrate && pnpm --filter @badabhai/db db:seed:packs --apply
 *   RUN_DB_TESTS=1 pnpm --filter @badabhai/api run test admin-worker-journey.db
 */

const RUN = process.env.RUN_DB_TESTS === "1";
const DATABASE_URL =
  process.env.E2E_DATABASE_URL ??
  process.env.DATABASE_URL ??
  "postgresql://badabhai:badabhai@localhost:5432/badabhai";

function uuid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

const WORKER = uuid(0xa0e1);
const SESSION = uuid(0xa0e2);
const ADMIN = uuid(0xa0e3);

const OCCUPATION_PACK = "qp_welding";
const UNIVERSAL_PACK = "qp_universal";
const PACK_VERSION = 1;

/** `qp_welding` v1's own six keys. */
const OCCUPATION_KEYS = [
  "welding_process",
  "welding_position",
  "material_worked",
  "safety_gear",
  "workplace_type",
  "certification",
] as const;

/**
 * Six of `qp_universal` v1's eight — stamped, as production stamps them, with the OCCUPATION
 * pack id. `current_city` and `salary_expected` are the two the worker never reached.
 */
const UNIVERSAL_KEYS_ANSWERED = [
  "primary_trade",
  "experience_years",
  "relocation",
  "availability",
  "education",
  "shift_preference",
] as const;

const CTX: RequestContext = {
  correlationId: uuid(0xa0e4),
  requestId: uuid(0xa0e5),
} as unknown as RequestContext;

const CONFIG = { PROFILING_PACK_LOCALE: "hi-IN" } as unknown as ServerConfig;

describe.skipIf(!RUN)("admin worker journey — the profiling denominator against real packs", () => {
  let client!: DbClient;
  let service!: AdminWorkerJourneyService;
  let repo!: AdminWorkerJourneyRepository;

  async function cleanup(): Promise<void> {
    // The worker cascade takes the session and the answer rows with it.
    await client.db.delete(workers).where(eq(workers.id, WORKER));
  }

  beforeAll(async () => {
    if (!RUN) return;
    client = createDbClient(DATABASE_URL, { max: 1 });
    repo = new AdminWorkerJourneyRepository(client.db);
    /**
     * The audit emission is STUBBED, and only here. `getJourneySummary` emits
     * `admin.worker_journey_viewed` fail-closed before it reads, which the unit suite asserts
     * in detail; this suite is about the SQL, and writing to the shared `events` spine on
     * every run would leave rows no cleanup owns.
     */
    const events = { emit: async () => ({ event_id: uuid(0xa0e6) }) } as unknown as EventsService;
    service = new AdminWorkerJourneyService(
      repo,
      new AdminEventsRepository(client.db),
      events,
      CONFIG,
    );

    await cleanup();
    await client.db.insert(workers).values({
      id: WORKER,
      phoneE164: `journey-db-${process.pid}`,
      phoneHash: `journey-db-hash-${process.pid}`,
      status: "active",
    });
    await client.db.insert(chatSessions).values({
      id: SESSION,
      workerId: WORKER,
      status: "ended",
      packId: OCCUPATION_PACK,
      packVersion: PACK_VERSION,
    });
    await client.db.insert(workerPackAnswers).values(
      [...OCCUPATION_KEYS, ...UNIVERSAL_KEYS_ANSWERED].map((questionKey) => ({
        workerId: WORKER,
        chatSessionId: SESSION,
        // ⚠ THE WHOLE POINT: the universal answers carry the OCCUPATION pack's id, because
        // that is what the flush writes.
        packId: OCCUPATION_PACK,
        packVersion: PACK_VERSION,
        questionKey,
        answerText: "x",
        status: "answered" as const,
        source: "chat" as const,
      })),
    );
  });

  afterAll(async () => {
    if (!client) return;
    await cleanup();
    await client.sql.end({ timeout: 5 });
  });

  it("counts the UNIVERSAL tail in the denominator, so `completed` cannot exceed `total`", async () => {
    // Read the truth out of the corpus rather than hard-coding 6 and 8: this is the number
    // the SEEDER owns, and `nextQuestion`'s own `progressOf` is `occupation.items.length +
    // universal.items.length` over exactly these two packs.
    const counts = await repo.countPackItems([
      { packId: OCCUPATION_PACK, packVersion: PACK_VERSION },
      { packId: UNIVERSAL_PACK, packVersion: PACK_VERSION },
    ]);
    const occupationItems = counts.find((c) => c.packId === OCCUPATION_PACK)?.itemCount ?? 0;
    const universalItems = counts.find((c) => c.packId === UNIVERSAL_PACK)?.itemCount ?? 0;
    expect(occupationItems).toBeGreaterThan(0);
    expect(universalItems).toBeGreaterThan(0);

    const summary = await service.getJourneySummary(ADMIN, WORKER, CTX);
    const profiling = summary.steps.find((s) => s.key === "profiling") as AdminJourneyProfilingStep;

    expect(profiling.completed).toBe(OCCUPATION_KEYS.length + UNIVERSAL_KEYS_ANSWERED.length);
    expect(profiling.total).toBe(occupationItems + universalItems);
    // The reading the pre-fix code produced was `12 of 6` → `done`. The two questions this
    // worker never answered are what makes it `in_progress`, and they are only representable
    // once the universal pack is in the denominator.
    expect(profiling.completed).toBeLessThan(profiling.total ?? 0);
    expect(profiling.status).toBe("in_progress");

    // ...and the per-pack rows still describe the STAMP, not the denominator: one row, the
    // occupation pack, carrying every answer. Inventing a universal row here would mean
    // claiming an `answer_count` of 0 for six questions this worker actually answered.
    expect(profiling.packs).toEqual([
      {
        pack_id: OCCUPATION_PACK,
        pack_version: PACK_VERSION,
        item_count: occupationItems,
        answer_count: OCCUPATION_KEYS.length + UNIVERSAL_KEYS_ANSWERED.length,
      },
    ]);

    // Every answer this worker holds is a question one of the two packs still owns, so the
    // corpus accounts for all of them and nothing is caveated.
    expect(summary.caveats).not.toContain("pack_version_retired");
  });

  it("raises `pack_version_retired` for a settled answer no contributing pack still owns", async () => {
    // A question RETIRED out from under a worker: the key is in neither pack at the version
    // this read can load, so the denominator does not describe the numerator. Same class as a
    // whole pack version losing its items, so it reuses that caveat rather than inventing a
    // second one.
    await client.db.insert(workerPackAnswers).values({
      workerId: WORKER,
      chatSessionId: SESSION,
      packId: OCCUPATION_PACK,
      packVersion: PACK_VERSION,
      questionKey: "retired_question",
      answerText: "x",
      status: "answered",
      source: "chat",
    });
    try {
      const summary = await service.getJourneySummary(ADMIN, WORKER, CTX);
      expect(summary.caveats).toContain("pack_version_retired");
    } finally {
      await client.db
        .delete(workerPackAnswers)
        .where(
          and(
            eq(workerPackAnswers.workerId, WORKER),
            eq(workerPackAnswers.questionKey, "retired_question"),
          ),
        );
    }
  });

  /**
   * ⚠ THE NUMERATOR IS QUESTIONS, NOT ANSWER ROWS — against the REAL corpus, because this is
   * the one the unit fixtures cannot state honestly: it needs `wpa_worker_question_uq` to be
   * per-PACK, and a fake cannot be wrong about that on the schema's behalf.
   *
   * A PARTIAL RE-INTERVIEW. The worker is re-interviewed under a second trade, so their six
   * universal answers are stamped a SECOND time under the new occupation pack. They still have
   * not answered `current_city` or `salary_expected`, and they answered only two of the second
   * trade's questions.
   *
   * The rule this replaced counted ROWS and capped the result at the denominator. Measured on
   * this database before the fix, that read `19 of 19` → `done` for this worker. The cap is
   * what produced the 19; it did not catch the overflow, it disguised it as completion — the
   * same false `done` this whole file exists to remove.
   */
  it("a PARTIAL re-interview reads its distinct questions, never a capped row count", async () => {
    const SECOND_PACK = "qp_plumbing";
    // Two of `qp_plumbing`'s own questions, and the SIX universal keys stamped again under it.
    const secondTradeKeys = ["plumbing_scope", "pipe_material"];
    await client.db.insert(workerPackAnswers).values(
      [...secondTradeKeys, ...UNIVERSAL_KEYS_ANSWERED].map((questionKey) => ({
        workerId: WORKER,
        chatSessionId: SESSION,
        packId: SECOND_PACK,
        packVersion: PACK_VERSION,
        questionKey,
        answerText: "x",
        status: "answered" as const,
        source: "chat" as const,
      })),
    );
    try {
      const counts = await repo.countPackItems([
        { packId: OCCUPATION_PACK, packVersion: PACK_VERSION },
        { packId: SECOND_PACK, packVersion: PACK_VERSION },
        { packId: UNIVERSAL_PACK, packVersion: PACK_VERSION },
      ]);
      const total = counts.reduce((sum, c) => sum + c.itemCount, 0);

      const summary = await service.getJourneySummary(ADMIN, WORKER, CTX);
      const profiling = summary.steps.find(
        (s) => s.key === "profiling",
      ) as AdminJourneyProfilingStep;

      // Asserted, not asserted-away: `completed` is `number | null` on the step base, and this
      // worker has answers, so a null here would itself be the regression.
      const completed = profiling.completed;
      expect(completed).not.toBeNull();

      // The ROW count — read out of the response's own uncapped fields — is strictly larger
      // than the questions those rows cover. That inequality IS the fixture: without it this
      // test would be re-asserting the single-interview case.
      const settledRows = profiling.answered_count + profiling.declined_count;
      expect(settledRows).toBeGreaterThan(completed!);

      expect(profiling.total).toBe(total);
      // NOT `total` (the row count capped) and NOT `settledRows`.
      expect(completed!).toBeLessThan(total);
      // The reading the pre-fix rule produced was `done`. Two universal questions are still
      // outstanding, so it is not.
      expect(profiling.status).toBe("in_progress");
      // Rows disagreeing with questions is what the caveat names, so the operator reading
      // `completed` beside `answered_count` is told why the two do not reconcile.
      expect(summary.caveats).toContain("pack_version_retired");
    } finally {
      await client.db
        .delete(workerPackAnswers)
        .where(
          and(eq(workerPackAnswers.workerId, WORKER), eq(workerPackAnswers.packId, SECOND_PACK)),
        );
    }
  });
});
