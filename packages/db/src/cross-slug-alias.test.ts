/**
 * Decision 1 (`cnc-programming`) — **option A, accept the loss** — held in place by the one
 * property that made B expensive.
 *
 * ===========================================================================
 * WHAT WAS DECIDED, AND WHAT THIS FILE IS FOR
 * ===========================================================================
 * S3-D deprecates `skill_cad_interpretation` in favour of `skill_drawing_reading`, and the two
 * sit under DIFFERENT legacy slugs (`cnc-programming` / `cnc-machining`). The retag moves the
 * aliases onto the terminal skill and the terminal's slug travels with them, so a caller scoped
 * to `cnc-programming` loses three embedded drawing-reading candidate rows and gains nothing.
 *
 * Option B was to write a COMPATIBILITY ALIAS: an alias row whose `domain_id` is a slug OTHER
 * than its own skill's. The owner chose **A** on 2026-08-20 — accept the loss — and the deciding
 * measurement was that B is not "one additive row":
 *
 *   - `SKILL_CANONICALIZE_ENABLED=false`, so **0 workers** reach Path B today;
 *   - the loss is **3 rows**, not 4 (`drawing padhna` has `embedding IS NULL` and was never a
 *     candidate, so Hindi drawing-reading is unserved under this slug ALREADY);
 *   - and no shipped writer can express the row at all — which is what this file pins.
 *
 * ===========================================================================
 * THE INVARIANT
 * ===========================================================================
 * EVERY `skill_alias` writer derives `domain_id` from the alias's OWN parent skill. None of them
 * can be handed an arbitrary slug. So a cross-slug compatibility alias is not a data entry — it
 * needs a dedicated runner, its own embed call (`db:embed:skills` has no per-row scope), and it
 * establishes a data shape with no precedent in this repository.
 *
 * WHEN THIS TEST FAILS, DECISION 1 IS BACK OPEN. A new writer that sets `domainId` from
 * anything other than the parent skill IS option B's machinery, whatever it was added for. That
 * is the moment to re-read `phase-9-cnc-programming-decision.md` rather than to widen the
 * allow-list below.
 *
 * Source-level, deliberately: the property is about what the CODE can express, and no runtime
 * assertion can observe a row nobody is able to write.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const SRC = __dirname;

/** Files holding an `.insert(skillAliases)` call, found rather than listed. */
function aliasWriters(): string[] {
  return readdirSync(SRC)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .filter((f) => readFileSync(join(SRC, f), "utf8").includes(".insert(skillAliases)"));
}

/**
 * The `domainId:` expressions a writer is allowed to use, each with why it is safe.
 *
 * Every one of them resolves to the PARENT SKILL's slug, to NULL, or to a value the database
 * already had. None takes a slug from an argument, a flag, or a corpus row that is not the
 * alias's own skill.
 */
const ALLOWED_DOMAIN_EXPRESSIONS: Record<string, string> = {
  "domainId: s.domainId": "seed-skills: the corpus row being seeded IS the parent skill",
  "domainId: domainBySkill.get(w.skillId)!":
    "seed-skills wedge aliases: looked up by the alias's own skillId",
  "domainId: targetDomain":
    "retag-skills: `byId.get(terminal)?.domainId ?? a.domainId` — the TERMINAL skill's slug, " +
    "which is exactly the behaviour that causes the cnc-programming loss and is the thing " +
    "option A accepts",
  "domainId: a.domainId":
    "s3d-rollback: restores the slug recorded in the rollback artifact — a value the database " +
    "already had, never a new one",
  "domainId: null":
    "seed-domain-skills: the growth corpus is scoped through `job_domain_skill`, and the 11 " +
    "legacy slugs are a disjoint id space, so picking one would be inventing a scope",
  "domainId: presentSkills.get(a.skillId) ?? null":
    "seed-domain-skills: looked up by the ALIAS'S OWN skillId, defaulting to NULL — the lookup " +
    "key is the parent, so it cannot return another skill's slug",
  // The scan is per-file rather than per-insert on purpose: a cross-slug slug could just as
  // easily arrive through a SELECT or a type as through the insert literal, so every
  // `domainId:` in a writer file is accounted for. These three are not writes at all.
  "domainId: skills.domainId })":
    "a SELECT projection — it READS the parent skill's own column, in retag-skills and in " +
    "seed-domain-skills, and is the source the writes above derive from",
  "domainId: r.domain_id":
    "s3d-rollback: reading a recorded row out of the rollback artifact into its own type",
  "domainId: string | null;": "s3d-rollback: a TYPE declaration, not a value",
};

describe("no shipped writer can create a cross-slug alias", () => {
  it("finds the writers at all — the derivation is not vacuously empty", () => {
    // A source scan that silently matches nothing would make every assertion below pass while
    // proving nothing, which is the failure mode of every grep-shaped test.
    const writers = aliasWriters();
    expect(writers.length).toBeGreaterThanOrEqual(4);
    expect(writers).toContain("seed-skills.ts");
    expect(writers).toContain("retag-skills.ts");
  });

  it("sets domainId only from the alias's own parent skill", () => {
    const offenders: string[] = [];
    for (const file of aliasWriters()) {
      const src = readFileSync(join(SRC, file), "utf8");
      for (const m of src.matchAll(/domainId:\s*([^,\n]+)/g)) {
        const expr = `domainId: ${m[1]!.trim()}`;
        if (!(expr in ALLOWED_DOMAIN_EXPRESSIONS)) offenders.push(`${file}: ${expr}`);
      }
    }
    expect(
      offenders,
      "a NEW domainId expression in a skill_alias writer is option B's machinery — re-read " +
        "phase-9-cnc-programming-decision.md before widening the allow-list",
    ).toEqual([]);
  });

  it("keeps every allow-list entry earning its place", () => {
    // A stale entry is a suppression nobody can see. If an expression is gone from the source,
    // the exemption for it must go too.
    const all = aliasWriters()
      .map((f) => readFileSync(join(SRC, f), "utf8"))
      .join("\n");
    for (const expr of Object.keys(ALLOWED_DOMAIN_EXPRESSIONS)) {
      expect(all, `${expr} is allowed but no longer written anywhere`).toContain(expr);
    }
  });

  it("documents a reason for every exemption", () => {
    for (const [expr, why] of Object.entries(ALLOWED_DOMAIN_EXPRESSIONS)) {
      expect(why.length, `${expr} needs a real reason, not a placeholder`).toBeGreaterThan(30);
    }
  });
});
