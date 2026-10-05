import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Logger, NotFoundException } from "@nestjs/common";
import type { RequestContext } from "../common/request-context";
import { AllExceptionsFilter } from "../common/filters/all-exceptions.filter";
import { ReachService } from "../reach/reach.service";
import type { JobSignalRow } from "../reach/reach.repository";
import type { WorkerProfileSignalRow } from "../reach/reach.mappers";
import type { ApplicantListResponseDto } from "../reach/reach.dto";
import { JobPostingsService } from "../job-postings/job-postings.service";
import type { MatchCandidateListDto } from "../match/match-candidates.service";
import { PayerApplicantsService } from "./payer-applicants.service";

/**
 * #1823 PR-5 — the payer applicant list's source selection (owner decision O8), and #1898 —
 * an agency's own job lists ONLY the workers who applied to it, whatever MATCH_V1_ENABLED says.
 *
 * The two ownership seams are the REAL services: `ReachService.tryApplicantsForOwnedJob` and
 * `JobPostingsService.getOneForPayer`. Only their repositories are
 * faked, and each fake mirrors its SQL's WHERE — `id = $1 AND payer_id = $2` — so a payer
 * asking for another payer's id gets exactly what the database would give him: nothing. The
 * SQL itself is pinned in reach.repository.test.ts and job-postings.repository.test.ts.
 *
 * Every rejection is also run through the app's real `AllExceptionsFilter`, so "identical 404"
 * and "DB error → 500" are claims about the HTTP response, not about an exception class.
 */

const PAYER_A = "aaaaaaaa-0000-4000-8000-00000000000a";
const PAYER_B = "bbbbbbbb-0000-4000-8000-00000000000b";
/** An agency `jobs` row owned by A. */
const JOB_A = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
/** A company `job_postings` row owned by A. */
const POSTING_A = "1b2c3d4e-5f6a-4b7c-8d9e-0f1a2b3c4d5e";
/** In neither table. */
const UNKNOWN = "2c3d4e5f-6a7b-4c8d-89e0-1f2a3b4c5d6e";
/** In BOTH tables, owned by A in both (the theoretical cross-table uuid collision). */
const TWIN = "3d4e5f6a-7b8c-4d9e-8f01-2a3b4c5d6e7f";

const CTX: RequestContext = {
  correlationId: "22222222-2222-4222-8222-222222222222",
  requestId: "req-1",
};

function signalRow(jobId: string): JobSignalRow {
  return {
    jobId,
    tradeKey: "cnc_milling",
    city: "pune",
    payMin: 18000,
    payMax: 30000,
    minExperienceYears: 1,
    maxExperienceYears: 8,
    neededBy: "immediate",
  };
}

function worker(n: number): WorkerProfileSignalRow {
  return {
    workerId: `33333333-3333-4333-8333-${n.toString(16).padStart(12, "0")}`,
    canonicalRoleId: "vmc_operator",
    canonicalTradeId: "cnc_vmc",
    experience: { total_years: 5 },
    salaryExpectation: { amount_min: 22000, period: "monthly" },
    locationPreference: { preferred_cities: ["pune"] },
    availability: { status: "immediate" },
    updatedAt: new Date("2026-06-10T00:00:00.000Z"),
  };
}

/** The whole eligible pool. Only worker(1) applied to JOB_A; worker(2) skipped it. */
const POOL = [worker(1), worker(2), worker(3)];
const APPLIER = worker(1);

/** The V1 candidate shape `listForPosting` returns; one applicant is enough to tell it apart. */
function candidates(postingId: string): MatchCandidateListDto {
  return {
    jobId: postingId,
    applicants: [
      {
        workerId: worker(9).workerId,
        applicationId: "44444444-4444-4444-8444-444444444444",
        rank: 1,
        matchTier: null,
        effectiveTier: null,
        skillMonths: null,
        industryMonths: null,
        lastWorkedAt: null,
        matchedSkillLabel: null,
        engineVersion: null,
      },
    ],
  };
}

/**
 * The MATCH_V1_ENABLED settings the flag-independence cases run under. The service takes no
 * config at all since #1898; the `describe.each` below proves the result is the same for both.
 */
const FLAG_STATES = [
  { MATCH_V1_ENABLED: false, label: "off" },
  { MATCH_V1_ENABLED: true, label: "on" },
] as const;

function make() {
  // jobs: id → owner. Mirrors `findOwnedJobSignalRowById`'s `id = $1 AND payer_id = $2`.
  const jobsTable = new Map<string, string>([
    [JOB_A, PAYER_A],
    [TWIN, PAYER_A],
  ]);
  // job_postings: id → owner. Mirrors `findByIdAndPayer`'s `id = $1 AND payer_id = $2`.
  const postingsTable = new Map<string, string>([
    [POSTING_A, PAYER_A],
    [TWIN, PAYER_A],
  ]);

  // applications: (job_id, worker_id, action). Mirrors `listApplicantSignalRowsForJob`'s
  // `job_id = $1 AND action = 'applied'` membership over the eligible pool.
  const applicationsTable = [
    { jobId: JOB_A, workerId: APPLIER.workerId, action: "applied" },
    { jobId: JOB_A, workerId: worker(2).workerId, action: "skipped" },
    { jobId: TWIN, workerId: APPLIER.workerId, action: "applied" },
  ];

  const reachRepo = {
    findOwnedJobSignalRowById: vi.fn(async (id: string, payerId: string) =>
      jobsTable.get(id) === payerId ? signalRow(id) : undefined,
    ),
    // The ops pool read. The payer path must never call it (#1898).
    listSignalRows: vi.fn(async () => POOL),
    listApplicantSignalRowsForJob: vi.fn(async (jobId: string) =>
      POOL.filter((w) =>
        applicationsTable.some(
          (a) => a.jobId === jobId && a.workerId === w.workerId && a.action === "applied",
        ),
      ),
    ),
  };
  const emitMany = vi.fn(async () => []);
  const emit = vi.fn(async () => undefined);
  // JOB_SOURCE is the ops-view seam; the payer-owned path never touches it.
  const reach = new ReachService(reachRepo as never, { emit, emitMany } as never, {} as never);

  const postingsRepo = {
    findByIdAndPayer: vi.fn(async (id: string, payerId: string) =>
      postingsTable.get(id) === payerId ? { id, payer_id: payerId } : undefined,
    ),
  };
  // Only the repository is reachable from getOneForPayer; every other dep is inert.
  const jobPostings = new JobPostingsService(
    postingsRepo as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );
  const getOneForPayer = vi.spyOn(jobPostings, "getOneForPayer");

  const matchCandidates = {
    listForPosting: vi.fn(async (postingId: string) => candidates(postingId)),
  };

  const svc = new PayerApplicantsService(reach, jobPostings, matchCandidates as never);
  const feedShown = (): Record<string, unknown>[] =>
    (emitMany.mock.calls as unknown as Record<string, unknown>[][][]).flatMap((c) => c[0]!);
  return {
    svc,
    reachRepo,
    postingsRepo,
    getOneForPayer,
    matchCandidates,
    emit,
    emitMany,
    feedShown,
  };
}

/** What the client actually receives for a rejection: the real global filter's status + body. */
function httpOutcome(err: unknown): { status: number; error: unknown } {
  let status = 0;
  let body: Record<string, unknown> = {};
  const res = {
    status: (s: number) => {
      status = s;
      return {
        json: (b: Record<string, unknown>) => {
          body = b;
        },
      };
    },
  };
  const req = { method: "GET", url: "/payer/reach/jobs/x/applicants", requestId: "req-1" };
  const host = { switchToHttp: () => ({ getResponse: () => res, getRequest: () => req }) };
  new AllExceptionsFilter().catch(err, host as never);
  return { status, error: body.error };
}

async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    return err;
  }
  throw new Error("expected the call to reject");
}

const NEUTRAL_404 = {
  status: 404,
  error: { statusCode: 404, message: "Job not found", error: "Not Found" },
};

beforeEach(() => {
  // The filter logs 5xx stacks; keep the test output clean.
  vi.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("PayerApplicantsService — an owned agency job lists ONLY its appliers (#1898)", () => {
  it("serves the workers who applied, weighted by the unchanged ReachService ranking", async () => {
    const d = make();
    const out = (await d.svc.listForOwned(JOB_A, PAYER_A, CTX)) as ApplicantListResponseDto;
    expect(out.jobId).toBe(JOB_A);
    expect(out.applicants.map((a) => a.workerId)).toEqual([APPLIER.workerId]);
    for (const a of out.applicants) {
      expect(typeof a.score).toBe("number");
      expect(Array.isArray(a.components)).toBe(true);
    }
    expect(d.reachRepo.findOwnedJobSignalRowById).toHaveBeenCalledWith(JOB_A, PAYER_A);
  });

  it("a non-applier never appears — neither a worker who skipped nor one with no decision", async () => {
    const d = make();
    const out = await d.svc.listForOwned(JOB_A, PAYER_A, CTX);
    const body = JSON.stringify(out);
    expect(body).not.toContain(worker(2).workerId); // skipped
    expect(body).not.toContain(worker(3).workerId); // never decided
    // The ranked whole pool is never read on the payer path.
    expect(d.reachRepo.listSignalRows).not.toHaveBeenCalled();
  });

  it("emits one feed.shown per APPLIER with the PAYER actor (event contract unchanged)", async () => {
    const d = make();
    await d.svc.listForOwned(JOB_A, PAYER_A, CTX);
    const events = d.feedShown();
    expect(events).toHaveLength(1);
    for (const e of events) {
      expect(e.event_name).toBe("feed.shown");
      expect(e.actor).toEqual({ actor_type: "payer", actor_id: PAYER_A });
      expect(e).not.toHaveProperty("idempotencyKey");
      const payload = e.payload as Record<string, unknown>;
      expect(Object.keys(payload).sort()).toEqual(["hot", "job_id", "rank", "score", "worker_id"]);
      expect(payload.job_id).toBe(JOB_A);
      expect(payload.worker_id).toBe(APPLIER.workerId);
    }
  });

  it("never reaches the posting seam", async () => {
    const d = make();
    await d.svc.listForOwned(JOB_A, PAYER_A, CTX);
    expect(d.getOneForPayer).not.toHaveBeenCalled();
    expect(d.matchCandidates.listForPosting).not.toHaveBeenCalled();
  });

  it("costs ONE ownership read: the row that proves ownership is the row that is ranked", async () => {
    const d = make();
    await d.svc.listForOwned(JOB_A, PAYER_A, CTX);
    expect(d.reachRepo.findOwnedJobSignalRowById).toHaveBeenCalledOnce();
  });

  it("an id in BOTH tables resolves as the job (jobs-first, the GET /jobs/:id precedent)", async () => {
    const d = make();
    const out = (await d.svc.listForOwned(TWIN, PAYER_A, CTX)) as ApplicantListResponseDto;
    expect(out.applicants[0]).toHaveProperty("score");
    expect(d.matchCandidates.listForPosting).not.toHaveBeenCalled();
  });
});

describe("PayerApplicantsService — the result does not depend on MATCH_V1_ENABLED (#1898)", () => {
  it("takes no server config: there is no flag for the list to branch on", () => {
    // Constructor arity is the structural pin — the flag read was the id-space flip (#1898).
    expect(PayerApplicantsService.length).toBe(3);
  });

  it.each(FLAG_STATES)(
    "MATCH_V1_ENABLED $label: agency job → appliers, posting → applicants, foreign → neutral 404",
    async (flags) => {
      vi.stubEnv("MATCH_V1_ENABLED", String(flags.MATCH_V1_ENABLED));
      try {
        const d = make();
        const job = (await d.svc.listForOwned(JOB_A, PAYER_A, CTX)) as ApplicantListResponseDto;
        expect(job.applicants.map((a) => a.workerId)).toEqual([APPLIER.workerId]);
        await expect(d.svc.listForOwned(POSTING_A, PAYER_A, CTX)).resolves.toEqual(
          candidates(POSTING_A),
        );
        expect(httpOutcome(await rejection(d.svc.listForOwned(JOB_A, PAYER_B, CTX)))).toEqual(
          NEUTRAL_404,
        );
      } finally {
        vi.unstubAllEnvs();
      }
    },
  );
});

describe("PayerApplicantsService — an owned company posting (O8)", () => {
  it("serves the posting's ACTUAL applicants via listForPosting", async () => {
    const d = make();
    const out = await d.svc.listForOwned(POSTING_A, PAYER_A, CTX);
    expect(out).toEqual(candidates(POSTING_A));
    expect(d.matchCandidates.listForPosting).toHaveBeenCalledWith(POSTING_A);
  });

  it("checks job ownership first, then posting ownership — both with the SESSION payer", async () => {
    const d = make();
    await d.svc.listForOwned(POSTING_A, PAYER_A, CTX);
    expect(d.reachRepo.findOwnedJobSignalRowById).toHaveBeenCalledWith(POSTING_A, PAYER_A);
    expect(d.getOneForPayer).toHaveBeenCalledWith(POSTING_A, PAYER_A);
    expect(d.reachRepo.findOwnedJobSignalRowById.mock.invocationCallOrder[0]!).toBeLessThan(
      d.getOneForPayer.mock.invocationCallOrder[0]!,
    );
  });

  it("emits no feed.shown and never reads the worker pool", async () => {
    const d = make();
    await d.svc.listForOwned(POSTING_A, PAYER_A, CTX);
    expect(d.emitMany).not.toHaveBeenCalled();
    expect(d.emit).not.toHaveBeenCalled();
    expect(d.reachRepo.listSignalRows).not.toHaveBeenCalled();
  });

  it("is NOT gated by FEED_POSTINGS_UNION_ENABLED: disarming the feed never hides applicants", async () => {
    vi.stubEnv("FEED_POSTINGS_UNION_ENABLED", "false");
    try {
      const d = make();
      await expect(d.svc.listForOwned(POSTING_A, PAYER_A, CTX)).resolves.toEqual(
        candidates(POSTING_A),
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("PayerApplicantsService — no existence oracle, no IDOR", () => {
  it("another payer's POSTING → neutral 404; its applicant list is never read", async () => {
    const d = make();
    const err = await rejection(d.svc.listForOwned(POSTING_A, PAYER_B, CTX));
    expect(httpOutcome(err)).toEqual(NEUTRAL_404);
    expect(d.getOneForPayer).toHaveBeenCalledWith(POSTING_A, PAYER_B);
    expect(d.matchCandidates.listForPosting).not.toHaveBeenCalled();
  });

  it("another payer's JOB → neutral 404; no worker is read and no impression is written", async () => {
    const d = make();
    const err = await rejection(d.svc.listForOwned(JOB_A, PAYER_B, CTX));
    expect(httpOutcome(err)).toEqual(NEUTRAL_404);
    expect(d.reachRepo.findOwnedJobSignalRowById).toHaveBeenCalledWith(JOB_A, PAYER_B);
    expect(d.reachRepo.listSignalRows).not.toHaveBeenCalled();
    expect(d.reachRepo.listApplicantSignalRowsForJob).not.toHaveBeenCalled();
    expect(d.emitMany).not.toHaveBeenCalled();
    expect(d.matchCandidates.listForPosting).not.toHaveBeenCalled();
  });

  it("unknown, foreign-job and foreign-posting ids produce the byte-identical response", async () => {
    const d = make();
    const outcomes = await Promise.all(
      [
        d.svc.listForOwned(UNKNOWN, PAYER_A, CTX),
        d.svc.listForOwned(JOB_A, PAYER_B, CTX),
        d.svc.listForOwned(POSTING_A, PAYER_B, CTX),
      ].map(async (p) => httpOutcome(await rejection(p))),
    );
    for (const o of outcomes) expect(o).toEqual(NEUTRAL_404);
    // The posting seam's own wording ("Job posting not found") never escapes.
    expect(JSON.stringify(outcomes)).not.toContain("posting");
  });

  it("an unknown id writes nothing and lists nothing", async () => {
    const d = make();
    await expect(d.svc.listForOwned(UNKNOWN, PAYER_A, CTX)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(d.emitMany).not.toHaveBeenCalled();
    expect(d.emit).not.toHaveBeenCalled();
    expect(d.matchCandidates.listForPosting).not.toHaveBeenCalled();
  });
});

describe("PayerApplicantsService — fail closed: a DB error is a 500, never a 404", () => {
  it("the jobs ownership read fails → the error propagates and the posting seam is not tried", async () => {
    const d = make();
    const boom = new Error("canceling statement due to statement timeout");
    d.reachRepo.findOwnedJobSignalRowById.mockRejectedValueOnce(boom);
    const err = await rejection(d.svc.listForOwned(POSTING_A, PAYER_A, CTX));
    expect(err).toBe(boom);
    expect(httpOutcome(err).status).toBe(500);
    expect(d.getOneForPayer).not.toHaveBeenCalled();
    expect(d.matchCandidates.listForPosting).not.toHaveBeenCalled();
  });

  it("the posting ownership read fails → 500 (the old `.catch(() => undefined)` made this a 404)", async () => {
    const d = make();
    const boom = new Error("connection terminated unexpectedly");
    d.postingsRepo.findByIdAndPayer.mockRejectedValueOnce(boom);
    const err = await rejection(d.svc.listForOwned(POSTING_A, PAYER_A, CTX));
    expect(err).toBe(boom);
    expect(httpOutcome(err).status).toBe(500);
    expect(d.matchCandidates.listForPosting).not.toHaveBeenCalled();
  });

  it("the candidate read fails → 500", async () => {
    const d = make();
    const boom = new Error("relation does not exist");
    d.matchCandidates.listForPosting.mockRejectedValueOnce(boom);
    const err = await rejection(d.svc.listForOwned(POSTING_A, PAYER_A, CTX));
    expect(err).toBe(boom);
    expect(httpOutcome(err).status).toBe(500);
  });

  it("the applier read fails → 500, no partial impression batch", async () => {
    const d = make();
    const boom = new Error("connection reset");
    d.reachRepo.listApplicantSignalRowsForJob.mockRejectedValueOnce(boom);
    const err = await rejection(d.svc.listForOwned(JOB_A, PAYER_A, CTX));
    expect(err).toBe(boom);
    expect(httpOutcome(err).status).toBe(500);
    expect(d.emitMany).not.toHaveBeenCalled();
  });
});
