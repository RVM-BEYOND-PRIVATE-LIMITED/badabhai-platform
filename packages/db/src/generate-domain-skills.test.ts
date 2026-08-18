/**
 * The Domain -> Skill generator, tested WITHOUT A PROVIDER AND WITHOUT A DATABASE.
 *
 * That is the point of how it is built: the model call is out-of-band (emit prompts,
 * ingest replies), so every decision the script makes is a pure function over text. The
 * committed corpus is empty today, so this logic has to be provably correct BEFORE it ever
 * sees real output — a test that needed a real batch would be a test that never ran.
 *
 * Three properties matter more than the rest and each has its own block below:
 *   1. THE PROMPT IS DETERMINISTIC. Otherwise `prompt_template_sha256` means nothing and a
 *      re-emit cannot be diffed against the last one.
 *   2. A MALFORMED LINE IS REPORTED. A batch of 200 that quietly ingests 173 looks like a
 *      success; the 27 missing trades surface months later as empty pickers.
 *   3. AN INVENTED skill_id IS REFUSED. Ids are immutable and never reused (SG-5), so a
 *      fabricated one is a permanent false claim about the vocabulary, not a typo.
 */
import { describe, expect, it } from "vitest";

import {
  PROMPT_TEMPLATE,
  PROMPT_TEMPLATE_SHA256,
  PROMPT_TEMPLATE_VERSION,
  RESPONSE_SCHEMA,
  buildBatchManifest,
  buildSkillPrompt,
  parseSkillResponses,
  selectPromptInputs,
  toCorpusRecords,
  toEdgeCorpusLines,
  toSkillCorpusLines,
  withIngestResults,
  type SkillResponse,
} from "./generate-domain-skills";
import {
  shippedSkillIds,
  validateTaxonomyCorpus,
  type SkillCatalogueEntry,
  type TaxonomyCorpus,
  type TaxonomyDomainRecord,
} from "./taxonomy-corpus";

const DOMAIN: TaxonomyDomainRecord = {
  job_domain_id: "jd_nco_7223_6002",
  label_en: "CNC Operator-Turning",
  trade_group: "cnc_machining",
};

const CATALOGUE: SkillCatalogueEntry[] = [
  { skill_id: "skill_fanuc_cnc", label_en: "Fanuc CNC" },
  { skill_id: "skill_vernier_caliper", label_en: "Vernier Caliper" },
];

function response(overrides: Partial<SkillResponse> = {}): SkillResponse {
  return {
    job_domain_id: DOMAIN.job_domain_id,
    skills: [
      {
        existing_skill_id: null,
        label_en: "Turret Indexing",
        label_hi: null,
        aliases: [{ text: "turret index", lang: "en" }],
        requirement: "required",
        relevance: 85,
        confidence: 0.9,
      },
    ],
    ...overrides,
  };
}

describe("buildSkillPrompt — deterministic, and it says every rule the validator enforces", () => {
  it("is byte-identical for the same domain and catalogue", () => {
    expect(buildSkillPrompt(DOMAIN, CATALOGUE)).toBe(buildSkillPrompt(DOMAIN, CATALOGUE));
  });

  it("changes when the domain changes", () => {
    const other = buildSkillPrompt({ ...DOMAIN, label_en: "Gas Welder" }, CATALOGUE);
    expect(other).not.toBe(buildSkillPrompt(DOMAIN, CATALOGUE));
  });

  it("carries the trade, the trade group and the id to echo", () => {
    const prompt = buildSkillPrompt(DOMAIN, CATALOGUE);
    expect(prompt).toContain("CNC Operator-Turning");
    expect(prompt).toContain("cnc_machining");
    expect(prompt).toContain(DOMAIN.job_domain_id);
  });

  it("carries the catalogue the model may echo from", () => {
    const prompt = buildSkillPrompt(DOMAIN, CATALOGUE);
    for (const entry of CATALOGUE) expect(prompt).toContain(entry.skill_id);
  });

  it("says so explicitly when there is nothing to reuse yet", () => {
    expect(buildSkillPrompt(DOMAIN, [])).toContain("none yet");
  });

  it.each([
    ["a count range", "6-14"],
    ["skill, not job title", "not a job title"],
    ["reuse first", "REUSE an existing skill"],
    ["never invent an id", "NEVER invent a skill_id"],
    ["required vs preferred", "preferred"],
    ["relevance range", "relevance: integer 0-100"],
    ["confidence range", "confidence: number 0-1"],
    ["the PII guard", 'No digits, no "@", no URLs'],
    ["the alias cap", "60 characters per alias"],
    ["strict JSON", "STRICT JSON"],
  ])("instructs the model about %s", (_why, needle) => {
    expect(buildSkillPrompt(DOMAIN, CATALOGUE)).toContain(needle);
  });

  it("hashes only the INVARIANT half, so two domains share one template sha", () => {
    expect(PROMPT_TEMPLATE_SHA256).toMatch(/^[0-9a-f]{64}$/);
    // The per-domain header and the catalogue are outside the hash by construction: the
    // template string itself contains neither.
    expect(PROMPT_TEMPLATE).not.toContain(DOMAIN.job_domain_id);
    expect(PROMPT_TEMPLATE).not.toContain("skill_fanuc_cnc");
  });
});

describe("selectPromptInputs", () => {
  const corpus: TaxonomyCorpus = {
    domains: [
      DOMAIN,
      { job_domain_id: "jd_nco_7212_0300", label_en: "Gas Welder", trade_group: "welding" },
    ],
    skills: [
      {
        kind: "skill",
        skill_id: "skill_oxy_fuel_cutting",
        label_en: "Oxy-Fuel Cutting",
        label_hi: null,
        aliases: [{ text: "oxy fuel cutting", lang: "en" }],
      },
    ],
    edges: [
      {
        kind: "domain_skill",
        job_domain_id: "jd_nco_7212_0300",
        skill_id: "skill_oxy_fuel_cutting",
        default_requirement: "required",
        relevance: 90,
        confidence: 0.9,
        source: "llm_bootstrap",
      },
    ],
  };

  it("skips domains that already have edges by default", () => {
    const ids = selectPromptInputs(corpus, { missingOnly: true }).map((p) => p.job_domain_id);
    expect(ids).toEqual([DOMAIN.job_domain_id]);
  });

  it("--all re-drafts covered domains too", () => {
    expect(selectPromptInputs(corpus, { missingOnly: false })).toHaveLength(2);
  });

  it("filters by trade group and honours a limit", () => {
    expect(selectPromptInputs(corpus, { missingOnly: false, tradeGroup: "welding" })).toHaveLength(1);
    expect(selectPromptInputs(corpus, { missingOnly: false, limit: 1 })).toHaveLength(1);
  });

  it("scopes the reuse catalogue to the trade group, plus the shipped vocabulary", () => {
    const welding = selectPromptInputs(corpus, { missingOnly: false, tradeGroup: "welding" })[0];
    const cnc = selectPromptInputs(corpus, { missingOnly: false, tradeGroup: "cnc_machining" })[0];
    // The welding batch sees the welding skill an earlier batch authored; the CNC batch
    // does not, because a long list of irrelevant candidates makes reuse LESS likely.
    expect(welding?.catalogue_ids).toContain("skill_oxy_fuel_cutting");
    expect(cnc?.catalogue_ids).not.toContain("skill_oxy_fuel_cutting");
    for (const p of [welding, cnc]) {
      expect(p?.catalogue_ids.length).toBeGreaterThan(0);
      expect(shippedSkillIds().has(p?.catalogue_ids[0] as string)).toBe(true);
    }
  });
});

describe("parseSkillResponses — malformed lines are REPORTED, never silently skipped", () => {
  it("accepts well-formed JSONL and ignores blanks and comments", () => {
    const raw = ["# batch 1", "", JSON.stringify(response()), ""].join("\n");
    const { responses, problems } = parseSkillResponses(raw);
    expect(responses).toHaveLength(1);
    expect(problems).toEqual([]);
  });

  it("reports a line that is not JSON, with its 1-based line number", () => {
    const raw = [JSON.stringify(response()), "{not json"].join("\n");
    const { responses, problems } = parseSkillResponses(raw);
    expect(responses).toHaveLength(1);
    expect(problems).toEqual(["response line 2: not valid JSON"]);
  });

  it("reports a line with no job_domain_id", () => {
    const { problems } = parseSkillResponses(JSON.stringify({ skills: [] }));
    expect(problems[0]).toContain("missing job_domain_id");
  });

  it("reports a line with no skills array, naming the domain", () => {
    const { problems } = parseSkillResponses(JSON.stringify({ job_domain_id: "jd_x" }));
    expect(problems[0]).toContain("jd_x");
    expect(problems[0]).toContain("no skills array");
  });
});

describe("toCorpusRecords — the model never supplies a database id", () => {
  it("mints a new skill id from the label, deterministically", () => {
    const { skills, edges, problems } = toCorpusRecords([response()], CATALOGUE);
    expect(problems).toEqual([]);
    expect(skills.map((s) => s.skill_id)).toEqual(["skill_turret_indexing"]);
    expect(edges).toHaveLength(1);
    expect(edges[0]?.skill_id).toBe("skill_turret_indexing");
  });

  it("REJECTS an existing_skill_id the model invented", () => {
    const bad = response({
      skills: [
        {
          existing_skill_id: "skill_totally_made_up",
          label_en: "Made Up",
          aliases: [{ text: "made up", lang: "en" }],
          requirement: "preferred",
          relevance: 40,
          confidence: 0.4,
        },
      ],
    });
    const { skills, edges, problems } = toCorpusRecords([bad], CATALOGUE);
    expect(skills).toEqual([]);
    expect(edges).toEqual([]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("INVENTED_SKILL_ID");
    expect(problems[0]).toContain("skill_totally_made_up");
  });

  it("accepts an echoed id that IS in the catalogue, and emits no skill record for it", () => {
    const reuse = response({
      skills: [
        {
          existing_skill_id: "skill_fanuc_cnc",
          label_en: "Fanuc CNC",
          aliases: [{ text: "fanuc", lang: "en" }],
          requirement: "required",
          relevance: 95,
          confidence: 0.95,
        },
      ],
    });
    const { skills, edges, problems } = toCorpusRecords([reuse], CATALOGUE);
    expect(problems).toEqual([]);
    // No skill record: re-declaring an id that already exists is exactly the collision the
    // corpus validator refuses. Only the edge is new.
    expect(skills).toEqual([]);
    expect(edges.map((e) => e.skill_id)).toEqual(["skill_fanuc_cnc"]);
  });

  it("merges one new skill proposed by two domains instead of emitting a duplicate id", () => {
    const a = response();
    const b = response({
      job_domain_id: "jd_nco_7223_6003",
      skills: [
        {
          existing_skill_id: null,
          label_en: "Turret Indexing",
          aliases: [{ text: "indexing wheel", lang: "en" }],
          requirement: "preferred",
          relevance: 70,
          confidence: 0.7,
        },
      ],
    });
    const { skills, edges } = toCorpusRecords([a, b], CATALOGUE);
    expect(skills).toHaveLength(1);
    expect(skills[0]?.aliases.map((x) => x.text)).toEqual(["turret index", "indexing wheel"]);
    expect(edges).toHaveLength(2);
  });

  it("hard-codes source=llm_bootstrap — the model cannot claim a human signed the edge", () => {
    const claiming = response({
      skills: [
        {
          existing_skill_id: null,
          label_en: "Turret Indexing",
          aliases: [{ text: "turret index", lang: "en" }],
          requirement: "required",
          relevance: 85,
          confidence: 0.9,
          // A model that could claim `curated` could overwrite ops' hand-authored rows,
          // because curated always wins a materialization conflict.
          ...({ source: "curated" } as Record<string, unknown>),
        },
      ],
    });
    const { edges } = toCorpusRecords([claiming], CATALOGUE);
    expect(edges[0]?.source).toBe("llm_bootstrap");
  });

  it("passes an unrecognised alias lang THROUGH so the validator can name it", () => {
    const weird = response({
      skills: [
        {
          existing_skill_id: null,
          label_en: "Turret Indexing",
          aliases: [{ text: "turret index", lang: "mr" as never }],
          requirement: "required",
          relevance: 85,
          confidence: 0.9,
        },
      ],
    });
    const { skills } = toCorpusRecords([weird], CATALOGUE);
    expect(skills[0]?.aliases[0]?.lang).toBe("mr");
  });

  it("produces records the corpus validator accepts end to end", () => {
    const { skills, edges } = toCorpusRecords([response()], CATALOGUE);
    expect(validateTaxonomyCorpus(skills, edges, { domains: [DOMAIN] })).toEqual([]);
  });
});

describe("corpus line serialization", () => {
  it("emits the pinned skills.jsonl and domain-skills.jsonl shapes", () => {
    const { skills, edges } = toCorpusRecords([response()], CATALOGUE);
    expect(JSON.parse(toSkillCorpusLines(skills))).toEqual({
      kind: "skill",
      skill_id: "skill_turret_indexing",
      label_en: "Turret Indexing",
      label_hi: null,
      aliases: [{ text: "turret index", lang: "en" }],
    });
    expect(JSON.parse(toEdgeCorpusLines(edges))).toEqual({
      kind: "domain_skill",
      job_domain_id: DOMAIN.job_domain_id,
      skill_id: "skill_turret_indexing",
      default_requirement: "required",
      relevance: 85,
      confidence: 0.9,
      source: "llm_bootstrap",
    });
  });
});

describe("the audit manifest", () => {
  const generatedAt = new Date("2026-08-16T09:30:00.000Z");
  const manifest = buildBatchManifest({
    batchId: "batch_2026-08-16T09-30-00Z",
    generatedAt,
    domains: [DOMAIN.job_domain_id],
  });

  it("carries every required emit-time field", () => {
    expect(manifest).toMatchObject({
      batch_id: "batch_2026-08-16T09-30-00Z",
      generated_at: "2026-08-16T09:30:00.000Z",
      generation_mode: "external_session_batch",
      model: null,
      provider: null,
      prompt_template_version: PROMPT_TEMPLATE_VERSION,
      prompt_template_sha256: PROMPT_TEMPLATE_SHA256,
      instruction_schema: RESPONSE_SCHEMA,
      domain_count: 1,
      domains: [DOMAIN.job_domain_id],
    });
  });

  it("declares the ingest-time fields as null rather than omitting them", () => {
    // An absent key is indistinguishable from a key someone forgot to write.
    for (const key of [
      "ingested_at",
      "raw_record_count",
      "accepted_count",
      "rejected_count",
      "rejections_by_reason",
    ] as const) {
      expect(Object.hasOwn(manifest, key)).toBe(true);
      expect(manifest[key]).toBeNull();
    }
  });

  it("carries NO token count and NO cost, before or after ingest", () => {
    const after = withIngestResults(manifest, {
      ingestedAt: new Date("2026-08-16T10:00:00.000Z"),
      rawRecordCount: 3,
      acceptedCount: 2,
      rejections: [{ locator: "skill[skill_x]", reason: "SKILL_ORPHAN", message: "…" }],
    });
    // Those numbers are genuinely unknown for a batch run outside this process, and a
    // plausible invented number in an audit record is worse than an absent one: it looks
    // like evidence.
    for (const blob of [JSON.stringify(manifest), JSON.stringify(after)]) {
      expect(blob).not.toMatch(/token|cost|price|spend|rupee|\binr\b|\busd\b/i);
    }
  });

  it("folds ingest counts in and summarises rejections by stable reason code", () => {
    const after = withIngestResults(manifest, {
      ingestedAt: new Date("2026-08-16T10:00:00.000Z"),
      rawRecordCount: 3,
      acceptedCount: 2,
      model: "some-model",
      provider: "some-provider",
      rejections: [
        { locator: "skill[a]", reason: "SKILL_ORPHAN", message: "…" },
        { locator: "skill[b]", reason: "SKILL_ORPHAN", message: "…" },
        { locator: null, reason: "PARSE", message: "…" },
      ],
    });
    expect(after).toMatchObject({
      ingested_at: "2026-08-16T10:00:00.000Z",
      raw_record_count: 3,
      accepted_count: 2,
      rejected_count: 3,
      rejections_by_reason: { SKILL_ORPHAN: 2, PARSE: 1 },
      model: "some-model",
      provider: "some-provider",
    });
  });

  it("never rewrites what was ASKED when a batch is re-ingested", () => {
    const after = withIngestResults(manifest, {
      ingestedAt: new Date("2026-08-16T10:00:00.000Z"),
      rawRecordCount: 0,
      acceptedCount: 0,
      rejections: [],
    });
    expect(after.batch_id).toBe(manifest.batch_id);
    expect(after.generated_at).toBe(manifest.generated_at);
    expect(after.prompt_template_sha256).toBe(manifest.prompt_template_sha256);
    expect(after.instruction_schema).toEqual(manifest.instruction_schema);
    expect(after.domains).toEqual(manifest.domains);
  });

  it("keeps a model/provider already recorded when a later ingest omits them", () => {
    const stated = buildBatchManifest({
      batchId: "b",
      generatedAt,
      domains: [],
      model: "m",
      provider: "p",
    });
    const after = withIngestResults(stated, {
      ingestedAt: generatedAt,
      rawRecordCount: 0,
      acceptedCount: 0,
      rejections: [],
    });
    expect(after.model).toBe("m");
    expect(after.provider).toBe("p");
  });
});
