import { describe, it, expect } from "vitest";
import type { ConversationState } from "@badabhai/ai-contracts";
import { mockProfilingTurn, MOCK_TOPIC_IDS, MUST_ASK_TOPICS } from "./mock-interview";

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

  it("becomes extraction_ready once essentials are answered AND must-asks asked, then wraps up", () => {
    let state: ConversationState | null = null;
    let ready = false;
    let lastAsked: string | null = "x";
    // The bank is 11 topics; readiness now also waits on the four MUST_ASK ids,
    // so the wrap-up lands later than it did before the #424 gate was mirrored.
    for (let i = 0; i < 20 && !ready; i++) {
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
        asked_question_ids: [
          "role",
          "machines",
          "experience",
          "current_location",
          ...MUST_ASK_TOPICS,
        ],
        unanswered_essentials: ["current_location"],
      };
      const t = mockProfilingTurn(stale);
      expect(t.updated_state.unanswered_essentials).toEqual([]);
      expect(t.extraction_ready).toBe(true);
    });

    it("extraction_ready agrees with the recomputed signal AND the must-ask gate on every asking turn", () => {
      let state = null as Parameters<typeof mockProfilingTurn>[0];
      for (let i = 0; i < 20; i++) {
        const t = mockProfilingTurn(state);
        state = t.updated_state;
        if (t.asked_question_id !== null) {
          const s = t.updated_state;
          // Readiness is decided BEFORE this turn's question is pushed, so the
          // question being asked right now does not count as already-asked.
          const askedBefore = s.asked_question_ids.filter((id) => id !== t.asked_question_id);
          const mustAskDone = MUST_ASK_TOPICS.every(
            (m) => askedBefore.includes(m) || s.answered_topics.includes(m),
          );
          expect(t.extraction_ready).toBe(s.unanswered_essentials.length === 0 && mustAskDone);
        }
      }
    });
  });

  // Parity with apps/ai-service/app/profiling/{question_bank,interview_engine}.py.
  // The ids cross the wire, so a divergence silently desynchronises a session that
  // switches between the real engine and this mock mid-interview.
  describe("engine parity", () => {
    it("mirrors question_bank.py _CNC_VMC_TOPICS ids, in order", () => {
      expect(MOCK_TOPIC_IDS).toEqual([
        "role",
        "machines",
        "experience",
        "skills",
        "current_location",
        "preferred_locations",
        "controllers",
        "salary_current",
        "salary_expected",
        "availability",
        "education",
      ]);
    });

    it("has no combined 'salary' or retired 'location' id", () => {
      expect(MOCK_TOPIC_IDS).not.toContain("salary");
      expect(MOCK_TOPIC_IDS).not.toContain("location");
    });

    // Mirrors the engine's test_every_must_ask_topic_exists_in_the_bank: an id the
    // bank cannot serve would wedge readiness until the bank ran dry.
    it("every MUST_ASK id exists in the topic bank", () => {
      for (const id of MUST_ASK_TOPICS) expect(MOCK_TOPIC_IDS).toContain(id);
    });

    it("asks current_location WITHOUT conflating preferred_locations", () => {
      let state = null as Parameters<typeof mockProfilingTurn>[0];
      const questions = new Map<string, string>();
      for (let i = 0; i < 20; i++) {
        const t = mockProfilingTurn(state);
        state = t.updated_state;
        if (t.asked_question_id) questions.set(t.asked_question_id, t.reply_text);
      }
      // The two topics are asked separately, and the current-location question no
      // longer smuggles in "kahan kaam karne ke liye ready ho".
      expect(questions.has("current_location")).toBe(true);
      expect(questions.has("preferred_locations")).toBe(true);
      expect(questions.get("current_location")).not.toMatch(/ready ho/i);
    });

    // The #424 scenario the gate exists for: a fluent worker whose opening message
    // answers the essentials must STILL be asked about money and notice period.
    it("an articulate worker is still asked every must-ask before wrap-up", () => {
      const seeded = {
        ...mockProfilingTurn(null).updated_state,
        answered_topics: ["role", "machines", "experience", "current_location", "skills"],
        asked_question_ids: [] as string[],
        unanswered_essentials: [] as string[],
      };
      let state = seeded as Parameters<typeof mockProfilingTurn>[0];
      const asked: string[] = [];
      let wrapped = false;
      for (let i = 0; i < 20 && !wrapped; i++) {
        const t = mockProfilingTurn(state);
        state = t.updated_state;
        if (t.asked_question_id) asked.push(t.asked_question_id);
        else wrapped = true;
      }
      expect(wrapped).toBe(true);
      for (const id of MUST_ASK_TOPICS) expect(asked).toContain(id);
    });

    it("always terminates — the finite bank wraps up even if the gate is never met", () => {
      // asked_question_ids pre-filled with every must-ask makes the gate reachable
      // only via the bank running dry; the loop must still end.
      let state = null as Parameters<typeof mockProfilingTurn>[0];
      let wrapped = false;
      for (let i = 0; i < 50 && !wrapped; i++) {
        const t = mockProfilingTurn(state);
        state = t.updated_state;
        if (t.asked_question_id === null) wrapped = true;
      }
      expect(wrapped).toBe(true);
    });
  });
});
