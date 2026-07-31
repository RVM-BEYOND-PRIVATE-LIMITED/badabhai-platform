import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { DEFAULT_MATCH_CONFIG, type MatchConfig } from "@badabhai/match-engine";
import type { RequestContext } from "../common/request-context";
import { MatchFeedService } from "./match-feed.service";
import type { MatchFeedRow } from "./match-feed.repository";

/**
 * MOMENT ④ — the worker feed (ADR-0036 §2/§6, E14/E18).
 *
 * Everything here is asserted on VALUES the service produced, not on the fact that a
 * collaborator was called. The three properties that would silently ruin the surface if
 * they broke:
 *
 *   1. the max-per-company rule is a PERMUTATION — a presentation rule that reorders and
 *      never drops or duplicates a job. A "rule" that quietly loses cards is a supply
 *      leak nobody would see in a screenshot;
 *   2. one `feed.shown_v2` per SHOWN card — the overfetched rows the worker never saw
 *      must not enter the audit spine as impressions (invariant #1 is about a TRUE
 *      audit, not a loud one);
 *   3. the card never carries the company key the interleave runs on (the open
 *      org_label privacy question in ADR-0036 stays open).
 */

const WORKER = "11111111-1111-4111-8111-111111111111";
const CTX: RequestContext = {
  correlationId: "22222222-2222-4222-8222-222222222222",
  requestId: "req-feed-1",
};

const PAYER_A = "aaaaaaaa-0000-4000-8000-00000000000a";
const PAYER_B = "bbbbbbbb-0000-4000-8000-00000000000b";
const PAYER_C = "cccccccc-0000-4000-8000-00000000000c";

/** A posting row exactly as `MatchFeedRepository.listFeed` hands it over. */
function row(id: string, payerKey: string, over: Partial<MatchFeedRow> = {}): MatchFeedRow {
  return {
    jobPostingId: id,
    payerKey,
    matchTier: 1,
    matchedSkillId: "mskill_vmc_operator",
    boosted: false,
    publishedAt: new Date("2026-07-30T10:00:00.000Z"),
    roleTitle: "VMC Operator",
    city: "Pune",
    payMin: 18000,
    payMax: 25000,
    shift: "day",
    neededBy: null,
    ...over,
  };
}

type EmittedFeedEvent = {
  event_name: string;
  actor: { actor_type: string; actor_id: string };
  subject: { subject_type: string; subject_id: string };
  payload: {
    worker_id: string;
    job_posting_id: string;
    rank: number;
    match_tier: number;
    boosted: boolean;
    matched_skill_id: string;
  };
  correlationId: string;
  requestId: string;
};

function setup(rows: MatchFeedRow[], cfg: Partial<MatchConfig> = {}) {
  const repo = { listFeed: vi.fn(async () => rows) };
  const config = { get: vi.fn(async () => ({ ...DEFAULT_MATCH_CONFIG, ...cfg })) };
  const emitted: EmittedFeedEvent[][] = [];
  const events = {
    emitMany: vi.fn(async (list: EmittedFeedEvent[]) => {
      emitted.push(list);
      return list;
    }),
  };
  const svc = new MatchFeedService(repo as never, config as never, events as never);
  /** Every event emitted across all batches, flattened. */
  const allEvents = () => emitted.flat();
  return { svc, repo, config, events, allEvents };
}

const companies = (jobs: { job_id: string }[], rows: MatchFeedRow[]) =>
  jobs.map((j) => rows.find((r) => r.jobPostingId === j.job_id)!.payerKey);

/** Longest run of identical consecutive entries — what the max-N rule bounds. */
function longestRun(keys: string[]): number {
  let best = 0;
  let run = 0;
  let prev: string | null = null;
  for (const k of keys) {
    run = k === prev ? run + 1 : 1;
    prev = k;
    if (run > best) best = run;
  }
  return best;
}

describe("MatchFeedService — overfetch is what gives the interleave material", () => {
  it("reads 3x the page and returns EXACTLY the page", async () => {
    // 30 candidates back, 10 asked for: the rule needs the extra 20 to have anywhere to
    // move a card TO, but the worker must still get 10.
    const rows = Array.from({ length: 30 }, (_, i) => row(`job-${i}`, i % 2 ? PAYER_A : PAYER_B));
    const { svc, repo } = setup(rows);

    const out = await svc.getFeed(WORKER, 10, {}, CTX);

    expect(repo.listFeed).toHaveBeenCalledWith(WORKER, 30, {});
    expect(out.jobs).toHaveLength(10);
  });

  it("caps the overfetch, so a huge `limit` cannot become an unbounded scan", async () => {
    const { svc, repo } = setup([]);
    // 500 * 3 = 1500 rows would be a table scan dressed as a feed request.
    await svc.getFeed(WORKER, 500, {}, CTX);
    expect(repo.listFeed).toHaveBeenCalledWith(WORKER, 300, {});
  });

  it("hands the worker's own filters through untouched (a dropped filter is a wrong feed)", async () => {
    const { svc, repo } = setup([]);
    const filters = { city: "Pune", shift: "night", payMin: 20000 };
    await svc.getFeed(WORKER, 10, filters, CTX);
    expect(repo.listFeed).toHaveBeenCalledWith(WORKER, 30, filters);
  });
});

describe("MatchFeedService — E14: max-2-per-company is a PERMUTATION, not a filter", () => {
  // Six cards, three companies, arriving fully clustered — the worst case the rule exists
  // for, and the shape a real "one factory posted eight jobs this morning" feed has.
  const CLUSTERED = [
    row("a1", PAYER_A),
    row("a2", PAYER_A),
    row("a3", PAYER_A),
    row("b1", PAYER_B),
    row("b2", PAYER_B),
    row("c1", PAYER_C),
  ];

  it("never drops or duplicates a job (the output is the same multiset)", async () => {
    const { svc } = setup(CLUSTERED);
    const out = await svc.getFeed(WORKER, 6, {}, CTX);

    // A presentation rule that loses a card is a supply leak that looks like nothing.
    expect(out.jobs.map((j) => j.job_id).sort()).toEqual(
      CLUSTERED.map((r) => r.jobPostingId).sort(),
    );
    expect(new Set(out.jobs.map((j) => j.job_id)).size).toBe(6);
  });

  it("actually REORDERS a clustered feed (the rule is not a pass-through)", async () => {
    const { svc } = setup(CLUSTERED);
    const out = await svc.getFeed(WORKER, 6, {}, CTX);
    expect(out.jobs.map((j) => j.job_id)).not.toEqual(CLUSTERED.map((r) => r.jobPostingId));
  });

  it("leaves NO THREE consecutive cards from one company (default max = 2)", async () => {
    const { svc } = setup(CLUSTERED);
    const out = await svc.getFeed(WORKER, 6, {}, CTX);
    expect(longestRun(companies(out.jobs, CLUSTERED))).toBeLessThanOrEqual(2);
  });

  it("honours a TIGHTER config (max 1 => no two in a row), so the knob is real", async () => {
    const { svc } = setup(CLUSTERED, { maxConsecutiveSameCompany: 1 });
    const out = await svc.getFeed(WORKER, 6, {}, CTX);
    expect(longestRun(companies(out.jobs, CLUSTERED))).toBe(1);
  });

  it("preserves each company's INTERNAL order (a stable permutation, not a shuffle)", async () => {
    const { svc } = setup(CLUSTERED);
    const out = await svc.getFeed(WORKER, 6, {}, CTX);
    // Within one company the SQL's boost/recency order is the only order there is —
    // the interleave may move a card later, never above its own company's earlier card.
    const aOrder = out.jobs.map((j) => j.job_id).filter((id) => id.startsWith("a"));
    expect(aOrder).toEqual(["a1", "a2", "a3"]);
  });

  it("degrades honestly when one company is all there is (no drops, original order)", async () => {
    const only = [row("a1", PAYER_A), row("a2", PAYER_A), row("a3", PAYER_A)];
    const { svc } = setup(only);
    const out = await svc.getFeed(WORKER, 3, {}, CTX);
    // The rule cannot conjure a second employer; padding or truncating here would be
    // the feed lying about supply.
    expect(out.jobs.map((j) => j.job_id)).toEqual(["a1", "a2", "a3"]);
  });
});

describe("MatchFeedService — ranks and the feed.shown_v2 audit line up", () => {
  const ROWS = [
    row("a1", PAYER_A, { matchTier: 1, boosted: true }),
    row("a2", PAYER_A, { matchTier: 2 }),
    row("b1", PAYER_B, { matchTier: 2, matchedSkillId: "mskill_cnc_turner" }),
  ];

  it("numbers the page 1..n in the order the worker actually sees", async () => {
    const { svc } = setup(ROWS);
    const out = await svc.getFeed(WORKER, 3, {}, CTX);
    expect(out.jobs.map((j) => j.rank)).toEqual([1, 2, 3]);
  });

  it("emits ONE event per SHOWN card — never for the overfetched rows", async () => {
    // 12 candidates read, 4 shown. Emitting 12 would put 8 impressions in the audit
    // spine for cards no worker ever saw, and the LEARN corpus would inherit the lie.
    const rows = Array.from({ length: 12 }, (_, i) => row(`job-${i}`, i % 2 ? PAYER_A : PAYER_B));
    const { svc, allEvents } = setup(rows);

    const out = await svc.getFeed(WORKER, 4, {}, CTX);

    expect(out.jobs).toHaveLength(4);
    expect(allEvents()).toHaveLength(4);
    expect(allEvents().map((e) => e.payload.job_posting_id)).toEqual(
      out.jobs.map((j) => j.job_id),
    );
  });

  it("stamps each event with the card's OWN rank and posting id (post-interleave)", async () => {
    const { svc, allEvents } = setup(ROWS);
    const out = await svc.getFeed(WORKER, 3, {}, CTX);

    // If the events were built from the pre-interleave order, rank 2 would name a
    // different job than the card at position 2 — and every downstream funnel metric
    // would be attributed to the wrong posting.
    for (const [i, card] of out.jobs.entries()) {
      expect(allEvents()[i]!.payload).toMatchObject({
        worker_id: WORKER,
        job_posting_id: card.job_id,
        rank: card.rank,
      });
    }
    expect(allEvents().map((e) => e.payload.rank)).toEqual([1, 2, 3]);
  });

  it("carries the row's REAL match_tier / boosted / matched_skill_id into the payload", async () => {
    const { svc, allEvents } = setup([row("a1", PAYER_A, { matchTier: 2, boosted: true })]);
    await svc.getFeed(WORKER, 5, {}, CTX);

    expect(allEvents()[0]).toMatchObject({
      event_name: "feed.shown_v2",
      actor: { actor_type: "worker", actor_id: WORKER },
      subject: { subject_type: "job_posting", subject_id: "a1" },
      correlationId: CTX.correlationId,
      requestId: CTX.requestId,
    });
    expect(allEvents()[0]!.payload).toMatchObject({
      match_tier: 2,
      boosted: true,
      matched_skill_id: "mskill_vmc_operator",
    });
  });

  it("emits NOTHING for an empty feed (no empty batch write)", async () => {
    const { svc, events } = setup([]);
    const out = await svc.getFeed(WORKER, 10, {}, CTX);
    expect(out.jobs).toEqual([]);
    expect(events.emitMany).not.toHaveBeenCalled();
  });
});

describe("MatchFeedService — E18 related badge and the honest null", () => {
  it("flags a tier-2 card as via_related and a tier-1 card as not", async () => {
    const { svc } = setup([row("a1", PAYER_A, { matchTier: 2 }), row("b1", PAYER_B)]);
    const out = await svc.getFeed(WORKER, 5, {}, CTX);

    const byId = new Map(out.jobs.map((j) => [j.job_id, j]));
    expect(byId.get("a1")!.via_related).toBe(true);
    expect(byId.get("b1")!.via_related).toBe(false);
  });

  it("resolves the matched skill to its LABEL, not its id", async () => {
    const { svc } = setup([row("a1", PAYER_A, { matchedSkillId: "mskill_cnc_turner" })]);
    const out = await svc.getFeed(WORKER, 5, {}, CTX);
    expect(out.jobs[0]!.matched_skill_label).toBe("CNC Turner");
  });

  it("returns NULL for a skill id outside the closed set (the card hides the line)", async () => {
    // The card must not invent a reason. An id the taxonomy does not know is a data bug;
    // rendering "mskill_forklift_xyz" or a prettified guess to a worker sells him a
    // match nobody curated.
    const { svc } = setup([row("a1", PAYER_A, { matchedSkillId: "mskill_not_a_real_skill" })]);
    const out = await svc.getFeed(WORKER, 5, {}, CTX);

    expect(out.jobs[0]!.matched_skill_label).toBeNull();
    // ...and the id still reaches the audit trail, so the bad row is findable.
    expect(out.jobs[0]!.trade_key).toBe("mskill_not_a_real_skill");
  });
});

describe("MatchFeedService — the card stays faceless (ADR-0036 open org_label question)", () => {
  it("never leaks the company key the interleave runs on", async () => {
    const rows = [row("a1", PAYER_A), row("a2", PAYER_A), row("b1", PAYER_B)];
    const { svc, allEvents } = setup(rows);

    const out = await svc.getFeed(WORKER, 5, {}, CTX);

    // `payerKey` is `payer_id`/`created_by`. It is the interleave key and nothing else:
    // whether company identity may render on a worker card is still an open ADR-0036
    // question awaiting security sign-off, so it must not arrive by accident.
    const serialized = JSON.stringify({ out, events: allEvents() });
    expect(serialized).not.toContain(PAYER_A);
    expect(serialized).not.toContain(PAYER_B);
  });

  it("returns the legacy card keys and nothing more", async () => {
    const { svc } = setup([row("a1", PAYER_A)]);
    const out = await svc.getFeed(WORKER, 5, {}, CTX);
    expect(Object.keys(out.jobs[0]!).sort()).toEqual(
      [
        "area",
        "city",
        "job_id",
        "matched_skill_label",
        "max_experience_years",
        "min_experience_years",
        "pay_max",
        "pay_min",
        "rank",
        "shift",
        "title",
        "trade_key",
        "via_related",
      ].sort(),
    );
  });

  it("renders a missing city as the empty string and never fabricates an area/band", async () => {
    const { svc } = setup([row("a1", PAYER_A, { city: null })]);
    const out = await svc.getFeed(WORKER, 5, {}, CTX);

    const card = out.jobs[0]!;
    expect(card.city).toBe("");
    // `area` and the experience window do not exist on `job_postings`. Deriving them
    // from `location_label` would put payer free text on a worker card.
    expect(card.area).toBeNull();
    expect(card.min_experience_years).toBeNull();
    expect(card.max_experience_years).toBeNull();
  });
});
