import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { NotFoundException } from "@nestjs/common";
import { JobsService } from "./jobs.service";
import type { JobsRepository, WorkerVisibleJobRow } from "./jobs.repository";
import type { EventsService } from "../events/events.service";
import type { RequestContext } from "../common/request-context";
import { JobSearchQuerySchema } from "./jobs.dto";

const JOB_ID = "22222222-2222-4222-8222-222222222222";
const WORKER_ID = "11111111-1111-4111-8111-111111111111";
const CTX = { correlationId: "c-1", requestId: "r-1" } as RequestContext;

/** A fully-populated worker-visible row (every SHOW field carries a value). */
const FULL_ROW: WorkerVisibleJobRow = {
  id: JOB_ID,
  tradeKey: "cnc_operator",
  title: "CNC Operator — Night Shift",
  city: "Pune",
  area: "Pimpri-Chinchwad",
  payMin: 18000,
  payMax: 25000,
  minExperienceYears: 2,
  maxExperienceYears: 5,
  neededBy: "immediate",
  shift: "night",
  description: "Operate and set Fanuc-control machines on the night line.",
  benefits: ["PF + ESI", "Canteen"],
  requirements: ["Fanuc control", "ITI / Diploma"],
};

function setup(row: unknown, searchResult: { rows: unknown[]; hasMore: boolean } = { rows: [], hasMore: false }) {
  const repo = {
    findWorkerVisibleJobById: vi.fn(async () => row),
    // The arg is DECLARED so `.mock.calls[0][0]` is typed — an argless `vi.fn` infers a
    // zero-length tuple and the call-args assertions below stop compiling.
    searchOpenPostings: vi.fn(async (_args: Record<string, unknown>) => searchResult),
  };
  // #822 — search emits `job.search_performed`; the detail read still emits nothing, and the
  // existing tests below assert exactly that against this same double.
  const events = { emit: vi.fn(async (p: unknown) => p) };
  const svc = new JobsService(repo as unknown as JobsRepository, events as unknown as EventsService);
  return { svc, repo, events };
}

describe("JobsService.getWorkerVisibleJob — neutral 404 (no oracle)", () => {
  it("404s with EXACTLY 'Job not found' on an unknown id, and emits NO event", async () => {
    const { svc, events } = setup(undefined);
    const err = await svc.getWorkerVisibleJob(JOB_ID).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotFoundException);
    // NEUTRAL: no id echo (XB-A/F-3 precedent, cf. AgencyService.getOwnJob).
    expect((err as NotFoundException).message).toBe("Job not found");
    // ADR-0024 final addendum §"Event ruling": the detail read emits NO event.
    //
    // ASSERTED ON BEHAVIOUR, not on constructor arity. This used to read
    // `expect(JobsService.length).toBe(1)` — "no EventsService seam exists in this module" —
    // which was a true and cheap guarantee right up until #822 gave the module a route that
    // legitimately needs one. The ruling it protects is about THIS read, not about the class,
    // so the assertion now says that: the emitter is present and injected, and this path
    // still does not call it.
    expect(events.emit).not.toHaveBeenCalled();
  });

  it("a CLOSED job is byte-identical to an unknown one (the repo's status='open' WHERE folds both)", async () => {
    // The repository returns `undefined` for a closed row exactly as for an
    // unknown id (status='open' is IN the WHERE) — so the service sees the SAME
    // input and must produce the SAME error, byte for byte.
    const unknownErr = (await setup(undefined)
      .svc.getWorkerVisibleJob(JOB_ID)
      .catch((e: unknown) => e)) as NotFoundException;
    const closedErr = (await setup(undefined)
      .svc.getWorkerVisibleJob(JOB_ID)
      .catch((e: unknown) => e)) as NotFoundException;
    expect(closedErr.message).toBe(unknownErr.message);
    expect(JSON.stringify(closedErr.getResponse())).toBe(JSON.stringify(unknownErr.getResponse()));
    expect(closedErr.getStatus()).toBe(unknownErr.getStatus());
  });
});

describe("JobsService.getWorkerVisibleJob — the ADR-0024 SHOW projection", () => {
  it("returns EVERY contract field, mapped snake_case, values intact", async () => {
    const { svc, repo } = setup(FULL_ROW);
    const out = await svc.getWorkerVisibleJob(JOB_ID);
    expect(repo.findWorkerVisibleJobById).toHaveBeenCalledExactlyOnceWith(JOB_ID);
    expect(out).toEqual({
      job_id: JOB_ID,
      trade_key: "cnc_operator",
      title: "CNC Operator — Night Shift",
      city: "Pune",
      area: "Pimpri-Chinchwad",
      pay_min: 18000,
      pay_max: 25000,
      min_experience_years: 2,
      max_experience_years: 5,
      needed_by: "immediate",
      shift: "night",
      description: "Operate and set Fanuc-control machines on the night line.",
      benefits: ["PF + ESI", "Canteen"],
      requirements: ["Fanuc control", "ITI / Diploma"],
    });
  });

  it("passes nulls through HONESTLY on every nullable field (absent data, never fabricated)", async () => {
    const bare: WorkerVisibleJobRow = {
      id: JOB_ID,
      tradeKey: "fitter",
      title: "Fitter",
      city: "Rajkot",
      area: null,
      payMin: null,
      payMax: null,
      minExperienceYears: null,
      maxExperienceYears: null,
      neededBy: null,
      shift: null,
      description: null,
      benefits: null,
      requirements: null,
    };
    const { svc } = setup(bare);
    const out = await svc.getWorkerVisibleJob(JOB_ID);
    expect(out).toEqual({
      job_id: JOB_ID,
      trade_key: "fitter",
      title: "Fitter",
      city: "Rajkot",
      area: null,
      pay_min: null,
      pay_max: null,
      min_experience_years: null,
      max_experience_years: null,
      needed_by: null,
      shift: null,
      description: null,
      benefits: null,
      requirements: null,
    });
  });

  it("V1 posting: a NULL trade_key is passed through (job_postings carries role_title only)", async () => {
    // ADR-0036: the feed serves `job_postings`, so a tapped/applied job id is a
    // POSTING id and the repo's fallback returns a row with NO trade_key/area/
    // experience/benefits/requirements (postings don't store them). The service
    // must surface `trade_key: null` honestly — never invent a trade — so the
    // detail screen shows the posting's real title/city/pay/shift/description.
    const posting: WorkerVisibleJobRow = {
      id: JOB_ID,
      tradeKey: null,
      title: "CNC Operator",
      city: "Pune",
      area: null,
      payMin: 20000,
      payMax: 28000,
      minExperienceYears: null,
      maxExperienceYears: null,
      neededBy: "immediate",
      shift: "day",
      description: "Run VMC/CNC on the day line.",
      benefits: null,
      requirements: null,
    };
    const { svc } = setup(posting);
    const out = await svc.getWorkerVisibleJob(JOB_ID);
    expect(out.trade_key).toBeNull();
    expect(out).toEqual({
      job_id: JOB_ID,
      trade_key: null,
      title: "CNC Operator",
      city: "Pune",
      area: null,
      pay_min: 20000,
      pay_max: 28000,
      min_experience_years: null,
      max_experience_years: null,
      needed_by: "immediate",
      shift: "day",
      description: "Run VMC/CNC on the day line.",
      benefits: null,
      requirements: null,
    });
  });

  it("PROJECTION: the serialized response never contains payer/payer_id/applicants/status keys", async () => {
    // Belt-and-braces: even if the repo (hypothetically) leaked the hidden
    // columns, the service's EXPLICIT field-by-field mapping drops them — the
    // ADR-0024 HIDE set can never ride this response.
    const leakyRow = {
      ...FULL_ROW,
      payerId: "99999999-9999-4999-8999-999999999999",
      status: "open",
      applicantsReceived: 7,
    };
    const { svc } = setup(leakyRow);
    const out = await svc.getWorkerVisibleJob(JOB_ID);
    const json = JSON.stringify(out);
    for (const forbidden of ["payer", "payer_id", "applicants", "status"]) {
      expect(json, `response must not contain "${forbidden}"`).not.toContain(forbidden);
    }
  });
});

/**
 * #822 — GET /jobs/search. The discovery surface, distinct from the personalized feed.
 */
describe("JobsService.searchJobs", () => {
  const HIT = {
    id: JOB_ID,
    title: "CNC Operator",
    city: "Pune",
    state: "Maharashtra",
    payMin: 20000,
    payMax: 35000,
    shift: "day" as const,
    publishedAt: new Date("2026-08-01T00:00:00.000Z"),
  };
  const q = (over: Record<string, unknown> = {}) => JobSearchQuerySchema.parse(over);

  it("maps a posting to the wire contract, with honest nulls for what a posting lacks", async () => {
    const { svc } = setup(undefined, { rows: [HIT], hasMore: false });
    const res = await svc.searchJobs(WORKER_ID, q(), CTX);
    expect(res.jobs[0]).toEqual({
      job_id: JOB_ID,
      title: "CNC Operator",
      city: "Pune",
      state: "Maharashtra",
      // `area` and the experience window live on the legacy `jobs` table only — null, never
      // invented, exactly as the detail read already answers for a V1 posting.
      area: null,
      pay_min: 20000,
      pay_max: 35000,
      shift: "day",
      min_experience_years: null,
      max_experience_years: null,
      matched_skill_label: null,
      published_at: "2026-08-01T00:00:00.000Z",
    });
  });

  it("NEVER leaks employer identity — no org label, payer id, or location_label", async () => {
    // ADR-0024: employer identity stays off the worker path ENTIRELY. The projection is
    // explicit in the repository; this asserts the SERVICE cannot widen it.
    const { svc } = setup(undefined, {
      rows: [{ ...HIT, orgLabel: "Sharma Precision Pvt Ltd", payerId: "payer-1" }],
      hasMore: false,
    });
    const res = await svc.searchJobs(WORKER_ID, q(), CTX);
    const wire = JSON.stringify(res);
    expect(wire).not.toContain("Sharma Precision");
    expect(wire).not.toContain("payer-1");
    expect(Object.keys(res.jobs[0]!)).not.toContain("orgLabel");
  });

  it("derives offset from the 1-based page and passes the filters through verbatim", async () => {
    const { svc, repo } = setup(undefined);
    await svc.searchJobs(WORKER_ID, q({ q: "welder", city: "pun", state: "MH", limit: 10, page: 3 }), CTX);
    expect(repo.searchOpenPostings).toHaveBeenCalledWith({
      workerId: WORKER_ID,
      q: "welder",
      city: "pun",
      state: "MH",
      limit: 10,
      offset: 20,
    });
  });

  it("a blank or whitespace-only q is ABSENT, not a term", async () => {
    // `ILIKE '%%'` would match everything while claiming a query ran, flattening the relevance
    // ladder and lying to the event. Absent is the honest state.
    const { svc, repo } = setup(undefined);
    await svc.searchJobs(WORKER_ID, q({ q: "   " }), CTX);
    expect(repo.searchOpenPostings.mock.calls[0]![0]).toMatchObject({ q: null });
  });

  it("emits job.search_performed carrying the SHAPE of the search and NEVER the query text", async () => {
    // §2 — the events table is exactly where raw PII must not land, and `q` is unbounded
    // worker free text that can hold a name or a phone number.
    const { svc, events } = setup(undefined, { rows: [HIT], hasMore: true });
    await svc.searchJobs(WORKER_ID, q({ q: "ravi 9876543210", city: "Pune", limit: 20, page: 2 }), CTX);

    const emitted = events.emit.mock.calls[0]![0] as { event_name: string; payload: Record<string, unknown> };
    expect(emitted.event_name).toBe("job.search_performed");
    expect(emitted.payload).toMatchObject({
      worker_id: WORKER_ID,
      has_query: true,
      query_length: "ravi 9876543210".length,
      city_filtered: true,
      state_filtered: false,
      result_count: 1,
      page: 2,
      limit: 20,
    });
    // The term itself, in any form, must not be anywhere in the row.
    const serialized = JSON.stringify(emitted);
    expect(serialized).not.toContain("ravi");
    expect(serialized).not.toContain("9876543210");
  });

  it("a failed emit does NOT fail the search", async () => {
    // Results are already computed and correct; 500-ing a good page over an analytics write
    // trades a working feature for a telemetry one.
    const { svc, events } = setup(undefined, { rows: [HIT], hasMore: false });
    events.emit.mockRejectedValueOnce(new Error("events table unreachable"));
    const res = await svc.searchJobs(WORKER_ID, q(), CTX);
    expect(res.jobs).toHaveLength(1);
  });

  it("reports has_more from the repository's limit+1 probe, not a guess", async () => {
    const { svc } = setup(undefined, { rows: [HIT], hasMore: true });
    expect((await svc.searchJobs(WORKER_ID, q(), CTX)).has_more).toBe(true);
  });

  it("a null published_at serializes as null, not as an invented date", async () => {
    const { svc } = setup(undefined, { rows: [{ ...HIT, publishedAt: null }], hasMore: false });
    expect((await svc.searchJobs(WORKER_ID, q(), CTX)).jobs[0]!.published_at).toBeNull();
  });
});

describe("JobSearchQuerySchema — bounds", () => {
  it("defaults to page 1 / limit 20 with no parameters at all", () => {
    expect(JobSearchQuerySchema.parse({})).toMatchObject({ page: 1, limit: 20 });
  });

  it("caps limit at 50 and rejects page 0 — no unbounded worker-facing list", () => {
    expect(JobSearchQuerySchema.safeParse({ limit: 500 }).success).toBe(false);
    expect(JobSearchQuerySchema.safeParse({ page: 0 }).success).toBe(false);
  });

  it("seeds NOTHING from the worker's profile — an absent filter stays absent", () => {
    // ADR-0036 Part 3: "Every default is wide or off. Defaults that narrow are a volume leak."
    const parsed = JobSearchQuerySchema.parse({});
    expect(parsed.q).toBeUndefined();
    expect(parsed.city).toBeUndefined();
    expect(parsed.state).toBeUndefined();
  });
});
