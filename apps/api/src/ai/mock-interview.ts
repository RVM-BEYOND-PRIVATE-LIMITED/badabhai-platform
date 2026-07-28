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

// Ordered interview flow per role family — core topics first. Mirrors
// question_bank.py `_*_TOPICS`: same ids, same order. The PHRASING is
// deliberately warmer here (mock mode replies with these strings directly);
// the IDS are not ours to vary — they cross the wire in `asked_question_ids` /
// `answered_topics` and a session can switch between the real engine and this
// mock mid-interview.

// Shared topics (identical across all families)
const _SHARED_MOCK: readonly MockTopic[] = [
  { id: "experience", question: "Total kitne saal ka experience hai is line me?", core: true , options: ["1 saal", "3 saal", "5 saal", "10 saal"]},
  // Id matches the ENGINE's essential topic id (interview_engine.py ESSENTIAL_TOPICS
  // uses "current_location", not the retired combined "location") so cross-mode
  // sessions agree on which essential was answered.
  { id: "current_location", question: "Abhi aap kis city me ho?", core: true },
  { id: "preferred_locations", question: "Kaam ke liye kaunse sheher tak ja sakte ho?", core: true },
  { id: "salary_current", question: "Abhi salary kitni mil rahi hai?", core: false , options: ["15 hazar", "20 hazar", "25 hazar", "30 hazar"]},
  { id: "salary_expected", question: "Aur kitni salary expect kar rahe ho?", core: false , options: ["25 hazar", "30 hazar", "35 hazar", "40 hazar"]},
  { id: "availability", question: "Join karne me kitne din lagenge — abhi free ho ya notice chal raha hai?", core: false , options: ["Turant", "15 din", "1 mahina", "2 mahina"]},
  { id: "education", question: "ITI ya diploma kiya hai? Koi aur training li hai?", core: false , options: ["ITI", "Diploma", "ITI nahi kiya"]},
  { id: "education_level", question: "Aapne kahan tak padhai ki hai — 10th, 12th ya B.Tech?", core: false },
  { id: "education_field", question: "Kis field me padhai ki — Electronics ya Computer Science?", core: false },
  { id: "certifications", question: "Koi certificate hai — NCVT, NSQF ya apprenticeship?", core: false , options: ["NCVT", "SCVT", "NSQF", "Apprenticeship"]},
];

const MOCK_TOPICS_CNC: readonly MockTopic[] = [
  { id: "role", question: "Bhai, aap mainly kya kaam karte ho — CNC, VMC, HMC operator, setter ya programmer?", core: true , options: ["VMC operator", "CNC turner", "Setter", "Programmer"]},
  { id: "machines", question: "Kaunsi machine pe sabse zyada kaam kiya hai — VMC, CNC lathe, HMC ya grinding?", core: true , options: ["VMC", "CNC lathe", "HMC", "Grinding"]},
  { id: "skills", question: "Setting khud karte ho ya sirf operation? Tool offset, program edit ya drawing reading me se kya aata hai?", core: true , options: ["Setting", "Tool offset", "Program edit", "Drawing reading"]},
  { id: "controllers", question: "Controller kaunsa chalaya hai — Fanuc, Siemens, Mitsubishi, Haas ya Heidenhain?", core: false , options: ["Fanuc", "Siemens", "Mitsubishi", "Haas"]},
  ..._SHARED_MOCK,
];

const MOCK_TOPICS_WELDING: readonly MockTopic[] = [
  { id: "role", question: "Bhai, aap mainly kya kaam karte ho — MIG, TIG, arc ya gas cutting?", core: true , options: ["MIG welder", "TIG welder", "Arc welder", "Gas cutter"]},
  { id: "equipment", question: "Kaunsi welding machine use karte ho — MIG, TIG, arc ya plasma cutter?", core: true , options: ["MIG welder", "TIG welder", "Arc welder", "Plasma cutter"]},
  { id: "skills_welding", question: "MIG welding, TIG welding, arc welding, grinding — inme se kya aata hai?", core: true , options: ["MIG welding", "TIG welding", "Arc welding", "Grinding"]},
  { id: "materials", question: "Kaunsi material pe welding karte ho — mild steel, stainless ya aluminum?", core: false , options: ["Mild steel", "Stainless", "Aluminum"]},
  { id: "position", question: "Kis position me welding aata hai — flat, vertical ya overhead bhi?", core: false , options: ["Flat", "Vertical", "Overhead", "Pipe (6G)"]},
  { id: "certifications", question: "Koi welding certification hai — 6G, 6GR ya AWS?", core: false , options: ["6G", "6GR", "AWS", "NCVT"]},
  ..._SHARED_MOCK,
];

const MOCK_TOPICS_PLUMBING: readonly MockTopic[] = [
  { id: "role", question: "Bhai, aap mainly kya kaam karte ho — plumber, pipe fitter ya drainage work?", core: true , options: ["Plumber", "Pipe fitter", "Drainage work", "Water supply"]},
  { id: "tools_plumbing", question: "Kaunse tools use karte ho — pipe wrench, threading machine ya cutter?", core: true , options: ["Pipe wrench", "Threading machine", "Pipe cutter", "Pipe bender"]},
  { id: "skills_plumbing", question: "Pipe fitting, drainage, water supply — inme se kya aata hai?", core: true , options: ["Pipe fitting", "Drainage", "Water supply", "Drawing reading"]},
  { id: "specialization_plumbing", question: "Kis type ka plumbing karte ho — residential, commercial ya industrial?", core: false , options: ["Residential", "Commercial", "Industrial"]},
  ..._SHARED_MOCK,
];

const MOCK_TOPICS_CARPENTRY: readonly MockTopic[] = [
  { id: "role", question: "Bhai, aap mainly kya kaam karte ho — carpenter, furniture maker ya kitchen fitter?", core: true , options: ["Furniture maker", "Carpenter", "Kitchen fitter", "Shuttering carpenter"]},
  { id: "tools_carpentry", question: "Kaunsi machine use karte ho — circular saw, planer ya router?", core: true , options: ["Circular saw", "Planer", "Router", "Sander"]},
  { id: "skills_carpentry", question: "Cutting, assembly, polishing, drawing reading — inme se kya aata hai?", core: true , options: ["Cutting", "Assembly", "Polishing", "Drawing reading"]},
  { id: "specialization_carpentry", question: "Kis type ka kaam karte ho — furniture, kitchen, construction ya finishing?", core: false , options: ["Furniture", "Kitchen", "Construction", "Finishing"]},
  ..._SHARED_MOCK,
];

const MOCK_TOPICS_DESIGN: readonly MockTopic[] = [
  { id: "role", question: "Bhai, aap mainly kya kaam karte ho — graphic designer, product designer ya mechanical designer?", core: true , options: ["Graphic designer", "Product designer", "Mechanical designer", "Fashion designer"]},
  { id: "software_design", question: "Kaunsa software use karte ho — AutoCAD, SolidWorks ya Photoshop?", core: true , options: ["AutoCAD", "SolidWorks", "CATIA", "Photoshop"]},
  { id: "skills_design", question: "2D drafting, 3D modeling, rendering — inme se kya aata hai?", core: true , options: ["2D drafting", "3D modeling", "Rendering", "Drawing reading"]},
  { id: "specialization_design", question: "Kis field me design karte ho — mechanical, architecture ya branding?", core: false , options: ["Mechanical", "Architecture", "Branding", "Fashion"]},
  ..._SHARED_MOCK,
];

const MOCK_TOPICS_INTERIOR: readonly MockTopic[] = [
  { id: "role", question: "Bhai, aap mainly kya kaam karte ho — residential, commercial ya retail designer?", core: true , options: ["Residential designer", "Commercial designer", "Retail designer", "Hospitality designer"]},
  { id: "software_interior", question: "Kaunsa software use karte ho — AutoCAD, SketchUp ya 3ds Max?", core: true , options: ["AutoCAD", "SketchUp", "3ds Max", "Revit"]},
  { id: "skills_interior", question: "Space planning, material selection, 3D visualization — inme se kya aata hai?", core: true , options: ["Space planning", "Material selection", "3D visualization", "Lighting design"]},
  { id: "specialization_interior", question: "Kis type ka interior karte ho — home, office, showroom ya hotel?", core: false , options: ["Home", "Office", "Showroom", "Hotel"]},
  ..._SHARED_MOCK,
];

// Lookup by role family
const MOCK_TOPICS_BY_FAMILY: Record<string, readonly MockTopic[]> = {
  cnc_vmc: MOCK_TOPICS_CNC,
  welding: MOCK_TOPICS_WELDING,
  plumbing: MOCK_TOPICS_PLUMBING,
  carpentry: MOCK_TOPICS_CARPENTRY,
  design: MOCK_TOPICS_DESIGN,
  interior_design: MOCK_TOPICS_INTERIOR,
};

function mockTopicsFor(roleFamily: string): readonly MockTopic[] {
  return MOCK_TOPICS_BY_FAMILY[roleFamily] ?? MOCK_TOPICS_CNC;
}

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
  // TD-EDU (owner 2026-07-23): two academic-education asks, mirroring the engine.
  "education_level",
  "education_field",
  "certifications",
] as const;

/** Topic ids in bank order for the CNC/VMC family (default). Exported so the
 *  parity tests can pin them against question_bank.py without exposing the
 *  mock's (deliberately different) phrasing. */
export const MOCK_TOPIC_IDS: readonly string[] = MOCK_TOPICS_CNC.map((t) => t.id);

/**
 * Tap-to-answer chips per topic, for topics that have them — CNC/VMC family.
 *
 * Exported for the parity test only. Unlike `question`, these strings are NOT ours
 * to vary — they are the worker's answer of record the moment a chip is tapped, and
 * only the Python suite can execute them against the detector.
 */
export const MOCK_TOPIC_OPTIONS: Readonly<Record<string, readonly string[]>> =
  Object.fromEntries(
    MOCK_TOPICS_CNC.filter((t) => t.options?.length).map((t) => [t.id, t.options!]),
  );

/** All mock topics, keyed by role family. Exported for tests to verify family coverage. */
export const MOCK_TOPICS_BY_FAMILY_MAP: Readonly<Record<string, readonly MockTopic[]>> =
  MOCK_TOPICS_BY_FAMILY;

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
  const topics = mockTopicsFor(roleFamily);
  const next = topics.find(
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
