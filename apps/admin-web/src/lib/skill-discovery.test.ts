import { describe, it, expect, beforeEach, vi } from "vitest";
import type { ZodType } from "zod";

/**
 * The skill-discovery data layer (#1260).
 *
 * `adminFetch` is replaced with a double that records the path and parses the response BODY
 * through the schema it was handed — the real transport's contract — the same discipline
 * `lib/feedback.test.ts` uses. What matters here: which request is actually built for a given
 * filter set, and what the response schemas accept and refuse.
 */

const transport = vi.hoisted(() => ({
  calls: [] as string[],
  body: { items: [], nextCursor: null } as unknown,
}));

vi.mock("./admin-http", () => ({
  adminFetch: async (path: string, opts: { schema: ZodType<unknown> }) => {
    transport.calls.push(path);
    return opts.schema.parse(transport.body);
  },
}));

const {
  getSkillDiscoveryCandidate,
  getSkillDiscoveryMetrics,
  listSkillDiscovery,
  skillDiscoveryDetailSchema,
  skillDiscoveryListItemSchema,
  skillDiscoveryMetricsSchema,
  skillDiscoveryPageSchema,
  skillDiscoveryQs,
} = await import("./skill-discovery");

const LIST_ROW = {
  id: "c0000000-0001-4a00-8000-000000000001",
  run_id: "sdr_20260826T000000Z_a1b2c3",
  cluster_key: "sanitary-fixture-installation",
  normalized_phrase: "sanitary fixture installation",
  proposed_skill_name: "Sanitary Fixture Installation",
  phrase_class: "OCCUPATION_WITH_SKILL_EVIDENCE",
  trade_family: "Plumbers and Pipe Fitters",
  source_alias_count: 4,
  source_domain_count: 12,
  proposed_action: "create",
  confidence_band: "high",
  status: "pending",
  review_tier: "direct",
  has_strong_match: false,
  related_skill_count: 3,
  reviewer_admin_id: null,
  reviewed_at: null,
  resulting_skill_id: null,
  created_at: "2026-08-26T09:00:00.000Z",
  updated_at: "2026-08-26T09:00:00.000Z",
};

const DETAIL_ROW = {
  ...LIST_ROW,
  phrase_class_label: "A job title with a modifier that names actual work.",
  proposed_description: "Operation and fitting of sanitary fixtures.",
  rationale: "An occupation title whose modifier names the work.",
  sources: [
    {
      source_type: "job_domain_alias",
      source_id: "jda-1",
      original_text: "sanitary fitting",
      normalized_text: "sanitary fitting",
      job_domain_id: "jd_nco_7126_0100",
    },
  ],
  source_type_counts: [
    { key: "job_domain_alias", count: 1 },
    { key: "job_domain_label", count: 0 },
    { key: "unresolved_phrase", count: 0 },
    { key: "worker_phrase", count: 0 },
    { key: "job_text", count: 0 },
    { key: "skill_alias", count: 0 },
  ],
  related_skills: [
    {
      skill_id: "skill_plumbing",
      skill_label: "Plumbing",
      relation: "surface_form_shared",
      relation_label: "This phrase is already listed as another name for this skill.",
      strength: "strong",
      strength_label: "Looks like the same thing.",
      evidence: "This phrase is already listed as another name for this skill.",
      rank: 1,
    },
    {
      skill_id: "skill_drain_laying",
      skill_label: "Drain Laying",
      relation: "high_token_overlap",
      relation_label: "Shares most of its meaningful words with this skill.",
      strength: "weak",
      strength_label: "Possibly related — worth a look, not a match.",
      evidence: "Shares most of its meaningful words with this skill.",
      rank: 2,
    },
  ],
  suggested_aliases: ["sanitary fitting", "sanitary installer"],
  review_reason: null,
  provenance: {
    run_id: LIST_ROW.run_id,
    cluster_key: LIST_ROW.cluster_key,
    classifier_rule: "occupation_with_modifier",
    phrase_class: "OCCUPATION_WITH_SKILL_EVIDENCE",
    occupation_heads: ["fitter"],
    evidence_tokens: ["sanitary", "fixture"],
    embedding_status: "not_required",
    model: null,
    prompt_version: null,
    corpus_fingerprint: "cf_abc123",
    provenance_digest: "d41d8cd98f00b204e9800998ecf8427e",
  },
};

const METRICS_BODY = {
  run_id: null,
  total: 6673,
  awaiting_decision: 599,
  deferred: 0,
  by_status: [
    { key: "pending", count: 550 },
    { key: "needs_review", count: 49 },
    { key: "approved_create", count: 0 },
    { key: "approved_map", count: 0 },
    { key: "approved_merge", count: 0 },
    { key: "rejected", count: 0 },
    { key: "deferred", count: 0 },
  ],
  by_band: [
    { key: "high", count: 82 },
    { key: "medium", count: 517 },
    { key: "low", count: 6074 },
  ],
  by_proposed_action: [
    { key: "map", count: 100 },
    { key: "create", count: 200 },
    { key: "merge", count: 50 },
    { key: "reject", count: 20 },
    { key: "review", count: 6303 },
  ],
  by_tier: [
    { key: "direct", count: 82 },
    { key: "derived", count: 6074 },
    { key: "ambiguous", count: 517 },
  ],
  oldest_awaiting_created_at: "2026-08-01T00:00:00.000Z",
  tier_basis: "review_tier_is_derived_not_stored",
};

beforeEach(() => {
  transport.calls.length = 0;
  transport.body = { items: [], nextCursor: null };
});

const lastPath = () => transport.calls.at(-1)!;

describe("skillDiscoveryQs — the query builder this module owns (repeated-key support)", () => {
  it("repeats `status=` once per value rather than joining them", () => {
    expect(skillDiscoveryQs({ status: ["pending", "needs_review"] })).toBe(
      "?status=pending&status=needs_review",
    );
  });

  it("omits undefined, null-shaped and empty-string values", () => {
    expect(skillDiscoveryQs({ tier: "", tradeFamily: undefined, runId: "r-1" })).toBe(
      "?runId=r-1",
    );
  });

  it("skips empty entries inside a status array without emitting a bare `status=`", () => {
    expect(skillDiscoveryQs({ status: ["pending", ""] })).toBe("?status=pending");
  });

  it("returns the empty string, not `?`, when nothing is set", () => {
    expect(skillDiscoveryQs({})).toBe("");
  });
});

describe("listSkillDiscovery — the request it actually makes", () => {
  it("asks for the bare route when nothing is filtered", async () => {
    await listSkillDiscovery();
    expect(lastPath()).toBe("/admin/skill-discovery");
  });

  it("carries the multi-valued status filter, the tier, and the cursor", async () => {
    await listSkillDiscovery({
      status: ["pending", "needs_review"],
      tier: "direct",
      cursor: "Y3Vyc29y",
      limit: 50,
    });
    expect(lastPath()).toBe(
      "/admin/skill-discovery?status=pending&status=needs_review&tier=direct&cursor=Y3Vyc29y&limit=50",
    );
  });

  it("FORWARDS an unrecognised tier rather than silently dropping it", async () => {
    // The server's schema is `.strict()`, so a hand-edited `?tier=nope` earns an honest 400
    // this page renders as a refusal — dropping it would show the whole queue under a URL
    // that claims a filter.
    await listSkillDiscovery({ tier: "nope" });
    expect(lastPath()).toBe("/admin/skill-discovery?tier=nope");
  });

  it("carries the anchored phrase search", async () => {
    await listSkillDiscovery({ phrase: "arc weld" });
    expect(lastPath()).toBe("/admin/skill-discovery?phrase=arc+weld");
  });

  it("returns the parsed page", async () => {
    transport.body = { items: [LIST_ROW], nextCursor: "bmV4dA" };
    const page = await listSkillDiscovery();
    expect(page.items).toHaveLength(1);
    expect(page.items[0]!.review_tier).toBe("direct");
    expect(page.nextCursor).toBe("bmV4dA");
  });

  it("a body the schema rejects becomes a thrown error, never a half-rendered page", async () => {
    transport.body = { items: [{ ...LIST_ROW, status: "not_a_real_status" }], nextCursor: null };
    await expect(listSkillDiscovery()).rejects.toThrow();
  });
});

describe("the list item schema", () => {
  it("parses the server's projection", () => {
    expect(skillDiscoveryListItemSchema.parse(LIST_ROW).id).toBe(LIST_ROW.id);
  });

  it("rejects an unrecognised status — CHECK-backed, so the union is honest", () => {
    expect(
      skillDiscoveryListItemSchema.safeParse({ ...LIST_ROW, status: "cancelled" }).success,
    ).toBe(false);
  });

  it("accepts a null trade_family and a null proposed_skill_name", () => {
    const row = skillDiscoveryListItemSchema.parse({
      ...LIST_ROW,
      trade_family: null,
      proposed_skill_name: null,
    });
    expect(row.trade_family).toBeNull();
    expect(row.proposed_skill_name).toBeNull();
  });

  it("NEVER carries a `score` or `confidence` numeric field — CHECK-backed columns only", () => {
    // The regression this guards: a repository that spread `skill_candidate_match` onto the
    // wire type would put a bare 0..1 similarity number on this screen. The schema has no key
    // for one, so a server response carrying it is silently dropped by `.parse`, not surfaced.
    const parsed = skillDiscoveryListItemSchema.parse({ ...LIST_ROW, score: 0.87 });
    expect(parsed).not.toHaveProperty("score");
  });
});

describe("the page envelope", () => {
  it("is `{ items, nextCursor }`", () => {
    expect(skillDiscoveryPageSchema.parse({ items: [LIST_ROW], nextCursor: null }).items).toHaveLength(
      1,
    );
  });

  it("requires nextCursor as a present key, not merely a truthy one", () => {
    expect(skillDiscoveryPageSchema.safeParse({ items: [] }).success).toBe(false);
  });
});

describe("getSkillDiscoveryCandidate — one request, no N+1", () => {
  it("hits the id route", async () => {
    transport.body = DETAIL_ROW;
    await getSkillDiscoveryCandidate("c0000000-0001-4a00-8000-000000000001");
    expect(lastPath()).toBe("/admin/skill-discovery/c0000000-0001-4a00-8000-000000000001");
  });

  it("encodes the id", async () => {
    transport.body = DETAIL_ROW;
    await getSkillDiscoveryCandidate("has space");
    expect(lastPath()).toBe("/admin/skill-discovery/has%20space");
  });

  it("parses ALL competing matches, not just the first", async () => {
    transport.body = DETAIL_ROW;
    const detail = await getSkillDiscoveryCandidate("x");
    expect(detail.related_skills).toHaveLength(2);
    expect(detail.related_skills.map((m) => m.strength)).toEqual(["strong", "weak"]);
  });

  it("NEVER carries a score, a vector, or a model name on a related skill", () => {
    const parsed = skillDiscoveryDetailSchema.parse({
      ...DETAIL_ROW,
      related_skills: [{ ...DETAIL_ROW.related_skills[0], score: 0.93, embedding_model: "x" }],
    });
    expect(parsed.related_skills[0]).not.toHaveProperty("score");
    expect(parsed.related_skills[0]).not.toHaveProperty("embedding_model");
  });

  it("carries the frozen provenance block as a nested, read-only record", () => {
    const detail = skillDiscoveryDetailSchema.parse(DETAIL_ROW);
    expect(detail.provenance.provenance_digest).toBe(DETAIL_ROW.provenance.provenance_digest);
    expect(detail.provenance.corpus_fingerprint).toBe(DETAIL_ROW.provenance.corpus_fingerprint);
  });

  it("rejects a detail body missing the provenance block", () => {
    const { provenance: _drop, ...rest } = DETAIL_ROW;
    expect(skillDiscoveryDetailSchema.safeParse(rest).success).toBe(false);
  });
});

describe("getSkillDiscoveryMetrics — one request, no client-side aggregation", () => {
  it("hits the bare metrics route with no run scope", async () => {
    transport.body = METRICS_BODY;
    await getSkillDiscoveryMetrics();
    expect(lastPath()).toBe("/admin/skill-discovery/metrics");
  });

  it("scopes to one run", async () => {
    transport.body = METRICS_BODY;
    await getSkillDiscoveryMetrics("sdr_20260826T000000Z_a1b2c3");
    expect(lastPath()).toBe(
      "/admin/skill-discovery/metrics?runId=sdr_20260826T000000Z_a1b2c3",
    );
  });

  it("parses every densified breakdown, zeros included", () => {
    const metrics = skillDiscoveryMetricsSchema.parse(METRICS_BODY);
    expect(metrics.by_status).toHaveLength(7);
    expect(metrics.by_status.find((b) => b.key === "approved_create")?.count).toBe(0);
    expect(metrics.by_tier).toHaveLength(3);
  });

  it("requires the tier_basis marker — a dashboard must not treat by_tier as stored", () => {
    const { tier_basis: _drop, ...rest } = METRICS_BODY;
    expect(skillDiscoveryMetricsSchema.safeParse(rest).success).toBe(false);
  });

  it("sums total from by_status server-side — this schema does not recompute it", () => {
    // The portal renders `total` verbatim; asserting it here pins that no client-side sum is
    // silently substituted for the server's own figure.
    const metrics = skillDiscoveryMetricsSchema.parse(METRICS_BODY);
    expect(metrics.total).toBe(METRICS_BODY.total);
  });
});
