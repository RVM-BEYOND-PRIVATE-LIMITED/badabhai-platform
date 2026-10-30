import { describe, expect, it } from "vitest";

import type { QuestionPack, QuestionPackItem } from "@badabhai/ai-contracts";

import { recordAnswer, recordDeclined, toAnswerMap, type AnswerMap } from "./answer-map";
import type { AnswerRecord } from "@badabhai/ai-contracts";
import {
  askCount,
  clarify,
  closingReplyFor,
  hasUnservedOptional,
  isMiddleWayPack,
  MAX_ABUSIVE_TURNS,
  MAX_ASKS_PER_QUESTION,
  MAX_CONSECUTIVE_CLARIFIES,
  MAX_ENGINE_ASKS,
  MAX_ENGINE_TURNS,
  MIDDLEWAY_TURNS_HARD_CAP,
  nextQuestion,
  progressReplyText,
  reAsk,
  remainingQuestions,
  servedText,
  withoutProgressLead,
  CLOSING_REPLY_TEXT,
  PROGRESS_REPLY_MAX_COUNT,
  PROGRESS_REPLY_NO_COUNT_TEXT,
  PROGRESS_REPLY_PAIRS,
  REQUIRED_COMPLETE_REPLY_TEXT,
  REQUIRED_TURNS_SOFT_CAP,
  type EnginePacks,
  type EngineState,
} from "./next-question";

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

let order = 0;

function item(partial: Partial<QuestionPackItem> & { question_key: string }): QuestionPackItem {
  return {
    prompt_text: `${partial.question_key}?`,
    display_order: order++,
    target_kind: "rfs",
    target_field: null,
    target_skill_id: null,
    answer_type: "text",
    is_mandatory: false,
    is_core: false,
    max_asks: MAX_ASKS_PER_QUESTION,
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

function pack(id: string, items: QuestionPackItem[]): QuestionPack {
  return {
    pack_id: id,
    version: 1,
    family_id: "fam_cnc_machining",
    locale: "hi",
    status: "active",
    content_hash: `hash_${id}`,
    items,
  };
}

function state(overrides: Partial<EngineState> = {}): EngineState {
  return {
    phase: "occupation_specific",
    turn: 1,
    engineAsks: 0,
    askCounts: {},
    answers: {} as AnswerMap,
    occupation: null,
    servedQuestionKey: null,
    clarifyCount: 0,
    abusiveTurns: 0,
    silentTurns: 0,
    hardshipTurns: 0,
    needsDisambiguation: false,
    ...overrides,
  };
}

function packsOf(occupationItems: QuestionPackItem[], universalItems: QuestionPackItem[] = []) {
  return {
    occupation: pack("pk_cnc", occupationItems),
    universal: pack("pk_universal", universalItems),
  } satisfies EnginePacks;
}

/** Serve one question and fold its ask into the state, as the orchestrator would. */
function afterAsk(current: EngineState, questionKey: string): EngineState {
  return {
    ...current,
    turn: current.turn + 1,
    engineAsks: current.engineAsks + 1,
    askCounts: { ...current.askCounts, [questionKey]: askCount(current, questionKey) + 1 },
    servedQuestionKey: questionKey,
  };
}

// ---------------------------------------------------------------------------
// The two invariants, asserted directly
// ---------------------------------------------------------------------------

describe("INVARIANT: a settled question is never re-served", () => {
  it("holds for an answered question", () => {
    const items = [item({ question_key: "city" }), item({ question_key: "years" })];
    const answers = recordAnswer(
      {},
      {
        questionKey: "city",
        targetField: "current_city",
        valueRaw: "pune",
        valueNormalized: "Pune",
        evidence: null,
      },
      1,
    );
    const decision = nextQuestion(state({ answers }), packsOf(items));
    expect(decision.questionKey).toBe("years");
  });

  it("holds for a DECLINED question — 'nahi pata' is a complete answer", () => {
    // The single most important hard case: a declination is never re-asked and never blocks
    // completion. The alternative is an engine that badgers a worker who has already said they
    // do not know.
    const items = [item({ question_key: "city", is_mandatory: true })];
    const answers = recordDeclined({}, "city", 1);
    const decision = nextQuestion(state({ answers }), packsOf(items));
    expect(decision.kind).toBe("close");
    expect(decision.completionReason).toBe("complete");
  });

  it("holds under a stubbed ALWAYS-BLIND detector, driven to exhaustion", () => {
    // THE SAFETY PROPERTY. Detection is stubbed to capture nothing at all, so every ask is
    // "unanswered". The bound must still hold — it is a pure function of askCount, never of
    // whether the detector understood anything.
    const items = Array.from({ length: 6 }, (_, i) =>
      item({ question_key: `q_${i}`, is_mandatory: i < 2 }),
    );
    const packs = packsOf(items);

    let current = state();
    const served: string[] = [];
    for (let i = 0; i < 200; i += 1) {
      const decision = nextQuestion(current, packs);
      if (decision.kind === "close") break;
      expect(decision.questionKey).not.toBeNull();
      served.push(decision.questionKey as string);
      current = afterAsk(current, decision.questionKey as string);
    }

    // It terminated, and no question exceeded its ceiling.
    expect(nextQuestion(current, packs).kind).toBe("close");
    for (const key of items.map((i) => i.question_key)) {
      const times = served.filter((k) => k === key).length;
      expect(times, `${key} was asked ${times} times`).toBeLessThanOrEqual(MAX_ASKS_PER_QUESTION);
    }
  });
});

describe("INVARIANT: determinism — same state ⇒ same decision", () => {
  it("returns an identical decision for an identical state, every time", () => {
    // What makes the CAS loser's re-run safe: re-running the decision against post-winner state
    // has no history to depend on.
    const packs = packsOf([item({ question_key: "a" }), item({ question_key: "b" })]);
    const s = state({ askCounts: { a: 1 }, turn: 4 });
    const first = nextQuestion(s, packs);
    for (let i = 0; i < 25; i += 1) expect(nextQuestion(s, packs)).toEqual(first);
  });
});

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

describe("bounds", () => {
  it("pins MAX_ENGINE_ASKS against the ARITHMETIC, not against the constant", () => {
    // The reference implementation's zero-margin coupling: the budget must exceed the worst-case
    // blind run, or a confused worker silently deletes questions from the TAIL of the interview.
    // Restating the number here would pin nothing — this derives the requirement instead.
    const mandatory = 4;
    const askOnce = 10;
    const worstCaseBlindRun = mandatory * MAX_ASKS_PER_QUESTION + askOnce;
    expect(MAX_ENGINE_ASKS).toBeGreaterThan(worstCaseBlindRun);
  });

  it("closes on the ask budget even with questions still unanswered", () => {
    const packs = packsOf([item({ question_key: "a", is_mandatory: true })]);
    const decision = nextQuestion(state({ engineAsks: MAX_ENGINE_ASKS }), packs);
    expect(decision.kind).toBe("close");
    expect(decision.completionReason).toBe("ask_budget");
  });

  it("closes on the abuse cap, and the cap OUTRANKS the ask budget", () => {
    const packs = packsOf([item({ question_key: "a" })]);
    const decision = nextQuestion(
      state({ abusiveTurns: MAX_ABUSIVE_TURNS, engineAsks: MAX_ENGINE_ASKS }),
      packs,
    );
    expect(decision.completionReason).toBe("abuse_cap");
  });

  it("clamps a corrupt negative ask count instead of granting extra asks", () => {
    // State arrives as jsonb and may have been written by an older build. A stored -1 would
    // otherwise buy an extra ask and defeat the bound outright.
    const s = state({ askCounts: { a: -5 } });
    expect(askCount(s, "a")).toBe(0);
  });

  it("floors a question that has a record but no count, so an old state cannot reset a budget", () => {
    const answers = toAnswerMap([
      {
        question_key: "a",
        target_field: null,
        value_raw: null,
        value_normalized: null,
        status: "unanswered",
        evidence: null,
        turn: 1,
        history: [],
      },
    ]);
    expect(askCount(state({ answers }), "a")).toBe(1);
  });

  it("never lets a pack item raise the ceiling above the engine's", () => {
    const packs = packsOf([item({ question_key: "a", max_asks: 99, is_mandatory: true })]);
    let current = state();
    let asks = 0;
    for (let i = 0; i < 20; i += 1) {
      const decision = nextQuestion(current, packs);
      if (decision.kind === "close") break;
      asks += 1;
      current = afterAsk(current, "a");
    }
    expect(asks).toBe(MAX_ASKS_PER_QUESTION);
  });
});

// ---------------------------------------------------------------------------
// Priority + phases
// ---------------------------------------------------------------------------

describe("selection priority", () => {
  it("serves mandatory, then core, then optional", () => {
    const items = [
      item({ question_key: "optional_one" }),
      item({ question_key: "core_one", is_core: true }),
      item({ question_key: "mandatory_one", is_mandatory: true }),
    ];
    const packs = packsOf(items);
    let current = state();
    const served: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const decision = nextQuestion(current, packs);
      served.push(decision.questionKey as string);
      current = {
        ...afterAsk(current, decision.questionKey as string),
        answers: recordAnswer(
          current.answers,
          {
            questionKey: decision.questionKey as string,
            targetField: null,
            valueRaw: "x",
            valueNormalized: "x",
            evidence: null,
          },
          current.turn,
        ),
      };
    }
    expect(served).toEqual(["mandatory_one", "core_one", "optional_one"]);
  });

  it("serves the OCCUPATION pack before the universal tail", () => {
    // Workers answer about their own trade fluently; opening with salary has the highest
    // measured abandon rate. The universal block is the tail precisely because it is what a
    // worker is most likely to walk away from.
    const packs = packsOf([item({ question_key: "machines" })], [item({ question_key: "salary" })]);
    expect(nextQuestion(state(), packs).questionKey).toBe("machines");
    expect(nextQuestion(state(), packs).phase).toBe("occupation_specific");
  });

  it("falls to the universal tail once the occupation pack is drained", () => {
    const packs = packsOf([item({ question_key: "machines" })], [item({ question_key: "salary" })]);
    const answers = recordAnswer(
      {},
      {
        questionKey: "machines",
        targetField: null,
        valueRaw: "vmc",
        valueNormalized: "vmc",
        evidence: null,
      },
      1,
    );
    const decision = nextQuestion(state({ answers }), packs);
    expect(decision.questionKey).toBe("salary");
    expect(decision.phase).toBe("universal_tail");
  });

  it("routes to disambiguation before serving anything", () => {
    const packs = packsOf([item({ question_key: "machines" })]);
    const decision = nextQuestion(state({ needsDisambiguation: true }), packs);
    expect(decision.kind).toBe("disambiguate");
    expect(decision.phase).toBe("disambiguate");
  });
});

describe("min_turn / max_turn move a question WITHOUT an engine special case", () => {
  it("withholds a question until its min_turn and drops it after its max_turn", () => {
    const packs = packsOf([
      item({ question_key: "later", min_turn: 5 }),
      item({ question_key: "now" }),
    ]);
    expect(nextQuestion(state({ turn: 1 }), packs).questionKey).toBe("now");

    const answered = recordAnswer(
      {},
      {
        questionKey: "now",
        targetField: null,
        valueRaw: "x",
        valueNormalized: "x",
        evidence: null,
      },
      1,
    );
    expect(nextQuestion(state({ turn: 5, answers: answered }), packs).questionKey).toBe("later");
    // Past max_turn the question is gone rather than served late.
    const expired = packsOf([item({ question_key: "early", max_turn: 2 })]);
    expect(nextQuestion(state({ turn: 9 }), expired).kind).toBe("close");
  });
});

describe("follow-ups are depth 1 and gated on the parent being ANSWERED", () => {
  it("withholds a follow-up until the parent is answered, and not merely declined", () => {
    const packs = packsOf([
      item({ question_key: "parent" }),
      item({ question_key: "child", parent_item_key: "parent" }),
    ]);
    expect(nextQuestion(state(), packs).questionKey).toBe("parent");

    const declined = recordDeclined({}, "parent", 1);
    // A declined parent has nothing to follow up on, so the interview completes rather than
    // asking a question whose premise the worker just disclaimed.
    expect(nextQuestion(state({ answers: declined }), packs).kind).toBe("close");

    const answered = recordAnswer(
      {},
      {
        questionKey: "parent",
        targetField: null,
        valueRaw: "yes",
        valueNormalized: "yes",
        evidence: null,
      },
      1,
    );
    expect(nextQuestion(state({ answers: answered }), packs).questionKey).toBe("child");
  });
});

// ---------------------------------------------------------------------------
// Wording
// ---------------------------------------------------------------------------

describe("served wording has ONE source of truth", () => {
  it("serves prompt_text first and retry_text on the bounded re-ask", () => {
    // MANDATORY, because only a mandatory question gets a second ask — see the ask-once test
    // below. Written against an optional question first, which closed the interview instead:
    // the engine was right and the assumption was wrong.
    const q = item({
      question_key: "city",
      is_mandatory: true,
      retry_text: "Sheher ka naam bataiye",
    });
    expect(servedText(q, 1)).toBe("city?");
    expect(servedText(q, 2)).toBe("Sheher ka naam bataiye");
    // Re-serving the ORIGINAL wording after the retry wording was shown reads as the assistant
    // going backwards, which is why the ask path and the re-serve path share this function.
    const packs = packsOf([q]);
    expect(nextQuestion(state(), packs).promptText).toBe("city?");
    const second = nextQuestion(state({ askCounts: { city: 1 } }), packs);
    expect(second.promptText).toBe("Sheher ka naam bataiye");
    expect(second.isReserve).toBe(true);
  });

  it("falls back to prompt_text when a pack has no retry copy", () => {
    const packs = packsOf([item({ question_key: "city", is_mandatory: true })]);
    expect(nextQuestion(state({ askCounts: { city: 1 } }), packs).promptText).toBe("city?");
  });

  it("ASK-ONCE for core and optional: only a mandatory question earns the re-ask", () => {
    // This mirrors the plan's stated priority verbatim — "unanswered essential under max_asks →
    // any unanswered core at askCount == 0 → any unanswered optional at askCount == 0". A worker
    // is re-asked only for the fields the profile cannot do without; everything else moves on
    // rather than pressing someone who did not answer the first time.
    for (const flags of [{ is_core: true }, {}]) {
      const packs = packsOf([item({ question_key: "q", ...flags })]);
      expect(nextQuestion(state(), packs).questionKey).toBe("q");
      expect(nextQuestion(state({ askCounts: { q: 1 } }), packs).kind).toBe("close");
    }
    const mandatory = packsOf([item({ question_key: "q", is_mandatory: true })]);
    expect(nextQuestion(state({ askCounts: { q: 1 } }), mandatory).questionKey).toBe("q");
  });
});

// ---------------------------------------------------------------------------
// Clarify
// ---------------------------------------------------------------------------

describe("a worker asking back is answered, not penalised", () => {
  it("serves why_text and re-serves the same question, never counting an ask", () => {
    const q = item({ question_key: "city", why_text: "Isse aas-paas ki jobs dikha payenge" });
    const packs = packsOf([q]);
    const s = state({ servedQuestionKey: "city", askCounts: { city: 1 } });
    const decision = clarify(s, packs);
    expect(decision?.kind).toBe("clarify");
    expect(decision?.promptText).toBe("Isse aas-paas ki jobs dikha payenge");
    expect(decision?.questionKey).toBe("city");
    // The ask count is untouched — the caller folds no ask for a clarify.
    expect(askCount(s, "city")).toBe(1);
  });

  it("is bounded, then falls through to ordinary selection", () => {
    const packs = packsOf([item({ question_key: "city", why_text: "because" })]);
    const s = state({ servedQuestionKey: "city", clarifyCount: MAX_CONSECUTIVE_CLARIFIES });
    expect(clarify(s, packs)).toBeNull();
  });

  it("returns null when nothing is on screen or the key is unknown", () => {
    const packs = packsOf([item({ question_key: "city" })]);
    expect(clarify(state(), packs)).toBeNull();
    expect(clarify(state({ servedQuestionKey: "gone" }), packs)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------

describe("progress counts a declination as progress", () => {
  it("advances the bar for answered AND declined", () => {
    const packs = packsOf([item({ question_key: "a" }), item({ question_key: "b" })]);
    expect(nextQuestion(state(), packs).progress).toEqual({ answered: 0, total: 2 });

    const declined = recordDeclined({}, "a", 1);
    // A worker who says "nahi pata" HAS made progress. A bar that disagreed would be telling
    // them otherwise, on the field they were least able to answer.
    expect(nextQuestion(state({ answers: declined }), packs).progress).toEqual({
      answered: 1,
      total: 2,
    });
  });
});

describe("#2308 — the progress line names a count the engine can stand behind", () => {
  it("names the count, singular for one, owner copy without an exclamation mark", () => {
    expect(progressReplyText(4)).toBe("Thoda sa aur. Bas 4 sawaal bache hain.");
    expect(progressReplyText(1)).toBe("Thoda sa aur. Bas 1 sawaal bacha hai.");
  });

  it("an unknown, impossible or too-large count is the no-count line, never a number", () => {
    for (const remaining of [null, 0, -1, 2.5, PROGRESS_REPLY_MAX_COUNT + 1]) {
      expect(progressReplyText(remaining)).toBe(PROGRESS_REPLY_NO_COUNT_TEXT);
    }
    expect(PROGRESS_REPLY_NO_COUNT_TEXT).toBe("Thoda sa aur, jaldi ho jayega.");
  });

  it("pairs every line with its Devanagari twin, no-count first then one per count", () => {
    expect(PROGRESS_REPLY_PAIRS).toHaveLength(PROGRESS_REPLY_MAX_COUNT + 1);
    expect(PROGRESS_REPLY_PAIRS[0]).toEqual([PROGRESS_REPLY_NO_COUNT_TEXT, "थोड़ा सा और, जल्दी हो जाएगा।"]);
    expect(PROGRESS_REPLY_PAIRS[1]).toEqual([progressReplyText(1), "थोड़ा सा और। बस 1 सवाल बचा है।"]);
    expect(PROGRESS_REPLY_PAIRS[3]).toEqual([progressReplyText(3), "थोड़ा सा और। बस 3 सवाल बचे हैं।"]);
  });

  it("strips one leading progress line, so asking twice never stacks two", () => {
    const question = "Aap kis sheher mein rehte hain?";
    expect(withoutProgressLead(`${progressReplyText(3)} ${question}`)).toBe(question);
    expect(withoutProgressLead(`${PROGRESS_REPLY_NO_COUNT_TEXT} ${question}`)).toBe(question);
    expect(withoutProgressLead(PROGRESS_REPLY_NO_COUNT_TEXT)).toBe("");
    expect(withoutProgressLead(question)).toBe(question);
  });

  it("counts what the engine can still serve — not total minus answered", () => {
    const onScreen = item({ question_key: "on_screen" });
    const askedOnce = item({ question_key: "asked_once" });
    const mandatoryReAsk = item({ question_key: "mandatory", is_mandatory: true });
    const later = item({ question_key: "later", min_turn: 9 });
    const gated = item({ question_key: "gated", ask_if: { op: "answered", field: "never" } });
    const fresh = item({ question_key: "fresh" });
    const done = item({ question_key: "done" });
    const answers = recordAnswer(
      {},
      { questionKey: "done", targetField: null, valueRaw: "x", valueNormalized: "x", evidence: null },
      1,
    );
    const current = state({
      answers,
      askCounts: { on_screen: 1, asked_once: 1, mandatory: 1 },
      servedQuestionKey: "on_screen",
    });
    // on screen (asked now) + mandatory re-ask + min_turn wait + never asked = 4. The ask-once
    // item, the unmet ask_if and the answered one are not ahead.
    expect(
      remainingQuestions(
        current,
        [onScreen, askedOnce, mandatoryReAsk, later, gated, fresh, done],
        "on_screen",
      ),
    ).toBe(4);
  });
});

describe("ask_if / skip_if reach the engine", () => {
  it("skips a question whose ask_if is unmet and serves it once it is met", () => {
    const packs = packsOf([
      item({ question_key: "welding_rods", ask_if: { op: "answered", field: "does_welding" } }),
      item({ question_key: "does_welding" }),
    ]);
    expect(nextQuestion(state(), packs).questionKey).toBe("does_welding");

    const answers = recordAnswer(
      {},
      {
        questionKey: "does_welding",
        targetField: null,
        valueRaw: "haan",
        valueNormalized: true,
        evidence: null,
      },
      1,
    );
    expect(nextQuestion(state({ answers }), packs).questionKey).toBe("welding_rods");
  });

  it("honours skip_if over ask_if", () => {
    const packs = packsOf([
      item({
        question_key: "a",
        ask_if: { op: "turn_gte", turn: 0 },
        skip_if: { op: "turn_gte", turn: 0 },
      }),
    ]);
    expect(nextQuestion(state(), packs).kind).toBe("close");
  });
});

describe("before an occupation is pinned", () => {
  const universalOnly: EnginePacks = {
    occupation: null,
    universal: pack("pk_universal", [item({ question_key: "city", is_mandatory: true })]),
  };

  it("reports the identify phase and still serves the universal pack", () => {
    // The universal block is the only thing askable before retrieval resolves an occupation —
    // and asking a worker their city while we work out their trade is better than stalling.
    const decision = nextQuestion(state(), universalOnly);
    expect(decision.phase).toBe("universal_tail");
    expect(decision.questionKey).toBe("city");
  });

  it("counts progress over the universal pack alone", () => {
    expect(nextQuestion(state(), universalOnly).progress).toEqual({ answered: 0, total: 1 });
  });

  it("closes cleanly once the universal pack is drained with no occupation pack", () => {
    const answers = recordDeclined({}, "city", 1);
    expect(nextQuestion(state({ answers }), universalOnly).completionReason).toBe("complete");
  });

  it("clarifies against the universal pack when nothing else is loaded", () => {
    const s = state({ servedQuestionKey: "city", askCounts: { city: 1 } });
    // No why_text on this item: the clarify falls back to re-serving the question itself rather
    // than emitting an empty message.
    expect(clarify(s, universalOnly)?.promptText).toBe("city?");
  });
});

// ---------------------------------------------------------------------------
// #2233 — a value its field's bound refused is re-asked, within the question's own asks
// ---------------------------------------------------------------------------

describe("reAsk — the question on screen again, as a counted ask (#2233)", () => {
  const YEAR = item({ question_key: "training_year", answer_type: "number", max_asks: 2 });
  const LATER = item({ question_key: "later_q" });
  const packs = packsOf([], [YEAR, LATER]);
  const onScreen = afterAsk(state({ phase: "universal_tail" }), "training_year");

  it("re-serves an ask-once item the engine itself would move past", () => {
    // Selection alone moves on: the item is not mandatory, so it is asked once.
    expect(nextQuestion(onScreen, packs).questionKey).toBe("later_q");
    expect(reAsk(onScreen, packs, "training_year")).toMatchObject({
      kind: "ask",
      questionKey: "training_year",
      promptText: YEAR.prompt_text,
      phase: "universal_tail",
      isReserve: true,
    });
  });

  it("serves the retry wording on the re-ask when the item has one", () => {
    const worded = item({ question_key: "worded", retry_text: "Saal batayein." });
    const asked = afterAsk(state(), "worded");
    expect(reAsk(asked, packsOf([worded]), "worded")?.promptText).toBe("Saal batayein.");
    expect(reAsk(asked, packsOf([worded]), "worded")?.phase).toBe("occupation_specific");
  });

  it("is null once the question has spent its asks", () => {
    const spent = afterAsk(onScreen, "training_year");
    expect(reAsk(spent, packs, "training_year")).toBeNull();
  });

  it("is null for a settled question, an unknown key, or a hard bound", () => {
    const settled = {
      ...onScreen,
      answers: recordDeclined(onScreen.answers, "training_year", onScreen.turn),
    };
    expect(reAsk(settled, packs, "training_year")).toBeNull();
    expect(reAsk(onScreen, packs, "nope")).toBeNull();
    expect(reAsk({ ...onScreen, engineAsks: MAX_ENGINE_ASKS }, packs, "training_year")).toBeNull();
    expect(
      reAsk({ ...onScreen, abusiveTurns: MAX_ABUSIVE_TURNS }, packs, "training_year"),
    ).toBeNull();
    expect(reAsk({ ...onScreen, needsDisambiguation: true }, packs, "training_year")).toBeNull();
    expect(reAsk({ ...onScreen, turn: MAX_ENGINE_TURNS + 1 }, packs, "training_year")).toBeNull();
  });
});

describe("Middle-Way required close (P3a) — the 8 settled slots end the interview", () => {
  const TURNER_8 = [
    "primary_trade",
    "turning_machine",
    "turning_experience",
    "turning_level",
    "controller_brand",
    "current_city",
    "salary_expected",
    "availability",
  ];

  function settledAnswers(keys: string[], declined: string[] = []): AnswerMap {
    const answered = keys
      .filter((key) => !declined.includes(key))
      .map(
        (key, i) =>
          ({
            question_key: key,
            status: "answered",
            target_field: key,
            value_normalized: `v${i}`,
            turn_answered: i + 1,
          }) as unknown as AnswerRecord,
      );
    let map = toAnswerMap(answered);
    declined.forEach((key, i) => {
      map = recordDeclined(map, key, answered.length + i + 1);
    });
    return map;
  }

  function turnerPacks(): EnginePacks {
    return {
      occupation: pack("qp_cnc_turning", []),
      universal: pack("pk_universal", []),
    };
  }

  it("closes required_complete when all 8 Turner slots are answered", () => {
    const decision = nextQuestion(
      state({ answers: settledAnswers(TURNER_8) }),
      turnerPacks(),
    );
    expect(decision.kind).toBe("close");
    expect(decision.completionReason).toBe("required_complete");
  });

  it("a declined slot counts as settled — 'nahi pata' closes, never re-asks", () => {
    const answers = settledAnswers(
      TURNER_8.filter((k) => k !== "salary_expected"),
      ["salary_expected"],
    );
    const decision = nextQuestion(state({ answers }), turnerPacks());
    expect(decision.completionReason).toBe("required_complete");
  });

  it("closes plain complete when one required slot is still open", () => {
    const answers = settledAnswers(TURNER_8.filter((k) => k !== "availability"));
    const decision = nextQuestion(state({ answers }), turnerPacks());
    expect(decision.completionReason).toBe("complete");
  });

  it("closes plain complete for a pack outside the Middle-Way four", () => {
    const packs: EnginePacks = {
      occupation: pack("qp_welding", []),
      universal: pack("pk_universal", []),
    };
    const decision = nextQuestion(state({ answers: settledAnswers(TURNER_8) }), packs);
    expect(decision.completionReason).toBe("complete");
  });

  it("closingReplyFor serves the Bas-ho-gaya line only for required_complete", () => {
    expect(closingReplyFor("required_complete")).toBe(REQUIRED_COMPLETE_REPLY_TEXT);
    expect(closingReplyFor("complete")).toBe(CLOSING_REPLY_TEXT);
    expect(closingReplyFor(null)).toBe(CLOSING_REPLY_TEXT);
  });
});

describe("Middle-Way stop rule (P3b) — 14-turn focus, 20-turn stop, optional offer gate", () => {
  const trade = (key: string, mandatory = false) =>
    item({ question_key: key, is_mandatory: mandatory });
  const packs = (occupationItems: QuestionPackItem[], universalItems: QuestionPackItem[] = []) => ({
    occupation: pack("qp_cnc_turning", occupationItems),
    universal: pack("pk_universal", universalItems),
  });
  const settledAnswers = (keys: string[]): AnswerMap =>
    toAnswerMap(
      keys.map(
        (key, i) =>
          ({
            question_key: key,
            status: "answered",
            target_field: key,
            value_normalized: `v${i}`,
            turn_answered: i + 1,
          }) as unknown as AnswerRecord,
      ),
    );

  const fullAnswers = (extra: string[] = []): AnswerMap =>
    settledAnswers([
      "primary_trade",
      "turning_machine",
      "turning_experience",
      "turning_level",
      "controller_brand",
      "current_city",
      "salary_expected",
      "availability",
      ...extra,
    ]);

  it("past 14 turns with the 8 unsettled, trade optionals wait for required slots", () => {
    const p = packs(
      [
        trade("turning_experience", true),
        trade("turning_machine", true),
        trade("turning_level", true),
        trade("turning_operation", false),
      ],
      [trade("current_city", true), trade("salary_expected")],
    );
    // Trade mandatories settled, one plain optional left, salary still open.
    // The universal pool is NEVER filtered: the tail carries the matching-critical
    // city/salary answers and every worker must reach it whole (sim invariant).
    const base = settledAnswers(["turning_experience", "turning_machine", "turning_level", "current_city"]);
    // At 14 turns the engine still serves the optional trade depth…
    expect(nextQuestion(state({ answers: base, turn: REQUIRED_TURNS_SOFT_CAP }), p).questionKey).toBe(
      "turning_operation",
    );
    // …past 14 it skips the trade optional and hurries the unsettled required slot.
    expect(
      nextQuestion(state({ answers: base, turn: REQUIRED_TURNS_SOFT_CAP + 1 }), p).questionKey,
    ).toBe("salary_expected");
  });

  it("has no unconditional 20-turn stop in the engine — the cap lives in the offer path", () => {
    // The 20-turn stop fires only after the worker ACCEPTED the optional offer
    // (orchestrator-owned). The engine itself keeps asking past 20 so a worker
    // who never got the offer is never cut off mid-required.
    const p = packs([trade("turning_experience", true)], [trade("education")]);
    const over = state({ turn: MIDDLEWAY_TURNS_HARD_CAP + 1 });
    expect(nextQuestion(over, p).kind).toBe("ask");
  });

  it("past 20 with everything asked still drains to required_complete, not to a cap", () => {
    const p = packs([trade("turning_experience", true)], [trade("education")]);
    const over = state({
      answers: fullAnswers(["education"]),
      turn: MIDDLEWAY_TURNS_HARD_CAP + 1,
    });
    const decision = nextQuestion(over, p);
    expect(decision.kind).toBe("close");
    expect(decision.completionReason).toBe("required_complete");
  });

  it("the caps do not touch other trades", () => {
    const other: EnginePacks = {
      occupation: pack("qp_welding", [trade("welding_process")]),
      universal: pack("pk_universal", []),
    };
    const late = state({ turn: MIDDLEWAY_TURNS_HARD_CAP + 5 });
    expect(nextQuestion(late, other).questionKey).toBe("welding_process");
    expect(isMiddleWayPack("qp_welding")).toBe(false);
    expect(isMiddleWayPack("qp_cnc_turning")).toBe(true);
    expect(isMiddleWayPack(null)).toBe(false);
  });

  it("hasUnservedOptional is true only while optional depth remains", () => {
    const p = packs([trade("turning_experience", true)], [trade("education")]);
    expect(hasUnservedOptional(p, state())).toBe(true);
    const doneAnswers = fullAnswers(["education"]);
    expect(hasUnservedOptional(p, state({ answers: doneAnswers }))).toBe(false);
    // Mandatory-only packs never gate an offer.
    const mandOnly = packs([trade("turning_experience", true)], [trade("current_city", true)]);
    expect(hasUnservedOptional(mandOnly, state())).toBe(false);
  });
});
