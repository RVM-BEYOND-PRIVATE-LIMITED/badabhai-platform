/**
 * The ratified vernacular aliases — delivery path, targets, and latent collisions.
 *
 * ===========================================================================
 * THIS FILE PREVIOUSLY ASSERTED SOMETHING FALSE
 * ===========================================================================
 * Its first version claimed the 22 RVM-ratified aliases were "unshipped since 2026-07-16" and
 * pinned that as a tripwire. **They were shipped.** 21 rows were created on 2026-07-16 — the
 * ratification date — and `drawing padhna` on 2026-08-20, when TD-01 repointed it from
 * `skill_cad_interpretation` to `skill_drawing_reading`. All 22 carry a `gemini-embedding-001`
 * vector and every one of the 16 target skills is `active`. Measured read-only 2026-08-24.
 *
 * Existing is not the same as working: only 8 of the 22 are reachable on the slug production
 * actually queries, and two produce a false assignment. See `anchor-path-retrieval.test.ts`.
 *
 * The error is worth keeping written down, because it is a reasoning failure, not a typo:
 *
 *   - I checked `SKILL_CORPUS`'s literal alias arrays and `data/taxonomy/skills.jsonl`, found
 *     the phrases in neither, and concluded "undelivered". Neither file is where a delivered
 *     alias lives — `skill_alias` is, and I never queried it.
 *   - I grepped for the identifier `WEDGE_ALIASES` to find a consumer and found none. The
 *     seeder consumes the ACCESSOR, `ratifiedWedgeAliases()`, so the grep missed a wire that
 *     was fully connected.
 *   - `skill-vernacular-ratification-packet.md` said seed/embed were "PENDING the SR-1 staging
 *     env". That line was five weeks stale and corroborated the wrong conclusion; it now
 *     carries a dated status banner.
 *
 * A tripwire asserting a false state is worse than no tripwire, so this file now pins the
 * things that are both TRUE and worth protecting.
 *
 * ===========================================================================
 * WHAT IT PROTECTS NOW
 * ===========================================================================
 * 1. The ratified set is intact and targets live skills.
 * 2. **The delivery path stays wired.** The seeder must keep consuming
 *    `ratifiedWedgeAliases()` — if that call is removed, a future ratified alias silently
 *    stops shipping and nothing else would notice. This is the invariant whose absence I
 *    mistakenly believed I had found.
 * 3. Latent normalization collisions are pinned at their measured size.
 *
 * A static test cannot assert what production holds. That measurement is in
 * `docs/registers/taxonomy-decisions/d60-anchor-path-retrieval.json`, with `measured_at`, and
 * the status correction is in `docs/registers/skill-vernacular-ratification-packet.md`.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { normalizeOccupationText } from "@badabhai/profiling-lexicon";
import { ratifiedWedgeAliases, SKILL_CORPUS, WEDGE_ALIASES } from "@badabhai/taxonomy";

const ratified = WEDGE_ALIASES.filter((w) => w.ratified);
const norm = (s: string): string => normalizeOccupationText(s);

const corpusSkillIds = new Set(SKILL_CORPUS.map((s) => s.skillId));

describe("the ratified set", () => {
  it("is 22 entries, all Hindi", () => {
    expect(ratified).toHaveLength(22);
    expect([...new Set(ratified.map((w) => w.alias.lang))]).toEqual(["hi"]);
  });

  it("targets 16 skills, every one live in SKILL_CORPUS", () => {
    const targets = new Set(ratified.map((w) => w.skillId));
    expect(targets.size).toBe(16);
    expect([...targets].filter((t) => !corpusSkillIds.has(t))).toEqual([]);
  });

  it("contains no duplicate (skill, RAW text) pair — the key row identity uses", () => {
    // The deterministic alias id is built from the raw `text`, so this is the key that decides
    // whether two entries are one row. A duplicate here would silently seed one row fewer than
    // the ratification recorded.
    const keys = ratified.map((w) => `${w.skillId}|${w.alias.text}`);
    expect(keys.length - new Set(keys).size).toBe(0);
  });

  it("but TWO pairs collapse under normalization, which is expected and benign", () => {
    // `kharad` / `kharad ka kaam` and `ghisai` / `ghisai ka kaam` differ only by a stripped
    // particle. Both rows exist in production and both carry their own vector, because
    // identity is the raw text. They converge only in `text_norm`, where `is_searchable`
    // election is designed to pick one — the same mechanism that already handles the 70
    // punctuation-variant pairs on the domain side.
    //
    // Asserted rather than left implicit: an author seeing "2 duplicates" in a normalizer
    // report should find it already explained, not investigate it again.
    const byNormKey = new Map<string, string[]>();
    for (const w of ratified) {
      const k = `${w.skillId}|${norm(w.alias.text)}`;
      byNormKey.set(k, [...(byNormKey.get(k) ?? []), w.alias.text]);
    }
    const collapsing = [...byNormKey.values()].filter((v) => v.length > 1).sort();
    expect(collapsing).toEqual([
      ["ghisai", "ghisai ka kaam"],
      ["kharad", "kharad ka kaam"],
    ]);
  });

  it("`ratifiedWedgeAliases()` returns exactly the ratified subset", () => {
    expect(ratifiedWedgeAliases().map((w) => w.alias.text).sort()).toEqual(
      ratified.map((w) => w.alias.text).sort(),
    );
  });
});

describe("the delivery path stays wired", () => {
  // THE REAL INVARIANT. The seeder is what carries a ratified alias into production; if this
  // call disappears, ratification becomes a document that changes nothing. `replay-path-a.ts`
  // and `td01-review-pack.ts` also call the accessor, but neither WRITES, so neither would
  // fail — losing the seeder's call is silent.
  const seeder = readFileSync(join(__dirname, "seed-skills.ts"), "utf8");

  it("seed-skills.ts consumes ratifiedWedgeAliases()", () => {
    expect(seeder).toContain("ratifiedWedgeAliases()");
  });

  it("it validates the wedge against the corpus before writing", () => {
    expect(seeder).toContain("validateWedgeAliases");
  });

  it("the planner counts wedge aliases as plannable rows", () => {
    // `planSeedSkills` takes the wedge as its own parameter and folds it into the alias ids,
    // which is what makes `--plan` able to show them before a write.
    expect(seeder).toMatch(/for \(const w of wedge\)/);
  });
});

describe("latent normalization collisions", () => {
  // `skill_alias.text_norm` is NOT read by retrieval today — the skill path is ANN-only
  // (D-6 §1). These collisions are therefore LATENT: they materialize if a skill-side L0
  // tier is ever built, or when a skill-alias normalizer elects `is_searchable`.
  // Pinned so the set cannot grow unnoticed between now and then.
  interface GrowthRow {
    skill_id: string;
    aliases?: { text: string }[];
  }
  const growth: GrowthRow[] = readFileSync(
    join(__dirname, "..", "data", "taxonomy", "skills.jsonl"),
    "utf8",
  )
    .split(/\r?\n/)
    .filter((l) => l.trim() !== "" && !l.startsWith("#"))
    .map((l) => JSON.parse(l) as GrowthRow);

  const rows: { skill: string; text: string }[] = [
    ...SKILL_CORPUS.flatMap((s) => (s.aliases ?? []).map((a) => ({ skill: s.skillId, text: a.text }))),
    ...growth.flatMap((r) => (r.aliases ?? []).map((a) => ({ skill: r.skill_id, text: a.text }))),
    ...ratified.map((w) => ({ skill: w.skillId, text: w.alias.text })),
  ];

  const byNorm = new Map<string, Set<string>>();
  for (const r of rows) {
    byNorm.set(norm(r.text), (byNorm.get(norm(r.text)) ?? new Set()).add(r.skill));
  }
  const colliding = [...byNorm.entries()]
    .filter(([, skills]) => skills.size > 1)
    .map(([n]) => n)
    .sort();

  it("there are exactly eight, and seven are the TD-01 merge triangle", () => {
    expect(colliding).toEqual([
      "blueprint reading",
      "cad",
      "drawing reading",
      "finishing",
      "gd t",
      "geometric dimensioning and tolerancing",
      "read engineering drawings",
      "technical drawing",
    ]);
  });

  it("only ONE involves a ratified wedge alias", () => {
    // `finishing ka kaam` -> `finishing` (particles stripped) lands on the same key as
    // `skill_furniture_finishing`'s alias. Recorded rather than resolved: the ruling that put
    // `chhilai`/`finishing ka kaam` on `skill_deburring` was the owner's (Q-A), and re-pointing
    // it is a taxonomy decision, not a test's business.
    const wedgeNorms = new Set(ratified.map((w) => norm(w.alias.text)));
    expect(colliding.filter((c) => wedgeNorms.has(c))).toEqual(["finishing"]);
  });

  it("seven of the eight resolve when the TD-01 deprecations are seeded", () => {
    // gdt_reading and cad_interpretation are deprecated in the corpus and still active in
    // production; both retrieval paths filter `s.status = 'active'`, so seeding the
    // deprecation removes them from retrieval and the collision with them stops mattering.
    const td01 = new Set(["skill_gdt_reading", "skill_cad_interpretation"]);
    const survivors = colliding.filter((c) => {
      const skills = byNorm.get(c) ?? new Set<string>();
      return [...skills].filter((s) => !td01.has(s)).length > 1;
    });
    expect(survivors).toEqual(["finishing"]);
  });
});
