import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { checkFontContract, embeddedFontFaces } from "../common/pdf/font-resolution";
import { RESUME_FONT_CONTRACT, RESUME_FONT_PROBE_HTML, RESUME_FONT_STACK } from "./resume-fonts";

const TEMPLATE = readFileSync(join(__dirname, "templates", "bb_trade.v1.html"), "utf8");
const FIXTURES = join(__dirname, "__fixtures__", "font-probe");

/**
 * The probe is only evidence about the SHEET if it renders through the sheet's own
 * font stack and exercises the sheet's own scripts. Every assertion here exists to
 * stop the probe drifting into measuring something adjacent and reporting it as the
 * sheet - which is the shape of every silent-verification failure this track has
 * collected so far.
 */
describe("the probe measures the stack the sheet actually declares", () => {
  it("matches bb_trade.v1's body font-family character for character", () => {
    expect(TEMPLATE).toContain(`font-family: ${RESUME_FONT_STACK};`);
  });

  it("renders both scripts the sheet prints", () => {
    // Latin for the name and the body; Devanagari for `.deva`, the worker's own name
    // line. A face that resolves for one says nothing about the other: the shipped
    // image once had Latin and no Devanagari at all.
    expect(RESUME_FONT_PROBE_HTML).toMatch(/[A-Za-z]/);
    expect(RESUME_FONT_PROBE_HTML).toMatch(/[ऀ-ॿ]/);
  });

  it("carries no worker data - the probe is fixed strings only", () => {
    // It runs on every cold render and its output is checked in as a fixture, so it
    // must never be able to carry a name, a phone or an employer into either.
    expect(RESUME_FONT_PROBE_HTML).not.toContain("{{");
    expect(RESUME_FONT_PROBE_HTML.length).toBeLessThan(400);
  });
});

describe("the checked-in fixtures still describe THIS probe", () => {
  it("was rendered from the exact probe HTML the contract ships", () => {
    // The three PDFs are the negative evidence the guard rests on. Edit the probe
    // without re-rendering them and they become bytes from a document that no longer
    // exists, still passing.
    const rendered = readFileSync(join(FIXTURES, "probe.html"), "utf8");
    expect(rendered).toBe(RESUME_FONT_PROBE_HTML);
  });

  it("shows the shipped image satisfying its own contract", () => {
    const full = readFileSync(join(FIXTURES, "full-fonts.pdf"));
    expect(checkFontContract(full, RESUME_FONT_CONTRACT)).toEqual({
      missing: [],
      unexpected: [],
    });
    expect(embeddedFontFaces(full)).toContain("Noto-Sans-Devanagari");
  });

  it("shows both degraded images failing it", () => {
    for (const name of ["no-noto", "no-sans"]) {
      const result = checkFontContract(
        readFileSync(join(FIXTURES, `${name}.pdf`)),
        RESUME_FONT_CONTRACT,
      );
      expect(result.missing.length + result.unexpected.length).toBeGreaterThan(0);
    }
  });
});

describe("the contract is the two faces a MEASURED failure produced", () => {
  it("requires the Latin family and the Devanagari family, and nothing more", () => {
    // Not a wish-list. Each entry maps to a container that rendered a wrong sheet at
    // exit 0; bold is deliberately absent because a synthesised bold is a small
    // visual regression, and every extra requirement is one more way for a font
    // UPGRADE to refuse a resume that would have been fine.
    expect([...RESUME_FONT_CONTRACT.requiredFaces]).toEqual(["Noto-Sans", "Noto-Sans-Devanagari"]);
    expect([...RESUME_FONT_CONTRACT.allowedFamilyPrefixes]).toEqual(["Noto-Sans"]);
  });
});
