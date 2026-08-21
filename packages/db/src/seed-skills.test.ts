/**
 * `--preserve-existing-status` — S3-A's one required code change.
 *
 * The plan specifies this flag precisely and it did not exist, so S3-A could not be run as
 * designed. Its whole job is to NOT write something, which is the hardest kind of behaviour to
 * be confident about: "we ran it and nothing changed" is indistinguishable from a no-op bug.
 * So the rule is a pure function, and the two source-level properties that a pure function
 * cannot cover — the omitted `status` key and the skipped PASS 2 pointer — are pinned against
 * the file itself.
 *
 * The plan's own required test is the first one below: *"one test asserting a preserved row
 * keeps `active` and gains no pointer."*
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  heldSkillIds,
  planSeedSkills,
  renderSeedSkillsPlan,
  type LiveSkillRow,
} from "./seed-skills";

const SRC = readFileSync(join(__dirname, "seed-skills.ts"), "utf8");

/** Source with comments stripped — the file explains the old behaviour it replaced. */
function code(): string {
  return SRC.replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !/^\s*\/\//.test(l))
    .join("\n");
}

describe("heldSkillIds — which rows keep production's status", () => {
  const corpus = [
    { skillId: "skill_a", status: "deprecated" },
    { skillId: "skill_b", status: "provisional" },
    { skillId: "skill_c", status: "active" },
    { skillId: "skill_new", status: "deprecated" },
  ];

  it("the plan's required case: a preserved row keeps active and gains no pointer", () => {
    // Production has skill_a active; the corpus wants it deprecated. It must be held, and the
    // held set is exactly what PASS 2 consults before writing replaced_by.
    const held = heldSkillIds(corpus, new Map([["skill_a", "active"]]));
    expect(held).toEqual([{ skillId: "skill_a", corpusStatus: "deprecated", dbStatus: "active" }]);
  });

  it("holds every row where corpus and database disagree", () => {
    const held = heldSkillIds(
      corpus,
      new Map([
        ["skill_a", "active"],
        ["skill_b", "active"],
        ["skill_c", "active"],
      ]),
    );
    // skill_c agrees, so there is nothing to hold for it.
    expect(held.map((h) => h.skillId)).toEqual(["skill_a", "skill_b"]);
  });

  it("does NOT hold a row that does not exist yet — a new row takes the corpus status", () => {
    // The flag preserves what production decided. Production has decided nothing about a row
    // it has never seen, and holding it would make the corpus permanently unlandable.
    expect(heldSkillIds(corpus, new Map()).length).toBe(0);
    expect(heldSkillIds(corpus, new Map([["skill_new", "active"]])).map((h) => h.skillId)).toEqual([
      "skill_new",
    ]);
  });

  it("does not hold a row whose status already agrees — no spurious divergence report", () => {
    expect(heldSkillIds([{ skillId: "s", status: "active" }], new Map([["s", "active"]]))).toEqual([]);
  });

  it("reports both sides, so the divergence it creates is legible", () => {
    const [h] = heldSkillIds([{ skillId: "s", status: "deprecated" }], new Map([["s", "provisional"]]));
    expect(h).toEqual({ skillId: "s", corpusStatus: "deprecated", dbStatus: "provisional" });
  });

  it("is sorted, so two runs produce the same report", () => {
    const held = heldSkillIds(
      [
        { skillId: "z", status: "deprecated" },
        { skillId: "a", status: "deprecated" },
      ],
      new Map([
        ["z", "active"],
        ["a", "active"],
      ]),
    );
    expect(held.map((h) => h.skillId)).toEqual(["a", "z"]);
  });
});

describe("the writes the flag suppresses", () => {
  it("omits `status` from the conflict update for a held row", () => {
    // The behaviour cannot be reached by a pure function: it is the shape of the `set` object.
    expect(code()).toMatch(/\.\.\.\(isHeld \? \{\} : \{ status: s\.status \}\)/);
  });

  it("does not clear replaced_by on a held row either", () => {
    // Pairing "status preserved as active" with a pointer rewrite is the exact combination the
    // CHECK `replaced_by IS NULL OR status = 'deprecated'` rejects.
    expect(code()).toMatch(/clearsPointer && !isHeld/);
  });

  it("skips PASS 2's pointer write for a held row", () => {
    const pass2 = code().slice(code().indexOf("replacedBy: s.replacedBy") - 900);
    expect(pass2).toMatch(/held\.has\(s\.skillId\)/);
  });

  it("still propagates labels, domain and source to a held row", () => {
    // The flag preserves the LIFECYCLE decision, not the whole row. Holding metadata too would
    // make the corpus unlandable, which is the opposite of what S3-A is for.
    const setBlock = code().slice(code().indexOf("onConflictDoUpdate"), code().indexOf("skillCount += 1"));
    for (const field of ["labelEn:", "labelHi:", "domainId:", "source:"]) {
      expect(setBlock, field).toContain(field);
    }
  });
});

describe("the flag is off by default", () => {
  it("is opt-in by exact argv match, not a prefix or a substring", () => {
    // `--preserve-existing-status-dry-run` must not silently enable the real thing.
    expect(code()).toMatch(/a === "--preserve-existing-status"/);
  });

  it("every held-row behaviour is gated behind it", () => {
    // `held` starts empty and is only populated inside `if (preserveStatus)`, so without the
    // flag `isHeld` is false everywhere and the file behaves exactly as it did before.
    const c = code();
    expect(c).toMatch(/const held = new Map/);
    expect(c).toMatch(/if \(preserveStatus\) \{/);
    expect(c.indexOf("if (preserveStatus)")).toBeLessThan(c.indexOf("const isHeld"));
  });

  it("reads the existing statuses BEFORE the first write", () => {
    // After PASS 1 has run, "what did production have" is gone. Ordering is the whole
    // correctness argument, so it is pinned rather than left to a comment.
    const c = code();
    expect(c.indexOf("SELECT skill_id, status FROM skill")).toBeLessThan(c.indexOf(".insert(skills)"));
  });

  it("guards its entrypoint, because it now exports heldSkillIds", () => {
    expect(code()).toMatch(/require\.main === module/);
  });
});

/**
 * `planSeedSkills` — the preview the mandatory first step of D2 did not have.
 *
 * `seed:domain-skills`, `embed:skills` and `promote:skills` are all dry-run-by-default. This
 * seeder was not, and it has to run FIRST: `seed:domain-skills` refuses until the shipped skills
 * its corpus references exist, and on production sixteen of them do not. So the one step nobody
 * could look at beforehand was the one that had to go first.
 *
 * The plan is pure, so the cases that matter are asserted here rather than rehearsed against a
 * database — and the case that matters most is the one where the plan and the writer must AGREE
 * about `--preserve-existing-status`, because a preview that disagrees with the run is worse
 * than no preview.
 */
describe("planSeedSkills — what the seed would do, without doing it", () => {
  const alias = (text: string) => ({ text, lang: "en", source: "seed" });
  const corpus = [
    {
      skillId: "skill_a",
      labelEn: "A",
      labelHi: "ए",
      domainId: "d1",
      source: "seed",
      status: "deprecated",
      replacedBy: "skill_b",
      aliases: [alias("a one")],
    },
    {
      skillId: "skill_b",
      labelEn: "B",
      labelHi: "बी",
      domainId: "d1",
      source: "seed",
      status: "active",
      aliases: [alias("b one"), alias("b two")],
    },
    {
      skillId: "skill_new",
      labelEn: "New",
      labelHi: "नया",
      domainId: "d2",
      source: "seed",
      status: "provisional",
      aliases: [alias("new one")],
    },
  ] as unknown as Parameters<typeof planSeedSkills>[0];

  const row = (o: Partial<LiveSkillRow> & { skillId: string }): LiveSkillRow => ({
    labelEn: "A",
    labelHi: "ए",
    domainId: "d1",
    source: "seed",
    status: "active",
    replacedBy: null,
    ...o,
  });

  const plan = (live: LiveSkillRow[], aliasIds: string[], preserve: boolean) =>
    planSeedSkills(corpus, live, new Set(aliasIds), [], preserve);

  it("an empty target is all inserts, and nothing is 'changed'", () => {
    const p = plan([], [], false);
    expect(p.newSkills).toEqual(["skill_a", "skill_b", "skill_new"]);
    expect(p.changedSkills).toEqual([]);
    expect(p.heldSkills).toEqual([]);
    expect(p.newAliases).toHaveLength(4);
    expect(p.unchangedAliases).toBe(0);
  });

  it("a target that already matches the corpus plans NOTHING — the re-run case", () => {
    // The seeder is idempotent by construction; a plan that reported work on an unchanged
    // database would make every real diff impossible to spot.
    const p = planSeedSkills(
      corpus,
      [
        row({ skillId: "skill_a", status: "deprecated", replacedBy: "skill_b" }),
        row({ skillId: "skill_b", labelEn: "B", labelHi: "बी", status: "active" }),
        row({ skillId: "skill_new", labelEn: "New", labelHi: "नया", domainId: "d2", status: "provisional" }),
      ],
      new Set(["x"]),
      [],
      false,
    );
    expect(p.newSkills).toEqual([]);
    expect(p.changedSkills).toEqual([]);
    expect(p.crosswalkWrites).toEqual([]);
  });

  it("names WHICH fields a change would overwrite, not just that one exists", () => {
    const p = plan([row({ skillId: "skill_b", labelEn: "stale", domainId: "d9", status: "active" })], [], false);
    const changed = p.changedSkills.find((c) => c.skillId === "skill_b");
    expect(changed?.fields).toContain("label_en");
    expect(changed?.fields).toContain("domain_id");
  });

  it("THE PRODUCTION CASE: --preserve-existing-status turns a status change into a HOLD", () => {
    // Measured against production 2026-08-20: four rows are `active` live and `deprecated` in
    // the corpus. Without the flag the seed flips all four; with it, none.
    const live = [row({ skillId: "skill_a", status: "active", replacedBy: null })];

    const without = plan(live, [], false);
    expect(without.heldSkills).toEqual([]);
    expect(without.changedSkills[0]?.fields.join()).toContain("status (active -> deprecated)");
    // ...and the crosswalk pointer rides along with the deprecation.
    expect(without.crosswalkWrites).toEqual(["skill_a"]);

    const withFlag = plan(live, [], true);
    expect(withFlag.heldSkills).toEqual([
      { skillId: "skill_a", dbStatus: "active", corpusStatus: "deprecated" },
    ]);
    expect(withFlag.changedSkills).toEqual([]);
    // THE PART THAT WOULD BREAK THE RUN IF THE PLAN GOT IT WRONG. A held row keeps `active`,
    // and the CHECK is `replaced_by IS NULL OR status = 'deprecated'` — so writing the pointer
    // would abort the whole seed. The writer skips it; the plan must say so.
    expect(withFlag.crosswalkWrites).toEqual([]);
  });

  it("counts an alias already present as untouched — existing vectors are never at risk", () => {
    // Aliases are inserted ON CONFLICT DO NOTHING with a deterministic id, so a re-run cannot
    // clobber an embedding. The plan reports that separation rather than merging the two.
    const all = plan([], [], false).newAliases;
    const p = plan([], [all[0]!], false);
    expect(p.newAliases).toHaveLength(all.length - 1);
    expect(p.unchangedAliases).toBe(1);
  });

  it("de-duplicates an alias the corpus and the wedge both declare", () => {
    // Both passes insert by deterministic id, so the same text/lang on the same skill is ONE
    // row. Counting it twice would overstate what the run writes.
    const p = planSeedSkills(
      corpus,
      [],
      new Set(),
      [{ skillId: "skill_b", alias: { text: "b one", lang: "en" } }],
      false,
    );
    expect(p.newAliases).toHaveLength(4);
  });

  it("the render warns when a status change is planned without the flag", () => {
    const text = renderSeedSkillsPlan(plan([row({ skillId: "skill_a", status: "active" })], [], false), false).join("\n");
    expect(text).toContain("WARNING");
    expect(text).toContain("--preserve-existing-status");
    const held = renderSeedSkillsPlan(plan([row({ skillId: "skill_a", status: "active" })], [], true), true).join("\n");
    expect(held).not.toContain("WARNING");
    expect(held).toContain("HELD");
  });

  it("the render always says nothing was written", () => {
    expect(renderSeedSkillsPlan(plan([], [], true), true)[0]).toContain("nothing was written");
  });
});
