import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { isDartWhitespace, titleCaseWords } from "./title-case";

/**
 * PARITY WITH `apps/worker-app/lib/core/util/title_case.dart` (#1432).
 *
 * The first block is `apps/worker-app/test/core/util/title_case_test.dart`, case for case and in
 * its order. The edges after it pin where a NAIVE JavaScript port would disagree with the Dart, so
 * a later "simplification" to `trim()`, a regex or `toUpperCase()` fails here rather than in a
 * backfill. The last block holds the port to the app's function as RECORDED on the Dart VM, over
 * every Unicode scalar value — the only check that does not depend on someone thinking of the case.
 */
describe("titleCaseWords — the Dart suite, case for case", () => {
  it("capitalizes the first letter of each lowercase word", () => {
    expect(titleCaseWords("rvm cad pvt lt")).toBe("Rvm Cad Pvt Lt");
  });

  it("single word", () => {
    expect(titleCaseWords("faridabad")).toBe("Faridabad");
  });

  it("already-capitalized text is unchanged", () => {
    expect(titleCaseWords("Asha Kumari")).toBe("Asha Kumari");
  });

  it("never touches a letter that is already uppercase — a deliberate abbreviation typed in caps survives untouched", () => {
    expect(titleCaseWords("RVM CAD")).toBe("RVM CAD");
    expect(titleCaseWords("ITI Faridabad")).toBe("ITI Faridabad");
    expect(titleCaseWords("NIFT")).toBe("NIFT");
  });

  it("mixed case: only a lowercase FIRST letter is fixed, nothing else in the word is touched", () => {
    expect(titleCaseWords("mCA institute")).toBe("MCA Institute");
  });

  it("empty string", () => {
    expect(titleCaseWords("")).toBe("");
  });

  it("leading/trailing/multiple internal spaces are preserved", () => {
    expect(titleCaseWords("govt  iti")).toBe("Govt  Iti");
  });

  it("digits and punctuation as a word start are left alone (no letter to capitalize)", () => {
    expect(titleCaseWords("3d cad institute")).toBe("3d Cad Institute");
  });
});

describe("titleCaseWords — the issue's own examples (#1432)", () => {
  it("fixes the reported value and leaves the correct ones byte-identical — never INITCAP", () => {
    expect(titleCaseWords("recursive global infotech pvt ltd")).toBe(
      "Recursive Global Infotech Pvt Ltd",
    );
    // INITCAP would print "Rvm Cad" and "Cnc Operator". These are the two the issue names.
    expect(titleCaseWords("RVM CAD")).toBe("RVM CAD");
    expect(titleCaseWords("CNC Operator")).toBe("CNC Operator");
  });
});

describe("titleCaseWords — edges where a naive JavaScript port would disagree with the Dart", () => {
  it("preserves leading and trailing whitespace, and every run of it", () => {
    expect(titleCaseWords("  spaced  out  ")).toBe("  Spaced  Out  ");
    expect(titleCaseWords(" ")).toBe(" ");
  });

  it("treats a tab and a newline as word breaks, exactly like a space", () => {
    expect(titleCaseWords("cnc\tturner\nfitter\r\nwelder")).toBe("Cnc\tTurner\nFitter\r\nWelder");
  });

  it("U+0085 (NEXT LINE) breaks a word — Dart trims it, JavaScript's trim() does not", () => {
    // THE ONE WHITESPACE DISAGREEMENT. A port written as `char.trim() === ""` returns "A\u0085b".
    expect("\u0085".trim()).toBe("\u0085"); // the JavaScript behaviour this guards against
    expect(titleCaseWords("a\u0085b")).toBe("A\u0085B");
  });

  it("every code point in Dart's whitespace list starts a new word", () => {
    const dartList = [
      0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0x85, 0xa0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003,
      0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f,
      0x3000, 0xfeff,
    ];
    for (const cp of dartList) {
      const sep = String.fromCodePoint(cp);
      expect(isDartWhitespace(cp), cp.toString(16)).toBe(true);
      expect(titleCaseWords(`a${sep}b`), cp.toString(16)).toBe(`A${sep}B`);
    }
  });

  it("does NOT break a word on look-alikes Dart does not trim (zero-width space, U+180E)", () => {
    for (const cp of [0x200b, 0x180e, 0x200c, 0x200d]) {
      expect(isDartWhitespace(cp), cp.toString(16)).toBe(false);
      expect(titleCaseWords(`a${String.fromCodePoint(cp)}b`)).toBe(`A${String.fromCodePoint(cp)}b`);
    }
  });

  it("punctuation is NOT a word break — unlike the API renderer's wider rule", () => {
    // The renderer (`resume-text-case.ts`) prints "Auto-Parts", "L&T", "(India)". The APP stores
    // what this function returns, and that is what a backfill must reproduce.
    expect(titleCaseWords("shri ram auto-parts (india)")).toBe("Shri Ram Auto-parts (india)");
    expect(titleCaseWords("l&t")).toBe("L&t");
    expect(titleCaseWords("m/s sharma engineering")).toBe("M/s Sharma Engineering");
    expect(titleCaseWords("shri ram's auto")).toBe("Shri Ram's Auto");
  });

  it("leaves Devanagari untouched — it has no case", () => {
    expect(titleCaseWords("फरीदाबाद")).toBe("फरीदाबाद");
    expect(titleCaseWords("आईटीआई faridabad")).toBe("आईटीआई Faridabad");
  });

  it("walks by CODE POINT, as Dart's `runes` does — an astral letter is cased as one unit", () => {
    // DESERET SMALL LONG I (U+10428) → CAPITAL (U+10400): a surrogate pair in UTF-16. Walking by
    // UTF-16 unit would upper-case half a character and leave the string unchanged or broken.
    expect(titleCaseWords("\u{10428}\u{1042F} x")).toBe("\u{10400}\u{1042F} X");
  });

  it("cases a precomposed accent, and leaves a combining mark after the letter it follows", () => {
    expect(titleCaseWords("éclair")).toBe("Éclair");
    expect(titleCaseWords("éclair")).toBe("Éclair");
  });

  it("never EXPANDS a letter — the Dart VM maps one code point to one", () => {
    // JavaScript alone would give "SSauer" and "FItter".
    expect("ß".toUpperCase()).toBe("SS");
    expect(titleCaseWords("ßauer")).toBe("ßauer");
    expect(titleCaseWords("ﬁtter shop")).toBe("ﬁtter Shop");
  });

  it("cases what the Dart VM cases, not what JavaScript does", () => {
    // Greek with an iota subscript: the VM gives ONE titlecase code point, JavaScript two ("ἈΙ").
    expect("ᾀ".toUpperCase()).toBe("ἈΙ");
    expect(titleCaseWords("ᾀ ᾳ ῳ")).toBe("ᾈ ᾼ ῼ");
    // Letters the VM's older case table leaves alone and JavaScript (Unicode 17) raises.
    expect("ɥ ა".toUpperCase()).toBe("Ɥ Ა");
    expect(titleCaseWords("ɥ ა ꭰ")).toBe("ɥ ა ꭰ");
    // A titlecase digraph is upper-cased, exactly as `char.toUpperCase()` does in the app.
    expect(titleCaseWords("ǅ ǆ ǈ")).toBe("Ǆ Ǆ Ǉ");
  });
});

describe("titleCaseWords — properties a one-time backfill leans on", () => {
  const corpus = [
    "rvm cad pvt lt",
    "RVM CAD",
    "CNC Operator",
    "mCA institute",
    "  govt  iti  ",
    "3d cad institute",
    "shri ram auto-parts (india)",
    "आईटीआई faridabad",
    "a\u0085b",
    "ßauer ﬁtter",
    "\u{10428}x y",
    "éclair",
    "",
  ];

  it("is idempotent, so a re-run of the backfill changes nothing", () => {
    for (const s of corpus) expect(titleCaseWords(titleCaseWords(s))).toBe(titleCaseWords(s));
  });

  it("never changes a value's length, so it cannot break a column's length CHECK", () => {
    for (const s of corpus) expect(titleCaseWords(s).length).toBe(s.length);
  });

  it("never lowercases anything — every changed code point became its own uppercase", () => {
    for (const s of corpus) {
      const before = [...s];
      const after = [...titleCaseWords(s)];
      expect(after).toHaveLength(before.length);
      before.forEach((c, i) => {
        if (after[i] !== c) expect(after[i]).toBe(c.toUpperCase());
      });
    }
  });
});

/**
 * THE APP'S FUNCTION, AS RECORDED ON THE DART VM. `__fixtures__/title-case.dart-vm.probe.dart`
 * imports `title_case.dart` itself and runs it over every Unicode scalar value; its header says how
 * to regenerate the recording. Nothing here re-derives the Dart — it compares against its output.
 */
describe("titleCaseWords — every scalar value, against the app's function on the Dart VM", () => {
  interface Recording {
    readonly dart: string;
    readonly whitespace: readonly number[];
    readonly upper: readonly (readonly number[])[];
    readonly anomalies: readonly number[];
    readonly strings: readonly (readonly (readonly number[])[])[];
  }
  const recording = JSON.parse(
    readFileSync(join(__dirname, "__fixtures__", "title-case.dart-vm.json"), "utf8"),
  ) as Recording;
  const whitespace = new Set(recording.whitespace);
  const upper = new Map(
    recording.upper.map(([from, ...to]) => [from!, String.fromCodePoint(...to)]),
  );

  function* scalarValues(): Generator<number> {
    for (let cp = 0; cp <= 0x10ffff; cp++) if (cp < 0xd800 || cp > 0xdfff) yield cp;
  }

  // The three walks over all 1,112,064 scalar values take 0.1-0.25 s alone, but CI runs every
  // package's tests at once: on 2026-10-03 one took 5.48 s and failed main on vitest's 5 s default.
  // A walk is bounded (no I/O, no retry), so a generous ceiling only absorbs contention.
  const EXHAUSTIVE_TIMEOUT_MS = 60_000;

  it("is a recording of the toolchain the app ships on, and every input fit the probe's model", () => {
    // Dart 3.9 is the Dart inside Flutter 3.35.7, the version ci.yml builds the app with.
    expect(recording.dart).toMatch(/^3\.9\./);
    expect(recording.anomalies).toEqual([]);
    expect(recording.upper.every((entry) => entry.length === 2)).toBe(true);
  });

  it(
    "breaks a word on exactly the code points the app does",
    () => {
      const disagree: string[] = [];
      for (const cp of scalarValues()) {
        if (isDartWhitespace(cp) !== whitespace.has(cp)) disagree.push(cp.toString(16));
      }
      expect(disagree).toEqual([]);
    },
    EXHAUSTIVE_TIMEOUT_MS,
  );

  it(
    "cases a word's first code point exactly as the app does, and never touches a later one",
    () => {
      const disagree: string[] = [];
      for (const cp of scalarValues()) {
        if (whitespace.has(cp)) continue;
        const c = String.fromCodePoint(cp);
        const expected = upper.get(cp) ?? c;
        if (titleCaseWords(c) !== expected || titleCaseWords(`x${c}`) !== `X${c}`) {
          disagree.push(cp.toString(16));
        }
      }
      expect(disagree).toEqual([]);
    },
    EXHAUSTIVE_TIMEOUT_MS,
  );

  it("returns the app's output for every recorded whole string", () => {
    expect(recording.strings.length).toBeGreaterThan(200);
    for (const [input, output] of recording.strings) {
      const s = String.fromCodePoint(...input!);
      expect(titleCaseWords(s), JSON.stringify(s)).toBe(String.fromCodePoint(...output!));
    }
  });

  it(
    "is idempotent and length-preserving on every scalar value, not just the corpus above",
    () => {
      const disagree: string[] = [];
      for (const cp of scalarValues()) {
        const once = titleCaseWords(String.fromCodePoint(cp));
        if (titleCaseWords(once) !== once || once.length !== String.fromCodePoint(cp).length) {
          disagree.push(cp.toString(16));
        }
      }
      expect(disagree).toEqual([]);
    },
    EXHAUSTIVE_TIMEOUT_MS,
  );
});
