import { describe, expect, it } from "vitest";
import {
  CHIP_DROP_REASON,
  screenCareerAnswer,
  validateCareerAnswer,
} from "./career-output.validator";

const answer = (lines: string[], chips: string[] = []) => ({ lines, followup_chips: chips });
/** One line, no chips — the shape most of the tables below need. */
const line = (text: string) => validateCareerAnswer(answer([text]));

describe("validateCareerAnswer (ADR-0046 P3 §2) — every check rejects its own fixture", () => {
  it("a clean answer passes: Latin Hinglish, short, no money, no names", () => {
    expect(
      validateCareerAnswer(
        answer(
          ["Pehle welding ka certificate kariye.", "Phir 6G test ki tayari kariye."],
          // One "?" is the whole answer's budget, and the chips share it with the lines.
          ["Course kahan milega", "Kitna time lagega?"],
        ),
      ),
    ).toBeNull();
  });

  it("shape: no lines, too many lines, empty lines", () => {
    expect(validateCareerAnswer(answer([]))).toBe("no_lines");
    expect(validateCareerAnswer(answer(["a", "b", "c", "d", "e"]))).toBe("too_many_lines");
    expect(validateCareerAnswer(answer(["ok", "   "]))).toBe("empty_line");
  });

  it("length: a line over twenty words, a chip over four", () => {
    expect(validateCareerAnswer(answer([Array(21).fill("kaam").join(" ")]))).toBe("line_too_long");
    expect(validateCareerAnswer(answer(["line ok"], ["yeh chip bahut lamba hai ji"]))).toBe(
      "chip_too_long",
    );
  });

  it("punctuation: no exclamation, at most one question mark", () => {
    expect(validateCareerAnswer(answer(["Yeh kaam kariye!"]))).toBe("exclamation");
    expect(validateCareerAnswer(answer(["Kyun?", "Kaise?"]))).toBe("too_many_questions");
    // One question mark across lines AND chips is the budget, so two spread out still fail.
    expect(validateCareerAnswer(answer(["Theek hai?"], ["Aur?"]))).toBe("too_many_questions");
    // The fullwidth forms are the same marks to a reader, so they spend the same budget.
    expect(validateCareerAnswer(answer(["Yeh kaam kariye！"]))).toBe("exclamation");
    expect(validateCareerAnswer(answer(["Kyun？", "Kaise?"]))).toBe("too_many_questions");
  });

  it("persona: the v3.2 scan rejects banned tokens — including the vocative rule (R8)", () => {
    // "bhai" is a banned vocative; "pakka" is a banned promise the persona corpus carries.
    expect(validateCareerAnswer(answer(["Suniye bhai, aise kariye."]))).toBe("persona");
  });

  it("promise: guarantee words fail however phrased", () => {
    expect(validateCareerAnswer(answer(["Job pakka milegi."]))).toBe("promise");
    expect(validateCareerAnswer(answer(["Yeh 100% ho jayega."]))).toBe("promise");
    expect(validateCareerAnswer(answer(["Zaroor milegi, tension na lo."]))).toBe("promise");
  });

  it("sensitive advice: legal / medical / financial terms", () => {
    expect(validateCareerAnswer(answer(["Court ka case vakil se ladiye."]))).toBe(
      "sensitive_advice",
    );
    expect(validateCareerAnswer(answer(["Bank se loan le lijiye."]))).toBe("sensitive_advice");
    expect(validateCareerAnswer(answer(["Bima karwa lijiye."]))).toBe("sensitive_advice");
  });

  /**
   * TD147(2), 2026-10-05: `case`, `policy` and `doctor` were removed from SENSITIVE because
   * they over-blocked ordinary Hinglish. Each narrowed word gets BOTH a must-pass and a
   * must-still-refuse fixture, so the narrowing cannot silently disable the topic.
   */
  describe("sensitive advice, narrowed (TD147(2))", () => {
    it.each([
      ["is case me", "Is case me pehle practice kariye."],
      ["safety policy", "Safety policy yaad rakhiye, helmet pehniye."],
      ["doctor ko dikhaiye", "Chot lage to doctor ko dikhaiye."],
    ])("%s passes — the word alone is ordinary Hinglish", (_why, text) => {
      expect(validateCareerAnswer(answer([text]))).toBeNull();
    });

    it.each([
      ["court", "Court se salah lijiye."],
      ["vakil", "Vakil se baat kariye."],
      ["lawyer", "Lawyer se poochiye."],
      ["kanoon", "Kanoon ka mamla hai."],
      ["dawai", "Dawai wahi lijiye jo doctor de."],
      ["dawa", "Dawa ka kaam medical ka hai."],
      ["ilaaj", "Ilaaj ke liye aspatal jaiye."],
      ["ilaj", "Ilaj ka paisa insurance se."],
      ["loan", "Bank se loan le lijiye."],
      ["emi", "EMI kam karwaiye."],
      ["insurance", "Insurance karwa lijiye."],
      ["bima", "Bima karwa lijiye."],
      ["invest", "Invest karna samajhdari hai."],
      ["share market", "Share market se paisa banao."],
      ["sip", "SIP shuru kar dijiye."],
      ["fd", "FD karwa lijiye."],
      ["rd", "RD ka rate sasta hai."],
    ])("%s still refuses — the unambiguous term is untouched", (_word, text) => {
      expect(validateCareerAnswer(answer([text]))).toBe("sensitive_advice");
    });

    it("the removed words do not weaken 'court case' or 'insurance policy'", () => {
      // "case" and "policy" are gone as bare words, but the legal/insurance words beside them
      // still refuse the line.
      expect(validateCareerAnswer(answer(["Court case mein vakil se miliye."]))).toBe(
        "sensitive_advice",
      );
      expect(validateCareerAnswer(answer(["Insurance policy le lijiye."]))).toBe(
        "sensitive_advice",
      );
    });
  });

  it("rating: comparing or scoring the worker", () => {
    expect(validateCareerAnswer(answer(["Aap achhe ho."]))).toBe("worker_rating");
    expect(validateCareerAnswer(answer(["Aapka score 8 out of 10 hai."]))).toBe("worker_rating");
    expect(validateCareerAnswer(answer(["Aapki rank badh jayegi."]))).toBe("worker_rating");
  });

  it("named employer: the platform's legal-entity heuristic", () => {
    expect(validateCareerAnswer(answer(["Sharma Engineering Pvt Ltd me jaiye."]))).toBe(
      "named_employer",
    );
  });

  // #1927: a bare "Ltd"/"Limited" with the sentence going on after it used to be SERVED — the
  // shared heuristic read the bare suffix only at the end. This is the one org check on this
  // gate, and the model writes whole sentences, so the mid-sentence form is the one it produces.
  it.each([
    ["a line", answer(["Tata Steel Ltd mein apply kariye."])],
    ["a line", answer(["Tata Steel Limited mein apply kariye."])],
    ["a line, any case", answer(["TATA STEEL LTD mein try kariye."])],
    ["a chip", answer(["Pehle welding ka certificate kariye."], ["Bharat Forge Ltd mein"])],
    // "Ltd" glued to "pvt", which the strong "pvt ltd" marker needs a space for
    ["a line, glued pvt", answer(["Sharma Engg Pvt.Ltd company mein apply kariye."])],
    ["a chip, glued pvt", answer(["Pehle welding ka certificate kariye."], ["Sharma PvtLtd mein"])],
    // a quoted name: the closing quote is the name's last character
    ["a line, quoted name", answer(["“Tata Steel” Limited mein apply kariye."])],
    ["a chip, quoted name", answer(["Pehle welding ka certificate kariye."], ['"Tata Steel" Ltd'])],
  ])("named employer: a bare suffix mid-sentence in %s (#1927)", (_where, a) => {
    expect(validateCareerAnswer(a)).toBe("named_employer");
  });

  it("named employer: 'limited' as a word is still served (#1927)", () => {
    expect(line("Experience limited hai to pehle apprenticeship kariye.")).toBeNull();
    expect(line("Kisi achhi Ltd company mein apprenticeship kariye.")).toBeNull();
  });

  // The stated price of the shared heuristic's "Ltd" skip list (#1927): a firm followed by a
  // listed noun — experience / posts / hours / company … — reads as "ltd" for "limited".
  it("KNOWN RESIDUAL: '<Firm> Ltd experience' is served (#1927)", () => {
    expect(line("Aapka Tata Motors Ltd experience kaam aayega.")).toBeNull();
  });

  it("PII: an email or a phone-shaped run", () => {
    expect(validateCareerAnswer(answer(["Mail kariye ramesh@example.com par."]))).toBe("pii");
    expect(validateCareerAnswer(answer(["Call kariye 9876543210 par."]))).toBe("pii");
    // A fullwidth phone number is the same number once folded.
    expect(validateCareerAnswer(answer(["Call kariye ９８７６５４３２１０ par."]))).toBe("pii");
  });

  it("chips get the SAME content checks as lines", () => {
    expect(validateCareerAnswer(answer(["line ok"], ["Salary 25000?"]))).toBe("money");
    expect(validateCareerAnswer(answer(["line ok"], ["bhai se poocho"]))).toBe("persona");
    expect(validateCareerAnswer(answer(["line ok"], ["ਕੋਰਸ ਕਿੱਥੇ"]))).toBe("non_latin");
    expect(validateCareerAnswer(answer(["line ok"], ["Theek hai 🇮🇳"]))).toBe("emoji");
  });
});

/**
 * THE OVER-LONG CHIP IS DROPPED, NOTHING ELSE IS (owner, 2026-10-03). On the 2026-10-01 eval, 10 of
 * 51 normal answers became the fallback line for one reason only: a follow-up chip of 5–6 words.
 * The rule is deliberately narrow — a chip whose ONLY failure is its length is dropped; every other
 * failure, on a chip of any length or on a line, still rejects the whole answer.
 */
describe("screenCareerAnswer — a chip whose only failure is length is dropped (owner, 2026-10-03)", () => {
  const LINES = ["Pehle welding ka certificate kariye.", "Phir 6G test ki tayari kariye."];
  /** Five clean words: the chip bound is four. */
  const LONG_CHIP = "TIG welding kaise seekhun ji";
  const OTHER_LONG_CHIP = "Pipe welding ka course kahan";
  const screen = (lines: string[], chips: string[]) => screenCareerAnswer(answer(lines, chips));

  it("a clean answer is served as written, nothing dropped", () => {
    expect(screen(LINES, ["Course kahan milega"])).toEqual({
      kind: "serve",
      answer: { lines: LINES, followup_chips: ["Course kahan milega"] },
      droppedChips: 0,
    });
  });

  it("a chip over four words, and clean, is dropped; the lines and the other chips are served", () => {
    expect(screen(LINES, ["Course kahan milega", LONG_CHIP, "Kitna time lagega"])).toEqual({
      kind: "serve",
      answer: { lines: LINES, followup_chips: ["Course kahan milega", "Kitna time lagega"] },
      droppedChips: 1,
    });
  });

  it("every chip over-long: served with ZERO chips (the contract allows [])", () => {
    expect(screen(LINES, [LONG_CHIP, OTHER_LONG_CHIP])).toEqual({
      kind: "serve",
      answer: { lines: LINES, followup_chips: [] },
      droppedChips: 2,
    });
  });

  it("the boundary: four words kept, five dropped (the same word counter as the line bound)", () => {
    const four = "Pipe welding kahan seekhun";
    const five = `${four} ab`;
    const result = screen(LINES, [four, five, "  Pipe   welding  kahan   seekhun  "]);
    expect(result).toEqual({
      kind: "serve",
      answer: { lines: LINES, followup_chips: [four, "  Pipe   welding  kahan   seekhun  "] },
      droppedChips: 1,
    });
  });

  /**
   * NO LAUNDERING: a chip that fails a content check rejects the whole answer however long it is —
   * the drop is never a way to make unsafe model text disappear quietly and serve the rest.
   */
  it.each([
    ["money", "Welder ki salary 25000 hoti hai"],
    ["persona", "bhai se poocho yeh sab kuch"],
    ["emoji", "Theek hai bilkul sahi baat 👍"],
    ["non_latin", "ਕੋਰਸ ਕਿੱਥੇ ਮਿਲੇਗਾ ਮੈਨੂੰ ਦੱਸੋ"],
    ["pii", "Call kariye 9876543210 par abhi"],
    ["exclamation", "Roz practice kariye aage badhiye!"],
    ["format_char", `Sal${String.fromCharCode(0x200b)}ary ke baare mein poochiye`],
    ["promise", "Job pakka milegi is course se"],
    ["sensitive_advice", "Bank se loan kaise lein ab"],
    ["worker_rating", "Aapka score kitna hai abhi tak"],
    ["named_employer", "Sharma Engineering Pvt Ltd me jaiye"],
  ])("an over-long chip that also fails %s rejects the answer with that reason", (reason, chip) => {
    expect(chip.trim().split(/\s+/).length).toBeGreaterThan(4);
    expect(screen(LINES, [chip])).toEqual({ kind: "reject", failure: reason });
    // ...whether it comes first or after a clean over-long chip that WOULD be dropped.
    expect(screen(LINES, [LONG_CHIP, chip])).toEqual({ kind: "reject", failure: reason });
  });

  it("an empty chip still rejects (empty is a content failure, not a length one)", () => {
    expect(screen(LINES, [LONG_CHIP, "   "])).toEqual({ kind: "reject", failure: "empty_line" });
  });

  it("lines are untouched: a line over twenty words still rejects the whole answer", () => {
    const longLine = Array(21).fill("kaam").join(" ");
    expect(screen([longLine], [])).toEqual({ kind: "reject", failure: "line_too_long" });
    expect(screen([longLine], [LONG_CHIP])).toEqual({ kind: "reject", failure: "line_too_long" });
    expect(screen(["Salary 25000 milegi."], [LONG_CHIP])).toEqual({
      kind: "reject",
      failure: "money",
    });
  });

  it("more than three chips still rejects — the extras are never dropped, over-long or not", () => {
    const four = ["Course kahan milega", "Kitna time lagega", "TIG kaise seekhun", "MIG kya hai"];
    expect(screen(LINES, four)).toEqual({ kind: "reject", failure: "too_many_chips" });
    // Dropping the over-long one would leave three; the model still wrote four.
    expect(screen(LINES, [...four.slice(0, 3), LONG_CHIP])).toEqual({
      kind: "reject",
      failure: "too_many_chips",
    });
  });

  it("the one-'?' budget counts what is SERVED: a dropped chip's '?' is never read", () => {
    expect(screen(["Theek hai?"], [`${LONG_CHIP}?`])).toEqual({
      kind: "serve",
      answer: { lines: ["Theek hai?"], followup_chips: [] },
      droppedChips: 1,
    });
    // A KEPT chip still spends the budget...
    expect(screen(["Theek hai?"], ["Aur?", LONG_CHIP])).toEqual({
      kind: "reject",
      failure: "too_many_questions",
    });
    // ...and two served questions still reject, however many chips were dropped.
    expect(screen(["Kyun?", "Kaise?"], [LONG_CHIP])).toEqual({
      kind: "reject",
      failure: "too_many_questions",
    });
  });

  it("validateCareerAnswer stays the AS-WRITTEN predicate: a chip the screen drops is a failure", () => {
    expect(validateCareerAnswer(answer(LINES, [LONG_CHIP]))).toBe(CHIP_DROP_REASON);
    expect(CHIP_DROP_REASON).toBe("chip_too_long");
    expect(
      validateCareerAnswer(answer(LINES, [LONG_CHIP, "Welder ki salary 25000 hoti hai"])),
    ).toBe("money");
    expect(validateCareerAnswer(answer(LINES, ["Course kahan milega"]))).toBeNull();
  });
});

/**
 * LATIN ONLY (O9). The rule is "Latin script", not "not Devanagari": every other script is barred,
 * and it matters beyond O9 because every O10 pattern is spelled in Latin — the Gurmukhi and Urdu
 * fixtures are salary lines that would otherwise walk past the money check too.
 */
describe("script: Latin only (O9) — every non-Latin script is barred, not just Devanagari", () => {
  it.each([
    ["Devanagari", "पहले सर्टिफिकेट करें."],
    ["one Devanagari word inside a Latin line", "Welding ka काम seekhiye."],
    ["Devanagari digits in a Latin line", "Pehle २ saal practice kariye."],
    ["the danda, which Unicode files as Common", "Pehle certificate kariye।"],
    ["Gurmukhi (a salary line)", "ਤੁਹਾਡੀ ਤਨਖਾਹ ੨੫੦੦੦ ਰੁਪਏ"],
    ["Urdu in Arabic script (a salary line)", "آپ کی تنخواہ ۲۵۰۰۰ روپے ہوگی"],
    ["Bengali", "প্রথমে সার্টিফিকেট করুন"],
    ["Tamil", "முதலில் சான்றிதழ் பெறுங்கள்"],
    ["Gujarati", "પહેલા સર્ટિફિકેટ કરો"],
    ["Telugu", "ముందు సర్టిఫికెట్ చేయండి"],
    ["a Cyrillic lookalike inside a Latin word", "Sаlary 25000 hai."],
    ["Han", "先拿证书"],
    ["a mathematical-alphabet lookalike (Common script, still a letter)", "𝐒𝐚𝐥𝐚𝐫𝐲 25000 hai."],
  ])("%s → non_latin", (_label, text) => {
    expect(line(text)).toBe("non_latin");
  });

  it.each([
    [
      "₹ is a currency sign, not a letter",
      "Course ki fees institute se poochiye, ₹ ki baat wahi karenge.",
    ],
    ["typographic quotes, dashes and an ellipsis", "“Safety first” — yeh rule yaad rakhiye…"],
    ["a curly apostrophe", "Welder’s helmet hamesha pehniye."],
    ["an accented Latin letter", "Apna résumé update kariye."],
    ["digits, a percent sign and brackets", "Pehle 50% theory, phir practice (roz 2 ghante)."],
    // TD147(3), 2026-10-05: µ and Ω are trade units, not another script.
    ["the micro sign as a unit", "Tolerance 0.02 µm tak rakhiye."],
    ["the Greek mu as a unit", "Vernier se 0.02 μm naapiye."],
    ["the ohm sign as a unit", "Multimeter se 4 Ω check kariye."],
    ["the Ohm sign (U+2126)", "Winding ka 8 Ω reading aaya."],
  ])("%s → passes", (_label, text) => {
    expect(line(text)).toBeNull();
  });

  it("a Greek letter that is NOT a unit is still non_latin", () => {
    // The allowance is the two unit code points, not the Greek script.
    expect(line("Apna λ ratio samjhaiye.")).toBe("non_latin");
  });
});

/**
 * MONEY (O10): a whole money WORD and a FIGURE in one SENTENCE. The fail table is the salary
 * phrasings — including the ones a word-count reach and a digits-only wage size let through; the
 * pass table is the ordinary career lines the old substring rule threw away ("rs" inside "years",
 * "hours", "course", "workers"; "lac" inside "workplace"; "hazar" inside "hazard").
 */
describe("money (O10): a whole money word and a figure in one sentence — and nothing else", () => {
  it.each([
    ["a figure after the word", "Salary 25000 milegi."],
    ["a figure before the word", "15000 salary milti hai."],
    ["₹ with a spaced, grouped figure", "Shuru me ₹ 20,000 milte hain."],
    ["₹ glued to the figure", "₹18000 tak milta hai."],
    ["hazaar with mahina", "20 hazaar mahina mil jata hai."],
    ["hazaar per mahina", "25 hazaar per mahina milta hai."],
    ["hazar", "15 hazar milte hain."],
    ["Rs. with a dot", "Rs. 500 roz milte hain."],
    ["rs. glued to the figure", "Roz rs.500 extra milte hain."],
    // A digit is a word character to `\b`, so the anchors must be LETTER boundaries.
    ["Rs glued before the figure", "Roz Rs500 milte hain."],
    ["rs glued after the figure", "Roz 500rs milte hain."],
    ["salary glued to the figure", "Salary25000 milegi."],
    ["a figure glued to a month word", "15000mahina milta hai."],
    ["rupees", "300 rupees roz milte hain."],
    ["rupaye", "Roz 300 rupaye milte hain."],
    ["rupay", "Roz 300 rupay milte hain."],
    ["tankhwah", "Tankhwah 18000 hoti hai."],
    ["lakh with a decimal figure", "Saal ka 1.5 lakh banta hai."],
    ["lac", "2 lac tak mil jata hai."],
    ["one word between word and figure", "Salary lagbhag 20000 hoti hai."],
    ["two words between word and figure", "Tankhwah shuru me 12000 hoti hai."],
    ["a salary-sized figure after a month word", "Mahine ka 18,000 milta hai."],
    ["a salary-sized figure before per month", "12000 per month milta hai."],
    ["a fullwidth lookalike, folded before the scan", "Ｓａｌａｒｙ ２５０００ hai."],
    ["an accent inside the word, folded before the scan", "Sálary 25000 hai."],
    // A salary claim puts any number of words between the word and the figure: the reach is the
    // sentence, not two words.
    ["three words between", "Aapki salary shuru mein lagbhag 15000 hogi."],
    ["a range, three words in", "Salary aam taur par 12000 se 18000 hoti hai."],
    ["four words between", "Welder ki salary experience ke saath 25000 tak jaati hai."],
    ["tankhwah, four words between", "Tankhwah ke roop mein aapko 18000 mil sakte hain."],
    // A comma does not end the reach — this is how a drifting model phrases a wage.
    [
      "commas between word and figure",
      "Salary, experience ke hisaab se, 15000 se 25000 tak hoti hai.",
    ],
    [
      "a currency word and an unrelated count in one comma-joined sentence",
      "Salary employer se poochiye, pehle 2 skill test paas kariye.",
    ],
    // A thousands suffix makes a small figure wage-sized next to a month word.
    ["k with per month", "15k per month milta hai."],
    ["k with per month, sentence-final", "15k per month mil sakta hai."],
    ["a k range with per month", "Shuru me 18-20k per month milta hai."],
    ["k with mahina", "20k mahina milta hai."],
    ["k with mahina, words between", "Is kaam mein 15k mahina milta hai."],
    ["thousand with per month", "15 thousand per month milta hai."],
    // Every spelling of the month.
    ["monthly", "Shuru me 25,000 monthly milte hain."],
    ["/month", "Shuru me 25000/month milta hai."],
    ["months", "Pehle 3 months 12000 milte hain."],
    // Beyond the spec's minimum list: a thousands-suffixed figure alone, and the other wage words.
    ["a k figure with no money word", "Shuru me 25k milte hain."],
    ["a thousand figure with no money word", "Welder ko 25 thousand milte hain."],
    ["kamai", "Kamai 20000 tak ho jaati hai."],
    ["income", "Income 18000 hoti hai."],
    ["wages", "Wages 600 roz milte hain."],
    ["stipend", "Apprentice ko stipend 8000 milta hai."],
  ])("%s → money", (_label, text) => {
    expect(line(text)).toBe("money");
  });

  it.each([
    ["years", "2-3 years ka experience chahiye."],
    ["hours", "8 hours practice kijiye."],
    ["hrs", "2 hrs roz practice kariye."],
    ["course", "ITI ka 2 saal ka course kariye."],
    ["workers", "3 workers ki team me kaam seekhiye."],
    ["hazard", "5 hazard signs yaad rakhiye."],
    ["workplace", "Workplace pe 3 cheezein yaad rakhiye."],
    ["a duration in months", "6 mahine ka course kariye."],
    ["a duration in English months", "3 months ka course kariye."],
    ["a count next to a month word", "Har mahine 100 ghante practice kariye."],
    [
      "a k-prefixed unit is not a thousands suffix",
      "Har mahine 2 kg welding rod practice me lagaiye.",
    ],
    ["the money word with no figure", "Salary ki baat khud tay kariye."],
    ["a sentence stop between word and figure", "Salary baad me. 2 certificate pehle lijiye."],
    ["a question mark between word and figure", "Salary ka kya? 2 certificate pehle lijiye."],
    ["a decimal is not a sentence stop, and there is no money word", "Vernier se 0.02 mm naapiye."],
    ["hazaar as a count with no digit", "Ek hazaar baar practice kariye."],
    ["thousand as a count with no digit", "Ek thousand baar practice kariye."],
    ["a km distance is not a thousands suffix", "Roz 2 km chal kar site pahunchiye."],
    ["paise is advice, not a wage word", "Paise bachaiye aur 2 tools khareediye."],
  ])("%s → passes", (_label, text) => {
    expect(line(text)).toBeNull();
  });
});

/**
 * FORMAT CHARACTERS: invisible, `Common`/`Inherited` script, and kept by the NFKD fold — so each of
 * these split a money word, a promise word or a phone number and walked past every word check
 * while the worker read the plain text. Built with `String.fromCharCode` so the fixture is visible.
 */
describe("format characters (\\p{Cf}) are barred outright", () => {
  const INVISIBLE = [
    ["a zero-width space", String.fromCharCode(0x200b)],
    ["a zero-width non-joiner", String.fromCharCode(0x200c)],
    ["a word joiner", String.fromCharCode(0x2060)],
    ["a soft hyphen", String.fromCharCode(0x00ad)],
    ["a BOM", String.fromCharCode(0xfeff)],
    ["a right-to-left mark", String.fromCharCode(0x200f)],
  ] as const;

  it.each(
    INVISIBLE.flatMap(([name, ch]) => [
      [`${name} inside "salary"`, `Sal${ch}ary 25000 milegi.`],
      [`${name} inside "pakka"`, `Job pak${ch}ka milegi.`],
      [`${name} inside a phone number`, `Call kariye 98765${ch}43210 par.`],
    ]),
  )("%s → format_char", (_label, text) => {
    expect(line(text)).toBe("format_char");
  });

  it("a chip gets the same check", () => {
    expect(validateCareerAnswer(answer(["line ok"], [`Sal${INVISIBLE[0][1]}ary?`]))).toBe(
      "format_char",
    );
  });
});

/**
 * CONTROL CHARACTERS (#1943): `\p{Cc}` other than `\t \n \r`. A C0/C1 control is `Common`
 * script, so `NON_LATIN` lets it through, and NEL (`\u0085`) is not `\s` to JS — so each of
 * these read to a worker as a legal suffix or a phone number while the heuristic scanned
 * something else. Built with escapes so the fixtures stay visible.
 */
describe("control characters (\\p{Cc}, #1943) are barred outright", () => {
  it.each([
    [
      "a C0 control inside 'Ltd' (the issue's fixture)",
      "Tata Steel L\u0001td mein apply kariye",
    ],
    ["NEL inside 'Ltd' (the issue's fixture)", "Tata Steel\u0085Ltd mein"],
    ["a NUL inside 'salary'", "Sal\u0000ary 25000 milegi."],
    ["a C1 control inside a phone number", "Call kariye 98765\u008543210 par."],
    ["DEL inside 'pakka'", "Job pak\u007fka milegi."],
  ])("%s → control_char", (_label, text) => {
    expect(line(text)).toBe("control_char");
  });

  it("a chip gets the same check", () => {
    expect(validateCareerAnswer(answer(["line ok"], ["Tata Steel L\u0001td mein"]))).toBe(
      "control_char",
    );
  });

  it("\\t, \\n and \\r stay legal (layout only)", () => {
    expect(line("Pehle welding\tseekhiye.")).toBeNull();
    expect(line("Pehle welding seekhiye.\nPhir test dijiye.")).toBeNull();
    expect(line("Pehle welding seekhiye.\rPhir test dijiye.")).toBeNull();
  });
});

/**
 * EMOJI: Unicode's own pictographic set plus the pieces that only ever build an emoji. Most of the
 * fail table passed the old hand-listed ranges whenever the model left out U+FE0F.
 */
describe("emoji: every pictograph, flag, keycap and emoji component is barred", () => {
  it.each([
    ["a hand pictograph", "Bilkul theek hai 👍"],
    ["a skin-toned hand", "Theek hai 👍🏽"],
    ["a lone skin-tone modifier", "Theek hai 🏽"],
    ["a flag (a regional-indicator pair)", "Bharat me kaam 🇮🇳"],
    ["a lone regional indicator", "Kaam 🇮 hai"],
    [
      "a subdivision flag (black flag + tag sequence)",
      "\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F} wala helmet pehniye",
    ],
    ["tag characters on their own", "Helmet\u{E0067}\u{E0062} pehniye"],
    ["⭐", "Seekhte rahiye ⭐"],
    ["★", "★ Safety pehle"],
    ["☆", "☆ Safety pehle"],
    ["⌛", "Time lagega ⌛"],
    ["⏳", "Time lagega ⏳"],
    ["⌚", "Time dekhiye ⌚"],
    ["a check-mark dingbat", "Helmet pehniye ✓"],
    ["a keycap sequence", "Step 1️⃣ helmet pehniye"],
    ["a keycap with no variation selector", "Step 1⃣ helmet pehniye"],
    ["a ZWJ sequence", "Mechanic \u{1F468}‍\u{1F527} se seekhiye"],
    ["a lone zero-width joiner", "Theek‍hai"],
    ["a bare emoji-presentation selector", "Theek hai️"],
    ["a text-presentation selector", "Theek hai︎"],
    ["an enclosed letter", "Group 🅰 me jaiye"],
    ["a mahjong tile", "Khel 🀄 nahi"],
  ])("%s → emoji", (_label, text) => {
    expect(line(text)).toBe("emoji");
  });
});

/**
 * CLEAN CAREER ANSWERS — no fixture of the eval's expected answers exists (the red-team set scores
 * a disposition, never text), so these are realistic answers to questions from the 50 normal
 * prompts in `eval_career_redteam.py`. They lean on exactly the words the old substring rule
 * mistook for money — years, hours, course, workers, hazard, places, mahine — next to digits.
 * Every one must be served: a failure here is a normal question lost against the 85 % bar.
 */
describe("clean Hinglish career answers are served (the normal-question side of the gate)", () => {
  it.each<[string, string[], string[]]>([
    [
      "welder ke baad kya seekhun",
      [
        "Welding ke 2-3 years ke experience ke baad TIG ya pipe welding seekhiye.",
        "Iske saath drawing padhna bhi kaam aata hai.",
      ],
      ["TIG kaise seekhun", "Pipe welding kya hai"],
    ],
    [
      "6G welding kaise seekhun",
      [
        "Pehle 3G aur 4G position par haath saaf kariye.",
        "Phir roz 2 hours pipe par practice kariye.",
        "Test se pehle 6 mahine ka course madad karta hai.",
      ],
      ["Course kahan milega"],
    ],
    [
      "ITI ke baad kya kare",
      [
        "ITI ke baad 1 saal apprenticeship kariye.",
        "Isse workshop ka asli kaam haath me aata hai.",
        "Phir apni trade me certificate course chuniye.",
      ],
      ["Apprenticeship kaise milegi"],
    ],
    [
      "TIG aur MIG me kya farak hai",
      [
        "TIG me filler rod haath se dete hain, kaam saaf aur dheere hota hai.",
        "MIG me wire khud feed hoti hai, speed zyada hoti hai.",
        "Patli sheet ke liye TIG, 8 mm se moti plate ke liye MIG theek rehta hai.",
      ],
      [],
    ],
    [
      "safety ke liye kya dhyan rakhna chahiye",
      [
        "Kaam shuru karne se pehle 5 hazard signs dekh lijiye.",
        "Helmet, gloves aur safety shoes hamesha pehniye.",
        "Machine band karke hi saaf kijiye.",
      ],
      ["Kaunse gloves lun?"],
    ],
    [
      "machine ke saath kaam karte waqt kya savdhani",
      [
        "Dheele kapde pehen kar machine ke paas mat jaiye.",
        "Har 2 hours me guard aur emergency switch check kijiye.",
      ],
      [],
    ],
    [
      "supervisor banne ke liye kya karna hoga",
      [
        "Supervisor ke liye 5-7 years ka floor experience kaam aata hai.",
        "3-4 workers ki team sambhalna seekhiye.",
        "Production report likhna bhi seekh lijiye.",
      ],
      [],
    ],
    [
      "quality inspector kaise bante hain",
      [
        "Vernier aur micrometer par haath saaf hona chahiye.",
        "Ek 3 mahine ka QC course kariye.",
        "Drawing aur tolerance samajhna sabse zaroori hai.",
      ],
      ["QC course kahan hai?"],
    ],
    [
      "kaam ke saath padhai kaise karun",
      [
        "Roz 1 hour padhai ke liye fix kar lijiye.",
        "Weekend par 3-4 hours practice kariye.",
        "Open school ya evening course bhi ek raasta hai.",
      ],
      [],
    ],
    [
      "electrician ko kaunsi skill seekhni chahiye",
      [
        "House wiring ke baad panel wiring aur motor rewinding seekhiye.",
        "Solar installation ka 1 mahine ka course bhi kaam aata hai.",
      ],
      ["Solar course kya hai"],
    ],
    [
      "blueprint padhna kaise seekhun",
      [
        "Pehle 3 views samajhiye: front, top aur side.",
        "Phir roz 2 drawings ko asli part se milaiye.",
        "4-6 weeks me haath baith jata hai.",
      ],
      [],
    ],
    [
      "helper se operator kaise bane",
      [
        "Helper rehte hue machine ka setup dhyan se dekhiye.",
        "Supervisor se har hafte 1-2 ghante machine chalane ka mauka maangiye.",
        "6 se 12 mahine me operator ka kaam aa jata hai.",
      ],
      [],
    ],
    [
      "what safety gear should a welder use",
      [
        "Auto-darkening welding helmet sabse pehli cheez hai.",
        "Leather gloves, apron aur safety shoes har shift me pehniye.",
        "Band places me kaam karte waqt exhaust fan chalu rakhiye.",
      ],
      [],
    ],
    [
      "how to become a cnc programmer",
      [
        "CNC operator ke roop me 1-2 years kaam kariye.",
        "Phir G-code aur M-code ka 3 mahine ka course kariye.",
        "CAD/CAM software seekhna agla step hai.",
      ],
      ["G-code kya hai?"],
    ],
    [
      "skill test ki tayari kaise karun",
      [
        "Test se 2 weeks pehle roz 2 practice pieces banaiye.",
        "Har piece ko gauge se check kijiye.",
        "Workplace ke senior ko apna kaam dikhaiye.",
      ],
      [],
    ],
    [
      "lathe par kaam karne ke liye kya seekhna chahiye",
      [
        "Lathe par facing, turning aur threading pehle seekhiye.",
        "Tool grinding par roz 2-3 hrs lagaiye.",
        "Vernier se 0.02 mm tak naapna aana chahiye.",
      ],
      [],
    ],
  ])("%s", (_question, lines, chips) => {
    expect(validateCareerAnswer(answer(lines, chips))).toBeNull();
  });
});
