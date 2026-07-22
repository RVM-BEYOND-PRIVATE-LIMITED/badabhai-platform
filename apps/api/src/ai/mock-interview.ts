import type { ConversationState } from "@badabhai/ai-contracts";

/**
 * Mock mirror of the Python interview engine
 * (apps/ai-service/app/profiling/{interview_engine,question_bank}.py).
 *
 * Used ONLY by the AiService mock fallback so the interview still advances
 * across turns when the FastAPI AI service is unreachable (local dev / e2e).
 * The Python engine is the source of truth; this is a deliberately simpler
 * mirror: it advances by `asked_question_ids` (so Q1 is never repeated) but does
 * not parse the worker's message for signals — it optimistically marks the
 * previously-asked topic as answered to keep progressing.
 */

interface MockTopic {
  id: string;
  question: string; // warm bada-bhai phrasing, used directly in mock mode
  core: boolean;
  /**
   * Tap-to-answer options for THIS topic — short ANSWERS, never questions.
   *
   * Mirrors `Topic.options` in `question_bank.py`, and mirroring it here is not
   * cosmetic: TD81 means staging runs the MOCK AI path, so whatever this file
   * serves is what a real staging worker taps. The strings are therefore kept
   * byte-identical to the Python bank — the Python side executes every one of
   * them against the detector (`tests/test_answer_chips.py`), which is the only
   * place that verification can happen, so a divergence here is a silent loss of
   * that guarantee.
   *
   * The phrasing of `question` above is deliberately warmer than the engine's;
   * these are NOT, for exactly that reason.
   *
   * Omitted = free text only (the two location topics: an open answer space,
   * where any four cities we offered would be four cities we put in the worker's
   * mouth).
   */
  options?: readonly string[];
}

// Ordered CNC/VMC interview flow — core topics first. Mirrors question_bank.py
// `_CNC_VMC_TOPICS`: same ids, same order. The PHRASING is deliberately warmer
// here (mock mode replies with these strings directly); the IDS are not ours to
// vary — they cross the wire in `asked_question_ids` / `answered_topics` and a
// session can switch between the real engine and this mock mid-interview.
const MOCK_TOPICS: readonly MockTopic[] = [
  { id: "role", question: "Bhai, aap mainly kya kaam karte ho — CNC, VMC, HMC operator, setter ya programmer?", core: true , options: ["VMC operator", "CNC turner", "Setter", "Programmer"]},
  { id: "machines", question: "Kaunsi machine pe sabse zyada kaam kiya hai — VMC, CNC lathe, HMC ya grinding?", core: true , options: ["VMC", "CNC lathe", "HMC", "Grinding"]},
  { id: "experience", question: "Total kitne saal ka experience hai is line me?", core: true , options: ["1 saal", "3 saal", "5 saal", "10 saal"]},
  { id: "skills", question: "Setting khud karte ho ya sirf operation? Tool offset, program edit ya drawing reading me se kya aata hai?", core: true , options: ["Setting", "Tool offset", "Program edit", "Drawing reading"]},
  // Id matches the ENGINE's essential topic id (interview_engine.py ESSENTIAL_TOPICS
  // uses "current_location", not the retired combined "location") so cross-mode
  // sessions agree on which essential was answered and the CHAT-UE-1
  // unanswered_essentials list never mints an id the engine retired.
  //
  // The question asks CURRENT city ONLY. It used to also ask "kahan kaam karne ke
  // liye ready ho?" — conflating it with `preferred_locations`, which the engine
  // splits into its own topic under the owner ruling recorded at
  // interview_engine.py:33 ("current AND preferred — do not conflate").
  { id: "current_location", question: "Abhi aap kis city me ho?", core: true },
  { id: "preferred_locations", question: "Kaam ke liye kaunse sheher tak ja sakte ho?", core: true },
  { id: "controllers", question: "Controller kaunsa chalaya hai — Fanuc, Siemens, Mitsubishi, Haas ya Heidenhain?", core: false , options: ["Fanuc", "Siemens", "Mitsubishi", "Haas"]},
  // Split to mirror the engine's two salary topics. A single combined "salary" id
  // could never satisfy the MUST_ASK gate below — it is not in the question bank.
  { id: "salary_current", question: "Abhi salary kitni mil rahi hai?", core: false , options: ["15 hazar", "20 hazar", "25 hazar", "30 hazar"]},
  { id: "salary_expected", question: "Aur kitni salary expect kar rahe ho?", core: false , options: ["25 hazar", "30 hazar", "35 hazar", "40 hazar"]},
  { id: "availability", question: "Join karne me kitne din lagenge — abhi free ho ya notice chal raha hai?", core: false , options: ["Turant", "15 din", "1 mahina", "2 mahina"]},
  { id: "education", question: "ITI ya diploma kiya hai? RVM CAD ya koi aur training li hai?", core: false , options: ["ITI", "Diploma", "ITI nahi kiya"]},
  { id: "certifications", question: "Koi certificate hai — NCVT, NSQF ya apprenticeship?", core: false , options: ["NCVT", "SCVT", "NSQF", "Apprenticeship"]},
];

// Must be ANSWERED before the profile is extraction-ready (mirrors the engine's
// ESSENTIAL_TOPICS tuple in interview_engine.py, ids included).
const ESSENTIAL_TOPICS = ["role", "machines", "experience", "current_location"] as const;

// Must at least have been ASKED (answering stays optional) before extraction is
// offered — mirrors interview_engine.py MUST_ASK_TOPICS and the issue #424 owner
// ruling: salary and notice period are what payers filter on, yet they gated
// nothing, so a fluent worker could be wrapped up having never been asked.
//
// This mirror matters more than it looks: TD81 means staging runs the mock
// everywhere, so without this gate the #424 ruling is never exercised outside
// production. Every id below is a MOCK_TOPICS id — one that is not would be
// unaskable and would wedge the interview until the bank ran dry.
// Owner ruling 2026-07-22: education and certifications were never asked at all.
// Not "sometimes skipped" — with a cooperative worker they were UNREACHABLE,
// because `education` was the LAST bank topic and readiness was already satisfied
// by the earlier must-asks, so the wrap-up fired before the bank drained. A
// worker's ITI could not reach their resume by any path. Making the last topic
// must-ask makes readiness unreachable until the bank is exhausted.
export const MUST_ASK_TOPICS = [
  "preferred_locations",
  "salary_current",
  "salary_expected",
  "availability",
  "education",
  "certifications",
] as const;

/** Topic ids in bank order. Exported so the parity tests can pin them against
 *  question_bank.py without exposing the mock's (deliberately different) phrasing. */
export const MOCK_TOPIC_IDS: readonly string[] = MOCK_TOPICS.map((t) => t.id);

/**
 * Tap-to-answer chips per topic, for topics that have them.
 *
 * Exported for the parity test only. Unlike `question`, these strings are NOT ours
 * to vary — they are the worker's answer of record the moment a chip is tapped, and
 * only the Python suite can execute them against the detector.
 */
export const MOCK_TOPIC_OPTIONS: Readonly<Record<string, readonly string[]>> =
  Object.fromEntries(
    MOCK_TOPICS.filter((t) => t.options?.length).map((t) => [t.id, t.options!]),
  );

const ACK = "Badhiya bhai. ";
const WRAP_UP =
  "Bahut badhiya bhai \u{1F44D} itni jaankari kaafi hai — main aapka profile bana deta hoon. " +
  "Kuch chhoti detail baad me confirm kar lenge.";

export interface MockTurnResult {
  reply_text: string;
  asked_question_id: string | null;
  updated_state: ConversationState;
  extraction_ready: boolean;
  suggested_followups: string[];
}

function freshState(roleFamily: string): ConversationState {
  return {
    role_family: roleFamily,
    turn_count: 0,
    answered_topics: [],
    asked_question_ids: [],
    collected: {},
    // COST-4 clarify bound (additive contract field). The API-side mock advances
    // every turn (it has no clarify path), so the streak counter stays 0 here.
    clarify_count: 0,
    // INTERVIEW-1 per-topic ask counts (additive contract field). This API-side
    // mock optimistically marks the last-asked topic answered every turn, so it
    // never re-asks and the map stays empty here; the Python engine owns the
    // bounded re-ask.
    ask_counts: {},
    // INTERVIEW-1 completeness signal (additive contract field). Placeholder only:
    // mockProfilingTurn recomputes it every turn (CHAT-UE-1 surfaces it to the
    // client, so even in mock mode empty must MEAN "all essentials answered").
    unanswered_essentials: [],
  };
}

/** Advance the mock interview by one turn (pure; returns a new state). */
export function mockProfilingTurn(
  state: ConversationState | null | undefined,
  roleFamily = "cnc_vmc",
): MockTurnResult {
  const st: ConversationState = state
    ? {
        ...state,
        answered_topics: [...state.answered_topics],
        asked_question_ids: [...state.asked_question_ids],
        collected: { ...state.collected },
      }
    : freshState(roleFamily);
  st.role_family = roleFamily;
  st.turn_count += 1;
  // Mirrors the engine: every ADVANCE ends a clarify streak (this mock has no
  // clarify path, so the counter never grows here either).
  st.clarify_count = 0;

  // Optimistically mark the previously-asked (still-open) topic as answered so
  // the interview progresses. (The real engine derives this from the message.)
  const lastAsked = st.asked_question_ids[st.asked_question_ids.length - 1];
  if (lastAsked && !st.answered_topics.includes(lastAsked)) {
    st.answered_topics.push(lastAsked);
  }

  // CHAT-UE-1: recompute the completeness signal every turn (mirrors the engine's
  // `_unanswered_essentials`, interview_engine.py). Two things depend on this:
  // a stale list persisted by a prior REAL-engine turn must not survive a fallback
  // turn (it could otherwise contradict extraction_ready forever), and on a fresh
  // AI-down session empty must mean "all essentials answered" — never "not computed".
  st.unanswered_essentials = ESSENTIAL_TOPICS.filter((t) => !st.answered_topics.includes(t));

  // Mirrors the engine's B-4 gate: essentials ANSWERED *and* every must-ask at
  // least ASKED. Asked-or-answered, never answer-required — a worker who declines
  // to name a salary must still be able to finish.
  const mustAskSatisfied = MUST_ASK_TOPICS.every(
    (t) => st.asked_question_ids.includes(t) || st.answered_topics.includes(t),
  );
  const extractionReady = st.unanswered_essentials.length === 0 && mustAskSatisfied;
  const next = MOCK_TOPICS.find(
    (t) => !st.asked_question_ids.includes(t.id) && !st.answered_topics.includes(t.id),
  );

  // `!next` (bank exhausted) still wraps up even if the gate is unmet — the bank
  // is finite, so this is the termination guarantee, not a bypass.
  if (!next || extractionReady) {
    return {
      reply_text: WRAP_UP,
      asked_question_id: null,
      updated_state: st,
      extraction_ready: true,
      suggested_followups: [],
    };
  }

  st.asked_question_ids.push(next.id);
  return {
    reply_text: ACK + next.question,
    asked_question_id: next.id,
    updated_state: st,
    extraction_ready: false,
    // The chips belong to the question being asked THIS turn.
    //
    // This used to be two hard-coded QUESTIONS served on every turn regardless of
    // topic. The worker app sends a tapped chip's label verbatim as the worker's
    // message, and the first of those two measured to
    // `{controllers: ['Fanuc','Siemens']}` — one tap recorded two controllers the
    // worker never named, on a turn that may have been asking about salary.
    suggested_followups: [...(next.options ?? [])],
  };
}
