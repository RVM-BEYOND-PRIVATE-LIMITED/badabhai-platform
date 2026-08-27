import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type * as SkillDiscoveryModule from "../../../../lib/skill-discovery";

/**
 * What the Skill Discovery queue screen actually RENDERS (#1260, extended #1280).
 *
 * `lib/skill-discovery.test.ts` covers the request/schema layer; this covers what a reviewer
 * sees. Two server-only seams are replaced (the capability gate, the data layer) plus the
 * client filter bar, which needs an app-router context this renderer does not provide — the
 * same treatment `workers/page.render.test.tsx` gives `WorkerFilterBar`.
 *
 * #1280 REPLACED THE GROUPED VIEW'S DATA SOURCE — it now calls `listSkillDiscoveryGroups`
 * (`GET /admin/skill-discovery/groups`), never `listSkillDiscovery`, so every assertion below
 * that used to read `stub.listCalls` for the DEFAULT (grouped) view now reads `stub.groupsCalls`
 * instead. The flat view is unchanged and still goes through `listSkillDiscovery`.
 */

const stub = vi.hoisted(() => {
  class RequestError extends Error {
    constructor(
      readonly status: number,
      message?: string,
    ) {
      super(message ?? `the admin API returned ${status}`);
    }
  }
  return {
    RequestError,
    order: [] as string[],
    listCalls: [] as Record<string, unknown>[],
    page: { items: [] as unknown[], nextCursor: null as string | null },
    listFailure: null as unknown,
    groupsCalls: [] as Record<string, unknown>[],
    groups: {
      groups: [] as unknown[],
      total_groups: 0,
      total_candidates: 0,
      total_undecided: 0,
      tier_basis: "review_tier_is_derived_not_stored",
      grouping_basis: "groups_are_derived_not_stored",
    },
    groupsFailure: null as unknown,
    metrics: null as unknown,
    metricsFailure: null as unknown,
  };
});

vi.mock("../../../../lib/auth", () => ({
  requireCapability: async (capability: string) => {
    stub.order.push(`gate:${capability}`);
    return { adminId: "a-1", role: "ops_admin", capabilities: [capability] };
  },
}));

vi.mock("../../../../lib/admin-http", () => ({
  isAdminRequestError: (err: unknown) => err instanceof stub.RequestError,
}));

vi.mock("../../../../lib/skill-discovery", async () => {
  const actual = await vi.importActual<typeof SkillDiscoveryModule>(
    "../../../../lib/skill-discovery",
  );
  return {
    ...actual,
    listSkillDiscovery: async (filters: Record<string, unknown>) => {
      stub.order.push("list");
      stub.listCalls.push(filters);
      if (stub.listFailure) throw stub.listFailure;
      return stub.page;
    },
    listSkillDiscoveryGroups: async (filters: Record<string, unknown>) => {
      stub.order.push("groups");
      stub.groupsCalls.push(filters);
      if (stub.groupsFailure) throw stub.groupsFailure;
      return stub.groups;
    },
    getSkillDiscoveryMetrics: async () => {
      stub.order.push("metrics");
      if (stub.metricsFailure) throw stub.metricsFailure;
      return stub.metrics;
    },
  };
});

vi.mock("./filter-bar", () => ({ SkillDiscoveryFilterBar: () => null }));

const { default: SkillDiscoveryPage } = await import("./page");

const METRICS = {
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

const ROW = {
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

const GROUP = {
  key: "direct|Plumbers and Pipe Fitters|sanitary fixture",
  tier: "direct",
  trade_family: "Plumbers and Pipe Fitters",
  anchor: "sanitary fixture",
  label: "Plumbers and Pipe Fitters — sanitary fixture",
  candidate_ids: [ROW.id],
  candidates: 2,
  undecided: 1,
  source_rows: 6,
  source_domains: 3,
  unanimous_action: "create",
};

beforeEach(() => {
  stub.order.length = 0;
  stub.listCalls.length = 0;
  stub.page = { items: [], nextCursor: null };
  stub.listFailure = null;
  stub.groupsCalls.length = 0;
  stub.groups = {
    groups: [],
    total_groups: 0,
    total_candidates: 0,
    total_undecided: 0,
    tier_basis: "review_tier_is_derived_not_stored",
    grouping_basis: "groups_are_derived_not_stored",
  };
  stub.groupsFailure = null;
  stub.metrics = METRICS;
  stub.metricsFailure = null;
});

const render = async (searchParams: Record<string, string | string[] | undefined> = {}) =>
  renderToStaticMarkup(await SkillDiscoveryPage({ searchParams: Promise.resolve(searchParams) }));

describe("the gate", () => {
  it("requires read_entities before the read runs", async () => {
    await render();
    expect(stub.order[0]).toBe("gate:read_entities");
  });
});

describe("AC#1 — dashboard tiles render from one metrics request, no client aggregation", () => {
  it("renders every densified bucket the response carries, zeros included", async () => {
    const out = await render();
    expect(out).toContain("599"); // awaiting_decision
    expect(out).toContain("82"); // direct
    expect(out).toContain("6,074"); // derived (Indian grouping)
    expect(out).toContain("517"); // ambiguous
    // Zero buckets — created/mapped/merged/rejected are all 0 in the fixture and must still render.
    const zeroCount = (out.match(/<span class="stat__value">0<\/span>/g) ?? []).length;
    expect(zeroCount).toBeGreaterThanOrEqual(4);
  });

  it("renders `tier_basis` beside the three tier counts it qualifies", async () => {
    // #1280 correction 3. The tiles look like counts of a stored column and are not — the tier is
    // recomputed on every read from the phrase class and whether a strong match exists.
    const out = await render();
    expect(out).toContain("A tier is worked out from the phrase class");
    expect(out).toContain("not a stored column, and nothing decides on it");
  });

  it("degrades to an error tile without blanking the queue below when metrics fails", async () => {
    stub.metricsFailure = new TypeError("network down");
    stub.page = { items: [ROW], nextCursor: null };
    const out = await render({ view: "flat" });
    expect(out).toContain("Dashboard tiles are unavailable");
    expect(out).toContain("sanitary fixture installation");
  });
});

describe("#1280 — the grouped view now calls the real GET /admin/skill-discovery/groups route", () => {
  it("defaults to the grouped view, and asks the GROUPS route, never the queue route", async () => {
    await render();
    expect(stub.groupsCalls.length).toBe(1);
    expect(stub.listCalls.length).toBe(0);
  });

  it("the groups request carries NO cursor, limit or sort — a group promises a complete list", async () => {
    await render();
    const call = stub.groupsCalls[0]!;
    expect(call).not.toHaveProperty("cursor");
    expect(call).not.toHaveProperty("limit");
    expect(call).not.toHaveProperty("sort");
  });

  it("renders the real batches — server label, real candidate/undecided counts, no 'on this page' claim", async () => {
    stub.groups = { ...stub.groups, groups: [GROUP], total_groups: 1, total_candidates: 2, total_undecided: 1 };
    const out = await render();
    expect(out).toContain("<details");
    expect(out).toContain(GROUP.label);
    expect(out).toContain("2 candidates");
    expect(out).toContain("1 undecided");
    expect(out).not.toContain("on this page");
  });

  it("renders the exhaustive totals footer, not a page-scoped claim", async () => {
    stub.groups = {
      ...stub.groups,
      groups: [GROUP],
      total_groups: 1,
      total_candidates: 2,
      total_undecided: 1,
    };
    const out = await render();
    expect(out).toContain("1 batches over 2 candidates");
    expect(out).toContain("1 still undecided");
  });

  it("switches to the flat view and asks for the queue route with the smaller default page size", async () => {
    await render({ view: "flat" });
    expect(stub.listCalls[0]).toMatchObject({ limit: 50 });
    expect(stub.groupsCalls.length).toBe(0);
  });

  it("the flat view renders one row per candidate in a plain table, no <details>", async () => {
    stub.page = { items: [ROW], nextCursor: null };
    const out = await render({ view: "flat" });
    expect(out).not.toContain("<details");
    expect(out).toContain("sanitary fixture installation");
  });

  it("the flat view still paginates with a keyset cursor; the grouped view never does", async () => {
    stub.page = { items: [ROW], nextCursor: "bmV4dA" };
    const flat = await render({ view: "flat" });
    expect(flat).toContain("Server-paged with a keyset cursor");

    stub.groups = { ...stub.groups, groups: [GROUP], total_groups: 1, total_candidates: 2, total_undecided: 1 };
    const grouped = await render();
    expect(grouped).not.toContain("Server-paged with a keyset cursor");
  });
});

describe("#1280 correction 3 — the grouping route's in-band marker is rendered, not just parsed", () => {
  it("renders `grouping_basis` — the server's own statement that a batch is stored nowhere", async () => {
    stub.groups = { ...stub.groups, groups: [GROUP], total_groups: 1, total_candidates: 2 };
    const out = await render();
    expect(out).toContain("A batch is worked out fresh on every read");
    expect(out).toContain("no decision is ever recorded against a batch");
  });

  it("an UNRECOGNISED basis marker renders itself rather than a guessed sentence", async () => {
    stub.groups = {
      ...stub.groups,
      groups: [GROUP],
      total_groups: 1,
      grouping_basis: "some_marker_added_later",
    };
    const out = await render();
    expect(out).toContain("some_marker_added_later");
  });
});

describe("#1280 — group sort is an explicit, labelled client re-order, defaulting to the server's own order", () => {
  const SMALL_UNDECIDED = { ...GROUP, key: "g-small", candidates: 5, undecided: 4, label: "small-undecided" };
  const BIG_DECIDED = { ...GROUP, key: "g-big", candidates: 40, undecided: 0, label: "big-decided" };

  it("defaults to the server's own order — biggest batch first, unchanged", async () => {
    stub.groups = { ...stub.groups, groups: [BIG_DECIDED, SMALL_UNDECIDED], total_groups: 2 };
    const out = await render();
    expect(out.indexOf("big-decided")).toBeLessThan(out.indexOf("small-undecided"));
    expect(out).toContain("Biggest batch first (server order)");
  });

  it("`?groupSort=undecided` re-orders the SAME fetched groups — most undecided first", async () => {
    stub.groups = { ...stub.groups, groups: [BIG_DECIDED, SMALL_UNDECIDED], total_groups: 2 };
    const out = await render({ groupSort: "undecided" });
    expect(out.indexOf("small-undecided")).toBeLessThan(out.indexOf("big-decided"));
    // The re-order is a DISPLAY choice — the request itself never carries a `sort` field, since
    // the groups route does not accept one.
    expect(stub.groupsCalls[0]).not.toHaveProperty("sort");
  });

  /*
   * ── THE TIE-BREAK IS A CODE-UNIT COMPARISON, NOT `localeCompare` ─────────────────────
   * It WAS `a.key.localeCompare(b.key)` — the exact comparator `packages/db` removed from
   * `groupFacts` in this same contract correction, and for two failures that comparator's own
   * docblock measures rather than assumes. This re-sort reintroduced it one layer up, over the
   * same keys, under a docblock promising the result was deterministic.
   *
   * Both cases below are live inputs, not hypotheticals: Devanagari anchors are a supported case
   * with a backend test of their own, and a zero-width character survives normalization.
   */
  it("orders a Devanagari anchor the same way regardless of the host's ICU locale", async () => {
    // MEASURED in this runtime, not assumed:
    //   "direct|craft|weld".localeCompare("direct|craft|बढ़ई")  ->  -1 under en-US
    //                                                          ->  +1 under hi-IN
    // Code-unit order is -1 on every host, because 'w' (U+0077) < 'ब' (U+092C). This assertion
    // therefore pins the SAME answer everywhere; under the old comparator it passed on an `en`
    // host and failed on a `hi` one, which is the property being fixed rather than the symptom.
    const latin = { ...GROUP, key: "direct|craft|weld", candidates: 3, undecided: 3, label: "latin-key" };
    const deva = { ...GROUP, key: "direct|craft|बढ़ई", candidates: 3, undecided: 3, label: "devanagari-key" };
    stub.groups = { ...stub.groups, groups: [deva, latin], total_groups: 2 };
    const out = await render({ groupSort: "undecided" });
    expect(out.indexOf("latin-key")).toBeLessThan(out.indexOf("devanagari-key"));
  });

  it("does not let an invisible character make two distinct batches swap places", async () => {
    // MEASURED: `localeCompare` returns 0 for these two keys (they differ only by U+200B) while
    // code-unit order returns 1. A 0 means the comparator ABSTAINED, and `Array.prototype.sort`
    // is stable, so the order silently falls back to however the groups happened to arrive —
    // which is the server's `candidates` order, not anything this tie-break chose. Unlike the
    // Devanagari case above, this one fails on every host, `en` included.
    const withZwsp = { ...GROUP, key: `direct|Craft|co\u200Bop`, candidates: 3, undecided: 3, label: "zwsp-key" };
    const plain = { ...GROUP, key: "direct|Craft|coop", candidates: 3, undecided: 3, label: "plain-key" };

    stub.groups = { ...stub.groups, groups: [withZwsp, plain], total_groups: 2 };
    const first = await render({ groupSort: "undecided" });
    stub.groups = { ...stub.groups, groups: [plain, withZwsp], total_groups: 2 };
    const second = await render({ groupSort: "undecided" });

    // Same set, two arrival orders, one rendered order — which is what "deterministic" has to
    // mean for a comparator whose whole job is to be the final tie-break.
    const order = (out: string) => out.indexOf("zwsp-key") < out.indexOf("plain-key");
    expect(order(first)).toBe(order(second));
  });
});

describe("AC#11 — tier sequencing is visible, never a silent default filter", () => {
  it("defaults to the direct tier, explicitly, and says so", async () => {
    await render();
    expect(stub.groupsCalls[0]).toMatchObject({ tier: "direct" });
    expect((await render()).includes("Direct (default)")).toBe(true);
  });

  it("the derived tab reads as sequenced-behind, not a normal one-click tab", async () => {
    const out = await render();
    expect(out).toContain("sequenced behind Direct");
    expect(out).toContain("view anyway");
  });

  it("opening derived without the acknowledgement still shows the reason banner, and does NOT actually request derived rows", async () => {
    await render({ tier: "derived" });
    // The load-bearing assertion: a guessed or shared `?tier=derived` link must not silently
    // serve derived candidates while the tab still reads as unselected — the request itself
    // falls back to `direct` until the acknowledging click sets `ack=1`.
    expect(stub.groupsCalls[0]).toMatchObject({ tier: "direct" });
  });

  it("carries the derived filter through to the request once acknowledged", async () => {
    await render({ tier: "derived", ack: "1" });
    expect(stub.groupsCalls[0]).toMatchObject({ tier: "derived" });
  });

  it("`All tiers` omits the tier filter entirely, and it is not the default tab", async () => {
    const bare = await render();
    const allTiersTag = (bare.match(/<a[^>]*>All tiers<\/a>/) ?? [""])[0];
    expect(allTiersTag).not.toContain("btn--primary");
    expect(stub.groupsCalls[0]).toMatchObject({ tier: "direct" });

    await render({ tier: "all" });
    expect(stub.groupsCalls[1]!.tier).toBeUndefined();
  });
});

describe("status scope — an explicit default, never hidden", () => {
  it("sends the two undecided statuses explicitly when nothing is chosen", async () => {
    await render();
    expect(stub.groupsCalls[0]).toMatchObject({ status: ["pending", "needs_review"] });
  });

  it("held scope sends only `deferred`", async () => {
    await render({ statusScope: "held" });
    expect(stub.groupsCalls[0]).toMatchObject({ status: ["deferred"] });
  });

  it("decided scope sends the four terminal statuses", async () => {
    await render({ statusScope: "decided" });
    expect(stub.groupsCalls[0]!.status).toEqual(
      expect.arrayContaining(["approved_create", "approved_map", "approved_merge", "rejected"]),
    );
  });

  it("all scope omits the status filter", async () => {
    await render({ statusScope: "all" });
    expect(stub.groupsCalls[0]!.status).toBeUndefined();
  });
});

describe("AC#3 — every filter field is reachable", () => {
  it("the FLAT view forwards band, proposedAction, sourceType, tradeFamily, runId, clusterKey, phrase, dates and sort", async () => {
    await render({
      view: "flat",
      band: "high",
      proposedAction: "create",
      sourceType: "worker_phrase",
      tradeFamily: "Welders",
      runId: "sdr_1",
      clusterKey: "ck-1",
      phrase: "arc weld",
      createdFrom: "2026-08-01",
      createdTo: "2026-08-20",
      sort: "oldest",
    });
    expect(stub.listCalls[0]).toMatchObject({
      band: "high",
      proposedAction: "create",
      sourceType: "worker_phrase",
      tradeFamily: "Welders",
      runId: "sdr_1",
      clusterKey: "ck-1",
      phrase: "arc weld",
      createdFrom: "2026-08-01",
      createdTo: "2026-08-20",
      sort: "oldest",
    });
  });

  it("the GROUPED view forwards the same filters, minus cursor/limit/sort which the route does not accept", async () => {
    await render({
      band: "high",
      proposedAction: "create",
      sourceType: "worker_phrase",
      tradeFamily: "Welders",
      runId: "sdr_1",
      clusterKey: "ck-1",
      phrase: "arc weld",
      createdFrom: "2026-08-01",
      createdTo: "2026-08-20",
    });
    expect(stub.groupsCalls[0]).toMatchObject({
      band: "high",
      proposedAction: "create",
      sourceType: "worker_phrase",
      tradeFamily: "Welders",
      runId: "sdr_1",
      clusterKey: "ck-1",
      phrase: "arc weld",
      createdFrom: "2026-08-01",
      createdTo: "2026-08-20",
    });
    expect(stub.groupsCalls[0]).not.toHaveProperty("sort");
    expect(stub.groupsCalls[0]).not.toHaveProperty("cursor");
    expect(stub.groupsCalls[0]).not.toHaveProperty("limit");
  });
});

describe("AC#5/#6 — no cosine score, vector or embedding model anywhere on this screen", () => {
  it("the flat row never mentions a score, vector, cosine, or embedding model", async () => {
    stub.page = { items: [ROW], nextCursor: null };
    const out = await render({ view: "flat" });
    expect(out.toLowerCase()).not.toMatch(/cosine|embedding model|vector/);
    expect(out).not.toMatch(/\b0\.\d\d\b/);
  });

  it("a review batch card never mentions a score, vector, cosine, or embedding model", async () => {
    stub.groups = { ...stub.groups, groups: [GROUP], total_groups: 1, total_candidates: 2, total_undecided: 1 };
    const out = await render();
    expect(out.toLowerCase()).not.toMatch(/cosine|embedding model|vector/);
    expect(out).not.toMatch(/\b0\.\d\d\b/);
  });
});

describe("the three empty states", () => {
  it("no discovery run ever persisted — the ops state", async () => {
    stub.metrics = { ...METRICS, total: 0 };
    const out = await render();
    expect(out).toContain("No discovery run has ever been persisted");
  });

  it("nothing awaiting decision — a clean queue, not an ops problem", async () => {
    stub.metrics = { ...METRICS, total: 6673 };
    const out = await render();
    expect(out).toContain("Nothing is awaiting a decision right now");
    expect(out).not.toContain("No discovery run has ever been persisted");
  });

  it("no candidates match these filters — a filtered empty result", async () => {
    stub.metrics = { ...METRICS, total: 6673 };
    const out = await render({ tradeFamily: "Nonexistent Trade" });
    expect(out).toContain("No candidates match these filters");
  });

  it("the empty check reads the GROUPS result in the grouped view, not a stale queue page", async () => {
    // Regression guard: an empty `stub.page` (the default) must not be what decides the grouped
    // view's empty state — only `stub.groups.groups` may.
    stub.metrics = { ...METRICS, total: 6673 };
    stub.groups = { ...stub.groups, groups: [GROUP], total_groups: 1, total_candidates: 2, total_undecided: 1 };
    const out = await render();
    expect(out).not.toContain("No candidates match these filters");
    expect(out).toContain(GROUP.label);
  });
});

describe("error states", () => {
  it("a 400 on the grouped (default) view renders the SERVER'S OWN message verbatim — never the generic copy", async () => {
    stub.groupsFailure = new stub.RequestError(
      400,
      "That filter matches 25000 candidates and grouping is exhaustive, not paged. Narrow it " +
        "— by tier, run or trade family — to at most 20000.",
    );
    const out = await render({ tier: "not-a-real-tier" });
    expect(out).toContain("The server rejected this request");
    expect(out).toContain("That filter matches 25000 candidates");
    expect(out).not.toContain("Nothing was fetched");
    expect(out).not.toContain("The queue is unavailable");
  });

  it("a 400 on the flat view renders the generic filter-refusal copy, unchanged from #1260", async () => {
    stub.listFailure = new stub.RequestError(400);
    const out = await render({ view: "flat", tier: "not-a-real-tier" });
    expect(out).toContain("The server rejected this request");
    expect(out).toContain("Nothing was fetched");
    expect(out).not.toContain("The queue is unavailable");
  });

  it("anything else (grouped) is our fault, with a retry that repeats the same query", async () => {
    stub.groupsFailure = new TypeError("network down");
    const out = await render({ tradeFamily: "Welders" });
    expect(out).toContain("The queue is unavailable");
    expect(out).toContain("tradeFamily=Welders");
  });

  it("anything else (flat) is our fault too, with its own retry", async () => {
    stub.listFailure = new TypeError("network down");
    const out = await render({ view: "flat", tradeFamily: "Welders" });
    expect(out).toContain("The queue is unavailable");
    expect(out).toContain("tradeFamily=Welders");
  });
});

describe("grouped rows link to their own decision screen — a group is a lens, never a merge", () => {
  it("every member id links to /skills/discovery/:id and there is no group-level decide button", async () => {
    stub.groups = { ...stub.groups, groups: [GROUP], total_groups: 1, total_candidates: 2, total_undecided: 1 };
    const out = await render();
    expect(out).toContain(`href="/skills/discovery/${ROW.id}"`);
    expect(out).not.toMatch(/decide all|bulk decide/i);
  });
});

// ---------------------------------------------------------------------------
// AC#12 — loading. This route's async data fetch is caught by Next's Suspense boundary at
// `(portal)/loading.tsx`; this route additionally ships its OWN shape-matched skeleton
// (`./loading.tsx`) because its tile counts and queue-panel shape differ materially from the
// generic shell one — a skeleton the wrong size jumps the layout the moment real content
// resolves. Rendered directly, mirroring how the portal-level loading state has no page to
// await: there is nothing to mock, it is a plain component.
// ---------------------------------------------------------------------------
describe("loading", () => {
  it("renders a busy, shape-matched skeleton with the tile counts this page actually has", async () => {
    const { default: SkillDiscoveryLoading } = await import("./loading");
    const out = renderToStaticMarkup(<SkillDiscoveryLoading />);
    expect(out).toContain('aria-busy="true"');
    expect(out).toContain("Loading…");
    // Four headline tiles + five outcome tiles = nine `.stat` skeletons, plus the queue panel.
    expect((out.match(/class="stat"/g) ?? []).length).toBe(9);
    expect(out).toContain('class="panel"');
  });
});
