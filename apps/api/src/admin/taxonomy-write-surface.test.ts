/**
 * NO REQUEST PATH IN THIS SERVICE CAN WRITE THE TAXONOMY. Asserted by reading the source tree,
 * because it is the only way to assert it at all.
 *
 * ===========================================================================
 * WHY A SCAN AND NOT A RUNTIME TEST
 * ===========================================================================
 * The property is "these tables are never written from an HTTP handler". No runtime assertion can
 * observe a row nobody is able to write — a test that calls every route and then counts `skill`
 * rows proves only that the routes it happened to call did not write one. The claim is about what
 * the CODE CAN EXPRESS, so the check has to be too.
 *
 * ===========================================================================
 * ONE SCANNER, TWO CONSUMERS — AND THE FIRST DRAFT GOT THAT WRONG
 * ===========================================================================
 * `packages/db/src/lifecycle-writer-scan.ts` has held the writer set for `packages/db` for a
 * while. Its claims are repo-wide in wording ("these files, and no others, can create a
 * `skill_alias` row") and were measured over one directory, so this file originally shipped its
 * OWN copy of the detection logic to cover `apps/api`.
 *
 * Two detectors is how a detector goes wrong quietly. They disagreed almost immediately and in
 * the direction that matters: the shared one matched only the ``dsql` `` tag — the alias
 * `packages/db` imports drizzle's `sql` under — so pointed at `apps/api`, which imports it as
 * `sql`, it read 437 files and reported ZERO writers. A clean bill of health for the workspace it
 * had just been extended to cover, produced by a scanner that could not read the syntax in front
 * of it. The local copy here matched both tags and found the write, and the disagreement was
 * invisible until the two were compared by hand.
 *
 * So the detection now lives in ONE place and this file consumes it. What remains here is the
 * `apps/api`-facing question — *can a request path author vocabulary?* — asked of the shared
 * answer. `packages/db/src/skill-lifecycle.test.ts` asks the repo-wide version of it, including
 * that the root list stays exhaustive against the workspace manifests.
 *
 * ===========================================================================
 * WHAT IS FORBIDDEN, AND THE ONE THING THAT IS NOT
 * ===========================================================================
 * FORBIDDEN from anywhere under `apps/api/src`: `skill`, `skill_alias`, `job_domain`,
 * `job_domain_alias`, `job_domain_skill`. Those five ARE the matching vocabulary. They are
 * authored by the offline chain — `validateTaxonomyCorpus` -> `taxonomyQualityVerdict` -> a human
 * commit -> `db:seed:domain-skills` -> `db:promote:skills` C1..C5 — every stage of which is a
 * gate a request path does not have and cannot acquire.
 *
 * PERMITTED, and declared by name below: `unresolved_phrase`, written by
 * `skills/skills.repository.ts`. It is the exact INVERSE of a corpus write — the row that says "a
 * worker used a phrase the taxonomy does not have", i.e. an INPUT to discovery rather than an
 * output of it. It creates no skill, no alias and no edge, it is an idempotent upsert with a
 * counter, and it is one of the sources the discovery pipeline reads. Refusing it would mean the
 * platform could not record what it does not know, which is the one thing this whole workstream
 * exists to fix.
 *
 * It is named with its FILE, not just its table: a second file learning to write
 * `unresolved_phrase` is a new capability and should have to be argued for here.
 *
 * ===========================================================================
 * DIRECTION OF ERROR
 * ===========================================================================
 * A writer that assembles its statement dynamically (string concatenation into `db.execute`)
 * would be missed. So a hit is proof and a miss is not — which is the safe direction: the scan
 * can under-report a writer, never invent one. It is a floor under the review layer's promise,
 * not a proof of it, and saying so here is better than letting the next reader assume otherwise.
 */
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  SPINE_WRITER_ROOTS,
  scanWritersAcross,
  spineSourceFiles,
  type SpineTable,
} from "@badabhai/db";

/** `apps/api/src/admin` -> `apps/api/src` -> `apps/api` -> `apps` -> the repo. */
const REPO_ROOT = join(__dirname, "..", "..", "..", "..");

/** The five that author the matching vocabulary. A request path may never write one. */
const FORBIDDEN: readonly SpineTable[] = [
  "skill",
  "skill_alias",
  "job_domain",
  "job_domain_alias",
  "job_domain_skill",
];

const API_ROOT = SPINE_WRITER_ROOTS.find((r) => r.dir === "apps/api/src");
const scan = scanWritersAcross(REPO_ROOT);

/** Just this workspace's writers, keyed by the repo-relative path the scan returns. */
const apiWriters = new Map(
  [...scan.byFile.entries()].filter(([file]) => file.startsWith("apps/api/src/")),
);

describe("the scan is pointed at this workspace and can actually see it", () => {
  it("`apps/api/src` is one of the declared roots", () => {
    // If this workspace ever drops out of the root list, every assertion below becomes vacuously
    // true — the exact failure mode the whole file exists to prevent.
    expect(API_ROOT).toBeDefined();
  });

  it("and the walk reaches the whole tree, not just its top level", () => {
    // `apps/api/src` is ~40 nested modules. A non-recursive walk returns a handful of files and
    // reports a clean scan, which is worse than no scan because the empty result gets quoted.
    const files = spineSourceFiles(REPO_ROOT, API_ROOT!);
    expect(files.length).toBeGreaterThan(300);
    expect(files).toContain("apps/api/src/skills/skills.repository.ts");
    expect(files).toContain("apps/api/src/admin/admin-skill-discovery.service.ts");
  });

  it("finds at least one real writer here — otherwise it is reading nothing", () => {
    // The positive control. Without it, "no forbidden writes" could mean "no reads happened".
    expect(apiWriters.size).toBeGreaterThan(0);
  });
});

describe("apps/api cannot author the matching vocabulary", () => {
  for (const table of FORBIDDEN) {
    it(`no file under apps/api/src writes ${table}`, () => {
      const offenders = [...(scan.byTable.get(table) ?? [])].filter((f) =>
        f.startsWith("apps/api/src/"),
      );
      // Named, not counted: a failure here has to say WHICH file so the reader can decide whether
      // it is a mistake or an owner decision. If it is the latter, this list is where the argument
      // goes — and it needs a second human either way, because the offline chain that authors this
      // table has one and a request path does not.
      expect(offenders).toEqual([]);
    });
  }

  it("the review layer's own files write NOTHING on the spine", () => {
    // The load-bearing case. An approval moves one `skill_candidate` row and stops; these files
    // say so in their headers, and this is the assertion that makes the headers true.
    for (const file of [
      "apps/api/src/admin/admin-skill-discovery.service.ts",
      "apps/api/src/admin/admin-skill-discovery.repository.ts",
      "apps/api/src/admin/admin-skill-discovery.controller.ts",
      "apps/api/src/admin/admin-skill-discovery.dto.ts",
    ]) {
      expect(scan.byFile.get(file), file).toBeUndefined();
    }
  });

  it("no admin file at all has learned to write a spine table", () => {
    // The whole `admin/` directory, not just the four above: the review capability lives in this
    // module, so this is where a "just create the skill here" shortcut would be added.
    expect([...apiWriters.keys()].filter((f) => f.startsWith("apps/api/src/admin/"))).toEqual([]);
  });
});

describe("the one permitted spine write is declared, not discovered", () => {
  it("the scanned write set for this workspace equals the declared one, exactly", () => {
    // An EQUALITY, not a subset. A subset assertion would let a new writer appear silently; this
    // fails in both directions, so removing the permitted one also fails and has to be noticed.
    const scanned = Object.fromEntries(
      [...apiWriters.entries()].map(([file, tables]) => [file, [...tables].sort()]),
    );
    expect(scanned).toEqual({
      "apps/api/src/skills/skills.repository.ts": ["unresolved_phrase"],
    });
  });

  it("and it is unresolved_phrase — a discovery INPUT, not a corpus output", () => {
    // The distinction the permission rests on. This row records that a worker used a phrase the
    // taxonomy does not have. It mints no skill, no alias and no edge; it is upserted with a
    // counter; and it is one of the sources the discovery pipeline reads. Recording what the
    // platform does not know is the opposite of authoring vocabulary.
    const tables = scan.byFile.get("apps/api/src/skills/skills.repository.ts");
    expect(tables).toEqual(new Set(["unresolved_phrase"]));
    for (const table of FORBIDDEN) expect(tables?.has(table)).toBe(false);
  });
});
