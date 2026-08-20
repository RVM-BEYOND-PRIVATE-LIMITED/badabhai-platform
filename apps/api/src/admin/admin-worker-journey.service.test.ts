import { describe, it, expect, vi } from "vitest";
import { NotFoundException } from "@nestjs/common";
import type { ServerConfig } from "@badabhai/config";
import type { RequestContext } from "../common/request-context";
import type { EventsService } from "../events/events.service";
import { AdminWorkerJourneyService } from "./admin-worker-journey.service";
import type { AdminWorkerJourneyRepository } from "./admin-worker-journey.repository";
import type { AdminEventsRepository } from "./admin-events.repository";
import type {
  AdminJourneyInterviewKitStep,
  AdminJourneyLoginStep,
  AdminJourneyPhotoStep,
  AdminJourneyProfileStep,
  AdminJourneyProfilingStep,
  AdminJourneyResumeStep,
  AdminJourneySearchApplyStep,
  AdminJourneyStep,
  AdminWorkerJourneySummary,
} from "./admin-worker-journey.dto";

/**
 * The journey SERVICE — where every funnel rule lives.
 *
 * The repository is faked so each test can state one worker's data exactly and assert the
 * rule, not the SQL. The SQL's own properties (which columns are projected, which index a
 * predicate matches) are pinned in `admin-worker-journey.repository.test.ts`.
 */

const WORKER = "11111111-1111-4111-8111-111111111111";
const SESSION = "22222222-2222-4222-8222-222222222222";
const ADMIN = "33333333-3333-4333-8333-333333333333";
const CREATED = new Date("2026-01-01T00:00:00.000Z");

const CTX: RequestContext = {
  correlationId: "corr-1",
  requestId: "req-1",
} as unknown as RequestContext;

const CONFIG = { PROFILING_PACK_LOCALE: "hi-IN" } as unknown as ServerConfig;

type Repo = AdminWorkerJourneyRepository;

/**
 * The funnel's two spine reads. They are methods on `AdminEventsRepository` — `events` has
 * exactly ONE admin reader by design — so they are NOT in `keyof Repo` and `fakeRepo`'s
 * override type has to name them.
 *
 * `Extract` rather than a bare string union: this resolves to `never` if either method is
 * renamed or removed on the real class, and every `fakeRepo({ countWorkerSubjectEvents: ... })`
 * below stops compiling. A hand-written union would silently keep accepting a dead key.
 */
type JourneySpineRead = Extract<
  keyof AdminEventsRepository,
  "countWorkerSubjectEvents" | "countInterviewKitDownloads"
>;

/**
 * A repository whose every read returns "this worker has done nothing", overridable per test.
 *
 * `countPackItems` RECORDS THE PAIRS IT WAS ASKED FOR — that recording is what makes the
 * denominator test below capable of failing, because an implementation that re-derived the
 * denominator from the currently-active pack would ask for a different pair (or none).
 */
function fakeRepo(over: Partial<Record<keyof Repo | JourneySpineRead, unknown>> = {}) {
  const askedForPairs: Array<{ packId: string; packVersion: number }> = [];
  // `Object.assign` rather than a spread: spreading `over` (whose values are `unknown`) would
  // widen every mock on `raw` to `unknown` and cost the tests their `.mock.calls` types.
  const repo = {
    findWorkerCore: vi.fn(async () => ({ id: WORKER, hasPhoto: false, createdAt: CREATED })),
    // The parameters are DECLARED even though the base implementation ignores them: without
    // them `mock.calls[0]` types as the empty tuple and the "which event names did it ask
    // for" assertions below cannot be written at all.
    countWorkerSubjectEvents: vi.fn(
      async (
        _workerId: string,
        _eventNames: readonly string[],
      ): Promise<
        Array<{ eventName: string; n: number; firstAt: Date | null; lastAt: Date | null }>
      > => [],
    ),
    countInterviewKitDownloads: vi.fn(async () => ({
      n: 0,
      trades: 0,
      firstAt: null,
      lastAt: null,
    })),
    packAnswerStatusCounts: vi.fn(async () => []),
    answeredPackVersions: vi.fn(async () => []),
    countPackItems: vi.fn(async (pairs: Array<{ packId: string; packVersion: number }>) => {
      askedForPairs.push(...pairs);
      return [];
    }),
    // "Every settled answer this worker holds is a question one of the contributing packs
    // still owns" — the healthy case, so a test that means to exercise a retired question has
    // to say so explicitly rather than inheriting it.
    countSettledKeysOutsidePacks: vi.fn(async () => 0),
    countSessions: vi.fn(async () => 0),
    resumeStats: vi.fn(async () => ({ n: 0, rendered: 0, firstAt: null, lastAt: null })),
    currentProfile: vi.fn(async () => ({
      status: null,
      confirmedAt: null,
      createdAt: null,
      updatedAt: null,
      profileCount: 0,
    })),
    applicationActionCounts: vi.fn(async () => []),
    listSessions: vi.fn(
      async (
        _workerId: string,
        _filter: { status?: string },
        _cursor: unknown,
        _limit: number,
      ): Promise<unknown[]> => [],
    ),
    countMessagesBySession: vi.fn(async () => new Map<string, number>()),
    countAnswersBySession: vi.fn(async () => new Map<string, number>()),
    findSession: vi.fn(async () => undefined),
    listSessionAnswers: vi.fn(async () => []),
    listSessionVoiceAnswers: vi.fn(async () => []),
    listSessionAiJobs: vi.fn(async () => []),
    sessionAiCost: vi.fn(async () => null),
    listSettledKeys: vi.fn(async () => []),
    sessionPackVersions: vi.fn(async () => []),
    listPackItems: vi.fn(async () => []),
    // The universal pack is never PINNED on a session, so the detail read resolves the active
    // one as a last resort. Default: none configured, which is the pre-fix behaviour.
    findActiveUniversalPack: vi.fn(
      async (_locale: string): Promise<{ packId: string; packVersion: number } | null> => null,
    ),
  };
  Object.assign(repo, over);
  // The parameter is DECLARED even though it is ignored: without it `mock.calls[0]` types as
  // the empty tuple and the "what exactly did it put on the spine" assertions below cannot be
  // written at all (the same reason `countWorkerSubjectEvents` above declares its two).
  const emit = vi.fn(async (_params: Record<string, unknown>) => ({ event_id: "e-1" }));
  const events = { emit } as unknown as EventsService;
  return {
    repo: repo as unknown as Repo,
    raw: repo,
    askedForPairs,
    emit,
    // TWO collaborators, ONE double. `countWorkerSubjectEvents`/`countInterviewKitDownloads`
    // live on `AdminEventsRepository` (the spine has exactly one admin reader), the rest on
    // `AdminWorkerJourneyRepository`; this object satisfies both, so `over` overrides and
    // `raw.<method>.mock.calls` keep working regardless of which class owns a read. Nothing is
    // lost by sharing it: the service is typechecked against the REAL classes, so calling a
    // spine read off `this.repo` is a compile error, not something a double could hide.
    service: new AdminWorkerJourneyService(
      repo as unknown as Repo,
      repo as unknown as AdminEventsRepository,
      events,
      CONFIG,
    ),
  };
}

function step<K extends AdminJourneyStep["key"]>(
  summary: AdminWorkerJourneySummary,
  key: K,
): Extract<AdminJourneyStep, { key: K }> {
  const found = summary.steps.find((s) => s.key === key);
  if (!found) throw new Error(`step ${key} missing from the funnel`);
  return found as Extract<AdminJourneyStep, { key: K }>;
}

// ---------------------------------------------------------------------------
// Shape + 404
// ---------------------------------------------------------------------------

describe("journey summary — the funnel shape", () => {
  it("404s for an unknown worker rather than returning an empty funnel", async () => {
    const { service, raw } = fakeRepo({ findWorkerCore: vi.fn(async () => undefined) });
    await expect(service.getJourneySummary(ADMIN, WORKER, CTX)).rejects.toBeInstanceOf(NotFoundException);
    // ...and it does not go on to run the eight other reads for a worker that does not exist.
    expect(raw.packAnswerStatusCounts).not.toHaveBeenCalled();
  });

  it("always returns ALL SEVEN steps in order — a step that never happened is `not_done`, never absent", async () => {
    const { service } = fakeRepo();
    const summary = await service.getJourneySummary(ADMIN, WORKER, CTX);
    expect(summary.steps.map((s) => s.key)).toEqual([
      "login",
      "profiling",
      "resume",
      "profile_confirmed",
      "job_search_apply",
      "photo",
      "interview_kit",
    ]);
    expect(summary.steps.map((s) => s.order)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it("always carries the interview-kit attribution caveat (a zero there is not a 'never')", async () => {
    const { service } = fakeRepo();
    const summary = await service.getJourneySummary(ADMIN, WORKER, CTX);
    expect(summary.caveats).toContain("interview_kit_attribution_since_0079");
  });
});

// ---------------------------------------------------------------------------
// Step 1 — login
// ---------------------------------------------------------------------------

describe("step 1: login", () => {
  it("counts `worker.otp_verified` with first/last, and keeps `worker.test_login` SEPARATE", async () => {
    const first = new Date("2026-02-01T10:00:00.000Z");
    const last = new Date("2026-03-01T10:00:00.000Z");
    const testAt = new Date("2026-04-01T10:00:00.000Z");
    const { service } = fakeRepo({
      countWorkerSubjectEvents: vi.fn(async () => [
        { eventName: "worker.otp_verified", n: 4, firstAt: first, lastAt: last },
        { eventName: "worker.test_login", n: 2, firstAt: testAt, lastAt: testAt },
      ]),
    });

    const login = step(await service.getJourneySummary(ADMIN, WORKER, CTX), "login") as AdminJourneyLoginStep;
    expect(login.otp_verified_count).toBe(4);
    expect(login.completed).toBe(4);
    expect(login.first_at).toEqual(first);
    expect(login.last_at).toEqual(last);
    // The staging mint is reported but NEVER folded into the real count — the two events are
    // distinct names precisely so a test mint cannot masquerade as a login.
    expect(login.test_login_count).toBe(2);
    expect(login.last_test_login_at).toEqual(testAt);
  });

  it("asks for exactly the three worker-SUBJECT event names (never feed.shown/application.submitted)", async () => {
    const { service, raw } = fakeRepo();
    await service.getJourneySummary(ADMIN, WORKER, CTX);
    const names = raw.countWorkerSubjectEvents.mock.calls[0]![1];
    // Those two events' subject is the JOB, so a per-worker count off them is unindexed.
    expect(names).toEqual(["worker.otp_verified", "worker.test_login", "job.search_performed"]);
    expect(names).not.toContain("feed.shown");
    expect(names).not.toContain("application.submitted");
  });

  it("is `done` even with zero otp events — the worker ROW is the proof a login happened", async () => {
    // The only production writer of a `workers` row is `createOrGetByPhoneHash`, reached only
    // from `mintLoginForPhone`, reached only from verifyOtp/testLogin. A row implies a login;
    // the counts carry the nuance (here: a worker minted by a staging test login).
    const { service } = fakeRepo({
      countWorkerSubjectEvents: vi.fn(async () => [
        { eventName: "worker.test_login", n: 1, firstAt: CREATED, lastAt: CREATED },
      ]),
    });
    const login = step(await service.getJourneySummary(ADMIN, WORKER, CTX), "login") as AdminJourneyLoginStep;
    expect(login.status).toBe("done");
    expect(login.otp_verified_count).toBe(0);
    expect(login.test_login_count).toBe(1);
    // With no real login event, the timestamps fall back to the worker row's own creation.
    expect(login.first_at).toEqual(CREATED);
    expect(login.worker_created_at).toEqual(CREATED);
  });
});

// ---------------------------------------------------------------------------
// Step 2 — profiling, and the denominator property this whole PR turns on
// ---------------------------------------------------------------------------

/**
 * ⚠ READ THIS BEFORE ADDING A FIXTURE HERE.
 *
 * Every fixture in this block below the first four tests describes a SELF-CONSISTENT world:
 * the worker's answers are stamped with the pack that owns those question keys. Production is
 * not that world. `packAnswerRowFor` takes ONE `packId` per call and both callers pass the
 * SESSION'S pack — the OCCUPATION pin — so a universal answer is written with
 * `pack_id = 'qp_welding'`.
 *
 * That gap is why this suite was fully green while `GET /admin/workers/:id/journey-summary`
 * reported `completed 12, total 6, status done` on 17 of 21 `(worker, pack)` groups of the
 * verification database, and `done` for 21 of 21 workers who had all left questions
 * unanswered. A fixture that stamps universal answers with a universal pack cannot express
 * the bug; the four tests immediately below stamp them the way the writer really does.
 */
describe("step 2: profiling — the REAL stamping shape (universal answers under the occupation pack)", () => {
  /** 6 occupation items + 8 universal items, the shipped `qp_welding` / `qp_universal` sizes. */
  const OCCUPATION_ITEMS = 6;
  const UNIVERSAL_ITEMS = 8;

  /**
   * The production shape exactly: ONE stamped pair, `qp_welding:1`, carrying twelve settled
   * answers — six of `qp_welding`'s own questions and six of `qp_universal`'s eight.
   */
  function realShape(over: Record<string, unknown> = {}) {
    // Its OWN recorder, because this helper overrides `countPackItems` and would otherwise
    // silence `fakeRepo`'s. Recording WHICH pairs were asked for is what makes these tests
    // capable of failing on a mutation that reaches the right total by the wrong route.
    const asked: string[] = [];
    const harness = fakeRepo({
      answeredPackVersions: vi.fn(async () => [
        { packId: "qp_welding", packVersion: 1, answerCount: 12 },
      ]),
      countPackItems: vi.fn(async (pairs: Array<{ packId: string; packVersion: number }>) => {
        asked.push(...pairs.map((p) => `${p.packId}:${p.packVersion}`));
        const byPair: Record<string, number> = {
          "qp_welding:1": OCCUPATION_ITEMS,
          "qp_universal:1": UNIVERSAL_ITEMS,
          "qp_universal:2": UNIVERSAL_ITEMS,
        };
        return pairs.flatMap((p) => {
          const itemCount = byPair[`${p.packId}:${p.packVersion}`];
          return itemCount === undefined
            ? []
            : [{ packId: p.packId, packVersion: p.packVersion, itemCount }];
        });
      }),
      packAnswerStatusCounts: vi.fn(async () => [
        { status: "answered", n: 12, firstAt: CREATED, lastAt: CREATED },
      ]),
      findActiveUniversalPack: vi.fn(async () => ({ packId: "qp_universal", packVersion: 1 })),
      ...over,
    });
    return { ...harness, asked };
  }

  it("counts the UNIVERSAL tail no answer row names, so 12 settled reads `12 of 14` and not `12 of 6`", async () => {
    const { service, asked } = realShape();
    const summary = await service.getJourneySummary(ADMIN, WORKER, CTX);
    const profiling = step(summary, "profiling") as AdminJourneyProfilingStep;

    // THE BUG, STATED AS A NUMBER. Pre-fix this was `12 of 6` — a progress figure larger than
    // its own denominator — and `progressStatus(12, 6)` therefore said `done` for a worker who
    // had two questions left. 6 + 8 is also what the engine's `progressOf` shows the WORKER.
    expect(profiling.completed).toBe(12);
    expect(profiling.total).toBe(OCCUPATION_ITEMS + UNIVERSAL_ITEMS);
    expect(profiling.status).toBe("in_progress");

    // The direct evidence, so a mutation that reached 14 some other way still fails: the read
    // asked for the stamped pair AND the active universal one, in that precedence.
    expect(asked).toEqual(["qp_welding:1", "qp_universal:1"]);

    // ...and `packs[]` is untouched: it describes the STAMP, so one row carrying twelve
    // answers against six questions is the true reading of a mis-stamped corpus, not a second
    // progress figure to be reconciled with the headline.
    expect(profiling.packs).toEqual([
      { pack_id: "qp_welding", pack_version: 1, item_count: OCCUPATION_ITEMS, answer_count: 12 },
    ]);
    expect(summary.caveats).not.toContain("pack_version_retired");
  });

  it("does NOT add today's universal pack when the worker's own rows already name one", async () => {
    // Durable evidence beats the approximation. `qp_universal:1` is stamped, the ACTIVE
    // version is v2 — adding v2 would count the same eight-question tail twice (`6 + 8 + 8`).
    const { service, asked } = realShape({
      answeredPackVersions: vi.fn(async () => [
        { packId: "qp_welding", packVersion: 1, answerCount: 6 },
        { packId: "qp_universal", packVersion: 1, answerCount: 6 },
      ]),
      findActiveUniversalPack: vi.fn(async () => ({ packId: "qp_universal", packVersion: 2 })),
    });
    const profiling = step(
      await service.getJourneySummary(ADMIN, WORKER, CTX),
      "profiling",
    ) as AdminJourneyProfilingStep;

    expect(profiling.total).toBe(OCCUPATION_ITEMS + UNIVERSAL_ITEMS);
    expect(asked).toEqual(["qp_welding:1", "qp_universal:1"]);
  });

  it("gives a worker with NO answer rows no denominator at all, rather than the corpus's", async () => {
    // `0 of 8` would be a number about the pack corpus wearing a progress bar about a person:
    // nothing here is evidence that an interview ever ran for them.
    const { service, asked } = realShape({
      answeredPackVersions: vi.fn(async () => []),
      packAnswerStatusCounts: vi.fn(async () => []),
    });
    const profiling = step(await service.getJourneySummary(ADMIN, WORKER, CTX), "profiling");
    expect(profiling.total).toBeNull();
    expect(profiling.completed).toBe(0);
    expect(asked).toEqual([]);
  });

  it("caveats a settled answer no contributing pack still owns, and does NOT invent a second code", async () => {
    // A pack re-seed that DROPS a question leaves the worker holding an answer to a question
    // that no longer exists. `12 of 14` would then quietly mean "11 of the current 14, plus
    // one nobody asks any more" — the only one of the three causes that never pushes the
    // numerator past the denominator, so nothing else would notice it.
    const { service } = realShape({
      countSettledKeysOutsidePacks: vi.fn(async () => 1),
    });
    const summary = await service.getJourneySummary(ADMIN, WORKER, CTX);
    expect(summary.caveats).toContain("pack_version_retired");
    // Same class ⇒ same code. A second enum member would be a second sentence for an operator
    // to learn about one fact: the corpus no longer accounts for these answers.
    expect(summary.caveats.filter((c) => c === "pack_version_retired")).toHaveLength(1);
    // The count is NOT silently absorbed into the numerator either — `completed` still reports
    // what settled.
    expect(step(summary, "profiling").completed).toBe(12);
  });

  it("CLAMPS `completed` to `total` and says so, so the UI can never render `20 of 14`", async () => {
    // A RE-INTERVIEW under a second trade: `wpa_worker_question_uq` is per PACK, so the
    // universal answers are stamped a second time under the new occupation pack. Twenty settled
    // rows, fourteen distinct questions. Reachable without any retirement at all.
    const { service } = realShape({
      packAnswerStatusCounts: vi.fn(async () => [
        { status: "answered", n: 18, firstAt: CREATED, lastAt: CREATED },
        { status: "declined", n: 2, firstAt: CREATED, lastAt: CREATED },
      ]),
    });
    const summary = await service.getJourneySummary(ADMIN, WORKER, CTX);
    const profiling = step(summary, "profiling") as AdminJourneyProfilingStep;

    expect(profiling.total).toBe(14);
    expect(profiling.completed).toBe(14);
    expect(profiling.status).toBe("done");
    // NOT SILENTLY: a clamp that bites is exactly the condition the caveat names.
    expect(summary.caveats).toContain("pack_version_retired");
    // ...and the uncapped truth is still on the response, where nothing rounded it.
    expect(profiling.answered_count).toBe(18);
    expect(profiling.declined_count).toBe(2);
  });
});

describe("step 2: profiling — the denominator comes from the ANSWERS' OWN pack versions", () => {
  /**
   * ⚠ THE PROPERTY THIS FILE EXISTS FOR.
   *
   * The interview merges an occupation pack and a UNIVERSAL pack, and only the occupation
   * pack is pinned on `chat_sessions`. The universal pack is resolved fresh from whatever is
   * `active`. So an implementation that re-derived the denominator from "the currently active
   * pack" would change a FINISHED worker's total the next time a pack was re-seeded.
   *
   * The fake below makes the two readings numerically different — v1 has 12 items, the newer
   * v2 has 40 — and asserts BOTH that the total is v1's and that the repository was asked for
   * v1. The second assertion is what makes this test fail under a faithful mutation rather
   * than passing on a coincidence.
   */
  it("sums items for the pack VERSIONS the answers stamp, not for the newest version of that pack", async () => {
    const { service, askedForPairs } = fakeRepo({
      answeredPackVersions: vi.fn(async () => [
        { packId: "qp_welding", packVersion: 1, answerCount: 8 },
        { packId: "qp_universal", packVersion: 3, answerCount: 4 },
      ]),
      countPackItems: vi.fn(async (pairs: Array<{ packId: string; packVersion: number }>) => {
        askedForPairs.push(...pairs);
        // The world as it is TODAY: qp_welding is on v2 with 40 items and qp_universal on v9
        // with 30. Neither is what this worker was asked.
        const byPair: Record<string, number> = {
          "qp_welding:1": 12,
          "qp_welding:2": 40,
          "qp_universal:3": 6,
          "qp_universal:9": 30,
        };
        return pairs.flatMap((p) => {
          const itemCount = byPair[`${p.packId}:${p.packVersion}`];
          return itemCount === undefined
            ? []
            : [{ packId: p.packId, packVersion: p.packVersion, itemCount }];
        });
      }),
      packAnswerStatusCounts: vi.fn(async () => [
        { status: "answered", n: 10, firstAt: CREATED, lastAt: CREATED },
        { status: "declined", n: 2, firstAt: CREATED, lastAt: CREATED },
      ]),
    });

    const profiling = step(
      await service.getJourneySummary(ADMIN, WORKER, CTX),
      "profiling",
    ) as AdminJourneyProfilingStep;

    // 12 (welding v1) + 6 (universal v3) = 18. The active-pack reading would be 40 + 30 = 70.
    expect(profiling.total).toBe(18);
    expect(profiling.completed).toBe(12);
    expect(profiling.status).toBe("in_progress");

    // The pairs actually asked for — the direct evidence that the versions came from the
    // worker's own rows. `[{welding,2},{universal,9}]` would be the active-pack mutation.
    expect(askedForPairs.map((p) => `${p.packId}:${p.packVersion}`)).toEqual([
      "qp_welding:1",
      "qp_universal:3",
    ]);
  });

  it("reports BOTH packs' progress separately, so a merged interview is legible", async () => {
    const { service } = fakeRepo({
      answeredPackVersions: vi.fn(async () => [
        { packId: "qp_welding", packVersion: 1, answerCount: 8 },
        { packId: "qp_universal", packVersion: 3, answerCount: 4 },
      ]),
      countPackItems: vi.fn(async () => [
        { packId: "qp_welding", packVersion: 1, itemCount: 12 },
        { packId: "qp_universal", packVersion: 3, itemCount: 6 },
      ]),
    });
    const profiling = step(
      await service.getJourneySummary(ADMIN, WORKER, CTX),
      "profiling",
    ) as AdminJourneyProfilingStep;
    expect(profiling.packs).toEqual([
      { pack_id: "qp_welding", pack_version: 1, item_count: 12, answer_count: 8 },
      { pack_id: "qp_universal", pack_version: 3, item_count: 6, answer_count: 4 },
    ]);
  });

  it("raises `pack_version_retired` when an answered version has no items left", async () => {
    // The version was retired out from under the worker's answers, so the denominator is an
    // undercount. Say so rather than rendering a progress bar nobody can trust.
    const { service } = fakeRepo({
      answeredPackVersions: vi.fn(async () => [
        { packId: "qp_welding", packVersion: 1, answerCount: 8 },
      ]),
      countPackItems: vi.fn(async () => []),
      packAnswerStatusCounts: vi.fn(async () => [
        { status: "answered", n: 8, firstAt: CREATED, lastAt: CREATED },
      ]),
    });
    const summary = await service.getJourneySummary(ADMIN, WORKER, CTX);
    expect(summary.caveats).toContain("pack_version_retired");
    // ...and the total is null, not 0: `8 of 0` is a missing denominator wearing a progress bar.
    expect(step(summary, "profiling").total).toBeNull();
  });

  /**
   * THE RULE: the numerator is the SETTLED set only — `answered` + `declined`. `unanswered` is
   * counted and reported, never added in.
   *
   * The fixture is built so that the difference is the whole test: 6 + 2 + 1 against an
   * `item_count` of 9, so the wrong rule reads `9 of 9` → `done` and the right one reads
   * `8 of 9` → `in_progress`. That is the exact shape of the bug this replaced — a worker who
   * settled nothing at all would have reported `done` under it.
   *
   * The answered/declined/unanswered/total assertions are deliberately left alone: they are
   * what make this prove the SPLIT rather than re-baseline a number. A version that dropped
   * unanswered rows on the floor entirely would pass a `completed: 8` assertion and fail here.
   */
  it("counts ONLY answered + declined as the numerator, and reports unanswered separately", async () => {
    const { service } = fakeRepo({
      answeredPackVersions: vi.fn(async () => [
        { packId: "qp_welding", packVersion: 1, answerCount: 9 },
      ]),
      countPackItems: vi.fn(async () => [
        { packId: "qp_welding", packVersion: 1, itemCount: 9 },
      ]),
      packAnswerStatusCounts: vi.fn(async () => [
        { status: "answered", n: 6, firstAt: new Date("2026-05-01"), lastAt: new Date("2026-05-02") },
        { status: "declined", n: 2, firstAt: new Date("2026-05-01"), lastAt: new Date("2026-05-03") },
        { status: "unanswered", n: 1, firstAt: new Date("2026-04-30"), lastAt: new Date("2026-05-01") },
      ]),
    });
    const profiling = step(
      await service.getJourneySummary(ADMIN, WORKER, CTX),
      "profiling",
    ) as AdminJourneyProfilingStep;
    expect(profiling.answered_count).toBe(6);
    expect(profiling.declined_count).toBe(2);
    expect(profiling.unanswered_count).toBe(1);
    // 6 + 2, NOT 6 + 2 + 1. The unanswered row is visible in its own field and absent here.
    expect(profiling.completed).toBe(8);
    expect(profiling.total).toBe(9);
    // ...so 8 of 9, not 9 of 9. A worker with a question still hanging is not finished.
    expect(profiling.status).toBe("in_progress");
    // first/last span every status bucket, not just the answered one.
    expect(profiling.first_at).toEqual(new Date("2026-04-30"));
    expect(profiling.last_at).toEqual(new Date("2026-05-03"));
  });

  it("is `not_done` when the worker answered nothing, whatever the denominator says", async () => {
    const { service } = fakeRepo({
      answeredPackVersions: vi.fn(async () => []),
      packAnswerStatusCounts: vi.fn(async () => []),
    });
    const profiling = step(await service.getJourneySummary(ADMIN, WORKER, CTX), "profiling");
    expect(profiling.status).toBe("not_done");
    expect(profiling.completed).toBe(0);
    expect(profiling.total).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Steps 3, 4, 6
// ---------------------------------------------------------------------------

describe("step 3: resume", () => {
  it("is `done` when a generated_resumes row exists, and reports the PDF render separately", async () => {
    const at = new Date("2026-06-01T00:00:00.000Z");
    const { service } = fakeRepo({
      resumeStats: vi.fn(async () => ({ n: 2, rendered: 1, firstAt: at, lastAt: at })),
    });
    const resume = step(
      await service.getJourneySummary(ADMIN, WORKER, CTX),
      "resume",
    ) as AdminJourneyResumeStep;
    expect(resume.status).toBe("done");
    expect(resume.has_resume).toBe(true);
    expect(resume.resume_count).toBe(2);
    // The PDF is rendered asynchronously and can lag or fail on its own — "has a resume" and
    // "can download a resume" are different facts, so they are different fields.
    expect(resume.rendered_count).toBe(1);
  });

  it("is `not_done` with no rows", async () => {
    const { service } = fakeRepo();
    expect(step(await service.getJourneySummary(ADMIN, WORKER, CTX), "resume").status).toBe("not_done");
  });
});

describe("step 4: profile confirmed", () => {
  const cases: Array<[string | null, string]> = [
    ["confirmed", "done"],
    ["extracted", "in_progress"],
    ["extracting", "in_progress"],
    // `draft` is the placeholder an ai-service outage writes. It is NOT progress.
    ["draft", "not_done"],
    [null, "not_done"],
  ];

  for (const [status, expected] of cases) {
    it(`profile_status ${status ?? "null"} ⇒ ${expected}`, async () => {
      const { service } = fakeRepo({
        currentProfile: vi.fn(async () => ({
          status,
          confirmedAt: status === "confirmed" ? new Date("2026-07-01") : null,
          createdAt: CREATED,
          updatedAt: CREATED,
          profileCount: status === null ? 0 : 1,
        })),
      });
      const profile = step(
        await service.getJourneySummary(ADMIN, WORKER, CTX),
        "profile_confirmed",
      ) as AdminJourneyProfileStep;
      expect(profile.status).toBe(expected);
      expect(profile.profile_status).toBe(status);
    });
  }

  it("surfaces confirmed_at and how many profile rows exist (>1 means re-interviews)", async () => {
    const confirmedAt = new Date("2026-07-01T00:00:00.000Z");
    const { service } = fakeRepo({
      currentProfile: vi.fn(async () => ({
        status: "confirmed",
        confirmedAt,
        createdAt: CREATED,
        updatedAt: confirmedAt,
        profileCount: 3,
      })),
    });
    const profile = step(
      await service.getJourneySummary(ADMIN, WORKER, CTX),
      "profile_confirmed",
    ) as AdminJourneyProfileStep;
    expect(profile.confirmed_at).toEqual(confirmedAt);
    expect(profile.profile_count).toBe(3);
  });
});

describe("step 6: photo", () => {
  it("reflects the boolean Postgres computed — the storage key never reaches this layer", async () => {
    const { service } = fakeRepo({
      findWorkerCore: vi.fn(async () => ({ id: WORKER, hasPhoto: true, createdAt: CREATED })),
    });
    const photo = step(await service.getJourneySummary(ADMIN, WORKER, CTX), "photo") as AdminJourneyPhotoStep;
    expect(photo.has_photo).toBe(true);
    expect(photo.status).toBe("done");
    // No timestamp is invented: `workers` has no per-column stamp, and `updated_at` moves for
    // any reason at all, so reporting it as "when the photo was added" would be wrong.
    expect(photo.first_at).toBeNull();
    expect(photo.last_at).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Step 5 — search / apply
// ---------------------------------------------------------------------------

describe("step 5: job search / apply", () => {
  it("counts APPLIED from the applications table and reports skipped separately", async () => {
    const appliedAt = new Date("2026-08-01T00:00:00.000Z");
    const { service } = fakeRepo({
      applicationActionCounts: vi.fn(async () => [
        { action: "applied", n: 3, firstAt: appliedAt, lastAt: appliedAt },
        { action: "skipped", n: 11, firstAt: appliedAt, lastAt: appliedAt },
      ]),
    });
    const s = step(
      await service.getJourneySummary(ADMIN, WORKER, CTX),
      "job_search_apply",
    ) as AdminJourneySearchApplyStep;
    // Deliberately NARROWER than AdminWorkerDetail.application_count, which counts both: a
    // skip is a real signal but it is not a funnel completion.
    expect(s.applied_count).toBe(3);
    expect(s.completed).toBe(3);
    expect(s.skipped_count).toBe(11);
    expect(s.status).toBe("done");
  });

  it("searching without applying is `in_progress`, not `done`", async () => {
    const searchAt = new Date("2026-08-02T00:00:00.000Z");
    const { service } = fakeRepo({
      countWorkerSubjectEvents: vi.fn(async () => [
        { eventName: "job.search_performed", n: 7, firstAt: searchAt, lastAt: searchAt },
      ]),
    });
    const s = step(
      await service.getJourneySummary(ADMIN, WORKER, CTX),
      "job_search_apply",
    ) as AdminJourneySearchApplyStep;
    expect(s.search_count).toBe(7);
    expect(s.first_search_at).toEqual(searchAt);
    expect(s.applied_count).toBe(0);
    expect(s.status).toBe("in_progress");
  });

  it("neither searched nor applied ⇒ not_done", async () => {
    const { service } = fakeRepo();
    expect(step(await service.getJourneySummary(ADMIN, WORKER, CTX), "job_search_apply").status).toBe(
      "not_done",
    );
  });
});

// ---------------------------------------------------------------------------
// Step 7 — interview kit
// ---------------------------------------------------------------------------

describe("step 7: interview kit", () => {
  it("counts attributed downloads and distinct trades", async () => {
    const at = new Date("2026-08-10T00:00:00.000Z");
    const { service } = fakeRepo({
      countInterviewKitDownloads: vi.fn(async () => ({
        n: 5,
        trades: 2,
        firstAt: at,
        lastAt: at,
      })),
    });
    const kit = step(
      await service.getJourneySummary(ADMIN, WORKER, CTX),
      "interview_kit",
    ) as AdminJourneyInterviewKitStep;
    expect(kit.download_count).toBe(5);
    expect(kit.trade_count).toBe(2);
    expect(kit.status).toBe("done");
    expect(kit.attribution_available).toBe(true);
  });

  it("a zero download count still ships the caveat — it is not evidence of 'never downloaded'", async () => {
    const { service } = fakeRepo();
    const summary = await service.getJourneySummary(ADMIN, WORKER, CTX);
    expect(step(summary, "interview_kit").status).toBe("not_done");
    expect(summary.caveats).toContain("interview_kit_attribution_since_0079");
  });
});

// ---------------------------------------------------------------------------
// Sessions: list
// ---------------------------------------------------------------------------

const sessionRow = (over: Partial<Record<string, unknown>> = {}) => ({
  id: SESSION,
  workerId: WORKER,
  status: "ended",
  startedAt: new Date("2026-08-01T09:00:00.000Z"),
  endedAt: new Date("2026-08-01T09:20:00.000Z"),
  lastMessageAt: new Date("2026-08-01T09:19:00.000Z"),
  packId: "qp_welding",
  packVersion: 1,
  ...over,
});

describe("chat-session list", () => {
  it("404s for an unknown worker", async () => {
    const { service } = fakeRepo({ findWorkerCore: vi.fn(async () => undefined) });
    await expect(
      service.listChatSessions(WORKER, { limit: 20 }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("over-fetches by ONE and only then claims a next page (no phantom empty page)", async () => {
    const rows = Array.from({ length: 3 }, (_, i) =>
      sessionRow({ id: `s${i}`, startedAt: new Date(2026, 0, 10 - i) }),
    );
    const { service, raw } = fakeRepo({ listSessions: vi.fn(async () => rows) });

    const page = await service.listChatSessions(WORKER, { limit: 2 });
    expect(raw.listSessions.mock.calls[0]![3]).toBe(3); // limit + 1
    expect(page.items).toHaveLength(2);
    expect(page.nextCursor).not.toBeNull();
  });

  it("returns a null cursor when the page is exactly the last one", async () => {
    const rows = [sessionRow({ id: "s0" }), sessionRow({ id: "s1" })];
    const { service } = fakeRepo({ listSessions: vi.fn(async () => rows) });
    const page = await service.listChatSessions(WORKER, { limit: 2 });
    expect(page.items).toHaveLength(2);
    expect(page.nextCursor).toBeNull();
  });

  it("joins message + answer counts for the WHOLE page in one call each (no N+1)", async () => {
    const rows = [sessionRow({ id: "s0" }), sessionRow({ id: "s1" })];
    const { service, raw } = fakeRepo({
      listSessions: vi.fn(async () => rows),
      countMessagesBySession: vi.fn(async () => new Map([["s0", 24]])),
      countAnswersBySession: vi.fn(async () => new Map([["s0", 11]])),
    });
    const page = await service.listChatSessions(WORKER, { limit: 20 });
    expect(raw.countMessagesBySession).toHaveBeenCalledTimes(1);
    expect(raw.countMessagesBySession).toHaveBeenCalledWith(["s0", "s1"]);
    expect(page.items[0]!.message_count).toBe(24);
    expect(page.items[0]!.answer_count).toBe(11);
    // A session with no rows reads as 0, not as undefined.
    expect(page.items[1]!.message_count).toBe(0);
  });

  it("surfaces the abandonment signal: the sweep's status AND how long it has been idle", async () => {
    const lastMessageAt = new Date(Date.now() - 3_600_000); // an hour ago
    const { service } = fakeRepo({
      listSessions: vi.fn(async () => [sessionRow({ status: "abandoned", lastMessageAt })]),
    });
    const item = (await service.listChatSessions(WORKER, { limit: 20 })).items[0]!;
    expect(item.status).toBe("abandoned");
    expect(item.abandoned).toBe(true);
    expect(item.idle_seconds).toBeGreaterThanOrEqual(3595);
    expect(item.idle_seconds).toBeLessThan(3700);
  });

  it("idle_seconds is NULL when the worker never spoke — not 0 measured from started_at", async () => {
    // A session opened and dropped before a single turn is the strongest abandonment signal
    // there is. Deriving 0 from `started_at` would make that worker look freshly active.
    const { service } = fakeRepo({
      listSessions: vi.fn(async () => [sessionRow({ lastMessageAt: null })]),
    });
    const item = (await service.listChatSessions(WORKER, { limit: 20 })).items[0]!;
    expect(item.idle_seconds).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Sessions: detail
// ---------------------------------------------------------------------------

const sessionDetailRow = (over: Partial<Record<string, unknown>> = {}) => ({
  ...sessionRow(),
  hasConversationState: true,
  askCounts: {} as Record<string, number>,
  answerStatuses: {} as Record<string, string>,
  ...over,
});

describe("chat-session detail", () => {
  it("404s for an unknown session", async () => {
    const { service } = fakeRepo();
    await expect(service.getChatSession(ADMIN, SESSION, CTX)).rejects.toBeInstanceOf(NotFoundException);
  });

  it("reports AI cost as NULL plus a caveat when nothing was recorded — never as ₹0", async () => {
    // `session_ai_cost_totals` accrues only from migration 0077, with no backfill. "We did not
    // measure it" and "it cost nothing" are different facts and must not render identically.
    const { service } = fakeRepo({
      findSession: vi.fn(async () => sessionDetailRow()),
      sessionAiCost: vi.fn(async () => null),
    });
    const detail = await service.getChatSession(ADMIN, SESSION, CTX);
    expect(detail.ai_cost).toBeNull();
    expect(detail.caveats).toContain("ai_cost_not_recorded");
  });

  it("passes a recorded cost through as a STRING, and raises no cost caveat", async () => {
    const cost = {
      total_cost_inr: "1.234500",
      call_count: 9,
      real_call_count: 7,
      first_recorded_at: CREATED,
      updated_at: CREATED,
    };
    const { service } = fakeRepo({
      findSession: vi.fn(async () => sessionDetailRow()),
      sessionAiCost: vi.fn(async () => cost),
    });
    const detail = await service.getChatSession(ADMIN, SESSION, CTX);
    // The column is numeric(16,6) precisely so a running sum does not drift; parsing to a
    // float at the last step would throw that away.
    expect(detail.ai_cost).toEqual(cost);
    expect(detail.caveats).not.toContain("ai_cost_not_recorded");
  });

  it("derives the stuck question from the session's OWN ask_counts and settled keys", async () => {
    const { service } = fakeRepo({
      findSession: vi.fn(async () =>
        sessionDetailRow({
          askCounts: { trade_years: 1, salary_expected: 1 },
          answerStatuses: { trade_years: "answered" },
        }),
      ),
      listSettledKeys: vi.fn(async () => ["trade_years"]),
      listPackItems: vi.fn(async () => [
        {
          questionKey: "trade_years",
          packId: "qp_welding",
          packVersion: 1,
          displayOrder: 0,
          maxAsks: 2,
          isMandatory: false,
          isCore: true,
        },
        {
          questionKey: "salary_expected",
          packId: "qp_welding",
          packVersion: 1,
          displayOrder: 1,
          maxAsks: 2,
          isMandatory: false,
          isCore: false,
        },
      ]),
    });
    const detail = await service.getChatSession(ADMIN, SESSION, CTX);
    expect(detail.stuck.outcome).toBe("resolved");
    expect(detail.stuck.stuck_question?.question_key).toBe("salary_expected");
    expect(detail.stuck.asked_count).toBe(2);
    expect(detail.stuck.settled_count).toBe(1);
  });

  it("raises `no_conversation_state` rather than guessing a question", async () => {
    const { service } = fakeRepo({
      findSession: vi.fn(async () => sessionDetailRow({ hasConversationState: false })),
    });
    const detail = await service.getChatSession(ADMIN, SESSION, CTX);
    expect(detail.stuck.outcome).toBe("no_conversation_state");
    expect(detail.stuck.stuck_question).toBeNull();
    expect(detail.caveats).toContain("no_conversation_state");
  });

  it("folds the session's OWN pin into the pack versions it loads items for", async () => {
    // A session abandoned before a single answer or clip has no stamped pairs at all — its
    // pin is then the only record of which interview it was running.
    const { service, raw } = fakeRepo({
      findSession: vi.fn(async () => sessionDetailRow({ packId: "qp_welding", packVersion: 4 })),
      sessionPackVersions: vi.fn(async () => []),
    });
    await service.getChatSession(ADMIN, SESSION, CTX);
    expect(raw.listPackItems).toHaveBeenCalledWith([{ packId: "qp_welding", packVersion: 4 }]);
  });

  it("does not duplicate the pin when the answers already stamp it", async () => {
    const { service, raw } = fakeRepo({
      findSession: vi.fn(async () => sessionDetailRow({ packId: "qp_welding", packVersion: 1 })),
      sessionPackVersions: vi.fn(async () => [
        { packId: "qp_welding", packVersion: 1 },
        { packId: "qp_universal", packVersion: 3 },
      ]),
    });
    await service.getChatSession(ADMIN, SESSION, CTX);
    expect(raw.listPackItems).toHaveBeenCalledWith([
      { packId: "qp_welding", packVersion: 1 },
      { packId: "qp_universal", packVersion: 3 },
    ]);
  });
});

// ---------------------------------------------------------------------------
// The universal tail — never pinned, so it has to be resolved.
// ---------------------------------------------------------------------------

describe("the UNIVERSAL pack is resolved for the detail read (it is never pinned)", () => {
  /**
   * ⚠ THE POPULATION THIS EXISTS FOR. `chat_sessions.pack_id` is the OCCUPATION pin only. In a
   * text-mode session that died in the universal block with nothing universal settled and no
   * voice clip recorded, the session stamps NO universal pair — so every universal key in
   * `ask_counts` resolved to no item, and the ranking was blind on exactly the questions it
   * most needed to judge.
   */
  it("appends the ACTIVE universal pack to the pairs it loads items for", async () => {
    const { service, raw } = fakeRepo({
      findSession: vi.fn(async () => sessionDetailRow({ packId: "qp_welding", packVersion: 1 })),
      sessionPackVersions: vi.fn(async () => [{ packId: "qp_welding", packVersion: 1 }]),
      findActiveUniversalPack: vi.fn(async () => ({ packId: "qp_universal", packVersion: 7 })),
    });
    await service.getChatSession(ADMIN, SESSION, CTX);
    expect(raw.findActiveUniversalPack).toHaveBeenCalledWith("hi-IN");
    // LAST, deliberately: `deriveStuckQuestion` takes the first item it sees for a key, so a
    // pair the session actually stamped must never be displaced by today's active version.
    expect(raw.listPackItems).toHaveBeenCalledWith([
      { packId: "qp_welding", packVersion: 1 },
      { packId: "qp_universal", packVersion: 7 },
    ]);
  });

  it("does not duplicate it when the session already stamped that exact version", async () => {
    const { service, raw } = fakeRepo({
      findSession: vi.fn(async () => sessionDetailRow({ packId: null, packVersion: null })),
      sessionPackVersions: vi.fn(async () => [{ packId: "qp_universal", packVersion: 7 }]),
      findActiveUniversalPack: vi.fn(async () => ({ packId: "qp_universal", packVersion: 7 })),
    });
    await service.getChatSession(ADMIN, SESSION, CTX);
    expect(raw.listPackItems).toHaveBeenCalledWith([{ packId: "qp_universal", packVersion: 7 }]);
  });

  it("survives there being no active universal pack at all (no crash, just fewer items)", async () => {
    const { service, raw } = fakeRepo({
      findSession: vi.fn(async () => sessionDetailRow({ packId: "qp_welding", packVersion: 1 })),
      sessionPackVersions: vi.fn(async () => []),
      findActiveUniversalPack: vi.fn(async () => null),
    });
    await service.getChatSession(ADMIN, SESSION, CTX);
    expect(raw.listPackItems).toHaveBeenCalledWith([{ packId: "qp_welding", packVersion: 1 }]);
  });

  it("raises `stuck_items_unresolved` when a key still resolves to no item", async () => {
    // Honest reporting rather than a confident ranking: an unresolvable key is judged on
    // neither servability nor engine position, and an operator must be able to see that.
    const { service } = fakeRepo({
      findSession: vi.fn(async () =>
        sessionDetailRow({ askCounts: { orphan_key: 1, known_key: 1 } }),
      ),
      listPackItems: vi.fn(async () => [
        {
          questionKey: "known_key",
          packId: "qp_welding",
          packVersion: 1,
          displayOrder: 0,
          maxAsks: 2,
          isMandatory: true,
          isCore: true,
        },
      ]),
    });
    const detail = await service.getChatSession(ADMIN, SESSION, CTX);
    expect(detail.stuck.unresolved_count).toBe(1);
    expect(detail.caveats).toContain("stuck_items_unresolved");
  });

  it("raises NO such caveat when every key resolved", async () => {
    const { service } = fakeRepo({
      findSession: vi.fn(async () => sessionDetailRow({ askCounts: { known_key: 1 } })),
      listPackItems: vi.fn(async () => [
        {
          questionKey: "known_key",
          packId: "qp_welding",
          packVersion: 1,
          displayOrder: 0,
          maxAsks: 2,
          isMandatory: true,
          isCore: true,
        },
      ]),
    });
    const detail = await service.getChatSession(ADMIN, SESSION, CTX);
    expect(detail.stuck.unresolved_count).toBe(0);
    expect(detail.caveats).not.toContain("stuck_items_unresolved");
  });
});

// ---------------------------------------------------------------------------
// The audit event — a read that leaves a trail.
// ---------------------------------------------------------------------------

describe("`admin.worker_journey_viewed` — every per-worker read is audited", () => {
  it("the summary read emits it with the SESSION admin as actor and the worker as subject", async () => {
    const { service, emit } = fakeRepo();
    await service.getJourneySummary(ADMIN, WORKER, CTX);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit.mock.calls[0]![0]).toEqual({
      event_name: "admin.worker_journey_viewed",
      actor: { actor_type: "admin", actor_id: ADMIN },
      subject: { subject_type: "worker", subject_id: WORKER },
      payload: {
        admin_id: ADMIN,
        subject_id: WORKER,
        view: "journey_summary",
        chat_session_id: null,
      },
      correlationId: "corr-1",
      requestId: "req-1",
    });
  });

  it("the session read emits it with the worker read OFF THE SESSION ROW, not the path", async () => {
    // The path carries a SESSION id. If the subject were derived from anything the caller
    // supplies, the trail could be pointed at a worker the caller names.
    const otherWorker = "44444444-4444-4444-8444-444444444444";
    const { service, emit } = fakeRepo({
      findSession: vi.fn(async () => sessionDetailRow({ workerId: otherWorker })),
    });
    await service.getChatSession(ADMIN, SESSION, CTX);
    expect(emit).toHaveBeenCalledTimes(1);
    const params = emit.mock.calls[0]![0];
    expect(params.subject).toEqual({ subject_type: "worker", subject_id: otherWorker });
    expect(params.payload).toEqual({
      admin_id: ADMIN,
      subject_id: otherWorker,
      view: "chat_session",
      chat_session_id: SESSION,
    });
  });

  it("carries NO question key, status, count or free text — ids and one enum only", async () => {
    // WHICH question a worker stalled on is a fact about that worker; it belongs in the
    // response to the authenticated admin, never on the append-only spine.
    const { service, emit } = fakeRepo({
      findSession: vi.fn(async () =>
        sessionDetailRow({
          askCounts: { salary_expected: 2 },
          answerStatuses: { salary_expected: "unanswered" },
        }),
      ),
    });
    await service.getChatSession(ADMIN, SESSION, CTX);
    const payload = emit.mock.calls[0]![0].payload as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual(
      ["admin_id", "chat_session_id", "subject_id", "view"].sort(),
    );
    expect(JSON.stringify(payload)).not.toContain("salary_expected");
  });

  it("is emitted AFTER the 404 check — an unknown id leaves no audit row", async () => {
    // Auditing an unknown id fills the spine with rows for entities that do not exist and
    // makes the audit stream itself an enumeration oracle.
    const unknownWorker = fakeRepo({ findWorkerCore: vi.fn(async () => undefined) });
    await expect(
      unknownWorker.service.getJourneySummary(ADMIN, WORKER, CTX),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(unknownWorker.emit).not.toHaveBeenCalled();

    const unknownSession = fakeRepo();
    await expect(
      unknownSession.service.getChatSession(ADMIN, SESSION, CTX),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(unknownSession.emit).not.toHaveBeenCalled();
  });

  it("is emitted BEFORE the read runs — a failing read still leaves the trail", async () => {
    const { service, emit } = fakeRepo({
      packAnswerStatusCounts: vi.fn(async () => {
        throw new Error("db down");
      }),
    });
    await expect(service.getJourneySummary(ADMIN, WORKER, CTX)).rejects.toThrow("db down");
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it("FAILS CLOSED: an emit failure means no data is returned", async () => {
    // A trail that is best-effort is not a control. This is the same discipline
    // AdminPiiRevealService applies to its audit-before-decrypt.
    const { raw } = fakeRepo();
    const events = {
      emit: vi.fn(async () => {
        throw new Error("spine unreachable");
      }),
    };
    const strict = new AdminWorkerJourneyService(
      raw as unknown as Repo,
      raw as unknown as AdminEventsRepository,
      events as unknown as EventsService,
      CONFIG,
    );
    await expect(strict.getJourneySummary(ADMIN, WORKER, CTX)).rejects.toThrow(
      "spine unreachable",
    );
    // ...and the read never ran.
    expect(raw.packAnswerStatusCounts).not.toHaveBeenCalled();
  });

  it("the session LIST is deliberately NOT audited (entity-detail data class)", async () => {
    const { service, emit } = fakeRepo({ listSessions: vi.fn(async () => []) });
    await service.listChatSessions(WORKER, { limit: 20 });
    expect(emit).not.toHaveBeenCalled();
  });
});
