import { describe, expect, it } from "vitest";
import type { ProfilingTurnUnderstandOutput, QuestionPackItem } from "@badabhai/ai-contracts";

import type { BufferedMessage, TranscriptBuffer } from "../../chat/chat-transcript.buffer";
import { emptyProfilingEnvelope, type ProfilingEnvelope } from "../conversation-state";
import {
  flagChatOnlyLines,
  isChatOnlyReading,
  withoutCityCrossFill,
  wroteNoFacts,
} from "./chat-only";

/** Token-audit fix Q2 — the pure half: the reading, the city guard's items, and the flagging. */

function reading(over: Partial<ProfilingTurnUnderstandOutput> = {}): ProfilingTurnUnderstandOutput {
  return {
    intent: "chat",
    confidence: 0.95,
    fills: [],
    edits: [],
    page_owned_mentions: [],
    on_screen_none: false,
    blocked: false,
    ai_metadata: null,
    ...over,
  };
}

describe("isChatOnlyReading", () => {
  it("is true for chat with nothing in it — run 7's four side questions", () => {
    expect(isChatOnlyReading(reading())).toBe(true);
  });

  it("is false the moment the layer heard anything for the profile", () => {
    expect(isChatOnlyReading(reading({ intent: "statement" }))).toBe(false);
    expect(isChatOnlyReading(reading({ intent: "answer" }))).toBe(false);
    expect(isChatOnlyReading(reading({ intent: "unclear" }))).toBe(false);
    expect(isChatOnlyReading(reading({ fills: [{ key: "current_city", value: "Pune" }] }))).toBe(
      false,
    );
    expect(
      isChatOnlyReading(
        reading({ edits: [{ op: "edit", key: "experience_years", ref: null, value: "6" }] }),
      ),
    ).toBe(false);
    // A Profile-page fact heard in a question is still the extraction's to read (#1505-2).
    expect(isChatOnlyReading(reading({ page_owned_mentions: ["expected_salary"] }))).toBe(false);
    expect(isChatOnlyReading(reading({ on_screen_none: true }))).toBe(false);
  });
});

describe("withoutCityCrossFill", () => {
  const items = [
    { question_key: "current_city", target_field: "current_city" },
    { question_key: "availability", target_field: "availability" },
    { question_key: "experience_years", target_field: "experience_years" },
    { question_key: "commute_max_km", target_field: "commute_max_km" },
  ] as Pick<QuestionPackItem, "question_key" | "target_field">[];

  it("drops only the worker's current city, in order", () => {
    expect(withoutCityCrossFill(items).map((item) => item.question_key)).toEqual([
      "availability",
      "experience_years",
      "commute_max_km",
    ]);
  });

  it("drops it by the fact registry, whichever spelling the pack row uses", () => {
    const byField = [{ question_key: "where_do_you_live", target_field: "current_city" }];
    expect(withoutCityCrossFill(byField)).toEqual([]);
  });
});

const NOW = "2026-10-22T10:00:00.000Z";
const line = (role: BufferedMessage["role"], text: string): BufferedMessage => ({
  role,
  text,
  at: NOW,
  voiceNoteId: null,
});

function envelopeOf(over: Partial<ProfilingEnvelope> = {}): ProfilingEnvelope {
  return { ...emptyProfilingEnvelope(), rev: 3, ...over };
}

const RECORD = {
  question_key: "current_city",
  target_field: "current_city",
  value_raw: "Pune",
  value_normalized: "Pune",
  status: "answered" as const,
  evidence: null,
  turn: 4,
  history: [],
};

describe("wroteNoFacts", () => {
  it("holds for a turn that only moved counters and the question on screen", () => {
    const before = envelopeOf();
    expect(wroteNoFacts(before, { ...before, rev: 4, engineAsks: 3, servedQuestionKey: "x" })).toBe(
      true,
    );
  });

  it("fails for a new answer, a changed draft or a new pin", () => {
    const before = envelopeOf();
    expect(wroteNoFacts(before, { ...before, answerMap: [RECORD] })).toBe(false);
    expect(
      wroteNoFacts(before, {
        ...before,
        llmDraft: { ...before.llmDraft, skills: ["VMC operation"] },
      }),
    ).toBe(false);
    expect(
      wroteNoFacts(before, {
        ...before,
        occupation: {
          job_domain_id: "jd_1",
          label: "CNC Operator-Turning",
          isco_unit_code: "7223",
          match_status: "matched_lexical",
          match_score: 0.97,
          match_layer: "l0_exact",
          pack_id: null,
          pack_version: null,
          catalog_version: "v1",
        },
      }),
    ).toBe(false);
  });
});

describe("flagChatOnlyLines", () => {
  const text = "gurgaon mein koi company hai?";
  const envelope = envelopeOf();
  const before: TranscriptBuffer = {
    workerId: "w",
    turnCount: 1,
    captured: {},
    roleFamily: "",
    messages: [line("assistant", "Aap kab se kaam shuru kar sakte hain?")],
    startedAt: NOW,
    profiling: envelope,
  };
  // `null` = a buffer with no envelope (a default parameter would swallow an explicit undefined).
  const decidedWith = (
    messages: BufferedMessage[],
    result = { kind: "ask", questionKey: "availability" as string | null },
    profiling: ProfilingEnvelope | null = { ...envelope, rev: 4 },
  ) => ({
    buffer: {
      ...before,
      messages: [...before.messages, ...messages],
      profiling: profiling ?? undefined,
    },
    result,
  });
  const turnLines = [
    line("worker", text),
    line("assistant", "Haan. Aap kab se kaam shuru kar sakte hain?"),
  ];

  it("flags the message and a reply that served the same question again", () => {
    const out = flagChatOnlyLines(decidedWith(turnLines), {
      before,
      envelope,
      text,
      verdict: { reservedKey: "availability" },
    });
    expect(out.buffer.messages.map((m) => m.chatOnly ?? false)).toEqual([false, true, true]);
    // The earlier line is the very same object, untouched.
    expect(out.buffer.messages[0]).toBe(before.messages[0]);
  });

  it("flags the message alone when the turn went on, or the reply asks something else", () => {
    for (const [verdict, result] of [
      [{ reservedKey: null }, { kind: "ask", questionKey: null }],
      [{ reservedKey: "availability" }, { kind: "ask", questionKey: "current_city" }],
      [{ reservedKey: "availability" }, { kind: "close", questionKey: "availability" }],
    ] as const) {
      const out = flagChatOnlyLines(decidedWith(turnLines, { ...result }), {
        before,
        envelope,
        text,
        verdict,
      });
      expect(out.buffer.messages.map((m) => m.chatOnly ?? false)).toEqual([false, true, false]);
    }
  });

  it("returns the decision untouched when the turn wrote a fact", () => {
    const decided = decidedWith(turnLines, undefined, { ...envelope, answerMap: [RECORD] });
    expect(
      flagChatOnlyLines(decided, {
        before,
        envelope,
        text,
        verdict: { reservedKey: "availability" },
      }),
    ).toBe(decided);
  });

  it("returns it untouched unless exactly the message and one reply were appended", () => {
    const verdict = { reservedKey: "availability" };
    for (const messages of [
      [],
      [line("worker", text)],
      [...turnLines, line("assistant", "extra")],
      [line("worker", "something else"), turnLines[1]!],
      [line("assistant", text), turnLines[1]!],
      [line("worker", text), line("worker", text)],
    ]) {
      const decided = decidedWith(messages);
      expect(flagChatOnlyLines(decided, { before, envelope, text, verdict })).toBe(decided);
    }
    const noEnvelope = decidedWith(turnLines, undefined, null);
    expect(flagChatOnlyLines(noEnvelope, { before, envelope, text, verdict })).toBe(noEnvelope);
  });
});
