/**
 * `validateTaxonomyCorpus` — the gate between a machine-drafted taxonomy and the database.
 *
 * WHAT THESE TESTS ARE FOR. Every check in the validator exists because the corresponding
 * bad row is INVISIBLE once seeded. A skill with no edges seeds fine and is never shown.
 * A domain with no edges seeds fine and renders the employer picker EMPTY. Two skills whose
 * labels normalize alike seed fine and permanently split one concept, so half the workers
 * who have it stop matching the postings that want it. An alias owned by two skills seeds
 * fine and makes canonicalization a coin flip. None of these fail loudly later — so they
 * must fail here.
 *
 * The tests are therefore written as "this specific bad record is REJECTED, with THIS
 * code", one per check, rather than as a single happy-path assertion. A validator whose
 * checks are never proven to fire is indistinguishable from `return []`.
 *
 * They assert on the CODE, not the prose. The prose is for the human who has to fix the
 * corpus and should be free to improve; the code is what the batch manifest counts by and
 * is treated like a column name.
 */
import { describe, expect, it } from "vitest";
import { join } from "node:path";

import {
  GENERIC_SKILL_STOPLIST,
  edgeLocator,
  loadTaxonomyCorpus,
  shippedSkillIds,
  skillCatalogue,
  skillLocator,
  summariseTaxonomyCorpus,
  taxonomyProblemCode,
  taxonomyProblemLocator,
  taxonomySkillIdFor,
  validateTaxonomyCorpus,
  type TaxonomyDomainRecord,
  type TaxonomyDomainSkillRecord,
  type TaxonomySkillRecord,
} from "./taxonomy-corpus";

const FIXTURE_DIR = join(__dirname, "__fixtures__", "taxonomy");

const DOMAIN_ID = "jd_nco_7223_6002";

function domain(overrides: Partial<TaxonomyDomainRecord> = {}): TaxonomyDomainRecord {
  return {
    job_domain_id: DOMAIN_ID,
    label_en: "CNC Operator-Turning",
    trade_group: "cnc_machining",
    ...overrides,
  };
}

function skill(overrides: Partial<TaxonomySkillRecord> = {}): TaxonomySkillRecord {
  return {
    kind: "skill",
    skill_id: "skill_fanuc_cnc",
    label_en: "Fanuc CNC",
    label_hi: null,
    aliases: [
      { text: "fanuc", lang: "en" },
      { text: "fanuc controller", lang: "en" },
    ],
    ...overrides,
  };
}

function edge(overrides: Partial<TaxonomyDomainSkillRecord> = {}): TaxonomyDomainSkillRecord {
  return {
    kind: "domain_skill",
    job_domain_id: DOMAIN_ID,
    skill_id: "skill_fanuc_cnc",
    default_requirement: "required",
    relevance: 90,
    confidence: 0.9,
    source: "llm_bootstrap",
    ...overrides,
  };
}

/** Codes only — the assertion the tests actually care about. */
function codes(problems: string[]): string[] {
  return problems.map(taxonomyProblemCode);
}

describe("validateTaxonomyCorpus — the happy path", () => {
  it("accepts a well-formed skill + edge + domain", () => {
    expect(validateTaxonomyCorpus([skill()], [edge()], { domains: [domain()] })).toEqual([]);
  });

  it("accepts an edge pointing at a SHIPPED SKILL_CORPUS skill with no corpus record", () => {
    const shipped = [...shippedSkillIds()][0] as string;
    const problems = validateTaxonomyCorpus([], [edge({ skill_id: shipped })], {
      domains: [domain()],
    });
    expect(problems).toEqual([]);
  });

  it("accepts a null confidence — a curated edge has no machine certainty to state", () => {
    const problems = validateTaxonomyCorpus([skill()], [edge({ confidence: null, source: "curated" })], {
      domains: [domain()],
    });
    expect(problems).toEqual([]);
  });
});

describe("validateTaxonomyCorpus — skill identity", () => {
  it("rejects a skill_id that does not match ^skill_[a-z0-9_]+$", () => {
    const problems = validateTaxonomyCorpus([skill({ skill_id: "Fanuc-CNC" })], [], {
      domains: [domain()],
    });
    expect(codes(problems)).toContain("SKILL_ID_FORMAT");
    expect(problems[0]).toContain("Fanuc-CNC");
  });

  it("rejects an mskill_* id with its OWN message — the matchable vocabulary is closed", () => {
    const problems = validateTaxonomyCorpus([skill({ skill_id: "mskill_cnc_operation" })], [], {
      domains: [domain()],
    });
    expect(codes(problems)).toContain("SKILL_ID_MATCHABLE_PREFIX");
    // Not the generic format error: someone adding a 19th matchable skill needs to be told
    // that the vocabulary is closed, not that their string failed a regex.
    expect(codes(problems)).not.toContain("SKILL_ID_FORMAT");
  });

  it("rejects an id that collides with SKILL_CORPUS when reuse is not declared", () => {
    const shipped = [...shippedSkillIds()][0] as string;
    const problems = validateTaxonomyCorpus([skill({ skill_id: shipped })], [], {
      domains: [domain()],
    });
    expect(codes(problems)).toContain("SKILL_ID_COLLIDES_CORPUS");
    expect(problems[0]).toContain(shipped);
  });

  it("accepts the same collision when it is declared as a deliberate reuse", () => {
    const shipped = [...shippedSkillIds()][0] as string;
    const problems = validateTaxonomyCorpus(
      [skill({ skill_id: shipped, reuses_existing: true })],
      [edge({ skill_id: shipped })],
      { domains: [domain()] },
    );
    expect(problems).toEqual([]);
  });

  it("rejects reuses_existing on an id that is NOT actually shipped", () => {
    // The inverse of the collision rule, and it needs its own code because the failure mode
    // is completely different. Left unchecked, such a record passes the whole file-only gate
    // — `db:verify:taxonomy` prints "PASS — corpus is seedable" — and the contradiction only
    // appears later against a live database, where the seeder aborts with "run
    // 'pnpm db:seed:skills' first". That message names a fix that cannot possibly work:
    // seeding the shipped corpus will never produce an id that was never in it.
    const problems = validateTaxonomyCorpus(
      [skill({ skill_id: "skill_definitely_not_shipped", reuses_existing: true })],
      [edge({ skill_id: "skill_definitely_not_shipped" })],
      { domains: [domain()] },
    );
    expect(codes(problems)).toContain("SKILL_ID_REUSE_UNKNOWN");
    // And it must NOT be misreported as the collision case, which would send the author
    // looking for a clash that does not exist.
    expect(codes(problems)).not.toContain("SKILL_ID_COLLIDES_CORPUS");
  });

  it("rejects a duplicate skill_id inside the corpus", () => {
    const problems = validateTaxonomyCorpus(
      [skill(), skill({ label_en: "Fanuc Control" })],
      [edge()],
      { domains: [domain()] },
    );
    expect(codes(problems)).toContain("SKILL_ID_DUPLICATE");
  });
});

describe("validateTaxonomyCorpus — skill lifecycle (status / replaced_by, TD-04/TD-06)", () => {
  it("accepts a deprecated skill replaced_by a SHIPPED skill, edges left pointing at it", () => {
    const shippedTarget = [...shippedSkillIds()][0] as string;
    const problems = validateTaxonomyCorpus(
      [skill({ status: "deprecated", replaced_by: shippedTarget })],
      [edge()],
      { domains: [domain()] },
    );
    expect(problems).toEqual([]);
  });

  it("accepts status: deprecated with no replaced_by — retired, nothing to re-tag to", () => {
    const problems = validateTaxonomyCorpus([skill({ status: "deprecated" })], [edge()], {
      domains: [domain()],
    });
    expect(problems).toEqual([]);
  });

  it('rejects any "status" other than "deprecated" — promotion is promote-skills.ts\'s job', () => {
    const problems = validateTaxonomyCorpus(
      // @ts-expect-error — deliberately not the one legal literal, to prove the runtime guard
      // catches what the compiler alone would not for hand-authored/generated JSONL.
      [skill({ status: "active" })],
      [edge()],
      { domains: [domain()] },
    );
    expect(codes(problems)).toContain("SKILL_STATUS_INVALID");
  });

  it("rejects replaced_by set without status: deprecated", () => {
    const shippedTarget = [...shippedSkillIds()][0] as string;
    const problems = validateTaxonomyCorpus(
      [skill({ replaced_by: shippedTarget })],
      [edge()],
      { domains: [domain()] },
    );
    expect(codes(problems)).toContain("SKILL_REPLACED_BY_WITHOUT_STATUS");
  });

  it("rejects replaced_by that does not resolve to a shipped SKILL_CORPUS id", () => {
    const problems = validateTaxonomyCorpus(
      [skill({ status: "deprecated", replaced_by: "skill_definitely_not_shipped" })],
      [edge()],
      { domains: [domain()] },
    );
    expect(codes(problems)).toContain("SKILL_REPLACED_BY_UNKNOWN");
  });

  it("rejects replaced_by pointing at ANOTHER corpus-authored draft, not a shipped id", () => {
    // The seeder inserts every corpus skill in one pass with no ordering guarantee between
    // two draft rows — the self-FK would risk failing mid-transaction. Only a shipped id,
    // guaranteed to already exist, is a legal target.
    const problems = validateTaxonomyCorpus(
      [
        skill({ skill_id: "skill_a", status: "deprecated", replaced_by: "skill_b" }),
        skill({ skill_id: "skill_b", label_en: "Skill B" }),
      ],
      [edge({ skill_id: "skill_a" }), edge({ skill_id: "skill_b" })],
      { domains: [domain()] },
    );
    expect(codes(problems)).toContain("SKILL_REPLACED_BY_UNKNOWN");
  });

  it("rejects status/replaced_by combined with reuses_existing — meaningless there", () => {
    const shipped = [...shippedSkillIds()][0] as string;
    const problems = validateTaxonomyCorpus(
      [skill({ skill_id: shipped, reuses_existing: true, status: "deprecated", replaced_by: shipped })],
      [edge({ skill_id: shipped })],
      { domains: [domain()] },
    );
    expect(codes(problems)).toContain("SKILL_STATUS_ON_REUSE");
  });

  it("does NOT orphan a deprecated skill whose edges are left pointing at it", () => {
    // TD-04/TD-06's own choice: leave domain_skill edges as-is rather than re-point them
    // (mirrors TD-01/02/03) — so the deprecated skill must stay non-orphaned as long as at
    // least one edge remains.
    const shippedTarget = [...shippedSkillIds()][0] as string;
    const problems = validateTaxonomyCorpus(
      [skill({ status: "deprecated", replaced_by: shippedTarget })],
      [edge()],
      { domains: [domain()] },
    );
    expect(codes(problems)).not.toContain("SKILL_ORPHAN");
  });
});

describe("validateTaxonomyCorpus — the synonym-as-canonical trap", () => {
  it("rejects two skills whose label_en normalizes identically", () => {
    const problems = validateTaxonomyCorpus(
      [
        skill({ skill_id: "skill_fanuc_cnc", label_en: "Fanuc CNC" }),
        skill({ skill_id: "skill_fanuc_cnc_2", label_en: "  fanuc, cnc  " }),
      ],
      [edge(), edge({ skill_id: "skill_fanuc_cnc_2" })],
      { domains: [domain()] },
    );
    const collision = problems.filter((p) => taxonomyProblemCode(p) === "SKILL_LABEL_COLLIDES");
    expect(collision).toHaveLength(1);
    // Names BOTH sides — a reviewer cannot act on "this label collides" alone.
    expect(collision[0]).toContain("skill_fanuc_cnc_2");
    expect(collision[0]).toContain("skill_fanuc_cnc");
  });

  it("rejects a label that is just the domain name restated", () => {
    const problems = validateTaxonomyCorpus(
      [skill({ skill_id: "skill_cnc_operator_turning", label_en: "CNC Operator-Turning" })],
      [edge({ skill_id: "skill_cnc_operator_turning" })],
      { domains: [domain()] },
    );
    expect(codes(problems)).toContain("SKILL_LABEL_IS_DOMAIN_NAME");
    expect(problems.find((p) => taxonomyProblemCode(p) === "SKILL_LABEL_IS_DOMAIN_NAME")).toContain(
      DOMAIN_ID,
    );
  });

  it("FLAGS a single-word over-generic skill so a human decides", () => {
    for (const word of ["work", "machine", "safety", "tools", "operation"]) {
      expect(GENERIC_SKILL_STOPLIST).toContain(word);
      const problems = validateTaxonomyCorpus(
        [skill({ skill_id: `skill_${word}`, label_en: word })],
        [edge({ skill_id: `skill_${word}` })],
        { domains: [domain()] },
      );
      expect(codes(problems)).toContain("SKILL_LABEL_OVER_GENERIC");
    }
  });

  it("does NOT flag the same word inside a multi-word skill", () => {
    const problems = validateTaxonomyCorpus(
      [skill({ skill_id: "skill_machine_levelling", label_en: "Machine Levelling" })],
      [edge({ skill_id: "skill_machine_levelling" })],
      { domains: [domain()] },
    );
    expect(codes(problems)).not.toContain("SKILL_LABEL_OVER_GENERIC");
  });

  it("honours an extra stoplist word supplied by the caller", () => {
    const problems = validateTaxonomyCorpus(
      [skill({ skill_id: "skill_shopfloor", label_en: "Shopfloor" })],
      [edge({ skill_id: "skill_shopfloor" })],
      { domains: [domain()], extraStoplist: ["shopfloor"] },
    );
    expect(codes(problems)).toContain("SKILL_LABEL_OVER_GENERIC");
  });
});

describe("validateTaxonomyCorpus — aliases", () => {
  it("rejects two aliases of the SAME skill that normalize alike", () => {
    // The particle stripper collapses "fanuc wala" onto "fanuc": only one can win
    // is_searchable, so the loser is an unreachable row that still costs an embedding.
    const problems = validateTaxonomyCorpus(
      [
        skill({
          aliases: [
            { text: "fanuc", lang: "en" },
            { text: "fanuc wala", lang: "en" },
          ],
        }),
      ],
      [edge()],
      { domains: [domain()] },
    );
    expect(codes(problems)).toEqual(["ALIAS_DUPLICATE_WITHIN_SKILL"]);
  });

  it("rejects an alias that a DIFFERENT skill already claims", () => {
    const problems = validateTaxonomyCorpus(
      [
        skill({ skill_id: "skill_fanuc_cnc", aliases: [{ text: "fanuc", lang: "en" }] }),
        skill({
          skill_id: "skill_fanuc_alarms",
          label_en: "Fanuc Alarm Handling",
          aliases: [{ text: "Fanuc", lang: "en" }],
        }),
      ],
      [edge(), edge({ skill_id: "skill_fanuc_alarms" })],
      { domains: [domain()] },
    );
    const ambiguous = problems.filter((p) => taxonomyProblemCode(p) === "ALIAS_AMBIGUOUS");
    expect(ambiguous).toHaveLength(1);
    expect(ambiguous[0]).toContain("skill_fanuc_cnc");
  });

  it("allows the same alias text under two different langs", () => {
    const problems = validateTaxonomyCorpus(
      [
        skill({
          aliases: [
            { text: "fanuc", lang: "en" },
            { text: "फैनुक", lang: "hi" },
          ],
        }),
      ],
      [edge()],
      { domains: [domain()] },
    );
    expect(problems).toEqual([]);
  });

  it("rejects an alias over 60 characters", () => {
    const problems = validateTaxonomyCorpus(
      [skill({ aliases: [{ text: "a".repeat(61), lang: "en" }] })],
      [edge()],
      { domains: [domain()] },
    );
    expect(codes(problems)).toContain("ALIAS_TOO_LONG");
  });

  it("rejects a label_en over 120 characters", () => {
    const problems = validateTaxonomyCorpus(
      [skill({ label_en: "Fanuc ".repeat(30) })],
      [edge()],
      { domains: [domain()] },
    );
    expect(codes(problems)).toContain("SKILL_LABEL_TOO_LONG");
  });

  it("rejects an alias with a bad lang", () => {
    const problems = validateTaxonomyCorpus(
      [skill({ aliases: [{ text: "fanuc", lang: "mr" as never }] })],
      [edge()],
      { domains: [domain()] },
    );
    expect(codes(problems)).toContain("ALIAS_LANG_ENUM");
  });

  it("rejects a skill with zero aliases — ADR-0030 embeds aliases, not the label", () => {
    const problems = validateTaxonomyCorpus([skill({ aliases: [] })], [edge()], {
      domains: [domain()],
    });
    expect(codes(problems)).toContain("ALIAS_LIST_EMPTY");
  });
});

describe("validateTaxonomyCorpus — the PII / junk guard", () => {
  // Shares `hasForbiddenAliasChars` with the job-domain corpus deliberately: two copies of
  // a PII rule drift, and the copy that drifts is the one nobody tests.
  it.each([
    ["a digit", "Fanuc 31i"],
    ["a Devanagari digit", "फैनुक ३१"],
    ["an at sign", "fanuc@shop"],
    ["a URL", "see https://fanuc.example"],
    ["a bare www host", "www.fanuc.example"],
  ])("rejects %s in an alias", (_why, text) => {
    const problems = validateTaxonomyCorpus([skill({ aliases: [{ text, lang: "en" }] })], [edge()], {
      domains: [domain()],
    });
    expect(codes(problems)).toContain("TEXT_FORBIDDEN_CHARS");
  });

  it("rejects the same junk in label_en and in label_hi", () => {
    const en = validateTaxonomyCorpus([skill({ label_en: "Fanuc 31i" })], [edge()], {
      domains: [domain()],
    });
    expect(codes(en)).toContain("TEXT_FORBIDDEN_CHARS");
    const hi = validateTaxonomyCorpus([skill({ label_hi: "call me @ shop" })], [edge()], {
      domains: [domain()],
    });
    expect(codes(hi)).toContain("TEXT_FORBIDDEN_CHARS");
  });
});

describe("validateTaxonomyCorpus — edges", () => {
  it("rejects an edge whose job_domain_id is not in sample-domains.jsonl", () => {
    const problems = validateTaxonomyCorpus([skill()], [edge({ job_domain_id: "jd_nco_9999_0000" })], {
      domains: [domain()],
    });
    expect(codes(problems)).toContain("EDGE_UNKNOWN_DOMAIN");
  });

  it("rejects an edge whose skill_id is in neither skills.jsonl nor SKILL_CORPUS", () => {
    const problems = validateTaxonomyCorpus([], [edge({ skill_id: "skill_invented_by_a_model" })], {
      domains: [domain()],
    });
    expect(codes(problems)).toContain("EDGE_UNKNOWN_SKILL");
  });

  it("rejects an edge pointing at the closed matchable vocabulary", () => {
    const problems = validateTaxonomyCorpus([], [edge({ skill_id: "mskill_cnc_operation" })], {
      domains: [domain()],
    });
    expect(codes(problems)).toContain("EDGE_MATCHABLE_SKILL");
  });

  it("rejects a duplicate (job_domain_id, skill_id) pair", () => {
    const problems = validateTaxonomyCorpus([skill()], [edge(), edge({ relevance: 10 })], {
      domains: [domain()],
    });
    expect(codes(problems)).toContain("EDGE_DUPLICATE");
  });

  it.each([
    [-1, "below zero"],
    [101, "above one hundred"],
    [50.5, "not an integer — the column is a smallint"],
  ])("rejects relevance %s (%s)", (relevance) => {
    const problems = validateTaxonomyCorpus([skill()], [edge({ relevance })], {
      domains: [domain()],
    });
    expect(codes(problems)).toContain("EDGE_RELEVANCE_RANGE");
  });

  it.each([-0.1, 1.1])("rejects confidence %s", (confidence) => {
    const problems = validateTaxonomyCorpus([skill()], [edge({ confidence })], {
      domains: [domain()],
    });
    expect(codes(problems)).toContain("EDGE_CONFIDENCE_RANGE");
  });

  it("rejects a bad default_requirement", () => {
    const problems = validateTaxonomyCorpus(
      [skill()],
      [edge({ default_requirement: "mandatory" as never })],
      { domains: [domain()] },
    );
    expect(codes(problems)).toContain("EDGE_REQUIREMENT_ENUM");
  });

  it("rejects a bad source", () => {
    const problems = validateTaxonomyCorpus([skill()], [edge({ source: "guessed" as never })], {
      domains: [domain()],
    });
    expect(codes(problems)).toContain("EDGE_SOURCE_ENUM");
  });
});

describe("validateTaxonomyCorpus — the silent coverage holes", () => {
  it("rejects a skill with ZERO edges — it seeds, it embeds, and nothing reaches it", () => {
    const problems = validateTaxonomyCorpus(
      [skill(), skill({ skill_id: "skill_orphan", label_en: "Turret Indexing" })],
      [edge()],
      { domains: [domain()] },
    );
    const orphan = problems.filter((p) => taxonomyProblemCode(p) === "SKILL_ORPHAN");
    expect(orphan).toHaveLength(1);
    expect(orphan[0]).toContain("skill_orphan");
  });

  it("rejects a domain with ZERO edges — the employer picker renders empty for it", () => {
    const problems = validateTaxonomyCorpus(
      [skill()],
      [edge()],
      { domains: [domain(), domain({ job_domain_id: "jd_nco_7212_0300", label_en: "Gas Welder" })] },
    );
    const orphan = problems.filter((p) => taxonomyProblemCode(p) === "DOMAIN_ORPHAN");
    expect(orphan).toHaveLength(1);
    expect(orphan[0]).toContain("jd_nco_7212_0300");
  });

  it("rejects a malformed or duplicated domain pointer", () => {
    expect(
      codes(validateTaxonomyCorpus([], [], { domains: [domain({ job_domain_id: "7223.6002" })] })),
    ).toContain("DOMAIN_ID_FORMAT");
    expect(codes(validateTaxonomyCorpus([], [], { domains: [domain(), domain()] }))).toContain(
      "DOMAIN_DUPLICATE",
    );
  });

  it("collects EVERY problem rather than throwing on the first", () => {
    const problems = validateTaxonomyCorpus(
      [skill({ skill_id: "BAD" }), skill({ skill_id: "mskill_x" }), skill({ aliases: [] })],
      [edge({ job_domain_id: "jd_missing" })],
      { domains: [domain()] },
    );
    expect(problems.length).toBeGreaterThanOrEqual(4);
  });
});

describe("problem string format", () => {
  it("is locator: CODE — prose, so ingest can drop exactly the offending record", () => {
    const problems = validateTaxonomyCorpus([skill({ aliases: [] })], [edge()], {
      domains: [domain()],
    });
    expect(problems[0]).toMatch(/^skill\[skill_fanuc_cnc\]: [A-Z_]+ — /);
    expect(taxonomyProblemLocator(problems[0] as string)).toBe(skillLocator("skill_fanuc_cnc"));
  });

  it("locates an edge by its pair, matching edgeLocator", () => {
    const problems = validateTaxonomyCorpus([], [edge({ skill_id: "skill_nope" })], {
      domains: [domain()],
    });
    expect(taxonomyProblemLocator(problems[0] as string)).toBe(edgeLocator(DOMAIN_ID, "skill_nope"));
  });

  it("returns UNKNOWN rather than throwing for a foreign string", () => {
    expect(taxonomyProblemCode("something else entirely")).toBe("UNKNOWN");
    expect(taxonomyProblemLocator("something else entirely")).toBeNull();
  });
});

describe("taxonomySkillIdFor", () => {
  it("is a pure function of the label — the model never supplies an id", () => {
    expect(taxonomySkillIdFor("Fanuc CNC")).toBe("skill_fanuc_cnc");
    expect(taxonomySkillIdFor("  Fanuc  CNC  ")).toBe("skill_fanuc_cnc");
    expect(taxonomySkillIdFor("Oxy-Fuel Cutting (manual)")).toBe("skill_oxy_fuel_cutting_manual");
  });

  it("mints an id the validator accepts", () => {
    const id = taxonomySkillIdFor("Turret Indexing");
    const problems = validateTaxonomyCorpus(
      [skill({ skill_id: id, label_en: "Turret Indexing" })],
      [edge({ skill_id: id })],
      { domains: [domain()] },
    );
    expect(problems).toEqual([]);
  });

  it("mints an id that a SHIPPED label would collide with — which the validator then catches", () => {
    // `skill_tool_offset_setting` is already in SKILL_CORPUS, so a model proposing "Tool
    // Offset Setting" as a NEW skill produces a colliding id. That chain — mint, then
    // reject — is the design: the generator never has to know the shipped vocabulary.
    const id = taxonomySkillIdFor("Tool Offset Setting");
    expect(shippedSkillIds().has(id)).toBe(true);
    expect(
      codes(
        validateTaxonomyCorpus([skill({ skill_id: id, label_en: "Tool Offset Setting" })], [], {
          domains: [domain()],
        }),
      ),
    ).toContain("SKILL_ID_COLLIDES_CORPUS");
  });
});

describe("skillCatalogue", () => {
  it("excludes deprecated skills — a model must not be told to reuse a retired id", () => {
    const ids = new Set(skillCatalogue().map((e) => e.skill_id));
    expect(ids.size).toBeGreaterThan(0);
    // Every catalogue id is a shipped id, and the catalogue is smaller than or equal to
    // the full shipped set (deprecated rows are dropped).
    for (const id of ids) expect(shippedSkillIds().has(id)).toBe(true);
    expect(ids.size).toBeLessThanOrEqual(shippedSkillIds().size);
  });

  it("folds in already-authored corpus skills, deduped and sorted", () => {
    const withExtra = skillCatalogue([skill({ skill_id: "skill_aaa_first" }), skill({ skill_id: "skill_aaa_first" })]);
    expect(withExtra.filter((e) => e.skill_id === "skill_aaa_first")).toHaveLength(1);
    const ids = withExtra.map((e) => e.skill_id);
    expect(ids).toEqual([...ids].sort());
  });
});

describe("loadTaxonomyCorpus", () => {
  it("partitions a directory by kind, treating an untagged line as a domain", () => {
    const corpus = loadTaxonomyCorpus(FIXTURE_DIR);
    expect(corpus.domains.map((d) => d.job_domain_id)).toEqual([
      "jd_nco_7223_6002",
      "jd_nco_7212_0300",
    ]);
    expect(corpus.skills.map((s) => s.skill_id)).toEqual(["skill_fanuc_cnc", "skill_oxy_fuel_cutting"]);
    expect(corpus.edges).toHaveLength(2);
  });

  it("returns an empty corpus for a directory that does not exist", () => {
    expect(loadTaxonomyCorpus(join(FIXTURE_DIR, "nope"))).toEqual({
      domains: [],
      skills: [],
      edges: [],
    });
  });

  it("validates clean, which keeps the fixture honest as an example of the pinned format", () => {
    const corpus = loadTaxonomyCorpus(FIXTURE_DIR);
    expect(validateTaxonomyCorpus(corpus.skills, corpus.edges, { domains: corpus.domains })).toEqual(
      [],
    );
  });

  it("summarises with ids + integers only", () => {
    const summary = summariseTaxonomyCorpus(loadTaxonomyCorpus(FIXTURE_DIR));
    expect(summary).toMatchObject({ domains: 2, skills: 2, edges: 2, edges_required: 2, aliases: 3 });
    for (const v of Object.values(summary)) expect(typeof v).toBe("number");
  });
});
