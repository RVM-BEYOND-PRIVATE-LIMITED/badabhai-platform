import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type * as SkillDiscoveryModule from "../../../../lib/skill-discovery";

/**
 * What the Skill Discovery queue screen actually RENDERS (#1260).
 *
 * `lib/skill-discovery.test.ts` covers the request/schema layer; this covers what a reviewer
 * sees. Two server-only seams are replaced (the capability gate, the data layer) plus the
 * client filter bar, which needs an app-router context this renderer does not provide — the
 * same treatment `workers/page.render.test.tsx` gives `WorkerFilterBar`.
 */

const stub = vi.hoisted(() => {
  class RequestError extends Error {
    constructor(readonly status: number) {
      super(`the admin API returned ${status}`);
    }
  }
  return {
    RequestError,
    order: [] as string[],
    listCalls: [] as Record<string, unknown>[],
    groupCalls: [] as Record<string, unknown>[],
    page: { items: [] as unknown[], nextCursor: null as string | null },
    groups: {
      groups: [] as unknown[],
      total_groups: 0,
      total_candidates: 0,
      total_undecided: 0,
      tier_basis: "review_tier_is_derived_not_stored",
      grouping_basis: "groups_are_derived_not_stored",
    } as Record<string, unknown>,
    listFailure: null as unknown,
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
      stub.groupCalls.push(filters);
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

/**
 * One batch as the SERVER computes it. Every field here is read off the response by the page —
 * the key, the anchor, the label, the membership and the counts — so a fixture is the only place
 * this console has an opinion about any of them.
 */
const GROUP = {
  key: "direct|Plumbers and Pipe Fitters|sanitary",
  tier: "direct",
  trade_family: "Plumbers and Pipe Fitters",
  anchor: "sanitary",
  label: "sanitary — Plumbers and Pipe Fitters",
  candidate_ids: [
    "c-1aaaaaaa-0000-4000-8000-000000000001",
    "c-2bbbbbbb-0000-4000-8000-000000000002",
  ],
  candidates: 2,
  undecided: 2,
  source_rows: 7,
  source_domains: 3,
  unanimous_action: "create",
};

beforeEach(() => {
  stub.order.length = 0;
  stub.listCalls.length = 0;
  stub.groupCalls.length = 0;
  stub.page = { items: [], nextCursor: null };
  stub.groups = {
    groups: [GROUP],
    total_groups: 1,
    total_candidates: 2,
    total_undecided: 2,
    tier_basis: "review_tier_is_derived_not_stored",
    grouping_basis: "groups_are_derived_not_stored",
  };
  stub.listFailure = null;
  stub.groupsFailure = null;
  stub.metrics = METRICS;
  stub.metricsFailure = null;
});

const render = async (searchParams: Record<string, string | string[] | undefined> = {}) =>
  renderToStaticMarkup(await SkillDiscoveryPage({ searchParams: Promise.resolve(searchParams) }));

/**
 * Render the FLAT view.
 *
 * The filter-forwarding assertions below are about what reaches the QUEUE route, and since the
 * grouping route took over the default view the queue is only read when the operator asks for
 * flat. Rendering flat is therefore how those tests keep asserting the thing they were written to
 * assert; `groupCalls` covers the same filters reaching the grouping route.
 */
const renderFlat = async (searchParams: Record<string, string | string[] | undefined> = {}) =>
  render({ ...searchParams, view: "flat" });

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
    // recomputed per read from the phrase class and whether a strong match exists.
    const out = await render();
    // `renderToStaticMarkup` escapes the apostrophe, so the assertion matches either form rather
    // than pinning an HTML entity that a copy edit would break for the wrong reason.
    expect(out.replace(/&#x27;/g, "'")).toContain(
      "A tier is worked out from the candidate's phrase class",
    );
    expect(out).toContain("not a stored column and nothing decides on it");
  });

  it("degrades to an error tile without blanking the queue below when metrics fails", async () => {
    stub.metricsFailure = new TypeError("network down");
    stub.page = { items: [ROW], nextCursor: null };
    const out = await renderFlat();
    expect(out).toContain("Dashboard tiles are unavailable");
    expect(out).toContain("sanitary fixture installation");
  });
});

describe("AC#2 — grouped is the default and never asks for the whole 6,673-row table", () => {
  it("defaults to the grouped view, and reads the GROUPING route rather than the queue", async () => {
    await render();
    expect(stub.order).toContain("groups");
    // The queue read is not issued at all in this view: two reads for one screen would be a
    // round trip nobody renders.
    expect(stub.listCalls).toHaveLength(0);
  });

  it("sends the filters to the grouping route and NEVER a cursor, limit or sort", async () => {
    // The route's contract is that a group is exhaustive for its filters. A cursor or a limit
    // would ask it to break that promise, and its own query schema refuses all three.
    await render();
    const sent = stub.groupCalls[0]!;
    expect(sent).toMatchObject({ tier: "direct" });
    expect(sent).not.toHaveProperty("cursor");
    expect(sent).not.toHaveProperty("limit");
    expect(sent).not.toHaveProperty("sort");
  });

  it("renders the server's label, anchor and counts verbatim", async () => {
    const out = await render();
    expect(out).toContain("<details");
    expect(out).toContain("sanitary — Plumbers and Pipe Fitters");
    expect(out).toContain("sanitary");
    expect(out).toContain("2 candidates");
    expect(out).toContain("2 still to decide");
    expect(out).toContain("7 source phrases across 3 trades");
  });

  it("renders the exhaustive totals the response carries, not a page-scoped count", async () => {
    const out = await render();
    expect(out).toContain("1 review screen");
    expect(out).toContain("Exhaustive for the filters");
    // The old page-scoped hedge is gone because the count is no longer page-scoped.
    expect(out).not.toContain("candidates on this page");
  });

  it("lists the EXACT membership as links, so a batch is never approximated", async () => {
    const out = await render();
    for (const id of GROUP.candidate_ids) {
      expect(out).toContain(`/skills/discovery/${id}`);
    }
    expect(out).toContain("These ids are the batch, exactly");
  });

  it("says an anchored batch is NARROWER than the trade-and-tier link it offers", async () => {
    const out = await render();
    expect(out).toContain("This batch is narrower");
  });

  it("a family-only batch offers the flat link with no narrower-than caveat", async () => {
    stub.groups = {
      ...stub.groups,
      groups: [{ ...GROUP, anchor: null, label: "Plumbers and Pipe Fitters" }],
    };
    const out = await render();
    expect(out).toContain("batched on the trade family alone");
    expect(out).not.toContain("This batch is narrower");
  });

  it("reports a mixed batch as mixed rather than inventing a single reading", async () => {
    stub.groups = { ...stub.groups, groups: [{ ...GROUP, unanimous_action: null }] };
    const out = await render();
    expect(out).toContain("Members disagree");
  });

  /*
   * ── THE ORDER IS THE SERVER'S, AND IT IS NOT THE INTUITIVE ONE (#1280, correction 2) ─
   * `candidates` DESCENDING, tie-broken on the group key in code-unit order. NOT `undecided`, so a
   * 35-member batch with nothing left to decide outranks a 10-member batch nobody has opened.
   *
   * The console does not re-sort. A second ordering rule in the browser would disagree with the
   * one the server publishes, over a list whose promise is to be exhaustive and reproducible for
   * the applied filters — the same defect as the page-local grouping this screen already deleted,
   * one field along. Whether the SERVER should order by `undecided` is an owner's call.
   *
   * So the two honest moves, both pinned here: say what the order is, and mark the batches with
   * nothing left to decide so a reviewer skips them by eye.
   */
  it("renders the batches in the server's order, unchanged", async () => {
    const finished = { ...GROUP, key: "direct|A|big", label: "big — A", candidates: 9, undecided: 0 };
    const untouched = { ...GROUP, key: "direct|B|small", label: "small — B", candidates: 2, undecided: 2 };
    stub.groups = { ...stub.groups, groups: [finished, untouched], total_groups: 2 };
    const out = await render();
    expect(out.indexOf("big — A")).toBeLessThan(out.indexOf("small — B"));
  });

  it("does not reorder even when the server's own order puts a finished batch first", async () => {
    // The same two batches with the response order REVERSED. A console that re-sorted by
    // `undecided` would produce the same rendering for both fixtures; this one cannot.
    const finished = { ...GROUP, key: "direct|A|big", label: "big — A", candidates: 9, undecided: 0 };
    const untouched = { ...GROUP, key: "direct|B|small", label: "small — B", candidates: 2, undecided: 2 };
    stub.groups = { ...stub.groups, groups: [untouched, finished], total_groups: 2 };
    const out = await render();
    expect(out.indexOf("small — B")).toBeLessThan(out.indexOf("big — A"));
  });

  it("states the ordering rule, including that it is not by how much is left", async () => {
    const out = await render();
    expect(out).toContain("Ordered by batch size, largest first");
    expect(out).toContain("not by how much is left to review");
  });

  it("marks a batch with nothing left to decide instead of moving it", async () => {
    stub.groups = { ...stub.groups, groups: [{ ...GROUP, undecided: 0 }] };
    const out = await render();
    expect(out).toContain("nothing left to decide");
    expect(out).not.toContain("0 still to decide");
  });

  it("renders `grouping_basis` — the server's own statement that a batch is stored nowhere", async () => {
    // #1280 correction 3: the response carries it and the console was parsing it without ever
    // showing it, leaving a disclaimer the reviewer never sees on a screen that looks like a list
    // of records.
    const out = await render();
    expect(out).toContain("A batch is worked out fresh on every read");
    expect(out).toContain("no decision is ever recorded against a batch");
  });

  it("an UNRECOGNISED basis marker renders itself rather than a guessed sentence", async () => {
    stub.groups = { ...stub.groups, grouping_basis: "some_marker_added_later" };
    const out = await render();
    expect(out).toContain("some_marker_added_later");
  });

  it("switches to the flat view and asks for the smaller default page size", async () => {
    await renderFlat({ view: "flat" });
    expect(stub.listCalls[0]).toMatchObject({ limit: 50 });
  });

  it("the flat view renders one row per candidate in a plain table, no <details>", async () => {
    stub.page = { items: [ROW], nextCursor: null };
    const out = await render({ view: "flat" });
    expect(out).not.toContain("<details");
    expect(out).toContain("sanitary fixture installation");
  });
});

describe("AC#11 — tier sequencing is visible, never a silent default filter", () => {
  it("defaults to the direct tier, explicitly, and says so", async () => {
    await renderFlat();
    expect(stub.listCalls[0]).toMatchObject({ tier: "direct" });
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
    // falls back to `direct` until the acknowledging click sets `ack=1`. Asserted on the
    // GROUPING call because that is the read the default view issues; the sequencing rule has to
    // hold on whichever route runs, not just the one it was written against.
    expect(stub.groupCalls[0]).toMatchObject({ tier: "direct" });
  });

  it("carries the derived filter through to the request once acknowledged", async () => {
    await renderFlat({ tier: "derived", ack: "1" });
    expect(stub.listCalls[0]).toMatchObject({ tier: "derived" });
  });

  it("`All tiers` omits the tier filter entirely, and it is not the default tab", async () => {
    const bare = await render();
    const allTiersTag = (bare.match(/<a[^>]*>All tiers<\/a>/) ?? [""])[0];
    expect(allTiersTag).not.toContain("btn--primary");
    expect(stub.groupCalls[0]).toMatchObject({ tier: "direct" });

    await render({ tier: "all" });
    expect(stub.groupCalls[1]!.tier).toBeUndefined();
  });
});

describe("status scope — an explicit default, never hidden", () => {
  it("sends the two undecided statuses explicitly when nothing is chosen", async () => {
    await renderFlat();
    expect(stub.listCalls[0]).toMatchObject({ status: ["pending", "needs_review"] });
  });

  it("held scope sends only `deferred`", async () => {
    await renderFlat({ statusScope: "held" });
    expect(stub.listCalls[0]).toMatchObject({ status: ["deferred"] });
  });

  it("decided scope sends the four terminal statuses", async () => {
    await renderFlat({ statusScope: "decided" });
    expect(stub.listCalls[0]!.status).toEqual(
      expect.arrayContaining(["approved_create", "approved_map", "approved_merge", "rejected"]),
    );
  });

  it("all scope omits the status filter", async () => {
    await renderFlat({ statusScope: "all" });
    expect(stub.listCalls[0]!.status).toBeUndefined();
  });
});

describe("AC#3 — every filter field is reachable", () => {
  it("forwards band, proposedAction, sourceType, tradeFamily, runId, clusterKey, phrase, dates and sort", async () => {
    await renderFlat({
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
});

describe("AC#5/#6 — no cosine score, vector or embedding model anywhere on this screen", () => {
  it("the rendered row never mentions a score, vector, cosine, or embedding model", async () => {
    stub.page = { items: [ROW], nextCursor: null };
    const out = await render();
    expect(out.toLowerCase()).not.toMatch(/cosine|embedding model|vector/);
    expect(out).not.toMatch(/\b0\.\d\d\b/);
  });
});

describe("the three empty states", () => {
  const noGroups = () => {
    stub.groups = {
      ...stub.groups,
      groups: [],
      total_groups: 0,
      total_candidates: 0,
      total_undecided: 0,
    };
  };

  it("no discovery run ever persisted — the ops state", async () => {
    stub.metrics = { ...METRICS, total: 0 };
    noGroups();
    const out = await render();
    expect(out).toContain("No discovery run has ever been persisted");
  });

  it("nothing awaiting decision — a clean queue, not an ops problem", async () => {
    stub.metrics = { ...METRICS, total: 6673 };
    noGroups();
    const out = await render();
    expect(out).toContain("Nothing is awaiting a decision right now");
    expect(out).not.toContain("No discovery run has ever been persisted");
  });

  it("no candidates match these filters — a filtered empty result", async () => {
    stub.metrics = { ...METRICS, total: 6673 };
    noGroups();
    const out = await render({ tradeFamily: "Nonexistent Trade" });
    expect(out).toContain("No candidates match these filters");
  });
});

describe("error states", () => {
  it("a 400 is the operator's filters, not our outage", async () => {
    // Set on BOTH seams: the default view reads the grouping route and the flat view reads the
    // queue, and a refusal must render identically whichever one the operator is on. On the
    // grouping route a 400 is also how "too much to group exhaustively" arrives.
    stub.listFailure = new stub.RequestError(400);
    stub.groupsFailure = new stub.RequestError(400);
    const out = await render({ tier: "not-a-real-tier" });
    expect(out).toContain("The server rejected this request");
    expect(out).not.toContain("The queue is unavailable");
  });

  it("anything else is our fault, with a retry that repeats the same query", async () => {
    stub.listFailure = new TypeError("network down");
    stub.groupsFailure = new TypeError("network down");
    const out = await render({ tradeFamily: "Welders" });
    expect(out).toContain("The queue is unavailable");
    expect(out).toContain("tradeFamily=Welders");
  });
});

describe("grouped rows link to their own decision screen — a group is a lens, never a merge", () => {
  it("every member links to /skills/discovery/:id and there is no group-level decide button", async () => {
    const out = await render();
    for (const id of GROUP.candidate_ids) {
      expect(out).toContain(`href="/skills/discovery/${id}"`);
    }
    // A group has no row anywhere, so there is nothing a group-level control could address.
    // Every member is decided on its own screen, with its own reason and its own audit row.
    expect(out).not.toMatch(/decide all|bulk decide|approve group/i);
  });

  it("the flat view still links every row to its own screen", async () => {
    stub.page = { items: [ROW], nextCursor: null };
    const out = await renderFlat();
    expect(out).toContain(`href="/skills/discovery/${ROW.id}"`);
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
