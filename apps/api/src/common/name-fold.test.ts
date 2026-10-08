import { describe, expect, it } from "vitest";

import {
  codePointCount,
  FOLD_SENTINEL,
  foldAwayMarks,
  foldName,
  foldText,
  MAX_FOLDED_MARKS,
  nameWordParts,
  NAME_SEPARATORS,
} from "./name-fold";

/**
 * #2166 — the fold the own-name redaction matches in. What these pin: the shadow reads variants
 * alike, and every shadow span maps back onto WHOLE units of the original, so a replacement never
 * touches a character outside the name and never splits a letter from its marks.
 */

const ZWSP = "\u200B";
const SOFT_HYPHEN = "\u00AD";
const ZWJ = "\u200D";

describe("foldText — the shadow", () => {
  it("is the text itself for pure ASCII, with an identity map", () => {
    const folded = foldText("main Suresh hoon");
    expect(folded.shadow).toBe("main Suresh hoon");
    expect(folded.originalSpan(5, 11)).toEqual([5, 11]);
  });

  it("folds compatibility letters, keeps compatibility symbols and digits as they are", () => {
    expect(foldText("\uFF33\uFF55\uFF52").shadow).toBe("Sur"); // fullwidth letters
    expect(foldText("\u{1D412}\u{1D42E}").shadow).toBe("Su"); // math bold, astral
    expect(foldText("\uFF0E\uFF0D").shadow).toBe(".-"); // fullwidth punctuation adds no word char
    expect(foldText("5m\u00B2 \u2460 \u2122 \uFF12").shadow).toBe("5m\u00B2 \u2460 \u2122 \uFF12");
  });

  it("turns each invisible into one sentinel", () => {
    expect(foldText(`Sur${ZWSP}esh${SOFT_HYPHEN}`).shadow).toBe(
      `Sur${FOLD_SENTINEL}esh${FOLD_SENTINEL}`,
    );
  });

  it("decomposes, and folds away the nukta and the Latin diacritics but no other mark", () => {
    expect(foldText("\u095B").shadow).toBe("\u091C"); // ज़ precomposed
    expect(foldText("\u091C\u093C").shadow).toBe("\u091C"); // ज + nukta
    expect(foldText("Jos\u00E9").shadow).toBe("Jose");
    expect(foldText("\u0930\u093E\u092E\u094D").shadow).toBe("\u0930\u093E\u092E\u094D"); // राम्
  });
});

describe("foldText — the way back to the original", () => {
  it("maps a shadow span onto the whole units it was folded from", () => {
    const text = "ab \uFF33\uFF55 cd";
    const folded = foldText(text);
    expect(folded.shadow).toBe("ab Su cd");
    expect(folded.originalSpan(3, 5)).toEqual([3, 5]);
    expect(text.slice(...folded.originalSpan(3, 5))).toBe("\uFF33\uFF55");
  });

  it("maps astral letters by their UTF-16 length", () => {
    const text = "x \u{1D412}\u{1D42E} y";
    const folded = foldText(text);
    expect(folded.shadow).toBe("x Su y");
    expect(text.slice(...folded.originalSpan(2, 4))).toBe("\u{1D412}\u{1D42E}");
  });

  it("widens a span to the whole unit, marks included", () => {
    // "रामे": a match ending at म takes the vowel sign with it.
    const text = "\u0930\u093E\u092E\u0947 x";
    const folded = foldText(text);
    expect(text.slice(...folded.originalSpan(0, 3))).toBe("\u0930\u093E\u092E\u0947");
  });

  it("keeps the invisibles inside a span, and leaves the ones outside it", () => {
    const text = `a Sur${ZWSP}esh${ZWSP} b`;
    const folded = foldText(text);
    const start = folded.shadow.indexOf("S");
    const end = folded.shadow.indexOf("h") + 1;
    expect(text.slice(...folded.originalSpan(start, end))).toBe(`Sur${ZWSP}esh`);
  });

  it("skips a unit that folded to nothing", () => {
    // A lone combining acute at the start folds away; the map still finds "a".
    const text = "\u0301a\u00E9";
    const folded = foldText(text);
    expect(folded.shadow).toBe("ae");
    expect(folded.originalSpan(0, 1)).toEqual([1, 2]);
    expect(folded.originalSpan(1, 2)).toEqual([2, 3]);
  });
});

describe("the sentinel and the mark cap", () => {
  it("reads a U+FFFF already in the text as an invisible, so it cannot mean anything else", () => {
    // The literal classes spell U+FFFF out; this pins that they agree with FOLD_SENTINEL.
    expect(FOLD_SENTINEL).toBe("\uFFFF");
    expect(foldText(`a${FOLD_SENTINEL}b\u00E9`).shadow).toBe(`a${FOLD_SENTINEL}be`);
    expect(foldName(`Sur${FOLD_SENTINEL}esh`)).toBe("Suresh");
  });

  it("folds a base and at most its first MAX_FOLDED_MARKS marks, and maps the whole unit back", () => {
    const marks = "\u20D0".repeat(MAX_FOLDED_MARKS + 50);
    const text = `x a${marks} y`;
    const folded = foldText(text);
    expect(folded.shadow).toBe(`x a${"\u20D0".repeat(MAX_FOLDED_MARKS)} y`);
    const start = folded.shadow.indexOf("a");
    expect(text.slice(...folded.originalSpan(start, start + 1))).toBe(`a${marks}`);
    // The unit after it maps exactly: the dropped marks shift nothing.
    const y = folded.shadow.indexOf("y");
    expect(folded.originalSpan(y, y + 1)).toEqual([text.length - 1, text.length]);
  });

  it("counts code points, an astral letter and a lone surrogate as one each", () => {
    expect(codePointCount("Suresh")).toBe(6);
    expect(codePointCount("\u{1D412}\u{1D42E}")).toBe(2);
    expect(codePointCount("a\uD800b")).toBe(3);
    expect(codePointCount("")).toBe(0);
  });
});

describe("foldName and the name's parts", () => {
  it("deletes a stored name's in-word invisibles, spaces its zero-width space, keeps its marks", () => {
    expect(foldName(`Sur${SOFT_HYPHEN}esh Ku${ZWJ}mar`)).toBe("Suresh Kumar");
    // A zero-width space is a word separator (#2166 review L2): two words, not one.
    expect(foldName(`Suresh${ZWSP}Kumar`)).toBe("Suresh Kumar");
    expect(foldName(`Suresh${ZWSP} Kumar`)).toBe("Suresh  Kumar");
    expect(foldName("\u095B")).toBe("\u091C\u093C");
    expect(foldAwayMarks(foldName("\u095B"))).toBe("\u091C");
  });

  it("splits a word on dots, hyphens, apostrophes, digits and modifier letters", () => {
    expect(nameWordParts("K.Suresh")).toEqual([
      { part: "K", separatorBefore: "" },
      { part: "Suresh", separatorBefore: "." },
    ]);
    expect(nameWordParts("D\u02BCSouza").map(({ part }) => part)).toEqual(["D", "Souza"]);
    expect(nameWordParts("(Raju007)")).toEqual([{ part: "Raju", separatorBefore: "" }]);
    expect(nameWordParts("R.K.-Ramesh")[2]).toEqual({ part: "Ramesh", separatorBefore: ".-" });
    expect(nameWordParts("98765")).toEqual([]);
  });

  it("NAME_SEPARATORS splits the same way through `split`, whatever its lastIndex", () => {
    NAME_SEPARATORS.lastIndex = 3;
    try {
      expect("Anil D'Souza".split(NAME_SEPARATORS)).toEqual(["Anil", "D", "Souza"]);
      expect("Raju007".split(NAME_SEPARATORS)).toEqual(["Raju", ""]);
    } finally {
      NAME_SEPARATORS.lastIndex = 0;
    }
  });
});
