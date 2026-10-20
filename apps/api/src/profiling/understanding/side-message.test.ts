import { describe, expect, it } from "vitest";
import type { ProfilingTurnUnderstandOutput, QuestionPackItem } from "@badabhai/ai-contracts";

import { isSideMessage } from "./side-message";

/** #2379 — when the layer's verdict says the typed message did not answer the question on screen. */

function item(partial: Partial<QuestionPackItem> & { question_key: string }): QuestionPackItem {
  return {
    prompt_text: `${partial.question_key}?`,
    display_order: 0,
    target_kind: "rfs",
    target_field: partial.question_key,
    target_skill_id: null,
    answer_type: "text",
    is_mandatory: false,
    is_core: false,
    max_asks: 1,
    min_turn: null,
    max_turn: null,
    ask_if: null,
    skip_if: null,
    parent_item_key: null,
    retry_text: null,
    why_text: null,
    options: [],
    ...partial,
  };
}

const TRAINING = item({ question_key: "training_name" });
const AVAIL = item({ question_key: "availability", answer_type: "single_select" });

function out(over: Partial<ProfilingTurnUnderstandOutput> = {}): ProfilingTurnUnderstandOutput {
  return {
    intent: "statement",
    confidence: 0.9,
    fills: [{ key: "current_city", value: "Pune" }],
    edits: [],
    page_owned_mentions: [],
    on_screen_none: false,
    blocked: false,
    ai_metadata: {} as never,
    ...over,
  };
}

const side = (o: ProfilingTurnUnderstandOutput, on: QuestionPackItem, capturedOnScreen = false, dontKnow = false) =>
  isSideMessage({ out: o, item: on, capturedOnScreen, dontKnow });

describe("#2379 — isSideMessage", () => {
  it("a statement over a free-text question is a side message, even though its capture took the text", () => {
    expect(side(out(), TRAINING, true)).toBe(true);
  });

  it("a statement over a typed question is one only when its parser read nothing", () => {
    expect(side(out(), AVAIL, false)).toBe(true);
    expect(side(out(), AVAIL, true)).toBe(false);
  });

  it("a correction typed with a new fact, read as a statement, is one", () => {
    const mixed = out({
      fills: [{ key: "commute_max_km", value: "15" }],
      edits: [{ op: "edit", key: "experience_years", ref: null, value: "6" }],
    });
    expect(side(mixed, AVAIL)).toBe(true);
    expect(side(mixed, TRAINING, true)).toBe(true);
  });

  it("chat is one only when it carries a fact (bare chat has its own branch)", () => {
    expect(side(out({ intent: "chat" }), TRAINING, true)).toBe(true);
    expect(side(out({ intent: "chat", fills: [] }), TRAINING, true)).toBe(false);
  });

  it("an answer, an edit, a delete, a progress question or an unclear read is not", () => {
    for (const intent of ["answer", "edit", "delete", "progress", "unclear"] as const) {
      expect(side(out({ intent }), TRAINING, true)).toBe(false);
    }
  });

  it("a fill for the question on screen is an answer to it, whatever the label", () => {
    expect(side(out({ fills: [{ key: "training_name", value: "ITI Welding" }] }), TRAINING, true)).toBe(false);
  });

  it("a 'none' for the question on screen is #2328's decline, never a side message", () => {
    expect(side(out({ on_screen_none: true }), TRAINING, true)).toBe(false);
  });

  it("a deterministic 'pata nahi' keeps its claim", () => {
    expect(side(out(), TRAINING, true, true)).toBe(false);
  });
});
