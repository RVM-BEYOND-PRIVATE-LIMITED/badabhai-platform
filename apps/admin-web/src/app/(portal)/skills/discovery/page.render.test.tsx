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
    page: { items: [] as unknown[], nextCursor: null as string | null },
    listFailure: null as unknown,
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

beforeEach(() => {
  stub.order.length = 0;
  stub.listCalls.length = 0;
  stub.page = { items: [], nextCursor: null };
  stub.listFailure = null;
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

  it("degrades to an error tile without blanking the queue below when metrics fails", async () => {
    stub.metricsFailure = new TypeError("network down");
    stub.page = { items: [ROW], nextCursor: null };
    const out = await render();
    expect(out).toContain("Dashboard tiles are unavailable");
    expect(out).toContain("sanitary fixture installation");
  });
});

describe("AC#2 — grouped is the default and never asks for the whole 6,673-row table", () => {
  it("defaults to the grouped view", async () => {
    await render();
    expect(stub.listCalls[0]).toMatchObject({ limit: 100 });
  });

  it("groups rows by trade_family into an expandable <details> per group", async () => {
    stub.page = {
      items: [ROW, { ...ROW, id: "c-2", normalized_phrase: "pipe fitting" }],
      nextCursor: null,
    };
    const out = await render();
    expect(out).toContain("<details");
    expect(out).toContain("Plumbers and Pipe Fitters");
    expect(out).toContain("2 candidates on this page");
  });

  it("groups a null trade_family under an honest label, not a blank heading", async () => {
    stub.page = { items: [{ ...ROW, trade_family: null }], nextCursor: null };
    const out = await render();
    expect(out).toContain("Unspecified trade");
  });

  it("switches to the flat view and asks for the smaller default page size", async () => {
    await render({ view: "flat" });
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
    await render();
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
    // falls back to `direct` until the acknowledging click sets `ack=1`.
    expect(stub.listCalls[0]).toMatchObject({ tier: "direct" });
  });

  it("carries the derived filter through to the request once acknowledged", async () => {
    await render({ tier: "derived", ack: "1" });
    expect(stub.listCalls[0]).toMatchObject({ tier: "derived" });
  });

  it("`All tiers` omits the tier filter entirely, and it is not the default tab", async () => {
    const bare = await render();
    const allTiersTag = (bare.match(/<a[^>]*>All tiers<\/a>/) ?? [""])[0];
    expect(allTiersTag).not.toContain("btn--primary");
    expect(stub.listCalls[0]).toMatchObject({ tier: "direct" });

    await render({ tier: "all" });
    expect(stub.listCalls[1]!.tier).toBeUndefined();
  });
});

describe("status scope — an explicit default, never hidden", () => {
  it("sends the two undecided statuses explicitly when nothing is chosen", async () => {
    await render();
    expect(stub.listCalls[0]).toMatchObject({ status: ["pending", "needs_review"] });
  });

  it("held scope sends only `deferred`", async () => {
    await render({ statusScope: "held" });
    expect(stub.listCalls[0]).toMatchObject({ status: ["deferred"] });
  });

  it("decided scope sends the four terminal statuses", async () => {
    await render({ statusScope: "decided" });
    expect(stub.listCalls[0]!.status).toEqual(
      expect.arrayContaining(["approved_create", "approved_map", "approved_merge", "rejected"]),
    );
  });

  it("all scope omits the status filter", async () => {
    await render({ statusScope: "all" });
    expect(stub.listCalls[0]!.status).toBeUndefined();
  });
});

describe("AC#3 — every filter field is reachable", () => {
  it("forwards band, proposedAction, sourceType, tradeFamily, runId, clusterKey, phrase, dates and sort", async () => {
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
});

describe("error states", () => {
  it("a 400 is the operator's filters, not our outage", async () => {
    stub.listFailure = new stub.RequestError(400);
    const out = await render({ tier: "not-a-real-tier" });
    expect(out).toContain("The server rejected this request");
    expect(out).not.toContain("The queue is unavailable");
  });

  it("anything else is our fault, with a retry that repeats the same query", async () => {
    stub.listFailure = new TypeError("network down");
    const out = await render({ tradeFamily: "Welders" });
    expect(out).toContain("The queue is unavailable");
    expect(out).toContain("tradeFamily=Welders");
  });
});

describe("grouped rows link to their own decision screen — a group is a lens, never a merge", () => {
  it("every member links to /skills/discovery/:id and there is no group-level decide button", async () => {
    stub.page = { items: [ROW], nextCursor: null };
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
