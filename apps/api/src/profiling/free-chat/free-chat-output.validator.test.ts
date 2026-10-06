import { describe, expect, it } from "vitest";

import { screenCareerAnswer } from "../../chat-companion/v2/career-output.validator";
import { FREE_CHAT_WALLS, screenFreeChatAnswer } from "./free-chat-output.validator";

/**
 * The free chat's reply gate (ADR-0051 §3.4): the companion career validator with the MONEY and
 * NAMED-EMPLOYER walls off (R11), every other wall on, and `{{`/`}}` rejected. The companion's own
 * results are pinned, unchanged, by `career-output.validator.test.ts`.
 */

const answer = (lines: string[], followup_chips: string[] = []) => ({ lines, followup_chips });
const failure = (lines: string[], chips: string[] = []) => {
  const out = screenFreeChatAnswer(answer(lines, chips));
  return out.kind === "reject" ? out.failure : null;
};

describe("R11 — the two walls the free chat turns off", () => {
  it.each([
    "Welder ki salary aam taur par 15000 se 20000 hoti hai.",
    "Shuru mein salary lagbhag 12000 hoti hai.",
    "Tata Steel Ltd mein bhi welder lagte hain.",
  ])("serves %j, which the companion would reject", (line) => {
    expect(failure([line])).toBeNull();
    expect(screenCareerAnswer(answer([line])).kind).toBe("reject");
  });

  it("is exactly those two", () => {
    expect(FREE_CHAT_WALLS).toEqual({ money: false, namedEmployer: false });
  });
});

describe("every other wall stays on, in the companion's order", () => {
  it.each([
    [["Yeh kaam kariye!"], "exclamation"],
    [["Suniye bhai, aise kariye."], "persona"],
    [["Job pakka milegi."], "promise"],
    [["Bank se loan le lijiye."], "sensitive_advice"],
    [["Aap achhe ho."], "worker_rating"],
    [["Call kariye 9876543210 par."], "pii"],
    [["वेल्डिंग सीखिए"], "non_latin"],
    [["Theek hai 🙂"], "emoji"],
    [["Kyun?", "Kaise?"], "too_many_questions"],
    [[Array(21).fill("kaam").join(" ")], "line_too_long"],
    [[], "no_lines"],
    [["a", "b", "c", "d", "e"], "too_many_lines"],
  ] as const)("%j → %s", (lines, expected) => {
    expect(failure([...lines])).toBe(expected);
  });

  it("checks every chip's content, even one the length rule would drop", () => {
    expect(failure(["Theek hai."], ["Bank se loan le lijiye"])).toBe("sensitive_advice");
    expect(failure(["Theek hai."], ["a", "b", "c", "d"])).toBe("too_many_chips");
  });

  it("drops a chip whose only failure is its length, and serves the rest", () => {
    const out = screenFreeChatAnswer(
      answer(["Theek hai."], ["yeh chip bahut lamba hai ji", "Aur batao"]),
    );
    expect(out).toEqual({
      kind: "serve",
      answer: { lines: ["Theek hai."], followup_chips: ["Aur batao"] },
      droppedChips: 1,
    });
  });
});

describe("the abuse lexicon on model output — a jailbroken reply never serves vulgar text", () => {
  it.each([
    [["Tu chutiya hai."], []],
    [["Theek hai."], ["gandu"]],
    [["Yeh fucking kaam hai."], []],
  ])("rejects %j / %j", (lines, chips) => {
    expect(failure(lines, chips)).toBe("abusive");
  });

  it("leaves shop-floor vocabulary alone (the lexicon is high-precision)", () => {
    expect(failure(["Bastard file se finishing kariye."])).toBeNull();
  });
});

describe("the template check — replies are rendered through the vocative", () => {
  it.each([
    [["{{worker_name}} ji, sab theek hai."], []],
    [["Sab theek hai."], ["{{x}}"]],
    [["Sab theek hai }}"], []],
  ])("rejects %j / %j", (lines, chips) => {
    expect(failure(lines, chips)).toBe("template_token");
  });
});
