import { describe, it, expect } from "vitest";
import type { ConversationState } from "@badabhai/ai-contracts";
import { mockProfilingTurn } from "./mock-interview";

describe("mockProfilingTurn", () => {
  it("asks Q1 (role) on a fresh interview", () => {
    const t = mockProfilingTurn(null);
    expect(t.asked_question_id).toBe("role");
    expect(t.updated_state.turn_count).toBe(1);
    expect(t.updated_state.asked_question_ids).toEqual(["role"]);
    expect(t.reply_text.length).toBeGreaterThan(0);
    expect(t.extraction_ready).toBe(false);
  });

  it("advances Q1 -> Q2 -> Q3 across turns and never repeats Q1", () => {
    const asked: (string | null)[] = [];
    let state: ConversationState | null = null;
    for (let i = 0; i < 3; i++) {
      const t = mockProfilingTurn(state);
      asked.push(t.asked_question_id);
      state = t.updated_state;
    }
    expect(asked).toEqual(["role", "machines", "experience"]);
    // distinct, and role asked exactly once
    expect(new Set(asked).size).toBe(3);
    expect(asked.filter((a) => a === "role")).toHaveLength(1);
    expect(state!.turn_count).toBe(3);
  });

  it("becomes extraction_ready once the essential topics are covered, then wraps up", () => {
    let state: ConversationState | null = null;
    let ready = false;
    let lastAsked: string | null = "x";
    // Drive enough turns to clear role/machines/experience/skills/location.
    for (let i = 0; i < 8 && !ready; i++) {
      const t = mockProfilingTurn(state);
      state = t.updated_state;
      ready = t.extraction_ready;
      lastAsked = t.asked_question_id;
    }
    expect(ready).toBe(true);
    expect(lastAsked).toBeNull(); // wrap-up turn asks nothing
    for (const essential of ["role", "machines", "experience", "location"]) {
      expect(state!.answered_topics).toContain(essential);
    }
  });

  it("carries role_family through", () => {
    const t = mockProfilingTurn(null, "cnc_vmc");
    expect(t.updated_state.role_family).toBe("cnc_vmc");
  });
});
