import "reflect-metadata";
import { Logger } from "@nestjs/common";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ServerConfig } from "@badabhai/config";
import { CompanionCareerInputSchema } from "@badabhai/ai-contracts";
import type { WorkerProfile } from "@badabhai/db";
import { EVENT_REGISTRY } from "@badabhai/event-schema";
import { FALLBACK, V2_CAREER_REFUSE } from "../../companion-replies";
import { CAREER_TURNS_MAX, CareerTalkHandler, workerContextOf } from "./career-talk.handler";
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

function setup(
  out: unknown,
  opts: {
    /** TD147(1) — what the platform employer index answers (`null` = never loaded). */
    knownEmployer?: boolean | null;
  } = {},
) {
  const ai = { companionCareer: vi.fn(async (_input: unknown, _ctx: unknown) => out) };
  const cost = { record: vi.fn(async () => undefined) };
  const events = { emit: vi.fn(async (params: unknown) => params) };
  const employers = {
    isKnownEmployer: vi.fn(async () =>
      opts.knownEmployer === undefined ? false : opts.knownEmployer,
    ),
  };
  const config = {
    CHAT_COMPANION_V2_EDIT_ENABLED: true,
    CHAT_COMPANION_V2_NEW_RESUME_ENABLED: true,
    CHAT_COMPANION_V2_CAREER_ENABLED: true,
  } as unknown as ServerConfig;
  return {
    handler: new CareerTalkHandler(config, ai as never, cost as never, events as never, employers as never),
    ai,
    cost,
    events,
    employers,
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
    expect(turn.reply).toBe("Pehle welding ka certificate kariye.\nPhir 6G test ki tayari kariye.");
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
    for (const topic of [
      "salary_promise",
      "legal_medical_financial",
      "named_employer",
      "worker_rating",
      "unsafe_other",
    ] as const) {
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

  it("legal_medical_financial names all three domains (README checklist item 4, 2026-10-05)", () => {
    // The draft sent a health question to "a lawyer or a bank". The fixed line names the law,
    // health and money halves and the professional each goes to.
    const { latin, dev } = V2_CAREER_REFUSE.legal_medical_financial;
    for (const word of ["kanoon", "sehat", "paise", "vakil", "doctor", "bank"]) {
      expect(latin).toContain(word);
    }
    for (const word of ["कानून", "सेहत", "पैसे", "वकील", "डॉक्टर", "बैंक"]) {
      expect(dev).toContain(word);
    }
  });

  describe("the platform's own employer names (TD147(1), WP7)", () => {
    it("an answer naming a known employer is NOT served — the fallback line instead", async () => {
      const h = setup(
        {
          status: "answer",
          lines: ["Dusri company mein try kariye."],
          followup_chips: ["Maruti ke baare mein"],
          ai_metadata: META,
        },
        { knownEmployer: true },
      );
      const { turn, outcome } = await h.handler.handle(input());

      expect(outcome).toBe("fallback");
      expect(turn.reply).toBe(FALLBACK.latin);
      expect(careerEvent(h.events).payload).toMatchObject({ outcome: "fallback" });
      // Every line AND chip runs the check, like every other content rule.
      expect(h.employers.isKnownEmployer).toHaveBeenCalled();
    });

    it("a chip naming a known employer rejects the whole answer", async () => {
      const h = setup(
        {
          status: "answer",
          lines: ["Pehle welding ka certificate kariye."],
          followup_chips: ["Tata Motors mein kaam"],
          ai_metadata: META,
        },
        { knownEmployer: true },
      );
      expect((await h.handler.handle(input())).outcome).toBe("fallback");
    });

    it("a never-loaded index is recorded and the answer is served — the heuristic still applied", async () => {
      const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
      const h = setup(
        {
          status: "answer",
          lines: ["Pehle welding ka certificate kariye."],
          followup_chips: [],
          ai_metadata: META,
        },
        { knownEmployer: null },
      );
      const { outcome } = await h.handler.handle(input());
      expect(outcome).toBe("served");
      expect(warn.mock.calls.map((c) => String(c[0])).join("\n")).toContain(
        "career employer index unavailable",
      );
      warn.mockRestore();
    });
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
    expect(careerEvent(h.events).payload).toMatchObject({
      outcome: "fallback",
      refusal_topic: null,
    });
  });

  describe("an over-long follow-up chip is dropped, not the answer (owner, 2026-10-03)", () => {
    const LINES = ["Pehle welding ka certificate kariye.", "Phir 6G test ki tayari kariye."];
    /** Five words, otherwise clean — its only failure is the four-word chip bound. */
    const LONG_CHIP = "TIG welding kaise seekhun ji";

    /** The handler's log and warn lines, captured so the test can read what an operator would. */
    function captureLogs() {
      const log = vi.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
      const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
      return { log, warn };
    }
    afterEach(() => vi.restoreAllMocks());

    it("serves the lines and only the KEPT chips; outcome answered; one counts-only log line", async () => {
      const logs = captureLogs();
      const h = setup({
        status: "answer",
        lines: LINES,
        followup_chips: ["Course kahan milega", LONG_CHIP],
        ai_metadata: META,
      });
      const { turn, outcome } = await h.handler.handle(input());

      expect(outcome).toBe("served");
      expect(turn.reply).toBe(LINES.join("\n"));
      expect(turn.suggested_followups).toEqual(["Course kahan milega"]);
      expect(careerEvent(h.events).payload).toEqual({
        outcome: "answered",
        refusal_topic: null,
        turns_in_memory: 0,
      });

      expect(logs.warn).not.toHaveBeenCalled();
      expect(logs.log).toHaveBeenCalledTimes(1);
      const line = logs.log.mock.calls.flat().map(String).join(" ");
      expect(line).toBe(
        `career answer served for worker ${WORKER} with 1 follow-up chip(s) dropped (reason=chip_too_long)`,
      );
      // The count and the closed reason — never the chip, which is model text.
      for (const word of LONG_CHIP.split(" ")) expect(line).not.toContain(word);
    });

    it("every chip over-long: served with no chips at all", async () => {
      const logs = captureLogs();
      const h = setup({
        status: "answer",
        lines: LINES,
        followup_chips: [LONG_CHIP, "Pipe welding ka course kahan"],
        ai_metadata: META,
      });
      const { turn, outcome } = await h.handler.handle(input());

      expect(outcome).toBe("served");
      expect(turn.suggested_followups).toEqual([]);
      expect(turn.question_kind).toBe("close");
      expect(String(logs.log.mock.calls[0]![0])).toContain("with 2 follow-up chip(s) dropped");
    });

    it("an over-long chip that ALSO states money is the fallback — the drop launders nothing", async () => {
      const logs = captureLogs();
      const h = setup({
        status: "answer",
        lines: LINES,
        followup_chips: ["Welder ki salary 25000 hoti hai"],
        ai_metadata: META,
      });
      const { turn, outcome } = await h.handler.handle(input());

      expect(outcome).toBe("fallback");
      expect(turn.reply).toBe(FALLBACK.latin);
      expect(careerEvent(h.events).payload).toMatchObject({ outcome: "fallback" });
      expect(logs.log).not.toHaveBeenCalled();
      const warned = logs.warn.mock.calls.flat().map(String).join(" ");
      expect(warned).toBe(`career answer rejected for worker ${WORKER} (money)`);
    });

    it("a clean answer logs nothing", async () => {
      const logs = captureLogs();
      const h = setup({
        status: "answer",
        lines: LINES,
        followup_chips: ["Course kahan milega"],
        ai_metadata: META,
      });
      expect((await h.handler.handle(input())).outcome).toBe("served");
      expect(logs.log).not.toHaveBeenCalled();
      expect(logs.warn).not.toHaveBeenCalled();
    });
  });

  it("an unreachable service is the fallback line, and the spend still records (null meta)", async () => {
    const h = setup(null);
    const { turn, outcome } = await h.handler.handle(input());
    expect(outcome).toBe("fallback");
    expect(turn.reply).toBe(FALLBACK.latin);
    // The call happened (or was attempted); `record` no-ops on the null meta it got.
    expect(h.cost.record).toHaveBeenCalledWith(
      null,
      "companion_career_answer",
      null,
      "c-1",
      "r-1",
      {
        workerId: WORKER,
      },
    );
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

  it("CAREER_TURNS_MAX is the contract's own bound (and the event's)", () => {
    const turns = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ role: "worker" as const, text: `t${i}` }));
    const body = (n: number) => ({
      text: "x",
      recent_turns: turns(n),
      worker_context: { trade_label: null, experience_bucket: null },
    });
    expect(CompanionCareerInputSchema.safeParse(body(CAREER_TURNS_MAX)).success).toBe(true);
    expect(CompanionCareerInputSchema.safeParse(body(CAREER_TURNS_MAX + 1)).success).toBe(false);
  });

  it("MEMORY_TURNS above six: only the NEWEST six are sent, and the event reports six", async () => {
    // The knob has no ceiling; a store holding eight turns must never make the call a 422.
    const h = setup({ status: "refuse", topic: "unsafe_other", ai_metadata: null });
    const turns = Array.from({ length: 8 }, (_, i) => ({
      role: (i % 2 === 0 ? "worker" : "bada_bhai") as "worker" | "bada_bhai",
      text: `t${i}`,
    }));
    await h.handler.handle(input({ recentTurns: turns }));

    const sent = h.ai.companionCareer.mock.calls[0]![0] as { recent_turns: unknown[] };
    expect(sent.recent_turns).toEqual(turns.slice(2));
    expect(CompanionCareerInputSchema.safeParse(sent).success).toBe(true);
    const event = careerEvent(h.events);
    expect(event.payload).toMatchObject({ turns_in_memory: CAREER_TURNS_MAX });
    // ...which the registered event contract accepts (it caps `turns_in_memory` at six).
    expect(
      EVENT_REGISTRY["chat.companion_career_answered"].payload.safeParse(event.payload).success,
    ).toBe(true);
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
