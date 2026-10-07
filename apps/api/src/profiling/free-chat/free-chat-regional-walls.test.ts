import { describe, expect, it } from "vitest";

import { screenFreeChatAnswer } from "./free-chat-output.validator";
import {
  REGIONAL_JUDGEMENT_WORDS,
  REGIONAL_PERSONA_TOKENS,
  REGIONAL_PROMISE_TOKENS,
  REGIONAL_RESPECTFUL_YOU,
  REGIONAL_SENSITIVE_WORDS,
  REGIONAL_SURELY_WORDS,
  REGIONAL_WILL_GET_WORDS,
  regionalWallFailure,
} from "./free-chat-regional-walls";

/**
 * ADR-0051 §9 (#2126): a reply in Marathi, Gujarati, Kannada, Telugu or Tamil mixed with English
 * (Latin letters, the way Hinglish mixes Hindi and English) meets the same persona, promise,
 * sensitive-advice and rating bar as a Hinglish one — in its own words.
 */

const answer = (lines: string[], followup_chips: string[] = []) => ({ lines, followup_chips });
const failure = (lines: string[], chips: string[] = []) => {
  const out = screenFreeChatAnswer(answer(lines, chips));
  return out.kind === "reject" ? out.failure : null;
};

describe("good regional replies are served", () => {
  it.each([
    ["Tamil", "Welding nalla skill, neenga safety training eduthaa growth irukku."],
    ["Telugu", "Meeru CNC nerchukunte factory lo manchi demand undi."],
    ["Kannada", "Neevu ITI certificate tagondre fitter kelasakke help aagutte."],
    ["Marathi", "Tumhi welding shikla tar Pune madhe kaam milnyachi shakyata aahe."],
    ["Gujarati", "Tame electrician no course karsho to kaam ma madad thase."],
    ["a Hinglish reply, unchanged", "Welding seekhna har factory mein kaam aata hai."],
  ])("%s: %j", (_language, line) => {
    expect(failure([line])).toBeNull();
  });

  it("'kandippa' alone is advice, not a promise — as 'zaroor try kijiye' is", () => {
    expect(failure(["Kandippa try pannunga, practice mukkiyam."])).toBeNull();
  });
});

describe("each wall, in the regional words", () => {
  it.each([
    ["Tamil familiar address", "Thambi, welding seekhunga.", "persona"],
    ["Tamil informal you", "Nee welding padikkalaam.", "persona"],
    ["Telugu informal you", "Nuvvu CNC nerchuko.", "persona"],
    ["Kannada familiar address", "Maga, ITI maadu.", "persona"],
    ["Marathi informal you", "Tula kaam milel.", "persona"],
    ["Gujarati informal you", "Tane kaam madse.", "persona"],
    ["Gujarati pakka", "Kaam pakku madse.", "promise"],
    ["Tamil will-surely-get", "Velai kandippa kidaikkum.", "promise"],
    ["Telugu will-surely-get", "Job khachitanga vastundi.", "promise"],
    ["Kannada will-surely-get", "Kelasa khanditavagi sigutte.", "promise"],
    ["Marathi will-surely-get", "Naukri nakki milel.", "promise"],
    ["Gujarati will-surely-get", "Nokri chokkas malse.", "promise"],
    ["Tamil medicine", "Indha marundhu saapdunga.", "sensitive_advice"],
    ["Telugu loan", "Bank nunchi appu teesukondi.", "sensitive_advice"],
    ["Kannada court", "Nyayalaya ge hogi.", "sensitive_advice"],
    ["Marathi loan", "Karj ghya.", "sensitive_advice"],
    ["Gujarati medicine", "Aa dava lo.", "sensitive_advice"],
    ["Tamil rating", "Neenga nalla worker.", "worker_rating"],
    ["Telugu rating", "Meeru best.", "worker_rating"],
    ["Marathi rating", "Tumhi kamjor aahat.", "worker_rating"],
    ["Gujarati rating", "Tame saara chho.", "worker_rating"],
  ])("%s: %j → %s", (_what, line, expected) => {
    expect(failure([line])).toBe(expected);
  });

  it("a chip carrying a regional word rejects the whole answer, even one the length rule drops", () => {
    expect(failure(["Welding seekhiye."], ["machan tips"])).toBe("persona");
    expect(failure(["Welding seekhiye."], ["kandippa velai kidaikkum ithu nichayam"])).toBe(
      "promise",
    );
  });

  it("matches whole words, case- and accent-insensitively", () => {
    expect(regionalWallFailure("ANNA")).toBe("persona");
    expect(regionalWallFailure("Ánna")).toBe("persona");
    // "annual" and "tamed" carry a listed word inside them; neither is the word.
    expect(regionalWallFailure("annual training")).toBeNull();
    expect(regionalWallFailure("tamed")).toBeNull();
  });

  it("a rating needs the respectful 'you' DIRECTLY before the judgement word", () => {
    expect(regionalWallFailure("neenga nalla")).toBe("worker_rating");
    expect(regionalWallFailure("nalla skill, neenga practice pannunga")).toBeNull();
  });
});

describe("the lists stay closed and well formed", () => {
  const lists = {
    REGIONAL_PERSONA_TOKENS,
    REGIONAL_PROMISE_TOKENS,
    REGIONAL_SURELY_WORDS,
    REGIONAL_WILL_GET_WORDS,
    REGIONAL_SENSITIVE_WORDS,
    REGIONAL_RESPECTFUL_YOU,
    REGIONAL_JUDGEMENT_WORDS,
  };

  it.each(Object.entries(lists))("%s: lowercase Latin single words, no duplicates", (_n, list) => {
    expect(list.length).toBeGreaterThan(0);
    expect(new Set(list).size).toBe(list.length);
    for (const word of list) expect(word).toMatch(/^[a-z]+$/);
  });

  it("no word the reply prompts ASK FOR is banned", () => {
    const banned = new Set([...REGIONAL_PERSONA_TOKENS, ...REGIONAL_SENSITIVE_WORDS]);
    for (const asked of REGIONAL_RESPECTFUL_YOU) expect(banned.has(asked)).toBe(false);
    for (const asked of ["aap", "unga", "mee", "nimma", "tumcha"]) {
      expect(banned.has(asked)).toBe(false);
    }
  });
});
