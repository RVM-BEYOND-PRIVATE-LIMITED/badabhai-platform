import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import type { RequestContext } from "../common/request-context";
import type { EventsService } from "../events/events.service";
import { ApplicationsService } from "./applications.service";
import type { ApplicationsRepository, FeedPostingRow } from "./applications.repository";

/**
 * #1823 (ADR-0049) — `GET /feed` WITH THE INTERIM UNION ARMED (MATCH_V1 off).
 *
 * Two arms, one deck: the UNCHANGED agency/seed `jobs` read and the company `job_postings`
 * read, merged newest-first into one ≤limit page. The card stays the 17 legacy keys and
 * every card emits one `feed.shown` v1 whose ENVELOPE says which table its id is in.
 */

const CTX: RequestContext = { correlationId: "corr-1", requestId: "req-1" };
const WORKER = "11111111-1111-4111-8111-111111111111";

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
  "shift",
  "title",
  "trade_key",
];

const JOB_NEW = {
  id: "a0000000-0000-4000-8000-000000000001",
  tradeKey: "cnc_operator",
  title: "CNC Operator",
  city: "Pune",
  area: "PCMC",
  minExperienceYears: 2,
  maxExperienceYears: 5,
  payMin: 18000,
  payMax: 25000,
  payType: "in_hand",
  shift: "night",
  description: "D1",
  benefits: ["B1"],
  requirements: ["R1"],
  neededBy: "immediate",
  createdAt: new Date("2026-10-03T00:00:00.000Z"),
};
const JOB_OLD = {
  ...JOB_NEW,
  id: "a0000000-0000-4000-8000-000000000002",
  createdAt: new Date("2026-09-01T00:00:00.000Z"),
};

const POSTING_NEWEST: FeedPostingRow = {
  id: "b0000000-0000-4000-8000-000000000001",
  roleTitle: "VMC Operator",
  city: null,
  area: "Sector 24",
  minExperienceYears: null,
  maxExperienceYears: 3,
  payMin: 16000,
  payMax: null,
  payType: "ctc",
  shift: null,
  description: "Fanuc VMC chalana.",
  benefits: null,
  requirements: ["Fanuc control"],
  neededBy: "soon",
  publishedAt: new Date("2026-10-05T09:30:00.000Z"),
};
const POSTING_MIDDLE: FeedPostingRow = {
  ...POSTING_NEWEST,
  id: "b0000000-0000-4000-8000-000000000002",
  city: "Faridabad",
  publishedAt: new Date("2026-09-15T00:00:00.000Z"),
};

function setup(
  opts: {
    jobs?: unknown[];
    postings?: FeedPostingRow[];
    wanted?: string[];
    union?: boolean;
    matchV1?: boolean;
  } = {},
) {
  const repo = {
    findOpenJobs: vi.fn(
      async (_w: string, _l: number, _f: Record<string, unknown>) =>
        opts.jobs ?? [JOB_NEW, JOB_OLD],
    ),
    findOpenPostingsForFeed: vi.fn(
      async (_w: string, _l: number, _f: Record<string, unknown>) =>
        opts.postings ?? [POSTING_NEWEST, POSTING_MIDDLE],
    ),
  };
  const events = {
    emit: vi.fn(async (p: Record<string, unknown>) => p),
    emitMany: vi.fn(async (l: Array<Record<string, unknown>>) => l),
  };
  const matchFeed = { getFeed: vi.fn(async () => ({ jobs: [] })) };
  const workerSkills = {
    listWantedSkillIds: vi.fn(async () => opts.wanted ?? ["mskill_vmc_operator"]),
  };
  const svc = new ApplicationsService(
    repo as unknown as ApplicationsRepository,
    events as unknown as EventsService,
    matchFeed as never,
    {} as never,
    {
      MATCH_V1_ENABLED: opts.matchV1 ?? false,
      FEED_POSTINGS_UNION_ENABLED: opts.union ?? true,
    } as never,
    workerSkills as never,
  );
  return { svc, repo, events, matchFeed, workerSkills };
}

type Card = Record<string, unknown>;
const cardsOf = (out: { jobs: unknown[] }) => out.jobs as Card[];
const batchOf = (events: ReturnType<typeof setup>["events"]) =>
  events.emitMany.mock.calls[0]![0] as Array<Record<string, any>>;

describe("union feed — both arms, one newest-first deck", () => {
  it("reads both arms and merges them by posted_at, ranking the deck 1..n", async () => {
    const { svc, repo, workerSkills } = setup();
    const out = await svc.getFeed(WORKER, 20, {}, CTX);

    expect(repo.findOpenJobs).toHaveBeenCalledOnce();
    expect(workerSkills.listWantedSkillIds).toHaveBeenCalledExactlyOnceWith(WORKER);
    expect(repo.findOpenPostingsForFeed).toHaveBeenCalledOnce();
    expect(cardsOf(out).map((c) => c.job_id)).toEqual([
      POSTING_NEWEST.id, // 2026-10-05
      JOB_NEW.id, // 2026-10-03
      POSTING_MIDDLE.id, // 2026-09-15
      JOB_OLD.id, // 2026-09-01
    ]);
    expect(cardsOf(out).map((c) => c.rank)).toEqual([1, 2, 3, 4]);
  });

  it("caps the merged deck at `limit` — one shared page, both arms asked for `limit`", async () => {
    const { svc, repo } = setup();
    const out = await svc.getFeed(WORKER, 3, {}, CTX);
    expect(cardsOf(out)).toHaveLength(3);
    expect(repo.findOpenJobs.mock.calls[0]![1]).toBe(3);
    expect(repo.findOpenPostingsForFeed.mock.calls[0]![1]).toBe(3);
  });

  it("every card carries EXACTLY the 17 legacy keys — no role_kind, no source, no V1 extras", async () => {
    const { svc } = setup();
    const out = await svc.getFeed(WORKER, 20, {}, CTX);
    expect(cardsOf(out).length).toBeGreaterThan(0); // vacuity guard
    for (const card of cardsOf(out)) {
      expect(Object.keys(card).sort()).toEqual(FEED_ITEM_KEYS);
      for (const extra of ["role_kind", "via_related", "matched_skill_label", "source"]) {
        expect(card).not.toHaveProperty(extra);
      }
    }
  });

  it('maps a posting: trade_key "", city "" when NULL, title = role_title, posted_at ISO, nulls kept', async () => {
    const { svc } = setup();
    const out = await svc.getFeed(WORKER, 20, {}, CTX);
    const card = cardsOf(out).find((c) => c.job_id === POSTING_NEWEST.id)!;

    expect(card).toEqual({
      job_id: POSTING_NEWEST.id,
      trade_key: "",
      title: "VMC Operator",
      city: "",
      area: "Sector 24",
      min_experience_years: null,
      max_experience_years: 3,
      pay_min: 16000,
      pay_max: null,
      pay_type: "ctc",
      shift: null,
      description: "Fanuc VMC chalana.",
      benefits: null,
      requirements: ["Fanuc control"],
      needed_by: "soon",
      posted_at: "2026-10-05T09:30:00.000Z",
      rank: 1,
    });
    expect(cardsOf(out).find((c) => c.job_id === POSTING_MIDDLE.id)!.city).toBe("Faridabad");
  });

  it("drops (never coerces) a posting row that somehow has no published_at", async () => {
    const { svc } = setup({ postings: [{ ...POSTING_NEWEST, publishedAt: null }, POSTING_MIDDLE] });
    const out = await svc.getFeed(WORKER, 20, {}, CTX);
    expect(cardsOf(out).map((c) => c.job_id)).not.toContain(POSTING_NEWEST.id);
    expect(cardsOf(out).map((c) => c.job_id)).toContain(POSTING_MIDDLE.id);
  });
});

describe("union feed — the posting arm's inputs", () => {
  it("gets the worker's wanted skill ids and city — never trade_key, shift or pay_min", async () => {
    const { svc, repo } = setup({ wanted: ["mskill_vmc_operator", "mskill_cnc_turner"] });
    await svc.getFeed(
      WORKER,
      20,
      { tradeKey: "cnc_operator", city: "Pune", shift: "night", payMin: 20000 },
      CTX,
    );

    const [workerId, , postingFilters] = repo.findOpenPostingsForFeed.mock.calls[0]!;
    expect(workerId).toBe(WORKER);
    expect(postingFilters).toEqual({
      city: "Pune",
      wantedSkillIds: ["mskill_vmc_operator", "mskill_cnc_turner"],
    });
    // The jobs arm still gets exactly what it got before the union existed.
    expect(repo.findOpenJobs).toHaveBeenCalledWith(WORKER, 20, {
      tradeKey: "cnc_operator",
      city: "Pune",
      shift: "night",
      payMin: 20000,
    });
  });

  it("passes an EMPTY wanted set through as-is — the #1240 'unprofiled sees all' case", async () => {
    const { svc, repo } = setup({ wanted: [] });
    await svc.getFeed(WORKER, 20, {}, CTX);
    expect(repo.findOpenPostingsForFeed.mock.calls[0]![2]).toMatchObject({ wantedSkillIds: [] });
  });
});

describe("union feed — feed.shown v1 per card, the envelope names the id space", () => {
  it("emits one feed.shown per card in one batch, payload keys unchanged", async () => {
    const { svc, events } = setup();
    const out = await svc.getFeed(WORKER, 20, {}, CTX);

    expect(events.emitMany).toHaveBeenCalledOnce();
    const batch = batchOf(events);
    expect(batch).toHaveLength(cardsOf(out).length);
    for (const e of batch) {
      expect(e.event_name).toBe("feed.shown");
      expect(Object.keys(e.payload).sort()).toEqual([
        "hot",
        "job_id",
        "rank",
        "score",
        "worker_id",
      ]);
      expect(e.payload).toMatchObject({ worker_id: WORKER, score: 0, hot: false });
      expect(e.actor).toEqual({ actor_type: "worker", actor_id: WORKER });
    }
  });

  it("subjects a jobs card as `job` and a posting card as `job_posting`, rank-for-rank", async () => {
    const { svc, events } = setup();
    await svc.getFeed(WORKER, 20, {}, CTX);
    expect(batchOf(events).map((e) => [e.subject, e.payload.job_id, e.payload.rank])).toEqual([
      [{ subject_type: "job_posting", subject_id: POSTING_NEWEST.id }, POSTING_NEWEST.id, 1],
      [{ subject_type: "job", subject_id: JOB_NEW.id }, JOB_NEW.id, 2],
      [{ subject_type: "job_posting", subject_id: POSTING_MIDDLE.id }, POSTING_MIDDLE.id, 3],
      [{ subject_type: "job", subject_id: JOB_OLD.id }, JOB_OLD.id, 4],
    ]);
  });

  it("never emits feed.shown_v2 — that event requires a reach row", async () => {
    const { svc, events } = setup();
    await svc.getFeed(WORKER, 20, {}, CTX);
    expect(batchOf(events).map((e) => e.event_name)).not.toContain("feed.shown_v2");
    expect(events.emit).not.toHaveBeenCalled();
  });

  it("emits nothing for an empty deck", async () => {
    const { svc, events } = setup({ jobs: [], postings: [] });
    const out = await svc.getFeed(WORKER, 20, {}, CTX);
    expect(out.jobs).toEqual([]);
    expect(events.emitMany).not.toHaveBeenCalled();
  });
});

describe("union feed — fail closed: any rejection fails /feed before a single emit", () => {
  it.each([
    ["the wanted-skills read", "workerSkills.listWantedSkillIds"],
    ["the jobs arm", "repo.findOpenJobs"],
    ["the posting arm", "repo.findOpenPostingsForFeed"],
  ])("%s rejecting rejects the feed and writes no impression", async (_label, which) => {
    const d = setup();
    const boom = new Error("db down");
    if (which === "workerSkills.listWantedSkillIds")
      d.workerSkills.listWantedSkillIds.mockRejectedValueOnce(boom);
    if (which === "repo.findOpenJobs") d.repo.findOpenJobs.mockRejectedValueOnce(boom);
    if (which === "repo.findOpenPostingsForFeed")
      d.repo.findOpenPostingsForFeed.mockRejectedValueOnce(boom);

    await expect(d.svc.getFeed(WORKER, 20, {}, CTX)).rejects.toBe(boom);
    expect(d.events.emitMany).not.toHaveBeenCalled();
    expect(d.events.emit).not.toHaveBeenCalled();
  });
});

describe("union feed — the flags that decide whether it runs at all", () => {
  it("MATCH_V1_ENABLED on: the V1 feed runs and neither union read happens", async () => {
    const { svc, repo, matchFeed, workerSkills } = setup({ matchV1: true });
    await svc.getFeed(WORKER, 20, { city: "Pune" }, CTX);
    expect(matchFeed.getFeed).toHaveBeenCalledOnce();
    expect(repo.findOpenJobs).not.toHaveBeenCalled();
    expect(repo.findOpenPostingsForFeed).not.toHaveBeenCalled();
    expect(workerSkills.listWantedSkillIds).not.toHaveBeenCalled();
  });

  it("union off: the jobs arm alone — no posting read, no skill read, subjects all `job`", async () => {
    const { svc, repo, events, workerSkills } = setup({ union: false });
    const out = await svc.getFeed(WORKER, 20, {}, CTX);
    expect(repo.findOpenPostingsForFeed).not.toHaveBeenCalled();
    expect(workerSkills.listWantedSkillIds).not.toHaveBeenCalled();
    expect(cardsOf(out).map((c) => c.job_id)).toEqual([JOB_NEW.id, JOB_OLD.id]);
    for (const e of batchOf(events)) expect(e.subject.subject_type).toBe("job");
  });
});
