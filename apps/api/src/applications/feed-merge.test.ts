import { describe, expect, it } from "vitest";
import type { FeedJob, FeedPostingRow } from "./applications.repository";
import {
  mergeNewestFirst,
  rankFeed,
  toSourcedFromJob,
  toSourcedFromPosting,
  type FeedSource,
  type SourcedFeedItem,
} from "./feed-merge";

/**
 * #1823 (ADR-0049) — the pure half of the interim union feed: the card mapping per source and
 * the newest-first merge of the two arms. No database, no Nest; everything here is a value.
 */

/**
 * The 17 keys a shipped client parses, plus the additive `role_kind` (owner ruling 2026-10-05).
 * The e2e exact-keys pin says the same of the wire.
 */
const FEED_ITEM_KEYS = [
  "area",
  "benefits",
  "city",
  "description",
  "job_id",
  "max_experience_years",
  "min_experience_years",
  "needed_by",
  "pay_max",
  "pay_min",
  "pay_type",
  "posted_at",
  "rank",
  "requirements",
  "role_kind",
  "shift",
  "title",
  "trade_key",
];

function sourced(source: FeedSource, id: string, iso: string): SourcedFeedItem {
  return {
    source,
    postedAt: new Date(iso),
    card: {
      job_id: id,
      trade_key: "",
      title: id,
      city: "",
      area: null,
      min_experience_years: null,
      max_experience_years: null,
      pay_min: null,
      pay_max: null,
      pay_type: null,
      shift: null,
      description: null,
      benefits: null,
      requirements: null,
      needed_by: null,
      posted_at: iso,
      role_kind: null,
    },
  };
}

const job = (id: string, iso: string) => sourced("job", id, iso);
const posting = (id: string, iso: string) => sourced("job_posting", id, iso);
const ids = (items: readonly SourcedFeedItem[]) => items.map((i) => i.card.job_id);

describe("mergeNewestFirst — one total order across both tables", () => {
  it("interleaves the two arms newest-first", () => {
    const jobs = [job("j1", "2026-10-05T00:00:00Z"), job("j2", "2026-10-02T00:00:00Z")];
    const postings = [
      posting("p1", "2026-10-06T00:00:00Z"),
      posting("p2", "2026-10-03T00:00:00Z"),
      posting("p3", "2026-10-01T00:00:00Z"),
    ];
    expect(ids(mergeNewestFirst(jobs, postings, 50))).toEqual(["p1", "j1", "p2", "j2", "p3"]);
  });

  it("on an equal posted_at falls back to id ASC, then a job before a posting", () => {
    const at = "2026-10-01T00:00:00Z";
    const a = "00000000-0000-4000-8000-00000000000a";
    const b = "00000000-0000-4000-8000-00000000000b";
    // id ASC decides across sources whichever arm holds the smaller id…
    expect(ids(mergeNewestFirst([job(b, at)], [posting(a, at)], 50))).toEqual([a, b]);
    expect(ids(mergeNewestFirst([job(a, at)], [posting(b, at)], 50))).toEqual([a, b]);
    // …and only an identical id (a cross-table v4 collision) falls through to the source.
    const tied = mergeNewestFirst([job(a, at)], [posting(a, at)], 50);
    expect(tied.map((i) => i.source)).toEqual(["job", "job_posting"]);
  });

  it("preserves each arm's own order verbatim — it compares heads, never re-sorts an arm", () => {
    // Postgres orders by MICROSECONDS; a JavaScript Date keeps milliseconds. These two rows
    // read as the same millisecond here but SQL put `z` first, and that order must survive
    // even though a re-sort by (posted_at, id) would put `a` first.
    const sameMs = "2026-10-01T00:00:00.123Z";
    const jobs = [job("z", sameMs), job("a", sameMs)];
    const postings = [posting("m", sameMs)];
    // Heads only: `m` beats the head `z` on id, then the jobs arm drains IN ITS OWN ORDER.
    // A full re-sort would have produced [a, m, z].
    expect(ids(mergeNewestFirst(jobs, postings, 50))).toEqual(["m", "z", "a"]);
    const reversed = [posting("y", sameMs), posting("b", sameMs)];
    expect(ids(mergeNewestFirst([], reversed, 50))).toEqual(["y", "b"]);
  });

  it("truncates to the limit — the merged page is ONE shared budget", () => {
    const jobs = [job("j1", "2026-10-05T00:00:00Z"), job("j2", "2026-10-03T00:00:00Z")];
    const postings = [posting("p1", "2026-10-04T00:00:00Z"), posting("p2", "2026-10-02T00:00:00Z")];
    expect(ids(mergeNewestFirst(jobs, postings, 3))).toEqual(["j1", "p1", "j2"]);
    expect(mergeNewestFirst(jobs, postings, 0)).toEqual([]);
  });

  it("handles empty arms on either side, and both", () => {
    const jobs = [job("j1", "2026-10-05T00:00:00Z")];
    const postings = [posting("p1", "2026-10-04T00:00:00Z")];
    expect(ids(mergeNewestFirst(jobs, [], 50))).toEqual(["j1"]);
    expect(ids(mergeNewestFirst([], postings, 50))).toEqual(["p1"]);
    expect(mergeNewestFirst([], [], 50)).toEqual([]);
  });

  it("does not mutate its inputs", () => {
    const jobs = [job("j1", "2026-10-01T00:00:00Z"), job("j2", "2026-09-01T00:00:00Z")];
    const postings = [posting("p1", "2026-10-02T00:00:00Z")];
    const before = JSON.stringify({ jobs, postings });
    mergeNewestFirst(Object.freeze([...jobs]), Object.freeze([...postings]), 1);
    mergeNewestFirst(jobs, postings, 50);
    expect(JSON.stringify({ jobs, postings })).toBe(before);
  });
});

describe("rankFeed — rank is the 1-based position in the deck as served", () => {
  it("numbers the merged deck 1..n and keeps each card's source", () => {
    const merged = mergeNewestFirst(
      [job("j1", "2026-10-01T00:00:00Z")],
      [posting("p1", "2026-10-02T00:00:00Z")],
      50,
    );
    const ranked = rankFeed(merged);
    expect(ranked.map((r) => [r.source, r.item.job_id, r.item.rank])).toEqual([
      ["job_posting", "p1", 1],
      ["job", "j1", 2],
    ]);
    // The source tag is NOT on the card — it only chooses the event envelope.
    for (const r of ranked) expect(Object.keys(r.item).sort()).toEqual(FEED_ITEM_KEYS);
  });
});

describe("toSourcedFromJob — the legacy mapping, unchanged", () => {
  const JOB: FeedJob = {
    id: "a0000000-0000-0000-0000-000000000001",
    tradeKey: "cnc_operator",
    title: "T1",
    city: "Pune",
    area: "PCMC",
    minExperienceYears: 2,
    maxExperienceYears: null,
    payMin: 18000,
    payMax: 25000,
    payType: "in_hand",
    shift: "night",
    description: "D1",
    benefits: ["B1"],
    requirements: ["R1"],
    neededBy: "immediate",
    roleKind: "cnc_turner",
    createdAt: new Date("2026-06-01T00:00:00.000Z"),
  };

  it("passes every column through verbatim, with posted_at from created_at", () => {
    const out = toSourcedFromJob(JOB);
    expect(out.source).toBe("job");
    expect(out.postedAt).toBe(JOB.createdAt);
    expect(out.card).toEqual({
      job_id: JOB.id,
      trade_key: "cnc_operator",
      title: "T1",
      city: "Pune",
      area: "PCMC",
      min_experience_years: 2,
      max_experience_years: null,
      pay_min: 18000,
      pay_max: 25000,
      pay_type: "in_hand",
      shift: "night",
      description: "D1",
      benefits: ["B1"],
      requirements: ["R1"],
      needed_by: "immediate",
      posted_at: "2026-06-01T00:00:00.000Z",
      role_kind: "cnc_turner",
    });
  });

  it("fails role_kind closed to null on anything outside the declared set", () => {
    for (const roleKind of ["cnc_operator", "Welder", "", null]) {
      expect(toSourcedFromJob({ ...JOB, roleKind }).card.role_kind).toBeNull();
    }
  });
});

describe("toSourcedFromPosting — a company posting on the same keys as a jobs card", () => {
  const ROW: FeedPostingRow = {
    id: "b0000000-0000-4000-8000-000000000001",
    roleTitle: "VMC Operator",
    city: "Faridabad",
    area: "Sector 24",
    minExperienceYears: 1,
    maxExperienceYears: 4,
    payMin: 16000,
    payMax: 22000,
    payType: "ctc",
    shift: "day",
    description: "Fanuc VMC chalana.",
    benefits: ["PF + ESI"],
    requirements: ["Fanuc control"],
    neededBy: "soon",
    roleKind: "vmc_milling",
    publishedAt: new Date("2026-10-01T09:30:00.000Z"),
  };

  it("maps every card field verbatim: title = role_title, posted_at = published_at", () => {
    const out = toSourcedFromPosting(ROW);
    expect(out).not.toBeNull();
    expect(out!.source).toBe("job_posting");
    expect(out!.postedAt).toBe(ROW.publishedAt);
    expect(out!.card).toEqual({
      job_id: ROW.id,
      trade_key: "",
      title: "VMC Operator",
      city: "Faridabad",
      area: "Sector 24",
      min_experience_years: 1,
      max_experience_years: 4,
      pay_min: 16000,
      pay_max: 22000,
      pay_type: "ctc",
      shift: "day",
      description: "Fanuc VMC chalana.",
      benefits: ["PF + ESI"],
      requirements: ["Fanuc control"],
      needed_by: "soon",
      posted_at: "2026-10-01T09:30:00.000Z",
      role_kind: "vmc_milling",
    });
  });

  it("fails role_kind closed to null on anything outside the declared set", () => {
    for (const roleKind of ["mskill_vmc_operator", "VMC_MILLING", " ", null]) {
      expect(toSourcedFromPosting({ ...ROW, roleKind })!.card.role_kind).toBeNull();
    }
  });

  it('sends trade_key "" — never a skill id, never a role — and city "" when the posting has none', () => {
    const out = toSourcedFromPosting({ ...ROW, city: null })!;
    expect(out.card.trade_key).toBe("");
    expect(out.card.city).toBe("");
  });

  it("passes every other null through un-coerced (the honest-nulls doctrine)", () => {
    const out = toSourcedFromPosting({
      ...ROW,
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
    })!;
    for (const key of [
      "area",
      "min_experience_years",
      "max_experience_years",
      "pay_min",
      "pay_max",
      "pay_type",
      "shift",
      "description",
      "benefits",
      "requirements",
      "needed_by",
    ] as const) {
      expect(out.card[key], key).toBeNull();
    }
  });

  it("returns NULL for a row with no published_at — a card with no honest date is dropped", () => {
    expect(toSourcedFromPosting({ ...ROW, publishedAt: null })).toBeNull();
  });
});
