import { describe, expect, it } from "vitest";
import { matchesDistress } from "../profiling/free-chat/free-chat.router";
import { isCompanionChipTap, mentionsStatusWord } from "./companion-intents";
import { isBareGreeting } from "./companion-greeting";
import { COMPANION_TASK_KEYS } from "./companion-task-keys";

/**
 * #2287 — what counts as a BARE greeting on the Bada Bhai chat: every word a greeting or a filler,
 * at least one greeting. Narrow on purpose: any content word sends the message to the brain.
 */
describe("isBareGreeting", () => {
  it.each([
    "hello",
    "Hello!!",
    "Namaste ji",
    "hi bada bhai",
    "good morning sir",
    "Good Evening",
    "🙏 namaste",
    "namaste 🙏🙏",
    "ram ram",
    "Ram Ram bhaiya",
    "hiii",
    "heyyy bhai",
    "hellooo",
    "namasteee",
    "namaskar sir ji",
    "pranam",
    "salaam bhai",
    "hello hi",
    "नमस्ते",
    "नमस्ते जी",
    "राम राम",
    "नमस्ते बड़े भाई",
  ])("%j is a bare greeting", (text) => {
    expect(isBareGreeting(text)).toBe(true);
  });

  it.each([
    "hello, welder ki salary kitni hai",
    "namaste bada bhai kaise ho aap",
    "hi, job chahiye",
    "hello bhai hai kya",
    "good",
    "morning",
    "ram",
    "bhai",
    "bada bhai ji",
    "🙏",
    "",
    "   ",
    "status",
    "thank you",
    "hello marna chahta hoon",
  ])("%j is NOT a bare greeting", (text) => {
    expect(isBareGreeting(text)).toBe(false);
  });

  it("an invisible character cannot glue or split a word past the reader", () => {
    expect(isBareGreeting("hel\u200blo")).toBe(true);
    expect(isBareGreeting("hello\u200bkaise ho")).toBe(false);
  });

  it("no greeting is a chip tap, a task chip or a distress phrase — those keep their routes", () => {
    for (const text of ["hello", "namaste", "hi bada bhai", "good morning sir"]) {
      expect(isCompanionChipTap(text)).toBe(false);
      expect(COMPANION_TASK_KEYS).not.toContain(text);
      expect(matchesDistress(text)).toBe(false);
    }
  });
});

describe("mentionsStatusWord (#2287) — 'status' is a status question again on the brain", () => {
  it("reads the word, not a substring", () => {
    expect(mentionsStatusWord("status")).toBe(true);
    expect(mentionsStatusWord("mera status kya hai?")).toBe(true);
    expect(mentionsStatusWord("statusbar")).toBe(false);
    expect(mentionsStatusWord("hello")).toBe(false);
  });
});
