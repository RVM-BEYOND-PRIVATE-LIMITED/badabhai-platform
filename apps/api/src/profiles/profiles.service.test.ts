import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import type { Queue } from "bullmq";
import {
  ProfilesService,
  EXTRACTION_ATTEMPT_CAP,
  EXTRACTION_IN_FLIGHT_WINDOW_MS,
  EXTRACTION_JOB_OPTS,
} from "./profiles.service";
import type { ProfilesRepository } from "./profiles.repository";
import type { AiJobsRepository } from "./ai-jobs.repository";
import type { WorkersRepository } from "../workers/workers.repository";
import type { ChatRepository } from "../chat/chat.repository";
import type { EventsService } from "../events/events.service";
import type {
  ProfileExtractionJobData,
  ReferralBonusJobData,
  ResumeGenerateJobData,
} from "../queue/queue.constants";
import type { RequestContext } from "../common/request-context";

const CTX = { correlationId: "c", requestId: "r" } as RequestContext;
const WORKER = "11111111-1111-4111-8111-111111111111";
const OTHER = "99999999-9999-4999-8999-999999999999";
const PROFILE = "33333333-3333-4333-8333-333333333333";
const SESSION = "44444444-4444-4444-8444-444444444444";
const SESSION_B = "55555555-5555-4555-8555-555555555555";

type FakeProfile = {
  canonicalTradeId: string | null;
  canonicalRoleId: string | null;
  skills: string[];
  machines: string[];
  experience: unknown;
  salaryExpectation: unknown;
  locationPreference: unknown;
  availability: unknown;
  richProfileDraft: unknown;
};

type FakeCandidate = { id: string; status: string; profile: FakeProfile | null };

/** An empty profile exactly as `DraftProfileSchema.parse({})` persists it (AI-down fallback). */
const EMPTY_PROFILE: FakeProfile = {
  canonicalTradeId: null,
  canonicalRoleId: null,
  skills: [],
  machines: [],
  experience: { total_years: null },
  salaryExpectation: { amount_min: null, amount_max: null },
  locationPreference: { preferred_cities: [] },
  availability: { status: "unknown" },
  // The fallback carries no `worker_profile_draft`, so the column is null.
  richProfileDraft: null,
};

/** A profile with real extracted content. */
const FILLED_PROFILE: FakeProfile = { ...EMPTY_PROFILE, skills: ["vmc_operation"] };

/**
 * A REAL extraction the gazetteer could not canonicalize (TD94). Identical to
 * EMPTY_PROFILE across every legacy column — the rich draft is the only signal
 * that the AI actually extracted something.
 *
 * `skills` is the real `WorkerProfileDraft` field (an earlier fixture said
 * `skill_labels`, which does not exist on the draft; it passed only while the
 * dedupe leg tested the draft's NULLNESS rather than its content — PR #438
 * review).
 */
const CONTENT_POOR_REAL_PROFILE: FakeProfile = {
  ...EMPTY_PROFILE,
  richProfileDraft: { skills: ["machine operation"] },
};

/**
 * The AI was reachable but the transcript carried nothing ("hmm"). The draft is
 * NON-NULL yet contentless — only the fields every draft has. This must NOT
 * dedupe, or one early extraction pins the session forever (PR #438 review).
 */
const CONTENTLESS_DRAFT_PROFILE: FakeProfile = {
  ...EMPTY_PROFILE,
  richProfileDraft: {
    role_family: "cnc_vmc",
    experience_level: "unknown",
    availability: "unknown",
    confidence_score: 0.3,
    missing_fields: ["primary_role", "current_city"],
    clarification_questions: ["Aap kaun si machine chalate hain?"],
  },
};

function setup() {
  const profiles = {
    findById: vi.fn(async () => undefined as Record<string, unknown> | undefined),
    confirm: vi.fn(async () => undefined),
  };
  const aiJobs = {
    create: vi.fn(async (_input: { jobType?: string; inputRef?: Record<string, unknown> }) => ({
      id: "job-1",
    })),
    markFailed: vi.fn(async () => undefined),
    findExtractionDedupeCandidate: vi.fn(
      async (_args: { sessionId: string; workerId: string; inFlightSince: Date }) =>
        undefined as FakeCandidate | undefined,
    ),
    findCorrectionRebuildJob: vi.fn(
      async (_args: { sessionId: string; workerId: string; answerSetHash: string }) =>
        undefined as { id: string; status: string } | undefined,
    ),
  };
  const workers = { findById: vi.fn(async () => undefined as Record<string, unknown> | undefined) };
  // Issue #435 — the session the caller named. Defaults to a session OWNED by WORKER,
  // so every pre-existing test keeps its old meaning; the ownership tests override it.
  const chat = {
    findSession: vi.fn(
      async (id: string) =>
        ({ id, workerId: WORKER }) as { id: string; workerId: string } | undefined,
    ),
    // #828 — the session `extract` falls back to when the body carries none. Defaults to
    // UNDEFINED ("this worker has never chatted"), which is the one case that still takes
    // the create-always path, so every pre-existing session-less test keeps its old
    // meaning verbatim. The #828 tests override it.
    findLatestSessionByWorker: vi.fn(
      async (_workerId: string) => undefined as { id: string; workerId: string } | undefined,
    ),
  };
  const events = {
    emit: vi.fn(async (p: { event_name: string; payload: Record<string, unknown> }) => p),
  };
  // The extraction attempt cap counts through BullMQ's OWN Redis connection (the house
  // rule: never open a second client), so the queue double has to carry one. An in-memory
  // counter keyed exactly like the real service keys it — a Map, not a stub returning a
  // fixed number, so a test can drive the cap by calling `extract` repeatedly rather than
  // by asserting on how many times INCRBY was invoked.
  const counters = new Map<string, number>();
  const redis = {
    incrby: vi.fn(async (key: string, by: number) => {
      const next = (counters.get(key) ?? 0) + by;
      counters.set(key, next);
      return next;
    }),
    expire: vi.fn(async () => 1),
  };
  const extractionQueue = {
    add: vi.fn(async () => undefined),
    // A PROMISE, matching BullMQ: every consumer in this codebase does `await queue.client`.
    client: Promise.resolve(redis),
  };
  const resumeGenerateQueue = { add: vi.fn(async () => undefined) };
  // §X.6 — leg 1 of the activation-bonus rule is enqueued on confirm.
  const referralBonusQueue = { add: vi.fn(async () => undefined) };
  const svc = new ProfilesService(
    profiles as unknown as ProfilesRepository,
    aiJobs as unknown as AiJobsRepository,
    workers as unknown as WorkersRepository,
    chat as unknown as ChatRepository,
    events as unknown as EventsService,
    extractionQueue as unknown as Queue<ProfileExtractionJobData>,
    resumeGenerateQueue as unknown as Queue<ResumeGenerateJobData>,
    referralBonusQueue as unknown as Queue<ReferralBonusJobData>,
  );
  return {
    svc,
    profiles,
    aiJobs,
    workers,
    chat,
    events,
    extractionQueue,
    resumeGenerateQueue,
    referralBonusQueue,
    redis,
    counters,
  };
}

describe("ProfilesService.extract", () => {
  it("issue #435: 404s when the session belongs to ANOTHER worker — nothing enqueued", async () => {
    // THE EXPLOIT. session_id arrives in the request BODY. Without an ownership check the
    // job is created as { worker_id: attacker, session_id: victim's }, and
    // ProfileExtractionProcessor.buildTranscript then reads the VICTIM's transcript and
    // extracts it into the ATTACKER's worker_profiles row — their trade, machines,
    // experience, salary and location. Both job and profile are attributable to the
    // attacker, so nothing downstream flags it.
    const { svc, aiJobs, chat, workers, extractionQueue, events } = setup();
    const VICTIM = "22222222-2222-4222-8222-222222222222";
    workers.findById.mockResolvedValue({ id: WORKER });
    chat.findSession.mockResolvedValue({ id: "sess-victim", workerId: VICTIM });

    await expect(
      svc.extract({ worker_id: WORKER, session_id: "sess-victim" }, CTX),
    ).rejects.toBeInstanceOf(NotFoundException);

    // No job, no queue work, no event — the request dies before any of it.
    expect(aiJobs.create).not.toHaveBeenCalled();
    expect(extractionQueue.add).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();
  });

  it("issue #435: a MISSING session and a NOT-OWNED session are byte-identical (no oracle)", async () => {
    // 404 not 403, matching ChatService.postMessage: a session id must never tell a
    // caller whether someone else's session exists.
    const { svc, chat, workers } = setup();
    workers.findById.mockResolvedValue({ id: WORKER });

    chat.findSession.mockResolvedValue(undefined);
    const missing = await svc
      .extract({ worker_id: WORKER, session_id: "sess-x" }, CTX)
      .catch((e: Error) => e);

    chat.findSession.mockResolvedValue({
      id: "sess-x",
      workerId: "33333333-3333-4333-8333-333333333333",
    });
    const notOwned = await svc
      .extract({ worker_id: WORKER, session_id: "sess-x" }, CTX)
      .catch((e: Error) => e);

    expect(missing).toBeInstanceOf(NotFoundException);
    expect(notOwned).toBeInstanceOf(NotFoundException);
    expect((notOwned as Error).message).toBe((missing as Error).message);
  });

  it("issue #435: the ownership check runs BEFORE the dedupe lookup", async () => {
    // Otherwise a foreign session id could still be probed through dedupe behaviour.
    const { svc, chat, aiJobs, workers } = setup();
    workers.findById.mockResolvedValue({ id: WORKER });
    chat.findSession.mockResolvedValue({
      id: "s",
      workerId: "44444444-4444-4444-8444-444444444444",
    });

    await expect(svc.extract({ worker_id: WORKER, session_id: "s" }, CTX)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(aiJobs.findExtractionDedupeCandidate).not.toHaveBeenCalled();
  });

  it("404s when the worker does not exist (nothing enqueued)", async () => {
    const { svc, aiJobs } = setup();
    await expect(svc.extract({ worker_id: WORKER, session_id: null }, CTX)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(aiJobs.create).not.toHaveBeenCalled();
  });

  it("enqueues + emits extraction_requested for a known worker", async () => {
    const { svc, workers, events, extractionQueue } = setup();
    workers.findById.mockResolvedValueOnce({ id: WORKER });
    const res = await svc.extract({ worker_id: WORKER, session_id: "sess" }, CTX);
    expect(res).toEqual({ ai_job_id: "job-1", status: "queued" });
    expect(extractionQueue.add).toHaveBeenCalledOnce();
    expect(events.emit.mock.calls[0]![0].event_name).toBe("profile.extraction_requested");
  });

  it("on enqueue failure marks the job failed, emits failed, throws 503", async () => {
    const { svc, workers, aiJobs, events, extractionQueue } = setup();
    workers.findById.mockResolvedValueOnce({ id: WORKER });
    extractionQueue.add.mockRejectedValueOnce(new Error("redis down"));
    await expect(svc.extract({ worker_id: WORKER, session_id: null }, CTX)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(aiJobs.markFailed).toHaveBeenCalledOnce();
    expect(events.emit.mock.calls.map((c) => c[0].event_name)).toContain(
      "profile.extraction_failed",
    );
  });
});

/**
 * Issue #420 — session-scoped idempotency. The server auto-trigger (ChatService,
 * on the extraction_ready flip) and the worker app's unconditional
 * POST /profile/extract both fire for the same interview; without a guard that is
 * 2 ai_jobs + 2x AI spend on every normal completion.
 *
 * The guard may only be tight in ONE direction. Suppressing a NEEDED extraction is
 * strictly worse than a duplicate one (the worker ends up with no profile at all),
 * so every "is this really redundant?" case below asserts we still create.
 */
describe("ProfilesService.extract — session-scoped idempotency (#420)", () => {
  const IN_FLIGHT = ["queued", "running"];

  type StoreRow = {
    id: string;
    jobType: string;
    sessionId: string | null;
    workerId: string | null;
    status: string;
    createdAt: number;
    profile: FakeProfile | null;
  };

  /**
   * setup() plus a stateful ai_jobs store whose lookup mirrors the REAL Drizzle
   * predicate in `findExtractionDedupeCandidate` leg for leg — job_type,
   * session_id, worker_id, the status/age disjunction, and newest-first ordering.
   * (The SQL itself is covered structurally in ai-jobs.repository.test.ts; this
   * fake exists so the service-level SEQUENCES run against the same semantics
   * rather than a restatement of the outcome we hope for.)
   *
   * `clock` is the store's own notion of now, so a job can be aged past the
   * in-flight window without touching Date.now().
   */
  function setupWithStore() {
    const h = setup();
    h.workers.findById.mockResolvedValue({ id: WORKER });

    const store: StoreRow[] = [];
    let seq = 0;
    let clock = 1_000_000;
    h.aiJobs.create.mockImplementation(async (input) => {
      const inputRef = input.inputRef ?? {};
      const row: StoreRow = {
        id: `job-${++seq}`,
        jobType: String(input.jobType ?? ""),
        sessionId: (inputRef["session_id"] as string | null) ?? null,
        workerId: (inputRef["worker_id"] as string | null) ?? null,
        status: "queued",
        createdAt: (clock += 1000),
        profile: null,
      };
      store.push(row);
      return { id: row.id };
    });
    h.aiJobs.findExtractionDedupeCandidate.mockImplementation(async (args) => {
      // The service passes an absolute floor; translate it to the store's clock.
      const windowMs = Date.now() - args.inFlightSince.getTime();
      const match = store
        .filter(
          (r) =>
            r.jobType === "profile_extraction" &&
            r.sessionId === args.sessionId &&
            r.workerId === args.workerId &&
            ((IN_FLIGHT.includes(r.status) && clock - r.createdAt < windowMs) ||
              r.status === "completed"),
        )
        .sort((a, b) => b.createdAt - a.createdAt)[0];
      return match ? { id: match.id, status: match.status, profile: match.profile } : undefined;
    });

    /** Simulate the processor finishing a job with the given profile. */
    const complete = (id: string, profile: FakeProfile) => {
      const row = store.find((r) => r.id === id)!;
      row.status = "completed";
      row.profile = profile;
    };
    /** Age every stored job by `ms` (advances the store clock only). */
    const age = (ms: number) => {
      clock += ms;
    };
    return { ...h, store, complete, age };
  }

  const requestedEvents = (events: ReturnType<typeof setup>["events"]) =>
    events.emit.mock.calls.filter((c) => c[0].event_name === "profile.extraction_requested");

  // --- the core #420 case --------------------------------------------------

  it("returns the SAME ai_job_id for a second extract while a job is queued — no second job, no enqueue, no second requested event", async () => {
    const { svc, aiJobs, events, extractionQueue, workers } = setup();
    workers.findById.mockResolvedValueOnce({ id: WORKER });
    aiJobs.findExtractionDedupeCandidate.mockResolvedValueOnce({
      id: "job-existing",
      status: "queued",
      profile: null,
    });

    const res = await svc.extract({ worker_id: WORKER, session_id: SESSION }, CTX);

    expect(res).toEqual({ ai_job_id: "job-existing", status: "queued" });
    expect(aiJobs.create).not.toHaveBeenCalled();
    expect(extractionQueue.add).not.toHaveBeenCalled();
    expect(requestedEvents(events)).toHaveLength(0);
  });

  it("dedupes against a RUNNING job too (in-flight, not just freshly queued)", async () => {
    const { svc, aiJobs, extractionQueue, workers } = setup();
    workers.findById.mockResolvedValueOnce({ id: WORKER });
    aiJobs.findExtractionDedupeCandidate.mockResolvedValueOnce({
      id: "job-running",
      status: "running",
      profile: null,
    });

    const res = await svc.extract({ worker_id: WORKER, session_id: SESSION }, CTX);

    expect(res).toEqual({ ai_job_id: "job-running", status: "running" });
    expect(extractionQueue.add).not.toHaveBeenCalled();
  });

  it("the real #420 scenario: server auto-trigger THEN the client's POST /profile/extract yields exactly ONE ai_job and ONE enqueue", async () => {
    const { svc, aiJobs, events, extractionQueue } = setupWithStore();

    // 1. ChatService.autoTriggerExtraction on the extraction_ready flip.
    const auto = await svc.extract({ worker_id: WORKER, session_id: SESSION }, CTX);
    // 2. Worker taps "Done"; ProfileCubit.extract() fires unconditionally.
    const client = await svc.extract({ worker_id: WORKER, session_id: SESSION }, CTX);

    expect(client.ai_job_id).toBe(auto.ai_job_id);
    expect(aiJobs.create).toHaveBeenCalledOnce();
    expect(extractionQueue.add).toHaveBeenCalledOnce();
    expect(requestedEvents(events)).toHaveLength(1);
  });

  it("dedupes against a COMPLETED job that produced a USABLE profile (the fast-completion case)", async () => {
    const { svc, aiJobs, extractionQueue, complete } = setupWithStore();

    const first = await svc.extract({ worker_id: WORKER, session_id: SESSION }, CTX);
    complete(first.ai_job_id, FILLED_PROFILE);
    const second = await svc.extract({ worker_id: WORKER, session_id: SESSION }, CTX);

    expect(second).toEqual({ ai_job_id: first.ai_job_id, status: "completed" });
    expect(aiJobs.create).toHaveBeenCalledOnce();
    expect(extractionQueue.add).toHaveBeenCalledOnce();
  });

  it("dedupes against a COMPLETED job whose extraction canonicalized NOTHING but carries a rich draft (TD94)", async () => {
    const { svc, aiJobs, extractionQueue, complete } = setupWithStore();

    // The unbounded-spend loop this closes: without the rich-draft leg this
    // profile is indistinguishable from the AI-down fallback, so the session
    // never becomes dedupe-eligible and EVERY profile-preview mount burns a
    // fresh ai_job + worker_profiles row + AI call, indefinitely.
    const first = await svc.extract({ worker_id: WORKER, session_id: SESSION }, CTX);
    complete(first.ai_job_id, CONTENT_POOR_REAL_PROFILE);

    const second = await svc.extract({ worker_id: WORKER, session_id: SESSION }, CTX);
    const third = await svc.extract({ worker_id: WORKER, session_id: SESSION }, CTX);

    expect(second).toEqual({ ai_job_id: first.ai_job_id, status: "completed" });
    expect(third).toEqual({ ai_job_id: first.ai_job_id, status: "completed" });
    expect(aiJobs.create).toHaveBeenCalledOnce();
    expect(extractionQueue.add).toHaveBeenCalledOnce();
  });

  it("does NOT dedupe against a COMPLETED job whose rich draft is non-null but CONTENTLESS", async () => {
    const { svc, aiJobs, complete } = setupWithStore();

    // The #438 regression this closes: `/profile/extract` returns a draft
    // unconditionally, so an extraction on a near-empty session completes with a
    // NON-NULL but empty draft. Treating that as content pinned the session
    // forever — the worker could finish the whole interview and every later
    // extract would dedupe to this empty job. It must stay retryable.
    const first = await svc.extract({ worker_id: WORKER, session_id: SESSION }, CTX);
    complete(first.ai_job_id, CONTENTLESS_DRAFT_PROFILE);

    const second = await svc.extract({ worker_id: WORKER, session_id: SESSION }, CTX);

    expect(second.ai_job_id).not.toBe(first.ai_job_id);
    expect(second.status).toBe("queued");
    expect(aiJobs.create).toHaveBeenCalledTimes(2);
  });

  // --- must NOT suppress a needed extraction --------------------------------

  it("a COMPLETED job holding an EMPTY profile (AI-down fallback) does NOT dedupe — the session self-heals", async () => {
    const { svc, aiJobs, events, extractionQueue, complete } = setupWithStore();

    // AI service unreachable: AiService.extractProfile returns
    // DraftProfileSchema.parse({}) with blocked=false, so the processor persists
    // an EMPTY profile as "extracted" and marks the job completed. Deduping
    // against that would pin the session to an empty profile forever.
    const first = await svc.extract({ worker_id: WORKER, session_id: SESSION }, CTX);
    complete(first.ai_job_id, EMPTY_PROFILE);

    const retry = await svc.extract({ worker_id: WORKER, session_id: SESSION }, CTX);

    expect(retry.ai_job_id).not.toBe(first.ai_job_id);
    expect(aiJobs.create).toHaveBeenCalledTimes(2);
    expect(extractionQueue.add).toHaveBeenCalledTimes(2);
    expect(requestedEvents(events)).toHaveLength(2);
  });

  it("a COMPLETED job with NO profile row at all does NOT dedupe", async () => {
    const { svc, aiJobs, extractionQueue, workers } = setup();
    workers.findById.mockResolvedValueOnce({ id: WORKER });
    aiJobs.findExtractionDedupeCandidate.mockResolvedValueOnce({
      id: "job-completed-orphan",
      status: "completed",
      profile: null,
    });

    const res = await svc.extract({ worker_id: WORKER, session_id: SESSION }, CTX);

    expect(res.ai_job_id).not.toBe("job-completed-orphan");
    expect(aiJobs.create).toHaveBeenCalledOnce();
    expect(extractionQueue.add).toHaveBeenCalledOnce();
  });

  it("a STALE queued job (older than the in-flight window) does NOT dedupe — a zombie never wedges the session", async () => {
    const { svc, aiJobs, extractionQueue, age } = setupWithStore();

    // Crash between the `queued` INSERT and extractionQueue.add: never enqueued,
    // so no BullMQ retry and no processor to fail it. Nothing reaps it.
    const zombie = await svc.extract({ worker_id: WORKER, session_id: SESSION }, CTX);
    age(EXTRACTION_IN_FLIGHT_WINDOW_MS + 60_000);

    const retry = await svc.extract({ worker_id: WORKER, session_id: SESSION }, CTX);

    expect(retry.ai_job_id).not.toBe(zombie.ai_job_id);
    expect(aiJobs.create).toHaveBeenCalledTimes(2);
    expect(extractionQueue.add).toHaveBeenCalledTimes(2);
  });

  it("a job still INSIDE the in-flight window does dedupe (the bound is not so tight it defeats the guard)", async () => {
    const { svc, aiJobs, age } = setupWithStore();

    const first = await svc.extract({ worker_id: WORKER, session_id: SESSION }, CTX);
    age(EXTRACTION_IN_FLIGHT_WINDOW_MS / 2);

    const second = await svc.extract({ worker_id: WORKER, session_id: SESSION }, CTX);

    expect(second.ai_job_id).toBe(first.ai_job_id);
    expect(aiJobs.create).toHaveBeenCalledOnce();
  });

  it("a FAILED prior job does not wedge the session — a retry still creates and enqueues", async () => {
    const { svc, aiJobs, events, extractionQueue, store } = setupWithStore();

    const first = await svc.extract({ worker_id: WORKER, session_id: SESSION }, CTX);
    store[0]!.status = "failed"; // extraction failed (processor or enqueue)

    const retry = await svc.extract({ worker_id: WORKER, session_id: SESSION }, CTX);

    expect(retry.ai_job_id).not.toBe(first.ai_job_id);
    expect(aiJobs.create).toHaveBeenCalledTimes(2);
    expect(extractionQueue.add).toHaveBeenCalledTimes(2);
    expect(requestedEvents(events)).toHaveLength(2);
  });

  it("does NOT over-dedupe: a different session still creates its own job", async () => {
    const { svc, aiJobs, events, extractionQueue } = setupWithStore();

    const first = await svc.extract({ worker_id: WORKER, session_id: SESSION }, CTX);
    const second = await svc.extract({ worker_id: WORKER, session_id: SESSION_B }, CTX);

    expect(second.ai_job_id).not.toBe(first.ai_job_id);
    expect(aiJobs.create).toHaveBeenCalledTimes(2);
    expect(extractionQueue.add).toHaveBeenCalledTimes(2);
    expect(requestedEvents(events)).toHaveLength(2);
  });

  // --- scoping / bounds handed to the repository ----------------------------

  it("another worker cannot touch the owner's session at all, and the owner still extracts", async () => {
    // WAS: "another worker's job on the SAME session never dedupes the owner". That
    // version had the attacker's call SUCCEED and only checked the owner still got a
    // distinct job — it took the #435 hole as its premise ("the controller takes
    // session_id straight from the body"). With ownership enforced the attacker never
    // gets a job at all, so the denial it guarded against cannot even begin.
    //
    // Both properties are kept, and the first is now stronger:
    //   1. the foreign call is REFUSED (was: allowed, but scoped);
    //   2. the owner is still not denied — the #430 worker_id predicate on the dedupe
    //      lookup, which is what this test was really protecting.
    const { svc, aiJobs, extractionQueue, chat } = setupWithStore();
    chat.findSession.mockResolvedValue({ id: SESSION, workerId: WORKER });

    await expect(
      svc.extract({ worker_id: OTHER, session_id: SESSION }, CTX),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(aiJobs.create).not.toHaveBeenCalled();

    const owner = await svc.extract({ worker_id: WORKER, session_id: SESSION }, CTX);
    expect(owner.ai_job_id).toBeDefined();
    expect(aiJobs.create).toHaveBeenCalledTimes(1);
    expect(extractionQueue.add).toHaveBeenCalledTimes(1);
  });

  it("passes the authenticated worker_id and a ~10min in-flight floor to the lookup", async () => {
    const { svc, aiJobs, workers } = setup();
    workers.findById.mockResolvedValueOnce({ id: WORKER });
    const before = Date.now();

    await svc.extract({ worker_id: WORKER, session_id: SESSION }, CTX);

    // FLAKY AS WRITTEN, fixed by bracketing instead of a one-sided floor. The
    // service computes `inFlightSince = Date.now() - WINDOW` at some instant
    // `serviceNow` strictly between `before` (captured above, before the await)
    // and `after` (captured below, once it resolves) — so `inFlightSince` is
    // ALWAYS `<= before - WINDOW` is false; it is bounded the other way:
    // `before - WINDOW <= inFlightSince <= after - WINDOW`. The original
    // one-sided `age = before - inFlightSince >= WINDOW` assertion only holds
    // when `serviceNow === before` exactly — any real elapsed time (a single ms
    // is enough, and it fired: "599999 to be >= 600000") fails it. Bracketing
    // both ends is the actual invariant and cannot race the clock.
    const after = Date.now();
    const args = aiJobs.findExtractionDedupeCandidate.mock.calls[0]![0];
    expect(args.sessionId).toBe(SESSION);
    expect(args.workerId).toBe(WORKER);
    const inFlightSince = args.inFlightSince.getTime();
    expect(inFlightSince).toBeGreaterThanOrEqual(before - EXTRACTION_IN_FLIGHT_WINDOW_MS);
    expect(inFlightSince).toBeLessThanOrEqual(after - EXTRACTION_IN_FLIGHT_WINDOW_MS);
  });

  it("null session_id falls through to create-always and is never looked up (no null-against-null dedupe)", async () => {
    const { svc, aiJobs, extractionQueue } = setupWithStore();

    const first = await svc.extract({ worker_id: WORKER, session_id: null }, CTX);
    const second = await svc.extract({ worker_id: WORKER, session_id: null }, CTX);

    expect(aiJobs.findExtractionDedupeCandidate).not.toHaveBeenCalled();
    expect(second.ai_job_id).not.toBe(first.ai_job_id);
    expect(aiJobs.create).toHaveBeenCalledTimes(2);
    expect(extractionQueue.add).toHaveBeenCalledTimes(2);
  });

  it("still 404s an unknown worker before consulting the dedupe lookup", async () => {
    const { svc, aiJobs } = setup();
    await expect(
      svc.extract({ worker_id: WORKER, session_id: SESSION }, CTX),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(aiJobs.findExtractionDedupeCandidate).not.toHaveBeenCalled();
  });

  // --- #828: a body with no session must not mean a session-LESS extraction ----
  //
  // THE PRODUCTION BUG THESE LOCK. The chat reply that flushes the transcript does two
  // things at once: it enqueues the real extraction (`autoTriggerExtraction`) and it
  // tells the app `session_ended: true`, which the app answers by calling
  // `clearChatSession()`. The profile-preview screen then fires `POST /profile/extract`
  // with the session id already gone. That reached
  // `ProfileExtractionProcessor.buildMessages`, whose first line is
  // `if (!sessionId) return []` — so the app's own job extracted "(no conversation
  // captured)" and wrote a fully-null profile NEWER than the real one. Because the app
  // polls its OWN job and confirms the id it reports, the empty profile is what the
  // résumé was rendered from: a blank PDF for a worker who had just said "Welder".

  it("resolves the worker's latest chat session when the body carries none, and DEDUPES against the auto-trigger's job", async () => {
    // The exact production sequence, in order.
    const { svc, aiJobs, chat, extractionQueue, events } = setupWithStore();
    chat.findLatestSessionByWorker.mockResolvedValue({ id: SESSION, workerId: WORKER });

    // 1. the transcript flush → ChatService.autoTriggerExtraction (session known).
    const auto = await svc.extract({ worker_id: WORKER, session_id: SESSION }, CTX);
    // 2. the app cleared its session id on `session_ended`, then hit the preview screen.
    const client = await svc.extract({ worker_id: WORKER, session_id: null }, CTX);

    // ONE job. The app polls the job that is actually reading the interview.
    expect(client.ai_job_id).toBe(auto.ai_job_id);
    expect(aiJobs.create).toHaveBeenCalledOnce();
    expect(extractionQueue.add).toHaveBeenCalledOnce();
    expect(requestedEvents(events)).toHaveLength(1);
  });

  it("NEVER enqueues a job whose sessionId is null once the worker has a session — that job cannot extract anything", async () => {
    // The structural claim, asserted directly on the queue payload rather than through
    // the dedupe: `buildMessages` returns [] for a null session, so such a job is
    // guaranteed to persist an empty profile. It must not be creatable.
    const { svc, chat, aiJobs, extractionQueue } = setupWithStore();
    chat.findLatestSessionByWorker.mockResolvedValue({ id: SESSION, workerId: WORKER });

    await svc.extract({ worker_id: WORKER, session_id: null }, CTX);

    expect(extractionQueue.add).toHaveBeenCalledWith(
      "extract",
      expect.objectContaining({ workerId: WORKER, sessionId: SESSION }),
      expect.anything(),
    );
    // The audit trail names the session the job will actually read, not the body's null.
    expect(aiJobs.create).toHaveBeenCalledWith(
      expect.objectContaining({ inputRef: { worker_id: WORKER, session_id: SESSION } }),
    );
  });

  it("the resolved session reaches the extraction_requested event too", async () => {
    const { svc, chat, events } = setupWithStore();
    chat.findLatestSessionByWorker.mockResolvedValue({ id: SESSION, workerId: WORKER });

    await svc.extract({ worker_id: WORKER, session_id: null }, CTX);

    expect(requestedEvents(events)[0]?.[0].payload).toMatchObject({ session_id: SESSION });
  });

  it("a body-supplied session still WINS over the worker's latest — the fallback is a fallback", async () => {
    // A caller naming SESSION_B must be extracting SESSION_B, even if the worker has
    // since chatted elsewhere. Resolution must never override an explicit id.
    const { svc, chat, extractionQueue } = setupWithStore();
    chat.findSession.mockResolvedValueOnce({ id: SESSION_B, workerId: WORKER });
    chat.findLatestSessionByWorker.mockResolvedValue({ id: SESSION, workerId: WORKER });

    await svc.extract({ worker_id: WORKER, session_id: SESSION_B }, CTX);

    expect(chat.findLatestSessionByWorker).not.toHaveBeenCalled();
    expect(extractionQueue.add).toHaveBeenCalledWith(
      "extract",
      expect.objectContaining({ sessionId: SESSION_B }),
      expect.anything(),
    );
  });

  it("the resolved session is NEVER ownership-checked against the body — it cannot name another worker's session", async () => {
    // `findLatestSessionByWorker` is queried BY the worker id, so ownership is a property
    // of the query. Re-checking would be a wasted round trip; more importantly, a caller
    // has no way to influence which session comes back, so there is nothing to check.
    const { svc, chat } = setupWithStore();
    chat.findLatestSessionByWorker.mockResolvedValue({ id: SESSION, workerId: WORKER });

    await svc.extract({ worker_id: WORKER, session_id: null }, CTX);

    expect(chat.findLatestSessionByWorker).toHaveBeenCalledWith(WORKER);
    expect(chat.findSession).not.toHaveBeenCalled();
  });

  it("a worker who has NEVER chatted still takes the create-always path (voice-form route untouched)", async () => {
    // The one case that legitimately has no session. `findLatestSessionByWorker` is the
    // default `undefined` here, i.e. exactly the pre-#828 behaviour.
    const { svc, aiJobs, extractionQueue } = setupWithStore();

    const first = await svc.extract({ worker_id: WORKER, session_id: null }, CTX);
    const second = await svc.extract({ worker_id: WORKER, session_id: null }, CTX);

    expect(aiJobs.findExtractionDedupeCandidate).not.toHaveBeenCalled();
    expect(second.ai_job_id).not.toBe(first.ai_job_id);
    expect(extractionQueue.add).toHaveBeenCalledTimes(2);
    expect(extractionQueue.add).toHaveBeenLastCalledWith(
      "extract",
      expect.objectContaining({ sessionId: null }),
      expect.anything(),
    );
  });

  it("the self-heal survives: a resolved session whose only job produced NOTHING still re-runs", async () => {
    // The direction this must not break. #420's dedupe is deliberately one-way — an empty
    // profile never pins a session — and routing the app's call through resolution must
    // not turn a placeholder into a permanent answer.
    const { svc, chat, aiJobs, complete } = setupWithStore();
    chat.findLatestSessionByWorker.mockResolvedValue({ id: SESSION, workerId: WORKER });

    const auto = await svc.extract({ worker_id: WORKER, session_id: SESSION }, CTX);
    complete(auto.ai_job_id, EMPTY_PROFILE);
    const client = await svc.extract({ worker_id: WORKER, session_id: null }, CTX);

    expect(client.ai_job_id).not.toBe(auto.ai_job_id);
    expect(aiJobs.create).toHaveBeenCalledTimes(2);
  });
});

describe("ProfilesService.confirm — ownership (IDOR) + event", () => {
  it("404s when the profile does not exist", async () => {
    const { svc } = setup();
    await expect(
      svc.confirm({ worker_id: WORKER, profile_id: PROFILE }, CTX),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("404s when the profile belongs to ANOTHER worker (no oracle), confirming nothing", async () => {
    const { svc, profiles, events } = setup();
    profiles.findById.mockResolvedValueOnce({ id: PROFILE, workerId: OTHER });
    await expect(
      svc.confirm({ worker_id: WORKER, profile_id: PROFILE }, CTX),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(profiles.confirm).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();
  });

  it("confirms the OWNER's profile, emits profile.confirmed, enqueues resume generation", async () => {
    const { svc, profiles, events, resumeGenerateQueue } = setup();
    profiles.findById.mockResolvedValueOnce({ id: PROFILE, workerId: WORKER });
    const res = await svc.confirm({ worker_id: WORKER, profile_id: PROFILE }, CTX);
    expect(res.profile_status).toBe("confirmed");
    expect(profiles.confirm).toHaveBeenCalledOnce();
    expect(events.emit.mock.calls[0]![0].event_name).toBe("profile.confirmed");
    expect(resumeGenerateQueue.add).toHaveBeenCalledOnce();
  });

  it("a resume-enqueue failure does NOT fail confirmation (degrades)", async () => {
    const { svc, profiles, resumeGenerateQueue } = setup();
    profiles.findById.mockResolvedValueOnce({ id: PROFILE, workerId: WORKER });
    resumeGenerateQueue.add.mockRejectedValueOnce(new Error("redis down"));
    const res = await svc.confirm({ worker_id: WORKER, profile_id: PROFILE }, CTX);
    expect(res.profile_status).toBe("confirmed"); // confirmation still succeeds
  });

  // ---- §X.6: confirm is LEG 1 of the ₹20 activation-bonus rule ----

  it("enqueues a referral-bonus evaluation with the worker id + trigger (no PII)", async () => {
    const { svc, profiles, referralBonusQueue } = setup();
    profiles.findById.mockResolvedValueOnce({ id: PROFILE, workerId: WORKER });
    await svc.confirm({ worker_id: WORKER, profile_id: PROFILE }, CTX);
    expect(referralBonusQueue.add).toHaveBeenCalledWith("evaluate", {
      invitedWorkerId: WORKER,
      trigger: "profile_confirmed",
    });
  });

  it("does NOT enqueue when confirmation is refused (not the owner)", async () => {
    const { svc, profiles, referralBonusQueue } = setup();
    profiles.findById.mockResolvedValueOnce({ id: PROFILE, workerId: OTHER });
    await expect(
      svc.confirm({ worker_id: WORKER, profile_id: PROFILE }, CTX),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(referralBonusQueue.add).not.toHaveBeenCalled();
  });

  it("a bonus-enqueue failure does NOT fail confirmation (a missed accrual is recoverable)", async () => {
    const { svc, profiles, referralBonusQueue } = setup();
    profiles.findById.mockResolvedValueOnce({ id: PROFILE, workerId: WORKER });
    referralBonusQueue.add.mockRejectedValueOnce(new Error("redis down"));
    const res = await svc.confirm({ worker_id: WORKER, profile_id: PROFILE }, CTX);
    expect(res.profile_status).toBe("confirmed");
  });
});

/**
 * THE FOURTH TRIGGER (#700, owner ruling 2026-08-08).
 *
 * The other three fire on "this session finished" and guard each other with session-scoped dedupe.
 * That guarding is what closed #420, where two triggers fired on UNCHANGED data and double-spent.
 * This one has to fire precisely because the data is no longer what was built — so it is keyed on
 * the data, and these tests exist to prove the two can never be confused for one another.
 */
describe("rebuildAfterCorrection — the correction-specific trigger", () => {
  const input = {
    worker_id: WORKER,
    session_id: SESSION,
    answer_set_hash: "a".repeat(64),
  };

  it("queues an extraction carrying the answer-set hash and the trigger", async () => {
    const { svc, aiJobs, extractionQueue } = setup();

    const result = await svc.rebuildAfterCorrection(input, CTX);

    expect(aiJobs.create).toHaveBeenCalledWith(
      expect.objectContaining({
        jobType: "profile_extraction",
        status: "queued",
        inputRef: {
          worker_id: WORKER,
          session_id: SESSION,
          answer_set_hash: "a".repeat(64),
          trigger: "correction",
        },
      }),
    );
    expect(extractionQueue.add).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ ai_job_id: "job-1", status: "queued" });
  });

  it("does NOT consult the session-scoped dedupe — that guard's answer is always yes here", async () => {
    // `findExtractionDedupeCandidate` asks "has this session been extracted?". After a correction
    // it says yes, and that is the REASON to rebuild, not a reason to skip. Calling it would make
    // this trigger unable to ever fire.
    const { svc, aiJobs } = setup();

    await svc.rebuildAfterCorrection(input, CTX);

    expect(aiJobs.findExtractionDedupeCandidate).not.toHaveBeenCalled();
  });

  it("dedupes on the HASH, so the same answer set is never built twice", async () => {
    const { svc, aiJobs, extractionQueue } = setup();
    aiJobs.findCorrectionRebuildJob.mockResolvedValueOnce({ id: "job-prior", status: "completed" });

    const result = await svc.rebuildAfterCorrection(input, CTX);

    expect(aiJobs.create).not.toHaveBeenCalled();
    expect(extractionQueue.add).not.toHaveBeenCalled();
    expect(result).toEqual({ ai_job_id: "job-prior", status: "completed" });
  });

  it("a DIFFERENT answer set is a different key and does build", async () => {
    // The property that makes this structurally distinct from #420: that race was two triggers on
    // unchanged data. A changed answer set is not expressible in this key space as a re-fire.
    const { svc, aiJobs, extractionQueue } = setup();
    aiJobs.findCorrectionRebuildJob.mockImplementation(async (args) =>
      args.answerSetHash === "a".repeat(64) ? { id: "job-prior", status: "completed" } : undefined,
    );

    await svc.rebuildAfterCorrection({ ...input, answer_set_hash: "b".repeat(64) }, CTX);

    expect(aiJobs.create).toHaveBeenCalledTimes(1);
    expect(extractionQueue.add).toHaveBeenCalledTimes(1);
  });

  it("NEVER throws — the correction is already durable when this runs", async () => {
    // Failing the worker's HTTP call because a queue was unreachable would report a stored
    // correction as lost. Loud in the log, null to the caller.
    const { svc, extractionQueue } = setup();
    extractionQueue.add.mockRejectedValueOnce(new Error("redis is down"));

    await expect(svc.rebuildAfterCorrection(input, CTX)).resolves.toBeNull();
  });

  it("emits ONE extraction_requested, keyed on the job — the spine must not over-report spend", async () => {
    const { svc, events } = setup();

    await svc.rebuildAfterCorrection(input, CTX);

    const requested = events.emit.mock.calls
      .map((c) => c[0])
      .filter((e) => e.event_name === "profile.extraction_requested");
    expect(requested).toHaveLength(1);
    // The hash is a dedupe key, not an event field: it describes our internals, not the worker.
    expect(JSON.stringify(requested[0]?.payload)).not.toContain("a".repeat(64));
  });
});

// ---------------------------------------------------------------------------
// The extraction attempt cap — the guard that sees all four triggers
// ---------------------------------------------------------------------------
//
// Per-job `attempts` bounds ONE job. It cannot bound how many jobs get CREATED, and
// creation is where the storm lived: the transcript-flush auto-trigger, the app's
// unconditional POST /profile/extract on the preview screen, `rebuildAfterCorrection`,
// and the worker tapping "Try again" each mint their own. Every dedupe guard in front of
// them keys on "did this produce content", and during an LLM outage the answer is always
// no — so all four re-fired indefinitely.

describe("ProfilesService.extract — the hourly attempt cap", () => {
  it("refuses to mint an eighth job for one session in an hour", async () => {
    const { svc, workers, aiJobs, extractionQueue } = setup();
    workers.findById.mockResolvedValue({ id: WORKER });

    // Six succeed — the cap is deliberately generous, since a healthy interview needs ONE
    // and the documented posture is that an unprofiled worker beats a double spend.
    for (let i = 0; i < EXTRACTION_ATTEMPT_CAP; i++) {
      await svc.extract({ worker_id: WORKER, session_id: SESSION }, CTX);
    }
    expect(extractionQueue.add).toHaveBeenCalledTimes(EXTRACTION_ATTEMPT_CAP);

    await expect(
      svc.extract({ worker_id: WORKER, session_id: SESSION }, CTX),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);

    // Nothing partial: the refusal happens BEFORE the ai_job row and before the event, so
    // a capped request leaves no orphaned `queued` row for the zombie rule to find later.
    expect(extractionQueue.add).toHaveBeenCalledTimes(EXTRACTION_ATTEMPT_CAP);
    expect(aiJobs.create).toHaveBeenCalledTimes(EXTRACTION_ATTEMPT_CAP);
  });

  it("is scoped per SESSION — one worker's exhausted interview cannot block their next", async () => {
    const { svc, workers, extractionQueue } = setup();
    workers.findById.mockResolvedValue({ id: WORKER });

    for (let i = 0; i < EXTRACTION_ATTEMPT_CAP; i++) {
      await svc.extract({ worker_id: WORKER, session_id: SESSION }, CTX);
    }
    await expect(
      svc.extract({ worker_id: WORKER, session_id: SESSION }, CTX),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);

    // A genuinely new interview is a different key and starts fresh.
    await expect(
      svc.extract({ worker_id: WORKER, session_id: SESSION_B }, CTX),
    ).resolves.toMatchObject({ status: "queued" });
    expect(extractionQueue.add).toHaveBeenCalledTimes(EXTRACTION_ATTEMPT_CAP + 1);
  });

  it("does not charge a request that DEDUPED — only real work costs cap", async () => {
    // Ordering matters: the cap is checked after the dedupe guards, so the common healthy
    // double-trigger (server auto-trigger + the app's unconditional POST) spends nothing.
    const { svc, workers, aiJobs, redis } = setup();
    workers.findById.mockResolvedValue({ id: WORKER });
    aiJobs.findExtractionDedupeCandidate.mockResolvedValue({
      id: "prior",
      status: "completed",
      profile: FILLED_PROFILE,
    });

    await svc.extract({ worker_id: WORKER, session_id: SESSION }, CTX);

    expect(redis.incrby).not.toHaveBeenCalled();
  });

  it("FAILS OPEN when Redis is down — an unprofiled worker is worse than a double spend", async () => {
    // The deliberate opposite of `SubjectRateLimit`, which fails closed because it guards
    // writes into the audit spine. This guards a worker getting a profile at all: refusing
    // on an unreadable counter would deny extraction platform-wide over a cache outage.
    const { svc, workers, extractionQueue, redis } = setup();
    workers.findById.mockResolvedValue({ id: WORKER });
    redis.incrby.mockRejectedValue(new Error("redis down"));

    await expect(
      svc.extract({ worker_id: WORKER, session_id: SESSION }, CTX),
    ).resolves.toMatchObject({ status: "queued" });
    expect(extractionQueue.add).toHaveBeenCalledOnce();
  });

  it("re-asserts the key's TTL on EVERY hit, not only the first", async () => {
    // A `if (count === 1)` guard leaks a TTL-less key whenever the process dies between
    // INCRBY and EXPIRE — one per session per affected hour, in the Redis that also runs
    // BullMQ. EXPIRE is idempotent and cheap, so re-asserting is the whole fix. The same
    // pitfall `SubjectRateLimit` documents.
    const { svc, workers, redis } = setup();
    workers.findById.mockResolvedValue({ id: WORKER });

    await svc.extract({ worker_id: WORKER, session_id: SESSION }, CTX);
    await svc.extract({ worker_id: WORKER, session_id: SESSION }, CTX);

    expect(redis.expire).toHaveBeenCalledTimes(2);
  });
});

describe("ProfilesService — the extraction job's retry policy", () => {
  it("overrides the queue-wide 1s backoff with one sized to a rate limit", async () => {
    // `queue.module.ts` sets attempts:3 with a 1s exponential backoff — 1s and 2s — tuned
    // for a transient DB blip. Retrying a provider rate limit after 1s is indistinguishable
    // from not backing off: the window has not moved, so it is another rejected request
    // charged against the same exhausted bucket.
    const { svc, workers, extractionQueue } = setup();
    workers.findById.mockResolvedValue({ id: WORKER });

    await svc.extract({ worker_id: WORKER, session_id: SESSION }, CTX);

    expect(extractionQueue.add).toHaveBeenCalledWith(
      "extract",
      expect.anything(),
      EXTRACTION_JOB_OPTS,
    );
    expect(EXTRACTION_JOB_OPTS.backoff.delay).toBe(5 * 60 * 1000);
  });

  it("the in-flight zombie window outlasts the full retry ladder", async () => {
    // THE COUPLING THAT WOULD HAVE BITTEN SILENTLY. A job correctly waiting out a rate
    // limit is ~15 minutes old before its final attempt. If the zombie window stayed at
    // its old 10 minutes, the dedupe guard would treat every healthy retrying job as
    // stranded and mint a duplicate — reintroducing the exact double-enqueue #420 closed.
    const ladder = EXTRACTION_JOB_OPTS.backoff.delay * (EXTRACTION_JOB_OPTS.attempts - 1);
    expect(EXTRACTION_IN_FLIGHT_WINDOW_MS).toBeGreaterThan(ladder);
  });
});
