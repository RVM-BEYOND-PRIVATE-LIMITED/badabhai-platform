import { describe, it, expect, vi } from "vitest";
import {
  knownNameMatcher,
  knownNameOnce,
  redactKnownName,
  redactKnownNameDeep,
  redactKnownNameLines,
  REDACTED_NAME_PLACEHOLDER,
} from "./redact-known-name";

const P = REDACTED_NAME_PLACEHOLDER;

// Invisible and combining characters are written as escapes, never raw: a reader cannot see them,
// and semgrep's bidi rule blocks raw bidi controls in source.
const ZWSP = "\u200B";
const ZWJ = "\u200D";
const SOFT_HYPHEN = "\u00AD";
const CGJ = "\u034F"; // combining grapheme joiner — default-ignorable, a mark, not Cf
const VS16 = "\uFE0F";
const NUKTA = "\u093C";
/** ज़ाकिर with the nukta letter precomposed (U+095B). */
const ZAKIR_PRECOMPOSED = "\u095B\u093E\u0915\u093F\u0930";
/** The same name typed decomposed: ज + nukta. */
const ZAKIR_DECOMPOSED = `\u091C${NUKTA}\u093E\u0915\u093F\u0930`;
/** The same name typed without the nukta at all. */
const ZAKIR_BARE = "\u091C\u093E\u0915\u093F\u0930";

/**
 * #2166 — the issue's table, row for row: stored name, worker text, the redaction expected. The
 * same rows run through a real caller in `llm-turn.service.test.ts`.
 */
const ISSUE_ROWS: readonly (readonly [string, string, string])[] = [
  ["K.Suresh", "main Suresh hoon", `main ${P} hoon`],
  ["R.K.Ramesh", "Ramesh bol raha", `${P} bol raha`],
  ["Ram-Prasad", "Ram Prasad bol raha hoon", `${P} bol raha hoon`],
  ["Anil D'Souza", "main Anil Souza", `main ${P}`],
  ["Mohd. Salim", "main Mohd Salim hoon", `main ${P} hoon`],
  [`Suresh${ZWSP} Kumar`, "main Suresh hoon", `main ${P} hoon`],
  [`Sur${SOFT_HYPHEN}esh Kumar`, "main Suresh hoon", `main ${P} hoon`],
  [ZAKIR_PRECOMPOSED, `main ${ZAKIR_DECOMPOSED} hoon`, `main ${P} hoon`],
];

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
    expect(redactKnownName("Kiran brand ka machine", "Kiran Patel")).toBe(`${P} brand ka machine`);
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

describe("#2166 — names the whitespace-only tokeniser missed (the issue's table)", () => {
  it.each(ISSUE_ROWS)("stored %j, typed %j → %j", (stored, typed, expected) => {
    expect(redactKnownName(typed, stored)).toBe(expected);
  });

  it("splits a stored name on dots, hyphens, apostrophes, digits and modifier letters", () => {
    expect(redactKnownName("Souza ji", "Anil D\u2019Souza")).toBe(`${P} ji`); // curly
    expect(redactKnownName("Souza ji", "Anil D\u02BCSouza")).toBe(`${P} ji`); // modifier letter
    expect(redactKnownName("Prasad ji", "Ram-Prasad")).toBe(`${P} ji`);
    expect(redactKnownName("main Raju bol raha", "Raju007")).toBe(`main ${P} bol raha`);
    expect(redactKnownName("Kumar bhai", "Suresh2 Kumar")).toBe(`${P} bhai`);
  });

  it("collapses the whole stored name, however its parts are separated, to ONE placeholder", () => {
    for (const typed of ["K.Suresh", "K. Suresh", "K Suresh", "k.suresh"]) {
      expect(redactKnownName(`main ${typed} hoon`, "K.Suresh")).toBe(`main ${P} hoon`);
    }
    for (const typed of ["R.K.Ramesh", "R.K. Ramesh", "R K Ramesh", "R. K. Ramesh"]) {
      expect(redactKnownName(`${typed} bol raha`, "R.K.Ramesh")).toBe(`${P} bol raha`);
    }
    for (const typed of ["Ram-Prasad", "Ram Prasad", "RamPrasad", "Ram\u2010Prasad"]) {
      expect(redactKnownName(`${typed} hoon`, "Ram-Prasad")).toBe(`${P} hoon`);
    }
    for (const typed of ["Anil D'Souza", "Anil D\u2019Souza", "Anil DSouza", "Anil D Souza"]) {
      expect(redactKnownName(`main ${typed}`, "Anil D'Souza")).toBe(`main ${P}`);
    }
    // The apostrophe-joined word on its own, with or without the apostrophe.
    for (const typed of ["D'Souza", "DSouza", "Dsouza", "D\u02BCSouza"]) {
      expect(redactKnownName(`${typed} sahab`, "Anil D'Souza")).toBe(`${P} sahab`);
    }
    expect(redactKnownName("main Mohd. Salim hoon", "Mohd. Salim")).toBe(`main ${P} hoon`);
    expect(redactKnownName("Raju007 yahan", "Raju007")).toBe(`${P} yahan`);
  });

  it("a stored name of initials only still matches exactly as written, as before", () => {
    expect(redactKnownName("R.K. se mila", "R.K.")).toBe(`${P} se mila`);
    expect(redactKnownName("R K se mila", "R.K.")).toBe("R K se mila");
  });
});

describe("#2166 — what the worker TYPED may vary as well", () => {
  const FULLWIDTH = "\uFF33\uFF55\uFF52\uFF45\uFF53\uFF48"; // Ｓｕｒｅｓｈ
  const MATH_BOLD = "\u{1D412}\u{1D42E}\u{1D42B}\u{1D41E}\u{1D42C}\u{1D421}"; // 𝐒𝐮𝐫𝐞𝐬𝐡

  it.each([
    ["fullwidth", FULLWIDTH],
    ["math bold", MATH_BOLD],
    ["a zero-width space inside", `Sur${ZWSP}esh`],
    ["a soft hyphen inside", `Sur${SOFT_HYPHEN}esh`],
    ["a zero-width joiner inside", `Su${ZWJ}resh`],
    ["U+034F inside", `Sur${CGJ}esh`],
    ["a variation selector inside", `Sures${VS16}h`],
    ["several invisibles inside", `S${ZWSP}${ZWSP}ur${SOFT_HYPHEN}es${ZWJ}h`],
  ])("typed as %s: one placeholder", (_, typed) => {
    expect(redactKnownName(`main ${typed} hoon`, "Suresh Kumar")).toBe(`main ${P} hoon`);
  });

  it("an invisible used as a word break still bounds the name — and is kept", () => {
    expect(redactKnownName(`main${ZWSP}Suresh${ZWSP}hoon`, "Suresh Kumar")).toBe(
      `main${ZWSP}${P}${ZWSP}hoon`,
    );
    expect(redactKnownName(`Suresh${ZWSP}Kumar hoon`, "Suresh Kumar")).toBe(`${P} hoon`);
  });

  it("matches NFC and NFD spellings, and the nukta present on one side only", () => {
    for (const [stored, typed] of [
      [ZAKIR_PRECOMPOSED, ZAKIR_DECOMPOSED],
      [ZAKIR_DECOMPOSED, ZAKIR_PRECOMPOSED],
      [ZAKIR_PRECOMPOSED, ZAKIR_BARE],
      [ZAKIR_BARE, ZAKIR_PRECOMPOSED],
      [ZAKIR_BARE, ZAKIR_DECOMPOSED],
    ] as const) {
      expect(redactKnownName(`main ${typed} hoon`, `${stored} \u0916\u093E\u0928`)).toBe(
        `main ${P} hoon`,
      );
    }
  });

  it("matches a Latin name with its diacritics composed, decomposed or left off", () => {
    for (const typed of ["Jos\u00E9", "Jose\u0301", "Jose", "JOS\u00C9"]) {
      expect(redactKnownName(`${typed} bol raha`, "Jos\u00E9 Kumar")).toBe(`${P} bol raha`);
    }
    expect(redactKnownName("Jos\u00E9 bol raha", "Jose Kumar")).toBe(`${P} bol raha`);
  });
});

describe("#2166 — the text outside the name is never rewritten", () => {
  it("leaves every character outside the matched span byte-identical", () => {
    const FULLWIDTH = "\uFF33\uFF55\uFF52\uFF45\uFF53\uFF48";
    // A fullwidth digit, a superscript, a circled digit, a ligature, a joiner, a precomposed nukta
    // letter, Latin accents and a lone surrogate — each one NFKC (or NFC) would rewrite.
    const tail =
      ` ne \uFF12 saal kaam kiya, 5m\u00B2 ka shed, \u2460 machine, \uFB01tting${ZWJ} ok, ` +
      `\u095B\u0930\u0942\u0930 \u00E9t\u00E9 \uD800 Cafe\u0301`;
    const out = redactKnownName(`${FULLWIDTH}${tail}`, "Suresh Kumar");
    expect(out).toBe(`${P}${tail}`);
    expect(out.slice(P.length)).toBe(tail);
  });

  it("returns a text with no match exactly as given", () => {
    const text = `\uFF12 saal, 5m\u00B2, \u2460, \uFB01tting${ZWJ}${ZWSP}, \u095B\u0930\u0942\u0930 \uD800`;
    expect(redactKnownName(text, "Suresh Kumar")).toBe(text);
  });

  it("replaces a name and its marks as whole characters, never leaving a mark behind", () => {
    // A vowel sign after a part does not end the word for the anchor (unchanged by #2166), and the
    // akshara it belongs to goes with the name: the Bengali genitive of a stored "রাম".
    expect(
      redactKnownName("\u09B0\u09BE\u09AE\u09C7\u09B0 \u0995\u09BE\u099C", "\u09B0\u09BE\u09AE"),
    ).toBe(`${P}\u09B0 \u0995\u09BE\u099C`);
  });
});

describe("#2166 — no over-masking: ordinary words that CONTAIN a name part are untouched", () => {
  it("'Ram Kumar' never touches aaram, kumari, Rampur, programme or Ramesh", () => {
    const text = "aaram se kaam karta hoon, kumari ji ke ghar, Rampur me programme, Ramesh bhai";
    expect(redactKnownName(text, "Ram Kumar")).toBe(text);
    expect(redactKnownName(`${text}, Ram Kumar`, "Ram Kumar")).toBe(`${text}, ${P}`);
  });

  it("an initial is never glued onto a name without a separator: 'S.Aman' leaves 'saman' alone", () => {
    expect(redactKnownName("saman le jaana hai", "S.Aman")).toBe("saman le jaana hai");
    expect(redactKnownName("aram karo", "A. Ram")).toBe("aram karo");
    expect(redactKnownName("S. Aman yahan, Aman bhi", "S.Aman")).toBe(`${P} yahan, ${P} bhi`);
  });

  it("a stored invisible joins its word, so it never makes a short part to shred the text with", () => {
    // `Sur<SHY>esh` is ONE word "Suresh" — never the parts "Sur" and "esh" ("sur" is a tune).
    expect(redactKnownName("sur mein gaana", `Sur${SOFT_HYPHEN}esh Kumar`)).toBe("sur mein gaana");
  });

  it("parts under three characters never match on their own", () => {
    expect(redactKnownName("om shanti, ab chalo", "Om Prakash")).toBe("om shanti, ab chalo");
    expect(redactKnownName("ab Ramesh bolega", "A B Ramesh")).toBe(`ab ${P} bolega`);
  });

  it("Devanagari: आराम and रामपुर are not राम", () => {
    const text =
      "\u0906\u0930\u093E\u092E \u0938\u0947, \u0930\u093E\u092E\u092A\u0941\u0930 \u0938\u0947";
    expect(redactKnownName(text, "\u0930\u093E\u092E \u0915\u0941\u092E\u093E\u0930")).toBe(text);
  });

  it("other marks are not folded away: a stored राम does not match रीमा or रम", () => {
    const text = "\u0930\u0940\u092E\u093E \u0914\u0930 \u0930\u092E";
    expect(redactKnownName(text, "\u0930\u093E\u092E")).toBe(text);
  });
});

describe("#2166 — known limits, pinned so nobody is surprised", () => {
  it("an initial glued with no separator to a dotted name is not matched (KSuresh)", () => {
    expect(redactKnownName("main KSuresh hoon", "K.Suresh")).toBe("main KSuresh hoon");
  });

  it("a virama typed off is a different word (ओम् vs ओम)", () => {
    expect(redactKnownName("main \u0913\u092E hoon", "\u0913\u092E\u094D")).toBe(
      "main \u0913\u092E hoon",
    );
    expect(redactKnownName("main \u0913\u092E\u094D hoon", "\u0913\u092E\u094D")).toBe(
      `main ${P} hoon`,
    );
  });

  it("a stored name joined ONLY by an invisible is one word", () => {
    expect(redactKnownName("main Suresh hoon", `Suresh${ZWSP}Kumar`)).toBe("main Suresh hoon");
    expect(redactKnownName("main SureshKumar hoon", `Suresh${ZWSP}Kumar`)).toBe(`main ${P} hoon`);
  });

  it("parts out of stored order are separate placeholders", () => {
    expect(redactKnownName("Kumar Suresh", "Suresh Kumar")).toBe(`${P} ${P}`);
  });
});

describe("knownNameMatcher — one compiled reading of the name", () => {
  it("test() answers what redact() would replace", () => {
    const matcher = knownNameMatcher("K.Suresh");
    expect(matcher?.test(`main Sur${ZWSP}esh hoon`)).toBe(true);
    expect(matcher?.test("main \uFF33\uFF55\uFF52\uFF45\uFF53\uFF48 hoon")).toBe(true);
    expect(matcher?.test("Sureshbhai")).toBe(false);
    expect(matcher?.test("")).toBe(false);
    // Repeated calls agree: no `lastIndex` state leaks between them.
    expect(matcher?.test("Suresh")).toBe(true);
    expect(matcher?.test("Suresh")).toBe(true);
    expect(matcher?.redact("Suresh, Suresh")).toBe(`${P}, ${P}`);
    expect(matcher?.redact("Suresh")).toBe(P);
  });

  it("is null for a name with nothing usable, and never throws", () => {
    for (const name of [null, undefined, "", "   ", "R K", `${ZWSP}${SOFT_HYPHEN}`, "...", "--"]) {
      expect(knownNameMatcher(name)).toBeNull();
    }
    expect(() => knownNameMatcher("\u{103FF}\uD800 Suresh")).not.toThrow();
    expect(redactKnownName("Suresh \uD800", "\uD800 Suresh")).toBe(`${P} \uD800`);
  });
});

describe("#2166 — linear time on a 20,000-character text with a hostile name", () => {
  // Each name is at most 100 characters (the DTO's bound) and shaped to make the matcher work
  // hardest on its text: many short parts in front of a long one, separator runs, invisibles
  // inside, a non-ASCII text folded unit by unit. Catastrophic backtracking would take seconds
  // to forever; the bound is loose enough for a loaded CI runner.
  const BUDGET_MS = 1_500;
  const cases: readonly (readonly [string, string, string])[] = [
    ["initials in front of a long part", `${"a ".repeat(48)}aaa`, "a ".repeat(10_000)],
    ["hyphen-glued initials", `${"a-".repeat(48)}aaaa`, "a-".repeat(10_000)],
    [
      "separator runs between long parts",
      "Suresh Kumar Yadav Singh",
      `Suresh${" ".repeat(400)}Kumar${".".repeat(400)}Yadav${"-".repeat(400)}`.repeat(17),
    ],
    ["separator runs between initials", `${"a ".repeat(48)}aaa`, `a${" ".repeat(199)}`.repeat(100)],
    ["invisibles inside every letter", "s".repeat(50), `s${ZWSP}`.repeat(10_000)],
    ["apostrophe glue", `${"d'".repeat(48)}dddd`, "d'".repeat(10_000)],
    [
      "Devanagari, folded unit by unit",
      "\u0930\u093E\u092E \u0930\u093E",
      "\u0930\u093E".repeat(10_000),
    ],
    ["no match at all", "Suresh Kumar", "x".repeat(20_000)],
  ];

  it.each(cases)(
    "%s",
    (_, name, text) => {
      expect(name.length).toBeLessThanOrEqual(100);
      expect(text.length).toBeGreaterThanOrEqual(20_000);
      const started = performance.now();
      redactKnownName(text, name);
      knownNameMatcher(name)?.test(text);
      expect(performance.now() - started).toBeLessThan(BUDGET_MS);
    },
    30_000,
  );
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
