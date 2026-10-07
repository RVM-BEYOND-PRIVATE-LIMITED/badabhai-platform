import "reflect-metadata";
import { BadRequestException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import type { RequestContext } from "../common/request-context";
import type { EventsService } from "../events/events.service";
import type { MatchFeedResume } from "../match/match-feed.service";
import { ApplicationsService, type FeedPage } from "./applications.service";
import type {
  ApplicationsRepository,
  FeedJobRow,
  FeedPostingKeyedRow,
} from "./applications.repository";
import { decodeFeedCursor, encodeFeedCursor, type FeedCursor } from "./feed-cursor";
import type { PostedKeysetPosition } from "./feed-keyset.predicates";
import { mergeNewestFirst, toSourcedFromJob, toSourcedFromPosting } from "./feed-merge";

/**
 * #1961 / ADR-0052 — `GET /feed` paging on the legacy paths (jobs alone, and the ADR-0049
 * union), plus the V1 hand-off.
 *
 * Both repository reads are replaced by IN-MEMORY models of their SQL: `posted_at DESC, id ASC`
 * over microsecond keys, with the keyset clause. The fixtures put cards from the two arms
 * inside ONE millisecond, in an order the merge's millisecond comparator and a single
 * microsecond keyset disagree on — the case that makes a single merged key lose a card, and
 * the reason the union cursor is per arm.
 */

const CTX: RequestContext = { correlationId: "c-1961", requestId: "r-1961" };
const WORKER = "11111111-1111-4111-8111-111111111111";

const uuid = (prefix: string, n: number) =>
  `${prefix}0000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;

/** A microsecond key on 2099-01-01. `ms`/`us` pick the millisecond and the micro inside it. */
const key = (ms: number, us = 0) =>
  `2099-01-01T00:00:${String(Math.floor(ms / 1000)).padStart(2, "0")}.${String(ms % 1000).padStart(3, "0")}${String(us).padStart(3, "0")}Z`;

function job(n: number, postedKey: string): FeedJobRow {
  return {
    id: uuid("a", n),
    tradeKey: "cnc_operator",
    title: `Job ${n}`,
    city: "Pune",
    area: null,
    minExperienceYears: null,
    maxExperienceYears: null,
    payMin: null,
    payMax: null,
    payType: null,
    shift: null,
    description: null,
    benefits: null,
    requirements: null,
    neededBy: null,
    roleKind: null,
    createdAt: new Date(postedKey),
    postedKey,
  };
}

function posting(n: number, postedKey: string): FeedPostingKeyedRow {
  return {
    id: uuid("b", n),
    roleTitle: `Posting ${n}`,
    city: null,
    area: null,
    minExperienceYears: null,
    maxExperienceYears: null,
    payMin: null,
    payMax: null,
    payType: null,
    shift: null,
    description: null,
    benefits: null,
    requirements: null,
    neededBy: null,
    roleKind: null,
    publishedAt: new Date(postedKey),
    postedKey,
  };
}

/** `posted_at DESC, id ASC` and the keyset clause, as the SQL evaluates them. */
function readArm<T extends { id: string; postedKey: string }>(
  rows: readonly T[],
  limit: number,
  after?: PostedKeysetPosition,
): T[] {
  const cmp = (a: { postedKey: string; id: string }, b: { postedKey: string; id: string }) =>
    a.postedKey !== b.postedKey
      ? a.postedKey > b.postedKey
        ? -1
        : 1
      : a.id === b.id
        ? 0
        : a.id < b.id
          ? -1
          : 1;
  return [...rows]
    .sort(cmp)
    .filter((r) => after === undefined || cmp(r, { postedKey: after.postedKey, id: after.id }) > 0)
    .slice(0, limit);
}

function setup(
  opts: {
    jobs?: FeedJobRow[];
    postings?: FeedPostingKeyedRow[];
    union?: boolean;
    v1?: boolean;
  } = {},
) {
  const repo = {
    findOpenJobs: vi.fn(
      async (_w: string, limit: number, _f: unknown, after?: PostedKeysetPosition) =>
        readArm(opts.jobs ?? [], limit, after),
    ),
    findOpenPostingsForFeed: vi.fn(
      async (_w: string, limit: number, _f: unknown, after?: PostedKeysetPosition) =>
        readArm(opts.postings ?? [], limit, after),
    ),
  };
  const events = {
    emit: vi.fn(async (p: unknown) => p),
    emitMany: vi.fn(async (l: unknown[]) => l),
  };
  const v1Next: MatchFeedResume = {
    after: { boosted: true, matchTier: 2, publishedKey: null, id: uuid("c", 1) },
    ahead: Array.from({ length: 60 }, (_, i) => uuid("c", 100 + i)),
  };
  const matchFeed = {
    getFeed: vi.fn(async () => ({
      jobs: [{ job_id: uuid("c", 9), rank: 1 }],
      next: v1Next,
    })),
  };
  const svc = new ApplicationsService(
    repo as unknown as ApplicationsRepository,
    events as unknown as EventsService,
    matchFeed as never,
    {} as never,
    {
      MATCH_V1_ENABLED: opts.v1 ?? false,
      FEED_POSTINGS_UNION_ENABLED: opts.union ?? false,
    } as never,
    { listWantedSkillIds: vi.fn(async () => []) } as never,
  );
  return { svc, repo, events, matchFeed, v1Next };
}

type Svc = ReturnType<typeof setup>["svc"];

const cursorOf = (page: FeedPage): FeedCursor | undefined =>
  page.next_cursor === null ? undefined : decodeFeedCursor(page.next_cursor)!;

async function pageAll(svc: Svc, limit: number) {
  const pages: FeedPage[] = [];
  let cursor: FeedCursor | undefined;
  for (let guard = 0; guard < 200; guard += 1) {
    const page = await svc.getFeed(WORKER, limit, {}, CTX, cursor);
    pages.push(page);
    if (page.next_cursor === null) return pages;
    cursor = cursorOf(page);
    expect(cursor, "a minted cursor always decodes").toBeDefined();
  }
  throw new Error("paging did not terminate");
}

const ids = (pages: FeedPage[]) => pages.flatMap((p) => p.jobs.map((j) => j.job_id));
const ranks = (pages: FeedPage[]) => pages.flatMap((p) => p.jobs.map((j) => j.rank));

/** 17 jobs and 13 postings; exact ties, and cross-arm pairs inside one millisecond. */
function fixtures() {
  const jobs: FeedJobRow[] = [];
  const postings: FeedPostingKeyedRow[] = [];
  for (let i = 0; i < 17; i += 1) jobs.push(job(i, key(50_000 - i * 1000, i % 3 === 0 ? 500 : 0)));
  for (let i = 0; i < 13; i += 1) postings.push(posting(i, key(50_000 - i * 1300, 700)));
  // Exact ties inside one arm: only `id ASC` orders them.
  jobs.push(job(100, key(20_000)), job(101, key(20_000)), job(102, key(20_000)));
  // The disagreeing pair: same millisecond; the posting is NEWER by microseconds, but its id
  // sorts after the job's, so the millisecond merge serves the job first.
  jobs.push(job(200, key(10_000, 100)));
  postings.push(posting(200, key(10_000, 900)));
  return { jobs, postings };
}

describe("legacy /feed paging (union off) — keyset on (posted_at DESC, id ASC)", () => {
  it.each([1, 2, 5, 7, 50])(
    "limit %i: pages concatenate to the single full read",
    async (limit) => {
      const { jobs } = fixtures();
      const { svc } = setup({ jobs });
      const pages = await pageAll(svc, limit);
      expect(ids(pages)).toEqual(readArm(jobs, 10_000).map((j) => j.id));
      expect(ranks(pages)).toEqual(Array.from({ length: jobs.length }, (_, i) => i + 1));
    },
  );

  it("no cursor: the read is the pre-cursor call and the page is unchanged", async () => {
    const { jobs } = fixtures();
    const { svc, repo } = setup({ jobs });
    const page = await svc.getFeed(WORKER, 5, {}, CTX);
    expect(repo.findOpenJobs.mock.calls[0]).toHaveLength(3);
    expect(page.jobs.map((j) => j.job_id)).toEqual(readArm(jobs, 5).map((j) => j.id));
    expect(page.jobs.map((j) => j.rank)).toEqual([1, 2, 3, 4, 5]);
  });

  it("the cursor carries the last card's MICROSECOND key, not its millisecond `posted_at`", async () => {
    const { jobs } = fixtures();
    const { svc, repo } = setup({ jobs });
    const page = await svc.getFeed(WORKER, 1, {}, CTX);
    const cursor = cursorOf(page);
    expect(cursor).toMatchObject({ m: "jobs", o: 1, j: { t: key(50_000, 500), id: uuid("a", 0) } });
    await svc.getFeed(WORKER, 1, {}, CTX, cursor);
    expect(repo.findOpenJobs.mock.calls[1]![3]).toEqual({
      postedKey: key(50_000, 500),
      id: uuid("a", 0),
    });
  });

  it("a short page is the end (null); a deck of exactly `limit` ends with one empty page", async () => {
    const { svc } = setup({ jobs: [job(1, key(1000)), job(2, key(900))] });
    expect((await svc.getFeed(WORKER, 5, {}, CTX)).next_cursor).toBeNull();
    const exact = await pageAll(svc, 2);
    expect(exact.map((p) => p.jobs.length)).toEqual([2, 0]);
    expect(exact.at(-1)!.next_cursor).toBeNull();
    expect((await setup().svc.getFeed(WORKER, 5, {}, CTX)).next_cursor).toBeNull();
  });

  it("feed.shown: one per card served on THAT page, rank = position in the deck", async () => {
    const { jobs } = fixtures();
    const { svc, events } = setup({ jobs });
    const first = await svc.getFeed(WORKER, 4, {}, CTX);
    await svc.getFeed(WORKER, 4, {}, CTX, cursorOf(first));
    expect(events.emitMany).toHaveBeenCalledTimes(2);
    const second = events.emitMany.mock.calls[1]![0] as Array<{
      event_name: string;
      payload: { rank: number; job_id: string };
    }>;
    expect(second.map((e) => e.event_name)).toEqual(Array(4).fill("feed.shown"));
    expect(second.map((e) => e.payload.rank)).toEqual([5, 6, 7, 8]);
  });

  it("an empty follow-on page emits nothing", async () => {
    const { svc, events } = setup({ jobs: [job(1, key(1000))] });
    const cursor: FeedCursor = { v: 1, m: "jobs", o: 1, j: { t: key(1000), id: uuid("a", 1) } };
    const page = await svc.getFeed(WORKER, 5, {}, CTX, cursor);
    expect(page).toEqual({ jobs: [], next_cursor: null });
    expect(events.emitMany).not.toHaveBeenCalled();
  });
});

describe("union /feed paging — both arms resume after their OWN last served card", () => {
  it.each([1, 2, 3, 5, 8, 50])(
    "limit %i: pages concatenate to the full merged deck, no duplicate and no gap",
    async (limit) => {
      const { jobs, postings } = fixtures();
      const { svc } = setup({ jobs, postings, union: true });
      const pages = await pageAll(svc, limit);
      const full = mergeNewestFirst(
        readArm(jobs, 10_000).map(toSourcedFromJob),
        readArm(postings, 10_000).map((p) => toSourcedFromPosting(p)!),
        10_000,
      ).map((s) => s.card.job_id);
      expect(ids(pages)).toEqual(full);
      expect(ranks(pages)).toEqual(full.map((_, i) => i + 1));
    },
  );

  it("vacuity: the fixture's same-millisecond pair is merged against its microsecond order", async () => {
    const { jobs, postings } = fixtures();
    const { svc } = setup({ jobs, postings, union: true });
    const served = ids(await pageAll(svc, 50));
    // The job (older by microseconds) is served before the posting (newer): a single merged
    // keyset at the job's key would have put the posting BEHIND the cursor — a lost card.
    expect(served.indexOf(uuid("a", 200))).toBeLessThan(served.indexOf(uuid("b", 200)));
  });

  it("an arm that served nothing on a page keeps its previous position (or none)", async () => {
    const { svc, repo } = setup({
      jobs: [job(1, key(1000)), job(2, key(900))],
      postings: [posting(1, key(5000)), posting(2, key(4000)), posting(3, key(10))],
      union: true,
    });
    const first = await svc.getFeed(WORKER, 2, {}, CTX);
    expect(first.jobs.map((j) => j.job_id)).toEqual([uuid("b", 1), uuid("b", 2)]);
    const cursor = cursorOf(first);
    expect(cursor).toMatchObject({ m: "union", o: 2, j: null, p: { id: uuid("b", 2) } });

    await svc.getFeed(WORKER, 2, {}, CTX, cursor);
    // The jobs arm, having served nothing, is read from its head; the posting arm resumes.
    expect(repo.findOpenJobs.mock.calls[1]).toHaveLength(3);
    expect(repo.findOpenPostingsForFeed.mock.calls[1]![3]).toEqual({
      postedKey: key(4000),
      id: uuid("b", 2),
    });
  });

  it("no cursor: both reads are the pre-cursor calls", async () => {
    const { jobs, postings } = fixtures();
    const { svc, repo } = setup({ jobs, postings, union: true });
    await svc.getFeed(WORKER, 5, {}, CTX);
    expect(repo.findOpenJobs.mock.calls[0]).toHaveLength(3);
    expect(repo.findOpenPostingsForFeed.mock.calls[0]).toHaveLength(3);
  });
});

describe("a cursor from another feed order is a 400, never a guess", () => {
  const JOBS: FeedCursor = { v: 1, m: "jobs", o: 5, j: { t: key(1000), id: uuid("a", 1) } };
  const UNION: FeedCursor = {
    v: 1,
    m: "union",
    o: 5,
    j: null,
    p: { t: key(1000), id: uuid("b", 1) },
  };
  const V1: FeedCursor = {
    v: 1,
    m: "v1",
    o: 5,
    k: { b: false, r: 1, t: null, id: uuid("b", 1) },
    a: [],
  };

  it.each([
    ["a union cursor on the jobs-only feed", { union: false }, UNION],
    ["a v1 cursor on the jobs-only feed", { union: false }, V1],
    ["a jobs cursor on the union feed", { union: true }, JOBS],
    ["a jobs cursor on the V1 feed", { v1: true }, JOBS],
    ["a union cursor on the V1 feed", { v1: true }, UNION],
  ])("%s", async (_why, flags, cursor) => {
    const { svc, repo, matchFeed, events } = setup(flags);
    const err = await svc.getFeed(WORKER, 5, {}, CTX, cursor).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect((err as BadRequestException).getResponse()).toMatchObject({
      issues: [{ path: "cursor" }],
    });
    expect(repo.findOpenJobs).not.toHaveBeenCalled();
    expect(matchFeed.getFeed).not.toHaveBeenCalled();
    expect(events.emitMany).not.toHaveBeenCalled();
  });
});

describe("V1 /feed — the cursor is translated, the deck logic stays in MatchFeedService", () => {
  it("first page: the pre-cursor four-argument call, and the resume point encoded", async () => {
    const { svc, matchFeed, v1Next } = setup({ v1: true });
    const page = await svc.getFeed(WORKER, 50, { city: "Pune" }, CTX);
    expect(matchFeed.getFeed).toHaveBeenCalledWith(
      WORKER,
      50,
      { city: "Pune", shift: undefined, payMin: undefined },
      CTX,
    );
    const cursor = cursorOf(page);
    expect(cursor).toEqual({
      v: 1,
      m: "v1",
      o: 1,
      k: { b: true, r: 2, t: null, id: v1Next.after.id },
      // Capped at the page size; the dropped ids can only be re-served, never skipped.
      a: v1Next.ahead.slice(0, 50),
    });
  });

  it("follow-on page: the decoded resume point and the served count are handed over", async () => {
    const { svc, matchFeed } = setup({ v1: true });
    const cursor: FeedCursor = {
      v: 1,
      m: "v1",
      o: 50,
      k: { b: false, r: 1, t: key(1000, 1), id: uuid("c", 2) },
      a: [uuid("c", 3)],
    };
    const page = await svc.getFeed(WORKER, 50, {}, CTX, cursor);
    expect(matchFeed.getFeed.mock.calls[0]).toEqual([
      WORKER,
      50,
      { city: undefined, shift: undefined, payMin: undefined },
      CTX,
      {
        resume: {
          after: { boosted: false, matchTier: 1, publishedKey: key(1000, 1), id: uuid("c", 2) },
          ahead: [uuid("c", 3)],
        },
        rankOffset: 50,
      },
    ]);
    expect(cursorOf(page)?.o).toBe(51);
  });

  it("the deck's end is next_cursor null", async () => {
    const { svc, matchFeed } = setup({ v1: true });
    matchFeed.getFeed.mockResolvedValueOnce({ jobs: [], next: null as never });
    expect(await svc.getFeed(WORKER, 50, {}, CTX)).toEqual({ jobs: [], next_cursor: null });
  });

  it("encodes to the wire form the DTO accepts", async () => {
    const { svc } = setup({ v1: true });
    const page = await svc.getFeed(WORKER, 50, {}, CTX);
    expect(encodeFeedCursor(cursorOf(page)!)).toBe(page.next_cursor);
  });
});
