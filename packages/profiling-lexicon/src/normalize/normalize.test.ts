/**
 * Occupation-normalizer tests.
 *
 * The properties here are not stylistic — each one is a defect that would be SILENT in
 * production. A normalizer that drifts, that returns empty, or that is not idempotent
 * does not throw: it just makes L0 exact-match retrieval quietly return nothing, and
 * every profiling turn falls through to a paid embedding call.
 */
import { describe, expect, it } from "vitest";

import { normalizeOccupationText, normalizeOccupationTextTraced, skeletonKey } from "./index";

describe("normalizeOccupationText", () => {
  it("lowercases, NFKC-folds and collapses whitespace", () => {
    expect(normalizeOccupationText("  Welder,   Gas  ")).toBe("welder gas");
    // NFKC maps the fullwidth forms onto ASCII — a paste from a PDF must not fork the key.
    expect(normalizeOccupationText("ＷＥＬＤＥＲ")).toBe("welder");
  });

  it("keeps `-` and `/` INSIDE a word but drops them at the edges", () => {
    // "gas/arc" is one concept; a trailing dash is punctuation.
    expect(normalizeOccupationText("Gas/Arc Welder -")).toBe("gas/arc welder");
    expect(normalizeOccupationText("re-roller")).toBe("re-roller");
    expect(normalizeOccupationText("/slash/ -dash-")).toBe("slash dash");
  });

  it("strips the multi-token particles a worker actually uses", () => {
    expect(normalizeOccupationText("kharad ka kaam karta hun")).toBe("kharad");
    expect(normalizeOccupationText("silai ka kaam")).toBe("silai");
    expect(normalizeOccupationText("welding karta hoon")).toBe("welding");
  });

  it("strips `wala/wale/wali` whether spaced or glued to the stem", () => {
    expect(normalizeOccupationText("silai wala")).toBe("silai");
    expect(normalizeOccupationText("silaiwala")).toBe("silai");
    expect(normalizeOccupationText("rickshaw wali")).toBe("rickshaw");
  });

  it("NEVER strips a particle as a substring — only as a whole token or a guarded suffix", () => {
    // `ke` is a particle; `kekada` is a word. A substring strip would gut it.
    expect(normalizeOccupationText("kekada")).toBe("kekada");
    // `kam` is a particle; `kamgar` is not.
    expect(normalizeOccupationText("kamgar")).toBe("kamgar");
    // Stem shorter than minStemLength (3) — the suffix strip must decline.
    expect(normalizeOccupationText("wala")).toBe("wala");
  });

  it("never returns empty when the input had any kept character", () => {
    // All-particle input falls back to its pre-particle form. An empty text_norm would
    // collide with every other empty one under 0068's NULLS NOT DISTINCT unique index.
    expect(normalizeOccupationText("ka kaam")).toBe("ka kaam");
    expect(normalizeOccupationText("karta hun")).toBe("karta hun");
    // Genuinely empty input stays empty — there is nothing to preserve.
    expect(normalizeOccupationText("   ")).toBe("");
    expect(normalizeOccupationText("!!!")).toBe("");
  });

  it("is IDEMPOTENT — the seeder and the query path may both apply it", () => {
    const cases = [
      "Welder, Gas",
      "kharad ka kaam karta hun",
      "silaiwala",
      "Gas/Arc Welder -",
      "मिस्त्री का काम",
    ];
    for (const input of cases) {
      const once = normalizeOccupationText(input);
      expect(normalizeOccupationText(once), `not idempotent for ${input}`).toBe(once);
    }
  });

  it("keeps Devanagari and does NOT transliterate it", () => {
    // Both scripts exist as separate alias rows by design — folding them here would
    // silently merge two rows the catalogue deliberately keeps apart.
    expect(normalizeOccupationText("मिस्त्री")).toBe("मिस्त्री");
    expect(normalizeOccupationText("बढ़ई का काम")).toBe("बढ़ई");
  });

  it("drops the danda but keeps Devanagari digits", () => {
    expect(normalizeOccupationText("मिस्त्री।")).toBe("मिस्त्री");
    expect(normalizeOccupationText("ग्रेड २")).toBe("ग्रेड २");
  });
});

describe("normalizeOccupationTextTraced", () => {
  it("reports what was stripped, with the LONGEST phrase winning", () => {
    // `ka kaam karta hun` is listed as one 4-token phrase and must be preferred over the
    // 2-token `ka kaam` + `karta hun` pair. Pinning this is what stops a future edit from
    // reordering the list and silently changing which particles get reported.
    const trace = normalizeOccupationTextTraced("kharad ka kaam karta hun");
    expect(trace.normalized).toBe("kharad");
    expect(trace.strippedParticles).toEqual(["ka kaam karta hun"]);
    expect(trace.input).toBe("kharad ka kaam karta hun");
  });

  it("falls back to shorter phrases when the long one does not match", () => {
    const trace = normalizeOccupationTextTraced("silai ka kaam");
    expect(trace.normalized).toBe("silai");
    expect(trace.strippedParticles).toEqual(["ka kaam"]);
  });

  it("reports nothing stripped when the empty-guard fired", () => {
    // The guard restores the pre-particle form, so claiming particles were removed
    // would make the audit output contradict the value actually written.
    const trace = normalizeOccupationTextTraced("ka kaam");
    expect(trace.normalized).toBe("ka kaam");
    expect(trace.strippedParticles).toEqual([]);
  });

  it("classifies script", () => {
    expect(normalizeOccupationTextTraced("welder").script).toBe("latin");
    expect(normalizeOccupationTextTraced("मिस्त्री").script).toBe("devanagari");
    expect(normalizeOccupationTextTraced("मिस्त्री welder").script).toBe("mixed");
  });
});

describe("skeletonKey", () => {
  it("reaches ONE key for every spelling family the contract promises", () => {
    // These five are the reason the folding is a consonant skeleton and not the
    // vowel-substitution rules originally described — those scored 2/5 here.
    const families = [
      ["welder", "waelder", "velder"],
      ["kharad", "kharaad"],
      ["silai", "silaai"],
      ["mistri", "mistry"],
      ["driver", "draiver"],
    ];
    for (const family of families) {
      const keys = new Set(family.map((word) => skeletonKey(normalizeOccupationText(word))));
      expect(keys.size, `${family.join("/")} -> ${[...keys].join(" | ")}`).toBe(1);
    }
  });

  it("keeps a word-initial vowel, which is informative", () => {
    expect(skeletonKey("operator")).toBe("oprtr");
    expect(skeletonKey("electrician")).toBe("elctrcn");
  });

  it("folds digraphs before dropping vowels", () => {
    expect(skeletonKey("khana")).toBe(skeletonKey("kana"));
    expect(skeletonKey("shilpi")).toBe(skeletonKey("silpi"));
  });

  it("collapses doubled characters", () => {
    expect(skeletonKey("hellper")).toBe(skeletonKey("helper"));
  });

  it("still separates genuinely different trades", () => {
    // The fold is lossy on purpose, but it must not turn the catalogue into one bucket.
    const distinct = ["welder", "fitter", "plumber", "tailor", "driver", "cook", "mason"];
    const keys = new Set(distinct.map((word) => skeletonKey(normalizeOccupationText(word))));
    expect(keys.size).toBe(distinct.length);
  });

  it("is a no-op on Devanagari — the fold classes are Latin-only", () => {
    expect(skeletonKey("मिस्त्री")).toBe("मिस्त्री");
  });

  it("returns empty for empty input rather than throwing", () => {
    expect(skeletonKey("")).toBe("");
  });
});
