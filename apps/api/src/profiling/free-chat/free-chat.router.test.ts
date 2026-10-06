import { describe, expect, it } from "vitest";
import type { FreeChatCategory } from "@badabhai/types";

import { greetingState, enterMode, registerStrike, FREE_CHAT_ASIDE_CAP } from "./free-chat.state";
import {
  confidenceBucketOf,
  DISTRESS_PHRASES,
  FREE_CHAT_MIN_CONFIDENCE,
  isResumeChip,
  matchesDistress,
  matchesOfferedOption,
  postClassifyFree,
  postClassifyResume,
  preClassifyFree,
  preClassifyResume,
  readGreetingChoice,
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
const v = (category: FreeChatCategory, confidence = 0.9): FreeChatVerdict => ({
  kind: "verdict",
  category,
  confidence,
});

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
  ] as const)("the greeting reads %j as %s", (text, choice) => {
    expect(readGreetingChoice(text)).toBe(choice);
  });

  it("reads the résumé chip by key or label, accents and case aside", () => {
    expect(isResumeChip("Resume banayein")).toBe(true);
    expect(isResumeChip("free_chat_resume")).toBe(true);
    expect(isResumeChip("  resume BANAYEIN ")).toBe(true);
    expect(isResumeChip("resume banao")).toBe(false);
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
    ["a typed answer", { typedAnswer: true }],
    ["nothing on screen to re-ask", { hasPendingQuestion: false }],
    ["the aside cap", { asideCapReached: true }],
  ])("passes on %s — with no model call", (_label, over) => {
    expect(preClassifyResume("kuch bhi", facts(over)).kind).toBe("pass");
  });

  it("checks distress before the skip list", () => {
    expect(preClassifyResume("marna chahta hoon", facts({ capped: true })).kind).toBe("distress");
  });

  it.each([
    [UNAVAILABLE_VERDICT, "pass"],
    [v("resume"), "pass"],
    [v("trash"), "de_escalate"],
    [v("distress"), "distress"],
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
