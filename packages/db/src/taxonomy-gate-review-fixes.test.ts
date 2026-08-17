/**
 * REGRESSION PINS FOR THE ADVERSARIAL REVIEW FINDINGS.
 *
 * Every test here exists because an independent review broke something, and every one of them
 * FAILED before the corresponding fix. They are collected in one file rather than scattered
 * because that is the useful framing for the next reader: this is the list of ways this
 * harness has actually been wrong, not a list of things somebody imagined it might do.
 *
 * The two that matter most, both of which made the gate WRONG rather than merely incomplete:
 *
 *   - the gate blocked its own required input. The prompt demands Devanagari aliases; a
 *     Devanagari alias can never share a token with a Latin label; "shares no token with the
 *     label" was read as evidence of a second concept. Every bilingual skill with two Hindi
 *     synonym families scored a confident FALSE_REUSE, and there is no override.
 *   - the gate punished reuse. A batch that correctly echoed `existing_skill_id` inherited
 *     that skill's pre-existing faults and blocked; a batch that lazily minted a fresh
 *     synonym passed. The harness exists to encourage reuse.
 *
 * NO REAL TAXONOMY DATA IS CREATED HERE.
 */
import { readFileSync } from "node:fs";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildBatchManifest, ingest, survivingValidatorProblems } from "./generate-domain-skills";
import {
  TAXONOMY_DATA_DIR,
  skillLocator,
  validateTaxonomyCorpus,
  type TaxonomyDomainRecord,
  type TaxonomyDomainSkillRecord,
  type TaxonomySkillRecord,
} from "./taxonomy-corpus";
import { aliasCoherence, buildSkillSurface, type ShippedSkillView } from "./taxonomy-lexical";
import {
  analyzeTaxonomyQuality,
  isBlockingCode,
  taxonomyQualityVerdict,
} from "./taxonomy-quality-gate";
import { analyzeReuse } from "./taxonomy-reuse-analysis";
import { type ConvergenceGroup } from "./taxonomy-convergence";

const CNC_TURNING = "jd_nco_7223_6002";
const CNC_PROGRAMMER = "jd_nco_7223_6003";

const DOMAINS: TaxonomyDomainRecord[] = [
  { job_domain_id: CNC_TURNING, label_en: "CNC Operator-Turning", trade_group: "cnc_machining" },
  { job_domain_id: CNC_PROGRAMMER, label_en: "CNC Programmer", trade_group: "cnc_machining" },
];

const CNC_GROUP: ConvergenceGroup = {
  group: "cnc_machining",
  job_domain_ids: [CNC_TURNING, CNC_PROGRAMMER],
  concepts: [{ concept: "Fanuc control", probes: ["fanuc"] }],
};

const NO_SHIPPED: ShippedSkillView[] = [];

function skill(overrides: Partial<TaxonomySkillRecord> = {}): TaxonomySkillRecord {
  return {
    kind: "skill",
    skill_id: "skill_x",
    label_en: "Turret Indexing",
    label_hi: null,
    aliases: [{ text: "turret index", lang: "en" }],
    ...overrides,
  };
}

function edge(overrides: Partial<TaxonomyDomainSkillRecord> = {}): TaxonomyDomainSkillRecord {
  return {
    kind: "domain_skill",
    job_domain_id: CNC_TURNING,
    skill_id: "skill_x",
    default_requirement: "required",
    relevance: 80,
    confidence: 0.8,
    source: "llm_bootstrap",
    ...overrides,
  };
}

function gate(
  skills: readonly TaxonomySkillRecord[],
  edges: readonly TaxonomyDomainSkillRecord[],
  overrides: Parameters<typeof analyzeTaxonomyQuality>[2] extends infer O ? Partial<O> : never = {},
) {
  const findings = analyzeTaxonomyQuality(skills, edges, {
    domains: DOMAINS,
    shipped: NO_SHIPPED,
    groups: [CNC_GROUP],
    problems: [],
    ...overrides,
  });
  return { findings, ...taxonomyQualityVerdict(findings) };
}

// ===========================================================================
// FINDING 1 — the gate blocked its own required input
// ===========================================================================

describe("cross-script aliases are not evidence of a second concept", () => {
  it("a Latin label with TWO families of Hindi aliases is coherent", () => {
    // Reproduced verbatim from the review. Four correct Hindi synonyms for mortar: गारा and
    // मसाला are both the material, and they share no token with each other or with the label
    // — because they are a different alphabet, not a different concept.
    const surface = buildSkillSurface("skill_mortar_mixing", "Mortar Mixing", [
      "mortar mix",
      "गारा मिश्रण",
      "गारा बनाना",
      "मसाला तैयार",
      "मसाला घोल",
    ]);
    expect(aliasCoherence(surface).divergent_clusters).toEqual([]);
  });

  it("and therefore does not BLOCK, which is what made this critical", () => {
    // `generate-domain-skills.ts` asks the model for "Hindi in Devanagari". Before the fix the
    // gate rejected exactly what it requested, with no override anywhere in the pipeline.
    const s = skill({
      skill_id: "skill_mortar_mixing",
      label_en: "Mortar Mixing",
      aliases: [
        { text: "mortar mix", lang: "en" },
        { text: "गारा मिश्रण", lang: "hi" },
        { text: "गारा बनाना", lang: "hi" },
        { text: "मसाला तैयार", lang: "hi" },
        { text: "मसाला घोल", lang: "hi" },
      ],
    });
    expect(gate([s], [edge({ skill_id: s.skill_id })]).verdict).toBe("PASS");
  });

  it("a SINGLE Hindi family is not even worth_looking_at", () => {
    // The weaker symptom, and the more corrosive one: one divergent cluster is
    // POTENTIAL_AMBIGUITY, so every bilingual skill in the corpus would carry permanent
    // advisory noise and the section would stop being read.
    const s = skill({
      skill_id: "skill_weld_bead_inspection",
      label_en: "Weld Bead Inspection",
      aliases: [
        { text: "वेल्ड जांच", lang: "hi" },
        { text: "वेल्ड परीक्षण", lang: "hi" },
      ],
    });
    const result = gate([s], [edge({ skill_id: s.skill_id })]);
    expect(result.findings.findings.map((f) => f.code)).not.toContain("POTENTIAL_AMBIGUITY");
  });

  it("STILL detects a genuine merge — two Latin families on one row", () => {
    // The other direction, and the reason the fix is a script split rather than deleting the
    // check: a row carrying both Fanuc vocabulary and mortar vocabulary is two concepts.
    const surface = buildSkillSurface("skill_merged", "Fanuc Control Operation", [
      "fanuc controller",
      "mortar mixing",
      "mortar mix",
    ]);
    expect(aliasCoherence(surface).divergent_clusters.length).toBeGreaterThanOrEqual(1);
  });
});

// ===========================================================================
// FINDING 3 — the gate punished reuse
// ===========================================================================

describe("attribution: authoring a skill and pointing at one are different acts", () => {
  const OLD_A = skill({
    skill_id: "skill_hydraulic_hose_crimping",
    label_en: "Hydraulic Hose Crimping",
    aliases: [{ text: "hose crimping", lang: "en" }],
  });
  const OLD_B = skill({
    skill_id: "skill_crimping_hydraulic_hose",
    label_en: "Crimping Hydraulic Hose",
    aliases: [{ text: "hydraulic crimping", lang: "en" }],
  });
  const EDGES = [
    edge({ skill_id: OLD_A.skill_id, job_domain_id: CNC_TURNING }),
    edge({ skill_id: OLD_B.skill_id, job_domain_id: CNC_PROGRAMMER }),
  ];

  it("a batch that merely REUSES a committed skill does not inherit its duplicate twin", () => {
    // The inversion in one assertion. Both duplicates are committed; this batch added one
    // edge pointing at one of them — the reuse the whole harness is built to encourage.
    const result = gate([OLD_A, OLD_B], EDGES, {
      attributableSkillIds: [], // authored nothing
      attributableEdgeSkillIds: [OLD_A.skill_id], // pointed at one
    });
    expect(result.verdict).toBe("PASS");
  });

  it("but a batch that AUTHORED one of them still blocks", () => {
    const result = gate([OLD_A, OLD_B], EDGES, {
      attributableSkillIds: [OLD_B.skill_id],
      attributableEdgeSkillIds: [OLD_B.skill_id],
    });
    expect(result.verdict).toBe("BLOCK");
  });

  it("a NEW EDGE owns the fragmentation it creates, even between two committed skills", () => {
    // The asymmetry that makes the split correct rather than merely lenient. Two equivalent
    // skills sit harmlessly in the corpus until somebody wires them into one family of
    // trades; whoever added the wire is who can pull it out.
    const a = skill({
      skill_id: "skill_fanuc_control_operation",
      label_en: "Fanuc Control Operation",
      aliases: [{ text: "fanuc", lang: "en" }],
    });
    const b = skill({
      skill_id: "skill_fanuc_control",
      label_en: "Fanuc Control",
      aliases: [{ text: "fanuc controller", lang: "en" }],
    });
    const edges = [
      edge({ skill_id: a.skill_id, job_domain_id: CNC_TURNING }),
      edge({ skill_id: b.skill_id, job_domain_id: CNC_PROGRAMMER }),
    ];
    const result = gate([a, b], edges, {
      attributableSkillIds: [], // authored neither
      attributableEdgeSkillIds: [b.skill_id], // but wired one in
    });
    expect(result.blocking.map((f) => f.code)).toContain("CONVERGENCE_FRAGMENTED");
  });

  it("and a batch that touched neither the rows nor the wires blocks on nothing", () => {
    const a = skill({
      skill_id: "skill_fanuc_control_operation",
      label_en: "Fanuc Control Operation",
      aliases: [{ text: "fanuc", lang: "en" }],
    });
    const b = skill({
      skill_id: "skill_fanuc_control",
      label_en: "Fanuc Control",
      aliases: [{ text: "fanuc controller", lang: "en" }],
    });
    const result = gate(
      [a, b],
      [
        edge({ skill_id: a.skill_id, job_domain_id: CNC_TURNING }),
        edge({ skill_id: b.skill_id, job_domain_id: CNC_PROGRAMMER }),
      ],
      { attributableSkillIds: [], attributableEdgeSkillIds: [] },
    );
    expect(result.verdict).toBe("PASS");
  });
});

// ===========================================================================
// FINDING 6 — the audit record could lie
// ===========================================================================

describe("severity is derived from the policy, not typed alongside it", () => {
  it("every finding's severity agrees with BLOCKING_CODES", () => {
    // `taxonomyQualityVerdict` reads `isBlockingCode(f.code)` and never `f.severity`, so a
    // hand-typed severity was unenforced decoration written straight into quality-gate.json.
    // Flipping all five call sites to "ADVISORY" used to change nothing any test could see.
    const dup = [
      skill({
        skill_id: "skill_a",
        label_en: "Hydraulic Hose Crimping",
        aliases: [{ text: "hose crimping", lang: "en" }],
      }),
      skill({
        skill_id: "skill_b",
        label_en: "Crimping Hydraulic Hose",
        aliases: [{ text: "hydraulic crimping", lang: "en" }],
      }),
    ];
    const result = gate(dup, [
      edge({ skill_id: "skill_a" }),
      edge({ skill_id: "skill_b", job_domain_id: CNC_PROGRAMMER }),
    ]);
    expect(result.findings.findings.length).toBeGreaterThan(0);
    for (const f of result.findings.findings) {
      expect(f.severity, `${f.code} severity must follow the policy`).toBe(
        isBlockingCode(f.code) ? "BLOCKING" : "ADVISORY",
      );
    }
  });

  it("no total is NaN — the code list cannot silently lose a member", () => {
    // `QUALITY_GATE_CODES` is derived from a `Record<QualityGateCode, true>` witness, so a
    // dropped member is a compile error. Before that, `totals[code] += 1` on an absent key
    // produced NaN and serialized into the audit record as null.
    const result = gate([skill()], [edge()]);
    for (const [code, n] of Object.entries(result.findings.totals)) {
      expect(Number.isFinite(n), `${code} total must be a number`).toBe(true);
    }
  });
});

// ===========================================================================
// FINDING 8 — a reviewer sent chasing an id that does not exist
// ===========================================================================

describe("a weak WITHIN-BATCH overlap is not reported as a shipped one", () => {
  it("names the sibling as a sibling, with a WITHIN_BATCH prefix", () => {
    // Half the informative tokens shared, no strict relation — the weak band exactly.
    const a = skill({
      skill_id: "skill_hydraulic_pump_overhaul",
      label_en: "Hydraulic Pump Overhaul",
      aliases: [{ text: "pump overhaul", lang: "en" }],
    });
    const b = skill({
      skill_id: "skill_hydraulic_valve_overhaul",
      label_en: "Hydraulic Valve Overhaul",
      aliases: [{ text: "valve overhaul", lang: "en" }],
    });
    const report = analyzeReuse(
      [a, b],
      [
        edge({ skill_id: a.skill_id }),
        edge({ skill_id: b.skill_id, job_domain_id: CNC_PROGRAMMER }),
      ],
      { domains: DOMAINS, shipped: NO_SHIPPED, problems: [] },
    );
    const weak = report.decisions.filter((d) => d.category === "POTENTIAL_AMBIGUITY");
    expect(weak.length).toBeGreaterThan(0);
    for (const d of weak) {
      // The defect precisely: naming the sibling as a SHIPPED id. Saying "neither is shipped"
      // is the corrected wording, so the assertion targets the claim, not the word.
      expect(d.reason, "must not present a sibling as a shipped id").not.toMatch(
        /overlaps shipped/,
      );
      expect(d.evidence.some((e) => e.startsWith("WITHIN_BATCH:"))).toBe(true);
    }
  });
});

// ===========================================================================
// FINDING 12 — "reused 0/3" on a group nobody has drafted
// ===========================================================================

describe("a trade group with no edges reads not_drafted, never a zero ratio", () => {
  it("reports NULL and not_drafted rather than an apparent reuse failure", () => {
    const report = analyzeReuse([], [], {
      domains: DOMAINS,
      shipped: [
        { skill_id: "skill_turning", label_en: "Turning (lathe operation)", aliases: ["turning"] },
      ],
      problems: [],
    });
    const cnc = report.by_trade_group.find((g) => g.trade_group === "cnc_machining");
    // The shipped corpus DOES cover this group, so the denominator is non-zero — the old rule
    // therefore rendered `ratio=0 (covered)`, which reads as "the generator reused nothing".
    expect(cnc?.available_candidate_skills).toBeGreaterThan(0);
    expect(cnc?.reuse_opportunity_ratio).toBeNull();
    expect(cnc?.limitation).toBe("not_drafted");
  });
});

// ===========================================================================
// FINDING 4 — a rejected candidate erasing a committed record's fault
// ===========================================================================

describe("dropping a rejected candidate's problems does not drop a committed record's", () => {
  const COMMITTED = skillLocator("skill_turret_index_setup");
  const PROBLEM = `${COMMITTED}: ALIAS_AMBIGUOUS — "turret" is already an alias of skill_other.`;

  it("keeps the problem when the locator also names a COMMITTED record", () => {
    // The id-aliasing case: a candidate mints an id the corpus already holds, so
    // `skill[<id>]` is the locator of both. Dropping by locator alone erased the committed
    // record's genuine fault from the report — including from the PRE-EXISTING section.
    expect(
      survivingValidatorProblems([PROBLEM], new Set([COMMITTED]), new Set([COMMITTED])),
    ).toEqual([PROBLEM]);
  });

  it("still drops it when the locator is a rejected CANDIDATE only", () => {
    expect(survivingValidatorProblems([PROBLEM], new Set([COMMITTED]), new Set())).toEqual([]);
  });

  it("always keeps a problem with no locator at all", () => {
    const parse = "response line 3: not valid JSON";
    expect(survivingValidatorProblems([parse], new Set([COMMITTED]), new Set())).toEqual([parse]);
  });
});

// ===========================================================================
// FINDING 7 — the all-generic label that was invisible to every check
// ===========================================================================

describe("a label made entirely of generic words is refused", () => {
  function problemsFor(labelEn: string): string[] {
    return validateTaxonomyCorpus(
      [skill({ skill_id: "skill_probe", label_en: labelEn })],
      [edge({ skill_id: "skill_probe" })],
      { domains: DOMAINS },
    ).filter((p) => p.includes("SKILL_LABEL_OVER_GENERIC"));
  }

  it("catches a MULTI-WORD all-generic label", () => {
    // The old rule only fired on a one-word label, so this went through with an EMPTY
    // informative-token set — unmatchable, unmergeable and unflaggable by every downstream
    // detector at once.
    expect(problemsFor("Machine Work")).toHaveLength(1);
  });

  it("catches one joined by a separator the normalizer keeps intra-word", () => {
    // "machine/tools" was ONE token to the validator's old `split(" ")` and TWO to the
    // analyzer's tokenizer. The two tokenizers are now one.
    expect(problemsFor("Machine/Tools")).toHaveLength(1);
  });

  it("still catches the single generic word", () => {
    expect(problemsFor("Machine")).toHaveLength(1);
  });

  it("does NOT catch a real skill that merely contains a generic word", () => {
    expect(problemsFor("Fanuc control operation")).toEqual([]);
    expect(problemsFor("Hydraulic hose crimping")).toEqual([]);
  });
});

// ===========================================================================
// DEFERRED #2 — inflectional duplicates stay in the weak band, ON PURPOSE
// ===========================================================================

describe("an inflectional pair is surfaced as a candidate, never silently equated", () => {
  // THIS TEST PROTECTS A DEFERRAL, NOT A FIX. See packages/db/docs/taxonomy-phase-2-decisions.md.
  //
  // "Boiler Operation" / "Boiler Operations" is the most likely real duplicate shape and the
  // gate does NOT block it. That is a decision, not an oversight: the obvious fix is lowering
  // MIN_TOKENS_FOR_SET_EQUALITY from 2 to 1, and that threshold is load-bearing — with the
  // stoplist absorbing the second word, "Boiler Operation" and "Boiler Cleaning" BOTH reduce
  // to {boiler}, so size-1 set equality would confidently merge two different skills. Trading
  // a detection gap for a false-accusation class is a downgrade.
  //
  // What the deferral REQUIRES is that the pair is still visible. If a future change makes
  // these silently canonical-equivalent, or drops them from the report, this fails.
  const A = skill({
    skill_id: "skill_boiler_operation",
    label_en: "Boiler Operation",
    aliases: [{ text: "boiler op", lang: "en" }],
  });
  const B = skill({
    skill_id: "skill_boiler_operations",
    label_en: "Boiler Operations",
    aliases: [{ text: "boiler ops", lang: "en" }],
  });
  const EDGES = [edge({ skill_id: A.skill_id }), edge({ skill_id: B.skill_id })];

  it("reports BOTH ends as advisory weak-band ambiguity", () => {
    const result = gate([A, B], EDGES);
    const ambiguous = result.findings.findings.filter((f) => f.code === "POTENTIAL_AMBIGUITY");
    expect(ambiguous.map((f) => f.subject).sort()).toEqual([A.skill_id, B.skill_id].sort());
    for (const f of ambiguous) expect(f.severity).toBe("ADVISORY");
  });

  it("names the twin, so a reviewer can act on it without re-deriving the pair", () => {
    const result = gate([A, B], EDGES);
    const finding = result.findings.findings.find((f) => f.code === "POTENTIAL_AMBIGUITY");
    expect(finding?.skill_ids.sort()).toEqual([A.skill_id, B.skill_id].sort());
    expect(finding?.evidence.some((e) => e.startsWith("WITHIN_BATCH:"))).toBe(true);
  });

  it("does NOT block — the deferral is that a human rules, not that the gate guesses", () => {
    expect(gate([A, B], EDGES).verdict).toBe("PASS");
  });

  it("is NOT counted as a confident reuse decision of any kind", () => {
    const totals = gate([A, B], EDGES).findings.reuse.totals;
    expect(totals.MISSED_REUSE).toBe(0);
    expect(totals.FALSE_REUSE).toBe(0);
    expect(totals.CORRECT_NEW).toBe(0); // silently "fine" would be the bad outcome
    expect(totals.POTENTIAL_AMBIGUITY).toBe(2);
  });
});

// ===========================================================================
// FINDING 5 — --out
// ===========================================================================

describe("--out cannot be used to smuggle candidates past review", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "taxonomy-out-"));
    vi.spyOn(console, "log").mockImplementation(() => {});
    writeFileSync(
      join(dir, "manifest.json"),
      JSON.stringify(
        buildBatchManifest({
          batchId: "b",
          generatedAt: new Date("2026-08-16T00:00:00.000Z"),
          domains: [CNC_TURNING],
        }),
        null,
        2,
      ),
      "utf8",
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  function writeResponses(entries: { label: string; alias: string; domain: string }[]): void {
    const byDomain = new Map<string, { label: string; alias: string }[]>();
    for (const e of entries) {
      const bucket = byDomain.get(e.domain);
      if (bucket === undefined) byDomain.set(e.domain, [{ label: e.label, alias: e.alias }]);
      else bucket.push({ label: e.label, alias: e.alias });
    }
    const lines = [...byDomain.entries()].map(([domain, skills]) =>
      JSON.stringify({
        job_domain_id: domain,
        skills: skills.map((s) => ({
          existing_skill_id: null,
          label_en: s.label,
          label_hi: null,
          aliases: [{ text: s.alias, lang: "en" }],
          requirement: "required",
          relevance: 80,
          confidence: 0.9,
        })),
      }),
    );
    writeFileSync(join(dir, "raw-responses.jsonl"), `${lines.join("\n")}\n`, "utf8");
  }

  it("REFUSES --out pointing at the corpus directory", () => {
    // `loadTaxonomyCorpus` globs *.jsonl out of that directory, so writing candidates there
    // makes unreviewed model output part of the corpus with no commit and no reviewer.
    writeResponses([
      { label: "Hydraulic Hose Crimping", alias: "hose crimping", domain: CNC_TURNING },
    ]);
    expect(() => ingest(["--out", TAXONOMY_DATA_DIR], dir)).toThrow(/must not be the corpus/);

    // AND NOTHING WAS WRITTEN. Not a belt-and-braces assertion — this is the finding itself.
    // Running the suite with the guard disabled (a mutation) really did leave
    // `accepted-skills.jsonl` in `data/taxonomy/`, where `loadTaxonomyCorpus` globs `*.jsonl`
    // and silently absorbed it into the committed corpus. Three unrelated tests then failed
    // for reasons that pointed nowhere near the cause. If this ever regresses, it must fail
    // here, loudly and attributably, instead of poisoning every later run.
    expect(existsSync(join(TAXONOMY_DATA_DIR, "accepted-skills.jsonl"))).toBe(false);
    expect(existsSync(join(TAXONOMY_DATA_DIR, "accepted-domain-skills.jsonl"))).toBe(false);
  });

  it("deletes a stale accepted-*.jsonl from BOTH directories on a later BLOCK", () => {
    // The `--out` divergence defeated the stale-file deletion: it cleaned `outDir` while
    // yesterday's pass sat in the batch directory, beside a manifest now saying BLOCK, exactly
    // where the runbook says to look.
    const out = mkdtempSync(join(tmpdir(), "taxonomy-outdir-"));
    try {
      writeResponses([
        { label: "Hydraulic Hose Crimping", alias: "hose crimping", domain: CNC_TURNING },
      ]);
      expect(ingest([], dir).blocked).toBe(false);
      expect(existsSync(join(dir, "accepted-skills.jsonl"))).toBe(true);

      writeResponses([
        { label: "Hydraulic Hose Crimping", alias: "hose crimping", domain: CNC_TURNING },
        { label: "Crimping Hydraulic Hose", alias: "hydraulic crimping", domain: CNC_PROGRAMMER },
      ]);
      expect(ingest(["--out", out], dir).blocked).toBe(true);
      expect(existsSync(join(dir, "accepted-skills.jsonl"))).toBe(false);
      expect(existsSync(join(out, "accepted-skills.jsonl"))).toBe(false);
      expect(existsSync(join(out, "blocked-skills.jsonl"))).toBe(true);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
});

// ===========================================================================
// The seeder's SQL — pinned at the source, because there is no database here
// ===========================================================================

describe("seeder write-path guards", () => {
  const source = readFileSync(join(__dirname, "seed-domain-skills.ts"), "utf8");

  it("never flips an INHERITED edge's source, which would violate the 0076 CHECK", () => {
    // `job_domain_skill_inherited_source_ck` requires
    // `inherited_from_job_domain_id IS NULL OR source = 'inherited'`. The upsert rewrites
    // `source` and never touches the parent link, so an inherited row flipped back to
    // llm_bootstrap violates the CHECK and aborts the apply part-way through.
    expect(source).toContain(`"source" NOT IN ('curated', 'inherited')`);
  });

  it("never DELETES a curated label_hi that the corpus does not carry", () => {
    expect(source).toContain(`COALESCE(excluded.label_hi, "skill"."label_hi")`);
    expect(source).toContain(`excluded."label_hi" IS NOT NULL`);
  });

  it("writes all three tables inside ONE transaction", () => {
    // Three loose loops leave a half-seeded taxonomy on any mid-run failure.
    expect(source).toContain("await db.transaction(async (tx) => {");
    // …and nothing writes outside it.
    expect(source).not.toMatch(/await db\s*\n?\s*\.insert\(/);
  });

  it("builds `claimed` ONLY through buildClaimedSet", () => {
    // The oscillation bug never lived inside `buildClaimedSet` — it lived in what `main()`
    // fed it, and `main()` is not reachable from any unit test. Reverting this one call site
    // reintroduces the exact defect with every test still green.
    expect(source).toContain("buildClaimedSet(claimedRows, planAliasRows(corpus.skills))");
    // The reintroduction shape, named exactly: the runner building the set out of the rows it
    // just read, without subtracting its own planned ids.
    expect(source.replace(/\s+/g, " ")).not.toContain("claimedRows .map");
    expect(source).not.toContain("claimedRows.map");
  });
});

describe("every row-moving writer carries the columns migration 0076 added", () => {
  it("retag-skills.ts preserves text_norm, embedding_model and embedded_at", () => {
    // `retag-skills.ts` replaces an alias row (insert-then-delete), so a column omitted from
    // the insert is silently dropped. 0076 added four and did not audit this writer: a retag
    // NULLed `text_norm` (dropping the alias out of the L0 and L2 indexes with no error) and
    // orphaned a paid embedding from its provenance.
    const source = readFileSync(join(__dirname, "retag-skills.ts"), "utf8");
    for (const column of [
      "textNorm: a.textNorm",
      "embeddingModel: a.embeddingModel",
      "embeddedAt: a.embeddedAt",
    ]) {
      expect(source, `retag must carry ${column}`).toContain(column);
    }
    // is_searchable is the ONE deliberate exception — a move changes the election group and
    // claiming an occupied one would violate the partial unique index and abort the retag.
    expect(source).toContain("isSearchable: false");
  });
});
