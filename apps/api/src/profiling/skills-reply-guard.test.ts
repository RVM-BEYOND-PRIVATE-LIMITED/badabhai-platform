import { describe, expect, it } from "vitest";
import type { TranscriptLine } from "@badabhai/ai-contracts";

import {
  classifyLlmReply,
  classifySkillsReply,
  EXPERIENCE_GATE_PROMPT,
  SKILLS_GATE_QUESTION_MIRROR,
} from "./llm-reply-guard";
import { SKILLS_GATE_QUESTION, skillsGatePrompt } from "./skills-gate";

/**
 * `classifySkillsReply` — the skills stage's read of a model line before it is served (ADR-0045
 * §3.2). Its own file so `llm-reply-guard.test.ts`, which pins `classifyLlmReply`, is untouched.
 *
 * The table covers both directions of the one judgement this adds: the model writing the engine's
 * add-more-skills gate in its own words is `gate_shaped`; the model asking WHICH skill — the
 * stage's own job — is `ok`, wherever the WH-word sits.
 */

function line(role: TranscriptLine["role"], text: string, i: number): TranscriptLine {
  return { i, role, text };
}

describe("SKILLS_GATE_QUESTION_MIRROR", () => {
  it("is byte-equal to the gate the engine serves — the duplicated literal cannot drift", () => {
    expect(SKILLS_GATE_QUESTION_MIRROR).toBe(SKILLS_GATE_QUESTION);
  });

  it("the engine's own gate line is always gate_shaped, and so is the bubble that ends on it", () => {
    expect(classifySkillsReply(SKILLS_GATE_QUESTION, [])).toBe("gate_shaped");
    expect(classifySkillsReply(skillsGatePrompt(["Tally", "GST filing"]), [])).toBe("gate_shaped");
  });
});

describe("classifySkillsReply — gate_shaped", () => {
  it.each([
    "Kya aur koi skill jodni hai?",
    "kya aur koi skill jodni hai",
    "Aur koi skill add karni hai?",
    "Koi aur skill aati hai?",
    "Koi aur hunar hai aapke paas?",
    "Aur koi cheez jo aap kar sakte hain?",
    "Koi dusri skill bhi hai?",
    "क्या और कोई स्किल जोड़नी है?",
    "कोई और हुनर है?",
  ])("%j", (reply) => {
    expect(classifySkillsReply(reply, [])).toBe("gate_shaped");
  });

  it("flags 'koi aur cheez', which Phase A's read leaves alone — the stages differ on that noun", () => {
    const reply = "Koi aur cheez batana chahenge?";
    expect(classifyLlmReply(reply, [])).toBe("ok");
    expect(classifySkillsReply(reply, [])).toBe("gate_shaped");
  });

  // The leading-WH exemption excuses only the sentence the WH-word opens — a WHICH question
  // followed by the gate's twin is still the gate's twin, and a worker's "Nahi" would answer it.
  it.each([
    "Kaunsa software chalate hain? Aur koi skill bhi hai?",
    "Kitne saal se Tally chala rahe hain? Koi aur skill hai?",
    "Kaunsi machine chalate hain! Koi aur hunar hai?",
    "Kitne saal ka experience hai. Aur koi skill hai?",
    "Kaunsa software chalate hain\nAur koi skill bhi hai",
    "कौनसा सॉफ्टवेयर चलाते हैं। और कोई स्किल है?",
    // the control: a non-WH opener, caught before and after
    "Accha. Aur koi skill hai?",
  ])("%j — per sentence", (reply) => {
    expect(classifySkillsReply(reply, [])).toBe("gate_shaped");
  });
});

describe("classifySkillsReply — ok", () => {
  it.each([
    // A leading WH-token: asking WHICH, after the worker said Haan, is the stage's own question.
    "Kaunsi skill jodni hai?",
    "Kaunse database use karte hain?",
    "Konsi aur skill aati hai?",
    // A WH-token BETWEEN the marker and the noun — the line a skills-only model writes most.
    "Aur kaunsi skill aati hai?",
    "Aapko aur kaunsi skills aati hain?",
    "Aur kis cheez mein kaam kar lete hain?",
    "Aur kya cheezein aati hain?",
    "और कौनसी स्किल आती है?",
    // No skill noun after the marker.
    "Excel ke alawa aur kya aata hai?",
    "Tally mein aur kya kya karte hain?",
    // A skills question with no marker at all.
    "GST return file karte hain?",
    "",
    // Every sentence asks WHICH — each is excused on its own.
    "Kaunsa software chalate hain? Aur kaunsi skill aati hai?",
    // A "." with no space after it ends no sentence: "B.Com" does not cut this WH-led line in two.
    "Kitne saal B.Com ke baad aur koi skill seekhi?",
  ])("%j", (reply) => {
    expect(classifySkillsReply(reply, [])).toBe("ok");
  });

  it("leaves the experience gate's own shape to Phase A — it is not the skills gate", () => {
    expect(classifySkillsReply(EXPERIENCE_GATE_PROMPT, [])).toBe("ok");
  });
});

describe("classifySkillsReply — repeat", () => {
  const history: TranscriptLine[] = [
    line("assistant", "Aap Tally mein kaunse kaam karte hain?", 0),
    line("worker", "Billing aur GST", 1),
    line("assistant", "Kaunse database use karte hain?", 2),
    line("worker", "SQL", 3),
  ];

  it("flags an exact repeat of an earlier model line", () => {
    expect(classifySkillsReply("Kaunse database use karte hain?", history)).toBe("repeat");
    expect(classifySkillsReply("Aap Tally mein kaunse kaam karte hain?", history)).toBe("repeat");
  });

  it("ignores worker lines, and passes a new question", () => {
    expect(classifySkillsReply("Billing aur GST", history)).toBe("ok");
    expect(classifySkillsReply("Busy software bhi chalate hain?", history)).toBe("ok");
  });

  it("checks gate-shape first — a gate twin that is also a repeat reads as the gate", () => {
    const withGate: TranscriptLine[] = [line("assistant", "Aur koi skill add karni hai?", 0)];
    expect(classifySkillsReply("Aur koi skill add karni hai?", withGate)).toBe("gate_shaped");
  });
});
