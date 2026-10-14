import { describe, expect, it } from "vitest";

import { claimsToBeHuman } from "./free-chat-human-claim";
import { screenFreeChatAnswer } from "./free-chat-output.validator";

/**
 * #2241 / ADR-0051 R45 — Bada Bhai never claims to be a person. The lines below are fabricated in
 * the shape round 1's eval saw ("Main ek insaan hoon" 8 times in 9 on claude-haiku-4-5).
 */
describe("claimsToBeHuman — a claim to be a person is caught", () => {
  it.each([
    // Hinglish — round 1's own shape, and its neighbours.
    "Main ek insaan hoon, aap se baat karne ke liye yahan hoon.",
    "Main ek aadmi hoon jo aapki madad karta hai.",
    "mai insaan hu",
    "Main bhi ek insaan hi hoon.",
    "Main asli insaan hoon, machine nahi.",
    "Main aam aadmi hoon.",
    "Main ek banda hoon jo welding karta tha.",
    "Main human hoon.",
    // English.
    "I am a human, here to help.",
    "I'm a real person.",
    "I’m human too.",
    "I am just a man who worked in a factory.",
    "I am a human being.",
    // The regional languages in Latin letters.
    "Mi manus aahe.",
    "Hu manas chhu.",
    "Naanu manushya.",
    "Nenu manishini.",
    "Naan oru manithan.",
  ])("%j", (line) => {
    expect(claimsToBeHuman(line)).toBe(true);
  });
});

describe("claimsToBeHuman — the honest answer and ordinary lines pass", () => {
  it.each([
    "Main BadaBhai app ka AI helper hoon, insaan nahi.",
    "Main insaan nahi hoon, main ek AI helper hoon.",
    "Main koi insaan nahi, app ka AI hoon.",
    "I am an AI helper, not a human.",
    "I'm not a human, I am the app's AI helper.",
    "I am just an AI.",
    "Naanu manushya alla, naanu AI sahayaka.",
    "Nenu manishini kaadu.",
    "Naan manithan illai.",
    "Main aapka Bada Bhai hoon, aapki madad ke liye.",
    "Har insaan ko apna hunar badhana chahiye.",
    "Factory mein har aadmi ko safety training chahiye.",
    "Welding mein tajurba bahut kaam aata hai.",
    "Woh ek achha insaan hai.",
  ])("%j", (line) => {
    expect(claimsToBeHuman(line)).toBe(false);
  });
});

describe("the gate throws a human claim away (#2241)", () => {
  it("rejects a line that claims to be a person, and serves the honest one", () => {
    expect(
      screenFreeChatAnswer({
        lines: ["Main ek insaan hoon, aap se baat karne ke liye yahan hoon."],
        followup_chips: [],
      }),
    ).toEqual({ kind: "reject", failure: "human_claim" });
    expect(
      screenFreeChatAnswer({
        lines: ["Main BadaBhai app ka AI helper hoon, insaan nahi.", "Kaam ki koi baat poochhiye."],
        followup_chips: ["Welding course"],
      }).kind,
    ).toBe("serve");
  });

  it("rejects a claim hidden in a chip too", () => {
    expect(
      screenFreeChatAnswer({
        lines: ["Kaam ki baat karte hain."],
        followup_chips: ["Main insaan hoon"],
      }),
    ).toEqual({ kind: "reject", failure: "human_claim" });
  });
});
