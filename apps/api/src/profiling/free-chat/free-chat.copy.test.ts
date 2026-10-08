import { describe, expect, it } from "vitest";
import { checkPersonaTokens, personaCorpus } from "@badabhai/profiling-lexicon";
import { FREE_CHAT_REFUSAL_TOPICS, FREE_CHAT_REPLY_LANGUAGES } from "@badabhai/types";

import { CONSTANT_REPLIES } from "../reply-closure";
import { ttsTextFor } from "../question-tts-text";
import {
  FREE_CHAT_COPY,
  FREE_CHAT_COPY_ENTRIES,
  FREE_CHAT_FIXED_LINE_ENTRIES,
  FREE_CHAT_LANG_NO_KEY,
  FREE_CHAT_LANG_NO_LABEL,
  FREE_CHAT_LANG_NO_LINE,
  FREE_CHAT_LANG_YES_KEY,
  FREE_CHAT_LANGUAGE_LINE_ENTRIES,
  FREE_CHAT_LANGUAGE_NAMES,
  FREE_CHAT_LANGUAGE_TEMPLATES,
  FREE_CHAT_LATER_KEY,
  FREE_CHAT_LATER_LABEL,
  FREE_CHAT_REFUSAL_LINES,
  FREE_CHAT_REPLIES,
  FREE_CHAT_RESUME_KEY,
  FREE_CHAT_RESUME_LABEL,
  FREE_CHAT_START_KEY,
  FREE_CHAT_START_LABEL,
  FREE_CHAT_TTS_ENTRIES,
  languageAskLine,
  languageYesLabel,
  languageYesLine,
} from "./free-chat.copy";

/**
 * The free chat's approved copy (ADR-0051 §5.1), held to persona v3.2 — the same scan
 * `companion-replies.test.ts` runs over the companion's lines, plus the ADR's own rules: the only
 * number in any line is the Tele-MANAS helpline, and every line has a Devanagari twin a voice can
 * read.
 */

const DEVANAGARI = /[ऀ-ॿ]/u;
// Pictographs and the emoji presentation selector — the persona ships no emoji.
const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]|\u{FE0F}/u;
const words = (line: string): number => line.trim().split(/\s+/).filter(Boolean).length;
const persona = personaCorpus();

describe("free-chat copy is on-persona (persona v3.2)", () => {
  const shown: ReadonlyArray<readonly [string, string]> = [
    // ADR-0051 §11 — every reply-language variant too (LANG_ASK.marathi, LANG_YES.tamil, …).
    ...FREE_CHAT_FIXED_LINE_ENTRIES.map(([name, line]) => [name, line.latin] as const),
    // The chips' labels are posted back as text, so they are copy too.
    ["chip", FREE_CHAT_START_LABEL],
    ["chip", FREE_CHAT_LATER_LABEL],
    ["chip", FREE_CHAT_RESUME_LABEL],
    ...FREE_CHAT_REPLY_LANGUAGES.map((language) => ["chip", languageYesLabel(language)] as const),
    ["chip", FREE_CHAT_LANG_NO_LABEL],
  ];

  it.each(shown)("%s — %j carries no banned token", (_name, text) => {
    expect(checkPersonaTokens(text)).toEqual([]);
  });

  it.each(shown)(
    "%s — %j has no exclamation, no emoji, at most one question mark",
    (_name, text) => {
      expect(text).not.toContain("!");
      expect(text).not.toMatch(EMOJI);
      expect((text.match(/\?/g) ?? []).length).toBeLessThanOrEqual(persona.maxQuestionMarks);
    },
  );

  it.each(shown)("%s — %j is under twenty words and in Latin script", (_name, text) => {
    expect(words(text)).toBeLessThanOrEqual(20);
    expect(text).not.toMatch(DEVANAGARI);
  });

  it.each(shown)(
    "%s — %j carries no number of four digits or more but the helpline",
    (name, text) => {
      const numbers = text.match(/\d{4,}/g) ?? [];
      expect(numbers).toEqual(name === "DISTRESS" ? ["14416"] : []);
    },
  );

  it("is name-free — no placeholder, so a pre-rendered clip is the same for every worker", () => {
    for (const [, line] of FREE_CHAT_FIXED_LINE_ENTRIES) {
      expect(line.latin).not.toMatch(/\{\{|\}\}/);
      expect(line.dev).not.toMatch(/\{\{|\}\}/);
    }
  });
});

describe("every line has a Devanagari twin a voice can read", () => {
  it.each(FREE_CHAT_FIXED_LINE_ENTRIES)(
    "%s — the twin is Devanagari, with no Latin word left in it",
    (_name, line) => {
      expect(line.dev).toMatch(DEVANAGARI);
      expect(line.dev).not.toMatch(/[A-Za-z]/);
    },
  );

  it("the helpline is the same number in both scripts", () => {
    expect(FREE_CHAT_COPY.DISTRESS.latin).toContain("14416");
    expect(FREE_CHAT_COPY.DISTRESS.dev).toContain("14416");
  });

  it("the sidecar serves each twin — and composes the twin of a deflection + a known question", () => {
    for (const [, line] of FREE_CHAT_FIXED_LINE_ENTRIES) {
      expect(ttsTextFor(line.latin)).toBe(line.dev);
    }
    const question = "Shukriya. Aap kaun sa kaam karte hain, aur kitna tajurba hai?";
    expect(ttsTextFor(`${FREE_CHAT_COPY.LOCK_DEFLECT.latin} ${question}`)).toBe(
      `${FREE_CHAT_COPY.LOCK_DEFLECT.dev} ${ttsTextFor(question)}`,
    );
    expect(ttsTextFor(`${FREE_CHAT_COPY.LOCK_CLARIFY.latin} ${FREE_CHAT_COPY.OPENER.latin}`)).toBe(
      `${FREE_CHAT_COPY.LOCK_CLARIFY.dev} ${FREE_CHAT_COPY.OPENER.dev}`,
    );
    // A classifier-only trash re-ask leads with the de-escalation line, whose twin is already held.
    const deEscalation = "Aap se vinamra rehne ki request hai. Kaam ki baat karte hain.";
    expect(ttsTextFor(`${deEscalation} ${FREE_CHAT_COPY.OPENER.latin}`)).toBe(
      `${ttsTextFor(deEscalation)} ${FREE_CHAT_COPY.OPENER.dev}`,
    );
    // Half Devanagari, half roman is worse than the roman line the client already speaks.
    expect(
      ttsTextFor(`${FREE_CHAT_COPY.LOCK_DEFLECT.latin} Kya aap chandrayaan udate hain?`),
    ).toBeUndefined();
  });
});

describe("the chips and the refusal map", () => {
  it("keys are digit-free slugs the option schema accepts, clear of the app-reserved keys", () => {
    for (const key of [
      FREE_CHAT_START_KEY,
      FREE_CHAT_LATER_KEY,
      FREE_CHAT_RESUME_KEY,
      FREE_CHAT_LANG_YES_KEY,
      FREE_CHAT_LANG_NO_KEY,
    ]) {
      expect(key).toMatch(/^[a-z_]+$/);
      expect(key).not.toMatch(/^(llm_|section_|companion_)/);
      expect([
        "companion_jobs_tab",
        "companion_applied",
        "resume_upload",
        "resume_chat_create",
        "kuch_aur",
      ]).not.toContain(key);
    }
  });

  it("maps EVERY refusal topic to a reviewed line — unsafe_other is the fallback", () => {
    for (const topic of FREE_CHAT_REFUSAL_TOPICS)
      expect(FREE_CHAT_REFUSAL_LINES[topic]).toBeDefined();
    expect(FREE_CHAT_REFUSAL_LINES.unsafe_other).toBe(FREE_CHAT_COPY.REPLY_FALLBACK);
    expect(FREE_CHAT_REFUSAL_LINES.distress).toBe(FREE_CHAT_COPY.DISTRESS);
  });

  it("every line is in the reply closure — the render manifest and the interpolation guard see it", () => {
    for (const line of FREE_CHAT_REPLIES) expect(CONSTANT_REPLIES).toContain(line);
  });
});

describe("ADR-0054 §5 — the two live-news lines, as approved on 2026-10-08", () => {
  it("are served verbatim, with their Devanagari twins", () => {
    expect(FREE_CHAT_COPY.NEWS_CAP).toEqual({
      latin: "Aaj ki khabrein ho gayin. Kal phir poochhiye. Tab tak resume bana lete hain?",
      dev: "आज की ख़बरें हो गईं। कल फिर पूछिए। तब तक रिज़्यूमे बना लेते हैं?",
    });
    expect(FREE_CHAT_COPY.NEWS_UNAVAILABLE).toEqual({
      latin: "Abhi taaza khabar nahi mil paayi. Thodi der baad phir poochhiye.",
      dev: "अभी ताज़ा ख़बर नहीं मिल पाई। थोड़ी देर बाद फिर पूछिए।",
    });
  });

  it("ADR-0051's NEWS line is unchanged — it stays the answer while news is unarmed", () => {
    expect(FREE_CHAT_COPY.NEWS.latin).toBe(
      "Taaza khabar abhi nahi bata sakta. Yeh suvidha jaldi aayegi.",
    );
    expect(FREE_CHAT_REFUSAL_LINES.news).toBe(FREE_CHAT_COPY.NEWS);
  });

  it("both are in the reply closure and the read-aloud sidecar", () => {
    for (const line of [FREE_CHAT_COPY.NEWS_CAP, FREE_CHAT_COPY.NEWS_UNAVAILABLE]) {
      expect(CONSTANT_REPLIES).toContain(line.latin);
      expect(ttsTextFor(line.latin)).toBe(line.dev);
    }
  });
});

describe("ADR-0051 §11 — the reply-language lines, as approved on 2026-10-08", () => {
  it("the templates are the approved copy verbatim, one {Language} slot where a language is named", () => {
    expect(FREE_CHAT_LANGUAGE_TEMPLATES).toEqual({
      LANG_ASK: {
        latin: "Kya aage ki saari baat {Language} mein karein?",
        dev: "क्या आगे की सारी बात {Language} में करें?",
      },
      LANG_YES: {
        latin: "Theek hai, ab se {Language} mein baat karenge.",
        dev: "ठीक है, अब से {Language} में बात करेंगे।",
      },
      LANG_NO: {
        latin: "Theek hai. Aap jis bhasha mein likhenge, usi mein jawab dunga.",
        dev: "ठीक है। आप जिस भाषा में लिखेंगे, उसी में जवाब दूँगा।",
      },
    });
  });

  it("names every reply language, in the closed set's order — Hindi for hinglish, in both scripts", () => {
    expect(Object.keys(FREE_CHAT_LANGUAGE_NAMES)).toEqual([...FREE_CHAT_REPLY_LANGUAGES]);
    expect(FREE_CHAT_LANGUAGE_NAMES).toEqual({
      english: { latin: "English", dev: "अंग्रेज़ी" },
      hinglish: { latin: "Hindi", dev: "हिंदी" },
      marathi: { latin: "Marathi", dev: "मराठी" },
      gujarati: { latin: "Gujarati", dev: "गुजराती" },
      kannada: { latin: "Kannada", dev: "कन्नड़" },
      telugu: { latin: "Telugu", dev: "तेलुगु" },
      tamil: { latin: "Tamil", dev: "तमिल" },
    });
  });

  it("fills each half with its own script's name", () => {
    expect(languageAskLine("marathi")).toEqual({
      latin: "Kya aage ki saari baat Marathi mein karein?",
      dev: "क्या आगे की सारी बात मराठी में करें?",
    });
    expect(languageYesLine("hinglish")).toEqual({
      latin: "Theek hai, ab se Hindi mein baat karenge.",
      dev: "ठीक है, अब से हिंदी में बात करेंगे।",
    });
    expect(languageYesLine("english").dev).toBe("ठीक है, अब से अंग्रेज़ी में बात करेंगे।");
    expect(FREE_CHAT_LANG_NO_LINE).toBe(FREE_CHAT_LANGUAGE_TEMPLATES.LANG_NO);
  });

  it("enumerates seven asks, seven yeses and one no — every slot filled", () => {
    expect(FREE_CHAT_LANGUAGE_LINE_ENTRIES).toHaveLength(2 * FREE_CHAT_REPLY_LANGUAGES.length + 1);
    for (const [, line] of FREE_CHAT_LANGUAGE_LINE_ENTRIES) {
      expect(line.latin).not.toContain("{");
      expect(line.dev).not.toContain("{");
    }
    expect(new Set(FREE_CHAT_LANGUAGE_LINE_ENTRIES.map(([, line]) => line.latin)).size).toBe(
      FREE_CHAT_LANGUAGE_LINE_ENTRIES.length,
    );
  });

  it("the chips: 'Haan, {Language} mein' and 'Nahi'", () => {
    expect(languageYesLabel("marathi")).toBe("Haan, Marathi mein");
    expect(languageYesLabel("hinglish")).toBe("Haan, Hindi mein");
    expect(FREE_CHAT_LANG_NO_LABEL).toBe("Nahi");
    expect([FREE_CHAT_LANG_YES_KEY, FREE_CHAT_LANG_NO_KEY]).toEqual([
      "free_chat_lang_yes",
      "free_chat_lang_no",
    ]);
  });

  it("every variant is in the reply closure and the read-aloud sidecar", () => {
    const sidecar = new Map(FREE_CHAT_TTS_ENTRIES);
    for (const [, line] of FREE_CHAT_LANGUAGE_LINE_ENTRIES) {
      expect(CONSTANT_REPLIES).toContain(line.latin);
      expect(sidecar.get(line.latin)).toBe(line.dev);
      expect(ttsTextFor(line.latin)).toBe(line.dev);
    }
  });

  it("the §5.1 table itself is unchanged — the language lines are listed beside it, not in it", () => {
    expect(FREE_CHAT_COPY_ENTRIES.map(([key]) => key)).not.toContain("LANG_ASK");
    expect(FREE_CHAT_FIXED_LINE_ENTRIES.slice(0, FREE_CHAT_COPY_ENTRIES.length)).toEqual(
      FREE_CHAT_COPY_ENTRIES,
    );
    expect(FREE_CHAT_COPY.GREETING.latin).toBe(
      "Namaste, main Bada Bhai hoon. Aapka resume banane mein madad karunga. Shuru karein?",
    );
  });
});
