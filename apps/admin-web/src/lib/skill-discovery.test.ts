import { describe, it, expect, beforeEach, vi } from "vitest";
import type { ZodType } from "zod";
import {
  SKILL_AUDIT_CAP_NOTE,
  SKILL_AUDIT_MAX_ENTRIES,
} from "./skill-discovery-vocabulary";

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
  adminCanonicalSkillSearchSchema,
  getSkillCandidateAudit,
  getSkillDiscoveryCandidate,
  getSkillDiscoveryMetrics,
  listSkillDiscovery,
  listSkillDiscoveryGroups,
  searchCanonicalSkills,
  skillCandidateAuditSchema,
  skillDiscoveryDetailSchema,
  skillDiscoveryGroupsSchema,
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
  // The reviewer's own trade judgement. Empty on an undecided row, which is the fixture's state —
  // and REQUIRED on the wire, so a response that stopped carrying it is a contract break rather
  // than a field this console quietly treats as optional.
  approved_job_domain_ids: [] as string[],
  approved_requirement: "preferred",
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
    expect(skillDiscoveryQs({ tier: "", tradeFamily: undefined, runId: "r-1" })).toBe("?runId=r-1");
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

  /*
   * ── THE TWO FIELDS THAT ACTUALLY LEAKED (#1280, correction 1) ────────────────────────
   * The detail read served `confidence` — the raw `real` 0..1 score, CHECKed in migration 0093 —
   * and `created_at_iso`, neither of them in any DTO. A service spread of a row type that is a
   * SUBTYPE of the wire row put them there, and TypeScript does not excess-property-check a
   * spread, so it compiled and shipped. Both are removed at the source now.
   *
   * These assertions are the console's end of that: the mirror declares no key for either, so a
   * server that regressed would have them STRIPPED at the parse rather than carried to a screen
   * where a reviewer could learn that 0.87 is good enough. A band is the wire representation and
   * the only one there has ever been — a band cannot be turned into an approval floor.
   */
  it("strips a leaked raw `confidence` score rather than carrying it to a screen", () => {
    const parsed = skillDiscoveryDetailSchema.parse({ ...DETAIL_ROW, confidence: 0.87 });
    expect(parsed).not.toHaveProperty("confidence");
    // The BAND still parses — it is the contracted representation, not a casualty of the fix.
    expect(parsed.confidence_band).toBe(DETAIL_ROW.confidence_band);
  });

  it("strips a leaked `created_at_iso` — `created_at` is the contracted field and survives", () => {
    const parsed = skillDiscoveryDetailSchema.parse({
      ...DETAIL_ROW,
      created_at_iso: "2026-08-26T09:00:00.000Z",
    });
    expect(parsed).not.toHaveProperty("created_at_iso");
    expect(parsed.created_at).toBe(DETAIL_ROW.created_at);
  });

  it("keeps the provenance fields NESTED — never read from the top level", () => {
    // The same spread also flattened `classifier_rule` / `model` / `corpus_fingerprint` /
    // `provenance_digest` onto the response. The contract nests them, this mirror nests them, and
    // a top-level copy is dropped — so no render can start depending on the flattened shape.
    const parsed = skillDiscoveryDetailSchema.parse({
      ...DETAIL_ROW,
      classifier_rule: "top_level_copy",
      model: "top_level_copy",
      corpus_fingerprint: "top_level_copy",
      provenance_digest: "top_level_copy",
    });
    expect(parsed).not.toHaveProperty("classifier_rule");
    expect(parsed).not.toHaveProperty("model");
    expect(parsed.provenance.classifier_rule).toBe(DETAIL_ROW.provenance.classifier_rule);
    expect(parsed.provenance.provenance_digest).toBe(DETAIL_ROW.provenance.provenance_digest);
  });
});

describe("the page envelope", () => {
  it("is `{ items, nextCursor }`", () => {
    expect(
      skillDiscoveryPageSchema.parse({ items: [LIST_ROW], nextCursor: null }).items,
    ).toHaveLength(1);
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
    expect(lastPath()).toBe("/admin/skill-discovery/metrics?runId=sdr_20260826T000000Z_a1b2c3");
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

// ═══════════════════════════════════════════════════════════════════════════════════════════
// The three routes this console gained when the backend closed its contract gaps
// ═══════════════════════════════════════════════════════════════════════════════════════════

describe("GET /admin/skill-discovery/groups — the server does the grouping", () => {
  const GROUP = {
    key: "direct|Plumbers and Pipe Fitters|sanitary",
    tier: "direct",
    trade_family: "Plumbers and Pipe Fitters",
    anchor: "sanitary",
    label: "sanitary — Plumbers and Pipe Fitters",
    candidate_ids: ["c-1", "c-2"],
    candidates: 2,
    undecided: 2,
    source_rows: 7,
    source_domains: 3,
    unanimous_action: "create",
  };
  const RESPONSE = {
    groups: [GROUP],
    total_groups: 1,
    total_candidates: 2,
    total_undecided: 2,
    tier_basis: "review_tier_is_derived_not_stored",
    grouping_basis: "groups_are_derived_not_stored",
  };

  it("parses a batch with every field the card renders", () => {
    const parsed = skillDiscoveryGroupsSchema.parse(RESPONSE);
    expect(parsed.groups[0]!.anchor).toBe("sanitary");
    expect(parsed.groups[0]!.candidate_ids).toEqual(["c-1", "c-2"]);
    expect(parsed.total_groups).toBe(1);
  });

  it("a family-only batch carries a null anchor, and a null trade family is legal", () => {
    expect(
      skillDiscoveryGroupsSchema.safeParse({
        ...RESPONSE,
        groups: [{ ...GROUP, anchor: null, trade_family: null }],
      }).success,
    ).toBe(true);
  });

  it("a mixed batch carries a null unanimous action rather than inventing one", () => {
    const parsed = skillDiscoveryGroupsSchema.parse({
      ...RESPONSE,
      groups: [{ ...GROUP, unanimous_action: null }],
    });
    expect(parsed.groups[0]!.unanimous_action).toBeNull();
  });

  it("an unknown TIER fails — it is derived from a closed three-member function", () => {
    expect(
      skillDiscoveryGroupsSchema.safeParse({
        ...RESPONSE,
        groups: [{ ...GROUP, tier: "unclear" }],
      }).success,
    ).toBe(false);
  });

  it("a missing membership list fails — a batch that cannot name its members is not a batch", () => {
    const { candidate_ids, ...withoutMembers } = GROUP;
    void candidate_ids;
    expect(
      skillDiscoveryGroupsSchema.safeParse({ ...RESPONSE, groups: [withoutMembers] }).success,
    ).toBe(false);
  });

  it("carries NO cursor and NO score — the response is exhaustive and unranked", () => {
    const parsed = skillDiscoveryGroupsSchema.parse(RESPONSE);
    expect(parsed).not.toHaveProperty("nextCursor");
    expect(parsed.groups[0]).not.toHaveProperty("score");
  });

  it("carries the two in-band markers the console renders (#1280, correction 3)", () => {
    const parsed = skillDiscoveryGroupsSchema.parse(RESPONSE);
    expect(parsed.grouping_basis).toBe("groups_are_derived_not_stored");
    expect(parsed.tier_basis).toBe("review_tier_is_derived_not_stored");
  });

  it("strips an added field rather than rejecting the whole response", () => {
    // Additive backend releases must not take a review screen down for a field it does not use.
    // Every schema here is a plain `z.object`; none is `.strict()`.
    const parsed = skillDiscoveryGroupsSchema.parse({
      ...RESPONSE,
      groups: [{ ...GROUP, some_future_field: "x" }],
      some_future_field: { nested: true },
    });
    expect(parsed).not.toHaveProperty("some_future_field");
    expect(parsed.groups[0]).not.toHaveProperty("some_future_field");
    expect(parsed.groups[0]!.candidate_ids).toEqual(GROUP.candidate_ids);
  });

  it("preserves the SERVER's group order — the mirror never re-sorts (#1280, correction 2)", () => {
    // The order is `candidates` descending, tie-broken on `key` in code-unit order, and it is NOT
    // `undecided` — a finished 9-member batch outranks an untouched 2-member one. A parse that
    // quietly reordered would put a second ordering rule behind the one the server publishes.
    const finished = { ...GROUP, key: "direct|A|big", candidates: 9, undecided: 0 };
    const untouched = { ...GROUP, key: "direct|B|small", candidates: 2, undecided: 2 };
    const parsed = skillDiscoveryGroupsSchema.parse({
      ...RESPONSE,
      groups: [finished, untouched],
      total_groups: 2,
    });
    expect(parsed.groups.map((g) => g.key)).toEqual(["direct|A|big", "direct|B|small"]);
  });

  it("an empty population is a real answer, not a failure", () => {
    expect(
      skillDiscoveryGroupsSchema.parse({
        ...RESPONSE,
        groups: [],
        total_groups: 0,
        total_candidates: 0,
        total_undecided: 0,
      }).total_groups,
    ).toBe(0);
  });
});

describe("GET /admin/skills?q= — the MAP picker lookup", () => {
  const SEARCH = {
    skills: [
      {
        skill_id: "skill_plumbing",
        label_en: "Plumbing",
        status: "active",
        kind: "attribute",
        mappable: true,
        not_mappable_reason: null,
      },
      {
        skill_id: "skill_retired",
        label_en: "Retired Thing",
        status: "deprecated",
        kind: "attribute",
        mappable: false,
        not_mappable_reason: "This skill is deprecated.",
      },
    ],
    q: "plumb",
    truncated: false,
  };

  it("parses eligible and INELIGIBLE results together, with the reason", () => {
    // The route reports the ineligible ones rather than filtering them out: a reviewer who gets
    // an empty list cannot tell "no such skill" from "deprecated" from "match vocabulary".
    const parsed = adminCanonicalSkillSearchSchema.parse(SEARCH);
    expect(parsed.skills).toHaveLength(2);
    expect(parsed.skills[1]!.mappable).toBe(false);
    expect(parsed.skills[1]!.not_mappable_reason).toContain("deprecated");
  });

  it("echoes the term, so a stale reply is not read as the answer to a newer keystroke", () => {
    expect(adminCanonicalSkillSearchSchema.parse(SEARCH).q).toBe("plumb");
  });

  it("a truncated result says so", () => {
    expect(adminCanonicalSkillSearchSchema.parse({ ...SEARCH, truncated: true }).truncated).toBe(
      true,
    );
  });

  it("no results is a real answer", () => {
    expect(
      adminCanonicalSkillSearchSchema.parse({ skills: [], q: "zzz", truncated: false }).skills,
    ).toEqual([]);
  });

  it("a result missing `mappable` FAILS — the picker must never guess eligibility", () => {
    const { mappable, ...withoutEligibility } = SEARCH.skills[0]!;
    void mappable;
    expect(
      adminCanonicalSkillSearchSchema.safeParse({ ...SEARCH, skills: [withoutEligibility] })
        .success,
    ).toBe(false);
  });
});

describe("GET /admin/skill-discovery/:id/audit — the spine plus the row", () => {
  const AUDIT = {
    candidate_id: "c-1",
    entries: [
      {
        event_id: "e-1",
        occurred_at: "2026-08-27T09:00:00.000Z",
        action_code: "skill_candidate_approved_create",
        admin_id: "a-1",
      },
    ],
    current: {
      status: "approved_create",
      reviewer_admin_id: "a-1",
      reviewed_at: "2026-08-27T09:00:00.000Z",
      review_reason: "A distinct competency.",
      resulting_skill_id: null,
      approved_job_domain_ids: ["jd_nco_7126_0100"],
      approved_requirement: "required",
    },
    corpus_effect: "decision_recorded_no_corpus_write",
  };

  it("parses the spine entries and the current record together", () => {
    const parsed = skillCandidateAuditSchema.parse(AUDIT);
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.current.approved_job_domain_ids).toEqual(["jd_nco_7126_0100"]);
    expect(parsed.current.approved_requirement).toBe("required");
  });

  it("an UNDECIDED candidate has a `current` full of nulls, never an absent one", () => {
    // A nullable block would make "nothing has happened yet" and "the row is gone" the same
    // response, and the second is a 404.
    const parsed = skillCandidateAuditSchema.parse({
      ...AUDIT,
      entries: [],
      current: {
        status: "pending",
        reviewer_admin_id: null,
        reviewed_at: null,
        review_reason: null,
        resulting_skill_id: null,
        approved_job_domain_ids: [],
        approved_requirement: "preferred",
      },
    });
    expect(parsed.current.status).toBe("pending");
    expect(parsed.entries).toEqual([]);
  });

  it("an absent `current` FAILS the parse", () => {
    const { current, ...withoutCurrent } = AUDIT;
    void current;
    expect(skillCandidateAuditSchema.safeParse(withoutCurrent).success).toBe(false);
  });

  it("an unknown action code PARSES — the vocabulary is closed in TypeScript only", () => {
    expect(
      skillCandidateAuditSchema.safeParse({
        ...AUDIT,
        entries: [{ ...AUDIT.entries[0], action_code: "skill_candidate_something_new" }],
      }).success,
    ).toBe(true);
  });

  it("an unknown STATUS on the current record fails — that column has a CHECK", () => {
    expect(
      skillCandidateAuditSchema.safeParse({
        ...AUDIT,
        current: { ...AUDIT.current, status: "archived" },
      }).success,
    ).toBe(false);
  });

  it("an entry carries no reason, no label and no target — the spine is value-free", () => {
    const parsed = skillCandidateAuditSchema.parse(AUDIT);
    expect(parsed.entries[0]).not.toHaveProperty("review_reason");
    expect(parsed.entries[0]).not.toHaveProperty("resulting_skill_id");
  });

  /*
   * ── THE CAP IS A LOCAL CONSTANT, NOT A NUMBER IN A SENTENCE (#1280, correction 6) ────
   * The route is `LIMIT 200` and returns no truncation flag, so the response cannot say whether
   * anything was cut. The console cannot detect that either — what it CAN do is refuse to claim
   * completeness once the count reaches the cap, and never build an affordance on top of a trail
   * that might be partial. The two facts asserted here are the ones a future reader needs: the
   * response carries no truncation marker, and the console's cap matches the server's.
   */
  it("the response carries NO truncation marker — the console cannot detect a cut trail", () => {
    const parsed = skillCandidateAuditSchema.parse(AUDIT);
    expect(parsed).not.toHaveProperty("truncated");
    expect(parsed).not.toHaveProperty("total");
  });

  it("the console's cap matches the route's own LIMIT", () => {
    expect(SKILL_AUDIT_MAX_ENTRIES).toBe(200);
    expect(SKILL_AUDIT_CAP_NOTE).toContain("200");
  });

  /*
   * ADDITIVE SERVER CHANGES MUST NOT BREAK THIS CONSOLE (#1280, correction 3).
   *
   * The audit found four response fields the issue text omitted — `candidate_id` and
   * `corpus_effect` here, `tier_basis` and `grouping_basis` on the grouping route. All four are
   * declared now, but the general property is the one worth pinning: every schema in this module
   * is a plain `z.object`, so an unknown key is STRIPPED rather than rejected.
   *
   * A `.strict()` mirror would turn any additive backend release into a hard failure on a review
   * screen — the console down for a field it does not even use. Stripping is also what keeps the
   * score-leak guards honest: a key with no home is dropped, never surfaced.
   */
  it("keeps `candidate_id` and `corpus_effect`, and strips a field it has never heard of", () => {
    const parsed = skillCandidateAuditSchema.parse({ ...AUDIT, some_future_field: 1 });
    expect(parsed.candidate_id).toBe(AUDIT.candidate_id);
    expect(parsed.corpus_effect).toBe("decision_recorded_no_corpus_write");
    expect(parsed).not.toHaveProperty("some_future_field");
  });
});

describe("the detail read now carries the reviewer trade judgement", () => {
  it("parses the approved trades and the requirement", () => {
    const parsed = skillDiscoveryDetailSchema.parse({
      ...DETAIL_ROW,
      approved_job_domain_ids: ["jd_nco_7126_0100"],
      approved_requirement: "required",
    });
    expect(parsed.approved_job_domain_ids).toEqual(["jd_nco_7126_0100"]);
    expect(parsed.approved_requirement).toBe("required");
  });

  it("an unknown requirement FAILS — the column is CHECK-backed", () => {
    expect(
      skillDiscoveryDetailSchema.safeParse({ ...DETAIL_ROW, approved_requirement: "mandatory" })
        .success,
    ).toBe(false);
  });

  it("an absent trade list FAILS — an approval that cannot say which trades is half a record", () => {
    const { approved_job_domain_ids, ...without } = DETAIL_ROW;
    void approved_job_domain_ids;
    expect(skillDiscoveryDetailSchema.safeParse(without).success).toBe(false);
  });
});

describe("the three fetchers build the routes they claim to", () => {
  it("the grouping route carries the filters and NEVER a cursor, limit or sort", async () => {
    transport.body = {
      groups: [],
      total_groups: 0,
      total_candidates: 0,
      total_undecided: 0,
      tier_basis: "review_tier_is_derived_not_stored",
      grouping_basis: "groups_are_derived_not_stored",
    };
    await listSkillDiscoveryGroups({ tier: "direct", status: ["pending", "needs_review"] });
    const path = lastPath();
    expect(path.startsWith("/admin/skill-discovery/groups?")).toBe(true);
    expect(path).toContain("tier=direct");
    // The repeated key, not a comma-joined literal the server would read as one status.
    expect(path).toContain("status=pending&status=needs_review");
    expect(path).not.toContain("cursor=");
    expect(path).not.toContain("limit=");
    expect(path).not.toContain("sort=");
  });

  it("the skills lookup hits the ADMIN route, never the internal service seam", async () => {
    transport.body = { skills: [], q: "weld", truncated: false };
    await searchCanonicalSkills("weld");
    const path = lastPath();
    expect(path).toBe("/admin/skills?q=weld");
    // The service-to-service controller is `/internal/skills/*` and carries its own credential.
    // A browser session must never reach it, and this console never does.
    expect(path).not.toContain("/internal/");
  });

  it("the skills lookup encodes the term and forwards an explicit limit", async () => {
    transport.body = { skills: [], q: "arc welding", truncated: false };
    await searchCanonicalSkills("arc welding", 5);
    expect(lastPath()).toContain("q=arc+welding");
    expect(lastPath()).toContain("limit=5");
  });

  it("the audit route hangs off the candidate and encodes its id", async () => {
    transport.body = {
      candidate_id: "c-1",
      entries: [],
      current: {
        status: "pending",
        reviewer_admin_id: null,
        reviewed_at: null,
        review_reason: null,
        resulting_skill_id: null,
        approved_job_domain_ids: [],
        approved_requirement: "preferred",
      },
      corpus_effect: "decision_recorded_no_corpus_write",
    };
    await getSkillCandidateAudit("c 1");
    expect(lastPath()).toBe("/admin/skill-discovery/c%201/audit");
  });
});
