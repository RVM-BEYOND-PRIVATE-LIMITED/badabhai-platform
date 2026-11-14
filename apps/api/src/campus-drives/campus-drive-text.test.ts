import { describe, expect, it } from "vitest";
import { cleanReviewReason } from "../campus-link/campus-review-reason";
import { cleanDriveLine } from "./campus-drive-text";

// Hidden characters, built from code points so no editor can turn them into anything else.
const ch = (code: number) => String.fromCharCode(code);
const NUL = ch(0x00);
const TAB = ch(0x09);
const LF = ch(0x0a);
const CR = ch(0x0d);
const NEL = ch(0x85); // a C1 control (Cc) that renders as a line break
const RLO = ch(0x202e); // right-to-left override (Cf)
const ZWSP = ch(0x200b); // zero-width space (Cf)
const BOM = ch(0xfeff); // byte-order mark (Cf)
const ZWNJ = ch(0x200c); // zero-width non-joiner (Cf): Indic spellings need it
const ZWJ = ch(0x200d); // zero-width joiner (Cf): Indic spellings need it
const LSEP = ch(0x2028); // line separator (Zl)
const PSEP = ch(0x2029); // paragraph separator (Zp)
const PUA = ch(0xe000); // private use (Co)
const LONE_HIGH = ch(0xd800); // a lone surrogate (Cs)
/** A real astral character (a surrogate PAIR), which must survive. */
const HAMMER = String.fromCodePoint(0x1f528);

describe("cleanDriveLine — the contact name, on the shared Campus character rule", () => {
  it("turns a tab or a line break into a space, so a name stays on one line", () => {
    expect(cleanDriveLine(`Ravi${LF}Sharma`)).toBe("Ravi Sharma");
    expect(cleanDriveLine(`Ravi${TAB}Sharma`)).toBe("Ravi Sharma");
    expect(cleanDriveLine(`Ravi${CR}${LF}Sharma`)).toBe("Ravi  Sharma");
  });

  it.each([
    ["NUL", NUL],
    ["NEL (C1)", NEL],
    ["RLO (bidi override)", RLO],
    ["ZWSP", ZWSP],
    ["BOM", BOM],
    ["line separator", LSEP],
    ["paragraph separator", PSEP],
    ["private use", PUA],
    ["lone surrogate", LONE_HIGH],
  ])("removes %s", (_name, hidden) => {
    expect(cleanDriveLine(`Ravi${hidden} Sharma`)).toBe("Ravi Sharma");
  });

  it("keeps ZWNJ and ZWJ (Indic spellings), Devanagari and an astral character", () => {
    expect(cleanDriveLine(`a${ZWNJ}b${ZWJ}c`)).toBe(`a${ZWNJ}b${ZWJ}c`);
    expect(cleanDriveLine("राम कुमार")).toBe("राम कुमार");
    expect(cleanDriveLine(`Ravi ${HAMMER}`)).toBe(`Ravi ${HAMMER}`);
  });

  it("is undefined when nothing visible is left", () => {
    expect(cleanDriveLine(`${ZWSP}${BOM} ${LF}`)).toBeUndefined();
  });
});

describe("roles_note and the decision reason use PR 5's note cleaner", () => {
  it("keeps newlines and the Indic joiners, drops every other hidden character", () => {
    expect(cleanReviewReason(`CNC${RLO} operators${LF}two${ZWNJ}shifts${ZWSP}`)).toBe(
      `CNC operators${LF}two${ZWNJ}shifts`,
    );
  });
});
