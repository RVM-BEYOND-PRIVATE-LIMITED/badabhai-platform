import { describe, expect, it } from "vitest";
import { isGenericEditRequest, looksLikeEditRequest } from "./edit-precheck";

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

/**
 * #2295 — a GENERIC edit request names no change, so the service answers it with the résumé's
 * edit section menu instead of an edit parse. An allowlist: any word it does not know — a field, a
 * value, a name — leaves the message to today's path.
 */
describe("isGenericEditRequest — an edit word + a résumé subject, and nothing else", () => {
  it.each([
    ["resume edit karein", "the production phrasing"],
    ["Resume edit karna hai", "case-insensitive"],
    ["mera resume update karna hai", "pronoun + want frame"],
    ["resume badalna hai", "a Hinglish edit verb"],
    ["mujhe apne resume mein kuch badlav karna hai", "a longer generic ask"],
    ["edit my resume please", "English"],
    ["i want to change my cv", "English, cv"],
    ["profile update kar do", "profile + an imperative"],
    ["biodata sudharna hai", "biodata + sudharna"],
    ["resume theek karna hai", "theek beside a karna verb"],
    ["kya resume edit ho sakta hai?", "a can-I question about editing"],
    ["resume edit", "the edit word and the subject alone"],
  ])("%j — %s", (text, _why) => {
    expect(isGenericEditRequest(text)).toBe(true);
  });

  it.each([
    ["resume mein salary 25000 kar do", "a field and a value"],
    ["skills mein Marathi jod do", "a field and a value, no résumé subject"],
    ["resume edit karo, Pune likho", "a value beside the generic ask"],
    ["Fanuc hata do resume se", "a value"],
    ["resume edit karna hai, city galat hai", "a field word"],
    ["resume theek hai", "'theek' without a karna verb is a statement"],
    ["resume update ho gaya?", "a status question"],
    ["resume update hua kya", "a status question"],
    ["resume chahiye", "no edit word"],
    ["edit karna hai", "no résumé subject"],
    ["naya resume banana hai", "a new-résumé request"],
    ["", "empty text"],
  ])("%j — %s", (text, _why) => {
    expect(isGenericEditRequest(text)).toBe(false);
  });
});
