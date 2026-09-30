import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import type { ServerConfig } from "@badabhai/config";
import type { WorkerProfile } from "@badabhai/db";
import { FALLBACK, V2_CAREER_REFUSE } from "../../companion-replies";
import { CareerTalkHandler, workerContextOf } from "./career-talk.handler";
import type { HandlerInput } from "./handler";

const WORKER = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-09-29T10:00:00.000Z");

const PROFILE = {
  canonicalTradeId: null,
  experience: { total_years: 4 },
} as unknown as WorkerProfile;

function input(over: Partial<HandlerInput> = {}): HandlerInput {
  return {
    workerId: WORKER,
    profile: PROFILE,
    text: "welder ke baad kya seekhun",
    recentTurns: [],
    ctx: { correlationId: "c-1", requestId: "r-1" } as never,
    now: NOW,
    ...over,
  };
}

function setup(out: unknown) {
  const ai = { companionCareer: vi.fn(async () => out) };
  const cost = { record: vi.fn(async () => undefined) };
  const events = { emit: vi.fn(async (params: unknown) => params) };
  const config = {
    CHAT_COMPANION_V2_EDIT_ENABLED: true,
    CHAT_COMPANION_V2_NEW_RESUME_ENABLED: true,
    CHAT_COMPANION_V2_CAREER_ENABLED: true,
  } as unknown as ServerConfig;
  return {
    handler: new CareerTalkHandler(config, ai as never, cost as never, events as never),
    ai,
    cost,
    events,
  };
}

const careerEvent = (events: { emit: { mock: { calls: unknown[][] } } }) =>
  events.emit.mock.calls
    .map((c) => c[0] as { event_name: string; payload: Record<string, unknown> })
    .find((e) => e.event_name === "chat.companion_career_answered")!;

const META = {
  ai_call_id: "call-1",
  task_type: "companion_career_answer",
  model_name: "claude-haiku-4-5",
  provider: "anthropic",
  real_call: false,
};

describe("CareerTalkHandler (ADR-0046 P3) — the one model-written answer", () => {
  it("a valid answer is served with read_aloud:false and the chips; the spend is recorded", async () => {
    const h = setup({
      status: "answer",
      lines: ["Pehle welding ka certificate kariye.", "Phir 6G test ki tayari kariye."],
      followup_chips: ["Course kahan milega", "Kitna time lagega"],
      ai_metadata: META,
    });
    const { turn, outcome } = await h.handler.handle(input());

    expect(outcome).toBe("served");
    expect(turn.reply).toBe(
      "Pehle welding ka certificate kariye.\nPhir 6G test ki tayari kariye.",
    );
    // O9: present and FALSE — an absent field would let a shipped client read `reply` aloud.
    expect(turn.read_aloud).toBe(false);
    expect(turn.tts_text).toBeUndefined();
    expect(turn.suggested_followups).toEqual(["Course kahan milega", "Kitna time lagega"]);
    expect(turn.suggested_options).toEqual([]);

    expect(h.cost.record).toHaveBeenCalledWith(
      META,
      "companion_career_answer",
      null,
      "c-1",
      "r-1",
      { workerId: WORKER },
    );
    expect(careerEvent(h.events).payload).toEqual({
      outcome: "answered",
      refusal_topic: null,
      turns_in_memory: 0,
    });
  });

  it("a refusal serves the REVIEWED copy for its topic, never the model's words", async () => {
    for (const topic of ["salary_promise", "named_employer", "worker_rating"] as const) {
      const h = setup({ status: "refuse", topic, ai_metadata: META });
      const { turn, outcome } = await h.handler.handle(input());
      expect(outcome).toBe("refused");
      expect(turn.reply).toBe(V2_CAREER_REFUSE[topic].latin);
      expect(turn.tts_text).toBe(V2_CAREER_REFUSE[topic].dev);
      expect(careerEvent(h.events).payload).toMatchObject({
        outcome: "refused",
        refusal_topic: topic,
      });
    }
  });

  it("an answer that fails the validator is NOT served — the fallback line instead", async () => {
    // The model returned an answer with a salary figure; the prompt forbids it, the validator
    // is what enforces it.
    const h = setup({
      status: "answer",
      lines: ["Salary 25000 mil jayegi."],
      followup_chips: [],
      ai_metadata: META,
    });
    const { turn, outcome } = await h.handler.handle(input());
    expect(outcome).toBe("fallback");
    expect(turn.reply).toBe(FALLBACK.latin);
    expect(careerEvent(h.events).payload).toMatchObject({ outcome: "fallback", refusal_topic: null });
  });

  it("an unreachable service is the fallback line, and the spend still records (null meta)", async () => {
    const h = setup(null);
    const { turn, outcome } = await h.handler.handle(input());
    expect(outcome).toBe("fallback");
    expect(turn.reply).toBe(FALLBACK.latin);
    // The call happened (or was attempted); `record` no-ops on the null meta it got.
    expect(h.cost.record).toHaveBeenCalledWith(null, "companion_career_answer", null, "c-1", "r-1", {
      workerId: WORKER,
    });
    expect(careerEvent(h.events).payload).toMatchObject({ outcome: "fallback" });
  });

  it("passes the memory turns (≤ 6) and the closed worker context to the model", async () => {
    const h = setup({ status: "refuse", topic: "unsafe_other", ai_metadata: null });
    const turns = Array.from({ length: 6 }, (_, i) => ({ role: "worker" as const, text: `t${i}` }));
    await h.handler.handle(input({ recentTurns: turns }));
    expect(h.ai.companionCareer).toHaveBeenCalledWith(
      {
        text: "welder ke baad kya seekhun",
        recent_turns: turns,
        worker_context: { trade_label: null, experience_bucket: "3-7" },
      },
      { correlationId: "c-1", requestId: "r-1" },
    );
    expect(careerEvent(h.events).payload).toMatchObject({ turns_in_memory: 6 });
  });
});

describe("workerContextOf — only the label and the bucket, ever", () => {
  it("buckets years at the closed boundaries", () => {
    const bucket = (years: number | null) =>
      workerContextOf({ experience: years === null ? null : { total_years: years } } as never)
        .experience_bucket;
    expect(bucket(null)).toBeNull();
    expect(bucket(0)).toBe("0-1");
    expect(bucket(1)).toBe("1-3");
    expect(bucket(2.9)).toBe("1-3");
    expect(bucket(3)).toBe("3-7");
    expect(bucket(6.9)).toBe("3-7");
    expect(bucket(7)).toBe("7+");
    expect(bucket(30)).toBe("7+");
  });

  it("carries no name, phone, employer or city — there is nowhere to put one", () => {
    const context = workerContextOf(PROFILE);
    expect(Object.keys(context).sort()).toEqual(["experience_bucket", "trade_label"]);
    expect(JSON.stringify(context)).not.toMatch(/name|phone|employer|city/i);
  });
});
