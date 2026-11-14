import { describe, expect, it } from "vitest";
import { cleanDriveLine, cleanDriveText } from "./campus-drive-text";

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
const LSEP = ch(0x2028); // line separator (Zl)
const PSEP = ch(0x2029); // paragraph separator (Zp)
const PUA = ch(0xe000); // private use (Co)
const LONE_HIGH = ch(0xd800); // a lone surrogate (Cs)
const LONE_LOW = ch(0xdc00);
/** A real astral character (a surrogate PAIR), which must survive. */
const HAMMER = String.fromCodePoint(0x1f528);

describe("cleanDriveText — roles_note and the decision reason", () => {
  it("keeps visible text, newlines and an emoji written as a surrogate pair", () => {
    const note = `CNC operators${LF}Two shifts ${HAMMER}`;
    expect(cleanDriveText(note)).toBe(note);
  });

  it.each([
    ["NUL", NUL],
    ["TAB", TAB],
    ["CR", CR],
    ["NEL (C1)", NEL],
    ["RLO (bidi override)", RLO],
    ["ZWSP", ZWSP],
    ["BOM", BOM],
    ["line separator", LSEP],
    ["paragraph separator", PSEP],
    ["private use", PUA],
    ["lone high surrogate", LONE_HIGH],
    ["lone low surrogate", LONE_LOW],
  ])("removes %s", (_name, hidden) => {
    expect(cleanDriveText(`CNC${hidden}operators`)).toBe("CNCoperators");
  });

  it("turns CRLF into LF and trims what is left", () => {
    expect(cleanDriveText(`  line one${CR}${LF}line two  `)).toBe(`line one${LF}line two`);
  });

  it("is no note at all when nothing visible is left, and undefined passes through", () => {
    expect(cleanDriveText(`${ZWSP}${RLO}  ${LF}`)).toBeUndefined();
    expect(cleanDriveText(undefined)).toBeUndefined();
  });
});

describe("cleanDriveLine — the contact name", () => {
  it("turns a tab or a line break into a space, so a name stays on one line", () => {
    expect(cleanDriveLine(`Ravi${LF}Sharma`)).toBe("Ravi Sharma");
    expect(cleanDriveLine(`Ravi${TAB}Sharma`)).toBe("Ravi Sharma");
    expect(cleanDriveLine(`Ravi${CR}${LF}Sharma`)).toBe("Ravi  Sharma");
  });

  it("removes format characters and keeps the name otherwise as written", () => {
    expect(cleanDriveLine(`Ra${RLO}vi Sh${ZWSP}arma`)).toBe("Ravi Sharma");
    expect(cleanDriveLine("राम कुमार")).toBe("राम कुमार");
  });

  it("is undefined when nothing visible is left", () => {
    expect(cleanDriveLine(`${ZWSP}${BOM} `)).toBeUndefined();
  });
});
