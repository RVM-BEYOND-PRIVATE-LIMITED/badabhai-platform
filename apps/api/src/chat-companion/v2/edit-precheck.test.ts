import { describe, expect, it } from "vitest";
import { looksLikeEditRequest } from "./edit-precheck";

/**
 * WP6 (TD146) — the narrow edit pre-check. It recognises an edit verb plus the field it targets,
 * or a generic English edit verb plus resume/cv/profile/biodata, and refuses everything a NAMED
 * v1 intent owns (status questions, jobs, applications, guarantees, chips).
 */
describe("looksLikeEditRequest — the unambiguous shape (edit verb + field)", () => {
  it.each([
    ["edit my resume", "generic English verb + subject"],
    ["please update my profile", "generic English verb + subject"],
    ["location Mumbai kar do", "verb phrase + location"],
    ["sheher Pune kar do", "Hinglish field + verb phrase"],
    ["salary 25000 kar do", "verb phrase + salary"],
    ["meri bhasha badal do", "verb phrase + bhasha"],
    ["shift change karo", "verb phrase + shift"],
    ["skills add karo", "verb phrase + skill"],
    ["certificate ka saal badal do", "verb phrase + certificate"],
    ["padhai update karo", "verb phrase + education"],
    ["training ka naam change karo", "verb phrase + training"],
    ["mera naam badal do", "verb phrase + name (the identity line answers)"],
    ["phone number update karo", "verb + phone (the identity line answers)"],
    ["mera role badlo", "single-word verb + role"],
    ["employer ka naam badalna hai", "verb word + employer"],
  ])("%j — %s", (text, _why) => {
    expect(looksLikeEditRequest(text)).toBe(true);
  });

  it("is case-, space- and punctuation-insensitive", () => {
    expect(looksLikeEditRequest("  LOCATION   Mumbai KAR DO. ")).toBe(true);
  });
});

describe("looksLikeEditRequest — what it must never claim", () => {
  it.each([
    ["koi update hai", "a status question (the recap is the answer)"],
    ["resume update ho gaya?", "a status question"],
    ["resume kab banega", "a status question"],
    ["ab tak kya hua", "a status question"],
    ["job milegi?", "the guarantee intent (no field word)"],
    ["meri applications", "the applied intent"],
    ["naye jobs dikhao", "the jobs intent"],
    ["kaam ka anubhav hai", "a résumé section, no edit verb"],
    ["welding bhi karta hoon, add karo", "an add with no field word (the parser owns it)"],
    ["naya resume banao", "a new-résumé request, not an edit"],
    ["firse banao", "the résumé menu's redo alias"],
    ["address change karo", "'add' is not a token of 'address'"],
    ["", "empty text"],
  ])("%j — %s", (text, _why) => {
    expect(looksLikeEditRequest(text)).toBe(false);
  });
});
