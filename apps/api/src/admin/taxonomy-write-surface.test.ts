/**
 * NO REQUEST PATH IN THIS SERVICE CAN WRITE THE TAXONOMY. Asserted by reading the source tree,
 * because it is the only way to assert it at all.
 *
 * ===========================================================================
 * WHY A SCAN AND NOT A RUNTIME TEST
 * ===========================================================================
 * The property is "these tables are never written from an HTTP handler". No runtime assertion
 * can observe a row nobody is able to write — a test that calls every route and then counts
 * `skill` rows proves only that the routes it happened to call did not write one. The claim is
 * about what the CODE CAN EXPRESS, so the check has to be too. This is the same technique
 * `packages/db/src/lifecycle-writer-scan.ts` uses on the other side of the boundary, and for the
 * same reason it gives there: "a hand-maintained list of writers is a list of the writers someone
 * remembered".
 *
 * That module scans `packages/db/src` ONLY. Nothing scanned `apps/api` — so the guarantee the
 * whole skill-discovery review layer rests on ("an approval RECORDS a decision; minting the
 * corpus stays offline, behind a second human") was true and unenforced. A single
 * `.insert(skills)` in a service, added in good faith by somebody implementing "approve and
 * create", would have satisfied every existing test in both packages.
 *
 * ===========================================================================
 * WHAT IS FORBIDDEN, AND THE ONE THING THAT IS NOT
 * ===========================================================================
 * FORBIDDEN, from anywhere under `apps/api/src`: `skill`, `skill_alias`, `job_domain`,
 * `job_domain_alias`, `job_domain_skill`. Those five ARE the matching vocabulary. They are
 * authored by the offline chain — `validateTaxonomyCorpus` -> `taxonomyQualityVerdict` -> a human
 * commit -> `db:seed:domain-skills` -> `db:promote:skills` C1..C5 — every stage of which is a
 * gate a request path does not have and cannot acquire.
 *
 * PERMITTED, and declared by name below: `unresolved_phrase`, written by
 * `skills/skills.repository.ts`. It is the exact INVERSE of a corpus write — the row that says
 * "a worker used a phrase the taxonomy does not have", i.e. an INPUT to discovery rather than an
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
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { describe, expect, it } from "vitest";

/** The Drizzle model identifiers and the raw table names for the taxonomy spine. */
const SPINE = {
  skill: { model: "skills", raw: "skill" },
  skill_alias: { model: "skillAliases", raw: "skill_alias" },
  job_domain: { model: "jobDomains", raw: "job_domain" },
  job_domain_alias: { model: "jobDomainAliases", raw: "job_domain_alias" },
  job_domain_skill: { model: "jobDomainSkills", raw: "job_domain_skill" },
  unresolved_phrase: { model: "unresolvedPhrases", raw: "unresolved_phrase" },
} as const;

type SpineTable = keyof typeof SPINE;

/** The five that author the matching vocabulary. A request path may never write one. */
const FORBIDDEN: readonly SpineTable[] = [
  "skill",
  "skill_alias",
  "job_domain",
  "job_domain_alias",
  "job_domain_skill",
];

/**
 * The ONE permitted spine write in `apps/api`, pinned to its file.
 *
 * `unresolved_phrase` is a discovery INPUT — see the header. Keyed by the repo-relative path so a
 * second writer of the same table is a failure rather than an accident.
 */
const PERMITTED: Readonly<Record<string, readonly SpineTable[]>> = {
  "skills/skills.repository.ts": ["unresolved_phrase"],
};

const SRC = join(__dirname, "..");

/** Every implementation file under `apps/api/src`. Tests are excluded — they write nothing real. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...sourceFiles(full));
      continue;
    }
    if (!entry.name.endsWith(".ts")) continue;
    if (entry.name.endsWith(".test.ts") || entry.name.endsWith(".d.ts")) continue;
    out.push(full);
  }
  return out.sort();
}

/**
 * Comments removed before any pattern runs. A MENTION IS NOT A CAPABILITY, and on this surface
 * that is not a technicality: `admin-skill-discovery.service.ts`,
 * `admin-skill-discovery.repository.ts` and `admin.module.ts` each explain at length that they do
 * not write `skill`, `skill_alias` or `job_domain_skill`, naming all three. Counting prose would
 * flag exactly the files most careful to say what they refuse to do — the same inversion
 * `lifecycle-writer-scan.ts` records having got wrong on its first attempt.
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
}

/** The text inside every `sql` / `dsql` tagged template — the only raw SQL that reaches a driver. */
function taggedSql(code: string): string {
  return [...code.matchAll(/\bd?sql`([\s\S]*?)`/g)].map((m) => m[1] ?? "").join("\n");
}

/** Which spine tables this file can WRITE. Reads are irrelevant and deliberately not detected. */
function writesOf(code: string): Set<SpineTable> {
  const stripped = stripComments(code);
  const rawSql = taggedSql(stripped);
  const found = new Set<SpineTable>();
  for (const table of Object.keys(SPINE) as SpineTable[]) {
    const { model, raw } = SPINE[table];
    const builder =
      stripped.includes(`.insert(${model})`) ||
      stripped.includes(`.update(${model})`) ||
      stripped.includes(`.delete(${model})`);
    // Anchored on the statement keyword and on a word boundary at the table name, so
    // `skill_candidate` never matches `skill` and `job_domain_skill` never matches `job_domain`.
    const rawWrite = new RegExp(
      `(INSERT\\s+INTO|UPDATE|DELETE\\s+FROM|TRUNCATE)\\s+"?${raw}"?(?![a-z_])`,
      "i",
    ).test(rawSql);
    if (builder || rawWrite) found.add(table);
  }
  return found;
}

const scan = new Map<string, Set<SpineTable>>();
for (const file of sourceFiles(SRC)) {
  const writes = writesOf(readFileSync(file, "utf8"));
  if (writes.size > 0) {
    scan.set(relative(SRC, file).split(sep).join("/"), writes);
  }
}

describe("the scan is CAPABLE of failing (no assertion below is vacuous)", () => {
  it("detects a drizzle builder write", () => {
    expect([...writesOf("await db.insert(skills).values(x);")]).toEqual(["skill"]);
    expect([...writesOf("await tx.update(jobDomainSkills).set(x);")]).toEqual(["job_domain_skill"]);
    expect([...writesOf("await db.delete(skillAliases).where(y);")]).toEqual(["skill_alias"]);
  });

  it("detects a raw write inside a tagged template", () => {
    expect([...writesOf("await db.execute(sql`INSERT INTO skill_alias (id) VALUES (1)`);")]).toEqual(
      ["skill_alias"],
    );
    expect([...writesOf("await db.execute(dsql`UPDATE skill SET status = 'x'`);")]).toEqual([
      "skill",
    ]);
  });

  it("does NOT count a mention in prose, which is the failure mode that inverts the audit", () => {
    expect([...writesOf("// this file never calls .insert(skills)")]).toEqual([]);
    expect([...writesOf("/** No INSERT INTO job_domain_skill happens here. */")]).toEqual([]);
    // The exact sentence the review layer's three files actually carry.
    expect([
      ...writesOf("/* no request path creates a `skill`, a `skill_alias` or a `job_domain_skill` */"),
    ]).toEqual([]);
  });

  it("does NOT count a READ — this is a write audit, not a coupling audit", () => {
    expect([...writesOf("const r = await db.select().from(skills).where(eq(x, y));")]).toEqual([]);
    expect([...writesOf("await db.execute(sql`SELECT skill_id FROM skill WHERE x = 1`);")]).toEqual(
      [],
    );
  });

  it("does not confuse the staging tables for the corpus ones they are named after", () => {
    // The whole point of migration 0093 is that `skill_candidate` is NOT `skill`. A scan that
    // could not tell them apart would flag the review layer's own guarded write as a corpus write
    // and the audit would have to be switched off to ship anything.
    expect([...writesOf("await tx.update(skillCandidates).set(patch);")]).toEqual([]);
    expect([
      ...writesOf("await db.execute(sql`INSERT INTO skill_candidate_source (x) VALUES (1)`);"),
    ]).toEqual([]);
    expect([...writesOf("await db.execute(sql`UPDATE skill_candidate SET status = 'x'`);")]).toEqual(
      [],
    );
  });

  it("finds at least one real writer in the tree — otherwise the scan is reading nothing", () => {
    expect(scan.size).toBeGreaterThan(0);
    expect([...scan.keys()]).toContain("skills/skills.repository.ts");
  });
});

describe("apps/api cannot author the matching vocabulary", () => {
  for (const table of FORBIDDEN) {
    it(`no file under apps/api/src writes ${table}`, () => {
      const offenders = [...scan.entries()]
        .filter(([, tables]) => tables.has(table))
        .map(([file]) => file);
      // Named, not counted: a failure here has to say WHICH file so the reader can decide whether
      // it is a mistake or an owner decision. If it is the latter, this list is where the
      // argument goes — and it needs a second human either way, because the offline chain that
      // authors this table has one and a request path does not.
      expect(offenders).toEqual([]);
    });
  }

  it("the review layer's own files write NOTHING on the spine", () => {
    // The load-bearing case. An approval moves one `skill_candidate` row and stops; these three
    // files say so in their headers, and this is the assertion that makes the headers true.
    for (const file of [
      "admin/admin-skill-discovery.service.ts",
      "admin/admin-skill-discovery.repository.ts",
      "admin/admin-skill-discovery.controller.ts",
      "admin/admin-skill-discovery.dto.ts",
    ]) {
      expect(scan.get(file) ?? new Set()).toEqual(new Set());
    }
  });

  it("no NEW admin file has learned to write a spine table", () => {
    // The whole `admin/` directory, not just the four above: the review capability lives in this
    // module, so this is where a "just create the skill here" shortcut would be added.
    const adminWriters = [...scan.keys()].filter((f) => f.startsWith("admin/"));
    expect(adminWriters).toEqual([]);
  });
});

describe("the one permitted spine write is declared, not discovered", () => {
  it("the scanned write set equals the declared one, exactly", () => {
    // An EQUALITY, not a subset. A subset assertion would let a new writer appear silently; this
    // fails in both directions, so removing the permitted one also fails and has to be noticed.
    const scanned = Object.fromEntries(
      [...scan.entries()].map(([file, tables]) => [file, [...tables].sort()]),
    );
    const declared = Object.fromEntries(
      Object.entries(PERMITTED).map(([file, tables]) => [file, [...tables].sort()]),
    );
    expect(scanned).toEqual(declared);
  });

  it("and it is unresolved_phrase — a discovery INPUT, not a corpus output", () => {
    // The distinction the permission rests on. This row records that a worker used a phrase the
    // taxonomy does not have. It mints no skill, no alias and no edge; it is upserted with a
    // counter; and it is one of the sources the discovery pipeline reads. Recording what the
    // platform does not know is the opposite of authoring vocabulary.
    expect(scan.get("skills/skills.repository.ts")).toEqual(new Set(["unresolved_phrase"]));
    for (const table of FORBIDDEN) {
      expect(scan.get("skills/skills.repository.ts")?.has(table)).toBe(false);
    }
  });
});
