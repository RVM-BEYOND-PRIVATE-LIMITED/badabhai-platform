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
    // Engine's essential ids (interview_engine.py) — "current_location", not the
    // retired combined "location".
    for (const essential of ["role", "machines", "experience", "current_location"]) {
      expect(state!.answered_topics).toContain(essential);
    }
  });

  it("carries role_family through", () => {
    const t = mockProfilingTurn(null, "cnc_vmc");
    expect(t.updated_state.role_family).toBe("cnc_vmc");
  });

  // CHAT-UE-1 — the mock must MAINTAIN the client-surfaced completeness signal,
  // not just carry the contract field. Empty means "all essentials answered".
  describe("unanswered_essentials recompute", () => {
    it("fresh AI-down session: turn 1 reports ALL essentials open (never a false 'complete')", () => {
      const t = mockProfilingTurn(null);
      expect(t.updated_state.unanswered_essentials).toEqual([
        "role",
        "machines",
        "experience",
        "current_location",
      ]);
      expect(t.extraction_ready).toBe(false);
    });

    it("shrinks in ESSENTIAL_TOPICS order as topics get answered", () => {
      const t1 = mockProfilingTurn(null); // asks role
      const t2 = mockProfilingTurn(t1.updated_state); // role answered, asks machines
      expect(t2.updated_state.unanswered_essentials).toEqual([
        "machines",
        "experience",
        "current_location",
      ]);
    });

    it("a stale non-empty list persisted by a prior REAL-engine turn is recomputed, not carried", () => {
      // All essentials answered, but the persisted signal still names one — e.g.
      // the engine wrote it, then the ai-service went down mid-interview.
      const stale = {
        ...mockProfilingTurn(null).updated_state,
        answered_topics: ["role", "machines", "experience", "current_location"],
        asked_question_ids: ["role", "machines", "experience", "current_location"],
        unanswered_essentials: ["current_location"],
      };
      const t = mockProfilingTurn(stale);
      expect(t.updated_state.unanswered_essentials).toEqual([]);
      expect(t.extraction_ready).toBe(true);
    });

    it("extraction_ready agrees with the recomputed signal on every asking turn", () => {
      let state = null as Parameters<typeof mockProfilingTurn>[0];
      for (let i = 0; i < 8; i++) {
        const t = mockProfilingTurn(state);
        state = t.updated_state;
        if (t.asked_question_id !== null) {
          // While the mock is still asking, ready ⟺ no essential open.
          expect(t.extraction_ready).toBe(t.updated_state.unanswered_essentials.length === 0);
        }
      }
    });
  });
});
