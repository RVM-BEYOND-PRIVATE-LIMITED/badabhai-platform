/**
 * The TypeScript half of the dual-language parity gate.
 *
 * `apps/ai-service/tests/test_lexicon_parity.py` asserts the SAME corpus against the Python
 * detectors. Changing a case, a cue list, or the classification precedence on one side only
 * turns the other side red — which is the entire reason the data lives in JSON.
 */

import { describe, expect, it } from "vitest";

import { loadUtteranceFixtures } from "../internal/fixtures.js";
import {
  asksQuestionBack,
  classifyUtterance,
  hasFirstPersonClaim,
  isAbusive,
  isCorrection,
  isDontKnow,
  isHardship,
} from "./index.js";

const PREDICATE_BY_NAME: Readonly<Record<string, (text: string) => boolean>> = {
  isDontKnow,
  isCorrection,
  isHardship,
  isAbusive,
  asksQuestionBack,
  hasFirstPersonClaim,
};

const fixtures = loadUtteranceFixtures();

describe("parity corpus", () => {
  it("holds at least the 300 cases Phase 3 requires", () => {
    // Pinned so the corpus cannot be quietly shrunk to make a failure go away. Deleting cases
    // is the cheapest possible way to turn this suite green and the most expensive to notice.
    expect(fixtures.length).toBeGreaterThanOrEqual(300);
  });

  it("has unique ids and unique texts", () => {
    // A duplicated text is two cases that can disagree; a duplicated id makes failure output
    // ambiguous. Both are cheap to prevent and annoying to debug later.
    expect(new Set(fixtures.map((f) => f.id)).size).toBe(fixtures.length);
    expect(new Set(fixtures.map((f) => f.text)).size).toBe(fixtures.length);
  });

  it("covers every utterance class the orchestrator branches on", () => {
    const seen = new Set(fixtures.map((f) => f.cls));
    for (const cls of [
      "dont_know",
      "correction",
      "hardship",
      "question_back",
      "abusive",
      "empty",
      "off_topic",
    ]) {
      expect(seen, `no fixture produces cls=${cls}`).toContain(cls);
    }
  });

  it("proves every detector both fires and stays silent somewhere", () => {
    // A predicate that is `false` on all 345 cases would pass every per-case assertion below
    // while being completely broken. This is the guard against a vacuously green suite.
    for (const name of Object.keys(PREDICATE_BY_NAME)) {
      const values = fixtures.map((f) => f.predicates[name]);
      expect(values, `${name} never expected true`).toContain(true);
      expect(values, `${name} never expected false`).toContain(false);
    }
  });
});

describe("classifyUtterance matches the corpus", () => {
  it.each(fixtures.map((f) => [f.id, f] as const))("%s", (_id, fixture) => {
    expect(classifyUtterance(fixture.text).cls, describeCase(fixture)).toBe(fixture.cls);
  });
});

describe("predicates match the corpus", () => {
  it.each(fixtures.map((f) => [f.id, f] as const))("%s", (_id, fixture) => {
    for (const [name, expected] of Object.entries(fixture.predicates)) {
      const fn = PREDICATE_BY_NAME[name];
      expect(fn, `corpus references unknown predicate "${name}"`).toBeDefined();
      expect(fn?.(fixture.text), `${name} — ${describeCase(fixture)}`).toBe(expected);
    }
  });
});

/** Failure context. Includes the note, because the note is usually the reason the case exists. */
function describeCase(fixture: { id: string; text: string; note?: string }): string {
  return `${fixture.id} ${JSON.stringify(fixture.text)}${fixture.note ? ` — ${fixture.note}` : ""}`;
}

describe("detector semantics that the corpus alone would not pin", () => {
  it("treats a missing or empty message as empty rather than throwing", () => {
    expect(classifyUtterance("").cls).toBe("empty");
    expect(isDontKnow("")).toBe(false);
    expect(isAbusive("")).toBe(false);
  });

  it("puts correction ahead of dont_know and question_back", () => {
    // Both of these satisfy two classes at once. Correction wins because it carries a value,
    // and losing it leaves the profile holding a number the worker explicitly retracted.
    expect(classifyUtterance("nahi nahi, pata nahi").cls).toBe("correction");
    expect(classifyUtterance("nahi nahi, 7 saal — kaam milega kya?").cls).toBe("correction");
  });

  it("does not read a single 'nahi' as a correction", () => {
    // Only the DOUBLED forms are markers. "nahi bhai" opens a huge share of worker replies,
    // and treating it as a self-correction would let any passing denial overwrite a collected
    // value for a topic that is not even on screen.
    expect(isCorrection("nahi bhai, 7 saal")).toBe(false);
    expect(classifyUtterance("nahi bhai, 7 saal — kaam milega kya?").cls).toBe("question_back");
  });

  it("puts abuse ahead of everything, even when the message also corrects", () => {
    expect(classifyUtterance("galat likha bhosdike").cls).toBe("abusive");
  });

  it("requires BOTH conjuncts for a question-back", () => {
    // The prospect cue alone fires on a worker ANSWERING the availability question.
    expect(asksQuestionBack("abhi job kar raha hu, 1 mahina lagega")).toBe(false);
    expect(asksQuestionBack("job milegi kya?")).toBe(true);
  });

  it("matches correction markers as substrings, not whole words", () => {
    // "correct kar" must cover "karo" and "karna". Upgrading this to word-boundary matching
    // would silently drop the two most common phrasings.
    expect(isCorrection("correct karo")).toBe(true);
    expect(isCorrection("correct karna hai")).toBe(true);
  });

  it("lets a third-party blocker beat a first-person marker", () => {
    expect(hasFirstPersonClaim("mera friend CNC chalata hai")).toBe(false);
    expect(hasFirstPersonClaim("main CNC chalata hu")).toBe(true);
  });

  it("closes a match before a Devanagari danda", () => {
    // REGRESSION. The danda U+0964 sits inside the Devanagari block but is PUNCTUATION, so
    // Python's `\b` treats it as a boundary. A boundary class that swallowed the whole block
    // made it a word character and killed the trailing boundary — measured, 15 detectors.
    expect(isDontKnow("idk।")).toBe(true);
    expect(isHardship("kaam nahi mil raha।")).toBe(true);
    expect(isAbusive("chutiya।")).toBe(true);
  });

  it("still refuses a match inside a longer word", () => {
    // The flip side of the boundary fix: loosening it must not turn these into substring hits.
    expect(isDontKnow("idkx")).toBe(false);
    expect(isDontKnow("xidk")).toBe(false);
    // Only the roots carrying an explicit inflection tail absorb a suffix. `bitch` has none,
    // so "bitchy" does NOT match — preserved verbatim from the Python side, where some roots
    // carried a `\w*` tail and some deliberately did not.
    expect(isAbusive("bitchy")).toBe(false);
    expect(isAbusive("fucking")).toBe(true);
    expect(isAbusive("bhosdike")).toBe(true);
  });

  it("keeps the pre-existing zero-width `\\s*` joins", () => {
    // "no idea" is written `no\s*idea`, and `\s*` permits ZERO whitespace, so the run-together
    // spellings match. Verified identical in Python before and after the extraction — pinned
    // here because it looks like a bug and is not one, and "tightening" it would be a
    // behaviour change smuggled in under a refactor.
    expect(isDontKnow("noidea")).toBe(true);
    expect(isDontKnow("dontknow")).toBe(true);
    expect(isDontKnow("donotknow")).toBe(true);
  });

  it("is stateless across repeated calls", () => {
    // A `g` flag would carry `lastIndex` between calls and make the second call disagree with
    // the first. The orchestrator's purity property tests depend on this not happening.
    for (let i = 0; i < 3; i += 1) {
      expect(isDontKnow("pata nahi")).toBe(true);
      expect(isAbusive("chutiya")).toBe(true);
    }
  });
});
