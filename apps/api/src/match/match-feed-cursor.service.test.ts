import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_MATCH_CONFIG } from "@badabhai/match-engine";
import type { RequestContext } from "../common/request-context";
import {
  MatchFeedService,
  type MatchFeedContinuation,
  type MatchFeedResume,
} from "./match-feed.service";
import type { MatchFeedKey, MatchFeedRow } from "./match-feed.repository";

/**
 * #1961 / ADR-0052 — paging the V1 deck through the E14 interleave.
 *
 * The repository is replaced by an IN-MEMORY model of `listFeed`: the same ORDER BY
 * (boost DESC, tier ASC, published_at DESC NULLS LAST, id ASC) and the same keyset clause, over
 * a mutable row set. That is what lets these tests page a whole deck and assert the property
 * the cursor exists for — every row served exactly once — through an interleave that DEFERS and
 * PULLS FORWARD rows across page boundaries. `match-feed-order.db` / `feed-cursor.db` pin the
 * real SQL to the same order.
 */

const WORKER = "11111111-1111-4111-8111-111111111111";
const CTX: RequestContext = { correlationId: "c-1961", requestId: "r-1961" };
const PAYER_A = "aaaaaaaa-0000-4000-8000-00000000000a";
const PAYER_B = "bbbbbbbb-0000-4000-8000-00000000000b";
const PAYER_C = "cccccccc-0000-4000-8000-00000000000c";

const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;

function row(n: number, payerKey: string, over: Partial<MatchFeedRow> = {}): MatchFeedRow {
  // Newest first by n: row 1 is the newest. Microsecond keys so two rows can share a millisecond.
  const micros = 1_000_000 - n * 7;
  const key = `2099-01-01T00:00:00.${String(micros).padStart(6, "0").slice(-6)}Z`;
  return {
    jobPostingId: id(n),
    payerKey,
    matchTier: 1,
    matchedSkillId: "mskill_vmc_operator",
    boosted: false,
    publishedAt: new Date(key),
    publishedKey: key,
    roleTitle: "VMC Operator",
    city: "Pune",
    area: null,
    minExperienceYears: null,
    maxExperienceYears: null,
    description: null,
    benefits: null,
    requirements: null,
    payMin: null,
    payMax: null,
    payType: null,
    shift: null,
    neededBy: null,
    roleKind: null,
    ...over,
  };
}

/** The repository's ORDER BY as a comparator. */
function compare(a: MatchFeedKey, b: MatchFeedKey): number {
  if (a.boosted !== b.boosted) return a.boosted ? -1 : 1;
  if (a.matchTier !== b.matchTier) return a.matchTier - b.matchTier;
  if (a.publishedKey !== b.publishedKey) {
    if (a.publishedKey === null) return 1; // NULLS LAST
    if (b.publishedKey === null) return -1;
    return a.publishedKey > b.publishedKey ? -1 : 1; // DESC
  }
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

const keyOf = (r: MatchFeedRow): MatchFeedKey => ({
  boosted: r.boosted,
  matchTier: r.matchTier,
  publishedKey: r.publishedKey,
  id: r.jobPostingId,
});

function setup(initial: MatchFeedRow[], maxConsecutiveSameCompany = 2) {
  const deck = { rows: [...initial] };
  const repo = {
    listFeed: vi.fn(async (_w: string, limit: number, _f: unknown, after?: MatchFeedKey) =>
      [...deck.rows]
        .sort((a, b) => compare(keyOf(a), keyOf(b)))
        .filter((r) => after === undefined || compare(keyOf(r), after) > 0)
        .slice(0, limit),
    ),
  };
  const config = {
    get: vi.fn(async () => ({ ...DEFAULT_MATCH_CONFIG, maxConsecutiveSameCompany })),
  };
  const events = { emitMany: vi.fn(async (l: unknown[]) => l) };
  const svc = new MatchFeedService(repo as never, config as never, events as never);
  return { svc, repo, events, deck };
}

type Svc = ReturnType<typeof setup>["svc"];

/** Follow `next` to the end; every page's ids, and every page's ranks. */
async function pageAll(svc: Svc, limit: number) {
  const pages: string[][] = [];
  const ranks: number[][] = [];
  let continuation: MatchFeedContinuation | undefined;
  for (let guard = 0; guard < 100; guard += 1) {
    const out = await svc.getFeed(WORKER, limit, {}, CTX, continuation);
    pages.push(out.jobs.map((j) => j.job_id));
    ranks.push(out.jobs.map((j) => j.rank));
    if (out.next === null) return { pages, ranks };
    continuation = {
      resume: out.next,
      rankOffset: (continuation?.rankOffset ?? 0) + out.jobs.length,
    };
  }
  throw new Error("paging did not terminate");
}

/** A deck the interleave has to rework: one company dominates the head, two trail it. */
function runHeavyDeck(): MatchFeedRow[] {
  const rows: MatchFeedRow[] = [];
  for (let n = 1; n <= 40; n += 1) {
    const payer = n <= 18 ? PAYER_A : n % 3 === 0 ? PAYER_C : n % 2 ? PAYER_A : PAYER_B;
    rows.push(row(n, payer, n % 5 === 0 ? { matchTier: 2 } : {}));
  }
  rows.push(row(41, PAYER_B, { boosted: true }), row(42, PAYER_A, { boosted: true }));
  rows.push(row(43, PAYER_C, { publishedAt: null, publishedKey: null }));
  rows.push(row(44, PAYER_C, { publishedAt: null, publishedKey: null, matchTier: 2 }));
  return rows;
}

describe("MatchFeedService paging (#1961) — every row exactly once, through the interleave", () => {
  it.each([1, 3, 4, 7, 10, 50])(
    "limit %i: pages concatenate to the whole deck, no duplicate and no gap",
    async (limit) => {
      const rows = runHeavyDeck();
      const { svc } = setup(rows);
      const { pages } = await pageAll(svc, limit);
      const served = pages.flat();
      expect(new Set(served).size).toBe(served.length); // no duplicate
      expect(new Set(served)).toEqual(new Set(rows.map((r) => r.jobPostingId))); // no gap
      for (const page of pages.slice(0, -1)) expect(page.length).toBe(limit);
    },
  );

  it("the first page is exactly the pre-cursor page: same read, same interleave, same cards", async () => {
    const rows = runHeavyDeck();
    const a = setup(rows);
    const b = setup(rows);
    const viaGetFeed = await a.svc.getFeed(WORKER, 10, {}, CTX);
    const viaComposePage = await b.svc.composePage(WORKER, 10, {});
    expect(viaGetFeed.jobs.map((j) => j.job_id)).toEqual(viaComposePage.map((r) => r.jobPostingId));
    // The read is the three-argument call it always was — no keyset clause on page one.
    expect(a.repo.listFeed).toHaveBeenCalledWith(WORKER, 30, {});
    expect(a.repo.listFeed.mock.calls[0]).toHaveLength(3);
  });

  it("actually exercises pull-forward: some cursor carries an ahead set", async () => {
    const { svc } = setup(runHeavyDeck());
    const aheadSizes: number[] = [];
    let continuation: MatchFeedContinuation | undefined;
    for (;;) {
      const out = await svc.getFeed(WORKER, 6, {}, CTX, continuation);
      if (out.next === null) break;
      aheadSizes.push(out.next.ahead.length);
      continuation = { resume: out.next, rankOffset: 0 };
    }
    // Vacuity guard: without a deferred row, the frontier logic would never be tested.
    expect(Math.max(...aheadSizes)).toBeGreaterThan(0);
  });

  it("rank and feed.shown_v2 rank continue across pages: 1..N with no restart", async () => {
    const rows = runHeavyDeck();
    const { svc, events } = setup(rows);
    const { ranks } = await pageAll(svc, 7);
    const all = ranks.flat();
    expect(all).toEqual(Array.from({ length: rows.length }, (_, i) => i + 1));
    const emitted = events.emitMany.mock.calls.flatMap(([list]) =>
      (list as Array<{ payload: { rank: number } }>).map((e) => e.payload.rank),
    );
    expect(emitted).toEqual(all);
  });

  it("an exhausted deck returns next = null; an empty deck is null on the first page", async () => {
    expect((await setup([]).svc.getFeed(WORKER, 5, {}, CTX)).next).toBeNull();
    const small = setup([row(1, PAYER_A), row(2, PAYER_B)]);
    expect((await small.svc.getFeed(WORKER, 5, {}, CTX)).next).toBeNull();
  });
});

describe("MatchFeedService paging — the deck changes between two page reads", () => {
  it("a boost that EXPIRES after its card was served re-serves that card (never errors, never skips)", async () => {
    const rows = runHeavyDeck();
    const { svc, deck } = setup(rows);
    const first = await svc.getFeed(WORKER, 4, {}, CTX);
    const boostedServed = first.jobs
      .map((j) => j.job_id)
      .filter((j) => j === id(41) || j === id(42));
    expect(boostedServed.length).toBeGreaterThan(0); // vacuity: a boosted card was on page 1

    // Both boosts expire before page 2.
    deck.rows = deck.rows.map((r) => (r.boosted ? { ...r, boosted: false } : r));

    let continuation: MatchFeedContinuation = { resume: first.next!, rankOffset: 4 };
    const after: string[] = [];
    for (;;) {
      const out = await svc.getFeed(WORKER, 4, {}, CTX, continuation);
      after.push(...out.jobs.map((j) => j.job_id));
      if (out.next === null) break;
      continuation = { resume: out.next, rankOffset: 0 };
    }
    const served = [...first.jobs.map((j) => j.job_id), ...after];
    // Nothing is lost...
    expect(new Set(served)).toEqual(new Set(rows.map((r) => r.jobPostingId)));
    // ...and the only repeats are the cards whose boost changed.
    const repeats = served.filter((j, i) => served.indexOf(j) !== i);
    for (const r of repeats) expect(boostedServed).toContain(r);
  });

  it("an applied card leaves the deck between pages without moving the cursor's position", async () => {
    const rows = runHeavyDeck();
    const { svc, deck } = setup(rows);
    const first = await svc.getFeed(WORKER, 5, {}, CTX);
    const firstIds = first.jobs.map((j) => j.job_id);
    // He applies to a card on page 1 and to one he has not reached yet (e.g. via search).
    const gone = [firstIds[0]!, id(30)];
    deck.rows = deck.rows.filter((r) => !gone.includes(r.jobPostingId));

    const served = [...firstIds];
    let continuation: MatchFeedContinuation = { resume: first.next!, rankOffset: 5 };
    for (;;) {
      const out = await svc.getFeed(WORKER, 5, {}, CTX, continuation);
      served.push(...out.jobs.map((j) => j.job_id));
      if (out.next === null) break;
      continuation = { resume: out.next, rankOffset: 0 };
    }
    expect(new Set(served).size).toBe(served.length);
    const expected = new Set(rows.map((r) => r.jobPostingId));
    expected.delete(id(30));
    expect(new Set(served)).toEqual(expected);
  });
});

describe("composeFrom — the frontier and the ahead set", () => {
  it("a deferred row holds the frontier back, and the pulled-forward row rides in `ahead`", async () => {
    // A A A B: max 2 per company, page of 3 → A A B served, the third A deferred.
    const rows = [row(1, PAYER_A), row(2, PAYER_A), row(3, PAYER_A), row(4, PAYER_B)];
    const { svc } = setup(rows);
    const page = await svc.composeFrom(WORKER, 3, {});
    expect(page.rows.map((r) => r.jobPostingId)).toEqual([id(1), id(2), id(4)]);
    const next = page.next as MatchFeedResume;
    expect(next.after.id).toBe(id(2)); // the last row of the fully-served prefix
    expect(next.ahead).toEqual([id(4)]); // served beyond it

    const second = await svc.composeFrom(WORKER, 3, {}, next);
    expect(second.rows.map((r) => r.jobPostingId)).toEqual([id(3)]); // the deferred row, once
    expect(second.next).toBeNull();
  });
});
