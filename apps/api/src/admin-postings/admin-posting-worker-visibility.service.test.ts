import "reflect-metadata";
import { describe, expect, it, vi } from "vitest";
import { ForbiddenException, UnauthorizedException, type ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { AdminRole, Database } from "@badabhai/db";
import { AdminAuthGuard, type AuthenticatedAdmin } from "../admin/admin-auth.guard";
import { ADMIN_CAPABILITY_KEY, AdminRolesGuard } from "../admin/admin-roles.guard";
import type { RequestContext } from "../common/request-context";
import type { EventsService } from "../events/events.service";
import type { JobPostingsService } from "../job-postings/job-postings.service";
import type { AdminPostingsRepository } from "./admin-postings.repository";
import { AdminPostingWorkerVisibilityController } from "./admin-posting-worker-visibility.controller";
import {
  WorkerVisibilityBulkSchema,
  WorkerVisibilityListQuerySchema,
  WorkerVisibilitySetSchema,
} from "./admin-posting-worker-visibility.dto";
import type {
  AdminPostingWorkerVisibilityRepository,
  LockedVisibility,
} from "./admin-posting-worker-visibility.repository";
import {
  AdminPostingWorkerVisibilityService,
  decodeCursor,
  encodeCursor,
} from "./admin-posting-worker-visibility.service";

/**
 * #2891 — the admin control of a Campus-origin posting's BadaBhai worker visibility, without a
 * database: which requests write, which are refused with which outcome, that reach follows only a
 * change, and that the routes sit behind `manage_postings`. The worker side (every read hides a
 * held posting) is proved against Postgres in `job-audience-visibility.db.test.ts`.
 */

const ADMIN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const POSTING = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CTX: RequestContext = { correlationId: "c", requestId: "r" } as RequestContext;
const REASON = { reason_code: "other" as const, reason_text: "Campus job checked by ops today" };
const TRADE = "cad_draughtsman";

function build(locked: LockedVisibility | undefined) {
  const tx = {} as Database;
  const repo = {
    withTransaction: vi.fn(async (work: (t: Database) => Promise<unknown>) => work(tx)),
    lock: vi.fn(async () => locked),
    decide: vi.fn(async () => undefined),
    clearReach: vi.fn(async () => undefined),
    list: vi.fn(async () => []),
  };
  const postingsRepo = { writeAudit: vi.fn(async () => undefined) };
  const jobPostings = { materializeAfterWorkerVisibility: vi.fn(async () => true) };
  const events = { emit: vi.fn(async (_input: unknown) => undefined) };
  const service = new AdminPostingWorkerVisibilityService(
    repo as unknown as AdminPostingWorkerVisibilityRepository,
    postingsRepo as unknown as AdminPostingsRepository,
    jobPostings as unknown as JobPostingsService,
    events as unknown as EventsService,
  );
  return { service, repo, postingsRepo, jobPostings, events };
}

const held = (over: Partial<LockedVisibility> = {}): LockedVisibility => ({
  state: "off",
  decided: false,
  origin: "campus_posted",
  audience: "both",
  roleKind: TRADE,
  ...over,
});

describe("set — what is written, and what is refused", () => {
  it("on, for a waiting posting with a trade: decides, audits, emits, then builds reach", async () => {
    const { service, repo, postingsRepo, jobPostings, events } = build(held());
    expect(await service.set(ADMIN, POSTING, { state: "on", ...REASON }, CTX)).toEqual({
      posting_id: POSTING,
      outcome: "changed",
      state: "on",
    });
    expect(repo.decide).toHaveBeenCalledWith(expect.anything(), POSTING, "on", ADMIN);
    expect(postingsRepo.writeAudit).toHaveBeenCalledWith(expect.anything(), {
      adminId: ADMIN,
      action: "posting_worker_visibility_on",
      entityType: "job_posting",
      entityId: POSTING,
      reasonCode: "other",
      reasonText: REASON.reason_text,
      metadata: {
        worker_visibility_before: "off",
        worker_visibility_after: "on",
        first_decision: true,
        origin: "campus_posted",
      },
    });
    const emitted = events.emit.mock.calls[0]![0] as unknown as {
      event_name: string;
      payload: object;
    };
    expect(emitted.event_name).toBe("admin.action_performed");
    // The spine carries the CODE only: no reason, no state.
    expect(emitted.payload).toEqual({
      admin_id: ADMIN,
      action_code: "posting_worker_visibility_on",
      target_type: "job_posting",
      target_id: POSTING,
    });
    expect(jobPostings.materializeAfterWorkerVisibility).toHaveBeenCalledWith(POSTING, ADMIN, CTX);
    expect(repo.clearReach).not.toHaveBeenCalled();
  });

  it("off, for an opened posting: decides and clears reach", async () => {
    const { service, repo, jobPostings } = build(held({ state: "on", decided: true }));
    const out = await service.set(ADMIN, POSTING, { state: "off", ...REASON }, CTX);
    expect(out.outcome).toBe("changed");
    expect(repo.clearReach).toHaveBeenCalledWith(POSTING);
    expect(jobPostings.materializeAfterWorkerVisibility).not.toHaveBeenCalled();
  });

  it("off, for a WAITING posting, is a decision: it leaves the waiting list", async () => {
    const { service, repo, postingsRepo } = build(held());
    expect((await service.set(ADMIN, POSTING, { state: "off", ...REASON }, CTX)).outcome).toBe(
      "changed",
    );
    expect(repo.decide).toHaveBeenCalledWith(expect.anything(), POSTING, "off", ADMIN);
    expect(postingsRepo.writeAudit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "posting_worker_visibility_off" }),
    );
  });

  it.each([
    ["not Campus-origin (no row)", undefined, "on", "not_campus_origin", null],
    ["already on", held({ state: "on", decided: true }), "on", "unchanged", "on"],
    ["already decided off", held({ decided: true }), "off", "unchanged", "off"],
    [
      "the company narrowed it to RVM students",
      held({ audience: "rvm_students" }),
      "on",
      "audience_excludes_workers",
      "off",
    ],
    ["no trade (#2635)", held({ roleKind: null }), "on", "trade_required", "off"],
    ["a role outside the 16", held({ roleKind: "polymer_operator" }), "on", "trade_required", "off"],
  ] as const)("%s: %s → nothing written, no reach touched", async (_l, locked, state, outcome, after) => {
    const { service, repo, postingsRepo, events, jobPostings } = build(locked);
    expect(await service.set(ADMIN, POSTING, { state, ...REASON }, CTX)).toEqual({
      posting_id: POSTING,
      outcome,
      state: after,
    });
    expect(repo.decide).not.toHaveBeenCalled();
    expect(postingsRepo.writeAudit).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();
    expect(repo.clearReach).not.toHaveBeenCalled();
    expect(jobPostings.materializeAfterWorkerVisibility).not.toHaveBeenCalled();
  });

  it("a reach failure after the commit is logged, never thrown: the decision stands", async () => {
    const { service, jobPostings } = build(held());
    jobPostings.materializeAfterWorkerVisibility.mockRejectedValueOnce(new Error("boom"));
    expect((await service.set(ADMIN, POSTING, { state: "on", ...REASON }, CTX)).outcome).toBe(
      "changed",
    );
  });
});

describe("setMany — one decision per posting, each on its own", () => {
  it("answers every id in order, and a refusal does not stop the rest", async () => {
    const { service, repo } = build(held());
    const other = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    repo.lock.mockResolvedValueOnce(undefined).mockResolvedValueOnce(held());
    const out = await service.setMany(
      ADMIN,
      { posting_ids: [other, POSTING], state: "on", ...REASON },
      CTX,
    );
    expect(out.results).toEqual([
      { posting_id: other, outcome: "not_campus_origin", state: null },
      { posting_id: POSTING, outcome: "changed", state: "on" },
    ]);
    expect(repo.withTransaction).toHaveBeenCalledTimes(2);
  });
});

describe("the wire contract", () => {
  it("every write needs a reason of 15+ characters with no phone or email in it", () => {
    expect(WorkerVisibilitySetSchema.safeParse({ state: "on" }).success).toBe(false);
    expect(
      WorkerVisibilitySetSchema.safeParse({ state: "on", reason_code: "other", reason_text: "ok" })
        .success,
    ).toBe(false);
    expect(
      WorkerVisibilitySetSchema.safeParse({
        state: "on",
        reason_code: "other",
        reason_text: "call the owner on 9876543210 first",
      }).success,
    ).toBe(false);
    expect(WorkerVisibilitySetSchema.safeParse({ state: "on", ...REASON }).success).toBe(true);
  });

  it("bulk: 1 to 100 distinct uuids, and no actor in the body", () => {
    const ok = { state: "off", ...REASON };
    expect(WorkerVisibilityBulkSchema.safeParse({ ...ok, posting_ids: [] }).success).toBe(false);
    expect(
      WorkerVisibilityBulkSchema.safeParse({ ...ok, posting_ids: [POSTING, POSTING] }).success,
    ).toBe(false);
    const many = Array.from({ length: 101 }, (_, i) =>
      `00000000-0000-4000-8000-${i.toString(16).padStart(12, "0")}`,
    );
    expect(WorkerVisibilityBulkSchema.safeParse({ ...ok, posting_ids: many }).success).toBe(false);
    expect(
      WorkerVisibilityBulkSchema.safeParse({ ...ok, posting_ids: [POSTING], admin_id: ADMIN })
        .success,
    ).toBe(false);
    expect(WorkerVisibilityBulkSchema.safeParse({ ...ok, posting_ids: [POSTING] }).success).toBe(
      true,
    );
  });

  it("the list defaults to the waiting postings", () => {
    expect(WorkerVisibilityListQuerySchema.parse({})).toEqual({ filter: "waiting", limit: 50 });
  });

  it("the cursor round-trips, and a forged one is a 400", () => {
    const at = new Date("2026-11-17T10:00:00.000Z");
    expect(decodeCursor(encodeCursor({ createdAt: at, id: POSTING }))).toEqual({
      createdAt: at,
      id: POSTING,
    });
    expect(() => decodeCursor("not-a-cursor")).toThrow();
  });
});

describe("routes — manage_postings only", () => {
  const ROUTES = ["list", "set", "setMany"] as const;
  const proto = AdminPostingWorkerVisibilityController.prototype as unknown as Record<
    string,
    object
  >;
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
      getClass: () => AdminPostingWorkerVisibilityController,
      switchToHttp: () => ({ getRequest: () => ({ admin: who }) }),
    } as unknown as ExecutionContext;
  };

  it("exposes exactly the list, one-posting and bulk routes, behind both admin guards", () => {
    const methods = Object.getOwnPropertyNames(proto).filter((m) => m !== "constructor");
    expect(methods.sort()).toEqual([...ROUTES].sort());
    const guards = (Reflect.getMetadata("__guards__", AdminPostingWorkerVisibilityController) ??
      []) as { name: string }[];
    expect(guards.map((g) => g.name)).toEqual([AdminAuthGuard.name, AdminRolesGuard.name]);
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
