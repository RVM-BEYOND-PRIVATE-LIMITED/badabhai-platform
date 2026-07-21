import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { Logger } from "@nestjs/common";
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
    // AI-PERSONA-2: reply_text the (mock) ai-service returns; the DECRYPTED name to
    // simulate (null = not set), and whether decrypt throws (rotated/tampered key).
    replyText?: string;
    workerName?: string | null;
    decryptThrows?: boolean;
    // CHAT-UE-1: exact updated_state the (mock) ai-service returns — including
    // explicitly `null` (the mock/AI-down fallback) or a MALFORMED value.
    updatedState?: unknown;
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
  const workers = {
    latestProfile: vi.fn().mockResolvedValue(opts.latestProfile ?? undefined),
    // full_name is stored ENCRYPTED (TD21); the plaintext lives only behind pii.decrypt.
    findById: vi.fn().mockResolvedValue({
      id: WORKER,
      fullName: opts.workerName == null ? null : "ENC_FULL_NAME_TOKEN",
    }),
  };
  const pii = {
    decrypt: vi.fn((_token: string) => {
      if (opts.decryptThrows) throw new Error("bad/rotated key");
      return opts.workerName ?? "";
    }),
  };
  const events = { emit: vi.fn().mockResolvedValue(undefined) };
  const ai = {
    profilingRespond: vi.fn().mockResolvedValue({
      reply_text: opts.replyText ?? "Thanks!",
      blocked: false,
      is_mock: true,
      suggested_followups: [],
      asked_question_id: "q_machines",
      extraction_ready: opts.extractionReady ?? false,
      updated_state:
        opts.updatedState !== undefined
          ? opts.updatedState
          : opts.extractionReady
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
    pii as never,
    events as never,
    ai as never,
    profiles as never,
  );
  return { svc, chat, workers, pii, events, ai, profiles };
}

const emittedNames = (events: { emit: ReturnType<typeof vi.fn> }): string[] =>
  events.emit.mock.calls.map((c) => (c[0] as { event_name: string }).event_name);

describe("ChatService — auto-trigger extraction on the readiness flip", () => {
  it("triggers extraction exactly once on the flip (no manual /profile/extract)", async () => {
    const { svc, profiles, events } = make({ extractionReady: true });
    const res = await svc.postMessage(WORKER, DTO as never, CTX);
    expect(res.extraction_ready).toBe(true);
    expect(emittedNames(events)).toContain("profile.extraction_ready");
    expect(profiles.extract).toHaveBeenCalledOnce();
    expect(profiles.extract).toHaveBeenCalledWith({ worker_id: WORKER, session_id: SESSION }, CTX);
  });

  it("does not trigger while the interview is not yet ready", async () => {
    const { svc, profiles, events } = make({ extractionReady: false });
    await svc.postMessage(WORKER, DTO as never, CTX);
    expect(emittedNames(events)).not.toContain("profile.extraction_ready");
    expect(profiles.extract).not.toHaveBeenCalled();
  });

  it("does not re-trigger on later ready turns (extraction_ready_emitted marker)", async () => {
    const { svc, profiles, events } = make({
      extractionReady: true,
      conversationState: { ...READY_STATE, extraction_ready_emitted: true },
    });
    await svc.postMessage(WORKER, DTO as never, CTX);
    expect(emittedNames(events)).not.toContain("profile.extraction_ready");
    expect(profiles.extract).not.toHaveBeenCalled();
  });

  it("skips extraction if the worker already has a profile (no duplicate)", async () => {
    const { svc, profiles, events } = make({ extractionReady: true, latestProfile: { id: "profile-1" } });
    await svc.postMessage(WORKER, DTO as never, CTX);
    expect(emittedNames(events)).toContain("profile.extraction_ready"); // signal still emitted
    expect(profiles.extract).not.toHaveBeenCalled(); // but no second extraction
  });

  it("never breaks the chat reply if the extraction trigger throws", async () => {
    const { svc, profiles } = make({ extractionReady: true, extractThrows: true });
    const res = await svc.postMessage(WORKER, DTO as never, CTX);
    expect(profiles.extract).toHaveBeenCalledOnce();
    expect(res.reply).toBe("Thanks!"); // chat still returns normally
    expect(res.extraction_ready).toBe(true);
  });
});

describe("ChatService.postMessage — query-count / N+1 guard (per turn)", () => {
  it("issues a BOUNDED, constant set of repo reads/writes per message (no N+1)", async () => {
    const { svc, chat } = make({ extractionReady: false });
    await svc.postMessage(WORKER, DTO as never, CTX);
    // Exactly one history read per turn — not one-per-prior-message.
    expect(chat.listMessages).toHaveBeenCalledTimes(1);
    // One session lookup, two message inserts (inbound + outbound), one state persist.
    expect(chat.findSession).toHaveBeenCalledTimes(1);
    expect(chat.insertMessage).toHaveBeenCalledTimes(2);
    expect(chat.saveConversationState).toHaveBeenCalledTimes(1);
  });

  it("history read stays O(1) regardless of prior transcript length", async () => {
    const { svc, chat } = make({ extractionReady: false });
    // Simulate a long prior transcript; the service must still read it ONCE.
    chat.listMessages.mockResolvedValueOnce(
      Array.from({ length: 200 }, (_, i) => ({ id: `m${i}`, direction: "inbound", bodyText: "x" })),
    );
    await svc.postMessage(WORKER, DTO as never, CTX);
    expect(chat.listMessages).toHaveBeenCalledTimes(1);
  });
});

// AI-PERSONA-2 — the real-name seam. The ai-service emits a {{worker_name}} token;
// the API interpolates the real first name POST-emit, ONLY in the client reply.
const PLACEHOLDER_REPLY = "{{worker_name}} ji, Aap kaunsa kaam karte hain?";
// Second insertMessage call is the OUTBOUND (assistant) message — the audit spine.
const outboundBody = (chat: { insertMessage: ReturnType<typeof vi.fn> }): string =>
  (chat.insertMessage.mock.calls[1]?.[0] as { bodyText: string }).bodyText;

describe("ChatService — AI-PERSONA-2 worker-name seam (SG-1 PII boundary)", () => {
  it("interpolates the real FIRST name into the client reply only", async () => {
    const { res, chat, events, ai } = await run({
      replyText: PLACEHOLDER_REPLY,
      workerName: "Nitin Kumar",
    });
    // Client sees the personalized reply (first name only, not the full name).
    expect(res.reply).toBe("Nitin ji, Aap kaunsa kaam karte hain?");

    // SG-1: the stored outbound message keeps the PLACEHOLDER, never the name.
    expect(outboundBody(chat)).toContain("{{worker_name}}");
    expect(outboundBody(chat)).not.toContain("Nitin");

    // The name is in NO event payload…
    expect(JSON.stringify(events.emit.mock.calls)).not.toContain("Nitin");
    // …and was NEVER sent to the ai-service (LLM input) — only worker_ref + message.
    expect(JSON.stringify(ai.profilingRespond.mock.calls)).not.toContain("Nitin");
  });

  it("inserts a name with `$` special-replacement chars literally (no pattern expansion)", async () => {
    // Worker-controlled name may contain $&, $', $$ — a STRING replacement would
    // expand these; the function replacement must insert them verbatim.
    const { res } = await run({ replyText: PLACEHOLDER_REPLY, workerName: "Om$'" });
    expect(res.reply).toBe("Om$' ji, Aap kaunsa kaam karte hain?");
  });

  it("null name → clean no-vocative reply, no residual {{ }} token", async () => {
    const { res, chat } = await run({ replyText: PLACEHOLDER_REPLY, workerName: null });
    expect(res.reply).toBe("Aap kaunsa kaam karte hain?");
    expect(res.reply).not.toContain("{{");
    expect(res.reply).not.toContain("ji,");
    // The stored placeholder is untouched regardless of the name being absent.
    expect(outboundBody(chat)).toContain("{{worker_name}}");
  });

  it("undecryptable name (rotated/tampered key) degrades to no-vocative, never 500s", async () => {
    const { res } = await run({
      replyText: PLACEHOLDER_REPLY,
      workerName: "Nitin Kumar",
      decryptThrows: true,
    });
    expect(res.reply).toBe("Aap kaunsa kaam karte hain?");
    expect(res.reply).not.toContain("{{");
  });

  it("never passes the worker name to the logger", async () => {
    const logSpy = vi.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    try {
      await run({ replyText: PLACEHOLDER_REPLY, workerName: "Nitin Kumar" });
      const logged = JSON.stringify([...logSpy.mock.calls, ...warnSpy.mock.calls]);
      expect(logged).not.toContain("Nitin");
    } finally {
      logSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  it("no DB name read for a reply without the placeholder (mid-interview ack turn)", async () => {
    const { workers } = await run({ replyText: "Theek hai. Kaunsi machine?" });
    // Fast path: renderWorkerName short-circuits, so no worker/name fetch happens.
    expect(workers.findById).not.toHaveBeenCalled();
  });
});

// CHAT-UE-1 — the completeness signal crosses the last hop to the client.
// The response carries topic IDS only (never PII), degrades to [] on the
// mock/AI-down null state, and a malformed engine value can never 500 a turn.
describe("ChatService — CHAT-UE-1 unanswered_essentials on the reply", () => {
  it("surfaces the engine's unanswered essentials, in engine (ESSENTIAL_TOPICS) order", async () => {
    const { res } = await run({
      updatedState: { ...READY_STATE, unanswered_essentials: ["machines", "experience", "salary"] },
    });
    expect(res.unanswered_essentials).toEqual(["machines", "experience", "salary"]);
  });

  it("updated_state null (mock/AI-down fallback) → [] and no throw", async () => {
    const { res, chat } = await run({ updatedState: null });
    expect(res.unanswered_essentials).toEqual([]);
    // The null-state leg was genuinely taken (plain touch, no state persist).
    expect(chat.touchSession).toHaveBeenCalledTimes(1);
    expect(chat.saveConversationState).not.toHaveBeenCalled();
  });

  it("all essentials answered → []", async () => {
    const { res } = await run({
      extractionReady: true,
      updatedState: { ...READY_STATE, unanswered_essentials: [] },
    });
    expect(res.unanswered_essentials).toEqual([]);
    expect(res.extraction_ready).toBe(true);
  });

  it("malformed value (non-string members) → drops them, keeps the string ids, never throws", async () => {
    const { res } = await run({
      updatedState: { ...READY_STATE, unanswered_essentials: ["machines", 42, null, "salary"] },
    });
    expect(res.unanswered_essentials).toEqual(["machines", "salary"]);
  });

  it("malformed value (not an array at all) → [], never throws", async () => {
    const { res } = await run({
      updatedState: { ...READY_STATE, unanswered_essentials: "machines" },
    });
    expect(res.unanswered_essentials).toEqual([]);
  });

  it("carries topic ids only — never the worker's name (PII)", async () => {
    const { res } = await run({
      replyText: PLACEHOLDER_REPLY,
      workerName: "Nitin Kumar",
      updatedState: { ...READY_STATE, unanswered_essentials: ["salary"] },
    });
    expect(res.unanswered_essentials).toEqual(["salary"]);
    expect(JSON.stringify(res.unanswered_essentials)).not.toContain("Nitin");
  });

  it("keeps every pre-existing reply field unchanged (additive, backward compatible)", async () => {
    const { res } = await run({});
    expect(res).toEqual({
      session_id: SESSION,
      reply: "Thanks!",
      blocked: false,
      is_mock: true,
      suggested_followups: [],
      asked_question_id: "q_machines",
      extraction_ready: false,
      // Only the NEW field is added; a state without the key degrades to [].
      unanswered_essentials: [],
    });
  });
});

/** Run one postMessage turn and return the harness + response. */
async function run(opts: Parameters<typeof make>[0]) {
  const h = make(opts);
  const res = await h.svc.postMessage(WORKER, DTO as never, CTX);
  return { ...h, res };
}
