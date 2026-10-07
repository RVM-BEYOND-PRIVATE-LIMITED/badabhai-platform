import "reflect-metadata";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Logger, NotFoundException } from "@nestjs/common";
import { DEFAULT_MATCH_CONFIG, rankKeyCompare } from "@badabhai/match-engine";
import type { RequestContext } from "../common/request-context";
import { ReachService } from "../reach/reach.service";
import type { JobSignalRow, JobApplicantSignalRow } from "../reach/reach.repository";
import type { WorkerProfileSignalRow } from "../reach/reach.mappers";
import type { ApplicantRowDto } from "../reach/reach.dto";
import { MatchCandidatesService } from "../match/match-candidates.service";
import type { CandidateRow, RankedCandidateRow } from "../match/match-feed.repository";
import { PayerApplicantsService } from "./payer-applicants.service";
import { PayerApplicantInboxService } from "./payer-applicant-inbox.service";
import type { InboxPageQuery, InboxPageRow } from "./payer-applicant-inbox.repository";
import { decodeInboxCursor } from "./payer-applicant-inbox.cursor";
import type { InboxApplicantRowDto, PayerApplicantInboxDto } from "./payer-applicant-inbox.dto";

/**
 * `GET /payer/reach/applicants` — the payer's cross-posting applicant inbox, at the service seam.
 *
 * The row builders are the REAL ones the per-posting list uses (`ReachService`,
 * `MatchCandidatesService`, and `PayerApplicantsService.listForOwned` for the comparison). Only
 * the repositories are faked, and each fake answers the way its SQL is written to:
 *  - the inbox page read: owner-scoped on both arms, `applied` only, no pending-deletion worker,
 *    an agency applier needs a profile row, newest first with the application id as the
 *    tiebreak, keyset `(created_at, id) <` the cursor;
 *  - the agency reads: owner-scoped job rows, appliers per job;
 *  - the company reads: each posting's list in `rankKeyCompare` order (the comparator
 *    `rank-parity.test.ts` pins the SQL to), and the window rank = position on that list.
 * The SQL itself is pinned in the repository tests and run on Postgres in
 * `payer-applicant-inbox.db.test.ts`. What this file proves is the SERVICE: which payer each read
 * is scoped to, how a page and its cursor are cut, that a row is the per-posting row plus
 * `posting` and nothing else, and which impressions are written.
 */

const PAYER_A = "aaaaaaaa-0000-4000-8000-00000000000a";
const PAYER_B = "bbbbbbbb-0000-4000-8000-00000000000b";

const JOB_A1 = "0a000000-0000-4000-8000-0000000000a1"; // agency job, A
const JOB_A2 = "0a000000-0000-4000-8000-0000000000a2"; // agency job, A
const POST_A1 = "0c000000-0000-4000-8000-0000000000a1"; // company posting, A
const POST_A2 = "0c000000-0000-4000-8000-0000000000a2"; // company posting, A
const POST_A_EMPTY = "0c000000-0000-4000-8000-0000000000ae"; // company posting, A, nobody applied
const JOB_B1 = "0a000000-0000-4000-8000-0000000000b1"; // agency job, B
const POST_B1 = "0c000000-0000-4000-8000-0000000000b1"; // company posting, B
const UNKNOWN = "0f000000-0000-4000-8000-00000000ffff";

const CTX: RequestContext = {
  correlationId: "22222222-2222-4222-8222-222222222222",
  requestId: "req-1",
};

const worker = (n: number) => `33333333-3333-4333-8333-${n.toString(16).padStart(12, "0")}`;
const app = (n: number) => `44444444-4444-4444-8444-${n.toString(16).padStart(12, "0")}`;
/** A microsecond UTC key, `minute` minutes into the day, plus `us` microseconds. */
const at = (minute: number, us = 0) =>
  `2026-10-01T${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}:00.${String(us).padStart(6, "0")}Z`;

const LEAVER = worker(90); // inside the deletion grace window
const NO_PROFILE = worker(91); // applied to an agency job, has no worker_profiles row

const JOBS = new Map<string, { owner: string; title: string }>([
  [JOB_A1, { owner: PAYER_A, title: "CNC Operator — Night Shift" }],
  [JOB_A2, { owner: PAYER_A, title: "VMC Setter" }],
  [JOB_B1, { owner: PAYER_B, title: "B's agency job" }],
]);
const POSTINGS = new Map<string, { owner: string; title: string }>([
  [POST_A1, { owner: PAYER_A, title: "Turner (Fanuc)" }],
  [POST_A2, { owner: PAYER_A, title: "Welder" }],
  [POST_A_EMPTY, { owner: PAYER_A, title: "Fitter" }],
  [POST_B1, { owner: PAYER_B, title: "B's posting" }],
]);

interface Application {
  id: string;
  workerId: string;
  jobId: string | null;
  jobPostingId: string | null;
  action: "applied" | "skipped";
  t: string;
  matchTier?: number | null;
  skillMonths?: number | null;
  industryMonths?: number | null;
  lastWorkedAt?: string | null;
  matchedSkillId?: string | null;
}

/**
 * The applications table. Workers 1..6 apply to A's postings, some to several; 7..8 to B's.
 * Two LISTED rows in different arms share a microsecond (app 7, agency; app 14, company) so the
 * id tiebreak is exercised across the union.
 */
const APPLICATIONS: Application[] = [
  // agency JOB_A1 — four appliers with different signal strength
  {
    id: app(1),
    workerId: worker(1),
    jobId: JOB_A1,
    jobPostingId: null,
    action: "applied",
    t: at(10),
  },
  {
    id: app(2),
    workerId: worker(2),
    jobId: JOB_A1,
    jobPostingId: null,
    action: "applied",
    t: at(20),
  },
  {
    id: app(3),
    workerId: worker(3),
    jobId: JOB_A1,
    jobPostingId: null,
    action: "applied",
    t: at(30),
  },
  {
    id: app(4),
    workerId: worker(4),
    jobId: JOB_A1,
    jobPostingId: null,
    action: "skipped",
    t: at(31),
  },
  { id: app(5), workerId: LEAVER, jobId: JOB_A1, jobPostingId: null, action: "applied", t: at(32) },
  // agency JOB_A2
  {
    id: app(6),
    workerId: worker(1),
    jobId: JOB_A2,
    jobPostingId: null,
    action: "applied",
    t: at(40),
  },
  {
    id: app(7),
    workerId: worker(5),
    jobId: JOB_A2,
    jobPostingId: null,
    action: "applied",
    t: at(50, 7),
  },
  {
    id: app(8),
    workerId: NO_PROFILE,
    jobId: JOB_A2,
    jobPostingId: null,
    action: "applied",
    t: at(50, 7),
  },
  // company POST_A1 — snapshots chosen so rank order != arrival order
  {
    id: app(9),
    workerId: worker(2),
    jobId: null,
    jobPostingId: POST_A1,
    action: "applied",
    t: at(15),
    matchTier: 2,
    skillMonths: 12,
    industryMonths: 12,
    lastWorkedAt: "2025-01-01",
    matchedSkillId: "mskill_cnc_turner",
  },
  {
    id: app(10),
    workerId: worker(3),
    jobId: null,
    jobPostingId: POST_A1,
    action: "applied",
    t: at(25),
    matchTier: 1,
    skillMonths: 48,
    industryMonths: 60,
    lastWorkedAt: "2026-05-01",
    matchedSkillId: "mskill_cnc_turner",
  },
  {
    id: app(11),
    workerId: worker(4),
    jobId: null,
    jobPostingId: POST_A1,
    action: "applied",
    t: at(35),
    matchTier: 1,
    skillMonths: 6,
    industryMonths: 6,
    lastWorkedAt: null,
    matchedSkillId: null,
  },
  {
    id: app(12),
    workerId: LEAVER,
    jobId: null,
    jobPostingId: POST_A1,
    action: "applied",
    t: at(36),
    matchTier: 1,
    skillMonths: 999,
    industryMonths: 999,
    lastWorkedAt: "2026-06-01",
    matchedSkillId: null,
  },
  {
    id: app(13),
    workerId: worker(6),
    jobId: null,
    jobPostingId: POST_A1,
    action: "skipped",
    t: at(37),
  },
  // company POST_A2
  {
    id: app(14),
    workerId: worker(6),
    jobId: null,
    jobPostingId: POST_A2,
    action: "applied",
    t: at(50, 7),
    matchTier: null,
    skillMonths: null,
    industryMonths: null,
    lastWorkedAt: null,
    matchedSkillId: null,
  },
  {
    id: app(15),
    workerId: worker(1),
    jobId: null,
    jobPostingId: POST_A2,
    action: "applied",
    t: at(55),
    matchTier: 1,
    skillMonths: 24,
    industryMonths: 30,
    lastWorkedAt: "2026-01-01",
    matchedSkillId: null,
  },
  // B's postings — must never reach A
  {
    id: app(16),
    workerId: worker(7),
    jobId: JOB_B1,
    jobPostingId: null,
    action: "applied",
    t: at(60),
  },
  {
    id: app(17),
    workerId: worker(8),
    jobId: null,
    jobPostingId: POST_B1,
    action: "applied",
    t: at(61),
    matchTier: 1,
    skillMonths: 12,
    industryMonths: 12,
    lastWorkedAt: null,
    matchedSkillId: null,
  },
];

/** Every worker with a profile row (NO_PROFILE has none). Signal strength varies by n. */
const PROFILES = new Map<string, WorkerProfileSignalRow>(
  [1, 2, 3, 4, 5, 6, 7, 8].map((n) => [
    worker(n),
    {
      workerId: worker(n),
      canonicalRoleId: n % 2 === 0 ? "vmc_operator" : "welder",
      canonicalTradeId: n % 2 === 0 ? "cnc_vmc" : "fabrication",
      experience: { total_years: n },
      salaryExpectation: { amount_min: 15000 + n * 1000, period: "monthly" },
      locationPreference: { preferred_cities: ["pune"] },
      availability: { status: "immediate" },
      updatedAt: new Date("2026-09-01T00:00:00.000Z"),
    },
  ]),
);
PROFILES.set(LEAVER, { ...PROFILES.get(worker(2))!, workerId: LEAVER });

const DELETING = new Set([LEAVER]);
const NOW = new Date("2026-10-07T00:00:00.000Z");

function jobSignalRow(jobId: string): JobSignalRow {
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

const listed = (a: Application) => a.action === "applied" && !DELETING.has(a.workerId);

/** The agency per-job membership: applied, not leaving, has a profile row. */
function appliersOf(jobId: string): WorkerProfileSignalRow[] {
  return APPLICATIONS.filter((a) => a.jobId === jobId && listed(a))
    .map((a) => PROFILES.get(a.workerId))
    .filter((p): p is WorkerProfileSignalRow => p !== undefined)
    .sort((x, y) => (x.workerId < y.workerId ? -1 : 1));
}

/** The company per-posting list, in rank-key order (the order the SQL is pinned to). */
function candidatesOf(postingId: string): CandidateRow[] {
  const rows: CandidateRow[] = APPLICATIONS.filter(
    (a) => a.jobPostingId === postingId && listed(a),
  ).map((a) => ({
    applicationId: a.id,
    workerId: a.workerId,
    matchTier: a.matchTier ?? null,
    skillMonths: a.skillMonths ?? null,
    industryMonths: a.industryMonths ?? null,
    lastWorkedAt: a.lastWorkedAt ?? null,
    createdAt: new Date(a.t),
    engineVersion: a.matchTier == null ? null : "v1.0",
    matchedSkillId: a.matchedSkillId ?? null,
  }));
  const order = MatchCandidatesService.toRankInputs(rows).sort((x, y) =>
    rankKeyCompare(x, y, DEFAULT_MATCH_CONFIG),
  );
  return order.map((o) => rows.find((r) => r.applicationId === o.id)!);
}

/** The inbox page read, answering the way `inboxPageStatement` is written to. */
function pageOf(payerId: string, q: InboxPageQuery): InboxPageRow[] {
  const rows: InboxPageRow[] = [];
  for (const a of APPLICATIONS) {
    if (!listed(a)) continue;
    const job = a.jobId ? JOBS.get(a.jobId) : undefined;
    const posting = a.jobPostingId ? POSTINGS.get(a.jobPostingId) : undefined;
    if (job && job.owner === payerId) {
      if (!PROFILES.has(a.workerId)) continue;
      rows.push({
        applicationId: a.id,
        workerId: a.workerId,
        appliedKey: a.t,
        postingKind: "agency_job",
        postingId: a.jobId!,
        postingTitle: job.title,
      });
    } else if (posting && posting.owner === payerId) {
      rows.push({
        applicationId: a.id,
        workerId: a.workerId,
        appliedKey: a.t,
        postingKind: "company_posting",
        postingId: a.jobPostingId!,
        postingTitle: posting.title,
      });
    }
  }
  const after = q.after;
  return rows
    .filter((r) => q.postingId === undefined || r.postingId === q.postingId)
    .filter(
      (r) =>
        after === undefined ||
        r.appliedKey < after.appliedKey ||
        (r.appliedKey === after.appliedKey && r.applicationId < after.applicationId),
    )
    .sort((x, y) =>
      x.appliedKey !== y.appliedKey
        ? x.appliedKey < y.appliedKey
          ? 1
          : -1
        : x.applicationId < y.applicationId
          ? 1
          : -1,
    )
    .slice(0, q.limit);
}

function world(opts: { page?: (payerId: string, q: InboxPageQuery) => InboxPageRow[] } = {}) {
  const inboxRepo = {
    listPage: vi.fn(async (payerId: string, q: InboxPageQuery) =>
      (opts.page ?? pageOf)(payerId, q),
    ),
  };
  const reachRepo = {
    findOwnedJobSignalRowById: vi.fn(async (id: string, payerId: string) =>
      JOBS.get(id)?.owner === payerId ? jobSignalRow(id) : undefined,
    ),
    listApplicantSignalRowsForJob: vi.fn(async (jobId: string) => appliersOf(jobId)),
    findOwnedJobSignalRowsByIds: vi.fn(async (ids: readonly string[], payerId: string) =>
      ids.filter((id) => JOBS.get(id)?.owner === payerId).map(jobSignalRow),
    ),
    listApplicantSignalRowsForJobs: vi.fn(
      async (ids: readonly string[]): Promise<JobApplicantSignalRow[]> =>
        ids.flatMap((jobId) => appliersOf(jobId).map((row) => ({ jobId, row }))),
    ),
    // The ops pool. No payer read may touch it.
    listSignalRows: vi.fn(async () => [...PROFILES.values()]),
  };
  const emit = vi.fn(async () => undefined);
  const emitMany = vi.fn(async () => []);
  const reach = new ReachService(reachRepo as never, { emit, emitMany } as never, {} as never);

  const matchRepo = {
    listCandidates: vi.fn(async (postingId: string, _floor: number, limit: number) =>
      candidatesOf(postingId).slice(0, limit),
    ),
    listRankedCandidatesByApplication: vi.fn(
      async (
        payerId: string,
        postingIds: readonly string[],
        applicationIds: readonly string[],
      ): Promise<RankedCandidateRow[]> =>
        postingIds
          .filter((p) => POSTINGS.get(p)?.owner === payerId)
          .flatMap((p) =>
            candidatesOf(p).map((row, i) => ({ ...row, jobPostingId: p, rank: i + 1 })),
          )
          .filter((r) => applicationIds.includes(r.applicationId)),
    ),
  };
  const config = { get: vi.fn(async () => DEFAULT_MATCH_CONFIG) };
  const candidates = new MatchCandidatesService(matchRepo as never, config as never);

  const jobPostings = {
    getOneForPayer: vi.fn(async (id: string, payerId: string) => {
      if (POSTINGS.get(id)?.owner !== payerId) throw new NotFoundException("Job posting not found");
      return { id };
    }),
  };
  const perPosting = new PayerApplicantsService(reach, jobPostings as never, candidates);
  const inbox = new PayerApplicantInboxService(inboxRepo as never, reach, candidates);

  const feedShown = (): Record<string, unknown>[] =>
    (emitMany.mock.calls as unknown as Record<string, unknown>[][][]).flatMap((c) => c[0]!);
  return { inbox, perPosting, inboxRepo, reachRepo, matchRepo, emit, emitMany, feedShown };
}

type World = ReturnType<typeof world>;

const query = (over: Partial<{ postingId: string; limit: number; cursor: string }> = {}) => ({
  limit: over.limit ?? 20,
  postingId: over.postingId,
  cursor: over.cursor === undefined ? undefined : decodeInboxCursor(over.cursor)!,
});

/** Walk every page for `payerId`; returns the pages in order. */
async function walk(w: World, payerId: string, limit: number, postingId?: string) {
  const pages: PayerApplicantInboxDto[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < 50; i += 1) {
    const page = await w.inbox.list(payerId, query({ limit, postingId, cursor }), CTX);
    pages.push(page);
    if (page.nextCursor === null) return pages;
    cursor = page.nextCursor;
  }
  throw new Error("pagination never ended");
}

/** The application id a row stands for (agency rows carry none; recover it from the fixture). */
function applicationOf(row: InboxApplicantRowDto): string {
  if (row.posting.kind === "company_posting")
    return (row as { applicationId: string }).applicationId;
  return APPLICATIONS.find((a) => a.jobId === row.posting.id && a.workerId === row.workerId)!.id;
}

/** A's expected inbox: every listed application on A's postings, newest first, id tiebreak. */
const EXPECTED_A = pageOf(PAYER_A, { limit: 1000 }).map((r) => r.applicationId);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("PayerApplicantInboxService — the fixture is what the tests claim", () => {
  it("A has 10 inbox rows: no skip, no leaver, no profile-less agency applier, nothing of B's", () => {
    // A guard against a vacuous suite: if the fixture lost its edge cases, every "never
    // appears" assertion below would pass for free.
    expect(EXPECTED_A).toHaveLength(10);
    expect(EXPECTED_A).not.toContain(app(4)); // skip
    expect(EXPECTED_A).not.toContain(app(5)); // leaver, agency
    expect(EXPECTED_A).not.toContain(app(12)); // leaver, company
    expect(EXPECTED_A).not.toContain(app(8)); // no profile row
    expect(EXPECTED_A).not.toContain(app(16));
    expect(EXPECTED_A).not.toContain(app(17));
  });
});

describe("PayerApplicantInboxService — ownership (XB-A): the session payer's postings only", () => {
  it("lists every applicant across A's agency jobs AND company postings, and nothing of B's", async () => {
    const w = world();
    const out = await w.inbox.list(PAYER_A, query(), CTX);
    expect(out.applicants.map(applicationOf)).toEqual(EXPECTED_A);
    expect(new Set(out.applicants.map((r) => r.posting.kind))).toEqual(
      new Set(["agency_job", "company_posting"]),
    );
    const body = JSON.stringify(out);
    for (const foreign of [JOB_B1, POST_B1, worker(7), worker(8), app(16), app(17)]) {
      expect(body).not.toContain(foreign);
    }
  });

  it("every read is scoped to the SESSION payer — the page and both detail reads", async () => {
    const w = world();
    await w.inbox.list(PAYER_A, query(), CTX);
    expect(w.inboxRepo.listPage).toHaveBeenCalledWith(PAYER_A, expect.anything());
    for (const call of w.reachRepo.findOwnedJobSignalRowsByIds.mock.calls)
      expect(call[1]).toBe(PAYER_A);
    for (const call of w.matchRepo.listRankedCandidatesByApplication.mock.calls) {
      expect(call[0]).toBe(PAYER_A);
    }
    expect(w.reachRepo.findOwnedJobSignalRowsByIds).toHaveBeenCalled();
    expect(w.matchRepo.listRankedCandidatesByApplication).toHaveBeenCalled();
  });

  it("B's session sees only B's applicants", async () => {
    const w = world();
    const out = await w.inbox.list(PAYER_B, query(), CTX);
    expect(out.applicants.map(applicationOf).sort()).toEqual([app(16), app(17)].sort());
  });

  it("DEFENCE IN DEPTH: a foreign row the page read let through is dropped by the owner-scoped detail reads", async () => {
    // Simulates a page-SQL regression that forgot an ownership predicate: the detail reads are
    // scoped to the session payer on their own, so B's applicants still never render for A.
    const w = world({ page: (_payer, q) => pageOf(PAYER_B, q) });
    const out = await w.inbox.list(PAYER_A, query(), CTX);
    expect(out.applicants).toEqual([]);
    expect(w.feedShown()).toHaveLength(0);
  });

  it("a postingId of ANOTHER payer → the same empty page as an unknown id and an owned empty posting", async () => {
    const w = world();
    const foreign = await w.inbox.list(PAYER_A, query({ postingId: POST_B1 }), CTX);
    const foreignJob = await w.inbox.list(PAYER_A, query({ postingId: JOB_B1 }), CTX);
    const unknown = await w.inbox.list(PAYER_A, query({ postingId: UNKNOWN }), CTX);
    const ownedEmpty = await w.inbox.list(PAYER_A, query({ postingId: POST_A_EMPTY }), CTX);
    const NEUTRAL = { applicants: [], nextCursor: null };
    expect(foreign).toStrictEqual(NEUTRAL);
    expect(foreignJob).toStrictEqual(NEUTRAL);
    expect(unknown).toStrictEqual(NEUTRAL);
    expect(ownedEmpty).toStrictEqual(NEUTRAL);
    // ...and costs the same: one page read each, no ownership probe that could tell them apart.
    expect(w.inboxRepo.listPage).toHaveBeenCalledTimes(4);
    expect(w.reachRepo.findOwnedJobSignalRowById).not.toHaveBeenCalled();
    expect(w.emitMany).not.toHaveBeenCalled();
  });
});

describe("PayerApplicantInboxService — order and pagination", () => {
  it("newest application first, application id breaking a same-microsecond tie", async () => {
    const w = world();
    const out = await w.inbox.list(PAYER_A, query(), CTX);
    const keys = out.applicants.map((r) => APPLICATIONS.find((a) => a.id === applicationOf(r))!.t);
    expect(keys).toEqual([...keys].sort().reverse());
  });

  it.each([1, 2, 3, 4, 7])(
    "walking pages of %i covers every applicant exactly once, in order — no gap, no repeat",
    async (limit) => {
      const w = world();
      const pages = await walk(w, PAYER_A, limit);
      const ids = pages.flatMap((p) => p.applicants.map(applicationOf));
      expect(ids).toEqual(EXPECTED_A);
      expect(new Set(ids).size).toBe(ids.length);
      for (const p of pages.slice(0, -1)) expect(p.applicants).toHaveLength(limit);
    },
  );

  it("reads limit + 1 to know whether a next page exists; the last page has nextCursor null", async () => {
    const w = world();
    const all = await w.inbox.list(PAYER_A, query({ limit: EXPECTED_A.length }), CTX);
    expect(w.inboxRepo.listPage.mock.calls[0]![1].limit).toBe(EXPECTED_A.length + 1);
    expect(all.applicants).toHaveLength(EXPECTED_A.length);
    expect(all.nextCursor).toBeNull();
  });

  it("the cursor is the LAST served row's position and is passed back as `after`", async () => {
    const w = world();
    const first = await w.inbox.list(PAYER_A, query({ limit: 3 }), CTX);
    const decoded = decodeInboxCursor(first.nextCursor!);
    const third = APPLICATIONS.find((a) => a.id === EXPECTED_A[2])!;
    expect(decoded).toEqual({ appliedKey: third.t, applicationId: third.id });
    await w.inbox.list(PAYER_A, query({ limit: 3, cursor: first.nextCursor! }), CTX);
    expect(w.inboxRepo.listPage.mock.calls[1]![1].after).toEqual(decoded);
  });
});

describe("PayerApplicantInboxService — filters", () => {
  it.each([JOB_A1, JOB_A2, POST_A1, POST_A2])(
    "postingId %s → only that posting's applicants",
    async (id) => {
      const w = world();
      const pages = await walk(w, PAYER_A, 2, id);
      const rows = pages.flatMap((p) => p.applicants);
      expect(rows.length).toBeGreaterThan(0);
      for (const r of rows) expect(r.posting.id).toBe(id);
      expect(rows.map(applicationOf)).toEqual(
        EXPECTED_A.filter((a) =>
          pageOf(PAYER_A, { postingId: id, limit: 100 }).some((r) => r.applicationId === a),
        ),
      );
      expect(w.inboxRepo.listPage.mock.calls.every((c) => c[1].postingId === id)).toBe(true);
    },
  );

  it("no postingId → the page read is unfiltered", async () => {
    const w = world();
    await w.inbox.list(PAYER_A, query(), CTX);
    expect(w.inboxRepo.listPage.mock.calls[0]![1].postingId).toBeUndefined();
  });
});

describe("PayerApplicantInboxService — a row is EXACTLY its per-posting feed row + `posting`", () => {
  it("same keys and same values as GET /payer/reach/jobs/:jobId/applicants, for every row", async () => {
    // If a field is added to the per-posting row but not here (or here but not there), the key
    // sets differ. If `rank`, `hot` or `effectiveTier` were computed differently (an inbox
    // position, a page-local hot fraction), the values differ.
    const w = world();
    const pages = await walk(w, PAYER_A, 3);
    const rows = pages.flatMap((p) => p.applicants);
    expect(rows).toHaveLength(EXPECTED_A.length);
    for (const row of rows) {
      const { posting, ...rest } = row;
      const list = await w.perPosting.listForOwned(posting.id, PAYER_A, CTX);
      const twin = (list.applicants as unknown as Record<string, unknown>[]).find((a) =>
        posting.kind === "agency_job"
          ? a.workerId === rest.workerId
          : a.applicationId === (rest as { applicationId: string }).applicationId,
      );
      expect(twin, `${posting.kind} ${posting.id} lists ${rest.workerId}`).toBeDefined();
      expect(Object.keys(rest).sort()).toEqual(Object.keys(twin!).sort());
      expect(rest).toStrictEqual(twin);
      expect(Object.keys(posting).sort()).toEqual(["id", "kind", "title"]);
    }
  });

  it("rank is the POSTING rank, not the inbox position (company rows arrive out of rank order)", async () => {
    const w = world();
    const out = await w.inbox.list(PAYER_A, query({ postingId: POST_A1 }), CTX);
    // Newest first is 11, 10, 9. Rank-key order is 10 (tier 1, 48 mo), 11 (tier 1, 6 mo), then 9
    // (tier 2 under the floor) — so the ranks read 2, 1, 3.
    expect(out.applicants.map((r) => [applicationOf(r), r.rank])).toEqual([
      [app(11), 2],
      [app(10), 1],
      [app(9), 3],
    ]);
  });

  it("an agency row's rank and hot are computed over the job's WHOLE applier set, not the page", async () => {
    const w = world();
    const perJob = await w.perPosting.listForOwned(JOB_A1, PAYER_A, CTX);
    const pageOfOne = await w.inbox.list(PAYER_A, query({ postingId: JOB_A1, limit: 1 }), CTX);
    const [only] = pageOfOne.applicants as (ApplicantRowDto & { posting: unknown })[];
    const twin = (perJob.applicants as ApplicantRowDto[]).find(
      (a) => a.workerId === only!.workerId,
    )!;
    expect(only!.rank).toBe(twin.rank);
    expect(only!.hot).toBe(twin.hot);
    // Not vacuous: ranked alone he would be #1; among all the job's appliers he is not.
    expect(perJob.applicants.length).toBeGreaterThan(1);
    expect(twin.rank).toBeGreaterThan(1);
  });

  it("posting carries the payer's OWN title and the kind payer-web branches on", async () => {
    const w = world();
    const out = await w.inbox.list(PAYER_A, query(), CTX);
    for (const r of out.applicants) {
      const source =
        r.posting.kind === "agency_job" ? JOBS.get(r.posting.id) : POSTINGS.get(r.posting.id);
      expect(r.posting.title).toBe(source!.title);
      expect(r.posting.kind === "agency_job" ? "score" in r : "applicationId" in r).toBe(true);
    }
  });
});

describe("PayerApplicantInboxService — faceless (no name, phone or other identifier)", () => {
  const ALLOWED = new Set([
    // ApplicantRowDto
    "workerId",
    "rank",
    "score",
    "hot",
    "pushEligible",
    "components",
    "experienceBand",
    "tradeLabel",
    "cityLabel",
    // MatchCandidateRowDto
    "applicationId",
    "matchTier",
    "effectiveTier",
    "skillMonths",
    "industryMonths",
    "lastWorkedAt",
    "matchedSkillLabel",
    "engineVersion",
    "posting",
  ]);

  it("every row key is a faceless per-posting key or `posting` — nothing else", async () => {
    const w = world();
    const out = await w.inbox.list(PAYER_A, query(), CTX);
    for (const r of out.applicants)
      for (const k of Object.keys(r)) expect(ALLOWED.has(k), k).toBe(true);
  });

  it("no identity-shaped key or value anywhere in the body, and no payer id", async () => {
    const w = world();
    const body = JSON.stringify(await w.inbox.list(PAYER_A, query(), CTX));
    for (const p of [
      "name",
      "phone",
      "email",
      "address",
      "employer",
      "payer",
      "org_label",
      "+91",
    ]) {
      expect(body.toLowerCase()).not.toContain(p);
    }
    expect(body).not.toContain(PAYER_A);
  });
});

describe("PayerApplicantInboxService — events: the per-posting posture, row for row", () => {
  it("each AGENCY row shown emits the feed.shown its per-job list emits for it — payer actor, v1 payload", async () => {
    const w = world();
    const out = await w.inbox.list(PAYER_A, query({ limit: 4 }), CTX);
    const agencyRows = out.applicants.filter(
      (r) => r.posting.kind === "agency_job",
    ) as (ApplicantRowDto & { posting: { id: string } })[];
    expect(agencyRows.length).toBeGreaterThan(0);
    const events = w.feedShown();
    expect(w.emitMany).toHaveBeenCalledOnce(); // one all-or-nothing batch
    expect(events).toHaveLength(agencyRows.length);
    events.forEach((e, i) => {
      const row = agencyRows[i]!;
      expect(e.event_name).toBe("feed.shown");
      expect(e.actor).toEqual({ actor_type: "payer", actor_id: PAYER_A });
      expect(e.subject).toEqual({ subject_type: "worker", subject_id: row.workerId });
      expect(e).not.toHaveProperty("idempotencyKey");
      expect(e.payload).toStrictEqual({
        worker_id: row.workerId,
        job_id: row.posting.id,
        rank: row.rank,
        score: row.score,
        hot: row.hot,
      });
    });
  });

  it("the impression is the per-job list's impression for the same worker, byte for byte", async () => {
    const w = world();
    await w.perPosting.listForOwned(JOB_A1, PAYER_A, CTX);
    const perJob = w.feedShown();
    w.emitMany.mockClear();
    await w.inbox.list(PAYER_A, query({ postingId: JOB_A1 }), CTX);
    const inbox = w.feedShown();
    const byWorker = (es: Record<string, unknown>[]) =>
      new Map(es.map((e) => [(e.payload as { worker_id: string }).worker_id, e]));
    const perJobBy = byWorker(perJob);
    for (const [workerId, e] of byWorker(inbox)) expect(e).toStrictEqual(perJobBy.get(workerId));
    expect(inbox).toHaveLength(perJob.length);
  });

  it("only rows ON THE PAGE are impressions — not the job's other appliers ranked to build them", async () => {
    const w = world();
    const out = await w.inbox.list(PAYER_A, query({ postingId: JOB_A1, limit: 1 }), CTX);
    expect(out.applicants).toHaveLength(1);
    expect(w.feedShown().map((e) => (e.payload as { worker_id: string }).worker_id)).toEqual([
      out.applicants[0]!.workerId,
    ]);
  });

  it("a page of company rows only emits nothing (an applicant is not a feed impression)", async () => {
    const w = world();
    const out = await w.inbox.list(PAYER_A, query({ postingId: POST_A1 }), CTX);
    expect(out.applicants.length).toBeGreaterThan(0);
    expect(w.emitMany).not.toHaveBeenCalled();
    expect(w.emit).not.toHaveBeenCalled();
  });

  it("an empty page emits nothing", async () => {
    const w = world();
    await w.inbox.list(PAYER_A, query({ postingId: POST_A_EMPTY }), CTX);
    expect(w.emitMany).not.toHaveBeenCalled();
  });
});

describe("PayerApplicantInboxService — bounded reads, fail closed", () => {
  it("a page spanning several jobs and postings costs ONE page read and three detail reads", async () => {
    const w = world();
    const out = await w.inbox.list(PAYER_A, query(), CTX);
    expect(new Set(out.applicants.map((r) => r.posting.id)).size).toBe(4);
    expect(w.inboxRepo.listPage).toHaveBeenCalledOnce();
    expect(w.reachRepo.findOwnedJobSignalRowsByIds).toHaveBeenCalledOnce();
    expect(w.reachRepo.listApplicantSignalRowsForJobs).toHaveBeenCalledOnce();
    expect(w.matchRepo.listRankedCandidatesByApplication).toHaveBeenCalledOnce();
    // No per-posting fan-out, and the ops pool is never read.
    expect(w.reachRepo.findOwnedJobSignalRowById).not.toHaveBeenCalled();
    expect(w.reachRepo.listApplicantSignalRowsForJob).not.toHaveBeenCalled();
    expect(w.matchRepo.listCandidates).not.toHaveBeenCalled();
    expect(w.reachRepo.listSignalRows).not.toHaveBeenCalled();
  });

  it("a detail read error propagates (5xx) and no impression is written", async () => {
    const w = world();
    const boom = new Error("canceling statement due to statement timeout");
    w.reachRepo.listApplicantSignalRowsForJobs.mockRejectedValueOnce(boom);
    await expect(w.inbox.list(PAYER_A, query(), CTX)).rejects.toBe(boom);
    expect(w.emitMany).not.toHaveBeenCalled();
  });

  it("a company detail read error propagates too", async () => {
    const w = world();
    const boom = new Error("connection reset");
    w.matchRepo.listRankedCandidatesByApplication.mockRejectedValueOnce(boom);
    await expect(w.inbox.list(PAYER_A, query(), CTX)).rejects.toBe(boom);
    expect(w.emitMany).not.toHaveBeenCalled();
  });

  it("a page row whose detail vanished between the reads is left out, and the cursor still advances past it", async () => {
    const w = world();
    // The worker entered the deletion grace window after the page read: his company row is gone.
    w.matchRepo.listRankedCandidatesByApplication.mockImplementationOnce(async () => []);
    const out = await w.inbox.list(PAYER_A, query({ postingId: POST_A1, limit: 2 }), CTX);
    expect(out.applicants).toEqual([]);
    expect(decodeInboxCursor(out.nextCursor!)!.applicationId).toBe(app(10));
  });
});
