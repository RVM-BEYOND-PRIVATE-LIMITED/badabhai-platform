import { describe, expect, it } from "vitest";

import {
  SAMPLE_LINE_MAX_CHARS,
  carriesIdentifier,
  maskSampleLine,
  nameSubTokens,
  normaliseForMask,
  type MaskedLine,
} from "./free-chat-probe.mask";

/**
 * ADR-0051 §10, owner ruling R29 — the probe's mask: a whole masked line, or nothing. Every line
 * and every name below is FABRICATED. The security review's reproduced fail-open rows (H1, M1), the
 * widened name cues (M2) and the scanner gaps (L1) are each a row here.
 */

const NAME = "Suresh Kumar";
const ZWSP = "​";
const SOFT_HYPHEN = "­";

const shown = (text: string): MaskedLine => ({ kind: "shown", text });
const dropped = (reason: Extract<MaskedLine, { kind: "dropped" }>["reason"]): MaskedLine => ({
  kind: "dropped",
  reason,
});

/** A line is SAFE when it is dropped, or shown with no token of the name left in it. */
function expectSafe(line: string, name: string, forbidden: readonly string[]): MaskedLine {
  const out = maskSampleLine(line, name);
  if (out.kind === "shown") {
    for (const token of forbidden)
      expect(out.text.toLowerCase()).not.toContain(token.toLowerCase());
  }
  return out;
}

describe("the worker's own name is masked", () => {
  it("replaces it case-insensitively with [NAME]", () => {
    expect(maskSampleLine("suresh bol raha hoon, kaam chahiye", NAME)).toEqual(
      shown("[NAME] bol raha hoon, kaam chahiye"),
    );
    expect(maskSampleLine("Suresh Kumar yahan", NAME)).toEqual(shown("[NAME] yahan"));
  });

  it("prints a bot line's stored {{worker_name}} placeholder as [NAME]", () => {
    expect(maskSampleLine("{{worker_name}} ji, aap kya kaam karte ho?", NAME)).toEqual(
      shown("[NAME] ji, aap kya kaam karte ho?"),
    );
  });
});

describe("H1 — names the shared redaction misses are masked fully or dropped (security review rows)", () => {
  it.each([
    ["K.Suresh", "main Suresh hoon, fitter", ["suresh"]],
    ["R.K.Ramesh", "Ramesh bol raha", ["ramesh"]],
    ["Ram-Prasad", "Ram Prasad bol raha hoon", ["ram", "prasad"]],
    ["Anil D'Souza", "main Anil Souza", ["anil", "souza"]],
    ["Mohd. Salim", "main Mohd Salim hoon", ["mohd", "salim"]],
    [`Suresh${ZWSP} Kumar`, "main Suresh hoon", ["suresh"]],
    [`Sur${SOFT_HYPHEN}esh Kumar`, "main Suresh hoon", ["suresh"]],
  ])("stored %j, line %j", (name, line, forbidden) => {
    expectSafe(line, name, forbidden);
  });

  it("masks these rows FULLY rather than merely dropping them", () => {
    expect(maskSampleLine("main Suresh hoon, fitter", "K.Suresh")).toEqual(
      shown("main [NAME] hoon, fitter"),
    );
    expect(maskSampleLine("Ram Prasad bol raha hoon", "Ram-Prasad")).toEqual(
      shown("[NAME] bol raha hoon"),
    );
    expect(maskSampleLine("main Suresh hoon", `Sur${SOFT_HYPHEN}esh Kumar`)).toEqual(
      shown("main [NAME] hoon"),
    );
  });

  it("matches a name stored precomposed (U+095B) against one typed decomposed (ज + nukta)", () => {
    const stored = "ज़ाकिर खान"; // ज़ाकिर खान, precomposed
    const typed = "main ज़ाकिर hoon"; // ज + U+093C
    expect(stored).not.toContain("ज़"); // the two spellings really differ as stored
    const out = expectSafe(typed, stored, [normaliseForMask("ज़ाकिर")]);
    expect(out).toEqual(shown("main [NAME] hoon"));
  });

  it("splits a stored name into sub-tokens on anything not a letter, mark or digit", () => {
    expect(nameSubTokens("Anil D'Souza")).toEqual(["Anil", "D", "Souza"]);
    expect(nameSubTokens(`R.K.Ramesh`)).toEqual(["R", "K", "Ramesh"]);
    expect(nameSubTokens(`Sur${SOFT_HYPHEN}esh${ZWSP}  Kumar`)).toEqual(["Suresh", "Kumar"]);
  });
});

describe("name tokens found in text — dropped, fail closed", () => {
  it("drops a line where a 3+ letter name token survives glued to another word", () => {
    expect(maskSampleLine("main sureshbhai hoon", NAME)).toEqual(dropped("name_tokens_found"));
  });

  it("masks the whole name glued together — the shared redaction reads it since #2166", () => {
    expect(maskSampleLine("main sureshkumar hoon", NAME)).toEqual(shown("main [NAME] hoon"));
  });

  it("a TWO-letter name token as a whole word (M1) is masked — the redaction's short rule (#2166)", () => {
    expect(maskSampleLine("main Om hoon, welder", "Om Prakash")).toEqual(
      shown("main [NAME] hoon, welder"),
    );
    // …but not where those two letters are only part of a word.
    expect(maskSampleLine("roz kaam karta hoon", "Om Prakash")).toEqual(
      shown("roz kaam karta hoon"),
    );
  });

  it("masks an apostrophe-joined surname typed without its apostrophe (the stored name is passed)", () => {
    expect(maskSampleLine("DSouza sahab se baat hui", "Anil D'Souza")).toEqual(
      shown("[NAME] sahab se baat hui"),
    );
  });
});

describe("M2 — name cues drop the line", () => {
  it.each([
    "mera naam Ramesh hai",
    "Name: Mahesh",
    "mere bhai ka nam raju hai",
    "naam - Dinesh",
    "my name's Ramesh",
    "naam 'Ramesh'",
    "naam (Ramesh)",
    "naam 1 Ramesh",
    "mera naaam Ramesh",
    "भाई का नाम राजू है",
    "माझं नाव रमेश आहे",
    "আমার নাম রমেশ",
    "ਮੇਰਾ ਨਾਮ ਰਮੇਸ਼",
    "ਮੇਰਾ ਨਾਂ ਰਮੇਸ਼",
    "મારું નામ રમેશ",
    "என் பெயர் ரமேஷ்",
    "en peyar Ramesh",
    "నా పేరు రమేష్",
    "naa peru Ramesh",
    "ನನ್ನ ಹೆಸರು ರಮೇಶ್",
    "nanna hesaru Ramesh",
    "എന്റെ പേര് രമേഷ്",
    "میرا نام رمیش ہے",
    "maza nav Ramesh",
  ])("%j", (line) => {
    expect(maskSampleLine(line, NAME)).toEqual(dropped("name_cue"));
  });

  it("does not read a cue inside another word, or a cue with nothing after it", () => {
    for (const line of ["namaste bhai", "Naman ki dukaan", "username bhool gaya", "aapka naam?"]) {
      expect(maskSampleLine(line, NAME).kind).toBe("shown");
    }
  });
});

describe("identifiers drop the line", () => {
  it.each([
    "mera number 9876543210 hai",
    "mera number ९८७६५४३२१० hai",
    "aadhaar 2345 6789 0123",
    "mail karo test.worker@example.com",
    `98765${ZWSP}43210 pe call karo`,
    // L1 — separators the scanners do not join, a lower-case PAN, an address with no TLD.
    "call 98765/43210",
    "9876 / 543210",
    "pan abcde1234f hai",
    "suresh123@gmail",
    "id 123-456-789",
  ])("%j", (line) => {
    expect(maskSampleLine(line, NAME)).toEqual(dropped("identifier"));
  });

  it("drops a line with a control character — the scanner's refusal counts as a hit", () => {
    expect(maskSampleLine("kaam \u001b[31mchahiye", NAME)).toEqual(dropped("identifier"));
  });

  it("drops a line with nine or more digits in total, however they are spread", () => {
    expect(carriesIdentifier("12 34 56 78 9", normaliseForMask("12 34 56 78 9"))).toBe(true);
    expect(carriesIdentifier("5 saal, 12000 tankhwah", "5 saal, 12000 tankhwah")).toBe(false);
  });

  it("checks identifiers BEFORE the name, so an unreadable name never hides why", () => {
    expect(maskSampleLine("9876543210", null)).toEqual(dropped("identifier"));
  });
});

describe("an unreadable name drops every line", () => {
  it.each([null, "", "   ", "Om Ji", `${ZWSP}${SOFT_HYPHEN}`, "98765 43210", "R2 D2"])(
    "name %j",
    (name) => {
      expect(maskSampleLine("kaam chahiye", name)).toEqual(dropped("name_unreadable"));
    },
  );
});

describe("L1 — compatibility forms and invisible characters, on the stored AND the typed side", () => {
  const CGJ = "͏"; // combining grapheme joiner — default-ignorable, not Cf
  const VS16 = "️"; // variation selector-16
  const HANGUL_FILLER = "ㅤ"; // NFKC turns it into U+1160, itself default-ignorable
  const CHOSEONG_FILLER = "ᅟ";
  const disguised: readonly [string, string][] = [
    ["fullwidth", "Ｓｕｒｅｓｈ"],
    ["math bold", "𝐒𝐮𝐫𝐞𝐬𝐡"],
    ["U+034F", `Sur${CGJ}esh`],
    ["U+FE0F", `Sur${VS16}esh`],
    ["U+3164", `Sur${HANGUL_FILLER}esh`],
    ["U+115F", `Sur${CHOSEONG_FILLER}esh`],
  ];

  it.each(disguised)("stored %s name, typed plainly: masked", (_, stored) => {
    expect(maskSampleLine("main Suresh hoon", `${stored} Kumar`)).toEqual(
      shown("main [NAME] hoon"),
    );
  });

  it.each(disguised)("stored plainly, typed as %s: masked", (_, typed) => {
    expect(maskSampleLine(`main ${typed} hoon`, NAME)).toEqual(shown("main [NAME] hoon"));
  });
});

describe("spelling variants that differ only in combining marks (final review L2)", () => {
  const ZAKIR = "ज़ाकिर"; // ज़ाकिर, the nukta precomposed
  const ZAR = "ज़र"; // ज़र
  const OM_VIRAMA = "ओम्"; // ओम्
  const TAMIL_OM = "ஓம்"; // ஓம்

  it.each([
    [OM_VIRAMA, "main ओम hoon"], // typed without the virama
    [TAMIL_OM, "main ஓம hoon"], // typed without the pulli
  ])("stored %j, typed without the mark (%j): dropped", (stored, line) => {
    expect(maskSampleLine(line, stored)).toEqual(dropped("name_tokens_found"));
  });

  it.each([
    [`${ZAKIR} खान`, "main जाकिर hoon"], // typed without the nukta
    // ज़र folds to the two letters जर: the redaction masks it as a WHOLE word only (#2166 review).
    [ZAR, "main जर hoon"], // typed without the nukta
  ])(
    "stored %j, typed without the NUKTA (%j): masked — the redaction folds it (#2166)",
    (stored, line) => {
      expect(maskSampleLine(line, stored)).toEqual(shown("main [NAME] hoon"));
    },
  );

  it("a stored ज़र does not mask जरा — and the probe's mark-stripped check drops that line", () => {
    // The redaction leaves "जरा" alone (a whole-word rule, #2166 review), so nothing is masked; the
    // probe's stricter second pass strips the vowel sign, finds the two letters जर as a word, and
    // drops the line — a false drop costs a line, never a name.
    expect(maskSampleLine("\u091C\u0930\u093E \u0930\u0941\u0915\u094B", ZAR)).toEqual(
      dropped("name_tokens_found"),
    );
  });

  it("still masks the exact spelling to [NAME], as before", () => {
    expect(maskSampleLine(`main ${OM_VIRAMA} hoon`, OM_VIRAMA)).toEqual(shown("main [NAME] hoon"));
    expect(maskSampleLine(`main ${TAMIL_OM} hoon`, TAMIL_OM)).toEqual(shown("main [NAME] hoon"));
    expect(maskSampleLine(`main ${ZAKIR} hoon`, `${ZAKIR} खान`)).toEqual(shown("main [NAME] hoon"));
  });

  it("still shows ordinary lines for those workers — the stripped check is no blanket drop", () => {
    expect(maskSampleLine("कमरा साफ़ है", OM_VIRAMA).kind).toBe("shown");
    expect(maskSampleLine("जल्दी काम चाहिए", `${ZAKIR} खान`).kind).toBe("shown");
    expect(maskSampleLine("roz kaam karta hoon", OM_VIRAMA).kind).toBe("shown");
  });
});

describe("L2 — the stored name splits on digits and modifier letters; a token needs 3+ letters", () => {
  it.each([
    ["Raju007", "main Raju bol raha", ["raju"]],
    ["Suresh2 Kumar", "Suresh2 bol raha, Kumar bhi", ["suresh", "kumar"]],
    ["Anil DʼSouza", "main Anil Souza", ["anil", "souza"]], // U+02BC, a modifier letter
  ])("stored %j, line %j: masked or dropped", (stored, line, forbidden) => {
    expectSafe(line, stored, forbidden);
  });

  it("splits as specified", () => {
    expect(nameSubTokens("Raju007")).toEqual(["Raju"]);
    expect(nameSubTokens("Suresh2 Kumar")).toEqual(["Suresh", "Kumar"]);
    expect(nameSubTokens("Anil DʼSouza")).toEqual(["Anil", "D", "Souza"]);
    expect(nameSubTokens("98765 43210")).toEqual([]);
  });

  it("masks Raju007's lines fully", () => {
    expect(maskSampleLine("main Raju bol raha", "Raju007")).toEqual(shown("main [NAME] bol raha"));
  });

  it("drops every line of a worker whose stored 'name' is a phone number", () => {
    expect(maskSampleLine("kaam chahiye", "98765 43210")).toEqual(dropped("name_unreadable"));
  });
});

describe("L3 — a PAN split by separators", () => {
  it.each(["mera pan ABCDE 1234 F hai", "abcde 1234 f", "pan ABCDE-1234-F", "pan abcde/1234/f"])(
    "%j",
    (line) => {
      expect(maskSampleLine(line, NAME)).toEqual(dropped("identifier"));
    },
  );

  it("does not read ordinary words and a small number as a PAN", () => {
    expect(maskSampleLine("5 saal kaam kiya", NAME)).toEqual(shown("5 saal kaam kiya"));
  });
});

describe("L4 — more name-cue words, and cues split by invisible characters", () => {
  it.each([
    "mera naav Ramesh",
    "माझे नांव रमेश",
    "माझे रमेश",
    "என் பேர் ரமேஷ்",
    "nanna hesru Ramesh",
    "naa peyru Ramesh",
    "en per Ramesh",
    "என் per Ramesh",
    `naam${ZWSP}Ramesh`,
    `na${ZWSP}am Ramesh`,
    `name${SOFT_HYPHEN}Ramesh`,
  ])("%j", (line) => {
    expect(maskSampleLine(line, NAME)).toEqual(dropped("name_cue"));
  });

  it("reads `per` as a cue ONLY after en/என் — never 'per day'", () => {
    expect(maskSampleLine("500 rupaye per day", NAME)).toEqual(shown("500 rupaye per day"));
    expect(maskSampleLine("open per click", NAME).kind).toBe("shown");
  });
});

describe("what a shown line looks like", () => {
  it("collapses whitespace and strips format characters", () => {
    expect(maskSampleLine("kaam\u200D  chahiye\n\nabhi\u202E", NAME)).toEqual(
      shown("kaam chahiye abhi"),
    );
  });

  it("is cut AFTER masking, so a cut never exposes part of the name", () => {
    const long = maskSampleLine(`${"a".repeat(SAMPLE_LINE_MAX_CHARS - 3)} Suresh`, NAME);
    const text = long.kind === "shown" ? long.text : "";
    expect(Array.from(text)).toHaveLength(SAMPLE_LINE_MAX_CHARS);
    expect(text.endsWith("…")).toBe(true);
    expect(text).not.toMatch(/sur/i);
  });
});
