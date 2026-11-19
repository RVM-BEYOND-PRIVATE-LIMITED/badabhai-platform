import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import {
  ForbiddenException,
  NotFoundException,
  UnauthorizedException,
  type ExecutionContext,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { AdminRole, Database, JobPostingAudience } from "@badabhai/db";
import { AdminAuthGuard, type AuthenticatedAdmin } from "../admin/admin-auth.guard";
import { ADMIN_CAPABILITY_KEY, AdminRolesGuard } from "../admin/admin-roles.guard";
import type { RequestContext } from "../common/request-context";
import type { EventsService } from "../events/events.service";
import type { FeatureRolloutService } from "../feature-rollout/feature-rollout.service";
import {
  AdminJobAudienceEnabledGuard,
  adminJobAudienceEnabled,
} from "../job-postings/admin-job-audience.flag";
import type { JobPostingsService } from "../job-postings/job-postings.service";
import type { PostingAudienceRepository } from "../job-postings/posting-audience.repository";
import { PostingAudienceService } from "../job-postings/posting-audience.service";
import type { AdminPostingsRepository } from "./admin-postings.repository";
import { AdminPostingAudienceController } from "./admin-posting-audience.controller";
import {
  AudienceBulkSchema,
  AudienceListQuerySchema,
  AudienceSetSchema,
} from "./admin-posting-audience.dto";
import type {
  AdminPostingAudienceRepository,
  LockedAudiencePosting,
} from "./admin-posting-audience.repository";
import { AdminPostingAudienceService } from "./admin-posting-audience.service";

/**
 * #2956 — an admin decides where a posting shows (Campus only, both, BadaBhai only), without a
 * database: which decisions write what, which are refused with which outcome, that reach follows
 * only a change for BadaBhai workers, and that the routes sit behind the switch and
 * `manage_postings`. Every worker and Campus read obeying the stored audience is proved against
 * Postgres in `admin-posting-audience.db.test.ts`.
 */

const ADMIN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const POSTING = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const HASH = "a".repeat(64);
const CTX: RequestContext = { correlationId: "c", requestId: "r" } as RequestContext;
const REASON = { reason_code: "other" as const, reason_text: "Two openings, RVM students fit" };

/** A live company posting in an RVM trade, today BadaBhai only, no decision yet. */
const posting = (over: Partial<LockedAudiencePosting> = {}): LockedAudiencePosting => ({
  id: POSTING,
  status: "open",
  syncSource: null,
  roleKind: "cnc_turner",
  audience: "badabhai_workers",
  rvmBranchIds: [],
  rvmCourseIds: [],
  hold: null,
  decision: null,
  contentHashNow: HASH,
  reviewStateNow: null,
  ...over,
});

function build(locked: LockedAudiencePosting | undefined, opts: { campusTrades?: string[] } = {}) {
  const tx = {} as Database;
  const trades = new Set(opts.campusTrades ?? ["cnc_turner"]);
  const repo = {
    withTransaction: vi.fn(async (work: (t: Database) => Promise<unknown>) => work(tx)),
    lock: vi.fn(async () => locked),
    isCampusTrade: vi.fn(async (_tx: Database, kind: string) => trades.has(kind)),
    writeAudience: vi.fn(async () => undefined),
    approveAsAdmin: vi.fn(async () => undefined),
    touchReview: vi.fn(async () => undefined),
    decideHold: vi.fn(async () => undefined),
    recordDecision: vi.fn(async () => undefined),
    clearReach: vi.fn(async () => undefined),
    list: vi.fn(async () => []),
  };
  const postingsRepo = { writeAudit: vi.fn(async () => undefined) };
  // The real targeting validation; only the option lookup is faked (branch 99 is not offered).
  const options = {
    activeOptionRefs: vi.fn(
      async (_kind: string, refs: readonly string[]) => new Set(refs.filter((r) => r !== "99")),
    ),
  };
  const audience = new PostingAudienceService(
    {} as FeatureRolloutService,
    options as unknown as PostingAudienceRepository,
    { emit: vi.fn() } as unknown as EventsService,
  );
  const jobPostings = { materializeAfterWorkerVisibility: vi.fn(async () => true) };
  const events = { emit: vi.fn(async (_input: unknown) => undefined) };
  const service = new AdminPostingAudienceService(
    repo as unknown as AdminPostingAudienceRepository,
    postingsRepo as unknown as AdminPostingsRepository,
    audience,
    jobPostings as unknown as JobPostingsService,
    events as unknown as EventsService,
  );
  return { service, repo, postingsRepo, jobPostings, events };
}

const set = (audience: JobPostingAudience, extra: object = {}) => ({
  audience,
  ...REASON,
  ...extra,
});
const eventNames = (events: { emit: { mock: { calls: unknown[][] } } }) =>
  events.emit.mock.calls.map((c) => (c[0] as { event_name: string }).event_name);

describe("the three cases", () => {
  it("case A — CNC turner, 3 openings, to Campus only: writes, approves, records, clears worker reach", async () => {
    const { service, repo, postingsRepo, jobPostings, events } = build(posting());
    expect(await service.set(ADMIN, POSTING, set("rvm_students"), CTX)).toEqual({
      posting_id: POSTING,
      outcome: "changed",
      shown_to: "campus",
    });
    expect(repo.writeAudience).toHaveBeenCalledWith(expect.anything(), POSTING, {
      audience: "rvm_students",
      rvmBranchIds: [],
      rvmCourseIds: [],
    });
    expect(repo.approveAsAdmin).toHaveBeenCalledWith(expect.anything(), POSTING, ADMIN);
    expect(repo.recordDecision).toHaveBeenCalledWith(expect.anything(), POSTING, "rvm_students", ADMIN);
    expect(postingsRepo.writeAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        adminId: ADMIN,
        action: "posting_audience_set",
        entityId: POSTING,
        reasonCode: "other",
        metadata: expect.objectContaining({
          audience_before: "badabhai_workers",
          audience_after: "rvm_students",
          rvm_approved_by_admin: true,
          first_decision: true,
        }),
      }),
    );
    expect(eventNames(events)).toEqual(["job_posting.audience_set", "admin.action_performed"]);
    const audienceSet = events.emit.mock.calls[0]![0] as {
      actor: object;
      payload: { review_state: string; previous_audience: string };
    };
    expect(audienceSet.actor).toEqual({ actor_type: "admin", actor_id: ADMIN });
    expect(audienceSet.payload.review_state).toBe("approved");
    expect(audienceSet.payload.previous_audience).toBe("badabhai_workers");
    // BadaBhai workers no longer see it: reach cleared after the commit, never rebuilt.
    expect(repo.clearReach).toHaveBeenCalledWith(POSTING);
    expect(jobPostings.materializeAfterWorkerVisibility).not.toHaveBeenCalled();
  });

  it("case B — the same job widened to both: approves for Campus, rebuilds worker reach", async () => {
    const { service, repo, jobPostings } = build(posting({ audience: "rvm_students" }));
    expect((await service.set(ADMIN, POSTING, set("both"), CTX)).shown_to).toBe("both");
    expect(repo.approveAsAdmin).toHaveBeenCalled();
    expect(jobPostings.materializeAfterWorkerVisibility).toHaveBeenCalledWith(POSTING, ADMIN, CTX);
    expect(repo.clearReach).not.toHaveBeenCalled();
  });

  it("case C — a painter job cannot go to Campus: refused, nothing written", async () => {
    const { service, repo, postingsRepo, events } = build(posting({ roleKind: "painter_coating" }));
    for (const audience of ["rvm_students", "both"] as const) {
      expect(await service.set(ADMIN, POSTING, set(audience), CTX)).toEqual({
        posting_id: POSTING,
        outcome: "trade_not_taught_at_campus",
        shown_to: "badabhai",
      });
    }
    expect(repo.writeAudience).not.toHaveBeenCalled();
    expect(repo.recordDecision).not.toHaveBeenCalled();
    expect(postingsRepo.writeAudit).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();
  });

  it("case C — confirming a painter job as BadaBhai only records the decision and touches no reach", async () => {
    const { service, repo, jobPostings } = build(posting({ roleKind: "painter_coating" }));
    expect(await service.set(ADMIN, POSTING, set("badabhai_workers"), CTX)).toEqual({
      posting_id: POSTING,
      outcome: "changed",
      shown_to: "badabhai",
    });
    expect(repo.writeAudience).not.toHaveBeenCalled();
    expect(repo.recordDecision).toHaveBeenCalledWith(expect.anything(), POSTING, "badabhai_workers", ADMIN);
    expect(repo.clearReach).not.toHaveBeenCalled();
    expect(jobPostings.materializeAfterWorkerVisibility).not.toHaveBeenCalled();
  });
});

describe("the rules", () => {
  it("not_found for no such posting", async () => {
    const { service } = build(undefined);
    expect(await service.set(ADMIN, POSTING, set("both"), CTX)).toEqual({
      posting_id: POSTING,
      outcome: "not_found",
      shown_to: null,
    });
  });

  it("an agency job's copy stays BadaBhai only", async () => {
    const { service, repo } = build(posting({ syncSource: "agency" }));
    expect((await service.set(ADMIN, POSTING, set("rvm_students"), CTX)).outcome).toBe(
      "twin_not_allowed",
    );
    expect(repo.writeAudience).not.toHaveBeenCalled();
  });

  it("a closed posting is not changed", async () => {
    const { service } = build(posting({ status: "closed" }));
    expect((await service.set(ADMIN, POSTING, set("rvm_students"), CTX)).outcome).toBe(
      "posting_closed",
    );
  });

  it("reaching BadaBhai workers on a live posting needs one of the 16 trades (#2635)", async () => {
    const { service } = build(posting({ roleKind: null, audience: "rvm_students", hold: null }));
    expect((await service.set(ADMIN, POSTING, set("badabhai_workers"), CTX)).outcome).toBe(
      "trade_required",
    );
  });

  it("Campus needs a trade: a posting with none answers trade_required", async () => {
    const { service } = build(posting({ roleKind: null }));
    expect((await service.set(ADMIN, POSTING, set("rvm_students"), CTX)).outcome).toBe(
      "trade_required",
    );
  });

  it("a trade not on the Campus list is refused, whatever the vacancy", async () => {
    const { service } = build(posting({ roleKind: "cnc_turner" }), { campusTrades: [] });
    expect((await service.set(ADMIN, POSTING, set("both"), CTX)).outcome).toBe(
      "trade_not_taught_at_campus",
    );
  });

  it("a branch that is not an active RVM option is refused, nothing written", async () => {
    const { service, repo } = build(posting());
    const result = await service.set(ADMIN, POSTING, set("rvm_students", { rvm_branch_ids: [99] }), CTX);
    expect(result.outcome).toBe("targeting_option_not_offered");
    expect(repo.writeAudience).not.toHaveBeenCalled();
  });

  it("targeting is stored canonically with a choice that includes Campus", async () => {
    const { service, repo } = build(posting());
    await service.set(ADMIN, POSTING, set("both", { rvm_branch_ids: [3, 1, 3] }), CTX);
    expect(repo.writeAudience).toHaveBeenCalledWith(expect.anything(), POSTING, {
      audience: "both",
      rvmBranchIds: [1, 3],
      rvmCourseIds: [],
    });
  });
});

describe("Campus-origin postings (#2891): one control, the hold follows the choice", () => {
  const campus = (over: Partial<LockedAudiencePosting> = {}) =>
    posting({
      roleKind: null,
      audience: "both",
      hold: { state: "off", decided: false, origin: "campus_posted" },
      reviewStateNow: "approved",
      ...over,
    });

  it("Campus only: stores rvm_students, records the hold off as a decision, keeps the approval", async () => {
    const { service, repo, jobPostings } = build(campus(), { campusTrades: [] });
    expect(await service.set(ADMIN, POSTING, set("rvm_students"), CTX)).toEqual({
      posting_id: POSTING,
      outcome: "changed",
      shown_to: "campus",
    });
    // Exempt from the Campus trade list: RVM made the job for its own students.
    expect(repo.isCampusTrade).not.toHaveBeenCalled();
    expect(repo.decideHold).toHaveBeenCalledWith(expect.anything(), POSTING, "off", ADMIN);
    // The audience moved, so the content hash moved: the admin's choice is the new approval.
    expect(repo.approveAsAdmin).toHaveBeenCalled();
    expect(jobPostings.materializeAfterWorkerVisibility).not.toHaveBeenCalled();
    expect(repo.clearReach).not.toHaveBeenCalled();
  });

  it("both: lifts the hold and builds worker reach, once the posting names a trade", async () => {
    const { service, repo, jobPostings } = build(campus({ roleKind: "cad_draughtsman" }));
    expect((await service.set(ADMIN, POSTING, set("both"), CTX)).shown_to).toBe("both");
    expect(repo.writeAudience).not.toHaveBeenCalled(); // already `both`
    expect(repo.approveAsAdmin).not.toHaveBeenCalled(); // the Campus approval still holds
    expect(repo.decideHold).toHaveBeenCalledWith(expect.anything(), POSTING, "on", ADMIN);
    expect(jobPostings.materializeAfterWorkerVisibility).toHaveBeenCalledWith(POSTING, ADMIN, CTX);
  });

  it("both without a trade: trade_required, the hold stays", async () => {
    const { service, repo } = build(campus());
    expect((await service.set(ADMIN, POSTING, set("both"), CTX)).outcome).toBe("trade_required");
    expect(repo.decideHold).not.toHaveBeenCalled();
  });
});

describe("no change, and re-deciding after the company edits", () => {
  it("the same decision for the same content is unchanged: nothing written", async () => {
    const { service, repo, postingsRepo, events } = build(
      posting({
        audience: "rvm_students",
        reviewStateNow: "approved",
        decision: { audience: "rvm_students", contentHash: HASH },
      }),
    );
    expect(await service.set(ADMIN, POSTING, set("rvm_students"), CTX)).toEqual({
      posting_id: POSTING,
      outcome: "unchanged",
      shown_to: "campus",
    });
    expect(repo.recordDecision).not.toHaveBeenCalled();
    expect(postingsRepo.writeAudit).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();
  });

  it("changed since decision (the company edited it): re-approves and records, no audience event", async () => {
    const { service, repo, events } = build(
      posting({
        audience: "rvm_students",
        reviewStateNow: "pending",
        decision: { audience: "rvm_students", contentHash: "b".repeat(64) },
      }),
    );
    expect((await service.set(ADMIN, POSTING, set("rvm_students"), CTX)).outcome).toBe("changed");
    expect(repo.writeAudience).not.toHaveBeenCalled();
    expect(repo.approveAsAdmin).toHaveBeenCalled();
    expect(repo.recordDecision).toHaveBeenCalled();
    expect(eventNames(events)).toEqual(["admin.action_performed"]);
  });

  it("taking a job off Campus bumps its review row so Campus's feed closes it", async () => {
    const { service, repo } = build(
      posting({ audience: "both", reviewStateNow: "approved", roleKind: "cnc_turner" }),
    );
    await service.set(ADMIN, POSTING, set("badabhai_workers"), CTX);
    expect(repo.touchReview).toHaveBeenCalledWith(expect.anything(), POSTING);
    expect(repo.approveAsAdmin).not.toHaveBeenCalled();
  });
});

describe("after the commit", () => {
  it("a reach failure is logged, never thrown: the decision stands", async () => {
    const { service, repo } = build(posting({ audience: "both" }));
    repo.clearReach.mockRejectedValueOnce(new Error("db down"));
    expect((await service.set(ADMIN, POSTING, set("rvm_students"), CTX)).outcome).toBe("changed");
  });

  it("bulk: each posting is its own decision, so one refusal does not stop the rest", async () => {
    const { service, repo } = build(posting());
    repo.lock
      .mockResolvedValueOnce(posting({ roleKind: "painter_coating" }))
      .mockResolvedValueOnce(posting());
    const other = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const { results } = await service.setMany(
      ADMIN,
      { posting_ids: [POSTING, other], audience: "rvm_students", ...REASON },
      CTX,
    );
    expect(results.map((r) => r.outcome)).toEqual(["trade_not_taught_at_campus", "changed"]);
    expect(repo.withTransaction).toHaveBeenCalledTimes(2);
  });
});

describe("the wire contract", () => {
  it("every write needs a reason of 15+ characters with no phone or email in it", () => {
    expect(AudienceSetSchema.safeParse({ audience: "both" }).success).toBe(false);
    expect(
      AudienceSetSchema.safeParse({ audience: "both", reason_code: "other", reason_text: "ok" })
        .success,
    ).toBe(false);
    expect(
      AudienceSetSchema.safeParse({
        audience: "both",
        reason_code: "other",
        reason_text: "call the owner on 9876543210 first",
      }).success,
    ).toBe(false);
    expect(AudienceSetSchema.safeParse(set("both")).success).toBe(true);
  });

  it("targeting only with a choice that includes Campus; [] always accepted", () => {
    expect(AudienceSetSchema.safeParse(set("badabhai_workers", { rvm_branch_ids: [1] })).success).toBe(
      false,
    );
    expect(AudienceSetSchema.safeParse(set("badabhai_workers", { rvm_branch_ids: [] })).success).toBe(
      true,
    );
    expect(AudienceSetSchema.safeParse(set("rvm_students", { rvm_course_ids: ["c1"] })).success).toBe(
      true,
    );
  });

  it("only the three stored audiences", () => {
    expect(AudienceSetSchema.safeParse(set("campus" as JobPostingAudience)).success).toBe(false);
  });

  it("bulk: 1 to 100 distinct uuids, and no actor in the body", () => {
    const ok = set("both");
    expect(AudienceBulkSchema.safeParse({ ...ok, posting_ids: [] }).success).toBe(false);
    expect(AudienceBulkSchema.safeParse({ ...ok, posting_ids: [POSTING, POSTING] }).success).toBe(
      false,
    );
    const many = Array.from({ length: 101 }, (_, i) =>
      `00000000-0000-4000-8000-${i.toString(16).padStart(12, "0")}`,
    );
    expect(AudienceBulkSchema.safeParse({ ...ok, posting_ids: many }).success).toBe(false);
    expect(
      AudienceBulkSchema.safeParse({ ...ok, posting_ids: [POSTING], admin_id: ADMIN }).success,
    ).toBe(false);
    expect(AudienceBulkSchema.safeParse({ ...ok, posting_ids: [POSTING] }).success).toBe(true);
  });

  it("the list defaults to the jobs still to decide", () => {
    expect(AudienceListQuerySchema.parse({})).toEqual({ filter: "to_decide", limit: 50 });
  });
});

describe("the switch — ADMIN_JOB_AUDIENCE_ENABLED", () => {
  it("only true turns it on", () => {
    expect(adminJobAudienceEnabled(undefined)).toBe(false);
    expect(adminJobAudienceEnabled({ ADMIN_JOB_AUDIENCE_ENABLED: false })).toBe(false);
    expect(adminJobAudienceEnabled({ ADMIN_JOB_AUDIENCE_ENABLED: true })).toBe(true);
  });

  it("off: the routes are a neutral 404 for every role", () => {
    const guard = new AdminJobAudienceEnabledGuard({ ADMIN_JOB_AUDIENCE_ENABLED: false });
    expect(() => guard.canActivate()).toThrow(NotFoundException);
    expect(new AdminJobAudienceEnabledGuard({ ADMIN_JOB_AUDIENCE_ENABLED: true }).canActivate()).toBe(
      true,
    );
  });
});

describe("routes — behind the switch, then manage_postings", () => {
  const ROUTES = ["list", "set", "setMany"] as const;
  const proto = AdminPostingAudienceController.prototype as unknown as Record<string, object>;
  const guard = new AdminRolesGuard(new Reflector());
  const admin = (role: AdminRole): AuthenticatedAdmin => ({ id: "a", role, sid: "s" });
  const ctxFor = (method: string, who: AuthenticatedAdmin | undefined): ExecutionContext => {
    const handler = () => undefined;
    Reflect.defineMetadata(
      ADMIN_CAPABILITY_KEY,
      Reflect.getMetadata(ADMIN_CAPABILITY_KEY, proto[method]!),
      handler,
    );
    return {
      getHandler: () => handler,
      getClass: () => AdminPostingAudienceController,
      switchToHttp: () => ({ getRequest: () => ({ admin: who }) }),
    } as unknown as ExecutionContext;
  };

  it("exposes exactly the list, one-posting and bulk routes; the switch runs before the roles", () => {
    const methods = Object.getOwnPropertyNames(proto).filter((m) => m !== "constructor");
    expect(methods.sort()).toEqual([...ROUTES].sort());
    const guards = (Reflect.getMetadata("__guards__", AdminPostingAudienceController) ?? []) as {
      name: string;
    }[];
    expect(guards.map((g) => g.name)).toEqual([
      AdminAuthGuard.name,
      AdminJobAudienceEnabledGuard.name,
      AdminRolesGuard.name,
    ]);
  });

  it.each(ROUTES)("%s: super_admin + ops_admin allowed; support + analyst 403; none 401", (r) => {
    expect(Reflect.getMetadata(ADMIN_CAPABILITY_KEY, proto[r]!)).toBe("manage_postings");
    expect(guard.canActivate(ctxFor(r, admin("super_admin")))).toBe(true);
    expect(guard.canActivate(ctxFor(r, admin("ops_admin")))).toBe(true);
    expect(() => guard.canActivate(ctxFor(r, admin("support")))).toThrow(ForbiddenException);
    expect(() => guard.canActivate(ctxFor(r, admin("analyst")))).toThrow(ForbiddenException);
    expect(() => guard.canActivate(ctxFor(r, undefined))).toThrow(UnauthorizedException);
  });
});
