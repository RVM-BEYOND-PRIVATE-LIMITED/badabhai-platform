import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { ChatService } from "./chat.service";

const WORKER = "11111111-1111-4111-8111-111111111111";
const SESSION = "22222222-2222-4222-8222-222222222222";
const CTX = { correlationId: "33333333-3333-4333-8333-333333333333", requestId: "req-1" } as never;
const DTO = { session_id: SESSION, worker_id: WORKER, text: "I run a VMC, 5 years in Pune" };

// A state where all essential topics are answered → the interview is ready.
const READY_STATE = {
  role_family: "cnc_vmc",
  turn_count: 4,
  answered_topics: ["role", "machines", "experience", "location"],
  asked_question_ids: ["q_role", "q_machines"],
  collected: {},
};

function make(
  opts: {
    conversationState?: unknown;
    extractionReady?: boolean;
    latestProfile?: unknown;
    extractThrows?: boolean;
  } = {},
) {
  const session = {
    id: SESSION,
    workerId: WORKER,
    status: "active",
    conversationState: opts.conversationState ?? null,
  };
  const chat = {
    findSession: vi.fn().mockResolvedValue(session),
    insertMessage: vi.fn().mockResolvedValue({ id: "msg-1" }),
    listMessages: vi.fn().mockResolvedValue([]),
    saveConversationState: vi.fn().mockResolvedValue(undefined),
    touchSession: vi.fn().mockResolvedValue(undefined),
  };
  const workers = { latestProfile: vi.fn().mockResolvedValue(opts.latestProfile ?? undefined) };
  const events = { emit: vi.fn().mockResolvedValue(undefined) };
  const ai = {
    profilingRespond: vi.fn().mockResolvedValue({
      reply_text: "Thanks!",
      blocked: false,
      is_mock: true,
      suggested_followups: [],
      asked_question_id: "q_machines",
      extraction_ready: opts.extractionReady ?? false,
      updated_state: opts.extractionReady
        ? READY_STATE
        : { ...READY_STATE, answered_topics: ["role"] },
    }),
  };
  const profiles = {
    extract: opts.extractThrows
      ? vi.fn().mockRejectedValue(new Error("redis down"))
      : vi.fn().mockResolvedValue({ ai_job_id: "job-1", status: "queued" }),
  };
  const svc = new ChatService(
    chat as never,
    workers as never,
    events as never,
    ai as never,
    profiles as never,
  );
  return { svc, chat, workers, events, ai, profiles };
}

const emittedNames = (events: { emit: ReturnType<typeof vi.fn> }): string[] =>
  events.emit.mock.calls.map((c) => (c[0] as { event_name: string }).event_name);

describe("ChatService — auto-trigger extraction on the readiness flip", () => {
  it("triggers extraction exactly once on the flip (no manual /profile/extract)", async () => {
    const { svc, profiles, events } = make({ extractionReady: true });
    const res = await svc.postMessage(DTO as never, CTX);
    expect(res.extraction_ready).toBe(true);
    expect(emittedNames(events)).toContain("profile.extraction_ready");
    expect(profiles.extract).toHaveBeenCalledOnce();
    expect(profiles.extract).toHaveBeenCalledWith({ worker_id: WORKER, session_id: SESSION }, CTX);
  });

  it("does not trigger while the interview is not yet ready", async () => {
    const { svc, profiles, events } = make({ extractionReady: false });
    await svc.postMessage(DTO as never, CTX);
    expect(emittedNames(events)).not.toContain("profile.extraction_ready");
    expect(profiles.extract).not.toHaveBeenCalled();
  });

  it("does not re-trigger on later ready turns (extraction_ready_emitted marker)", async () => {
    const { svc, profiles, events } = make({
      extractionReady: true,
      conversationState: { ...READY_STATE, extraction_ready_emitted: true },
    });
    await svc.postMessage(DTO as never, CTX);
    expect(emittedNames(events)).not.toContain("profile.extraction_ready");
    expect(profiles.extract).not.toHaveBeenCalled();
  });

  it("skips extraction if the worker already has a profile (no duplicate)", async () => {
    const { svc, profiles, events } = make({ extractionReady: true, latestProfile: { id: "profile-1" } });
    await svc.postMessage(DTO as never, CTX);
    expect(emittedNames(events)).toContain("profile.extraction_ready"); // signal still emitted
    expect(profiles.extract).not.toHaveBeenCalled(); // but no second extraction
  });

  it("never breaks the chat reply if the extraction trigger throws", async () => {
    const { svc, profiles } = make({ extractionReady: true, extractThrows: true });
    const res = await svc.postMessage(DTO as never, CTX);
    expect(profiles.extract).toHaveBeenCalledOnce();
    expect(res.reply).toBe("Thanks!"); // chat still returns normally
    expect(res.extraction_ready).toBe(true);
  });
});
