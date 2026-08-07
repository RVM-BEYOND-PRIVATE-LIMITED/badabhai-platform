/**
 * The eval harness and the live index must resolve identically.
 *
 * WHY THIS FILE EXISTS, PLAINLY. Phase 4 extracted `resolveFamily` so "Phase 7's service
 * can use it", never exported it, and wrote a doc-comment claiming a parity test asserted
 * the two agreed. There was no such test. A second copy appeared in the service, the two
 * guarded ISCO codes differently, and one worker resolved to a real family in the deploy
 * gate and to universal in the engine — silently, with no error on either side.
 *
 * The same trap is open here and is worse: `packages/db`'s eval harness publishes the
 * Phase 2 acceptance number (L0+L1 ≥ 60% with vectors off, currently 97.0%), and
 * `OccupationIndexService` is what actually answers workers. If those two search
 * differently, that number describes software nobody runs.
 *
 * They share `buildSpanIndex`/`matchSpan` from `@badabhai/profiling-lexicon` so they
 * CANNOT diverge by construction. This test is the guard on that construction: it feeds
 * one corpus through both assembly paths and asserts the same answer. Deleting the shared
 * import and pasting the algorithm back into either side turns this red.
 */
import { describe, expect, it } from "vitest";
import { buildOccupationIndex, resolveOccupation } from "@badabhai/db";
import { matchSpan } from "@badabhai/profiling-lexicon";

import { buildOccupationSnapshot } from "./occupation-index";

/** One corpus, expressed the way each side expects to receive it. */
const DOMAINS = [
  { id: "jd_weld", unit: "7212", aliases: ["welder", "gas welder", "welding"] },
  { id: "jd_tailor", unit: "7531", aliases: ["darzi", "silai", "tailor"] },
  { id: "jd_mason", unit: "7112", aliases: ["mistri", "raj mistri"] },
  { id: "jd_lathe", unit: "7223", aliases: ["kharad", "lathe operator", "turner"] },
  { id: "jd_driver", unit: "8322", aliases: ["driver", "gaadi chalata"] },
];

/**
 * Utterances chosen to exercise every branch the two paths could disagree on: a bare
 * word, a long span that must beat a short one, a misspelling that only L1 reaches, a
 * particle-heavy sentence, and two misses.
 */
const UTTERANCES = [
  "welder",
  "main gas welder hoon",
  "waelder ka kaam karta hoon",
  "silai ka kaam karta hun",
  "mistri",
  "kharad chalata hun",
  "main pichhle char saal se welding ka kaam karta hoon",
  "gaadi chalata hoon",
  "darzi",
  "turner",
  "",
  "aaj mausam accha hai",
  "kuch bhi nahi",
];

describe("eval harness / live index parity", () => {
  const evalIndex = buildOccupationIndex(
    DOMAINS.map((d) => ({
      jobDomainId: d.id,
      isco_unit: d.unit,
      selectable: true,
      aliases: d.aliases.map((text) => ({ text, source: "rvm" })),
      // The harness reads only the four fields above; the corpus type carries more.
    })) as unknown as Parameters<typeof buildOccupationIndex>[0],
  );

  const snapshot = buildOccupationSnapshot({
    catalogVersion: "parity",
    domains: DOMAINS.map((d) => ({
      jobDomainId: d.id,
      labelEn: d.id,
      labelHi: null,
      iscoUnitCode: d.unit,
    })),
    aliases: DOMAINS.flatMap((d) => d.aliases.map((text) => ({ jobDomainId: d.id, text }))),
    bindings: [{ familyId: "fam_any", isUniversal: true }],
  });

  it("builds the SAME span index from both assembly paths", () => {
    expect([...snapshot.spans.exact.keys()].sort()).toEqual([...evalIndex.spans.exact.keys()].sort());
    expect([...snapshot.spans.skeleton.keys()].sort()).toEqual(
      [...evalIndex.spans.skeleton.keys()].sort(),
    );
    expect(snapshot.spans.maxSpanTokens).toBe(evalIndex.spans.maxSpanTokens);
  });

  it.each(UTTERANCES)("resolves %j identically on both paths", (utterance) => {
    const fromEval = resolveOccupation(evalIndex, utterance);
    const fromLive = matchSpan(snapshot.spans, utterance);

    if (fromEval === null) {
      expect(fromLive).toBeNull();
      return;
    }
    expect(fromLive).not.toBeNull();
    expect(fromLive?.layer).toBe(fromEval.layer);
    expect(fromLive?.span).toBe(fromEval.span);
    expect(fromLive?.spanTokens).toBe(fromEval.spanTokens);
    // The harness narrows to one winner for scoring; the live path keeps every claimant
    // so the family margin can refuse to guess. The winner must still be the same one.
    expect(fromLive?.ids[0]).toBe(fromEval.jobDomainId);
  });

  it("keeps EVERY claimant live where the harness keeps one", () => {
    // Not a divergence — a deliberate difference, pinned so it stays deliberate. If the
    // live path ever narrowed to one id, disambiguation would lose the second option and
    // the engine would auto-pin a coin flip instead of asking.
    const shared = buildOccupationSnapshot({
      catalogVersion: "parity",
      domains: [
        { jobDomainId: "jd_a", labelEn: "A", labelHi: null, iscoUnitCode: "7112" },
        { jobDomainId: "jd_b", labelEn: "B", labelHi: null, iscoUnitCode: "7233" },
      ],
      aliases: [
        { jobDomainId: "jd_a", text: "mistri" },
        { jobDomainId: "jd_b", text: "mistri" },
      ],
      bindings: [{ familyId: "fam_any", isUniversal: true }],
    });
    expect(matchSpan(shared.spans, "mistri")?.ids).toEqual(["jd_a", "jd_b"]);
  });
});
