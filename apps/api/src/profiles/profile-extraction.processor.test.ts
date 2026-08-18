import "reflect-metadata";
import { Logger } from "@nestjs/common";
import { describe, it, expect, vi } from "vitest";
import {
  DraftProfileSchema,
  WorkerProfileDraftSchema,
  type DraftProfile,
} from "@badabhai/ai-contracts";
import { SKILL_TAXONOMY_VERSION } from "@badabhai/taxonomy";
import { AiCostRecorder } from "../ai/ai-cost-recorder.service";
import { fakeAiCostTotals } from "../ai/ai-cost-totals.fake";
import { ProfileExtractionProcessor } from "./profile-extraction.processor";
import type { ProfileExtractionJobData } from "../queue/queue.constants";

const JOB = {
  workerId: "11111111-1111-4111-8111-111111111111",
  sessionId: "22222222-2222-4222-8222-222222222222",
  aiJobId: "33333333-3333-4333-8333-333333333333",
  correlationId: "44444444-4444-4444-8444-444444444444",
  requestId: "req-1",
} satisfies ProfileExtractionJobData;

const PROFILE = "55555555-5555-4555-8555-555555555555";

function makeJob(over: { attemptsMade?: number; attempts?: number } = {}) {
  return {
    data: JOB,
    attemptsMade: over.attemptsMade ?? 0,
    opts: { attempts: over.attempts ?? 3 },
  } as never;
}

function make(
  opts: {
    findById?: unknown;
    extractThrows?: boolean;
    aiMetadata?: unknown;
    /**
     * #745 — `ProfileExtractionOutput.skill_embedding_metadata`: one record per embed the
     * TAX-4 canonicalization pass paid for. Omit for a pass that reached no provider.
     */
    skillEmbedMetadata?: unknown[];
    /** Issue #419 — the rich WorkerProfileDraft the response carries; omit to simulate none. */
    richDraft?: unknown;
    /**
     * T3 — the LEGACY DraftProfile the extraction returned. Defaults to
     * `DraftProfileSchema.parse({})`, which is byte-for-byte the fabrication
     * `AiService.extractProfile` returns when the ai-service is unreachable. Pass a
     * populated draft to simulate an extraction that genuinely found something.
     */
    profile?: unknown;
    /** T3 — the fail-closed leg (pseudonymization blocked the LLM call). */
    blocked?: boolean;
    /** R32 — stored chat rows the transcript is built from. */
    messages?: { direction: string; bodyText: string }[];
    /** R32 — the worker's DECRYPTED full name (null = none stored). */
    workerName?: string | null;
    /** R32 — a rotated/tampered key: `pii.decrypt` throws. */
    decryptThrows?: boolean;
    /** The in-flight Redis transcript (the early-finish path, before any flush). */
    buffered?: { messages: { role: "worker" | "assistant"; text: string; at: string }[] } | null;
    /** Redis is unreachable when the extraction tries to read the buffer. */
    bufferThrows?: boolean;
    /** Generalized profiling — the RAG match the ai-service returned (omit = pass off). */
    domainMatch?: unknown;
    /** The catalog re-validation verdict, or a throw to simulate a failing check. */
    domainSelectable?: boolean;
    domainCheckThrows?: boolean;
    /**
     * OIE Phase 8 — `chat_sessions.conversation_state`. PRESENT-BUT-NULL is meaningful
     * (a session with no OIE state), so the harness tests with `in`, never `??`.
     */
    conversationState?: unknown;
    /** The session read fails; the processor must degrade to the legacy path. */
    sessionThrows?: boolean;
    /** What `/profile/parse` returned. `null` = unreachable/blocked/mis-shaped. */
    parsed?: unknown;
    /**
     * `ProfileExtractionOutput.error_code` — WHY a degraded extraction is degraded.
     * `"extract_service_unreachable"` is what `AiService.extractProfile` now authors when the
     * request never left the process; `undefined` reproduces a healthy response.
     */
    errorCode?: string;
    /**
     * Phase C — `CHAT_LLM_INTERVIEW_ENABLED`. OFF by default, which is the property most of this
     * file depends on: with the flag down the processor makes exactly the calls it always did.
     */
    llmInterview?: boolean;
    /** What `/profiling/extract` returned. `null` = unreachable/blocked/mis-shaped. */
    interview?: unknown;
  } = {},
) {
  const draft = opts.profile ?? DraftProfileSchema.parse({});
  const profiles = { create: vi.fn().mockResolvedValue({ id: PROFILE }) };
  const aiJobs = {
    findById: vi.fn().mockResolvedValue(opts.findById ?? undefined),
    markRunning: vi.fn().mockResolvedValue(undefined),
    markCompleted: vi.fn().mockResolvedValue(undefined),
    markFailed: vi.fn().mockResolvedValue(undefined),
  };
  const chat = {
    listMessages: vi.fn().mockResolvedValue(opts.messages ?? []),
    // OIE Phase 8: the answer map and the pinned occupation are read from
    // `chat_sessions.conversation_state`, because the Redis buffer is dropped the moment
    // the flush commits and this job runs minutes later. `undefined` = a pre-cutover
    // session with no OIE state, which must take the legacy transcript re-parse.
    findSession: opts.sessionThrows
      ? vi.fn().mockRejectedValue(new Error("db down"))
      : vi
          .fn()
          .mockResolvedValue(
            "conversationState" in opts
              ? { id: JOB.sessionId, conversationState: opts.conversationState }
              : { id: JOB.sessionId, conversationState: null },
          ),
  };
  // The in-flight transcript, for the early-finish path. `undefined` = no buffer (the
  // normal post-flush case, where Postgres is authoritative).
  const buffer = {
    load: opts.bufferThrows
      ? vi.fn().mockRejectedValue(new Error("redis down"))
      : vi.fn().mockResolvedValue(opts.buffered ?? null),
  };
  // `emitOnce` is what `AiCostRecorder` calls — it needs the "was a row written or deduped"
  // bit to decide whether to move the running totals. Routed through the SAME `emit` spy so
  // every assertion in this file that reads `events.emit.mock.calls` still sees the cost
  // events; a separate spy would have made all of them pass while recording nothing.
  const emit = vi.fn().mockResolvedValue(undefined);
  const events = {
    emit,
    emitOnce: vi.fn(async (params: unknown) => {
      await emit(params);
      return { event: params, written: true };
    }),
  };
  // R32 — full_name is stored ENCRYPTED (TD21); the plaintext lives only behind decrypt.
  const workers = {
    findById: vi.fn().mockResolvedValue({
      id: JOB.workerId,
      fullName: opts.workerName == null ? null : "ENC_FULL_NAME_TOKEN",
    }),
  };
  const pii = {
    decrypt: vi.fn((_token: string) => {
      if (opts.decryptThrows) throw new Error("bad/rotated key");
      return opts.workerName ?? "";
    }),
  };
  const ai = {
    // OIE Phase 8 — the ONE LLM call left.
    //
    // THE DEFAULT IS A HEALTHY PARSE THAT FOUND NOTHING, not `null` — most cases here are
    // about the answer-map path and want a parse that ran and simply added no overlay.
    // `AiService.parseProfile` returns `null` when the call never came back at all (non-OK,
    // our own abort, or an off-contract body) — that is a TRANSPORT signal, not the model
    // being reached and failing, so it does NOT retry (see `outageCode` in the processor
    // and "a null parse is a transport failure, not an LLM outage" below). Pass `parsed:
    // null` explicitly to exercise that immediate-fallback path.
    parseProfile: vi
      .fn()
      .mockResolvedValue(
        "parsed" in opts
          ? opts.parsed
          : { fields: {}, unparsed_field_ids: [], notes: [], ai_metadata: null },
      ),
    // Phase C. Unreachable by default — the flag is off, so the processor must not call it at
    // all, and a stub that returned something would hide a call this file says never happens.
    extractInterview: vi.fn().mockResolvedValue("interview" in opts ? opts.interview : null),
    extractProfile: opts.extractThrows
      ? vi.fn().mockRejectedValue(new Error("boom"))
      : vi.fn().mockResolvedValue({
          profile: draft,
          blocked: opts.blocked ?? false,
          // The ai-service sets `is_mock = not meta.real_call`, so this is TRUE for a
          // perfectly healthy extraction whenever AI_ENABLE_REAL_CALLS=false (the
          // committed default). Left true across the T3 cases on purpose — it is the
          // signal profile_status must NOT be derived from.
          is_mock: true,
          ai_metadata: opts.aiMetadata ?? null,
          // #745 — the canonicalization pass's embeds. `[]` (the default) reproduces a
          // pass that never reached a provider; a populated list is N billable embeds.
          skill_embedding_metadata: opts.skillEmbedMetadata ?? [],
          // Issue #419 — the response has always carried the rich draft; `undefined`
          // here reproduces an AI service that omits it entirely.
          worker_profile_draft: opts.richDraft,
          // `undefined` reproduces an ai-service with DOMAIN_MATCH_ENABLED off:
          // the key is absent, which the processor must read as "did not run".
          job_domain_match: opts.domainMatch,
          error_code: opts.errorCode ?? null,
        }),
  };
  ai.parseProfile = vi
    .fn()
    .mockResolvedValue(
      "parsed" in opts
        ? opts.parsed
        : { fields: {}, unparsed_field_ids: [], notes: [], ai_metadata: null },
    );
  const skills = {
    isSelectableDomain: opts.domainCheckThrows
      ? vi.fn().mockRejectedValue(new Error("db down"))
      : vi.fn().mockResolvedValue(opts.domainSelectable ?? true),
  };
  // ADR-0036 moments ①/②. `rebuildQuietly` is the ONLY method the processor calls, and
  // it is contractually never-throwing — so a stub that resolves is the honest double.
  // The "a rebuild failure must not fail the extraction" property is asserted by its own
  // case below with a REJECTING stub, not assumed from this one.
  const matchSkills = { rebuildQuietly: vi.fn().mockResolvedValue(undefined) };
  // `worker_attributes` — the destination for the 77% of the pack corpus that is attribute-kind.
  // Returns the row count so a test can assert what was written, not merely that a call happened.
  const workerAttributes = {
    upsertMany: vi.fn(async (rows: unknown[]) => rows.length),
  };
  const proc = new ProfileExtractionProcessor(
    profiles as never,
    aiJobs as never,
    chat as never,
    buffer as never,
    events as never,
    ai as never,
    workers as never,
    pii as never,
    matchSkills as never,
    skills as never,
    workerAttributes as never,
    // The REAL recorder over the fake events service, not a stub — the emit assertions below
    // are about what actually reaches `events.emit`, and a stubbed recorder would make every
    // one of them pass without an event ever being built (#738).
    new AiCostRecorder(events as never, fakeAiCostTotals().repo),
    { CHAT_LLM_INTERVIEW_ENABLED: opts.llmInterview ?? false } as never,
  );
  return {
    proc,
    profiles,
    aiJobs,
    chat,
    buffer,
    events,
    ai,
    workers,
    pii,
    matchSkills,
    skills,
    workerAttributes,
  };
}

describe("ProfileExtractionProcessor", () => {
  it("happy path: creates a profile, marks completed, emits extraction_completed", async () => {
    const { proc, profiles, aiJobs, events } = make();
    const res = await proc.process(makeJob());
    expect(res).toEqual({ profile_id: PROFILE });
    expect(profiles.create).toHaveBeenCalledOnce();
    // The profile is tied to its ai_job so a partial-success retry can't orphan a
    // duplicate (TD14 — DB-enforced via the unique ai_job_id).
    expect(profiles.create).toHaveBeenCalledWith(expect.objectContaining({ aiJobId: JOB.aiJobId }));
    // B-6: every skills WRITE carries the taxonomy version in force (ADR-0030 §c).
    // Asserted against the exported constant so a corpus version bump can't drift
    // from what the processor stamps.
    expect(profiles.create).toHaveBeenCalledWith(
      expect.objectContaining({ taxonomyVersion: String(SKILL_TAXONOMY_VERSION) }),
    );
    // No AI metadata on the mock/AI-down path → usage columns left untouched (undefined),
    // and no ai.cost_recorded event (nothing real to record).
    expect(aiJobs.markCompleted).toHaveBeenCalledWith(
      JOB.aiJobId,
      { profile_id: PROFILE },
      undefined,
    );
    expect(events.emit.mock.calls[0]![0].event_name).toBe("profile.extraction_completed");
    const names = events.emit.mock.calls.map((c) => c[0].event_name);
    expect(names).not.toContain("ai.cost_recorded");
  });

  it("issue #419: PERSISTS the rich WorkerProfileDraft instead of discarding it", async () => {
    // REGRESSION: the extraction response has always carried worker_profile_draft (28
    // fields — controllers, education, certifications, current vs expected salary,
    // availability, current_city/current_state), and the processor read only
    // `result.profile` (the narrow legacy shape). Everything the interview collected
    // beyond the legacy fields was silently thrown away.
    const richDraft = {
      role_family: "cnc_vmc",
      controllers: ["fanuc", "siemens"],
      education: ["iti_fitter"],
      certifications: ["nsqf_l4"],
      current_salary: 18000,
      expected_salary: 25000,
      availability: "immediate",
      current_city: "pune",
      current_state: "maharashtra",
      preferred_locations: ["pune", "chakan"],
    };
    const { proc, profiles } = make({ richDraft });
    await proc.process(makeJob());

    expect(profiles.create).toHaveBeenCalledWith(
      expect.objectContaining({ richProfileDraft: richDraft }),
    );
    // ...and the legacy column is untouched: raw_profile is parsed elsewhere with
    // DraftProfileSchema (resume.service.ts), so the rich shape must NOT land there.
    const arg = profiles.create.mock.calls[0]![0] as Record<string, unknown>;
    expect(arg.rawProfile).toEqual(DraftProfileSchema.parse({}));
    expect(arg.rawProfile).not.toEqual(richDraft);
  });

  it("issue #419: a response with NO rich draft stores null, never undefined", async () => {
    // The contract makes the field nullable (the mock / AI-down path returns none).
    // `undefined` would make drizzle omit the column rather than write NULL, so the
    // `?? null` in the processor is load-bearing.
    const { proc, profiles } = make();
    await proc.process(makeJob());

    const arg = profiles.create.mock.calls[0]![0] as Record<string, unknown>;
    expect(arg).toHaveProperty("richProfileDraft");
    expect(arg.richProfileDraft).toBeNull();
  });

  it("persists AI usage/cost on completion + emits ai.cost_recorded (operational fields only, no PII)", async () => {
    const aiMetadata = {
      ai_call_id: "66666666-6666-4666-8666-666666666666",
      task_type: "profile_extraction",
      model_name: "gpt-4o-mini",
      provider: "openai",
      real_call: true,
      input_tokens: 1200,
      output_tokens: 300,
      estimated_cost_inr: 0.42,
      latency_ms: 850,
      success: true,
      error_code: null,
      cost_alert: false,
      above_target: false,
      created_at: "2026-06-11T00:00:00.000Z",
    };
    const { proc, aiJobs, events } = make({ aiMetadata });
    await proc.process(makeJob());

    // (1) Operational usage/cost persisted to ai_jobs via markCompleted — total_tokens derived.
    expect(aiJobs.markCompleted).toHaveBeenCalledWith(
      JOB.aiJobId,
      { profile_id: PROFILE },
      {
        modelName: "gpt-4o-mini",
        realCall: true,
        inputTokens: 1200,
        outputTokens: 300,
        totalTokens: 1500,
        costInr: 0.42,
      },
    );

    // (2) ai.cost_recorded emitted with the same metadata (after extraction_completed).
    const costEvent = events.emit.mock.calls
      .map((c) => c[0])
      .find((e) => e.event_name === "ai.cost_recorded");
    expect(costEvent).toBeDefined();
    expect(costEvent!.payload).toMatchObject({
      ai_job_id: JOB.aiJobId,
      task_type: "profile_extraction",
      model: "gpt-4o-mini",
      real_call: true,
      tokens_in: 1200,
      tokens_out: 300,
      estimated_cost_inr: 0.42,
    });

    // (3) No PII: the persisted usage object exposes ONLY the six operational scalars.
    const usageArg = aiJobs.markCompleted.mock.calls[0]![2] as Record<string, unknown>;
    expect(Object.keys(usageArg).sort()).toEqual(
      ["costInr", "inputTokens", "modelName", "outputTokens", "realCall", "totalTokens"].sort(),
    );
    const blob = JSON.stringify(costEvent) + JSON.stringify(usageArg);
    expect(blob).not.toMatch(/phone|full_name|e164|transcript|\bbody_text\b/i);
  });

  it("TD27: emits ai.spend_cap_exceeded when the gateway blocks a real call (cap reason), no PII", async () => {
    const aiMetadata = {
      ai_call_id: "66666666-6666-4666-8666-666666666666",
      task_type: "profile_extraction",
      model_name: "gemini-flash",
      provider: "google",
      real_call: false,
      input_tokens: 0,
      output_tokens: 0,
      estimated_cost_inr: 0,
      latency_ms: 0,
      success: false,
      error_code: "daily_cap_exceeded",
      cost_alert: true,
      above_target: false,
      created_at: "2026-06-11T00:00:00.000Z",
    };
    const { proc, events } = make({ aiMetadata });
    await proc.process(makeJob());

    // cost_recorded is still emitted (unchanged), AND the cap event in addition.
    const names = events.emit.mock.calls.map((c) => c[0].event_name);
    expect(names).toContain("ai.cost_recorded");
    const capEvent = events.emit.mock.calls
      .map((c) => c[0])
      .find((e) => e.event_name === "ai.spend_cap_exceeded");
    expect(capEvent).toBeDefined();
    expect(capEvent!.payload).toMatchObject({
      ai_job_id: JOB.aiJobId,
      task_type: "profile_extraction",
      model: "gemini-flash",
      provider: "google",
      reason: "daily_cap_exceeded",
      real_call: false,
    });
    expect(JSON.stringify(capEvent)).not.toMatch(/phone|full_name|e164|transcript|\bbody_text\b/i);
  });

  it("TD27: does NOT emit ai.spend_cap_exceeded for a non-cap error_code", async () => {
    const aiMetadata = {
      ai_call_id: "66666666-6666-4666-8666-666666666666",
      task_type: "profile_extraction",
      model_name: "gemini-flash",
      provider: "google",
      real_call: true,
      input_tokens: 10,
      output_tokens: 5,
      estimated_cost_inr: 0.01,
      latency_ms: 100,
      success: false,
      error_code: "provider_timeout",
      cost_alert: false,
      above_target: false,
      created_at: "2026-06-11T00:00:00.000Z",
    };
    const { proc, events } = make({ aiMetadata });
    await proc.process(makeJob());
    const names = events.emit.mock.calls.map((c) => c[0].event_name);
    expect(names).not.toContain("ai.spend_cap_exceeded");
  });

  it("PERF-2 guard: extraction still receives the FULL transcript from its OWN source", async () => {
    // The chat turn no longer ships history to the ai-service (PERF-2 — the turn
    // engine discards it), but extraction genuinely needs the whole conversation.
    // Its transcript source is the processor's own buildTranscript → chat.listMessages
    // — NOT the chat turn's payload — so it must keep reading every stored message.
    const { proc, chat, ai } = make();
    chat.listMessages.mockResolvedValue([
      { id: "m1", direction: "outbound", bodyText: "Kaunsa kaam karte ho?" },
      { id: "m2", direction: "inbound", bodyText: "VMC operator, 5 saal" },
      { id: "m3", direction: "outbound", bodyText: "Kaunsi city me ho?" },
      { id: "m4", direction: "inbound", bodyText: "Pune me hoon" },
    ]);
    await proc.process(makeJob());

    // The transcript was read from the chat repository (the processor's own path)…
    expect(chat.listMessages).toHaveBeenCalledWith(JOB.sessionId);
    // …and every turn of the conversation reached the extraction call, in BOTH
    // shapes: the flat transcript the model reads, and the role-tagged messages
    // the AI service's deterministic detector reads.
    expect(ai.extractProfile).toHaveBeenCalledWith(
      {
        worker_ref: JOB.workerId,
        transcript: [
          "Bada Bhai: Kaunsa kaam karte ho?",
          "Worker: VMC operator, 5 saal",
          "Bada Bhai: Kaunsi city me ho?",
          "Worker: Pune me hoon",
        ].join("\n"),
        messages: [
          { role: "assistant", text: "Kaunsa kaam karte ho?" },
          { role: "worker", text: "VMC operator, 5 saal" },
          { role: "assistant", text: "Kaunsi city me ho?" },
          { role: "worker", text: "Pune me hoon" },
        ],
      },
      // BL-19: the job's own correlation/request id, threaded to the ai-service call.
      { requestId: JOB.requestId, correlationId: JOB.correlationId },
    );
  });

  it("always sends BOTH conversation fields — never messages without transcript", async () => {
    // `transcript` is the rollback lever: the AI service falls back to it whenever
    // `messages` is absent, and reverting to the pre-split behaviour is exactly
    // "stop sending messages". Sending `messages` alone would silently change what
    // the MODEL reads too, which is not what the split is for.
    const { proc, ai } = make();
    await proc.process(makeJob());

    const arg = ai.extractProfile.mock.calls[0]![0];
    expect(Object.keys(arg).sort()).toEqual(["messages", "transcript", "worker_ref"]);
    expect(typeof arg.transcript).toBe("string");
    expect(arg.transcript.length).toBeGreaterThan(0);
  });

  it("empty session: both fields still describe the same (empty) conversation", async () => {
    const { proc, chat, ai } = make();
    chat.listMessages.mockResolvedValue([]);
    await proc.process(makeJob());

    expect(ai.extractProfile).toHaveBeenCalledWith(
      {
        worker_ref: JOB.workerId,
        // The placeholder the AI service has always received for an empty session.
        transcript: "(no conversation captured)",
        messages: [],
      },
      { requestId: JOB.requestId, correlationId: JOB.correlationId },
    );
  });

  it("drops empty-bodied messages from BOTH shapes identically", async () => {
    // The two shapes must always describe the same set of lines. If the filter
    // drifts, the model and the detector are reading different conversations.
    const { proc, chat, ai } = make();
    chat.listMessages.mockResolvedValue([
      { id: "m1", direction: "outbound", bodyText: "Kaunsa kaam karte ho?" },
      { id: "m2", direction: "inbound", bodyText: "" },
      { id: "m3", direction: "inbound", bodyText: null },
      { id: "m4", direction: "inbound", bodyText: "VMC operator" },
    ]);
    await proc.process(makeJob());

    const arg = ai.extractProfile.mock.calls[0]![0];
    expect(arg.messages).toEqual([
      { role: "assistant", text: "Kaunsa kaam karte ho?" },
      { role: "worker", text: "VMC operator" },
    ]);
    expect(arg.transcript).toBe("Bada Bhai: Kaunsa kaam karte ho?\nWorker: VMC operator");
  });

  it("idempotent: an already-completed job is not reprocessed", async () => {
    const { proc, profiles, aiJobs } = make({
      findById: { status: "completed", outputRef: { profile_id: PROFILE } },
    });
    const res = await proc.process(makeJob());
    expect(res).toEqual({ profile_id: PROFILE });
    expect(aiJobs.markRunning).not.toHaveBeenCalled();
    expect(profiles.create).not.toHaveBeenCalled();
  });

  it("non-final attempt failure: rethrows WITHOUT marking failed / emitting", async () => {
    const { proc, aiJobs, events } = make({ extractThrows: true });
    await expect(proc.process(makeJob({ attemptsMade: 0, attempts: 3 }))).rejects.toThrow();
    expect(aiJobs.markFailed).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();
  });

  it("final attempt failure: marks failed + emits extraction_failed exactly once", async () => {
    const { proc, aiJobs, events } = make({ extractThrows: true });
    await expect(proc.process(makeJob({ attemptsMade: 2, attempts: 3 }))).rejects.toThrow();
    expect(aiJobs.markFailed).toHaveBeenCalledOnce();
    expect(events.emit).toHaveBeenCalledOnce();
    expect(events.emit.mock.calls[0]![0].event_name).toBe("profile.extraction_failed");
  });

  // ── ADR-0036 moments ①/② ──────────────────────────────────────────────────────
  it("rebuilds the worker's match skills AFTER the profile is written", async () => {
    const { proc, matchSkills, profiles } = make();
    await proc.process(makeJob());
    expect(matchSkills.rebuildQuietly).toHaveBeenCalledOnce();
    expect(matchSkills.rebuildQuietly).toHaveBeenCalledWith(
      JOB.workerId,
      expect.objectContaining({ correlationId: JOB.correlationId }),
    );
    // ORDER MATTERS: the rebuild reads the worker's LATEST worker_profiles row, so it
    // must run after the write, not before — otherwise it derives from the previous
    // profile and the new skills only appear on the next extraction.
    const createOrder = profiles.create.mock.invocationCallOrder[0]!;
    const rebuildOrder = matchSkills.rebuildQuietly.mock.invocationCallOrder[0]!;
    expect(rebuildOrder).toBeGreaterThan(createOrder);
  });

  it("a match-rebuild failure NEVER fails the extraction", async () => {
    // The real `rebuildQuietly` swallows + logs, so this stub deliberately violates its
    // contract to prove the processor does not depend on that politeness: `worker_skill`
    // / `worker_industry_tenure` / `job_reach` are rebuildable projections, and losing a
    // worker's extracted profile to a reach-cache hiccup is the far worse trade.
    const { proc, matchSkills, aiJobs, events } = make();
    matchSkills.rebuildQuietly.mockRejectedValueOnce(new Error("job_reach unavailable"));
    await expect(proc.process(makeJob())).resolves.toEqual({ profile_id: PROFILE });
    expect(aiJobs.markCompleted).toHaveBeenCalledOnce();
    expect(aiJobs.markFailed).not.toHaveBeenCalled();
    const names = events.emit.mock.calls.map((c) => c[0].event_name);
    expect(names).toContain("profile.extraction_completed");
    expect(names).not.toContain("profile.extraction_failed");
  });
});

/**
 * T3 — a FABRICATED or contentless extraction must never be recorded as "extracted".
 *
 * THE PRODUCTION BUG this pins: when the ai-service is unreachable,
 * `AiService.extractProfile` returns `DraftProfileSchema.parse({})` (null canonical
 * ids, empty skills/machines, availability "unknown") with `blocked: false`. The
 * processor read ONLY that flag — `result.blocked ? "draft" : "extracted"` — so the
 * fabrication was stamped "extracted", the status that means "this worker is
 * profiled", and `ChatService.autoTriggerExtraction` (which skipped on any existing
 * profile ROW) then made it the worker's PERMANENT profile.
 *
 * The status now follows CONTENT, via the SAME `hasExtractedContent` predicate
 * `ProfilesService.extract` dedupes on — never `is_mock`, which is
 * `not meta.real_call` on the ai-service side and therefore true for every healthy
 * extraction under the committed `AI_ENABLE_REAL_CALLS=false` default.
 */
describe("ProfileExtractionProcessor — T3 profile_status follows CONTENT, not reachability", () => {
  /** The profileStatus the run handed to `ProfilesRepository.create`. */
  const createdStatus = (profiles: { create: ReturnType<typeof vi.fn> }): unknown =>
    (profiles.create.mock.calls[0]![0] as Record<string, unknown>).profileStatus;

  /** The `profile.extraction_completed` payload the run emitted. */
  const completedPayload = (events: { emit: ReturnType<typeof vi.fn> }) =>
    events.emit.mock.calls
      .map((c) => c[0] as { event_name: string; payload: Record<string, unknown> })
      .find((e) => e.event_name === "profile.extraction_completed")!.payload;

  /** A legacy draft carrying real extracted content (the ordinary happy path). */
  const REAL_DRAFT = DraftProfileSchema.parse({
    canonical_role_id: "vmc_operator",
    skills: ["skill_milling"],
    machines: ["haas_vf2"],
    experience: { total_years: 5 },
  });

  it("an OUTAGE and a worker with nothing to say no longer share one warning (B-8a)", async () => {
    // Both produce `blocked: false` + an empty draft + `is_mock: true`, so until
    // `error_code` existed the processor could only log "check ai-service reachability" —
    // an instruction to go and find out, because nothing in the result could say. The two
    // cases must now be distinguishable IN THE LOG, since the recorded row is identical by
    // design (both are honestly "draft").
    const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    try {
      const outage = make({ errorCode: "extract_service_unreachable" });
      await outage.proc.process(makeJob());
      const outageLine = warn.mock.calls
        .map((c) => String(c[0]))
        .find((m) => m.includes("NO extracted content"));
      expect(outageLine).toContain("cause=extract_service_unreachable");

      warn.mockClear();
      const quiet = make(); // reachable, healthy, and the worker said nothing usable
      await quiet.proc.process(makeJob());
      const quietLine = warn.mock.calls
        .map((c) => String(c[0]))
        .find((m) => m.includes("NO extracted content"));
      expect(quietLine).toContain("the interview itself produced nothing");
      expect(quietLine).not.toContain("cause=");
    } finally {
      warn.mockRestore();
    }
  });

  it("the AI-DOWN fabrication is recorded as 'draft', never 'extracted'", async () => {
    // The default harness IS the fabrication: empty legacy draft, no rich draft,
    // blocked:false, is_mock:true — exactly what AiService.extractProfile returns.
    const { proc, profiles, events } = make();
    await proc.process(makeJob());

    expect(createdStatus(profiles)).toBe("draft");
    expect(completedPayload(events).profile_status).toBe("draft");
    // The number that always made this detectable, spent on the payload and nothing
    // else before T3. Still emitted, still unchanged — it is a count, not a verdict.
    expect(completedPayload(events).field_count).toBe(0);
  });

  it("a REAL extraction with content is 'extracted' exactly as before — even though is_mock is true", async () => {
    // The load-bearing case for rejecting `is_mock` as the discriminator: under the
    // committed AI_ENABLE_REAL_CALLS=false default the ai-service returns is_mock=true
    // for every healthy deterministic extraction. Keying status off it would mean NO
    // worker ever reaches "extracted" outside a real-provider environment.
    const { proc, profiles, events, ai } = make({ profile: REAL_DRAFT });
    await proc.process(makeJob());

    expect(await ai.extractProfile.mock.results[0]!.value).toMatchObject({ is_mock: true });
    expect(createdStatus(profiles)).toBe("extracted");
    expect(completedPayload(events).profile_status).toBe("extracted");
    expect(completedPayload(events).field_count).toBeGreaterThan(0);
  });

  it("TD94: empty legacy columns but a content-bearing RICH draft is still 'extracted'", async () => {
    // A real extraction of "main CNC operator hoon" that the gazetteer could not
    // canonicalize: every legacy column is at its default (countFields would score 0)
    // yet the AI genuinely extracted a skill label into the rich draft. Judging on
    // countFields alone would demote a good profile — which is why the status uses
    // hasExtractedContent, whose rich-draft leg covers exactly this.
    const { proc, profiles, events } = make({
      richDraft: WorkerProfileDraftSchema.parse({ skills: ["machine operation"] }),
    });
    await proc.process(makeJob());

    expect(completedPayload(events).field_count).toBe(0); // legacy columns genuinely empty
    expect(createdStatus(profiles)).toBe("extracted");
  });

  it("a reachable AI that genuinely found NOTHING is 'draft' (re-extractable), not a completed profile", async () => {
    // The intended outcome for the honest empty case ("hmm" as the whole interview):
    // the ai-service was UP and answered, so the draft is non-null — but it carries
    // only the always-populated fields. Recording that as "extracted" would pin the
    // worker to an empty profile just as surely as the outage fabrication does, so it
    // takes the same branch: recorded, evented, and left re-extractable.
    const { proc, profiles, events } = make({
      richDraft: WorkerProfileDraftSchema.parse({
        role_family: "cnc_vmc",
        experience_level: "unknown",
        availability: "unknown",
        confidence_score: 0.3,
        missing_fields: ["primary_role", "experience_years"],
        clarification_questions: ["Aap kaun si machine chalate hain?"],
      }),
    });
    await proc.process(makeJob());

    expect(createdStatus(profiles)).toBe("draft");
    expect(completedPayload(events).profile_status).toBe("draft");
  });

  it("the blocked (fail-closed) leg is 'draft', unchanged", async () => {
    // Pre-existing behaviour, pinned so the content check cannot accidentally
    // re-litigate a result that was never allowed to produce content.
    const { proc, profiles } = make({ blocked: true, profile: REAL_DRAFT });
    await proc.process(makeJob());
    expect(createdStatus(profiles)).toBe("draft");
  });

  it("an AI-service outage NEVER blocks the worker: the job still completes and events still flow", async () => {
    // The repo's deliberate posture, preserved verbatim. T3 changes what is RECORDED,
    // not whether the pipeline survives — nothing throws, the profile row is created,
    // the ai_job reaches `completed` with a real profile_id, and the completion event
    // is emitted. Only `profile_status` tells the truth now.
    const { proc, profiles, aiJobs, events } = make();
    const res = await proc.process(makeJob());

    expect(res).toEqual({ profile_id: PROFILE });
    expect(profiles.create).toHaveBeenCalledOnce();
    expect(aiJobs.markCompleted).toHaveBeenCalledWith(
      JOB.aiJobId,
      { profile_id: PROFILE },
      undefined,
    );
    expect(aiJobs.markFailed).not.toHaveBeenCalled();
    const names = events.emit.mock.calls.map((c) => c[0].event_name);
    expect(names).toContain("profile.extraction_completed");
    expect(names).not.toContain("profile.extraction_failed");
  });

  it("still persists every column it always did — only the status verdict changed", async () => {
    // Guard against 'fixing' this by writing less: the empty draft is still stored in
    // full (raw_profile, skills, machines, taxonomy version, ai_job tie), so an
    // operator can still see exactly what the extraction returned.
    const { proc, profiles } = make();
    await proc.process(makeJob());

    const arg = profiles.create.mock.calls[0]![0] as Record<string, unknown>;
    expect(arg).toMatchObject({
      workerId: JOB.workerId,
      aiJobId: JOB.aiJobId,
      profileStatus: "draft",
      skills: [],
      machines: [],
      taxonomyVersion: String(SKILL_TAXONOMY_VERSION),
    });
    expect(arg.rawProfile).toEqual(DraftProfileSchema.parse({}));
  });
});

// R32 — the extraction transcript is the WIDEST worker-free-text egress to the
// ai-service: it replays every stored inbound line, so an introduction typed on
// turn 1 rides along on every later extraction. The worker's own KNOWN name is
// removed from both shapes before the hop.
describe("ProfileExtractionProcessor — R32 known-name redaction on the transcript", () => {
  const CONVO = [
    { direction: "inbound", bodyText: "Suresh Kumar, CNC operator" },
    { direction: "outbound", bodyText: "Theek hai. Kaunsi machine?" },
    { direction: "inbound", bodyText: "VMC. Suresh yahin se bol raha hun" },
  ];

  it("removes the name from BOTH the flat transcript and the role-tagged messages", async () => {
    const { proc, ai } = make({ messages: CONVO, workerName: "Suresh Kumar" });
    await proc.process(makeJob());

    const sent = ai.extractProfile.mock.calls[0]![0] as {
      transcript: string;
      messages: { role: string; text: string }[];
    };
    expect(sent.transcript).not.toContain("Suresh");
    expect(sent.transcript).not.toContain("Kumar");
    expect(sent.transcript).toBe(
      "Worker: [NAME], CNC operator\n" +
        "Bada Bhai: Theek hai. Kaunsi machine?\n" +
        "Worker: VMC. [NAME] yahin se bol raha hun",
    );
    expect(sent.messages.map((m) => m.text)).toEqual([
      "[NAME], CNC operator",
      "Theek hai. Kaunsi machine?",
      "VMC. [NAME] yahin se bol raha hun",
    ]);
    // The role tags are carried through untouched.
    expect(sent.messages.map((m) => m.role)).toEqual(["worker", "assistant", "worker"]);
  });

  it("a DECRYPT FAILURE does NOT fail the extraction — it degrades to un-redacted", async () => {
    const { proc, ai, aiJobs } = make({
      messages: CONVO,
      workerName: "Suresh Kumar",
      decryptThrows: true,
    });
    const out = await proc.process(makeJob());
    expect(out).toEqual({ profile_id: PROFILE });
    expect(aiJobs.markCompleted).toHaveBeenCalledOnce();
    const sent = ai.extractProfile.mock.calls[0]![0] as { transcript: string };
    expect(sent.transcript).toContain("Suresh Kumar");
  });

  it("no name stored → the transcript is sent exactly as it always was", async () => {
    const { proc, ai } = make({ messages: CONVO, workerName: null });
    await proc.process(makeJob());
    const sent = ai.extractProfile.mock.calls[0]![0] as { transcript: string };
    expect(sent.transcript).toContain("Suresh Kumar, CNC operator");
  });

  it("leaves trade vocabulary alone (the measured-dead gazetteer regression class)", async () => {
    const { proc, ai } = make({
      messages: [{ direction: "inbound", bodyText: "Wire EDM, Jyoti CNC, ITI fitter 2018-2020" }],
      workerName: "Suresh Kumar",
    });
    await proc.process(makeJob());
    const sent = ai.extractProfile.mock.calls[0]![0] as { transcript: string };
    expect(sent.transcript).toBe("Worker: Wire EDM, Jyoti CNC, ITI fitter 2018-2020");
  });
});

// ---------------------------------------------------------------------------
// Generalized profiling — persisting the RAG job-domain match.
// ---------------------------------------------------------------------------

/** The `job_domain_*` columns as they would be written for this extraction. */
const domainCols = (profiles: { create: ReturnType<typeof vi.fn> }) => {
  const row = profiles.create.mock.calls[0]![0] as Record<string, unknown>;
  return {
    jobDomainId: row.jobDomainId,
    jobDomainMatchStatus: row.jobDomainMatchStatus,
    jobDomainMatchScore: row.jobDomainMatchScore,
    hasMatchedAt: row.jobDomainMatchedAt !== undefined,
  };
};

describe("ProfileExtractionProcessor — the job-domain match", () => {
  it("writes NOTHING when the pass did not run (the flag is off)", async () => {
    // A disabled feature and a workforce the catalog cannot describe are different
    // facts. Recording "degraded" here would make the first look like the second, and
    // an ops query for unmatchable workers would return everyone.
    const { proc, profiles, skills } = make({ domainMatch: undefined });
    await proc.process(makeJob());
    expect(domainCols(profiles)).toEqual({
      jobDomainId: undefined,
      jobDomainMatchStatus: undefined,
      jobDomainMatchScore: undefined,
      hasMatchedAt: false,
    });
    expect(skills.isSelectableDomain).not.toHaveBeenCalled();
  });

  it("persists a validated match with its retrieval score", async () => {
    const { proc, profiles, skills } = make({
      domainMatch: {
        status: "matched_llm",
        job_domain_id: "isco_7223",
        score: 0.82,
        considered: [],
      },
      domainSelectable: true,
    });
    await proc.process(makeJob());
    expect(skills.isSelectableDomain).toHaveBeenCalledWith("isco_7223");
    expect(domainCols(profiles)).toEqual({
      jobDomainId: "isco_7223",
      jobDomainMatchStatus: "matched_llm",
      jobDomainMatchScore: 0.82,
      hasMatchedAt: true,
    });
  });

  it("records the REASON when the pass ran and honestly found nothing", async () => {
    // The status is kept and the id stays NULL, so "nothing close in the catalog" is
    // distinguishable from "the AI seam was down" — different operational facts.
    const { proc, profiles, skills } = make({
      domainMatch: {
        status: "unmatched_below_floor",
        job_domain_id: null,
        score: null,
        considered: [],
      },
    });
    await proc.process(makeJob());
    expect(domainCols(profiles)).toEqual({
      jobDomainId: undefined,
      jobDomainMatchStatus: "unmatched_below_floor",
      jobDomainMatchScore: undefined,
      hasMatchedAt: true,
    });
    // No id to check, so no query is spent.
    expect(skills.isSelectableDomain).not.toHaveBeenCalled();
  });

  it("REJECTS an id the catalog does not recognise — the label never costs the profile", async () => {
    // `job_domain_id` carries a foreign key, so an unresolvable id would fail the INSERT
    // and take the worker's entire extracted profile with it. A cheap SELECT means a bad
    // label costs the label.
    const { proc, profiles } = make({
      domainMatch: {
        status: "matched_llm",
        job_domain_id: "isco_invented",
        score: 0.9,
        considered: [],
      },
      domainSelectable: false,
    });
    await proc.process(makeJob());
    expect(domainCols(profiles)).toMatchObject({
      jobDomainId: undefined,
      jobDomainMatchStatus: "unmatched_llm_declined",
    });
  });

  it("a FAILING validation query degrades to unmatched, never throws", async () => {
    const { proc, profiles } = make({
      domainMatch: {
        status: "matched_auto",
        job_domain_id: "isco_7223",
        score: 0.95,
        considered: [],
      },
      domainCheckThrows: true,
    });
    await expect(proc.process(makeJob())).resolves.toEqual({ profile_id: PROFILE });
    expect(domainCols(profiles)).toMatchObject({
      jobDomainId: undefined,
      jobDomainMatchStatus: "unmatched_degraded",
    });
  });

  it("the match never changes profile_status — a label is not extracted content", async () => {
    const { proc, profiles } = make({
      domainMatch: {
        status: "matched_llm",
        job_domain_id: "isco_7223",
        score: 0.82,
        considered: [],
      },
    });
    await proc.process(makeJob());
    const row = profiles.create.mock.calls[0]![0] as { profileStatus: string };
    // The default fixture is the empty placeholder draft, so the status must still be
    // "draft": a domain classification says what KIND of worker this is, never that the
    // interview produced anything.
    expect(row.profileStatus).toBe("draft");
  });
});

// ---------------------------------------------------------------------------
// The early-finish path — extracting an interview that has not been flushed yet.
// ---------------------------------------------------------------------------

describe("ProfileExtractionProcessor — transcript source", () => {
  const BUFFERED = {
    messages: [
      { role: "worker" as const, text: "VMC chalata hun", at: "2026-07-22T00:00:00.000Z" },
      { role: "assistant" as const, text: "Achha. Kitne saal se?", at: "2026-07-22T00:00:01.000Z" },
      { role: "worker" as const, text: "5 saal", at: "2026-07-22T00:00:02.000Z" },
    ],
  };

  it("extracts from the REDIS BUFFER when the interview has not been flushed", async () => {
    // THE REGRESSION. The worker app offers "Phir bhi profile banaiye" at any point
    // before completion, promising an incomplete profile. It posts /profile/extract
    // mid-interview, when there are zero chat_messages rows — so a Postgres-only read
    // handed the AI service "(no conversation captured)" and produced an EMPTY profile
    // every time. And because `latestProfile` orders by created_at DESC, a worker who
    // already had a good profile and tapped this had their summary replaced by it.
    const { proc, ai, chat, buffer } = make({ messages: [], buffered: BUFFERED });
    await proc.process(makeJob());

    expect(chat.listMessages).toHaveBeenCalledTimes(1); // Postgres asked first
    expect(buffer.load).toHaveBeenCalledTimes(1); // …then the buffer
    const sent = ai.extractProfile.mock.calls[0]![0] as {
      transcript: string;
      messages: { role: string; text: string }[];
    };
    expect(sent.transcript).toBe(
      "Worker: VMC chalata hun\nBada Bhai: Achha. Kitne saal se?\nWorker: 5 saal",
    );
    expect(sent.messages).toHaveLength(3);
    expect(sent.transcript).not.toContain("no conversation captured");
  });

  it("prefers POSTGRES once the interview is flushed, and never reads the buffer", async () => {
    // After the flush the buffer is dropped in the same breath, so the two sources are
    // never both populated. Postgres leads because it is authoritative from then on.
    const { proc, ai, buffer } = make({
      messages: [{ direction: "inbound", bodyText: "flushed line" }],
      buffered: BUFFERED,
    });
    await proc.process(makeJob());
    expect(buffer.load).not.toHaveBeenCalled();
    const sent = ai.extractProfile.mock.calls[0]![0] as { transcript: string };
    expect(sent.transcript).toBe("Worker: flushed line");
  });

  it("a Redis outage degrades to the empty transcript rather than failing the job", async () => {
    // `buffer.load` fails CLOSED with a 503 for a chat TURN, because silently restarting
    // an interview is worse than an error the worker can retry. An EXTRACTION is the
    // opposite trade: if Redis is unreachable we genuinely have no transcript, and
    // degrading to today's behaviour beats failing the job.
    const { proc, ai } = make({ messages: [], bufferThrows: true });
    await expect(proc.process(makeJob())).resolves.toEqual({ profile_id: PROFILE });
    const sent = ai.extractProfile.mock.calls[0]![0] as { transcript: string };
    expect(sent.transcript).toBe("(no conversation captured)");
  });

  it("still redacts the worker's own name out of a BUFFERED transcript (R32)", async () => {
    // The buffer holds the worker's raw words by design, so the redaction that has
    // always guarded the Postgres path must guard this one identically.
    const { proc, ai } = make({
      messages: [],
      workerName: "Suresh Kumar",
      buffered: {
        messages: [
          { role: "worker", text: "Suresh Kumar, VMC operator", at: "2026-07-22T00:00:00.000Z" },
        ],
      },
    });
    await proc.process(makeJob());
    const sent = ai.extractProfile.mock.calls[0]![0];
    expect(JSON.stringify(sent)).not.toContain("Suresh");
    expect((sent as { transcript: string }).transcript).toBe("Worker: [NAME], VMC operator");
  });
});

// ---------------------------------------------------------------------------
// OIE Phase 8 — the deterministic answer map becomes the profile
// ---------------------------------------------------------------------------

/** One `AnswerRecord` as `conversation_state.answer_map` carries it. */
function record(over: Record<string, unknown> = {}) {
  return {
    question_key: "trade",
    target_field: "trade",
    value_raw: "silai ka kaam",
    value_normalized: "darzi",
    status: "answered",
    evidence: null,
    turn: 1,
    history: [],
    ...over,
  };
}

const PIN = {
  job_domain_id: "jd_nco_7531_0100",
  label: "darzi",
  isco_unit_code: "7531",
  match_status: "matched_lexical",
  match_score: 0.97,
  match_layer: "l0_exact",
  pack_id: "qp_tailoring",
  pack_version: 2,
  catalog_version: "cat_2026_08",
};

const withMap = (over: Record<string, unknown> = {}) => ({
  conversationState: {
    answer_map: [
      record(),
      record({
        question_key: "current_city",
        target_field: "current_city",
        value_normalized: "Pune",
      }),
      record({
        question_key: "experience_years",
        target_field: "experience_years",
        value_normalized: 7,
      }),
    ],
    occupation: PIN,
    ...over,
  },
});

describe("the 77% reaches worker_attributes", () => {
  /**
   * THE DEFECT AN E2E AUDIT FOUND, WHICH EVERY UNIT TEST MISSED.
   *
   * Migration 0071 built `worker_attributes`; V2 taught `projectProfile` to fill a
   * `ProjectedAttribute[]`. Nothing joined them — `toExtractionOutput(projection)` reads
   * `projection.draft` and nothing else, so the array was computed on every interview and
   * dropped on the floor. A live 13-turn welding interview produced 10 typed answers and
   * ZERO rows here: the original 77% defect, moved one layer later and no less total.
   *
   * `workplace_type` (100 items), `tools_owned` (59), `safety_training` (17) and
   * `shift_work` (14) are matching inputs under §2. An unwritten row ranks nobody.
   *
   * `tools_owned` reads 59 rather than the 99 this comment carried when the defect was found:
   * 40 packs were cut to v2 with the item removed, because a cashier and a bus driver were
   * being asked whether they own their own auzaar. The RATIO in the name above is the one
   * measured at the time and is left alone; today's is 319 of 426 active items.
   */
  const attributeMap = (over: Record<string, unknown> = {}) => ({
    conversationState: {
      answer_map: [
        record({
          question_key: "workplace_type",
          target_field: "workplace_type",
          value_normalized: "factory",
        }),
        record({
          question_key: "safety_gear",
          target_field: "safety_gear",
          value_normalized: true,
        }),
        record({
          question_key: "material_worked",
          target_field: "material_worked",
          value_normalized: ["mild_steel", "stainless"],
        }),
        // An RFS field, for contrast: it belongs on `worker_profiles` and must NOT become
        // an attribute. The crosswalk is what tells the two apart.
        record({
          question_key: "current_city",
          target_field: "current_city",
          value_normalized: "Pune",
        }),
      ],
      occupation: PIN,
      pack_id: "qp_welding",
      pack_version: 1,
      ...over,
    },
  });

  const rowsWritten = (w: { upsertMany: { mock: { calls: unknown[][] } } }) =>
    (w.upsertMany.mock.calls[0]?.[0] ?? []) as Record<string, unknown>[];

  it("writes every attribute-kind answer, and ONLY those", async () => {
    const { proc, workerAttributes } = make(attributeMap());
    await proc.process(makeJob());

    expect(workerAttributes.upsertMany).toHaveBeenCalledOnce();
    const keys = rowsWritten(workerAttributes)
      .map((r) => r.attributeKey)
      .sort();
    expect(keys).toEqual(["material_worked", "safety_gear", "workplace_type"]);
    // `current_city` is RFS — it goes on the profile, never here.
    expect(keys).not.toContain("current_city");
  });

  it("types each value into the column its value_kind names, and NULLs the rest", async () => {
    // `wa_value_present_chk` demands exactly one populated value column, and the one
    // `value_kind` names. A row that populated two, or the wrong one, is rejected by the
    // database — so getting this wrong fails at runtime, not in review.
    const { proc, workerAttributes } = make(attributeMap());
    await proc.process(makeJob());
    const rows = rowsWritten(workerAttributes);
    const by = (k: string) => rows.find((r) => r.attributeKey === k)!;

    expect(by("safety_gear")).toMatchObject({
      valueKind: "boolean",
      valueBool: true,
      valueNumber: null,
      valueText: null,
      valueTextList: null,
    });
    expect(by("workplace_type")).toMatchObject({
      valueKind: "text",
      valueText: "factory",
      valueBool: null,
      valueNumber: null,
      valueTextList: null,
    });
    expect(by("material_worked")).toMatchObject({
      valueKind: "text_list",
      valueTextList: ["mild_steel", "stainless"],
      valueBool: null,
    });
  });

  it("pins the interview each value came from", async () => {
    // Pack contents are immutable per version, so `pack_id` + `pack_version` is the only thing
    // that makes a stored value re-readable once the corpus has moved on — "did `safety_gear`
    // mean the same question in v1 as in v3" is otherwise unanswerable.
    const { proc, workerAttributes } = make(attributeMap());
    await proc.process(makeJob());
    for (const row of rowsWritten(workerAttributes)) {
      expect(row).toMatchObject({ packId: "qp_welding", packVersion: 1, sessionId: JOB.sessionId });
      expect(row.workerId).toBe(JOB.workerId);
    }
  });

  it("writes BEFORE the job is marked completed", async () => {
    // The ordering is the whole safety argument. `profiles.create` is idempotent on `ai_job_id`
    // and `upsertMany` is idempotent by key, so a throw here costs a retry and loses nothing —
    // whereas completing the job first would leave 77% of what the worker said permanently
    // unwritten with the job recorded as a success. There is no backfill runner for this table.
    const calls: string[] = [];
    const { proc, workerAttributes, aiJobs } = make(attributeMap());
    workerAttributes.upsertMany.mockImplementation(async () => {
      calls.push("attributes");
      return 3;
    });
    aiJobs.markCompleted.mockImplementation(async () => {
      calls.push("markCompleted");
    });

    await proc.process(makeJob());

    expect(calls).toEqual(["attributes", "markCompleted"]);
  });

  it("a failed attribute write FAILS the job rather than silently losing the answers", async () => {
    const { proc, workerAttributes, aiJobs } = make(attributeMap());
    workerAttributes.upsertMany.mockRejectedValue(new Error("deadlock detected"));

    await expect(proc.process(makeJob())).rejects.toThrow("deadlock detected");
    expect(aiJobs.markCompleted).not.toHaveBeenCalled();
  });

  it("a legacy session with no answer map writes nothing — and that is honest, not degraded", async () => {
    const { proc, workerAttributes } = make(); // no conversationState → transcript re-parse
    await proc.process(makeJob());
    expect(rowsWritten(workerAttributes)).toEqual([]);
  });
});

describe("the interview's one LLM call is ledgered", () => {
  /**
   * THE ECONOMIC CASE FOR THE WHOLE CUTOVER, AND IT WAS INVISIBLE. Phase 8's claim is "~12
   * capable calls per interview became 1". That one call is `/profile/parse` — and it shipped
   * returning no `ai_metadata`, emitting no cost record, and naming a `task_type` the
   * `ai.cost_recorded` enum could not even express. Every number the ledger could show
   * described the architecture the cutover deleted.
   */
  const PARSE_META = {
    ai_call_id: "77777777-7777-4777-8777-777777777777",
    task_type: "profile_parse",
    model_name: "gemini-flash",
    provider: "google",
    real_call: true,
    input_tokens: 2100,
    output_tokens: 240,
    estimated_cost_inr: 0.19,
    latency_ms: 1420,
    success: true,
    error_code: null,
    cost_alert: false,
    above_target: false,
    created_at: "2026-08-07T00:00:00.000Z",
  };

  const costRecords = (events: { emit: { mock: { calls: unknown[][] } } }) =>
    events.emit.mock.calls
      .map((c) => c[0] as { event_name: string; payload: Record<string, unknown> })
      .filter((e) => e.event_name === "ai.cost_recorded");

  it("emits ai.cost_recorded for the parse call, attributed to profile_parse", async () => {
    const { proc, events } = make({
      ...withMap(),
      parsed: { fields: {}, unparsed_field_ids: [], notes: [], ai_metadata: PARSE_META },
    });

    await proc.process(makeJob());

    const records = costRecords(events);
    expect(records).toHaveLength(1);
    expect(records[0]!.payload.task_type).toBe("profile_parse");
    expect(records[0]!.payload.estimated_cost_inr).toBe(0.19);
    expect(records[0]!.payload.tokens_in).toBe(2100);
    expect(records[0]!.payload.model).toBe("gemini-flash");
  });

  it("records BOTH calls when one job makes two — keyed on the call, not the job", async () => {
    // `idempotencyKey` used to be `ai.cost_recorded:${aiJobId}`. One job now makes two billable
    // calls, so a per-job key silently deduped the second away: the extraction record landed and
    // the parse record was dropped as a duplicate. Two distinct `ai_call_id`s must produce two
    // distinct keys.
    const extractionMeta = { ...PARSE_META, ai_call_id: "88888888-8888-4888-8888-888888888888" };
    const { proc, events } = make({
      ...withMap(),
      aiMetadata: extractionMeta,
      parsed: { fields: {}, unparsed_field_ids: [], notes: [], ai_metadata: PARSE_META },
    });

    await proc.process(makeJob());

    const records = costRecords(events);
    const keys = events.emit.mock.calls
      .map((c) => c[0] as { event_name: string; idempotencyKey?: string })
      .filter((e) => e.event_name === "ai.cost_recorded")
      .map((e) => e.idempotencyKey);
    expect(new Set(keys).size).toBe(records.length);
    expect(keys).toContain(`ai.cost_recorded:${PARSE_META.ai_call_id}`);
  });

  /**
   * #745 — the canonicalization fan-out on the SAME job.
   *
   * This is the call path the issue's first cut missed. `/skills/canonicalize` (the
   * job-posting write) was wired and this was not, so `WHERE task_type = 'skill_embedding'`
   * returned only part of the spend — and a partial ledger reads as complete, where an empty
   * one reads as "not instrumented" and invites a look. Only COUNTING the records can tell
   * the two apart, so these tests count.
   *
   * NO `withMap()` HERE, AND THAT IS THE POINT. `/profile/extract` — the route that runs the
   * canonicalization pass — is reached only when the session has no answer map (a
   * pre-cutover interview, or the "make the profile anyway" escape hatch). The OIE path
   * projects locally and calls `/profile/parse`, so it never embeds anything. Writing these
   * against `withMap()` produced a green-looking assertion of zero, which is how the first
   * draft of this test proved nothing.
   *
   * The recorder here is the REAL `AiCostRecorder` over a stubbed `EventsService`, so every
   * assertion below also proves the event validates against the registry — including the
   * `skill_embedding` task type carrying a real `ai_jobs` id.
   */
  const EMBED_META = (id: string, cost: number) => ({
    ...PARSE_META,
    ai_call_id: id,
    task_type: "skill_embedding",
    model_name: "gemini-embedding-001",
    output_tokens: 0,
    estimated_cost_inr: cost,
  });

  it("emits one ai.cost_recorded per canonicalization embed, attributed to this job", async () => {
    const { proc, events } = make({
      skillEmbedMetadata: [
        EMBED_META("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", 0.03),
        EMBED_META("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", 0.03),
        EMBED_META("cccccccc-cccc-4ccc-8ccc-cccccccccccc", 0.03),
      ],
    });

    await proc.process(makeJob());

    const embeds = costRecords(events).filter((e) => e.payload.task_type === "skill_embedding");
    // THREE, not one: a 3-label pass is 3 billable embeds. A per-pass record would
    // under-report this surface by the number of labels on every extraction that runs it.
    expect(embeds).toHaveLength(3);
    // Attributed to the extraction's own ai_jobs row — unlike the job-posting write, this
    // surface HAS one, so null would be throwing away attribution that exists.
    expect(new Set(embeds.map((e) => e.payload.ai_job_id))).toEqual(new Set([JOB.aiJobId]));
    // Distinct dedupe keys, or the fan-out collapses to one row on the way in.
    const keys = events.emit.mock.calls
      .map(
        (c) =>
          c[0] as {
            event_name: string;
            payload: Record<string, unknown>;
            idempotencyKey?: string;
          },
      )
      .filter(
        (e) => e.event_name === "ai.cost_recorded" && e.payload.task_type === "skill_embedding",
      )
      .map((e) => e.idempotencyKey);
    expect(new Set(keys).size).toBe(3);
  });

  it("emits no embed records when the canonicalization pass never ran", async () => {
    // The default posture (flag off) and the ledger-blocked path both return an empty list.
    // Empty means "nothing was attempted" — a ₹0 row here would describe an embed that
    // never happened, which is the same lie a fabricated extraction record would be.
    const { proc, events } = make();

    await proc.process(makeJob());

    expect(costRecords(events).filter((e) => e.payload.task_type === "skill_embedding")).toEqual(
      [],
    );
  });

  it("records NOTHING when the parse degraded — a zero-cost row would be a lie", async () => {
    // `ai_metadata: null` is what the route returns on a blown deadline, mock posture or a
    // spend cap. A zero-cost record is indistinguishable from a real call that was free.
    //
    // `mock_no_parse`, NOT `llm_unavailable`, and the route draws that line itself: the
    // first is a POSTURE (nothing was attempted — mock mode, a cap, the kill switch), the
    // second is an INCIDENT (every candidate was reached and every one failed). Only the
    // incident is retried, so using it here would be testing the retry path by accident
    // instead of the cost-record rule this case is about.
    const { proc, events } = make({
      ...withMap(),
      parsed: { fields: {}, unparsed_field_ids: [], notes: ["mock_no_parse"], ai_metadata: null },
    });

    await proc.process(makeJob());

    expect(costRecords(events)).toHaveLength(0);
  });

  it("records NOTHING on the final attempt of an OUTAGE either", async () => {
    // The incident twin of the case above. The final attempt writes the profile from the
    // answer map rather than leaving the worker with nothing, but no model call succeeded,
    // so there is still no spend to record.
    const { proc, events } = make({
      ...withMap(),
      parsed: { fields: {}, unparsed_field_ids: [], notes: ["llm_unavailable"], ai_metadata: null },
    });

    await proc.process(makeJob({ attemptsMade: 2, attempts: 3 }));

    expect(costRecords(events)).toHaveLength(0);
  });

  it("carries no worker text — the cost record is ids, counts and money", async () => {
    const { proc, events } = make({
      ...withMap(),
      messages: [{ direction: "inbound", bodyText: "main pune se welder hoon" }],
      parsed: { fields: {}, unparsed_field_ids: [], notes: [], ai_metadata: PARSE_META },
    });

    await proc.process(makeJob());

    const payload = JSON.stringify(costRecords(events)[0]!.payload);
    expect(payload).not.toContain("pune");
    expect(payload).not.toContain("welder");
  });
});

describe("the answer map is the profile, and the LLM is an overlay on it", () => {
  it("takes the PARSE path, not the legacy transcript re-parse", async () => {
    const { proc, ai } = make(withMap());
    await proc.process(makeJob());
    expect(ai.parseProfile).toHaveBeenCalledOnce();
    expect(ai.extractProfile).not.toHaveBeenCalled();
  });

  it("sends the answer map as the PRIMARY input, with the transcript indexed beside it", async () => {
    const { proc, ai } = make({
      ...withMap(),
      messages: [
        { direction: "inbound", bodyText: "silai ka kaam karta hoon" },
        { direction: "outbound", bodyText: "Aap kis sheher mein rehte hain?" },
      ],
    });
    await proc.process(makeJob());
    const body = ai.parseProfile.mock.calls[0]![0] as {
      answer_map: unknown[];
      transcript: { i: number; role: string }[];
      occupation: { job_domain_id: string };
      target_fields: { field_id: string }[];
    };
    expect(body.answer_map).toHaveLength(3);
    // INDEXES ARE POSITIONS IN THIS ARRAY. `evidence.message_index` points into it, and
    // the gates check the quote against it — so the two must be the same array.
    expect(body.transcript.map((m) => m.i)).toEqual([0, 1]);
    expect(body.occupation.job_domain_id).toBe(PIN.job_domain_id);
    // Gate 5 is only as closed as this list.
    expect(body.target_fields.map((f) => f.field_id)).toContain("salary_expected");
  });

  it("a NULL parse still produces a real profile — the fail-closed guarantee", async () => {
    // The whole point of normalizing at CAPTURE time. LLM down, blocked, or mis-shaped:
    // one outcome, and the worker still gets a profile.
    const { proc, profiles } = make(withMap());
    const res = await proc.process(makeJob());
    expect(res).toEqual({ profile_id: PROFILE });
    const row = profiles.create.mock.calls[0]![0] as Record<string, unknown>;
    const rich = row.richProfileDraft as Record<string, unknown>;
    expect(rich.primary_role).toBe("darzi");
    expect(rich.current_city).toBe("Pune");
    expect(rich.experience_years).toBe(7);
  });

  it("THE PIN IS THE MATCH — no second classifier reads the same transcript", async () => {
    const { proc, profiles, skills } = make(withMap());
    await proc.process(makeJob());
    const row = profiles.create.mock.calls[0]![0] as Record<string, unknown>;
    expect(row.jobDomainId).toBe(PIN.job_domain_id);
    expect(row.jobDomainMatchStatus).toBe("matched_lexical");
    // ...and `isSelectableDomain` is STILL the last hallucination wall, pinned or not.
    expect(skills.isSelectableDomain).toHaveBeenCalledWith(PIN.job_domain_id);
  });

  it("a pin the catalogue no longer accepts is recorded UNMATCHED, never written", async () => {
    const { proc, profiles } = make({ ...withMap(), domainSelectable: false });
    await proc.process(makeJob());
    const row = profiles.create.mock.calls[0]![0] as Record<string, unknown>;
    expect(row.jobDomainId).toBeUndefined();
    expect(row.jobDomainMatchStatus).toBe("unmatched_llm_declined");
  });

  it("falls back to the legacy re-parse for a session with no answer map", async () => {
    // A pre-cutover interview, or one where the worker never said anything capturable.
    // There is no flag here: the branch is a property of the DATA, so it drains to zero.
    const { proc, ai } = make({ conversationState: { answer_map: [], occupation: null } });
    await proc.process(makeJob());
    expect(ai.extractProfile).toHaveBeenCalledOnce();
    expect(ai.parseProfile).not.toHaveBeenCalled();
  });

  it("a failed conversation_state read degrades to the legacy path, never fails the job", async () => {
    const { proc, ai } = make({ sessionThrows: true });
    const res = await proc.process(makeJob());
    expect(res).toEqual({ profile_id: PROFILE });
    expect(ai.extractProfile).toHaveBeenCalledOnce();
  });

  it("drops an answer record the contract cannot parse, keeping the rest", async () => {
    // The column is jsonb written by a possibly-older build. One stale field must cost
    // that field, never "this worker has no answers at all".
    const { proc, ai } = make({
      conversationState: {
        answer_map: [record(), { question_key: 42, status: "nonsense" }],
        occupation: PIN,
      },
    });
    await proc.process(makeJob());
    const body = ai.parseProfile.mock.calls[0]![0] as {
      answer_map: unknown[];
    };
    expect(body.answer_map).toHaveLength(1);
  });

  it("applies the SECOND WALL: a hallucinated field never reaches the profile", async () => {
    // The ai-service already gated this; running the gates again here is the double-wall
    // discipline, and the two walls fail independently (version skew, a rewriting proxy).
    const { proc, profiles } = make({
      ...withMap(),
      messages: [{ direction: "inbound", bodyText: "silai ka kaam karta hoon" }],
      parsed: {
        fields: {
          salary_expected: {
            value: 45000,
            // A quote that appears NOWHERE in the transcript. Gate 1 has nothing to
            // anchor it to, which is precisely why a fabricated value cannot survive.
            evidence: { message_index: 0, quote: "pentaalis hazaar mahina" },
            source: "transcript",
            normalization: "numeric",
            confidence: 0.9,
          },
        },
        unparsed_field_ids: [],
        notes: [],
      },
    });
    await proc.process(makeJob());
    const row = profiles.create.mock.calls[0]![0] as Record<string, unknown>;
    const rich = row.richProfileDraft as Record<string, unknown>;
    expect(rich.expected_salary).toBeNull();
  });

  it("emits profile.parse_disagreement with FIELD IDS AND COUNTS — never a value", async () => {
    const { proc, events } = make({
      ...withMap(),
      messages: [{ direction: "inbound", bodyText: "silai ka kaam karta hoon, main darzi hoon" }],
      parsed: {
        fields: {
          // Contradicts the deterministic map, which holds "darzi", and quotes a real span.
          trade: {
            value: "welder",
            evidence: { message_index: 0, quote: "silai ka kaam karta hoon" },
            source: "answer_map",
            normalization: "verbatim",
            confidence: 0.9,
          },
        },
        unparsed_field_ids: [],
        notes: [],
      },
    });
    await proc.process(makeJob());
    const emit = events.emit.mock.calls
      .map((c) => c[0] as { event_name: string; payload: Record<string, unknown> })
      .find((e) => e.event_name === "profile.parse_disagreement");
    expect(emit).toBeDefined();
    expect(emit!.payload.field_ids).toEqual(["trade"]);
    const serialized = JSON.stringify(emit!.payload);
    expect(serialized).not.toContain("welder");
    expect(serialized).not.toContain("darzi");
  });

  it("emits profile.parse_gates_rejected with PER-GATE COUNTS — never the field it threw away", async () => {
    const { proc, events } = make({
      ...withMap(),
      messages: [{ direction: "inbound", bodyText: "silai ka kaam karta hoon" }],
      parsed: {
        fields: {
          // A quote that appears in NO transcript line: gate 1 (provenance) rejects it. This is
          // the strongest gate — a hallucinated value has no span to point at.
          current_city: {
            value: "Pune",
            evidence: { message_index: 0, quote: "main Pune me rehta hoon" },
            source: "transcript",
            normalization: "verbatim",
            confidence: 0.9,
          },
        },
        unparsed_field_ids: [],
        notes: [],
      },
    });
    await proc.process(makeJob());
    const emit = events.emit.mock.calls
      .map((c) => c[0] as { event_name: string; payload: Record<string, unknown> })
      .find((e) => e.event_name === "profile.parse_gates_rejected");

    expect(emit).toBeDefined();
    expect(emit!.payload.rejected_count).toBe(1);
    expect((emit!.payload.by_gate as Record<string, number>).provenance).toBe(1);
    // Neither the invented value nor the field it claimed to fill appears anywhere.
    const serialized = JSON.stringify(emit!.payload);
    expect(serialized).not.toContain("Pune");
    expect(serialized).not.toContain("current_city");
  });

  it("emits NO gate-rejection event when the whole wall passed", async () => {
    // The healthy case is the overwhelming majority; one row per extraction to say "zero" is
    // exactly the write amplification risk #9 warns about.
    const { proc, events } = make(withMap());
    await proc.process(makeJob());
    expect(
      events.emit.mock.calls.map((c) => (c[0] as { event_name: string }).event_name),
    ).not.toContain("profile.parse_gates_rejected");
  });

  it("does not emit a disagreement when the model and the map agree", async () => {
    const { proc, events } = make(withMap());
    await proc.process(makeJob());
    const names = events.emit.mock.calls.map((c) => (c[0] as { event_name: string }).event_name);
    expect(names).not.toContain("profile.parse_disagreement");
  });
});

// ---------------------------------------------------------------------------
// An unreachable model is an INCIDENT, not an empty interview
// ---------------------------------------------------------------------------
//
// THE LOOP THIS CLOSES. A 429 used to arrive here indistinguishable from a worker who
// said nothing: empty overlay, `blocked: false`, job marked `completed`. Because nothing
// threw, BullMQ's `attempts` never engaged — the retry machinery sat dormant for the one
// failure mode it was needed for — and every dedupe guard read the empty profile as "not
// profiled yet", so the next of four triggers started a fresh extraction. 429 -> empty
// profile -> not profiled -> extract -> 429, each pass putting a full retry chain back on
// the wire.

describe("an LLM outage retries instead of completing", () => {
  const OUTAGE_PARSE = {
    fields: {},
    unparsed_field_ids: [],
    notes: ["llm_unavailable"],
    ai_metadata: null,
  };
  /** A healthy parse call's usage — the shape a SUCCESSFUL model leg reports. */
  const HEALTHY_META = {
    ai_call_id: "77777777-7777-4777-8777-777777777777",
    task_type: "profile_parse",
    model_name: "gemini-flash",
    provider: "google",
    real_call: true,
    input_tokens: 2100,
    output_tokens: 240,
    estimated_cost_inr: 0.19,
    latency_ms: 1420,
    success: true,
    error_code: null,
    created_at: "2026-08-08T00:00:00.000Z",
  };

  it("throws so BullMQ retries, and writes NOTHING while attempts remain", async () => {
    const { proc, profiles, aiJobs, workerAttributes } = make({
      ...withMap(),
      parsed: OUTAGE_PARSE,
    });

    await expect(proc.process(makeJob({ attemptsMade: 0, attempts: 3 }))).rejects.toThrow(
      "llm unavailable",
    );

    // BEFORE any write. A retry that has written nothing has nothing to reconcile — and a
    // profile row that exists only because the model was down is the exact artifact that
    // taught the dedupe guards to re-fire.
    expect(profiles.create).not.toHaveBeenCalled();
    expect(workerAttributes.upsertMany).not.toHaveBeenCalled();
    expect(aiJobs.markCompleted).not.toHaveBeenCalled();
  });

  it("a null parse is a transport failure, not an LLM outage — it completes on attempt 1, not a 5-15 minute retry ladder", async () => {
    // THE BUG THIS PINS DOWN. `AiService.parseProfile` returns `null` on exactly one class
    // of event: the call never came back — a non-OK response, our own 25s abort, or an
    // off-contract body. That collapses two very different situations into one signal this
    // side cannot tell apart: "the ai-service is up but this one call misbehaved" and "the
    // ai-service process was never reachable at all" (nothing listening on the port —
    // exactly what apps/api's e2e CI job does on purpose, per its "AI service is
    // intentionally NOT started" comment).
    //
    // This USED TO throw `LlmUnavailableError("parse_service_unreachable")` here, which
    // BullMQ retries on `EXTRACTION_JOB_OPTS`'s 5-then-10-minute backoff — a ladder sized
    // for a provider RATE LIMIT clearing on a timer (that docstring's own words: "THIS IS
    // NOT WHAT BOUNDS THE STORM"), not for an endpoint with no listener at all. A worker
    // whose interview had already finished sat with `ai_jobs.status = "running"` for the
    // full ladder before the third, final attempt wrote the profile anyway — the exact
    // outcome attempt 1 could have produced immediately.
    //
    // Consistent with the legacy `extract_service_unreachable` leg (`outageCodeOf` already
    // narrowed that one to null): a transport failure completes on the FIRST attempt, from
    // the answer map alone, exactly like a healthy parse that simply found nothing.
    const { proc, profiles, aiJobs } = make({ ...withMap(), parsed: null });

    const res = await proc.process(makeJob({ attemptsMade: 0, attempts: 3 }));

    expect(res).toEqual({ profile_id: PROFILE });
    expect(profiles.create).toHaveBeenCalledOnce();
    expect(aiJobs.markCompleted).toHaveBeenCalled();
  });

  it("does NOT retry when the parse failed but Phase C's overlay landed", async () => {
    // THE LIVE DEFECT, session `38f9fde8`. `/profile/parse` blew its deadline while
    // `/profiling/extract` returned a complete nine-key object with two `experiences[]` entries
    // — and the retry read only the parse, threw before the write, and discarded the successful
    // overlay. Three attempts, two of them billed at Rs 0.226, and the worker ended with no
    // `worker_profiles` row at all.
    //
    // ATTEMPT 0 OF 3 on purpose: attempts remain, so the ONLY thing that can stop the throw is
    // the landed overlay. Written as a positive assertion on `experiences[]` rather than just
    // "did not throw", because a retry that silently dropped the entries would still resolve.
    const { proc, profiles, aiJobs } = make({
      ...withMap(),
      parsed: {
        fields: {},
        unparsed_field_ids: [],
        notes: ["parse_deadline_exceeded"],
        ai_metadata: null,
      },
      llmInterview: true,
      messages: [
        { direction: "outbound", bodyText: "Aap kaunsa kaam karte hain?" },
        { direction: "inbound", bodyText: "cnc operator hu, 3 saal" },
      ],
      interview: {
        domain_label: "CNC machining",
        role_label: "CNC operator",
        skills: ["CNC turning"],
        experiences: [
          {
            role_label: "CNC operator",
            duration_text: "3 saal",
            duration_months: 36,
            work_done: "parts banaye",
          },
        ],
        shift: null,
        current_city: null,
        preferred_locations: [],
        availability: null,
        expected_salary: null,
        blocked: false,
        is_mock: false,
        ai_metadata: null,
      },
    });

    const res = await proc.process(makeJob({ attemptsMade: 0, attempts: 3 }));

    expect(res).toEqual({ profile_id: PROFILE });
    expect(aiJobs.markCompleted).toHaveBeenCalled();
    const raw = (profiles.create.mock.calls[0]![0] as { rawProfile: DraftProfile }).rawProfile;
    expect(raw.experiences).toHaveLength(1);
    expect(raw.experiences?.[0]?.role_label).toBe("CNC operator");
  });

  it("still retries when the parse failed and Phase C produced nothing either", async () => {
    // The veto is about HOLDING model output, not about the flag being on. With both legs down
    // there is nothing to preserve and the original retry is exactly right — otherwise this
    // change would quietly disable the retry for every LLM-led interview.
    const { proc, profiles } = make({
      ...withMap(),
      parsed: OUTAGE_PARSE,
      llmInterview: true,
      messages: [
        { direction: "outbound", bodyText: "Aap kaunsa kaam karte hain?" },
        { direction: "inbound", bodyText: "cnc operator hu" },
      ],
      interview: null,
    });

    await expect(proc.process(makeJob({ attemptsMade: 0, attempts: 3 }))).rejects.toThrow(
      "llm unavailable",
    );
    expect(profiles.create).not.toHaveBeenCalled();
  });

  it("still retries when Phase C answered with an EMPTY overlay (its own degrade shape)", async () => {
    // THE MIRROR OF THE BUG ABOVE, and the reason the veto tests CONTENT rather than presence.
    //
    // `interview: null` (the test above) is only the UNREACHABLE case. The ai-service answers
    // three of its own degrades with a healthy 200 carrying `InterviewExtractOutput(is_mock=
    // True)` — every field empty and `blocked` FALSE by default:
    //
    //   - its own Phase C deadline breach, which is exactly the case this PR raises the
    //     deadline for, so precisely the one in play;
    //   - mock mode (`not meta.real_call`) — TD81: staging runs mocked AI;
    //   - "interview extract output failed the contract", i.e. the model returned garbage.
    //
    // Read as presence, all three say "the interview landed" while holding nothing, and the
    // veto then suppresses the retry in the one situation the retry exists for: no overlay, no
    // parse, nothing to write but the answer map. This is the exact object those paths return.
    const { proc, profiles } = make({
      ...withMap(),
      parsed: OUTAGE_PARSE,
      llmInterview: true,
      messages: [
        { direction: "outbound", bodyText: "Aap kaunsa kaam karte hain?" },
        { direction: "inbound", bodyText: "cnc operator hu" },
      ],
      interview: {
        domain_label: null,
        role_label: null,
        skills: [],
        experiences: [],
        shift: null,
        current_city: null,
        preferred_locations: [],
        availability: null,
        expected_salary: null,
        blocked: false,
        is_mock: true,
        ai_metadata: null,
      },
    });

    await expect(proc.process(makeJob({ attemptsMade: 0, attempts: 3 }))).rejects.toThrow(
      "llm unavailable",
    );
    expect(profiles.create).not.toHaveBeenCalled();
  });

  it("vetoes the retry for a THIN overlay — one field is still model work a retry cannot beat", async () => {
    // The bar is "carries values", not "carries experiences[]". A short interview that yielded
    // only a domain label is still a capable call whose answer a re-run would just re-buy, and
    // the deterministic projection underneath it is unaffected either way.
    const { proc, profiles, aiJobs } = make({
      ...withMap(),
      parsed: OUTAGE_PARSE,
      llmInterview: true,
      messages: [
        { direction: "outbound", bodyText: "Aap kaunsa kaam karte hain?" },
        { direction: "inbound", bodyText: "cnc operator hu" },
      ],
      interview: {
        domain_label: "CNC machining",
        role_label: null,
        skills: [],
        experiences: [],
        shift: null,
        current_city: null,
        preferred_locations: [],
        availability: null,
        expected_salary: null,
        blocked: false,
        is_mock: false,
        ai_metadata: null,
      },
    });

    await expect(proc.process(makeJob({ attemptsMade: 0, attempts: 3 }))).resolves.toEqual({
      profile_id: PROFILE,
    });
    expect(aiJobs.markCompleted).toHaveBeenCalled();
    expect(profiles.create).toHaveBeenCalled();
  });

  it("on the FINAL attempt it writes the profile from the answer map rather than nothing", async () => {
    // The posture `ProfilesService.extract` already documents: "being wrong in that
    // direction leaves a worker with no profile at all — strictly worse". The deterministic
    // projection is the bulk of the value; the parse is an overlay on top of it.
    const { proc, profiles, aiJobs } = make({ ...withMap(), parsed: OUTAGE_PARSE });

    const res = await proc.process(makeJob({ attemptsMade: 2, attempts: 3 }));

    expect(res).toEqual({ profile_id: PROFILE });
    expect(profiles.create).toHaveBeenCalledOnce();
    expect(aiJobs.markCompleted).toHaveBeenCalled();
  });

  it("a SPEND CAP is a decision, not an outage — it completes, it does not retry", async () => {
    // The distinction that keeps this from retrying money away. A cap does not heal on a
    // timer, so re-running in five minutes would spend against a ledger that has already
    // refused — and `AI_SPEND_CAP_REASONS` keeps its existing `ai.spend_cap` treatment.
    const { proc, profiles } = make({
      ...withMap(),
      parsed: {
        fields: {},
        unparsed_field_ids: [],
        notes: [],
        ai_metadata: { ...HEALTHY_META, error_code: "daily_cap_exceeded" },
      },
    });

    await proc.process(makeJob({ attemptsMade: 0, attempts: 3 }));
    expect(profiles.create).toHaveBeenCalledOnce();
  });

  it("a healthy parse that simply found nothing is NOT an outage", async () => {
    // The other half of the split, and the regression this must never undo: a worker who
    // genuinely said little still gets their profile written on the first attempt.
    const { proc, profiles } = make({
      ...withMap(),
      parsed: { fields: {}, unparsed_field_ids: [], notes: [], ai_metadata: HEALTHY_META },
    });

    await proc.process(makeJob({ attemptsMade: 0, attempts: 3 }));
    expect(profiles.create).toHaveBeenCalledOnce();
  });
});

/**
 * PHASE C — the conversation itself, read once, for what the answer map cannot hold.
 *
 * `experiences[]` is the whole reason this call exists. A pack asks its fixed question once, so
 * a worker with three jobs has three different answers to "what did you do" and the answer map
 * has room for one. That list only exists in the transcript.
 *
 * EVERY CASE HERE IS ALSO A FAIL-CLOSED CASE. The profile that comes out when this call fails
 * must be exactly the profile the answer map alone produces — an overlay is never the profile.
 */
describe("the interview overlay (Phase C)", () => {
  const ENTRY = {
    role_label: "tandoor cook",
    duration_text: "3 saal",
    duration_months: 36,
    work_done: "naan, roti",
  };
  const EXTRACT = (over: Record<string, unknown> = {}) => ({
    domain_label: "cooking",
    role_label: "tandoor cook",
    skills: [],
    experiences: [ENTRY],
    shift: null,
    current_city: null,
    preferred_locations: [],
    availability: null,
    expected_salary: null,
    blocked: false,
    is_mock: false,
    ai_metadata: null,
    ...over,
  });
  // A REAL CONVERSATION IS REQUIRED. `interviewOverlay` returns before the network when the
  // transcript is empty — an extraction with nothing said would otherwise spend a capable call to
  // be told so. Every case below therefore carries messages, or it tests the guard instead.
  const CHAT = [
    { direction: "outbound", bodyText: "Aap kaunsa kaam karte hain?" },
    { direction: "inbound", bodyText: "cook hu, tandoor pe 3 saal" },
    { direction: "outbound", bodyText: "Aur koi experience jodna hai?" },
    { direction: "inbound", bodyText: "nahi" },
  ];
  const rawOf = (profiles: { create: { mock: { calls: unknown[][] } } }): DraftProfile =>
    (profiles.create.mock.calls[0]![0] as { rawProfile: DraftProfile }).rawProfile;

  it("does not call the model at all while the flag is off", async () => {
    // The OIE cutover's economics are "twelve capable calls became one". Turning that one into
    // two is a trade that belongs to the LLM-led interview, not to every worker.
    // WITH A REAL CONVERSATION ON PURPOSE. Without messages this would pass on the
    // empty-transcript guard even if the flag check were deleted — the assertion has to be about
    // the FLAG, not about there being nothing to read.
    const { proc, ai } = make({ ...withMap(), messages: CHAT });
    await proc.process(makeJob());
    expect(ai.extractInterview).not.toHaveBeenCalled();
  });

  it("does not call the model when nothing was said, even with the flag on", async () => {
    // The app's "make the profile anyway" escape hatch reaches here with no transcript. A
    // capable call to be told the conversation was empty is spend for nothing.
    const { proc, ai } = make({ ...withMap(), messages: [], llmInterview: true });
    await proc.process(makeJob());
    expect(ai.extractInterview).not.toHaveBeenCalled();
  });

  it("lands `experiences[]` on the stored profile — the thing no pack question can produce", async () => {
    const { proc, profiles } = make({
      ...withMap(),
      messages: CHAT,
      llmInterview: true,
      interview: EXTRACT(),
    });
    await proc.process(makeJob());
    expect(rawOf(profiles).experiences).toEqual([ENTRY]);
  });

  it("still writes a profile when the interview call is unreachable", async () => {
    // FAIL CLOSED (§3): the answer map alone is already a usable profile, and an overlay that
    // could not be fetched must cost the overlay and nothing else.
    const { proc, profiles } = make({
      ...withMap(),
      messages: CHAT,
      llmInterview: true,
      interview: null,
    });
    await proc.process(makeJob());
    expect(profiles.create).toHaveBeenCalledOnce();
    expect(rawOf(profiles).experiences).toEqual([]);
    // The deterministic values are untouched by the failure.
    expect(rawOf(profiles).experience.total_years).toBe(7);
  });

  it("drops a BLOCKED overlay rather than storing it", async () => {
    // `blocked` means the pseudonymizer refused the transcript. That is a definitive "do not
    // store this", not an outage — and it must not reach a column.
    const { proc, profiles } = make({
      ...withMap(),
      messages: CHAT,
      llmInterview: true,
      interview: EXTRACT({ blocked: true }),
    });
    await proc.process(makeJob());
    expect(rawOf(profiles).experiences).toEqual([]);
  });

  /**
   * ── THE RÉSUMÉ CONTAINER IS WRITTEN FROM CONTENT, NOT FROM PRESENCE ───────────────────
   *
   * `resume_profile` is the résumé's ONLY input once it exists, so storing a hollow one does
   * not degrade the résumé — it BLANKS it. The renderer reads the container instead of the
   * answer-map profile, and an empty container renders a PDF carrying nothing but the worker's
   * name: generated successfully, and blank.
   *
   * The hollow object is the ai-service's own degrade shape, not a hypothetical: four paths in
   * `routers/profiling.py` return `InterviewExtractOutput(is_mock=True)` with `blocked` false,
   * and `not meta.real_call` is one of them — i.e. EVERY mocked environment, staging included
   * (TD81). So this is the ordinary case there, not the rare one.
   */
  it("writes NO container when the overlay came back empty", async () => {
    const { proc, profiles } = make({
      ...withMap(),
      messages: CHAT,
      llmInterview: true,
      interview: EXTRACT({
        domain_label: null,
        role_label: null,
        experiences: [],
        is_mock: true,
      }),
    });
    await proc.process(makeJob());
    // Null, NOT an empty object: null is what the renderer reads as "there was no interview,
    // use the answer-map profile", and it is the only value that keeps the worker's résumé.
    expect(rawOf(profiles).resume_profile).toBeNull();
  });

  it("leaves the legacy fields exactly as an unreachable overlay would", async () => {
    // The guard nulls the CONTAINER and must touch nothing else. `preferModel`,
    // `preferModelList` and `availabilityOf` already treat an empty overlay as no overlay, so
    // an empty response and an absent one have to produce byte-identical deterministic fields.
    const empty = make({
      ...withMap(),
      messages: CHAT,
      llmInterview: true,
      interview: EXTRACT({ domain_label: null, role_label: null, experiences: [], is_mock: true }),
    });
    const absent = make({ ...withMap(), messages: CHAT, llmInterview: true, interview: null });
    await empty.proc.process(makeJob());
    await absent.proc.process(makeJob());
    expect(rawOf(empty.profiles)).toEqual(rawOf(absent.profiles));
  });

  it("writes the container the moment the overlay carries ANY value", async () => {
    // The bar is the same one `interviewLanded` uses — "carries values", not "carries
    // experiences[]". A short interview that yielded only a domain label is still a real record
    // of a real interview, and the résumé is still built from it one-for-one.
    const { proc, profiles } = make({
      ...withMap(),
      messages: CHAT,
      llmInterview: true,
      interview: EXTRACT({ role_label: null, experiences: [] }),
    });
    await proc.process(makeJob());
    expect(rawOf(profiles).resume_profile).toMatchObject({ domain_label: "cooking" });
  });

  it("stores the container as the Phase C object, one-for-one", async () => {
    // The property the container exists for: a reader can diff it against the Langfuse
    // assistant message and expect equality. The guard above decides WHETHER to store it and
    // must never change WHAT is stored.
    const { proc, profiles } = make({
      ...withMap(),
      messages: CHAT,
      llmInterview: true,
      interview: EXTRACT({ current_city: "Mumbai", skills: ["tandoor"], expected_salary: 22000 }),
    });
    await proc.process(makeJob());
    expect(rawOf(profiles).resume_profile).toEqual({
      domain_label: "cooking",
      role_label: "tandoor cook",
      skills: ["tandoor"],
      experiences: [ENTRY],
      shift: null,
      current_city: "Mumbai",
      preferred_locations: [],
      availability: null,
      expected_salary: 22000,
    });
  });

  it("lets the model's value win over the one the worker answered", async () => {
    // THIS ASSERTED THE OPPOSITE UNTIL 2026-08-12, and the reversal is an explicit owner
    // decision (Divyanshu), not a drift: the stored profile must equal the Phase C object as
    // traced in Langfuse, and under first-write-wins "Mumbai" was discarded because the answer
    // map held "Pune". The cost is stated on `preferModel` — a value that skipped the city
    // normalizer and the negation veto now outranks one that went through both.
    const { proc, profiles } = make({
      ...withMap(),
      messages: CHAT,
      llmInterview: true,
      interview: EXTRACT({ current_city: "Mumbai", expected_salary: 99000 }),
    });
    await proc.process(makeJob());
    expect(rawOf(profiles).location_preference.current_city).toBe("Mumbai");
    expect(rawOf(profiles).salary_expectation.amount_min).toBe(99000);
  });

  it("replaces but never erases — a silent model yields to the answer map", async () => {
    // THE BOUND ON THE REVERSAL ABOVE. `preferModel` falls through on null/absent, so a Phase C
    // response that simply did not mention the city cannot blank a value the worker gave. Without
    // this, "the model wins" would read as "the model's nulls win" and every quiet field would
    // erase a real answer — the degraded Phase C response is mostly nulls.
    const { proc, profiles } = make({
      ...withMap(),
      messages: CHAT,
      llmInterview: true,
      interview: EXTRACT({ current_city: null }),
    });
    await proc.process(makeJob());
    expect(rawOf(profiles).location_preference.current_city).toBe("Pune");
  });

  it("lands the four keys the merge used to discard", async () => {
    // `domain_label`, `role_label` and `shift` had ZERO readers in the processor, and
    // `availability` was read off the answer map only. Four of the model's nine data keys were
    // prompted for, billed for, validated and dropped — most of the gap between the Langfuse
    // assistant response and the stored row.
    const { proc, profiles } = make({
      ...withMap(),
      messages: CHAT,
      llmInterview: true,
      interview: EXTRACT({
        domain_label: "cooking",
        role_label: "tandoor cook",
        shift: "night",
        availability: "immediate",
      }),
    });
    await proc.process(makeJob());
    const raw = rawOf(profiles);
    expect(raw.domain_label).toBe("cooking");
    expect(raw.role_label).toBe("tandoor cook");
    expect(raw.shift).toBe("night");
    expect(raw.availability.status).toBe("immediate");
  });

  it("maps the model's notice-period vocabulary instead of throwing on it", async () => {
    // THE ONE THAT WOULD HAVE COST THE WHOLE PROFILE. The extract prompt asks for `15_days` /
    // `1_month`; `AvailabilitySchema.status` accepts neither. Assigned raw, `DraftProfileSchema
    // .parse` throws INSIDE the job and the worker gets nothing — strictly worse than the
    // dropped field this change set out to fix. The notice LENGTH is preserved, not flattened.
    const { proc, profiles } = make({
      ...withMap(),
      messages: CHAT,
      llmInterview: true,
      interview: EXTRACT({ availability: "1_month" }),
    });
    await proc.process(makeJob());
    expect(profiles.create).toHaveBeenCalledOnce();
    expect(rawOf(profiles).availability).toEqual({
      status: "notice_period",
      notice_period_days: 30,
    });
  });

  it("yields to the deterministic status on an availability value it does not know", async () => {
    // The wire type is a bare `str | None` with no Literal behind it, so the model can return
    // anything at all. Unrecognised must mean "the answer map decides", never a throw and never
    // an invented status.
    const { proc, profiles } = make({
      ...withMap(),
      messages: CHAT,
      llmInterview: true,
      interview: EXTRACT({ availability: "rotational-ish" }),
    });
    await proc.process(makeJob());
    expect(rawOf(profiles).availability.status).toBe("unknown");
  });

  it("fills a gap the deterministic map left empty", async () => {
    // Unchanged by the precedence reversal — with nothing on the answer map to outrank, both
    // rules agree here. Kept because it pins the fallback direction independently of `preferModel`.
    const { proc, profiles } = make({
      ...withMap(),
      messages: CHAT,
      llmInterview: true,
      interview: EXTRACT({ expected_salary: 18000, preferred_locations: ["Mumbai"] }),
    });
    await proc.process(makeJob());
    expect(rawOf(profiles).salary_expectation.amount_min).toBe(18000);
    expect(rawOf(profiles).location_preference.preferred_cities).toEqual(["Mumbai"]);
  });

  it("stores the model's skill list verbatim rather than a union with the answer map", async () => {
    // WAS A UNION, which made `skill_labels` a superset in answer-map-first order — so it never
    // equalled the traced array even when every entry the model produced was present. Exact
    // equality is the assertion that matters here; `arrayContaining` passed under both rules.
    const { proc, profiles } = make({
      ...withMap(),
      messages: CHAT,
      llmInterview: true,
      interview: EXTRACT({ skills: ["tandoor", "naan"] }),
    });
    await proc.process(makeJob());
    expect(rawOf(profiles).skill_labels).toEqual(["tandoor", "naan"]);
  });

  it("keeps the answer map's skills when the model returned none", async () => {
    // AN EMPTY LIST IS THE SHAPE OF EVERY DEGRADED PHASE C RESPONSE, not an assertion that the
    // worker has no skills. Letting [] win would make a provider blip erase confirmed skills.
    const { proc, profiles } = make({
      ...withMap({
        answer_map: [
          record({ question_key: "skills", target_field: "skills", value_normalized: ["welding"] }),
        ],
      }),
      messages: CHAT,
      llmInterview: true,
      interview: EXTRACT({ skills: [] }),
    });
    await proc.process(makeJob());
    expect(rawOf(profiles).skill_labels).toEqual(["welding"]);
  });

  it("ledgers the call's spend, so a second billable request is not silently free", async () => {
    const meta = {
      ai_call_id: "66666666-6666-4666-8666-666666666666",
      task_type: "profile_extraction",
      model_name: "gemini-2.5-pro",
      provider: "google",
      real_call: true,
      input_tokens: 900,
      output_tokens: 120,
      estimated_cost_inr: 0.41,
      latency_ms: 2100,
      success: true,
      created_at: "2026-08-11T12:00:00.000Z",
    };
    const { proc, events } = make({
      ...withMap(),
      messages: CHAT,
      llmInterview: true,
      interview: EXTRACT({ ai_metadata: meta }),
    });
    await proc.process(makeJob());
    const costs = events.emit.mock.calls
      .map((c) => c[0] as { event_name: string; payload: { ai_call_id?: string } })
      .filter((e) => e.event_name === "ai.cost_recorded");
    expect(costs.some((e) => e.payload.ai_call_id === meta.ai_call_id)).toBe(true);
  });
});
