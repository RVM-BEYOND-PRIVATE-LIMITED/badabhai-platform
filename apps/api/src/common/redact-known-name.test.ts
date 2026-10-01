import { describe, it, expect, vi } from "vitest";
import {
  knownNameOnce,
  redactKnownName,
  redactKnownNameDeep,
  redactKnownNameLines,
  REDACTED_NAME_PLACEHOLDER,
} from "./redact-known-name";

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

describe("redactKnownNameLines — every line of a conversation", () => {
  it("redacts each line's text, carries every other field, and never mutates the input", () => {
    const lines = [
      { i: 0, role: "worker", text: "Suresh Kumar, fitter" },
      { i: 1, role: "assistant", text: "Kitne saal se?" },
    ] as const;
    const before = JSON.stringify(lines);
    expect(redactKnownNameLines(lines, "Suresh Kumar")).toEqual([
      { i: 0, role: "worker", text: `${P}, fitter` },
      { i: 1, role: "assistant", text: "Kitne saal se?" },
    ]);
    expect(JSON.stringify(lines)).toBe(before);
  });

  it("a null name returns the same lines, as new objects", () => {
    const lines = [{ text: "Suresh Kumar" }];
    const out = redactKnownNameLines(lines, null);
    expect(out).toEqual(lines);
    expect(out).not.toBe(lines);
  });
});

describe("redactKnownNameDeep — every string inside a JSON-shaped value", () => {
  it("redacts a string, array items and object keys and values at any depth", () => {
    const value = {
      tools: ["lathe", "Suresh wala VMC"],
      note: { "Kumar ka": ["Suresh Kumar"] },
      years: 7,
      certified: true,
      none: null,
    };
    const before = JSON.stringify(value);
    expect(redactKnownNameDeep(value, "Suresh Kumar")).toEqual({
      tools: ["lathe", `${P} wala VMC`],
      note: { [`${P} ka`]: [P] },
      years: 7,
      certified: true,
      none: null,
    });
    expect(redactKnownNameDeep("Suresh CNC operator", "Suresh Kumar")).toBe(`${P} CNC operator`);
    // The input is never mutated.
    expect(JSON.stringify(value)).toBe(before);
  });

  it("carries numbers, booleans, null and undefined through, and a null name changes nothing", () => {
    expect(redactKnownNameDeep(7, "Suresh Kumar")).toBe(7);
    expect(redactKnownNameDeep(false, "Suresh Kumar")).toBe(false);
    expect(redactKnownNameDeep(null, "Suresh Kumar")).toBeNull();
    expect(redactKnownNameDeep(undefined, "Suresh Kumar")).toBeUndefined();
    expect(redactKnownNameDeep(["Suresh"], null)).toEqual(["Suresh"]);
  });
});

describe("knownNameOnce — one lookup per request", () => {
  it("reads at most once however many consumers ask", async () => {
    const read = vi.fn(async (): Promise<string | null> => "Suresh Kumar");
    const known = knownNameOnce(read);
    await expect(known()).resolves.toBe("Suresh Kumar");
    await expect(known()).resolves.toBe("Suresh Kumar");
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("never reads until asked — a turn that calls no model decrypts nothing", () => {
    const read = vi.fn(async (): Promise<string | null> => "Suresh Kumar");
    knownNameOnce(read);
    expect(read).not.toHaveBeenCalled();
  });

  it("does not keep a rejection: the next consumer reads again", async () => {
    const read = vi
      .fn(async (): Promise<string | null> => "Suresh Kumar")
      .mockRejectedValueOnce(new Error("connection reset"));
    const known = knownNameOnce(read);
    await expect(known()).rejects.toThrow("connection reset");
    await expect(known()).resolves.toBe("Suresh Kumar");
    expect(read).toHaveBeenCalledTimes(2);
  });
});
