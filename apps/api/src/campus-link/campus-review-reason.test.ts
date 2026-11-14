import { describe, expect, it } from "vitest";
import { cleanReviewReason } from "./campus-review-reason";

/**
 * #2746 PR 5 — the review note is shown verbatim to the company, so nothing invisible is stored.
 * Every hidden character below is built from its code point (`String.fromCharCode`), never typed.
 */
const ch = (codePoint: number) => String.fromCharCode(codePoint);

const NEWLINE = ch(0x0a);
const CR = ch(0x0d);
const TAB = ch(0x09);
const NUL = ch(0x00);
const BELL = ch(0x07);
const ESC = ch(0x1b);
const DEL = ch(0x7f);
const C1_NEL = ch(0x85);
const RLO = ch(0x202e); // right-to-left override
const LRI = ch(0x2066); // left-to-right isolate
const PDI = ch(0x2069); // pop directional isolate
const ZWSP = ch(0x200b); // zero-width space
const ZWJ = ch(0x200d); // zero-width joiner
const WORD_JOINER = ch(0x2060);
const BOM = ch(0xfeff);
const SOFT_HYPHEN = ch(0x00ad);

describe("cleanReviewReason", () => {
  it("keeps an ordinary note, and the newlines of a multi-line one", () => {
    expect(cleanReviewReason("Pay below the RVM floor")).toBe("Pay below the RVM floor");
    expect(cleanReviewReason(`Line one${NEWLINE}Line two`)).toBe(`Line one${NEWLINE}Line two`);
  });

  it("strips every other control character (C0, DEL, C1), including CR and TAB", () => {
    const dirty = `a${NUL}b${BELL}c${ESC}[31md${DEL}e${C1_NEL}f${TAB}g${CR}${NEWLINE}h`;
    expect(cleanReviewReason(dirty)).toBe(`abc[31mdefg${NEWLINE}h`);
  });

  it("strips bidi overrides and isolates, so the company reads what was stored", () => {
    expect(cleanReviewReason(`Approved ${RLO}detcejer${PDI} ok`)).toBe("Approved detcejer ok");
    expect(cleanReviewReason(`${LRI}note${PDI}`)).toBe("note");
  });

  it("strips zero-width space and the other invisible format characters", () => {
    const dirty = `pa${ZWSP}y lo${WORD_JOINER}w${SOFT_HYPHEN}${BOM}`;
    expect(cleanReviewReason(dirty)).toBe("pay low");
  });

  it("keeps ZWNJ and ZWJ, which Indic spellings need, and still strips a bidi override beside them", () => {
    const ZWNJ = ch(0x200c);
    // Devanagari KA + VIRAMA + ZWJ + SSA: a half-form conjunct written with a joiner.
    const conjunct = ch(0x0915) + ch(0x094d) + ZWJ + ch(0x0937);
    expect(cleanReviewReason(`${conjunct} ${ZWNJ}ok`)).toBe(`${conjunct} ${ZWNJ}ok`);
    expect(cleanReviewReason(`${RLO}${conjunct}`)).toBe(conjunct);
  });

  it("trims after stripping, so hidden characters cannot shield whitespace", () => {
    expect(cleanReviewReason(`${ZWSP}  spaced  ${RLO}`)).toBe("spaced");
  });

  it("treats a note left empty as no note at all", () => {
    expect(cleanReviewReason(`${ZWSP}${RLO}${NUL}`)).toBeUndefined();
    expect(cleanReviewReason(`${NEWLINE}${NEWLINE}`)).toBeUndefined();
    expect(cleanReviewReason(undefined)).toBeUndefined();
  });

  it("strips line and paragraph separators, private-use and unassigned code points", () => {
    const LINE_SEP = ch(0x2028); // Zl
    const PARA_SEP = ch(0x2029); // Zp
    const PRIVATE_USE = ch(0xe000); // Co
    const UNASSIGNED = ch(0x0378); // Cn (a hole in the Greek block)
    expect(cleanReviewReason(`one${LINE_SEP}two${PARA_SEP}three`)).toBe("onetwothree");
    expect(cleanReviewReason(`a${PRIVATE_USE}b${UNASSIGNED}c`)).toBe("abc");
  });

  it("strips lone surrogates, which the driver would rewrite to U+FFFD, and keeps a real pair", () => {
    const HIGH = ch(0xd800);
    const LOW = ch(0xdc00);
    const EMOJI = String.fromCodePoint(0x1f600); // a valid surrogate PAIR, one visible character
    expect(cleanReviewReason(`x${HIGH}y${LOW}z`)).toBe("xyz");
    expect(cleanReviewReason(`ok ${EMOJI}`)).toBe(`ok ${EMOJI}`);
  });

  it("keeps visible non-Latin text untouched", () => {
    const hindi = "वेतन कम है";
    expect(cleanReviewReason(hindi)).toBe(hindi);
  });
});
