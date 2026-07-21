import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { DraftProfileSchema } from "@badabhai/ai-contracts";
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
  } = {},
) {
  const draft = DraftProfileSchema.parse({});
  const profiles = { create: vi.fn().mockResolvedValue({ id: PROFILE }) };
  const aiJobs = {
    findById: vi.fn().mockResolvedValue(opts.findById ?? undefined),
    markRunning: vi.fn().mockResolvedValue(undefined),
    markCompleted: vi.fn().mockResolvedValue(undefined),
    markFailed: vi.fn().mockResolvedValue(undefined),
  };
  const chat = { listMessages: vi.fn().mockResolvedValue([]) };
  const events = { emit: vi.fn().mockResolvedValue(undefined) };
  const ai = {
    extractProfile: opts.extractThrows
      ? vi.fn().mockRejectedValue(new Error("boom"))
      : vi
          .fn()
          .mockResolvedValue({
            profile: draft,
            blocked: false,
            is_mock: true,
            ai_metadata: opts.aiMetadata ?? null,
            // Issue #419 — the response has always carried the rich draft; `undefined`
            // here reproduces an AI service that omits it entirely.
            worker_profile_draft: opts.richDraft,
          }),
  };
  const proc = new ProfileExtractionProcessor(
    profiles as never,
    aiJobs as never,
    chat as never,
    events as never,
    ai as never,
  );
  return { proc, profiles, aiJobs, chat, events, ai };
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
    // …and every turn of the conversation reached the extraction call.
    expect(ai.extractProfile).toHaveBeenCalledWith({
      worker_ref: JOB.workerId,
      transcript: [
        "Bada Bhai: Kaunsa kaam karte ho?",
        "Worker: VMC operator, 5 saal",
        "Bada Bhai: Kaunsi city me ho?",
        "Worker: Pune me hoon",
      ].join("\n"),
    });
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
});
