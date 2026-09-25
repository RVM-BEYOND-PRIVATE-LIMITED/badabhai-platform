/**
 * Alias retirement — the corpus rule, the loader, the retrieval view and the SQL.
 *
 * WHAT THESE TESTS ARE FOR. A retirement changes which trade a worker's words reach, and it
 * changes it in two places that must agree: the offline index every routing test and the eval
 * are built from, and the live `is_searchable` flag every retrieval layer filters on. A
 * validator check that never fires is indistinguishable from `return []`, so each one is proven
 * to fire; the offline effect is proven through the REAL loader and the REAL index; and the SQL
 * is rendered and read, because no test here may open a database connection.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import {
  retiredAliasIds,
  retiredAliasPredicate,
  retiredAliasesJson,
} from "./job-domain-alias-retirement";
import {
  applyAliasRetirements,
  loadJobDomainCorpusLines,
  loadRetiredAliasKeys,
  resolveJobDomainCorpus,
  retiredAliasKey,
  retiredKeyString,
  validateAliasRetirements,
  type JobDomainAliasRetirementRecord,
  type RetiredAliasKey,
  type JobDomainSeedRecord,
  type ResolvedJobDomain,
} from "./job-domain-corpus";
import { recomputeSearchableSql } from "./normalize-job-domain-aliases";
import { buildOccupationIndex, resolveOccupation } from "./occupation-retrieval-eval";

// ── Fixtures ──────────────────────────────────────────────────────────────────

function domain(overrides: Partial<ResolvedJobDomain> = {}): ResolvedJobDomain {
  return {
    source: "nco2015",
    code: "6121.0800",
    level: 5,
    parent_code: "6121",
    parent_source: "isco08",
    isco_major: "6",
    isco_unit: "6121",
    skill_level: 2,
    label_en: "Milker, Machine",
    label_hi: null,
    description_en: null,
    selectable: true,
    industry_id: null,
    canonical_role_id: null,
    aliases: [
      { text: "Milker, Machine", lang: "en", source: "nco2015" },
      { text: "Milker", lang: "en", source: "nco2015" },
      { text: "Machine", lang: "en", source: "nco2015" },
    ],
    jobDomainId: "jd_nco_6121_0800",
    parentJobDomainId: "jd_isco_6121",
    ...overrides,
  };
}

function retire(
  overrides: Partial<JobDomainAliasRetirementRecord> = {},
): JobDomainAliasRetirementRecord {
  return {
    kind: "retire",
    job_domain_id: "jd_nco_6121_0800",
    text: "Machine",
    lang: "en",
    ruling: "RVM worksheet Part 5, A4",
    reason: "comma-split junk of 'Milker, Machine'",
    decided_by: "Divyanshu",
    decided_on: "2026-09-24",
    ...overrides,
  };
}

// ── validateAliasRetirements ─────────────────────────────────────────────────

describe("validateAliasRetirements", () => {
  it("accepts a well-formed retirement of a published alias", () => {
    expect(validateAliasRetirements([retire()], [domain()])).toEqual([]);
  });

  it("accepts a retirement of an authored (rvm) alias", () => {
    const d = domain({
      aliases: [...domain().aliases, { text: "doodh machine", lang: "en", source: "rvm" }],
    });
    expect(validateAliasRetirements([retire({ text: "doodh machine" })], [d])).toEqual([]);
  });

  it("rejects a malformed job_domain_id", () => {
    const problems = validateAliasRetirements([retire({ job_domain_id: "NCO-6121" })], [domain()]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("does not match");
  });

  it("rejects a domain that is not in the corpus", () => {
    const problems = validateAliasRetirements(
      [retire({ job_domain_id: "jd_nco_9999_0000" })],
      [domain()],
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("not in the domain corpus");
  });

  it("rejects an unknown lang", () => {
    const problems = validateAliasRetirements(
      [retire({ lang: "fr" as JobDomainAliasRetirementRecord["lang"] })],
      [domain()],
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("lang must be one of");
  });

  it.each(["ruling", "reason", "decided_by"] as const)(
    "rejects a retirement with no %s",
    (field) => {
      const blank: Partial<JobDomainAliasRetirementRecord> = { [field]: "  " };
      const problems = validateAliasRetirements([retire(blank)], [domain()]);
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain(`${field} is required`);
    },
  );

  it.each(["24-09-2026", "2026-13-45", "", "yesterday"])("rejects decided_on %j", (decided_on) => {
    const problems = validateAliasRetirements([retire({ decided_on })], [domain()]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("decided_on must be an ISO date");
  });

  // THE TYPO GUARD. A near-miss would otherwise retire nothing and read as a decision taken.
  it.each([
    ["a case mismatch", { text: "machine" }],
    ["a lang mismatch", { lang: "hi" as const }],
    ["a phrase no alias carries", { text: "Machine Operator" }],
  ])("rejects %s: the line must name an alias exactly", (_label, overrides) => {
    const problems = validateAliasRetirements([retire(overrides)], [domain()]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("names no alias on that domain");
  });

  it("rejects the same alias retired twice", () => {
    const problems = validateAliasRetirements([retire(), retire()], [domain()]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("already retired");
  });

  it("rejects a second spelling that normalizes to an already-retired key", () => {
    // "Machine," and "Machine" normalize alike, so the second line retires nothing new.
    const d = domain({
      aliases: [...domain().aliases, { text: "Machine,", lang: "en", source: "nco2015" }],
    });
    const problems = validateAliasRetirements([retire(), retire({ text: "Machine," })], [d]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("already retired");
  });

  // THE REACHABILITY GUARD. Retiring the only phrase an occupation has is a second decision.
  it("rejects retiring a selectable occupation's last alias", () => {
    const d = domain({ aliases: [{ text: "Press Operator", lang: "en", source: "nco2015" }] });
    const problems = validateAliasRetirements([retire({ text: "Press Operator" })], [d]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("remove EVERY alias");
  });

  it("allows it once a replacement alias gives workers another way in", () => {
    const d = domain({
      aliases: [
        { text: "Press Operator", lang: "en", source: "nco2015" },
        { text: "woollen press operator", lang: "en", source: "rvm" },
      ],
    });
    expect(validateAliasRetirements([retire({ text: "Press Operator" })], [d])).toEqual([]);
  });

  it("does not demand a replacement on a non-selectable domain, which retrieval never reads", () => {
    const d = domain({
      selectable: false,
      aliases: [{ text: "Machine", lang: "en", source: "nco2015" }],
    });
    expect(validateAliasRetirements([retire()], [d])).toEqual([]);
  });

  it("reports EVERY problem rather than stopping at the first", () => {
    const problems = validateAliasRetirements(
      [
        retire({ text: "nope" }),
        retire({ job_domain_id: "jd_nco_9999_0000" }),
        retire({ reason: "" }),
      ],
      [domain()],
    );
    expect(problems).toHaveLength(3);
  });
});

// ── applyAliasRetirements ────────────────────────────────────────────────────

describe("applyAliasRetirements", () => {
  it("drops the retired alias and every spelling on that domain that normalizes alike", () => {
    const d = domain({
      aliases: [...domain().aliases, { text: "Machine,", lang: "en", source: "nco2015" }],
    });
    const [out] = applyAliasRetirements([d], [retire()]);
    expect(out?.aliases.map((a) => a.text)).toEqual(["Milker, Machine", "Milker"]);
  });

  it("leaves the same phrase on OTHER domains alone — a retirement is per domain", () => {
    const other = domain({
      jobDomainId: "jd_nco_7223_5001",
      code: "7223.5001",
      aliases: [{ text: "Machine", lang: "en", source: "nco2015" }],
    });
    const [, kept] = applyAliasRetirements([domain(), other], [retire()]);
    expect(kept?.aliases.map((a) => a.text)).toEqual(["Machine"]);
  });

  it("never mutates the corpus it was handed", () => {
    const d = domain();
    applyAliasRetirements([d], [retire()]);
    expect(d.aliases.map((a) => a.text)).toContain("Machine");
  });
});

// ── The loader and the retrieval view, end to end through the REAL index ─────

/** A minimal but VALID corpus: the ISCO chain down to unit 7233, and two NCO fitters. */
function writeFixtureCorpus(retirements: readonly object[]): string {
  const dir = mkdtempSync(join(tmpdir(), "bb-retire-"));
  const isco = (
    code: string,
    level: number,
    parent: string | null,
    selectable = false,
  ): JobDomainSeedRecord => ({
    source: "isco08",
    code,
    level,
    parent_code: parent,
    isco_major: "7",
    isco_unit: level === 4 ? code : null,
    skill_level: null,
    label_en: `ISCO ${code}`,
    label_hi: null,
    description_en: null,
    selectable,
    industry_id: null,
    canonical_role_id: null,
    aliases: selectable ? [{ text: `isco unit ${code}`, lang: "en", source: "isco08" }] : [],
  });
  const nco = (code: string, title: string): JobDomainSeedRecord => ({
    source: "nco2015",
    code,
    level: 5,
    parent_code: "7233",
    parent_source: "isco08",
    isco_major: "7",
    isco_unit: "7233",
    skill_level: 2,
    label_en: title,
    label_hi: null,
    description_en: null,
    selectable: true,
    industry_id: null,
    canonical_role_id: null,
    aliases: [{ text: title, lang: "en", source: "nco2015" }],
  });
  const lines = (rows: readonly object[]) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
  writeFileSync(
    join(dir, "a-domains.jsonl"),
    lines([
      isco("7", 1, null),
      isco("72", 2, "7"),
      isco("723", 3, "72"),
      isco("7233", 4, "723", true),
      nco("7233.0101", "Maintenance Fitter-Mechanical"),
      nco("7233.0200", "Fitter, Bench"),
    ]),
  );
  writeFileSync(
    join(dir, "rvm-aliases.jsonl"),
    "# overlay\n" +
      lines([
        { kind: "alias", job_domain_id: "jd_nco_7233_0101", text: "fitter", lang: "en" },
        {
          kind: "alias",
          job_domain_id: "jd_nco_7233_0101",
          text: "maintenance fitter",
          lang: "en",
        },
        { kind: "alias", job_domain_id: "jd_nco_7233_0200", text: "bench fitter", lang: "en" },
      ]),
  );
  writeFileSync(join(dir, "rvm-alias-retirements.jsonl"), "# retirements\n" + lines(retirements));
  return dir;
}

/** The A1 ruling in miniature: plain `fitter` leaves Maintenance Fitter. */
const A1 = retire({
  job_domain_id: "jd_nco_7233_0101",
  text: "fitter",
  ruling: "RVM worksheet Part 5, A1",
  reason: "plain fitter belongs to Bench Fitter",
});

describe("the corpus loader", () => {
  it("reads `retire` lines as retirements, apart from domains and overlays", () => {
    const { domains, overlays, retirements } = loadJobDomainCorpusLines(writeFixtureCorpus([A1]));
    expect(domains).toHaveLength(6);
    expect(overlays).toHaveLength(3);
    expect(retirements).toEqual([A1]);
  });

  it("still refuses an unknown kind, and names retire among the kinds it expects", () => {
    const dir = writeFixtureCorpus([]);
    writeFileSync(join(dir, "z-bad.jsonl"), JSON.stringify({ kind: "retired" }) + "\n");
    expect(() => loadJobDomainCorpusLines(dir)).toThrow(/expected "domain", "alias" or "retire"/);
  });
});

describe("the retrieval view", () => {
  it("drops the retired alias by default and keeps it for the row-level consumers", () => {
    const dir = writeFixtureCorpus([A1]);
    const maint = (corpus: ResolvedJobDomain[]) =>
      corpus.find((d) => d.jobDomainId === "jd_nco_7233_0101")?.aliases.map((a) => a.text);
    expect(maint(resolveJobDomainCorpus(dir))).toEqual([
      "Maintenance Fitter-Mechanical",
      "maintenance fitter",
    ]);
    expect(maint(resolveJobDomainCorpus(dir, { includeRetiredAliases: true }))).toContain("fitter");
  });

  it("changes ROUTING: the retired phrase stops reaching its old occupation, the rest still do", () => {
    const before = buildOccupationIndex(resolveJobDomainCorpus(writeFixtureCorpus([])));
    const after = buildOccupationIndex(resolveJobDomainCorpus(writeFixtureCorpus([A1])));

    expect(resolveOccupation(before, "fitter")?.jobDomainId).toBe("jd_nco_7233_0101");
    expect(resolveOccupation(after, "fitter")?.jobDomainId).not.toBe("jd_nco_7233_0101");
    // Untouched neighbours on both domains keep routing exactly as before.
    expect(resolveOccupation(after, "maintenance fitter")?.jobDomainId).toBe("jd_nco_7233_0101");
    expect(resolveOccupation(after, "bench fitter")?.jobDomainId).toBe("jd_nco_7233_0200");
  });

  it("refuses an invalid retirement file outright, for every reader", () => {
    const dir = writeFixtureCorpus([retire({ job_domain_id: "jd_nco_7233_0101", text: "fittr" })]);
    expect(() => resolveJobDomainCorpus(dir)).toThrow(/alias retirements invalid/);
    expect(() => resolveJobDomainCorpus(dir, { includeRetiredAliases: true })).toThrow(
      /alias retirements invalid/,
    );
    // The normalizer and the verifiers load keys through this — it must fail closed too.
    expect(() => loadRetiredAliasKeys(dir)).toThrow(/alias retirements invalid/);
  });

  it("hands the normalizer the NORMALIZED key, the one `text_norm` stores", () => {
    expect(loadRetiredAliasKeys(writeFixtureCorpus([A1]))).toEqual([
      { jobDomainId: "jd_nco_7233_0101", lang: "en", textNorm: retiredAliasKey(A1).textNorm },
    ]);
  });
});

// ── The SQL ──────────────────────────────────────────────────────────────────

describe("the SQL every writer and gate shares", () => {
  const dialect = new PgDialect();
  const KEYS = [retiredAliasKey(A1)];

  it("binds the retirement list as ONE jsonb parameter", () => {
    const q = dialect.sqlToQuery(retiredAliasPredicate(KEYS));
    expect(q.sql).toContain("jsonb_to_recordset($1::jsonb)");
    expect(q.params).toEqual([retiredAliasesJson(KEYS)]);
    expect(JSON.parse(q.params[0] as string)).toEqual([
      { job_domain_id: "jd_nco_7233_0101", lang: "en", text_norm: KEYS[0]?.textNorm },
    ]);
  });

  it("matches on the dedupe group — domain, lang and normalized text", () => {
    const { sql } = dialect.sqlToQuery(retiredAliasPredicate(KEYS));
    expect(sql).toContain(`r."job_domain_id" = a."job_domain_id"`);
    expect(sql).toContain(`r."lang" = a."lang"`);
    expect(sql).toContain(`r."text_norm" = a."text_norm"`);
  });

  it("is the SAME statement with zero retirements, so CI's e2e run exercises the real path", () => {
    const none = dialect.sqlToQuery(recomputeSearchableSql([]));
    const some = dialect.sqlToQuery(recomputeSearchableSql(KEYS));
    expect(none.sql).toBe(some.sql);
    expect(none.params).toEqual(["[]"]);
  });

  it("makes a retired row unsearchable in the election, on both sides of the diff", () => {
    const { sql } = dialect.sqlToQuery(recomputeSearchableSql(KEYS));
    expect(sql).toContain("AS retired");
    expect(sql).toContain(`SET "is_searchable" = (r.eligible AND NOT r.retired AND r.rn = 1)`);
    expect(sql).toContain(`IS DISTINCT FROM (r.eligible AND NOT r.retired AND r.rn = 1)`);
  });
});

describe("retiredAliasIds — REASON 4 for the lifecycle verifier", () => {
  const KEYS = [retiredAliasKey(A1)];
  const norm = KEYS[0]?.textNorm ?? "";

  it("demotes exactly the rows the SQL predicate would match", () => {
    const ids = retiredAliasIds(
      [
        { id: "hit", parentId: "jd_nco_7233_0101", lang: "en", textNorm: norm },
        { id: "other-domain", parentId: "jd_nco_7233_0200", lang: "en", textNorm: norm },
        { id: "other-lang", parentId: "jd_nco_7233_0101", lang: "hi", textNorm: norm },
        { id: "unnormalized", parentId: "jd_nco_7233_0101", lang: "en", textNorm: null },
      ],
      KEYS,
    );
    expect([...ids]).toEqual(["hit"]);
  });
});

// ── The committed file ───────────────────────────────────────────────────────

describe("the committed retirement file", () => {
  it("validates against the real corpus", () => {
    expect(() => loadRetiredAliasKeys()).not.toThrow();
  });

  it("leaves no retired alias in the retrieval view the routing tests are built from", () => {
    const keyOf = (k: RetiredAliasKey) => retiredKeyString(k.jobDomainId, k.lang, k.textNorm);
    const retired = new Set(loadRetiredAliasKeys().map(keyOf));
    const leaked = resolveJobDomainCorpus().flatMap((d) =>
      d.aliases
        .filter((a) =>
          retired.has(
            keyOf(retiredAliasKey({ job_domain_id: d.jobDomainId, lang: a.lang, text: a.text })),
          ),
        )
        .map((a) => `${d.jobDomainId} ${a.text}`),
    );
    expect(leaked).toEqual([]);
  });
});
