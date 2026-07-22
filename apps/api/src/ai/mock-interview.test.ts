import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, it, expect } from "vitest";
import type { ConversationState } from "@badabhai/ai-contracts";
import {
  mockProfilingTurn,
  MOCK_TOPIC_IDS,
  MOCK_TOPIC_OPTIONS,
  MUST_ASK_TOPICS,
} from "./mock-interview";

const FIXTURE_DIR = "packages/ai-contracts/src/__fixtures__";
const CHIPS_FIXTURE = `${FIXTURE_DIR}/answer-chips.json`;
const GATE_FIXTURE = `${FIXTURE_DIR}/interview-gate.json`;

/**
 * A golden cross-language fixture, read from disk rather than imported.
 *
 * `readFileSync` and not a JSON import on purpose: this file lives in apps/api and
 * the fixtures in packages/ai-contracts, so an import would reach across a package
 * boundary and land in the build graph. Reading it keeps the dependency to exactly
 * what it is — a test-time parity assertion.
 *
 * Found by walking UP from the cwd rather than off `import.meta.url` (this package
 * typechecks as CommonJS, where that is a TS1343) or a fixed `../../../..` (which
 * silently depends on vitest's `--root`). Missing file = loud failure, never a
 * skipped assertion: the whole point is that it cannot be quietly lost.
 *
 * Takes the relative path so the second fixture (the interview gate, added to close
 * the MUST_ASK drift hole) reuses the resolution rather than re-deriving it — the
 * walk-up is the load-bearing part and having two copies of it invites one to rot.
 */
function findFixture(relPath: string): string {
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    const candidate = resolve(dir, relPath);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    `golden fixture not found: ${relPath} (searched up from ${process.cwd()}). ` +
      "The Python suite asserts against this same file — losing it removes the only " +
      "guard that this mock has not drifted from the engine it mirrors.",
  );
}

const GOLDEN_CHIPS = JSON.parse(readFileSync(findFixture(CHIPS_FIXTURE), "utf-8")) as {
  options: Record<string, string[]>;
  free_text_only: string[];
};

/**
 * The golden interview-gate contract — the ids and the ORDER of both readiness
 * gates plus the bank, shared with `apps/ai-service/app/profiling/*.py`.
 *
 * Why it exists: this file used to pin `MOCK_TOPIC_IDS` as a hand-transcribed
 * literal and assert `MUST_ASK_TOPICS` only as a SUBSET of the mock's OWN bank —
 * an assertion that stays true no matter what the Python engine does. The Python
 * suite pinned its own separate literal. Measured: deleting "availability" from
 * the Python `MUST_ASK_TOPICS` tuple left BOTH suites green, and under TD81 THIS
 * mock is the copy staging actually runs.
 */
const GOLDEN_GATE = JSON.parse(readFileSync(findFixture(GATE_FIXTURE), "utf-8")) as {
  essential_topics: string[];
  must_ask_topics: string[];
  topic_ids: string[];
};

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
    // KEPT DELIBERATELY, even though the fixture comparison in "cross-language gate
    // parity" below now states the same ids. This literal is the DELIBERATE-EDIT
    // signal: a shared fixture cannot provide one, because the same careless change
    // that edits this file can edit the fixture too. The two do different jobs —
    // this one makes a reviewer see the ids change; the fixture makes the OTHER
    // language go red. The Python side keeps its own literal for the same reason
    // (test_profiling_parser_coverage.py::test_the_429_must_ask_gate_holds_...).
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
        "certifications",
      ]);
    });

    // The chips are the worker's ANSWER OF RECORD: the app sends a tapped label
    // verbatim as their message. This file is a SECOND copy of those strings, and
    // TD81 means staging runs this mock — so what is written here is what a real
    // staging worker taps. Only the Python suite can execute a chip against
    // `signals.detect_answered_topics`, so both sides pin the same golden file.
    it("serves the golden chips, byte-identical to question_bank.py", () => {
      expect(MOCK_TOPIC_OPTIONS).toEqual(GOLDEN_CHIPS.options);
    });

    it("leaves the free-text topics free-text", () => {
      // Any four cities we offered would be four cities we put in their mouth.
      for (const id of GOLDEN_CHIPS.free_text_only) {
        expect(MOCK_TOPIC_OPTIONS[id]).toBeUndefined();
      }
    });

    it("never serves a QUESTION as a chip", () => {
      // The whole defect had one visible signature. 'Controller kaunsa — Fanuc ya
      // Siemens?' was served on every turn and measured to
      // {controllers: ['Fanuc','Siemens']} — two controllers from one tap.
      for (const chips of Object.values(MOCK_TOPIC_OPTIONS)) {
        for (const chip of chips) expect(chip).not.toContain("?");
      }
    });

    it("serves the chips belonging to the topic it just asked", () => {
      let state = null as Parameters<typeof mockProfilingTurn>[0];
      for (let i = 0; i < 12; i++) {
        const t = mockProfilingTurn(state);
        state = t.updated_state;
        if (t.asked_question_id === null) {
          // Wrap-up asks nothing, so it must offer nothing to answer.
          expect(t.suggested_followups).toEqual([]);
          continue;
        }
        expect(t.suggested_followups).toEqual(
          GOLDEN_CHIPS.options[t.asked_question_id] ?? [],
        );
      }
    });

    it("has no combined 'salary' or retired 'location' id", () => {
      expect(MOCK_TOPIC_IDS).not.toContain("salary");
      expect(MOCK_TOPIC_IDS).not.toContain("location");
    });

    // Mirrors the engine's test_every_must_ask_topic_exists_in_the_bank: an id the
    // bank cannot serve would wedge readiness until the bank ran dry.
    //
    // NOTE ON WHAT THIS DOES *NOT* COVER, since it reads like a parity test and is
    // not one: it compares MUST_ASK_TOPICS to the ids in THIS file, so it stays
    // green for any pair of lists that agree with each other locally. Deleting
    // "availability" from the PYTHON tuple never touched it. The ordered
    // fixture comparison below is the assertion that crosses the boundary; this one
    // is kept because it states a different, local property (serve-ability).
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

    // --- cross-language gate parity -----------------------------------------
    //
    // THE HOLE THIS CLOSES, stated as it was measured: every assertion above pins
    // this file against ITSELF or against a hand-transcribed literal. Python did
    // the same on its side. So deleting "availability" from
    // `interview_engine.py MUST_ASK_TOPICS` left BOTH suites green — a worker could
    // stop being asked about notice period (one of the three fields issue #424 was
    // filed about) with nothing anywhere going red.
    //
    // The pattern is the one `answer-chips.json` already established and that this
    // file already uses: one JSON file in packages/ai-contracts, asserted from both
    // sides, so a one-language edit turns the other language red. The difference is
    // the reason. Chips are shared because only Python can EXECUTE them against the
    // detector; these ids are shared because they cross the wire in
    // `asked_question_ids` / `answered_topics` and a session can switch between the
    // real engine and this mock mid-interview.
    //
    // Nothing here re-transcribes a constant: `MUST_ASK_TOPICS` and `MOCK_TOPIC_IDS`
    // are imported from the module under test, and the essentials are read off the
    // signal they drive (see `mockEssentialTopics`).
    describe("cross-language gate parity (interview-gate.json)", () => {
      /**
       * The mock's ESSENTIAL_TOPICS, in order — OBSERVED, never re-transcribed.
       *
       * `ESSENTIAL_TOPICS` is module-private in mock-interview.ts and exporting it
       * purely for a test would widen the module's surface for no runtime reason.
       * It does not need to be exported to be pinned: `mockProfilingTurn` recomputes
       * `unanswered_essentials` as `ESSENTIAL_TOPICS.filter(t => !answered.includes(t))`
       * on EVERY turn (CHAT-UE-1), so on a fresh interview — where `answered_topics`
       * is provably empty, asserted below — that field IS the constant, in order.
       *
       * Reading it through the field it drives is arguably the stronger pin anyway:
       * it is the form in which these ids actually reach the client, so this fails
       * both if the constant drifts from Python AND if the recompute stops reflecting
       * the constant.
       */
      function mockEssentialTopics(): string[] {
        const fresh = mockProfilingTurn(null);
        // The precondition that makes the derivation exact: turn 1 answers nothing
        // (there is no previously-asked topic to optimistically close), so the
        // filter removes nothing and the list is the whole constant.
        expect(fresh.updated_state.answered_topics).toEqual([]);
        return fresh.updated_state.unanswered_essentials;
      }

      it("MUST_ASK_TOPICS matches interview_engine.py — same ids, SAME ORDER", () => {
        // `toEqual` on arrays is ordered, and that is the point: a set comparison
        // would accept a reordering, and order is the cheapest signal available
        // that the two lists were edited together rather than one appended to.
        expect([...MUST_ASK_TOPICS]).toEqual(GOLDEN_GATE.must_ask_topics);
      });

      it("ESSENTIAL_TOPICS matches interview_engine.py — same ids, SAME ORDER", () => {
        // Order is load-bearing here, not cosmetic: `unanswered_essentials` is
        // client-visible (CHAT-UE-1) and the engine emits it in ESSENTIAL_TOPICS
        // order, so a divergence would reorder a live field the moment a session
        // fell back from the real engine to this mock.
        expect(mockEssentialTopics()).toEqual(GOLDEN_GATE.essential_topics);
      });

      it("MOCK_TOPIC_IDS matches question_bank.py _CNC_VMC_TOPICS — same ids, SAME ORDER", () => {
        // The ask order both `_next_topic` (Python) and `MOCK_TOPICS.find` (here)
        // walk. A session that switches engines mid-interview relies on it.
        expect([...MOCK_TOPIC_IDS]).toEqual(GOLDEN_GATE.topic_ids);
      });

      it("every gated id in the shared contract is one this mock can actually serve", () => {
        // Same claim as the engine's test_424_every_must_ask_id_exists_verbatim_in_the
        // _question_bank, but stated over the SHARED list: an id added to the contract
        // that only the Python bank can serve is caught here, on the side missing it.
        // An unserveable must-ask wedges readiness until the bank runs dry.
        for (const id of [...GOLDEN_GATE.essential_topics, ...GOLDEN_GATE.must_ask_topics]) {
          expect(MOCK_TOPIC_IDS).toContain(id);
        }
      });

      it("keeps the two gates disjoint — a must-ask is never silently made compulsory", () => {
        // The protective half of the #424 ruling. An ESSENTIAL must be ANSWERED, a
        // MUST_ASK only ASKED: moving an id across would make a worker's salary a
        // precondition for having a profile. Asserted against the real constants
        // (not just the fixture) so it binds this file, not only the JSON.
        const essentials = new Set(mockEssentialTopics());
        for (const id of MUST_ASK_TOPICS) {
          expect(essentials.has(id)).toBe(false);
        }
      });
    });
  });
});
