import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  checkFontContract,
  embeddedFontFaces,
  FontResolutionError,
  stripSubsetTag,
  type FontContract,
} from "./font-resolution";

/**
 * These tests run against REAL WeasyPrint output, not hand-written PDF-ish bytes.
 *
 * `__fixtures__/font-probe/*.pdf` were produced by rendering the probe document in
 * three containers — the shipped image, the same image with `fonts-noto-core`
 * deleted, and that one with the DejaVu *sans* faces deleted as well. All three
 * exited 0 and produced a valid PDF; that is the whole problem, and it is why the
 * negative cases here are bytes rather than assertions about bytes.
 *
 * See the fixtures' README for the exact commands.
 */
const FIXTURES = join(__dirname, "..", "..", "resume", "__fixtures__", "font-probe");
const pdf = (name: string): Buffer => readFileSync(join(FIXTURES, `${name}.pdf`));

const CONTRACT: FontContract = {
  what: "test",
  probeHtml: "<p>unused - these tests never render</p>",
  requiredFaces: ["Noto-Sans", "Noto-Sans-Devanagari"],
  allowedFamilyPrefixes: ["Noto-Sans"],
};

describe("stripSubsetTag", () => {
  it("strips a real six-capital subset tag", () => {
    expect(stripSubsetTag("HUHQIP+Noto-Sans")).toBe("Noto-Sans");
  });

  it("leaves a name alone when the prefix is not a subset tag", () => {
    // A tag is EXACTLY six capitals and a plus. Anything else is part of the name,
    // and eating it would silently merge two different faces into one.
    expect(stripSubsetTag("ABC+Noto-Sans")).toBe("ABC+Noto-Sans");
    expect(stripSubsetTag("ABCDEFG+Noto-Sans")).toBe("ABCDEFG+Noto-Sans");
    expect(stripSubsetTag("Noto-Sans")).toBe("Noto-Sans");
  });
});

describe("embeddedFontFaces reads what the renderer actually embedded", () => {
  it("finds both faces inside a COMPRESSED WeasyPrint PDF", () => {
    // Font dictionaries live in Flate object streams. If the inflate path regressed,
    // this returns [] - which is precisely the state that must not read as "clean".
    expect(embeddedFontFaces(pdf("full-fonts"))).toEqual(["Noto-Sans", "Noto-Sans-Devanagari"]);
  });

  it("reports the substituted families in the two degraded renders", () => {
    expect(embeddedFontFaces(pdf("no-noto"))).toEqual(["DejaVu-Sans"]);
    expect(embeddedFontFaces(pdf("no-sans"))).toEqual(["DejaVu-Serif"]);
  });

  it("returns nothing from bytes it cannot read, rather than throwing", () => {
    expect(embeddedFontFaces(Buffer.from("not a pdf at all"))).toEqual([]);
    expect(embeddedFontFaces(Buffer.alloc(0))).toEqual([]);
  });
});

describe("checkFontContract", () => {
  it("passes the shipped image", () => {
    expect(checkFontContract(pdf("full-fonts"), CONTRACT)).toEqual({
      missing: [],
      unexpected: [],
    });
  });

  it("FAILS the render with fonts-noto-core removed - the Devanagari tofu case", () => {
    // What this fixture looks like without the check: a valid PDF, exit 0, correct
    // page count, and the worker's name a row of empty boxes.
    const result = checkFontContract(pdf("no-noto"), CONTRACT);
    expect(result.missing).toEqual(["Noto-Sans", "Noto-Sans-Devanagari"]);
    expect(result.unexpected).toEqual(["DejaVu-Sans"]);
  });

  it("FAILS the render that silently fell through to a serif", () => {
    const result = checkFontContract(pdf("no-sans"), CONTRACT);
    expect(result.missing).toEqual(["Noto-Sans", "Noto-Sans-Devanagari"]);
    expect(result.unexpected).toEqual(["DejaVu-Serif"]);
  });

  it("fails an unreadable PDF instead of finding no violations in it", () => {
    // The mutation bar, stated as a test: "I could not look" must never be reported
    // as "I looked and it was fine".
    expect(checkFontContract(Buffer.alloc(0), CONTRACT).missing).toEqual([
      "Noto-Sans",
      "Noto-Sans-Devanagari",
    ]);
  });

  it("catches a PARTIAL substitution that a forbidden-list would have let through", () => {
    // Both required faces ARE present - a required-faces check alone says pass. The
    // allowlist is what notices the third face, and it notices families nobody
    // enumerated: DejaVu Serif is the one that actually happened and the one no
    // denylist contained.
    const partial = Buffer.from(
      "/BaseFont /AAAAAA+Noto-Sans /BaseFont /BBBBBB+Noto-Sans-Devanagari " +
        "/BaseFont /CCCCCC+Liberation-Sans",
    );
    const result = checkFontContract(partial, CONTRACT);
    expect(result.missing).toEqual([]);
    expect(result.unexpected).toEqual(["Liberation-Sans"]);
  });

  it("permits every face in the family it asked for, including weights", () => {
    // A guard is only trustworthy once you have tested what it PERMITS: one that
    // rejects Noto-Sans-Bold blocks a legitimate render and gets deleted the first
    // time it does.
    const bold = Buffer.from(
      "/BaseFont /AAAAAA+Noto-Sans /BaseFont /BBBBBB+Noto-Sans-Bold " +
        "/BaseFont /CCCCCC+Noto-Sans-Devanagari",
    );
    expect(checkFontContract(bold, CONTRACT)).toEqual({ missing: [], unexpected: [] });
  });
});

describe("FontResolutionError", () => {
  it("names both failure kinds and carries constants only", () => {
    const err = new FontResolutionError("bb_trade", ["Noto-Sans-Devanagari"], ["DejaVu-Sans"]);
    expect(err.message).toContain("missing Noto-Sans-Devanagari");
    expect(err.message).toContain("unexpected DejaVu-Sans");
    expect(err.name).toBe("FontResolutionError");
  });
});
