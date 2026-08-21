/**
 * Owner-ratified vernacular aliases that have not reached the corpus.
 *
 * ===========================================================================
 * WHY THIS IS A TEST AND NOT A PARAGRAPH
 * ===========================================================================
 * On 2026-07-16 the RVM domain owner ratified 22 vernacular aliases — `kharad` → turning,
 * `chhilai` → deburring, `ghisai` → grinding, and so on. The measurement behind that decision
 * is unusually clear: those phrases score 0.528–0.603 against the standards-only corpus, which
 * is below the 0.75 floor AND interleaved with the negatives (`biryani banana` scores 0.5427,
 * ABOVE the correct `chhilai` at 0.5284), so no threshold can rescue them. As an alias each
 * becomes an exact hit at ≈1.0.
 *
 * Five weeks later they exist only as a TypeScript constant. `WEDGE_ALIASES` has no consumer,
 * none of the 22 is in the corpus, and nothing anywhere fails because of it. The ratification
 * packet names the blocker (the SR-1 staging env), so this is a known-blocked step rather than
 * a forgotten one — but a known-blocked step with no signal becomes indistinguishable from a
 * forgotten one after a few weeks, which is what happened.
 *
 * So the delivery gap gets a voice. This does NOT demand the aliases ship — that is a corpus
 * write and a paid embed, both owner-gated. It pins the gap at its measured size so that
 * shipping them, or striking them, is a deliberate edit here rather than a silent drift.
 *
 * ===========================================================================
 * WHICH CORPUS, AND WHY IT MATTERS
 * ===========================================================================
 * These target `SKILL_CORPUS` — the 49 hand-authored seeds — NOT the D2 growth corpus in
 * `data/taxonomy/skills.jsonl`. The two are disjoint id spaces (TASK 9B: intersection 0), and
 * an earlier draft of this file checked the wrong one and failed with 15 "dangling" skills that
 * were not dangling at all.
 *
 * That distinction cuts in D6-0's favour. `SKILL_CORPUS` is exactly the set the runtime bridge
 * `ATTRIBUTE_TO_MATCH_SKILLS` covers, so these 22 aliases would improve retrieval for skills
 * that actually reach matching — unlike the 96 promotable growth skills, which reach nothing
 * (Q1, still an owner decision).
 */
import { describe, expect, it } from "vitest";

import { SKILL_CORPUS, WEDGE_ALIASES } from "@badabhai/taxonomy";

const ratified = WEDGE_ALIASES.filter((w) => w.ratified);
const norm = (s: string): string => s.trim().toLowerCase();

const corpusSkillIds = new Set(SKILL_CORPUS.map((s) => s.skillId));
const corpusAliasTexts = new Set(
  SKILL_CORPUS.flatMap((s) => (s.aliases ?? []).map((a) => norm(a.text))),
);

const delivered = ratified.filter((w) => corpusAliasTexts.has(norm(w.alias.text)));

describe("wedge alias delivery", () => {
  it("the owner ratified 22 vernacular aliases", () => {
    expect(ratified).toHaveLength(22);
  });

  it("every ratified entry targets a skill that still exists", () => {
    // If this breaks, a ratified alias points at a skill since renamed or retired, and shipping
    // the pack would fail on a foreign key — worth knowing before the seed, not during it.
    const dangling = ratified.filter((w) => !corpusSkillIds.has(w.skillId)).map((w) => w.skillId);
    expect([...new Set(dangling)]).toEqual([]);
  });

  // THE GAP. Change this in the same commit that ships them, never separately.
  it("NONE of them has reached the corpus — unshipped since 2026-07-16", () => {
    expect(delivered).toEqual([]);
  });

  it("they are all Hindi, which is why nothing in the English-only fixture would notice", () => {
    expect([...new Set(ratified.map((w) => w.alias.lang))]).toEqual(["hi"]);
  });
});
