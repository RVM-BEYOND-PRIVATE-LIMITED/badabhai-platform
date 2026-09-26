import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { looksLikeOrgName, looksLikePii, looksLikeUrl } from "@badabhai/validators";

import {
  MAX_RAW_SKILL_UNITS,
  MAX_SKILL_CHARS,
  MAX_SKILL_DIGITS,
  MAX_SKILL_WORDS,
  MAX_SKILLS,
  certifySkillLabel,
  certifySkills,
  skillKey,
  type SkillCertifyContext,
} from "./skill-certifier";

/**
 * THE API'S WALL FOR A MODEL-RETURNED SKILL (ADR-0045 §3.2).
 *
 * Every wall is pinned from BOTH sides — what it refuses and what it must let through — because
 * the permitted half is the half that keeps the wall alive: a certifier that refuses "C++" or
 * "ASP.NET" is a certifier somebody deletes, and then nothing checks for a phone number either.
 *
 * Every person, address and number below is synthetic.
 */

function ctx(overrides: Partial<SkillCertifyContext> = {}): SkillCertifyContext {
  return {
    workerText: "",
    held: [],
    roleLabel: null,
    domainLabel: null,
    ...overrides,
  };
}

/** A context whose message grounds exactly the given labels, word for word. */
function groundedCtx(labels: readonly string[], overrides: Partial<SkillCertifyContext> = {}) {
  return ctx({ workerText: labels.join(", "), ...overrides });
}

/**
 * Characters a review measured rendering as NOTHING while surviving the first INVISIBLE_RE
 * (`\p{Cf}\p{Cc}` only): "Call 98765<X>43210" showed as a plain phone number and was kept.
 */
const INVISIBLE_SPLITTERS: readonly (readonly [name: string, char: string])[] = [
  ["U+FE0F variation selector-16 (Mn)", "\uFE0F"],
  ["U+034F combining grapheme joiner (Mn)", "\u034F"],
  ["U+115F Hangul choseong filler (Lo)", "\u115F"],
  ["U+1160 Hangul jungseong filler (Lo)", "\u1160"],
  ["U+3164 Hangul filler (Lo)", "\u3164"],
  ["U+FFA0 halfwidth Hangul filler (Lo)", "\uFFA0"],
  ["U+17B4 Khmer vowel inherent AQ (Mn)", "\u17B4"],
  ["U+180B Mongolian free variation selector (Mn)", "\u180B"],
  ["U+2800 Braille pattern blank (So)", "\u2800"],
];

/** The review's realistic list: every one must certify, alone and grounded. */
const REALISTIC_SKILLS: readonly string[] = [
  "Python",
  "Java",
  "C++",
  "C#",
  ".NET",
  "ASP.NET",
  "Node.js",
  "React",
  "SQL",
  "MongoDB",
  "AWS",
  "Docker",
  "Figma",
  "Photoshop",
  "AutoCAD",
  "SketchUp",
  "3ds Max",
  "Revit",
  "Tally",
  "GST filing",
  "Excel",
  "A320",
  "Boeing 737",
  "IFR flying",
  "Night flying",
  "Tandoor",
  "Mughlai",
  "Chinese cuisine",
  "Bulk cooking",
  "Retail trading",
  "Wholesale trading",
  "Inventory management",
  "Customer handling",
  "Forklift driving",
  "Heavy vehicle driving",
];

describe("certifySkillLabel — 0. the raw ceiling, before any regex", () => {
  it("keeps a padded label at exactly MAX_RAW_SKILL_UNITS and refuses one unit more — never truncating", () => {
    const atCeiling = `Welding${" ".repeat(MAX_RAW_SKILL_UNITS - "Welding".length)}`;
    expect(atCeiling.length).toBe(MAX_RAW_SKILL_UNITS);
    expect(certifySkillLabel(atCeiling)).toBe("Welding");
    expect(certifySkillLabel(`${atCeiling} `)).toBeNull();
  });

  it("refuses a 50,000-character label in under 50 ms — the quadratic trim never runs", () => {
    // `a` + a long punctuation run + `b` is the trailing-punctuation regex's worst case: measured
    // at ~1.5 s per call without the ceiling. Two calls here, so an unguarded wall is ~3 s.
    const hostile = `a${".".repeat(50_000)}b`;
    const started = performance.now();
    expect(certifySkillLabel(hostile)).toBeNull();
    const result = certifySkills(["Tandoor", hostile], ctx({ workerText: "tandoor" }));
    const elapsed = performance.now() - started;
    expect(result).toEqual({ kept: ["Tandoor"], rejected: 1, capped: false });
    expect(elapsed).toBeLessThan(50);
  });
});

describe("certifySkillLabel — 1. cleaning", () => {
  it("strips leading bullets and numbering, collapses whitespace, trims trailing punctuation", () => {
    expect(certifySkillLabel("• Welding")).toBe("Welding");
    expect(certifySkillLabel("- TIG welding")).toBe("TIG welding");
    expect(certifySkillLabel("1. Pipe fitting")).toBe("Pipe fitting");
    expect(certifySkillLabel("2) Shuttering")).toBe("Shuttering");
    expect(certifySkillLabel("- 1. Bar bending")).toBe("Bar bending");
    expect(certifySkillLabel("  MS \t  Office.  ")).toBe("MS Office");
    expect(certifySkillLabel("Tandoor!?")).toBe("Tandoor");
  });

  it("applies NFKC and strips invisible characters", () => {
    expect(certifySkillLabel("ＡｕｔｏＣＡＤ")).toBe("AutoCAD");
    expect(certifySkillLabel("Auto\u200BCAD")).toBe("AutoCAD");
    expect(certifySkillLabel("\uFEFFPlastering\u00AD")).toBe("Plastering");
  });

  it.each(INVISIBLE_SPLITTERS)("strips %s, which renders as nothing", (_name, char) => {
    expect(certifySkillLabel(`Auto${char}CAD`)).toBe("AutoCAD");
  });

  it.each(INVISIBLE_SPLITTERS)("sees through %s to the generic word it splits", (_name, char) => {
    // Unstripped, each of these either survives normalisation as a mark or letter ("ha<U+034F>an") or
    // blanks into a space ("ha an") — and neither is the generic "haan" the wall refuses.
    expect(certifySkillLabel(`ha${char}an`)).toBeNull();
  });

  it("leaves Devanagari matras, the virama and the nukta alone", () => {
    for (const word of ["तंदूर", "वेल्डिंग", "सिलाई", "कढ़ाई"]) {
      const nfkc = word.normalize("NFKC");
      const certified = certifySkillLabel(word);
      expect(certified, word).toBe(nfkc);
      expect(certified?.match(/\p{M}/gu)?.length, word).toBe(nfkc.match(/\p{M}/gu)?.length);
    }
  });

  it("keeps a line break as a word boundary rather than fusing the words", () => {
    expect(certifySkillLabel("MS\nOffice")).toBe("MS Office");
  });

  it("leaves digits that are not numbering alone", () => {
    expect(certifySkillLabel("3ds Max")).toBe("3ds Max");
    expect(certifySkillLabel("2.5 ton crane")).toBe("2.5 ton crane");
  });

  it("refuses a candidate that cleans to nothing", () => {
    for (const empty of ["", "   ", "•", "- * >", "1. ", "...", "\u200B"]) {
      expect(certifySkillLabel(empty), JSON.stringify(empty)).toBeNull();
    }
  });
});

describe("certifySkillLabel — 2. length", () => {
  it("keeps a label at exactly the character and word limits", () => {
    const sixtyChars = `Welding ${"x".repeat(MAX_SKILL_CHARS - "Welding ".length)}`;
    expect([...sixtyChars].length).toBe(MAX_SKILL_CHARS);
    expect(certifySkillLabel(sixtyChars)).toBe(sixtyChars);
    expect(certifySkillLabel("Tally ERP 9 with GST billing")).toBe("Tally ERP 9 with GST billing");
    expect("Tally ERP 9 with GST billing".split(" ")).toHaveLength(MAX_SKILL_WORDS);
  });

  it("refuses one character or one word over, and never truncates", () => {
    expect(
      certifySkillLabel(`Welding ${"x".repeat(MAX_SKILL_CHARS - "Welding ".length + 1)}`),
    ).toBeNull();
    expect(certifySkillLabel("Tally ERP 9 with GST billing daily")).toBeNull();
  });

  it("counts code points, not UTF-16 units", () => {
    // U+20000 is an astral CJK letter (two UTF-16 units) that NFKC leaves alone: 30 of them is
    // 60 units but 30 code points.
    const astral = `Welding ${"\u{20000}".repeat(30)}`;
    expect(astral.length).toBeGreaterThan(MAX_SKILL_CHARS);
    expect([...astral].length).toBeLessThanOrEqual(MAX_SKILL_CHARS);
    expect(certifySkillLabel(astral)).toBe(astral);
  });
});

describe("certifySkillLabel — 3. placeholders", () => {
  it.each([
    "[PERSON_1]",
    "PERSON_1",
    "[person_1]",
    "[ PERSON_1 ]",
    "[PERSON 1]",
    "Welding at [EMPLOYER_2]",
    "[NAME]",
    "[Name]",
    "[Company Name]",
    "{{worker_name}}",
    "Welding {{",
    "General",
    "general",
    "सामान्य",
  ])("refuses %j", (placeholder) => {
    expect(certifySkillLabel(placeholder)).toBeNull();
  });

  it.each([
    "[PERSON1]",
    "[PERSON-1]",
    "[ PERSON 1 ]",
    "[EMPLOYER #1]",
    "<NAME>",
    "{worker}",
    "a > b",
  ])("refuses any bracket, brace or angle bracket: %j", (placeholder) => {
    expect(certifySkillLabel(placeholder)).toBeNull();
  });

  it.each(["PERSON 1", "EMPLOYER 1", "employer-2", "ID #3", "Name 1", "phone_4", "PERSON १"])(
    "refuses an unbracketed gateway prefix and number: %j",
    (placeholder) => {
      expect(certifySkillLabel(placeholder)).toBeNull();
    },
  );

  it("refuses a placeholder inside a grounded label", () => {
    const result = certifySkills(
      ["Tandoor", "Tandoor at [PERSON-1]'s dhaba"],
      ctx({ workerText: "tandoor chalata hoon" }),
    );
    expect(result).toEqual({ kept: ["Tandoor"], rejected: 1, capped: false });
  });

  it("does not refuse ordinary labels that merely resemble the shapes", () => {
    expect(certifySkillLabel("Python 3")).toBe("Python 3");
    expect(certifySkillLabel("General fitting")).toBe("General fitting");
    expect(certifySkillLabel("Welding (TIG)")).toBe("Welding (TIG)");
    expect(certifySkillLabel("Android 12")).toBe("Android 12");
    expect(certifySkillLabel("Class 10 maths")).toBe("Class 10 maths");
  });
});

describe("certifySkillLabel — 4. hard identifiers (shared fixture)", () => {
  interface Case {
    readonly text: string;
    readonly expected: string | null;
  }
  const FIXTURE = join(
    __dirname,
    "../../../../packages/ai-contracts/src/__fixtures__/hard-identifiers.cases.json",
  );
  const cases = (JSON.parse(readFileSync(FIXTURE, "utf8")) as { cases: Case[] }).cases;

  it("loads the fixture", () => {
    expect(cases.filter((c) => c.expected !== null).length).toBeGreaterThan(20);
  });

  it("refuses every case the fixture names as a hard identifier", () => {
    for (const c of cases.filter((entry) => entry.expected !== null)) {
      expect(certifySkillLabel(c.text), JSON.stringify(c.text)).toBeNull();
    }
  });

  it("refuses the permitted half ONLY where another named wall explains it", () => {
    // The fixture's permitted half exists to prove the hard-identifier wall does not over-fire.
    // Some of it is refused HERE for other reasons ("Tata Motors Ltd" is an organisation,
    // "1200000" is a PII-shaped digit run, "98765/43210" is over the digit budget, "" is empty)
    // — each such refusal must be explained by one of those walls, never by the hard-identifier
    // scanner alone. The digit budget and the trailing legal suffix are the certifier's OWN
    // walls, restated here from their documented rules rather than imported, so a change to
    // either rule has to be made twice to go unnoticed.
    const permitted = cases.filter((entry) => entry.expected === null);
    let passed = 0;
    for (const c of permitted) {
      const certified = certifySkillLabel(c.text);
      if (certified !== null) {
        passed++;
        continue;
      }
      const explained =
        c.text.trim().length === 0 ||
        !/\p{L}/u.test(c.text) ||
        looksLikePii(c.text) ||
        looksLikeOrgName(c.text) ||
        looksLikeUrl(c.text) ||
        (c.text.match(/\p{Nd}/gu)?.length ?? 0) > MAX_SKILL_DIGITS ||
        /\b(?:ltd|limited|llc|gmbh|pvt|inc|corp|llp)\W*$/iu.test(c.text);
      expect(explained, JSON.stringify(c.text)).toBe(true);
    }
    expect(passed).toBeGreaterThanOrEqual(10);
  });

  it("refuses an identifier split by an invisible character", () => {
    expect(certifySkillLabel("98765\u200B43210")).toBeNull();
  });
});

describe("certifySkillLabel — 4b. the digit budget", () => {
  it.each([
    "Call 98765*43210",
    "Call 98765:43210",
    "Call 98765~43210",
    "Call 98765=43210",
    "Call 98765 aur 43210",
    "Welding 98765/43210",
    "Aadhaar 1234/5678/9012",
    "1234/5678/9012",
  ])("refuses %j: ten or more digits, whatever separates them", (label) => {
    expect(certifySkillLabel(label)).toBeNull();
  });

  it.each(INVISIBLE_SPLITTERS)("refuses a phone split by %s", (_name, char) => {
    expect(certifySkillLabel(`Call 98765${char}43210`)).toBeNull();
  });

  it("refuses them end to end when the worker's own message grounds them", () => {
    const labels = ["Call 98765*43210", "Call 98765 aur 43210"];
    const result = certifySkills(["Tandoor", ...labels], groundedCtx(["tandoor", ...labels]));
    expect(result).toEqual({ kept: ["Tandoor"], rejected: 2, capped: false });
  });

  it("keeps a standard code at the budget", () => {
    expect(certifySkillLabel("ISO 9001:2015")).toBe("ISO 9001:2015"); // 8 digits
    expect(certifySkillLabel("IS 456:2000")).toBe("IS 456:2000"); // 7
    expect(certifySkillLabel("IATF 16949:2016")).toBe("IATF 16949:2016"); // 9 — the budget
    expect("IATF 16949:2016".match(/\d/gu)).toHaveLength(MAX_SKILL_DIGITS);
  });

  it("pins the known over-drop that is NOT the budget: a hyphened or spaced year is a 7+ digit run", () => {
    // `looksLikePii` strips "-" and spaces before counting a 7-digit run. Fail-closed, one bullet;
    // the colon form above is the one standards bodies print.
    expect(certifySkillLabel("ISO 9001-2015")).toBeNull();
    expect(certifySkillLabel("IS 456 2000")).toBeNull();
  });
});

describe("certifySkillLabel — 4c. the scan form: the digits of every script are digits", () => {
  it.each([
    ["Devanagari", "WhatsApp ९८७६५४३२१०"],
    ["Devanagari, grouped", "Aadhaar १२३४ ५६७८ ९०१२"],
    ["Arabic-Indic", "Call ٩٨٧٦٥٤٣٢١٠"],
    ["Extended Arabic-Indic", "Call ۹۸۷۶۵۴۳۲۱۰"],
    ["Tamil", "Call ௯௮௭௬௫௪௩௨௧௦"],
    ["Bengali", "Call ৯৮৭৬৫৪৩২১০"],
    ["Gujarati", "Call ૯૮૭૬૫૪૩૨૧૦"],
  ])("refuses a %s phone or Aadhaar", (_script, label) => {
    expect(certifySkillLabel(label)).toBeNull();
  });

  it("feeds the SHAPE walls the folded digits too, not only the digit count", () => {
    // Each is under the digit budget, so only a wall reading the scan form can refuse it.
    expect(certifySkillLabel("ABCDE१२३४F")).toBeNull(); // PAN
    expect(certifySkillLabel("Welding १२०००००")).toBeNull(); // a 7-digit run (looksLikePii)
    expect(certifySkillLabel("PERSON १")).toBeNull(); // a gateway placeholder
  });

  it("closes the voice-turn hole: no grounding AND unseen digits used to mean no wall at all", () => {
    const result = certifySkills(
      ["Tandoor", "WhatsApp ९८७६५४३२१०"],
      ctx({ workerText: "मैं तंदूर चलाता हूँ, व्हाट्सएप ९८७६५४३२१०" }),
    );
    expect(result).toEqual({ kept: ["Tandoor"], rejected: 1, capped: false });
  });

  it("reads the ORIGINAL form as well: folding must never be what lets an identifier through", () => {
    // Folded, "५" becomes "5" and glues to the PAN, erasing the word boundary every PAN pattern
    // needs. The original form still has it — so only reading both forms refuses this.
    expect(certifySkillLabel("५ABCDE1234F")).toBeNull();
  });

  it("shows the worker's own digits: the scan form is read, never returned", () => {
    expect(certifySkillLabel("Class १० maths")).toBe("Class १० maths");
    expect(certifySkillLabel("Boeing ७३७")).toBe("Boeing ७३७");
  });

  it("relies on a Unicode guarantee this engine honours: every Nd run is whole blocks of ten", () => {
    // The fold computes a digit's value as its distance from the start of its run, mod 10. That
    // is exact only if every maximal run of `\p{Nd}` is a whole number of 0-9 blocks — Unicode's
    // stability policy says it is; this checks the running engine's data agrees.
    const isDecimal = /^\p{Nd}$/u;
    const broken: string[] = [];
    let runStart = -1;
    for (let cp = 0; cp <= 0x110000; cp++) {
      const digit = cp <= 0x10ffff && isDecimal.test(String.fromCodePoint(cp));
      if (digit && runStart < 0) runStart = cp;
      if (!digit && runStart >= 0) {
        if ((cp - runStart) % 10 !== 0) broken.push(runStart.toString(16));
        runStart = -1;
      }
    }
    expect(broken).toEqual([]);
  });
});

describe("certifySkillLabel — 4d. PAN in any case and with separators", () => {
  it.each([
    "PAN abcde1234f",
    "PAN AbCdE1234F",
    "PAN ABCDE 1234 F",
    "PAN ABCDE-1234-F",
    "PAN ABCDE.1234.F",
    "PAN ABCDE - 1234 - F",
    "abcde1234f",
    "Pan card abcde1234f",
  ])("refuses %j", (label) => {
    expect(certifySkillLabel(label)).toBeNull();
  });

  it("refuses it end to end when the worker's own message grounds it", () => {
    const result = certifySkills(
      ["Tandoor", "PAN abcde1234f"],
      ctx({ workerText: "tandoor, mera pan abcde1234f hai" }),
    );
    expect(result).toEqual({ kept: ["Tandoor"], rejected: 1, capped: false });
  });

  it.each(["Excel 2019", "Revit 2020 MEP", "Excel 2016 VBA", "Tally ERP 9", "Canva 2024"])(
    "keeps the near miss %j",
    (label) => {
      expect(certifySkillLabel(label)).toBe(label);
    },
  );
});

describe("certifySkillLabel — 5. PII shapes", () => {
  it("refuses an email and a long digit run the hard-identifier wall permits", () => {
    expect(certifySkillLabel("ramesh@example.com")).toBeNull();
    expect(certifySkillLabel("9876543210")).toBeNull();
    // Seven digits: a salary to the hard-identifier wall, a PII shape to this one.
    expect(certifySkillLabel("Welding 1200000")).toBeNull();
  });

  it("keeps a label with a short number in it", () => {
    expect(certifySkillLabel("Boeing 737")).toBe("Boeing 737");
    expect(certifySkillLabel("ISO 9001")).toBe("ISO 9001");
  });
});

describe("certifySkillLabel — 6. URL shapes and the technology exemption", () => {
  it.each(["www.example.com", "example.com", "https://example", "shop.example.in", "foo.net"])(
    "refuses %j",
    (link) => {
      expect(certifySkillLabel(link)).toBeNull();
    },
  );

  it.each([".NET", "ASP.NET", "asp.net", "VB.NET", "ADO.NET", "B.Com", "M.Com", "ASP.NET MVC"])(
    "exempts the allow-listed name %j",
    (name) => {
      expect(certifySkillLabel(name)).toBe(name);
    },
  );

  it("exempts only the allow-listed token, not the rest of the label", () => {
    expect(certifySkillLabel("ASP.NET www.example.com")).toBeNull();
    expect(certifySkillLabel("www.asp.net")).toBeNull();
    expect(certifySkillLabel("b.com/anything")).toBeNull();
  });

  it("pins the known gaps: names the closed list does not carry are still refused", () => {
    expect(certifySkillLabel("Socket.io")).toBeNull();
    expect(certifySkillLabel("C#.NET")).toBeNull();
  });

  it("exempts an allow-listed name that carried a trailing full stop", () => {
    expect(certifySkillLabel("B.Com.")).toBe("B.Com");
  });
});

describe("certifySkillLabel — 6b. contact routes the URL shape does not know", () => {
  it.each([
    "UPI ramesh@okaxis",
    "ramesh@paytm",
    "Instagram @ramesh_cook",
    "ramesh@gmail",
    "ramesh @ gmail . com",
    "ramesh＠gmail",
  ])("refuses the at-sign in %j", (label) => {
    expect(certifySkillLabel(label)).toBeNull();
  });

  it.each(["ramesh at gmail dot com", "ramesh (at) gmail (dot) com", "Ramesh AT gmail DOT in"])(
    "refuses the spelled-out email %j",
    (label) => {
      expect(certifySkillLabel(label)).toBeNull();
    },
  );

  it.each([
    "t.me/ramesh_cook",
    "t.me/x",
    "bit.ly/x",
    "bit.ly/rameshcv",
    "linktr.ee/x",
    "linktr.ee/rameshcook",
    "example.tech/portfolio",
  ])("refuses the host-with-path %j", (label) => {
    expect(certifySkillLabel(label)).toBeNull();
  });

  it.each(["t.me", "rameshkitchen.dev", "ramesh.shop", "Cooking ramesh.site", "RAMESH.ONLINE"])(
    "refuses the short-link host %j",
    (label) => {
      expect(certifySkillLabel(label)).toBeNull();
    },
  );

  it("refuses them end to end when the worker's own message grounds them", () => {
    const labels = ["UPI ramesh@okaxis", "ramesh at gmail dot com", "bit.ly/rameshcv"];
    const result = certifySkills(["Tandoor", ...labels], groundedCtx(["tandoor", ...labels]));
    expect(result).toEqual({ kept: ["Tandoor"], rejected: 3, capped: false });
  });

  it.each([
    "Node.js",
    "Vue.js",
    "Next.js",
    "Express.js",
    "B.Tech",
    "B.Sc",
    "M.Sc",
    "D.Pharm",
    "Ph.D",
    "ASP.NET",
    ".NET",
    "UI/UX",
    "Welding at site",
  ])("keeps the technology name or trade phrase %j", (label) => {
    expect(certifySkillLabel(label)).toBe(label);
  });

  it("pins the known cost: a slash straight after a dotted name reads as a path", () => {
    expect(certifySkillLabel("Node.js/Express")).toBeNull();
    expect(certifySkillLabel("B.Tech/B.E")).toBeNull();
  });
});

describe("certifySkillLabel — 7. organisation names", () => {
  it.each(["Tata Motors Pvt Ltd", "Acme Industries LLP", "Sharma & Co", "Bharat Forge Limited"])(
    "refuses %j",
    (org) => {
      expect(certifySkillLabel(org)).toBeNull();
    },
  );

  it("refuses 'Co.' even though cleaning trims the dot the org wall keys on", () => {
    expect(certifySkillLabel("Sharma Co.")).toBeNull();
  });

  it("keeps trade text that only resembles an org suffix", () => {
    expect(certifySkillLabel("Coordination")).toBe("Coordination");
    // A legal word that LEADS is trade prose; the certifier's own wall reads the LAST word only.
    expect(certifySkillLabel("Limited slip differential")).toBe("Limited slip differential");
    expect(certifySkillLabel("Corporate accounting")).toBe("Corporate accounting");
    expect(certifySkillLabel("Zinc plating")).toBe("Zinc plating");
    expect(certifySkillLabel("Incoming inspection")).toBe("Incoming inspection");
  });

  it.each([
    "welding at tata motors ltd",
    "tata motors limited",
    "Sharma LLC",
    "Sharma GmbH",
    "sharma pvt",
    "sharma pvt. ltd.",
    "sharma private limited",
    "sharma llp",
    "शर्मा प्राइवेट लिमिटेड",
  ])("refuses the trailing legal suffix in %j, in any case", (org) => {
    expect(certifySkillLabel(org)).toBeNull();
  });

  it("refuses it end to end when the worker's own message grounds it", () => {
    const labels = ["welding at tata motors ltd", "Sharma GmbH"];
    const result = certifySkills(["Welding", ...labels], groundedCtx(labels));
    expect(result).toEqual({ kept: ["Welding"], rejected: 2, capped: false });
  });

  it("pins what the SHARED org wall refuses anywhere: company-law skills cost a bullet", () => {
    // Not the trailing-suffix wall — `looksLikeOrgName` matches `\bllp\b` and "pvt ltd" in any
    // position. Fail-closed: a company-secretary worker loses these bullets, never his privacy.
    expect(certifySkillLabel("LLP compliance")).toBeNull();
    expect(certifySkillLabel("Pvt Ltd incorporation")).toBeNull();
  });
});

describe("certifySkillLabel — 8. generic words", () => {
  it.each([
    "haan",
    "Haan.",
    "kaam",
    "Kuch nahi!",
    "Sab-kuch",
    "etc.",
    "Operator",
    "helper",
    "N/A",
    "हाँ",
    "नहीं",
  ])("refuses %j", (generic) => {
    expect(certifySkillLabel(generic)).toBeNull();
  });

  it("refuses a label that names nothing: no letter at all", () => {
    expect(certifySkillLabel("+++")).toBeNull();
    expect(certifySkillLabel("25000")).toBeNull();
    expect(certifySkillLabel("737")).toBeNull();
  });

  it("matches the WHOLE label only — a generic word inside a skill is fine", () => {
    expect(certifySkillLabel("Crane operator")).toBe("Crane operator");
    expect(certifySkillLabel("Tile ka kaam")).toBe("Tile ka kaam");
    expect(certifySkillLabel("Senior care")).toBe("Senior care");
  });
});

describe("certifySkillLabel — technology names that must pass", () => {
  it.each([
    "C++",
    "C#",
    ".NET",
    "ASP.NET",
    "Node.js",
    "3ds Max",
    "A320",
    "Boeing 737",
    "Tally ERP 9",
    "UI/UX",
    "MS Office",
    "React Native",
    "Night flying",
    "Tandoor",
  ])("keeps %j verbatim", (name) => {
    expect(certifySkillLabel(name)).toBe(name);
  });
});

describe("certifySkills — the realistic list certifies in full", () => {
  // The walls above are only worth keeping while the honest half passes them. This is the list
  // the review certified BEFORE the digit, contact, placeholder and legal-suffix walls went in.
  it.each(REALISTIC_SKILLS)("keeps %j verbatim", (label) => {
    expect(certifySkillLabel(label)).toBe(label);
  });

  it("refuses none of them when grounded, and stops at MAX_SKILLS", () => {
    expect(REALISTIC_SKILLS.length).toBeGreaterThan(MAX_SKILLS);
    const result = certifySkills(REALISTIC_SKILLS, groundedCtx(REALISTIC_SKILLS));
    expect(result).toEqual({
      kept: REALISTIC_SKILLS.slice(0, MAX_SKILLS),
      rejected: 0,
      capped: true,
    });
  });
});

describe("certifySkills — the role is not a skill", () => {
  it("refuses a candidate equal to the role or the domain, after normalisation", () => {
    const result = certifySkills(
      ["pilot", "Aviation.", "Night flying"],
      groundedCtx(["pilot", "aviation", "night flying"], {
        roleLabel: "Pilot",
        domainLabel: "Aviation",
      }),
    );
    expect(result.kept).toEqual(["Night flying"]);
    expect(result.rejected).toBe(2);
  });

  it("keeps a skill that merely contains the role word", () => {
    const result = certifySkills(
      ["Commercial pilot licence training"],
      groundedCtx(["commercial pilot licence training"], { roleLabel: "Pilot" }),
    );
    expect(result.kept).toEqual(["Commercial pilot licence training"]);
  });
});

describe("certifySkills — 9. grounding", () => {
  it("grounds a label that appears whole in the message", () => {
    const result = certifySkills(["AutoCAD"], ctx({ workerText: "autocad aur sketchup" }));
    expect(result).toEqual({ kept: ["AutoCAD"], rejected: 0, capped: false });
  });

  it("grounds on one shared evidential token", () => {
    const result = certifySkills(["MS Excel"], ctx({ workerText: "excel mein data entry" }));
    expect(result.kept).toEqual(["MS Excel"]);
  });

  it("grounds on a one-edit typo", () => {
    const result = certifySkills(["MS Excel"], ctx({ workerText: "exel chalata hoon" }));
    expect(result.kept).toEqual(["MS Excel"]);
  });

  it("does not ground a label the worker never mentioned", () => {
    const result = certifySkills(["Photoshop"], ctx({ workerText: "coreldraw" }));
    expect(result).toEqual({ kept: [], rejected: 1, capped: false });
  });

  it("does not ground on a stop word or a generic word", () => {
    const result = certifySkills(
      ["Tile ka kaam"],
      ctx({ workerText: "main painter ka kaam karta hoon" }),
    );
    expect(result).toEqual({ kept: [], rejected: 1, capped: false });
  });

  it("does not fuzzy-match a token that differs by a digit", () => {
    const result = certifySkills(["A321"], ctx({ workerText: "a320 udaata hoon" }));
    expect(result.rejected).toBe(1);
  });

  it("does not skip grounding for an empty message", () => {
    const result = certifySkills(["Welding"], ctx({ workerText: "" }));
    expect(result).toEqual({ kept: [], rejected: 1, capped: false });
  });

  it("SKIPS grounding for a message with no Latin letter — every other wall still applies", () => {
    const result = certifySkills(
      ["AutoCAD", "Photoshop", "9876543210", "haan"],
      ctx({ workerText: "मैं ऑटोकैड और फोटोशॉप चलाता हूँ" }),
    );
    expect(result.kept).toEqual(["AutoCAD", "Photoshop"]);
    expect(result.rejected).toBe(2);
  });

  it("grounds on the Latin tokens only once a single Latin letter appears", () => {
    const result = certifySkills(["CNC", "Fanuc"], ctx({ workerText: "मैं CNC चलाता हूँ, फानुक" }));
    expect(result.kept).toEqual(["CNC"]);
    expect(result.rejected).toBe(1);
  });

  it("grounds a label that normalises to one short token only by the whole-label match", () => {
    const heard = certifySkills(["C++"], ctx({ workerText: "c++ aur java" }));
    expect(heard.kept).toEqual(["C++"]);
    const unheard = certifySkills(["C++"], ctx({ workerText: "java aur python" }));
    expect(unheard.rejected).toBe(1);
  });
});

describe("skillKey — 10. identity", () => {
  it("merges case, punctuation and width: 'node js' is 'Node.js'", () => {
    expect(skillKey("node js")).toBe(skillKey("Node.js"));
    expect(skillKey("NODE.JS")).toBe(skillKey("Node.js"));
    expect(skillKey("ＵＩ/ＵＸ")).toBe(skillKey("UI UX"));
  });

  it("keeps C, C++ and C# apart", () => {
    const keys = new Set([skillKey("C"), skillKey("C++"), skillKey("C#")]);
    expect(keys.size).toBe(3);
  });

  it("uses the taxonomy id when the phrase is a reviewed alias", () => {
    expect(skillKey("stick welding")).toBe(skillKey("Arc welding"));
    expect(skillKey("stick welding").startsWith("n:")).toBe(false);
  });

  it("prefixes a phrase fallback so it can never collide with a taxonomy id", () => {
    expect(skillKey("Tandoor")).toBe("n:tandoor");
  });
});

describe("certifySkills — de-duplication", () => {
  it("drops a candidate already held, whatever its case or punctuation, without counting it", () => {
    const result = certifySkills(
      ["node js", "NODE.JS", "React Native"],
      ctx({ workerText: "node js aur react native", held: ["Node.js"] }),
    );
    expect(result).toEqual({ kept: ["React Native"], rejected: 0, capped: false });
  });

  it("drops a later spelling of a skill kept earlier in the same batch", () => {
    const result = certifySkills(
      ["AutoCAD", "autocad.", "Auto CAD"],
      ctx({ workerText: "autocad" }),
    );
    expect(result.kept).toEqual(["AutoCAD"]);
    expect(result.rejected).toBe(1); // "Auto CAD" is ungrounded, not a duplicate
  });

  it("drops a taxonomy synonym of a held skill", () => {
    const result = certifySkills(
      ["stick welding"],
      ctx({ workerText: "stick welding", held: ["Arc welding"] }),
    );
    expect(result).toEqual({ kept: [], rejected: 0, capped: false });
  });

  it("keeps kept skills in input order", () => {
    const labels = ["Tandoor", "Night flying", "MS Office"];
    expect(certifySkills(labels, groundedCtx(labels)).kept).toEqual(labels);
  });

  it("does not mutate its inputs", () => {
    const candidates = Object.freeze(["Tandoor", "haan"]);
    const held = Object.freeze(["Welding"]);
    const result = certifySkills(candidates, ctx({ workerText: "tandoor", held }));
    expect(result.kept).toEqual(["Tandoor"]);
    expect(held).toEqual(["Welding"]);
  });
});

describe("certifySkills — 11. the cap", () => {
  const heldOf = (n: number): string[] => Array.from({ length: n }, (_, i) => `Held skill ${i}`);

  it("stops at MAX_SKILLS total and reports capped", () => {
    const candidates = ["Tandoor", "Night flying", "MS Office", "React Native"];
    const result = certifySkills(
      candidates,
      groundedCtx(candidates, { held: heldOf(MAX_SKILLS - 2) }),
    );
    expect(result.kept).toEqual(["Tandoor", "Night flying"]);
    expect(result.capped).toBe(true);
    expect(result.rejected).toBe(0);
  });

  it("is not capped when exactly the room left is filled", () => {
    const candidates = ["Tandoor", "Night flying"];
    const result = certifySkills(
      candidates,
      groundedCtx(candidates, { held: heldOf(MAX_SKILLS - 2) }),
    );
    expect(result).toEqual({ kept: candidates, rejected: 0, capped: false });
  });

  it("is not capped when only refused candidates or duplicates were left out", () => {
    const held = heldOf(MAX_SKILLS);
    const result = certifySkills(
      ["haan", "Held skill 3", "9876543210"],
      ctx({ workerText: "haan held skill 3", held }),
    );
    expect(result).toEqual({ kept: [], rejected: 2, capped: false });
  });

  it("still runs every wall past the cap, so rejected does not depend on order", () => {
    const candidates = ["Tandoor", "Night flying", "haan", "Photoshop"];
    const result = certifySkills(
      candidates,
      ctx({ workerText: "tandoor, night flying", held: heldOf(MAX_SKILLS - 1) }),
    );
    expect(result.kept).toEqual(["Tandoor"]);
    expect(result.capped).toBe(true);
    expect(result.rejected).toBe(2); // "haan" (generic) and "Photoshop" (ungrounded)
  });
});

describe("certifySkills — counting", () => {
  it("counts refusals and excludes duplicates from them", () => {
    const result = certifySkills(
      [
        "Tandoor",
        "tandoor",
        "Tata Motors Pvt Ltd",
        "ramesh@example.com",
        "9876543210",
        "www.example.com",
        "haan",
        "kaam",
        "[PERSON_1]",
        "Chef",
      ],
      ctx({ workerText: "tandoor chalata hoon", held: ["Welding"], roleLabel: "Chef" }),
    );
    expect(result).toEqual({ kept: ["Tandoor"], rejected: 8, capped: false });
  });
});
