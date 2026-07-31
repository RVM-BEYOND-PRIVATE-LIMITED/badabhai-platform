import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { DraftProfileSchema, WorkerProfileDraftSchema } from "@badabhai/ai-contracts";
import { SKILL_TAXONOMY_VERSION } from "@badabhai/taxonomy";
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
  };
  const events = { emit: vi.fn().mockResolvedValue(undefined) };
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
    extractProfile: opts.extractThrows
      ? vi.fn().mockRejectedValue(new Error("boom"))
      : vi
          .fn()
          .mockResolvedValue({
            profile: draft,
            blocked: opts.blocked ?? false,
            // The ai-service sets `is_mock = not meta.real_call`, so this is TRUE for a
            // perfectly healthy extraction whenever AI_ENABLE_REAL_CALLS=false (the
            // committed default). Left true across the T3 cases on purpose — it is the
            // signal profile_status must NOT be derived from.
            is_mock: true,
            ai_metadata: opts.aiMetadata ?? null,
            // Issue #419 — the response has always carried the rich draft; `undefined`
            // here reproduces an AI service that omits it entirely.
            worker_profile_draft: opts.richDraft,
          }),
  };
  // ADR-0036 moments ①/②. `rebuildQuietly` is the ONLY method the processor calls, and
  // it is contractually never-throwing — so a stub that resolves is the honest double.
  // The "a rebuild failure must not fail the extraction" property is asserted by its own
  // case below with a REJECTING stub, not assumed from this one.
  const matchSkills = { rebuildQuietly: vi.fn().mockResolvedValue(undefined) };
  const proc = new ProfileExtractionProcessor(
    profiles as never,
    aiJobs as never,
    chat as never,
    events as never,
    ai as never,
    workers as never,
    pii as never,
    matchSkills as never,
  );
  return { proc, profiles, aiJobs, chat, events, ai, workers, pii, matchSkills };
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
    expect(aiJobs.markCompleted).toHaveBeenCalledWith(JOB.aiJobId, { profile_id: PROFILE }, undefined);
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
      { modelName: "gpt-4o-mini", realCall: true, inputTokens: 1200, outputTokens: 300, totalTokens: 1500, costInr: 0.42 },
    );

    // (2) ai.cost_recorded emitted with the same metadata (after extraction_completed).
    const costEvent = events.emit.mock.calls.map((c) => c[0]).find((e) => e.event_name === "ai.cost_recorded");
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
    const capEvent = events.emit.mock.calls.map((c) => c[0]).find((e) => e.event_name === "ai.spend_cap_exceeded");
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
    expect(ai.extractProfile).toHaveBeenCalledWith({
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
    });
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

    expect(ai.extractProfile).toHaveBeenCalledWith({
      worker_ref: JOB.workerId,
      // The placeholder the AI service has always received for an empty session.
      transcript: "(no conversation captured)",
      messages: [],
    });
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
    expect(aiJobs.markCompleted).toHaveBeenCalledWith(JOB.aiJobId, { profile_id: PROFILE }, undefined);
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
