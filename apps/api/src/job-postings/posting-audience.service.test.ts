import "reflect-metadata";
import { BadRequestException, NotFoundException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import type { InstituteReviewState } from "@badabhai/db";

import type { RequestContext } from "../common/request-context";
import type { PayerTenantScope, TenantKey } from "../payers/payer-tenant-scope";
import type { JobPostingApi } from "./job-postings.repository";
import { AUDIENCE_REFUSAL_REASONS, PostingAudienceService } from "./posting-audience.service";
import type { RvmReviewFacts } from "./rvm-review-view";

/**
 * #2746 — the audience rules, with the repository and the switch faked. The SQL (the review row
 * writes, the live-hash read, the options) runs against Postgres in
 * `payer-portal/payer-job-audience.db.test.ts`.
 */

// A test may build a key from a literal: the brand guards production call sites, not fixtures.
const SCOPE: PayerTenantScope = {
  actorPayerId: "aaaaaaaa-0000-4000-8000-000000000001",
  tenantKey: "aaaaaaaa-0000-4000-8000-000000000001" as TenantKey,
  orgId: null,
  orgRole: null,
  mode: "off",
};
const CTX: RequestContext = {
  correlationId: "11111111-1111-4111-8111-111111111111",
  requestId: "r",
};
const ACTOR = { actor_type: "payer" as const, actor_id: SCOPE.actorPayerId };
const P1 = "bbbbbbbb-0000-4000-8000-000000000001";
const P2 = "bbbbbbbb-0000-4000-8000-000000000002";
const P3 = "bbbbbbbb-0000-4000-8000-000000000003";

function posting(over: Partial<JobPostingApi> = {}): JobPostingApi {
  return {
    id: P1,
    role_title: "VMC Operator",
    status: "draft",
    audience: "badabhai_workers",
    rvm_branch_ids: [],
    rvm_course_ids: [],
    ...over,
  } as JobPostingApi;
}

/** Active options: branches 1–3, courses `cnc` and `cad`. Branch 9 / course `old` exist but retired. */
const ACTIVE = { branch: new Set(["1", "2", "3"]), course: new Set(["cnc", "cad"]) };

function make(opts: { enabled?: boolean; reviews?: Map<string, RvmReviewFacts> } = {}) {
  const rollout = { isEnabledFor: vi.fn(async () => opts.enabled ?? true) };
  const repo = {
    activeOptionRefs: vi.fn(async (kind: "branch" | "course", refs: readonly string[]) => {
      return new Set(refs.filter((r) => ACTIVE[kind].has(r)));
    }),
    listActiveOptions: vi.fn(async () => [
      { kind: "branch" as const, ref: "2", label: "Pune", sortOrder: 2 },
      { kind: "branch" as const, ref: "1", label: "Faridabad", sortOrder: 1 },
      { kind: "course" as const, ref: "cnc", label: "CNC Programming", sortOrder: 0 },
    ]),
    ensurePendingReview: vi.fn(async () => undefined),
    resetStaleDecision: vi.fn(async () => false),
    touchReview: vi.fn(async () => undefined),
    reviewStatesFor: vi.fn(async (ids: readonly string[]) => {
      const all = opts.reviews ?? new Map<string, RvmReviewFacts>();
      return new Map([...all].filter(([id]) => ids.includes(id)));
    }),
  };
  const events = { emit: vi.fn(async (_p: Record<string, unknown>) => undefined) };
  const svc = new PostingAudienceService(rollout as never, repo as never, events as never);
  return { svc, rollout, repo, events };
}

const TX = { tx: "open" } as never;

describe("requestedBy — the switch gates the capability, never stored state", () => {
  it("a body with no audience field reads no switch", async () => {
    const d = make();
    expect(await d.svc.requestedBy(SCOPE, {})).toBeNull();
    expect(d.rollout.isEnabledFor).not.toHaveBeenCalled();
  });

  it("switch off for the company: the fields are ignored (null), not refused", async () => {
    const d = make({ enabled: false });
    await expect(
      d.svc.requestedBy(SCOPE, { audience: "rvm_students", rvm_branch_ids: [1] }),
    ).resolves.toBeNull();
    expect(d.rollout.isEnabledFor).toHaveBeenCalledWith("job_audience", SCOPE.tenantKey);
  });

  it("switch on: exactly the sent fields come back", async () => {
    const d = make();
    expect(await d.svc.requestedBy(SCOPE, { rvm_course_ids: ["cnc"] })).toEqual({
      rvm_course_ids: ["cnc"],
    });
  });
});

describe("resolveCreate / resolveWrite — deterministic validation", () => {
  it("a create that sends the default stores the default (null)", async () => {
    const d = make();
    expect(await d.svc.resolveCreate(SCOPE, { audience: "badabhai_workers" })).toBeNull();
  });

  it("an RVM create stores the audience and canonical (sorted, de-duplicated) targeting", async () => {
    const d = make();
    expect(
      await d.svc.resolveCreate(SCOPE, {
        audience: "rvm_students",
        rvm_branch_ids: [3, 1, 3],
        rvm_course_ids: ["cnc", "cad"],
      }),
    ).toEqual({ audience: "rvm_students", rvmBranchIds: [1, 3], rvmCourseIds: ["cad", "cnc"] });
  });

  it("`both` with no targeting is every branch and course", async () => {
    const d = make();
    expect(await d.svc.resolveCreate(SCOPE, { audience: "both" })).toEqual({
      audience: "both",
      rvmBranchIds: [],
      rvmCourseIds: [],
    });
    expect(d.repo.activeOptionRefs).not.toHaveBeenCalled();
  });

  it("targeting without an RVM audience is a 400 with a reason", async () => {
    const d = make();
    const err = await d.svc.resolveCreate(SCOPE, { rvm_branch_ids: [1] }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect((err as BadRequestException).getResponse()).toMatchObject({
      reason: AUDIENCE_REFUSAL_REASONS.targetingNeedsRvmAudience,
    });
    // `[]` says "no targeting" and is fine on any audience.
    expect(
      await d.svc.resolveCreate(SCOPE, { audience: "badabhai_workers", rvm_branch_ids: [] }),
    ).toBeNull();
  });

  it("an id that is not an ACTIVE option of its kind is a 400 naming the id", async () => {
    const d = make();
    for (const body of [
      { audience: "rvm_students" as const, rvm_branch_ids: [9] },
      { audience: "rvm_students" as const, rvm_course_ids: ["old"] },
      { audience: "both" as const, rvm_course_ids: ["1"] }, // a branch ref is not a course
    ]) {
      const err = await d.svc.resolveCreate(SCOPE, body).catch((e: unknown) => e);
      expect(err, JSON.stringify(body)).toBeInstanceOf(BadRequestException);
      expect((err as BadRequestException).getResponse()).toMatchObject({
        reason: AUDIENCE_REFUSAL_REASONS.targetingOptionNotOffered,
      });
    }
  });

  it("an id the posting ALREADY holds stays valid after Campus retires it", async () => {
    const d = make();
    const current = posting({ audience: "both", rvm_branch_ids: [9], rvm_course_ids: [] });
    expect(await d.svc.resolveWrite({ rvm_branch_ids: [9, 2] }, current)).toEqual({
      audience: "both",
      rvmBranchIds: [2, 9],
      rvmCourseIds: [],
    });
    // Only the new id was checked.
    expect(d.repo.activeOptionRefs).toHaveBeenCalledWith("branch", ["2"], undefined);
  });

  it("targeting alone edits an RVM posting and keeps its audience", async () => {
    const d = make();
    const current = posting({ audience: "rvm_students", rvm_branch_ids: [1] });
    expect(await d.svc.resolveWrite({ rvm_branch_ids: [2] }, current)).toEqual({
      audience: "rvm_students",
      rvmBranchIds: [2],
      rvmCourseIds: [],
    });
  });

  it("targeting alone on a BadaBhai-only posting is refused", async () => {
    const d = make();
    await expect(d.svc.resolveWrite({ rvm_course_ids: ["cnc"] }, posting())).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it("withdrawing the RVM part clears the targeting with it", async () => {
    const d = make();
    const current = posting({ audience: "both", rvm_branch_ids: [1], rvm_course_ids: ["cnc"] });
    expect(await d.svc.resolveWrite({ audience: "badabhai_workers" }, current)).toEqual({
      audience: "badabhai_workers",
      rvmBranchIds: [],
      rvmCourseIds: [],
    });
  });

  it("re-sending what is stored is no change (null), in any order", async () => {
    const d = make();
    const current = posting({ audience: "both", rvm_branch_ids: [1, 3], rvm_course_ids: ["cad"] });
    expect(
      await d.svc.resolveWrite(
        { audience: "both", rvm_branch_ids: [3, 1], rvm_course_ids: ["cad"] },
        current,
      ),
    ).toBeNull();
  });
});

describe("recordCreateWithin / recordUpdateWithin — the review row and the event", () => {
  it("an RVM create opens a pending row and emits audience_set (no previous audience)", async () => {
    const d = make({
      reviews: new Map([[P1, { stateNow: "pending", reason: null, reviewedAt: null }]]),
    });
    const created = posting({ audience: "both", rvm_branch_ids: [1], rvm_course_ids: ["cnc"] });
    await d.svc.recordCreateWithin(TX, created, ACTOR, CTX);
    expect(d.repo.ensurePendingReview).toHaveBeenCalledWith(P1, TX);
    expect(d.events.emit).toHaveBeenCalledTimes(1);
    expect(d.events.emit.mock.calls[0]![0]).toMatchObject({
      event_name: "job_posting.audience_set",
      actor: ACTOR,
      subject: { subject_type: "job_posting", subject_id: P1 },
      tx: TX,
      payload: {
        job_posting_id: P1,
        audience: "both",
        previous_audience: null,
        branch_ids: [1],
        course_ids: ["cnc"],
        review_state: "pending",
      },
    });
  });

  it("a content-only edit resets a stale decision and emits nothing of its own", async () => {
    const d = make();
    await d.svc.recordUpdateWithin(TX, posting({ audience: "both" }), "both", false, ACTOR, CTX);
    expect(d.repo.resetStaleDecision).toHaveBeenCalledWith(P1, TX);
    expect(d.repo.ensurePendingReview).not.toHaveBeenCalled();
    expect(d.repo.touchReview).not.toHaveBeenCalled();
    expect(d.events.emit).not.toHaveBeenCalled();
  });

  it("an audience change to RVM opens, resets, bumps the row and emits with the previous audience", async () => {
    const d = make({
      reviews: new Map([[P1, { stateNow: "pending", reason: null, reviewedAt: null }]]),
    });
    await d.svc.recordUpdateWithin(
      TX,
      posting({ audience: "rvm_students" }),
      "badabhai_workers",
      true,
      ACTOR,
      CTX,
    );
    expect(d.repo.ensurePendingReview).toHaveBeenCalledWith(P1, TX);
    expect(d.repo.resetStaleDecision).toHaveBeenCalledWith(P1, TX);
    expect(d.repo.touchReview).toHaveBeenCalledWith(P1, TX);
    expect(d.events.emit.mock.calls[0]![0]).toMatchObject({
      payload: {
        audience: "rvm_students",
        previous_audience: "badabhai_workers",
        review_state: "pending",
      },
    });
  });

  it("a withdrawal keeps the row (bumped, never deleted) and reports no review state", async () => {
    const d = make();
    await d.svc.recordUpdateWithin(TX, posting(), "both", true, ACTOR, CTX);
    expect(d.repo.ensurePendingReview).not.toHaveBeenCalled();
    expect(d.repo.touchReview).toHaveBeenCalledWith(P1, TX);
    expect(d.repo.reviewStatesFor).not.toHaveBeenCalled();
    expect(d.events.emit.mock.calls[0]![0]).toMatchObject({
      payload: { audience: "badabhai_workers", previous_audience: "both", review_state: null },
    });
  });
});

describe("payerViews — stored state is always visible, the switch only adds the default's block", () => {
  const facts = (
    stateNow: InstituteReviewState | null,
    reason: string | null = null,
  ): RvmReviewFacts => ({
    stateNow,
    reason,
    reviewedAt: stateNow === "pending" ? null : new Date("2026-11-14T10:00:00Z"),
  });

  it("switch off: a default posting carries no audience field at all", async () => {
    const d = make({ enabled: false });
    const [view] = await d.svc.payerViews(SCOPE, [posting()]);
    for (const key of ["audience", "rvm_branch_ids", "rvm_course_ids", "rvm_review"]) {
      expect(view).not.toHaveProperty(key);
    }
  });

  it("switch off: an RVM posting still shows its audience and review", async () => {
    const d = make({ enabled: false, reviews: new Map([[P1, facts("pending")]]) });
    const [view] = await d.svc.payerViews(SCOPE, [
      posting({ audience: "rvm_students", rvm_branch_ids: [1] }),
    ]);
    expect(view).toMatchObject({
      audience: "rvm_students",
      rvm_branch_ids: [1],
      rvm_course_ids: [],
      rvm_review: { state: "pending" },
    });
  });

  it("switch on: a default posting shows its audience with no review", async () => {
    const d = make({ enabled: true });
    const [view] = await d.svc.payerViews(SCOPE, [posting()]);
    expect(view).toMatchObject({ audience: "badabhai_workers", rvm_review: null });
  });

  it("maps decisions: approved and rejected carry their time and note, a pending one neither", async () => {
    const reviews = new Map([
      [P1, facts("approved")],
      [P2, facts("rejected", "Please state the stipend")],
      [P3, facts("pending")],
    ]);
    const d = make({ reviews });
    const views = await d.svc.payerViews(SCOPE, [
      posting({ id: P1, audience: "both" }),
      posting({ id: P2, audience: "rvm_students" }),
      posting({ id: P3, audience: "rvm_students" }),
    ]);
    expect(views.map((v) => v.rvm_review)).toEqual([
      { state: "approved", reviewed_at: new Date("2026-11-14T10:00:00Z") },
      {
        state: "rejected",
        reviewed_at: new Date("2026-11-14T10:00:00Z"),
        reason: "Please state the stipend",
      },
      { state: "pending" },
    ]);
  });

  it("an RVM posting with no review row reads pending (no row is not approved)", async () => {
    const d = make();
    const [view] = await d.svc.payerViews(SCOPE, [posting({ audience: "both" })]);
    expect(view?.rvm_review).toEqual({ state: "pending" });
  });

  it("a page costs one switch read and one review read, for the RVM postings only", async () => {
    const d = make({ enabled: false });
    await d.svc.payerViews(SCOPE, [
      posting({ id: P1 }),
      posting({ id: P2, audience: "both" }),
      posting({ id: P3, audience: "rvm_students" }),
    ]);
    expect(d.rollout.isEnabledFor).toHaveBeenCalledTimes(1);
    expect(d.repo.reviewStatesFor).toHaveBeenCalledTimes(1);
    expect(d.repo.reviewStatesFor).toHaveBeenCalledWith([P2, P3]);
  });

  it("no switch read when every posting holds a non-default audience", async () => {
    const d = make();
    await d.svc.payerViews(SCOPE, [posting({ audience: "both" })]);
    expect(d.rollout.isEnabledFor).not.toHaveBeenCalled();
  });
});

describe("optionsFor — GET audience-options", () => {
  it("is the neutral 404 while the switch is off for the company", async () => {
    const d = make({ enabled: false });
    await expect(d.svc.optionsFor(SCOPE)).rejects.toBeInstanceOf(NotFoundException);
    expect(d.repo.listActiveOptions).not.toHaveBeenCalled();
  });

  it("returns the audiences and the active options, branch ids as numbers", async () => {
    const d = make();
    expect(await d.svc.optionsFor(SCOPE)).toEqual({
      audiences: ["badabhai_workers", "rvm_students", "both"],
      branches: [
        { id: 2, label: "Pune", sort_order: 2 },
        { id: 1, label: "Faridabad", sort_order: 1 },
      ],
      courses: [{ id: "cnc", label: "CNC Programming", sort_order: 0 }],
    });
  });
});
