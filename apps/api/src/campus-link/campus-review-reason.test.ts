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

  it("strips zero-width and other invisible format characters", () => {
    const dirty = `pa${ZWSP}y${ZWJ} lo${WORD_JOINER}w${SOFT_HYPHEN}${BOM}`;
    expect(cleanReviewReason(dirty)).toBe("pay low");
  });

  it("trims after stripping, so hidden characters cannot shield whitespace", () => {
    expect(cleanReviewReason(`${ZWSP}  spaced  ${RLO}`)).toBe("spaced");
  });

  it("treats a note left empty as no note at all", () => {
    expect(cleanReviewReason(`${ZWSP}${RLO}${NUL}`)).toBeUndefined();
    expect(cleanReviewReason(`${NEWLINE}${NEWLINE}`)).toBeUndefined();
    expect(cleanReviewReason(undefined)).toBeUndefined();
  });

  it("keeps visible non-Latin text untouched", () => {
    const hindi = "वेतन कम है";
    expect(cleanReviewReason(hindi)).toBe(hindi);
  });
});
