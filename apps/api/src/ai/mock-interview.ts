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
}

// Ordered CNC/VMC interview flow — core topics first. Mirrors question_bank.py.
const MOCK_TOPICS: readonly MockTopic[] = [
  { id: "role", question: "Bhai, aap mainly kya kaam karte ho — CNC, VMC, HMC operator, setter ya programmer?", core: true },
  { id: "machines", question: "Kaunsi machine pe sabse zyada kaam kiya hai — VMC, CNC lathe, HMC ya grinding?", core: true },
  { id: "experience", question: "Total kitne saal ka experience hai is line me?", core: true },
  { id: "skills", question: "Setting khud karte ho ya sirf operation? Tool offset, program edit ya drawing reading me se kya aata hai?", core: true },
  { id: "location", question: "Abhi aap kis city me ho, aur kahan kaam karne ke liye ready ho?", core: true },
  { id: "controllers", question: "Controller kaunsa chalaya hai — Fanuc, Siemens, Mitsubishi, Haas ya Heidenhain?", core: false },
  { id: "salary", question: "Abhi salary kitni hai aur kitni expect kar rahe ho?", core: false },
  { id: "availability", question: "Join karne me kitne din lagenge — abhi free ho ya notice chal raha hai?", core: false },
  { id: "education", question: "ITI ya diploma kiya hai? RVM CAD ya koi aur training li hai?", core: false },
];

// Must be answered before the profile is extraction-ready (mirrors the engine).
const ESSENTIAL_TOPICS = ["role", "machines", "experience", "location"] as const;

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

  // Optimistically mark the previously-asked (still-open) topic as answered so
  // the interview progresses. (The real engine derives this from the message.)
  const lastAsked = st.asked_question_ids[st.asked_question_ids.length - 1];
  if (lastAsked && !st.answered_topics.includes(lastAsked)) {
    st.answered_topics.push(lastAsked);
  }

  const extractionReady = ESSENTIAL_TOPICS.every((t) => st.answered_topics.includes(t));
  const next = MOCK_TOPICS.find(
    (t) => !st.asked_question_ids.includes(t.id) && !st.answered_topics.includes(t.id),
  );

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
    suggested_followups: [
      "Controller kaunsa — Fanuc ya Siemens?",
      "Setting karte ho ya sirf operation?",
    ],
  };
}
