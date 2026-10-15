import { describe, expect, it } from "vitest";
import { parseAffirmation } from "@badabhai/profiling-lexicon";
import type { QuestionPackItem, QuestionPackOption } from "@badabhai/ai-contracts";
import type { FreeChatCategory } from "@badabhai/types";

import { greetingState, enterMode, registerStrike, FREE_CHAT_ASIDE_CAP } from "./free-chat.state";
import {
  confidenceBucketOf,
  DISTRESS_PHRASES,
  DISTRESS_STEMS,
  FREE_CHAT_MIN_CONFIDENCE,
  GREETING_DECLINE_WORDS,
  GREETING_FILLER_WORDS,
  isBareTypedAnswer,
  isBareYesNo,
  isFreeChatChip,
  isResumeChip,
  isYesNoQuestion,
  matchesDistress,
  matchesOfferedOption,
  postClassifyFree,
  postClassifyResume,
  postDistressCheck,
  preClassifyFree,
  preClassifyResume,
  readGreetingChoice,
  readLanguageAnswer,
  TYPED_ANSWER_FILLER_WORDS,
  typedAnswerCarriesWords,
  UNAVAILABLE_VERDICT,
  type FreeChatVerdict,
  type ResumeSkipFacts,
} from "./free-chat.router";

/**
 * The routing table (ADR-0051 §3.2), on pure inputs: deterministic code picks the handler, applies
 * the precedence and the 0.6 floor, and decides what an unavailable classifier means in each mode.
 */

const T0 = new Date("2026-10-06T10:00:00.000Z");
const FREE = enterMode(greetingState(), "free", "chip", T0);
// The language label (§11 R42) is no routing fact: every rule here reads category and confidence.
const v = (category: FreeChatCategory, confidence = 0.9): FreeChatVerdict => ({
  kind: "verdict",
  category,
  confidence,
  language: null,
});

/** A pack option carrying `value`: a yes/no select carries booleans, any other select text. */
const packOption = (value: unknown): QuestionPackOption => ({
  option_key: String(value).toLowerCase(),
  label_text: String(value),
  value,
  implies_skill_id: null,
  is_none_of_above: false,
});

/** A pack question: a field and an answer type, and the options a select offers. */
const packItem = (
  target_field: string | null,
  answer_type: QuestionPackItem["answer_type"],
  options: readonly unknown[] = [],
): QuestionPackItem => ({
  question_key: target_field ?? "q",
  prompt_text: "?",
  display_order: 0,
  target_kind: "attribute",
  target_field,
  target_skill_id: null,
  answer_type,
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
  options: options.map(packOption),
});

const YEARS = packItem("experience_years", "number");
const CITY = packItem("current_city", "text");
const TRAINING = packItem("training_year", "number");
const OUTPUT = packItem("target_output", "number");
const PROCESS = packItem("welding_process", "multi_select", ["MIG welding", "TIG welding"]);
const TOOLS = packItem("own_tools", "boolean");

describe("reading the worker's words deterministically", () => {
  it.each([
    ["Haan, shuru karein", "start"],
    ["free_chat_start", "start"],
    ["haan", "start"],
    ["Haan ji", "start"],
    ["ok", "start"],
    ["shuru karo", "start"],
    ["yes", "start"],
    ["Baad mein", "later"],
    ["free_chat_later", "later"],
    ["baad me", "later"],
    ["abhi nahi", "later"],
    ["later", "later"],
    ["haan nahi", null],
    ["haan mujhe pehle jobs dekhni hain", null],
    ["kaise ho", null],
    // #2223 — a yes word or a later phrase carries ONLY filler; anything else is a message.
    ["haan shuru karo", "start"],
    ["Haan theek hai", "start"],
    ["yes please", "start"],
    ["ok bhai", "start"],
    ["haan ok", "start"],
    ["haan resume banao", "start"],
    ["ok lets go", "start"],
    ["Nahi, baad mein", "later"],
    ["ok baad mein", "later"],
    ["abhi nahi ji", "later"],
    ["baad mein karenge", "later"],
    // Each of these STARTED or read LATER before #2223 — the old reader took any short "haan …".
    ["haan marna hai", null],
    ["ha marna", null],
    ["haan mar jaunga", null],
    ["ok sab khatam", null],
    ["yes give up", null],
    ["abhi nahi jeena", null],
    ["baad mein mar jaunga", null],
    ["baad mein nahi", null],
    ["mat baad mein", null],
    // Null before and after (the old negation rule) — kept as the issue's own example.
    ["ha jeena nahi", null],
  ] as const)("the greeting reads %j as %s", (text, choice) => {
    expect(readGreetingChoice(text)).toBe(choice);
  });

  it("the filler list holds no negation and no word of a Latin distress phrase (#2223)", () => {
    const distressWords = new Set(
      DISTRESS_PHRASES.filter((phrase) => /^[a-z ]+$/.test(phrase)).flatMap((phrase) =>
        phrase.split(" "),
      ),
    );
    for (const word of GREETING_FILLER_WORDS) {
      expect(distressWords.has(word), word).toBe(false);
      expect(GREETING_DECLINE_WORDS.has(word) || word === "mat", word).toBe(false);
    }
  });

  it.each([
    "haan",
    "Haan ji",
    "haan karta hoon",
    "nahi",
    "nahi karta",
    "haan hai",
    "Haan sir",
    "haan bhai",
    "haan mere paas hai",
    "nahi, mere paas nahi hai",
    "जी हाँ",
    "मैं नहीं करता",
    "हाँ, मेरे पास है",
  ])("a typed yes/no that is only an answer: %j (#2226)", (text) => {
    expect(isBareYesNo(text)).toBe(true);
  });

  it.each([
    "haan marna hai",
    "haan mar jaunga",
    "nahi jeena",
    "jeena nahi hai",
    "haan sab khatam",
    "haan, 5 saal se karta hoon",
    "हाँ मरना है",
    // A hidden format character inside "jeena" / "jina" / "जीना" splits it into a yes cue and the
    // tag negator "na" when read as a gap; the deleted reading still sees the word.
    "haan jee\u200Bna nahi hai",
    "haan ji\u200Bna nahi hai",
    "haan jee\u00ADna nahi",
    "जी\u200Dना नहीं है",
    "haan\u200Bmarna",
    // An emoji is never filler.
    "haan 😭💀",
    "nahi 😭",
  ])("a typed yes/no that carries other words: %j (#2226)", (text) => {
    expect(isBareYesNo(text)).toBe(false);
  });

  it("reads a format character between two bare words as bare (#2226)", () => {
    expect(isBareYesNo("haan\u200Bji")).toBe(true);
  });

  // #2250 \u2014 a denied cue that says how the worker IS ("theek", "sahi", "ok") is checked; a denied
  // "ji" or "bilkul" is only a "no".
  it.each([
    "main theek nahi hoon",
    "main sahi nahi hoon",
    "theek nahi",
    "not ok",
    "ok nahi hai",
    "acha nahi",
    "\u092E\u0948\u0902 \u0920\u0940\u0915 \u0928\u0939\u0940\u0902 \u0939\u0942\u0901",
  ])("a denied state cue is no bare yes/no: %j (#2250)", (text) => {
    expect(isBareYesNo(text)).toBe(false);
  });

  it.each(["ji nahi", "bilkul nahi", "nahi, theek hai", "haan theek hai", "theek hai", "ok"])(
    "a plain answer around a state cue stays bare: %j (#2250)",
    (text) => {
      expect(isBareYesNo(text)).toBe(true);
    },
  );

  it.each<[Pick<QuestionPackItem, "answer_type" | "options"> | null, boolean]>([
    [{ answer_type: "boolean", options: [] }, true],
    [{ answer_type: "single_select", options: [packOption(true), packOption(false)] }, true],
    [{ answer_type: "single_select", options: [packOption("MIG"), packOption("TIG")] }, false],
    [{ answer_type: "number", options: [] }, false],
    [{ answer_type: "text", options: [] }, false],
    [null, false],
  ])("a yes/no question: %j → %s (#2226)", (item, yesNo) => {
    expect(isYesNoQuestion(item)).toBe(yesNo);
  });

  // #2250 — any other typed answer is bare when every word its capture did not read is filler.
  it.each<[string, QuestionPackItem, string]>([
    ["years", YEARS, "5 saal"],
    ["years", YEARS, "paanch saal"],
    ["years", YEARS, "mere paas 5 saal hai"],
    ["city", CITY, "Pune"],
    ["city", CITY, "Pune hai, sir"],
    ["training year", TRAINING, "2015"],
    ["no-parser number", OUTPUT, "50"],
    ["no-parser number", OUTPUT, "50 hai ji"],
    ["option", PROCESS, "MIG welding"],
    ["options", PROCESS, "MIG welding, TIG welding"],
  ])("a bare %s answer: %j (#2250)", (_l, item, text) => {
    expect(isBareTypedAnswer(text, item)).toBe(true);
    expect(typedAnswerCarriesWords(text, item)).toBe(false);
  });

  it.each<[string, QuestionPackItem, string]>([
    ["years", YEARS, "5 saal, ab marna hai"],
    ["years", YEARS, "5 saal se kar raha hoon"],
    ["years", YEARS, "5 saal 😭"],
    ["city", CITY, "Pune mein hoon, jeena nahi"],
    ["city", CITY, "Pune\u200Bmarna"],
    ["training year", TRAINING, "2015, ab sab khatam"],
    ["no-parser number", OUTPUT, "50 piece, marna hai"],
    ["no-parser number", OUTPUT, "50 log"],
    ["option", PROCESS, "MIG welding, ab jeena nahi"],
  ])("a %s answer that carries other words: %j (#2250)", (_l, item, text) => {
    expect(isBareTypedAnswer(text, item)).toBe(false);
    expect(typedAnswerCarriesWords(text, item)).toBe(true);
  });

  it("reads a yes/no question by its cues, not by a value (#2226, #2250)", () => {
    expect(typedAnswerCarriesWords("haan ji", TOOLS)).toBe(false);
    expect(typedAnswerCarriesWords("haan marna hai", TOOLS)).toBe(true);
    expect(typedAnswerCarriesWords("main theek nahi hoon", TOOLS)).toBe(true);
  });

  it("the typed-answer filler list holds no negation and no word of a distress phrase (#2226)", () => {
    const distressWords = new Set(
      DISTRESS_PHRASES.flatMap((phrase) => phrase.normalize("NFC").toLowerCase().split(" ")),
    );
    for (const word of TYPED_ANSWER_FILLER_WORDS) {
      expect(distressWords.has(word), word).toBe(false);
      expect(GREETING_DECLINE_WORDS.has(word), word).toBe(false);
      expect(parseAffirmation(word)?.value, word).not.toBe(false);
      expect(word, word).toBe(word.normalize("NFC").toLowerCase());
    }
  });

  it("reads the résumé chip by key or label, accents and case aside", () => {
    expect(isResumeChip("Resume banayein")).toBe(true);
    expect(isResumeChip("free_chat_resume")).toBe(true);
    expect(isResumeChip("  resume BANAYEIN ")).toBe(true);
    expect(isResumeChip("resume banao")).toBe(false);
  });

  it("reads any of the three free-chat chips, by key or label", () => {
    for (const chip of [
      "Haan, shuru karein",
      "free_chat_start",
      "Baad mein",
      "free_chat_later",
      "Resume banayein",
      "free_chat_resume",
    ]) {
      expect(isFreeChatChip(chip)).toBe(true);
    }
    expect(isFreeChatChip("haan")).toBe(false);
    expect(isFreeChatChip("main welder hoon")).toBe(false);
  });

  it("matches an offered option by key or by its normalised label", () => {
    const options = [{ option_key: "pune", label_text: "Pune" }];
    expect(matchesOfferedOption("pune", options)).toBe(true);
    expect(matchesOfferedOption("PUNE.", options)).toBe(true);
    expect(matchesOfferedOption("pune mein", options)).toBe(false);
    expect(matchesOfferedOption("", options)).toBe(false);
  });
});

describe("the distress list (ADR-0051 §5.2) — whole phrases, case- and diacritic-insensitive", () => {
  it.each(DISTRESS_PHRASES)("matches %j inside a sentence", (phrase) => {
    expect(matchesDistress(`main ${phrase} hoon`)).toBe(true);
  });

  it("is case-, punctuation- and diacritic-insensitive, nukta included", () => {
    expect(matchesDistress("SUICIDE.")).toBe(true);
    expect(matchesDistress("khúdkushi")).toBe(true);
    expect(matchesDistress("khud-khushi")).toBe(true);
    expect(matchesDistress("खुदकुशी")).toBe(true);
    expect(matchesDistress("ख़ुदकुशी")).toBe(true);
  });

  it("matches WHOLE phrases only — and a vowel sign is a letter, not an accent", () => {
    expect(matchesDistress("suicidebomber")).toBe(false);
    expect(matchesDistress("marna chahtay")).toBe(false);
    // मारना ("to hit") must not read as मरना ("to die").
    expect(matchesDistress("मारना चाहता")).toBe(false);
    expect(matchesDistress("main kal kaam pe jaana chahta hoon")).toBe(false);
  });

  it("reads an invisible format character inside a word as nothing, not a split (#2228)", () => {
    expect(matchesDistress("mar\u200Bna chahta")).toBe(true);
    expect(matchesDistress("jee\u200Bne ka mann nahi")).toBe(true);
    expect(matchesDistress("mar\u00ADna chahta")).toBe(true);
    expect(matchesDistress("mar\u2060na chahta")).toBe(true);
    expect(matchesDistress("sui\uFEFFcide")).toBe(true);
    expect(matchesDistress("\u0906\u0924\u094D\u092E\u200B\u0939\u0924\u094D\u092F\u093E")).toBe(
      true,
    );
  });

  it("still reads a format character used as a word gap as a gap (#2228)", () => {
    expect(matchesDistress("marna\u200Bchahta")).toBe(true);
    expect(matchesDistress("main\u200Bkal kaam pe jaana chahta hoon")).toBe(false);
    expect(matchesDistress("ma\u200Brna chahtay")).toBe(false);
  });
});

describe("the regional distress list (ADR-0051 §9, #2126) — five languages, both scripts", () => {
  it.each(DISTRESS_STEMS)("a word STARTING with the stem %j matches", (stem) => {
    expect(matchesDistress(stem)).toBe(true);
    // A case ending joined straight onto the noun, the way these languages write it.
    expect(matchesDistress(`naan ${stem}ku yosikkiren`)).toBe(true);
  });

  it.each([
    ["Tamil, inflected", "நான் தற்கொலைக்கு யோசிக்கிறேன்"],
    ["Tamil, Latin", "enakku vaazha pidikkala"],
    ["Telugu, inflected", "నేను ఆత్మహత్యకు ప్రయత్నిస్తా"],
    ["Telugu, Latin", "naaku chanipovalani undi"],
    ["Kannada, inflected", "ನಾನು ಆತ್ಮಹತ್ಯೆಗೆ ಯೋಚನೆ ಮಾಡ್ತಿದೀನಿ"],
    ["Kannada, Latin", "nanage saayabeku anisutte"],
    ["Marathi", "मला मरायचं आहे"],
    ["Marathi, Latin", "mala jagaychi ichha nahi"],
    ["Gujarati", "મારે મરી જવું છે"],
    ["Gujarati, aapghat", "aapghaat karvano vichar aave chhe"],
  ])("%s: %j → distress", (_language, text) => {
    expect(matchesDistress(text)).toBe(true);
  });

  it.each([
    // "adventure" begins like "saaganum" ("to die") and must not read as it.
    "saagasam pidikkum",
    "Marathi mein baat karte hain",
    "naaku cinema ante ishtam",
    "ನನಗೆ ಕೆಲಸ ಬೇಕು",
    "મને નોકરી જોઈએ છે",
    "నాకు ఉద్యోగం కావాలి",
    "எனக்கு வேலை வேண்டும்",
  ])("ordinary talk is not distress: %j", (text) => {
    expect(matchesDistress(text)).toBe(false);
  });
});

describe("free mode — the deterministic rules come first", () => {
  const pre = (text: string, state = FREE, mode: "greeting" | "free" = "free", now = T0) =>
    preClassifyFree({ mode, text, state, now }).kind;

  it("the greeting's chips and typed variants, only in greeting mode", () => {
    expect(pre("Haan", greetingState(), "greeting")).toBe("start");
    expect(pre("Baad mein", greetingState(), "greeting")).toBe("later");
    expect(pre("Haan", FREE, "free")).toBe("classify");
  });

  it.each([
    "haan suicide",
    "ok khudkushi",
    "yes kill myself",
    "baad mein suicide",
    "abhi nahi, marna chahta",
  ])("DISTRESS comes before the greeting's choice: %j → distress", (text) => {
    expect(pre(text, greetingState(), "greeting")).toBe("distress");
  });

  it.each(["haan marna hai", "haan mar jaunga", "abhi nahi jeena", "baad mein mar jaunga"])(
    "distress OFF the fixed list is not swallowed as a greeting choice: %j → classify (#2223)",
    (text) => {
      expect(matchesDistress(text)).toBe(false);
      expect(pre(text, greetingState(), "greeting")).toBe("classify");
    },
  );

  it("no chip key or label is a distress phrase, so distress-first costs a chip nothing", () => {
    for (const chip of [
      "Haan, shuru karein",
      "free_chat_start",
      "Baad mein",
      "free_chat_later",
      "Resume banayein",
      "free_chat_resume",
    ]) {
      expect(matchesDistress(chip)).toBe(false);
    }
  });

  it("the résumé chip, distress, the abuse lexicon, then the classifier", () => {
    expect(pre("Resume banayein")).toBe("start");
    expect(pre("mujhe suicide karna hai")).toBe("distress");
    expect(pre("chutiya")).toBe("strike");
    expect(pre("aaj mausam accha hai")).toBe("classify");
  });

  it.each(["chu\u200Btiya", "bhos\u00ADdike", "gaa\u2060ndu", "haan\u200Bchutiya"])(
    "an invisible format character cannot hide a lexicon word from the strike: %j (#2237)",
    (text) => {
      expect(pre(text)).toBe("strike");
    },
  );

  it("the cool-down blocks typing and the classifier — but not the chip, and not distress", () => {
    let state = FREE;
    for (let i = 0; i < 3; i++) state = registerStrike(state, T0).state;
    expect(pre("hello", state)).toBe("cooldown");
    expect(pre("chutiya", state)).toBe("cooldown");
    expect(pre("Resume banayein", state)).toBe("start");
    expect(pre("jeene ka mann nahi", state)).toBe("distress");
  });

  it("the per-session cap answers before abuse and the classifier", () => {
    const capped = { ...FREE, asides: FREE_CHAT_ASIDE_CAP };
    expect(pre("hello", capped)).toBe("aside_cap");
    expect(pre("Resume banayein", capped)).toBe("start");
  });
});

describe("free mode — the classifier's answer", () => {
  it.each([
    [UNAVAILABLE_VERDICT, { kind: "clarify" }],
    [v("career", FREE_CHAT_MIN_CONFIDENCE - 0.01), { kind: "clarify" }],
    // Distress bypasses the floor.
    [v("distress", 0.3), { kind: "fixed", line: "DISTRESS" }],
    [v("unclear"), { kind: "clarify" }],
    [v("career", FREE_CHAT_MIN_CONFIDENCE), { kind: "reply", category: "career" }],
    [v("casual"), { kind: "reply", category: "casual" }],
    [v("jobs"), { kind: "fixed", line: "JOBS" }],
    [v("off_limits"), { kind: "fixed", line: "OFF_LIMITS" }],
    [v("distress"), { kind: "fixed", line: "DISTRESS" }],
    [v("trash"), { kind: "strike" }],
  ])("%j → %j", (verdict, action) => {
    expect(postClassifyFree(verdict, "kuch bhi")).toEqual(action);
  });

  it("résumé: a first-person claim is the interview's first answer; a bare intent is not", () => {
    expect(postClassifyFree(v("resume"), "main welder hoon, resume banao")).toEqual({
      kind: "start",
      firstTurn: true,
    });
    expect(postClassifyFree(v("resume"), "resume banana hai")).toEqual({
      kind: "start",
      firstTurn: false,
    });
  });
});

describe("résumé mode — the skip list, then the classifier", () => {
  const facts = (over: Partial<ResumeSkipFacts> = {}): ResumeSkipFacts => ({
    capped: false,
    pendingOffer: false,
    gateOpen: false,
    offeredOption: false,
    lexiconClass: "answer",
    typedAnswer: false,
    typedAnswerCarriesWords: false,
    hasPendingQuestion: true,
    asideCapReached: false,
    ...over,
  });

  it("classifies an ordinary message with a question on screen", () => {
    expect(preClassifyResume("aaj mausam accha hai", facts()).kind).toBe("classify");
  });

  it.each([
    ["the turn cap", { capped: true }],
    ["a pending offer", { pendingOffer: true }],
    ["an open gate", { gateOpen: true }],
    ["a tapped option", { offeredOption: true }],
    ["the lexicon's abusive class", { lexiconClass: "abusive" as const }],
    ["the lexicon's empty class", { lexiconClass: "empty" as const }],
    ["the lexicon's dont_know class", { lexiconClass: "dont_know" as const }],
    ["the lexicon's hardship class", { lexiconClass: "hardship" as const }],
    ["the lexicon's question_back class", { lexiconClass: "question_back" as const }],
    ["the lexicon's progress_question class (#2308)", { lexiconClass: "progress_question" as const }],
    ["a typed answer", { typedAnswer: true }],
    ["nothing on screen to re-ask", { hasPendingQuestion: false }],
    ["the aside cap", { asideCapReached: true }],
  ])("passes on %s — with no model call", (_label, over) => {
    expect(preClassifyResume("kuch bhi", facts(over)).kind).toBe("pass");
  });

  it("checks distress before the skip list", () => {
    expect(preClassifyResume("marna chahta hoon", facts({ capped: true })).kind).toBe("distress");
  });

  // #2226 — a typed yes/no that carries other words keeps its skip, behind a distress check.
  const carrying = { typedAnswer: true, typedAnswerCarriesWords: true };

  it("checks a typed yes/no that carries other words for distress", () => {
    expect(preClassifyResume("haan marna hai", facts(carrying)).kind).toBe("distress_check");
  });

  it("reads the carried words only on a typed answer", () => {
    expect(preClassifyResume("kuch bhi", facts({ typedAnswerCarriesWords: true })).kind).toBe(
      "classify",
    );
  });

  it.each([
    ["the turn cap", { capped: true }],
    ["a pending offer", { pendingOffer: true }],
    ["an open gate", { gateOpen: true }],
    ["a tapped option", { offeredOption: true }],
    ["the lexicon's dont_know class", { lexiconClass: "dont_know" as const }],
    ["nothing on screen to re-ask", { hasPendingQuestion: false }],
    ["the aside cap", { asideCapReached: true }],
  ])("every other skip still wins over the check: %s", (_label, over) => {
    expect(preClassifyResume("haan marna hai", facts({ ...carrying, ...over })).kind).toBe("pass");
  });

  it.each([
    [UNAVAILABLE_VERDICT, "pass"],
    [v("distress"), "distress"],
    [v("distress", 0.3), "distress"],
    [v("resume"), "pass"],
    [v("resume", 0.59), "pass"],
    [v("unclear"), "pass"],
    [v("trash"), "pass"],
    [v("career"), "pass"],
    [v("casual"), "pass"],
    [v("jobs"), "pass"],
    [v("off_limits"), "pass"],
  ])("the distress check: %j → %s", (verdict, kind) => {
    expect(postDistressCheck(verdict).kind).toBe(kind);
  });

  it.each([
    [UNAVAILABLE_VERDICT, "pass"],
    [v("resume"), "pass"],
    [v("trash"), "de_escalate"],
    [v("distress"), "distress"],
    [v("distress", 0.3), "distress"],
    [v("unclear"), "clarify"],
    [v("resume", 0.59), "clarify"],
    [v("career"), "deflect"],
    [v("casual"), "deflect"],
    [v("jobs"), "deflect"],
    [v("off_limits"), "deflect"],
  ])("%j → %s", (verdict, kind) => {
    expect(postClassifyResume(verdict).kind).toBe(kind);
  });
});

describe("the confidence buckets — the companion's, unchanged", () => {
  it.each([
    [0, "lt50"],
    [0.49, "lt50"],
    [0.5, "50_70"],
    [0.69, "50_70"],
    [0.7, "70_90"],
    [0.9, "gte90"],
    [1, "gte90"],
  ] as const)("%d → %s", (confidence, bucket) => {
    expect(confidenceBucketOf(confidence)).toBe(bucket);
  });
});

describe("ADR-0051 §11 — the language ask's answer, read deterministically (R41)", () => {
  it.each([
    // The chips: the key a client may post, and the label the app posts.
    ["free_chat_lang_yes", "marathi", "yes"],
    ["Haan, Marathi mein", "marathi", "yes"],
    ["haan, marathi mein", "marathi", "yes"],
    ["Haan, Hindi mein", "hinglish", "yes"],
    ["Haan, English mein", "english", "yes"],
    ["free_chat_lang_no", "marathi", "no"],
    ["Nahi", "tamil", "no"],
    // The typed yes / no, in the chat's languages.
    ["haan", "tamil", "yes"],
    ["aam", "tamil", "yes"],
    ["avunu", "telugu", "yes"],
    ["haudu", "kannada", "yes"],
    ["ho", "marathi", "yes"],
    ["nako", "marathi", "no"],
    ["vendam", "tamil", "no"],
  ] as const)("%j to a %s ask is %s", (text, offer, answer) => {
    expect(readLanguageAnswer(text, offer)).toBe(answer);
  });

  it.each([
    // Another language's yes-chip: the ask offered Tamil, the label names Marathi.
    ["Haan, Marathi mein", "tamil"],
    // Another language typed beside a yes.
    ["haan, tamil mein", "marathi"],
    // A message, not an answer.
    ["welder ki salary kitni hai", "marathi"],
    // A yes / no word leading a message (M1).
    ["haan marna hai", "marathi"],
    ["ok, salary batao", "tamil"],
    ["nahi jeena mujhe", "marathi"],
    // The greeting's and the résumé chip's KEYS are not this ask's.
    ["free_chat_start", "marathi"],
    ["free_chat_resume", "marathi"],
  ] as const)("%j to a %s ask is neither — the offer lapses", (text, offer) => {
    expect(readLanguageAnswer(text, offer)).toBeNull();
  });

  it("the ask's chips are no greeting or résumé chip — a résumé-mode double tap is not absorbed", () => {
    expect(isFreeChatChip("Haan, Marathi mein")).toBe(false);
    expect(isFreeChatChip("free_chat_lang_yes")).toBe(false);
    expect(isResumeChip("Nahi")).toBe(false);
  });
});
