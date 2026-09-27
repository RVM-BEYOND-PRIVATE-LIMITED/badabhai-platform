import { describe, expect, it } from "vitest";
import { checkPersonaTokens, personaCorpus } from "@badabhai/profiling-lexicon";

import {
  RESUME_MENU_CHAT_CREATE_KEY,
  RESUME_MENU_EDIT_KEY,
  RESUME_MENU_REDO_KEY,
  RESUME_MENU_UPLOAD_KEY,
  RESUME_SECTIONS,
} from "../chat/resume-menu";
import {
  GENERAL_FORM_OFFER,
  isSkillsStop,
  isSkillsYes,
  narrowGeneralFormOffer,
  readSkillsGateReply,
  SKILLS_GATE_OPTIONS,
  SKILLS_GATE_QUESTION,
  skillsGatePrompt,
  type SkillsGateRead,
} from "./skills-gate";
import { FORM_OFFER_OPTIONS } from "./trade-form-offer";
import { TRADE_FORM_OFFERS } from "./trade-form-router";

/**
 * The skills gate's own module (ADR-0045 §3.2–§3.3) — the bubble, the chips, the reader, the card.
 *
 * The chips are asserted by their CONTRACT (keys and boolean values), because the client answers
 * with keys. The reader is asserted through every door it promises, and through the two outcomes
 * that are safety properties: a sentence about a skill is never a stop ("excel nahi aata"), and a
 * bare skill is never a yes or a no ("photoshop"). The copy is held to the persona rules the
 * engine's other replies are (`persona-copy.test.ts`).
 */

const SAMPLE_SKILLS = ["Tally", "GST filing", "MS Excel"] as const;

function questionMarks(text: string): number {
  return (text.match(/\?/g) ?? []).length;
}

describe("skillsGatePrompt — the bubble", () => {
  it("lists the skills as one bullet per line, a blank line, then the question", () => {
    expect(skillsGatePrompt(SAMPLE_SKILLS)).toBe(
      "Aapki skills:\n• Tally\n• GST filing\n• MS Excel\n\nKya aur koi skill jodni hai?",
    );
  });

  it("ends on the gate question and carries exactly one question mark", () => {
    const prompt = skillsGatePrompt(SAMPLE_SKILLS);
    expect(prompt.endsWith(SKILLS_GATE_QUESTION)).toBe(true);
    expect(questionMarks(prompt)).toBe(1);
  });

  it("with zero skills is the question alone — no empty heading", () => {
    expect(skillsGatePrompt([])).toBe(SKILLS_GATE_QUESTION);
    // Skills that are empty once shaped are no skills either.
    expect(skillsGatePrompt(["", "   ", "?"])).toBe(SKILLS_GATE_QUESTION);
  });

  it("keeps its shape whatever a skill string carries — one line each, one '?' in all", () => {
    const prompt = skillsGatePrompt(["Tally\nPrime", "  GST   filing  ", "Excel?"]);
    expect(prompt).toBe(
      "Aapki skills:\n• Tally Prime\n• GST filing\n• Excel\n\nKya aur koi skill jodni hai?",
    );
    expect(questionMarks(prompt)).toBe(1);
  });

  it("keeps the caller's order and does not de-duplicate — the stage owns both", () => {
    expect(skillsGatePrompt(["B", "A", "B"])).toBe(
      "Aapki skills:\n• B\n• A\n• B\n\nKya aur koi skill jodni hai?",
    );
  });
});

describe("SKILLS_GATE_OPTIONS — the chips", () => {
  it("carries exactly two chips — Haan and Nahi — with boolean values and stable keys", () => {
    expect(SKILLS_GATE_OPTIONS.map((o) => o.option_key)).toEqual([
      "skills_gate_add",
      "skills_gate_done",
    ]);
    expect(SKILLS_GATE_OPTIONS.map((o) => o.label_text)).toEqual(["Haan", "Nahi"]);
    expect(SKILLS_GATE_OPTIONS.map((o) => o.value)).toEqual([true, false]);
    for (const option of SKILLS_GATE_OPTIONS) {
      expect(option.implies_skill_id).toBeNull();
      expect(option.is_none_of_above).toBe(false);
    }
  });

  it("is frozen, chips and list alike", () => {
    expect(Object.isFrozen(SKILLS_GATE_OPTIONS)).toBe(true);
    for (const option of SKILLS_GATE_OPTIONS) expect(Object.isFrozen(option)).toBe(true);
  });

  it("uses no key a shipped client or another offer already routes on", () => {
    const taken = new Set<string>([
      ...FORM_OFFER_OPTIONS.map((o) => o.option_key),
      RESUME_MENU_EDIT_KEY,
      RESUME_MENU_REDO_KEY,
      RESUME_MENU_UPLOAD_KEY,
      RESUME_MENU_CHAT_CREATE_KEY,
      ...RESUME_SECTIONS.map((s) => s.key),
    ]);
    for (const option of SKILLS_GATE_OPTIONS) expect(taken.has(option.option_key)).toBe(false);
  });
});

describe("readSkillsGateReply — the reader", () => {
  const TABLE: ReadonlyArray<readonly [reply: string, read: SkillsGateRead]> = [
    // 1. chip keys, exactly
    ["skills_gate_add", "add"],
    ["skills_gate_done", "done"],
    // 2. chip labels, case-insensitive and trimmed
    ["Haan", "add"],
    ["haan", "add"],
    ["HAAN", "add"],
    ["  haan  ", "add"],
    ["Nahi", "done"],
    ["NAHI", "done"],
    // 3. whole-message stops — including the ones the lexicon has no word for
    ["bas", "done"],
    ["bs", "done"],
    ["bas bas", "done"],
    ["bas bhai", "done"],
    ["bas hogaya", "done"],
    ["bas ho gaya", "done"],
    ["ho gya bas", "done"],
    ["sab ho gaya", "done"],
    ["itna hi tha", "done"],
    ["yahi tha", "done"],
    ["sirf itna", "done"],
    ["sirf itna hi", "done"],
    ["bas yehi", "done"],
    ["bas yahi hai", "done"],
    ["that's it", "done"],
    ["thats it", "done"],
    ["nothing more", "done"],
    ["nothing else", "done"],
    ["no more", "done"],
    ["enough", "done"],
    ["finished", "done"],
    // …and the literal negation of "aur KOI skill" — each of these used to cost a model call
    ["aur koi nahi", "done"],
    ["koi aur nahi", "done"],
    ["koi nahi", "done"],
    ["aur koi skill nahi", "done"],
    ["koi skill nahi", "done"],
    ["kuch aur nahi", "done"],
    ["और कोई नहीं", "done"],
    ["कोई नहीं", "done"],
    ["Bas.", "done"],
    ["bas itna hi", "done"],
    ["Bas, itna hi!", "done"],
    ["itna hi", "done"],
    ["yahi sab", "done"],
    ["kuch nahi", "done"],
    ["aur kuch nhi", "done"],
    ["that's all", "done"],
    ["Thats all", "done"],
    ["done", "done"],
    ["khatam", "done"],
    ["ho gaya", "done"],
    ["nahi ji", "done"],
    ["बस", "done"],
    ["बस इतना ही", "done"],
    ["नहीं", "done"],
    ["कुछ नहीं", "done"],
    ["और कुछ नहीं।", "done"],
    // 4. whole-message yeses. A miss here was a wrong Nahi: `other` → no skill → `unclear` → §6.
    //    The lexicon has no bare "ha", and "ha ji" reached its "ji" cue at index 3, not the head.
    ["ha", "add"],
    ["Ha.", "add"],
    ["haa", "add"],
    ["ha ji", "add"],
    ["ha jee", "add"],
    ["han ji", "add"],
    ["ha bhai", "add"],
    ["ha sir", "add"],
    ["hn", "add"],
    ["hnji", "add"],
    ["हा", "add"],
    ["हाँ जी", "add"],
    ["हा जी", "add"],
    ["aur", "add"],
    ["aur hai", "add"],
    ["ek aur", "add"],
    ["ha aur hai", "add"],
    ["haan aur hai", "add"],
    ["और है", "add"],
    // the gate's own verb, echoed back
    ["jodni hai", "add"],
    ["jodna hai", "add"],
    ["jodni h", "add"],
    ["जोड़नी है", "add"],
    ["add", "add"],
    ["Add karo", "add"],
    ["add more", "add"],
    ["one more", "add"],
    ["more", "add"],
    // 5a. a leading no, then nothing new — still a no
    ["nahi, bas itna", "done"],
    ["nahi bas", "done"],
    ["nahi bhai", "done"],
    ["nahi yaar", "done"],
    ["nahi chahiye", "done"],
    ["nahi shukriya", "done"],
    ["no thanks", "done"],
    ["no thank you", "done"],
    ["nahi nahi", "done"],
    ["nahi nahi bas", "done"],
    ["nahi, bas itna hi hai", "done"],
    ["nahi ji, aur kuch nahi", "done"],
    ["नहीं बस", "done"],
    ["haan nahi", "done"],
    ["ji nahi, thank you", "done"],
    // 5b. a leading no, then ANYTHING else — "no wait, one more": the skills model reads the rest
    ["nahi, excel bhi", "other"],
    ["nahi excel bhi", "other"],
    ["na, photoshop bhi", "other"],
    ["nahi ek aur hai", "other"],
    ["no wait excel bhi", "other"],
    ["nahi nahi excel bhi aata hai", "other"],
    ["nahi, tally bhi aata hai", "other"],
    ["नहीं, एक्सेल भी", "other"],
    //     …after a yes too: "haan nahi" is a no, and what follows it is still the model's to read
    ["haan nahi, excel bhi", "other"],
    ["ji nahi, excel bhi", "other"],
    ["bilkul nahi, excel bhi", "other"],
    //     "nahi pata" is a don't-know, not a no — `other`, and the model's `unclear` is the Nahi
    ["nahi pata", "other"],
    // 5c. a leading yes, then a whole stop — manners before a no ("bas ji" and "ji bas" agree now)
    ["haan bas itna hi", "done"],
    ["ji bas", "done"],
    ["ji bas itna hi", "done"],
    ["ok bas", "done"],
    ["ok thats all", "done"],
    ["Ok, that's all.", "done"],
    ["yes done", "done"],
    ["theek hai bas itna hi", "done"],
    ["haan ho gaya", "done"],
    ["haan itna hi", "done"],
    ["haan bhai, bas", "done"],
    ["हाँ बस", "done"],
    //     "na" after a yes is a tag ("haan na" = "of course"), never a no
    ["haan na", "add"],
    ["ji na", "add"],
    // 6. the lexicon's yes/no, when its cue OPENS the reply
    ["haan photoshop bhi", "add"],
    ["haan, bas welding", "add"],
    ["ji haan", "add"],
    ["हाँ", "add"],
    ["theek hai", "add"],
    // 7. everything else is `other` — the skills model reads it
    ["excel nahi aata", "other"],
    ["tally aata hai", "other"],
    ["welding bhi karta hoon", "other"],
    ["photoshop", "other"],
    ["bas welding", "other"],
    ["tally aur excel hai", "other"],
    ["", "other"],
    ["   ", "other"],
  ];

  it.each(TABLE)("%j → %s", (reply, read) => {
    expect(readSkillsGateReply(reply)).toBe(read);
  });

  it("reads a long run of fillers after a no in one pass, and still sees the word at its end", () => {
    const fillers = " bas".repeat(5000);
    expect(readSkillsGateReply(`nahi${fillers}`)).toBe("done");
    expect(readSkillsGateReply(`nahi${fillers} excel`)).toBe("other");
  });
});

describe("isSkillsYes — the whole-message yes set", () => {
  // Every entry of the set, verbatim — so the disjointness check below walks all of them.
  const YES_ENTRIES = [
    "ha",
    "haa",
    "ha ji",
    "ha jee",
    "han ji",
    "ha bhai",
    "ha sir",
    "hn",
    "hnji",
    "हा",
    "हाँ जी",
    "हा जी",
    "aur",
    "aur hai",
    "ek aur",
    "ha aur hai",
    "haan aur hai",
    "jodni hai",
    "jodna hai",
    "jodni h",
    "more",
    "add",
    "add karo",
    "add more",
    "one more",
    "और है",
    "जोड़नी है",
  ];

  it("reads the closed set, in both scripts, whatever the case and punctuation", () => {
    for (const text of [...YES_ENTRIES, "HA!", "Ha ji.", "Add karo", "ONE MORE"]) {
      expect(isSkillsYes(text), text).toBe(true);
    }
  });

  it("is disjoint from the stop set — no entry is both, so the reader's order decides nothing", () => {
    for (const text of YES_ENTRIES) expect(isSkillsStop(text), text).toBe(false);
  });

  it("is never a substring match — a list of skills is not a yes", () => {
    for (const text of ["tally aur excel hai", "haan photoshop bhi", "add excel", "", "   "]) {
      expect(isSkillsYes(text), text).toBe(false);
    }
  });
});

describe("isSkillsStop — the whole-message stop set", () => {
  it("reads the closed set, in both scripts, whatever the case and punctuation", () => {
    for (const text of [
      "bas",
      "bas itna",
      "bas itna hi",
      "bas yahi",
      "itna hi",
      "yahi",
      "yahi sab",
      "nahi",
      "nhi",
      "na",
      "no",
      "nope",
      "kuch nahi",
      "kuch nhi",
      "aur nahi",
      "aur kuch nahi",
      "aur kuch nhi",
      "nothing",
      "thats all",
      "that's all",
      "That’s all.",
      "done",
      "khatam",
      "ho gaya",
      "hogaya",
      "bas ho gaya",
      "BAS!!",
      "bs",
      "that's it",
      "koi nahi",
      "aur koi nahi",
      "koi aur nahi",
      "aur koi skill nahi",
      "बस",
      "बस इतना",
      "बस इतना ही",
      "इतना ही",
      "नहीं",
      "कुछ नहीं",
      "और कुछ नहीं",
      "कोई नहीं",
      "और कोई नहीं",
    ]) {
      expect(isSkillsStop(text), text).toBe(true);
    }
  });

  it("is never a substring match — a sentence about a skill is not a stop", () => {
    for (const text of [
      "excel nahi aata",
      "bas welding",
      "nahi pata",
      "done welding",
      "tally bas",
      "बस वेल्डिंग",
      "",
      "   ",
    ]) {
      expect(isSkillsStop(text), text).toBe(false);
    }
  });
});

describe("GENERAL_FORM_OFFER — the card", () => {
  it("says what happened and what the button does", () => {
    expect(GENERAL_FORM_OFFER.headline).toBe("Skills note ho gayi");
    expect(GENERAL_FORM_OFFER.reply).toBe(
      "Skills note ho gayi. Ab form bharkar resume pura karein.",
    );
  });

  it("uses the SAME button label as every trade-form card — the duplicated literal cannot drift", () => {
    const tradeOffers = Object.values(TRADE_FORM_OFFERS);
    expect(tradeOffers.length).toBeGreaterThan(0);
    for (const offer of tradeOffers) expect(GENERAL_FORM_OFFER.ctaLabel).toBe(offer.ctaLabel);
  });

  it("has exactly the trade cards' reply shape, with only the headline changed", () => {
    for (const offer of Object.values(TRADE_FORM_OFFERS)) {
      expect(offer.reply.replace(offer.headline, GENERAL_FORM_OFFER.headline)).toBe(
        GENERAL_FORM_OFFER.reply,
      );
    }
  });

  it("is frozen", () => {
    expect(Object.isFrozen(GENERAL_FORM_OFFER)).toBe(true);
  });
});

describe("narrowGeneralFormOffer — the Redis round trip", () => {
  it("rebuilds the card from the constant for any stored object, whatever it says", () => {
    expect(narrowGeneralFormOffer(GENERAL_FORM_OFFER)).toBe(GENERAL_FORM_OFFER);
    expect(narrowGeneralFormOffer({})).toBe(GENERAL_FORM_OFFER);
    // A headline a retired build wrote is NOT replayed — the copy is ours, not the session's.
    expect(
      narrowGeneralFormOffer({ headline: "Retired copy", ctaLabel: "Old", reply: "Old." }),
    ).toBe(GENERAL_FORM_OFFER);
  });

  it("returns null for anything that is not an object", () => {
    for (const value of [null, undefined, "offer", 1, true]) {
      expect(narrowGeneralFormOffer(value)).toBeNull();
    }
  });
});

describe("the gate's copy is on-persona", () => {
  const COPY: ReadonlyArray<readonly [name: string, text: string]> = [
    ["SKILLS_GATE_QUESTION", SKILLS_GATE_QUESTION],
    ["skillsGatePrompt(sample)", skillsGatePrompt(SAMPLE_SKILLS)],
    ["GENERAL_FORM_OFFER.headline", GENERAL_FORM_OFFER.headline],
    ["GENERAL_FORM_OFFER.reply", GENERAL_FORM_OFFER.reply],
    ["GENERAL_FORM_OFFER.ctaLabel", GENERAL_FORM_OFFER.ctaLabel],
    ...SKILLS_GATE_OPTIONS.map((o) => [`chip ${o.option_key}`, o.label_text] as const),
  ];

  it.each(COPY)("%s carries no banned token", (_name, text) => {
    expect(checkPersonaTokens(text)).toEqual([]);
  });

  it.each(COPY)("%s has no exclamation mark and at most the persona's question budget", (_n, t) => {
    expect(t).not.toContain("!");
    expect(questionMarks(t)).toBeLessThanOrEqual(personaCorpus().maxQuestionMarks);
  });

  it("the card asks nothing — it closes the chat", () => {
    expect(questionMarks(GENERAL_FORM_OFFER.reply)).toBe(0);
  });

  it("uses the aap register — never tu/tum", () => {
    for (const [name, text] of COPY) {
      for (const informal of personaCorpus().bannedInformal) {
        expect(` ${text.toLowerCase()} `, `${name} contains "${informal}"`).not.toContain(
          ` ${informal} `,
        );
      }
    }
  });

  it("offers no more chips than the persona allows", () => {
    expect(SKILLS_GATE_OPTIONS.length).toBeLessThanOrEqual(personaCorpus().maxChips);
  });
});
