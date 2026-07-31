import { describe, it, expect } from "vitest";
import { redactKnownName, REDACTED_NAME_PLACEHOLDER } from "./redact-known-name";

const P = REDACTED_NAME_PLACEHOLDER;

describe("redactKnownName — the R32 known-name redaction", () => {
  it("redacts the full name as ONE placeholder (the headline case)", () => {
    expect(redactKnownName("Suresh Kumar, CNC operator", "Suresh Kumar")).toBe(
      `${P}, CNC operator`,
    );
  });

  it("redacts a single token of the stored name on its own", () => {
    expect(redactKnownName("mera naam Suresh hai", "Suresh Kumar")).toBe(`mera naam ${P} hai`);
    expect(redactKnownName("sab log Kumar bolte hain", "Suresh Kumar")).toBe(
      `sab log ${P} bolte hain`,
    );
  });

  it("is case-insensitive in both directions", () => {
    expect(redactKnownName("suresh kumar yahan", "Suresh Kumar")).toBe(`${P} yahan`);
    expect(redactKnownName("SURESH bol raha hun", "suresh kumar")).toBe(`${P} bol raha hun`);
  });

  it("redacts EVERY occurrence, not just the first", () => {
    expect(redactKnownName("Suresh here. Suresh again. Suresh.", "Suresh Kumar")).toBe(
      `${P} here. ${P} again. ${P}.`,
    );
  });

  it("is word-anchored — never matches inside another word", () => {
    // "Ram" must not eat Rampur / programme / Ramesh.
    expect(redactKnownName("Rampur me programme banata hun", "Ram Yadav")).toBe(
      "Rampur me programme banata hun",
    );
    // ...but the standalone token still goes.
    expect(redactKnownName("Ram, Rampur se", "Ram Yadav")).toBe(`${P}, Rampur se`);
  });

  it("word-anchoring holds across scripts (\\b is ASCII-only, the lookarounds are not)", () => {
    expect(redactKnownName("मेरा नाम राम है", "राम यादव")).toBe(`मेरा नाम ${P} है`);
    // Not adjacent-matching inside a longer Devanagari token.
    expect(redactKnownName("रामपुर से हूं", "राम यादव")).toBe("रामपुर से हूं");
  });

  it("tolerates extra internal whitespace in the STORED name", () => {
    expect(redactKnownName("Suresh Kumar bol raha hun", "  Suresh   Kumar  ")).toBe(
      `${P} bol raha hun`,
    );
  });

  it("tolerates extra whitespace in the TYPED text via the full-name alternative", () => {
    expect(redactKnownName("Suresh   Kumar hun", "Suresh Kumar")).toBe(`${P} hun`);
  });

  it("skips tokens shorter than 3 characters (initials must not shred the text)", () => {
    // "R" and "K" are initials — redacting them would rewrite every stray letter.
    const out = redactKnownName("R K se mila, 5 saal ka experience", "R K Ramesh");
    expect(out).toBe("R K se mila, 5 saal ka experience");
    // The real token still goes.
    expect(redactKnownName("Ramesh bol raha hun", "R K Ramesh")).toBe(`${P} bol raha hun`);
  });

  it("does not mangle ordinary trade text when no token matches", () => {
    const text = "Wire EDM aur Jyoti CNC pe kaam kiya, ITI fitter 2018-2020 kiya";
    expect(redactKnownName(text, "Suresh Kumar")).toBe(text);
  });

  it("ACCEPTED TRADEOFF: a name that collides with trade vocabulary loses that token", () => {
    // A worker actually NAMED Kiran loses "Kiran brand". Deliberate — it is their own
    // name and privacy wins. Documented in the module header.
    expect(redactKnownName("Kiran brand ka machine", "Kiran Patel")).toBe(
      `${P} brand ka machine`,
    );
    // ...and it is scoped to that worker only: anyone else's turn is untouched.
    expect(redactKnownName("Kiran brand ka machine", "Suresh Kumar")).toBe(
      "Kiran brand ka machine",
    );
  });

  it("FAILS SAFE on an unusable name — returns the text unchanged, never throws", () => {
    const text = "Suresh Kumar, CNC operator";
    expect(redactKnownName(text, null)).toBe(text);
    expect(redactKnownName(text, undefined)).toBe(text);
    expect(redactKnownName(text, "")).toBe(text);
    expect(redactKnownName(text, "   ")).toBe(text);
    // A name made only of initials yields no usable token.
    expect(redactKnownName(text, "R K")).toBe(text);
  });

  it("treats regex metacharacters in a stored name literally", () => {
    // A name is worker-supplied data, never a pattern.
    expect(redactKnownName("a.c and abc", "a.c")).toBe(`${P} and abc`);
    expect(redactKnownName("who is (Ravi) here", "(Ravi)")).toBe(`who is ${P} here`);
  });

  it("handles an empty / non-string text without throwing", () => {
    expect(redactKnownName("", "Suresh Kumar")).toBe("");
    expect(redactKnownName(null as never, "Suresh Kumar")).toBe(null);
  });

  it("dedupes a repeated token in the stored name", () => {
    expect(redactKnownName("Singh Singh", "Singh Singh")).toBe(P);
  });
});
