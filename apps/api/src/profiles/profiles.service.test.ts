import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import type { Queue } from "bullmq";
import { ProfilesService, EXTRACTION_IN_FLIGHT_WINDOW_MS } from "./profiles.service";
import type { ProfilesRepository } from "./profiles.repository";
import type { AiJobsRepository } from "./ai-jobs.repository";
import type { WorkersRepository } from "../workers/workers.repository";
import type { ChatRepository } from "../chat/chat.repository";
import type { EventsService } from "../events/events.service";
import type { ProfileExtractionJobData, ResumeGenerateJobData } from "../queue/queue.constants";
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
  };
  const workers = { findById: vi.fn(async () => undefined as Record<string, unknown> | undefined) };
  // Issue #435 — the session the caller named. Defaults to a session OWNED by WORKER,
  // so every pre-existing test keeps its old meaning; the ownership tests override it.
  const chat = {
    findSession: vi.fn(
      async (id: string) =>
        ({ id, workerId: WORKER }) as { id: string; workerId: string } | undefined,
    ),
  };
  const events = {
    emit: vi.fn(async (p: { event_name: string; payload: Record<string, unknown> }) => p),
  };
  const extractionQueue = { add: vi.fn(async () => undefined) };
  const resumeGenerateQueue = { add: vi.fn(async () => undefined) };
  const svc = new ProfilesService(
    profiles as unknown as ProfilesRepository,
    aiJobs as unknown as AiJobsRepository,
    workers as unknown as WorkersRepository,
    chat as unknown as ChatRepository,
    events as unknown as EventsService,
    extractionQueue as unknown as Queue<ProfileExtractionJobData>,
    resumeGenerateQueue as unknown as Queue<ResumeGenerateJobData>,
  );
  return { svc, profiles, aiJobs, workers, chat, events, extractionQueue, resumeGenerateQueue };
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

    const args = aiJobs.findExtractionDedupeCandidate.mock.calls[0]![0];
    expect(args.sessionId).toBe(SESSION);
    expect(args.workerId).toBe(WORKER);
    const age = before - args.inFlightSince.getTime();
    expect(age).toBeGreaterThanOrEqual(EXTRACTION_IN_FLIGHT_WINDOW_MS);
    expect(age).toBeLessThan(EXTRACTION_IN_FLIGHT_WINDOW_MS + 5_000);
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
});
