import "reflect-metadata";
import {
  BadRequestException,
  ConflictException,
  HttpException,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Database, InstituteReviewState } from "@badabhai/db";

import type { EventsService } from "../events/events.service";
import type { FeatureRolloutService } from "../feature-rollout/feature-rollout.service";
import type { PostingAudienceRepository } from "../job-postings/posting-audience.repository";
import type { PayerTenantScope, TenantKey } from "../payers/payer-tenant-scope";
import type { PayerTenantScopeService } from "../payers/payer-tenant-scope.service";
import { CAMPUS_MAX_CLOCK_SKEW_MS, CAMPUS_RESET_FLOOR_TOLERANCE_MS } from "./campus-link.contract";
import type {
  CampusPostingReviewRepository,
  DecisionWrite,
  DecisionWriteResult,
  LockedReview,
  LockedReviewTarget,
} from "./campus-posting-review.repository";
import {
  CampusPostingReviewService,
  type CampusReviewDecision,
} from "./campus-posting-review.service";

/**
 * #2746 PR 5 — the review rules, with the repository, the switch, the tenancy resolver and the
 * events faked. The SQL (the locked hash read, the ensured and locked review row, the guarded
 * upsert, the lock order against a company edit and against a second decision) runs against
 * Postgres in `campus-review.db.test.ts`.
 */

const POSTING = "bbbbbbbb-0000-4000-8000-000000000001";
const OWNER = "aaaaaaaa-0000-4000-8000-000000000001";
const ANCHOR = "aaaaaaaa-0000-4000-8000-0000000000aa";
const STAFF = "9A8B7C6D-5E4F-4A3B-8C2D-1E0F9A8B7C6D";
const CALL_ID = "cccccccc-0000-4000-8000-000000000001";
const HASH = "a".repeat(64);
const OTHER_HASH = "b".repeat(64);
const DECIDED_AT = "2026-11-14T10:00:00.000+05:30";
const CALL = {
  ctx: { correlationId: "11111111-1111-4111-8111-111111111111", requestId: "r" },
  callId: CALL_ID,
};

/** Hidden characters from code points, never typed. */
const RLO = String.fromCharCode(0x202e);
const ZWSP = String.fromCharCode(0x200b);
const NEWLINE = String.fromCharCode(0x0a);

function target(over: Partial<LockedReviewTarget> = {}): LockedReviewTarget {
  return {
    id: POSTING,
    ownerPayerId: OWNER,
    status: "open",
    hidden: false,
    audience: "rvm_students",
    rvmBranchIds: [1, 2],
    rvmCourseIds: [],
    contentHash: HASH,
    ...over,
  };
}

function decision(over: Partial<CampusReviewDecision> = {}): CampusReviewDecision {
  return {
    state: "approved",
    reviewer_ref: STAFF,
    content_hash: HASH,
    decided_at: DECIDED_AT,
    ...over,
  };
}

/** The review row as `lockReview` reports it; a pending row unless a test says otherwise. */
const PENDING: LockedReview = {
  state: "pending",
  timing: "none",
  sameDecision: false,
  insertedByThisCall: false,
};

/** A row as a test describes it; `insertedByThisCall` defaults to false. */
type HeldRow = Omit<LockedReview, "insertedByThisCall"> & { insertedByThisCall?: boolean };

interface Setup {
  live?: boolean;
  enabled?: boolean;
  /** The owner's scope as the read-only resolver answers; `null` = no membership / denied. */
  scope?: PayerTenantScope | null;
  resolveError?: Error;
  unlocked?: LockedReviewTarget | undefined;
  locked?: LockedReviewTarget | undefined;
  held?: HeldRow;
  stateNow?: InstituteReviewState;
  write?: DecisionWriteResult;
  activeCourses?: readonly string[];
}

// A test may build a key from a literal: the brand guards production call sites, not fixtures.
const OWNER_SCOPE: PayerTenantScope = {
  actorPayerId: OWNER,
  tenantKey: ANCHOR as TenantKey,
  orgId: null,
  orgRole: null,
  mode: "on",
};

function make(opts: Setup = {}) {
  const tx = { tx: true } as unknown as Database;
  const unlocked = "unlocked" in opts ? opts.unlocked : target();
  const locked = "locked" in opts ? opts.locked : unlocked;
  const repo = {
    findTarget: vi.fn(async () => unlocked),
    withTransaction: vi.fn(async <T>(work: (t: Database) => Promise<T>) => work(tx)),
    lockTarget: vi.fn(async () => locked),
    lockReview: vi.fn(
      async (
        _tx: Database,
        _write: DecisionWrite,
        _pendingFloorMs: number,
      ): Promise<LockedReview> => ({
        ...PENDING,
        ...opts.held,
      }),
    ),
    reviewStateNow: vi.fn(async () => opts.stateNow ?? ("pending" as InstituteReviewState)),
    writeDecision: vi.fn(
      async (
        _tx: Database,
        _input: DecisionWrite,
        _floor: { toleranceMs: number; insertedByThisCall: boolean },
      ): Promise<DecisionWriteResult> => opts.write ?? { outcome: "written", contentHash: HASH },
    ),
    writeAudit: vi.fn(async () => undefined),
  };
  const active = new Set(opts.activeCourses ?? ["cnc", "cad"]);
  const options = {
    activeOptionRefs: vi.fn(async (_kind: string, refs: readonly string[]) => {
      return new Set(refs.filter((r) => active.has(r)));
    }),
  };
  const rollout = {
    isLiveForServiceCaller: vi.fn(() => opts.live ?? true),
    isEnabledFor: vi.fn(async () => opts.enabled ?? true),
  };
  const tenancy = {
    resolveReadOnly: vi.fn(async () => {
      if (opts.resolveError) throw opts.resolveError;
      return "scope" in opts ? (opts.scope ?? null) : OWNER_SCOPE;
    }),
    // Must never be reached: it can heal (write a solo org).
    resolve: vi.fn(async () => {
      throw new Error("resolve() must not be called from a Campus review");
    }),
  };
  const events = {
    emit: vi.fn(async () => ({ event_id: "eeeeeeee-0000-4000-8000-000000000001" })),
  };
  const service = new CampusPostingReviewService(
    repo as unknown as CampusPostingReviewRepository,
    options as unknown as PostingAudienceRepository,
    rollout as unknown as FeatureRolloutService,
    tenancy as unknown as PayerTenantScopeService,
    events as unknown as EventsService,
  );
  return { service, repo, options, rollout, tenancy, events, tx };
}

async function refusal(promise: Promise<unknown>): Promise<HttpException> {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(HttpException);
  return err as HttpException;
}

function codeOf(err: HttpException): unknown {
  const body = err.getResponse();
  return typeof body === "object" && body !== null ? (body as { code?: unknown }).code : undefined;
}

/** Nothing of a decision was stored: no write, no event, no audit row. */
function expectNothingStored(m: ReturnType<typeof make>): void {
  expect(m.repo.writeDecision).not.toHaveBeenCalled();
  expect(m.events.emit).not.toHaveBeenCalled();
  expect(m.repo.writeAudit).not.toHaveBeenCalled();
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("CampusPostingReviewService — decided_at may not be from BadaBhai's future", () => {
  it("refuses a decided_at more than the skew bound ahead, with 400 VALIDATION_FAILED, before any read", async () => {
    const m = make();
    const ahead = new Date(Date.now() + CAMPUS_MAX_CLOCK_SKEW_MS + 60_000).toISOString();
    const err = await refusal(m.service.review(POSTING, decision({ decided_at: ahead }), CALL));
    expect(err).toBeInstanceOf(BadRequestException);
    expect(codeOf(err)).toBe("VALIDATION_FAILED");
    expect(JSON.stringify(err.getResponse())).toContain("decided_at");
    expect(m.repo.findTarget).not.toHaveBeenCalled();
  });

  it("accepts a decided_at inside the bound (a clock a little ahead)", async () => {
    const m = make();
    const ahead = new Date(Date.now() + CAMPUS_MAX_CLOCK_SKEW_MS - 10_000).toISOString();
    await m.service.review(POSTING, decision({ decided_at: ahead }), CALL);
    expect(m.repo.writeDecision).toHaveBeenCalledTimes(1);
  });

  it("refuses a decided_at before the floor (year 0000 included) with 400, before any read", async () => {
    for (const decidedAt of ["0000-01-01T00:00:00.000Z", "2025-12-31T23:59:59.000Z"]) {
      const m = make();
      const err = await refusal(
        m.service.review(POSTING, decision({ decided_at: decidedAt }), CALL),
      );
      expect(codeOf(err)).toBe("VALIDATION_FAILED");
      expect(m.repo.findTarget).not.toHaveBeenCalled();
    }
  });
});

describe("CampusPostingReviewService — which postings answer the neutral 404", () => {
  it("a malformed id, before any read", async () => {
    const { service, repo } = make();
    const err = await refusal(service.review("not-a-uuid", decision(), CALL));
    expect(err).toBeInstanceOf(NotFoundException);
    expect(repo.findTarget).not.toHaveBeenCalled();
  });

  it("job_audience off everywhere, before any read", async () => {
    const { service, repo, rollout } = make({ live: false });
    const err = await refusal(service.review(POSTING, decision(), CALL));
    expect(err).toBeInstanceOf(NotFoundException);
    expect(rollout.isLiveForServiceCaller).toHaveBeenCalledWith("job_audience");
    expect(repo.findTarget).not.toHaveBeenCalled();
  });

  it.each([
    ["an unknown id", undefined],
    ["a draft", target({ status: "draft" })],
    ["a hidden posting", target({ hidden: true })],
    ["a posting with no owning company (ops, agency twin)", target({ ownerPayerId: null })],
  ])("%s, with no transaction opened", async (_name, row) => {
    const { service, repo } = make({ unlocked: row });
    const err = await refusal(service.review(POSTING, decision(), CALL));
    expect(err).toBeInstanceOf(NotFoundException);
    expect(codeOf(err)).toBeUndefined();
    expect(repo.withTransaction).not.toHaveBeenCalled();
  });

  it("the owner is not on the pilot list: the switch is read with the OWNER's tenant key", async () => {
    const { service, repo, tenancy, rollout } = make({ enabled: false });
    const err = await refusal(service.review(POSTING, decision(), CALL));
    expect(err).toBeInstanceOf(NotFoundException);
    // The stored owner, resolved READ-ONLY: the same decision as the company's own request.
    expect(tenancy.resolveReadOnly).toHaveBeenCalledWith(OWNER);
    expect(rollout.isEnabledFor).toHaveBeenCalledWith("job_audience", ANCHOR);
    expect(repo.withTransaction).not.toHaveBeenCalled();
  });

  it("tenancy resolves no key without a write (no membership, a denial): 404, and the healing resolve is never used", async () => {
    const { service, tenancy, rollout } = make({ scope: null });
    const err = await refusal(service.review(POSTING, decision(), CALL));
    expect(err).toBeInstanceOf(NotFoundException);
    expect(tenancy.resolve).not.toHaveBeenCalled();
    expect(rollout.isEnabledFor).not.toHaveBeenCalled();
  });

  it("a tenancy read failure propagates (it is not a 404)", async () => {
    const { service } = make({ resolveError: new Error("db down") });
    await expect(service.review(POSTING, decision(), CALL)).rejects.toThrow("db down");
  });

  it.each([
    ["hidden since the pre-check", target({ hidden: true })],
    ["gone since the pre-check", undefined],
    ["owned by someone else under the lock", target({ ownerPayerId: ANCHOR })],
  ])("re-checked under the lock: %s", async (_name, locked) => {
    const m = make({ locked });
    const err = await refusal(m.service.review(POSTING, decision(), CALL));
    expect(err).toBeInstanceOf(NotFoundException);
    expect(m.repo.lockReview).not.toHaveBeenCalled();
    expectNothingStored(m);
  });
});

describe("CampusPostingReviewService — the posting's own 409s, decided under its lock", () => {
  it("AUDIENCE_EXCLUDES_RVM for a BadaBhai-only posting", async () => {
    const m = make({ locked: target({ audience: "badabhai_workers" }) });
    const err = await refusal(m.service.review(POSTING, decision(), CALL));
    expect(err).toBeInstanceOf(ConflictException);
    expect(codeOf(err)).toBe("AUDIENCE_EXCLUDES_RVM");
    expectNothingStored(m);
  });

  it("POSTING_NOT_OPEN for a closed posting (terminal: a decision could never reach a student)", async () => {
    const m = make({ locked: target({ status: "closed" }) });
    const err = await refusal(m.service.review(POSTING, decision(), CALL));
    expect(codeOf(err)).toBe("POSTING_NOT_OPEN");
    expectNothingStored(m);
  });

  it.each(["paused", "suspended", "open"] as const)(
    "a %s posting is reviewable (it can be open again with the same content)",
    async (status) => {
      const { service, repo } = make({ locked: target({ status }) });
      await service.review(POSTING, decision(), CALL);
      expect(repo.writeDecision).toHaveBeenCalledTimes(1);
    },
  );
});

describe("CampusPostingReviewService — the newest decision wins (decided_at), then the content", () => {
  it("the same decided_at and the same decision: the replay, 200 with the stored decision, nothing written", async () => {
    const m = make({ held: { state: "approved", timing: "same", sameDecision: true } });
    expect(await m.service.review(POSTING, decision(), CALL)).toEqual({
      posting_id: POSTING,
      review_state: "approved",
      reviewed_at: DECIDED_AT,
    });
    expectNothingStored(m);
  });

  it("a replay whose stored hash is no longer the posting's (an edit that skipped the reset): 409 POSTING_CHANGED, nothing written", async () => {
    const m = make({
      locked: target({ contentHash: OTHER_HASH }),
      held: { state: "approved", timing: "same", sameDecision: true },
    });
    expect(codeOf(await refusal(m.service.review(POSTING, decision(), CALL)))).toBe(
      "POSTING_CHANGED",
    );
    expectNothingStored(m);
  });

  it("the reset floor: a review that went pending after decided_at (beyond the tolerance) is 409 POSTING_CHANGED (re-review), nothing written", async () => {
    const m = make({ held: { state: "pending", timing: "before_reset", sameDecision: false } });
    expect(codeOf(await refusal(m.service.review(POSTING, decision(), CALL)))).toBe(
      "POSTING_CHANGED",
    );
    expectNothingStored(m);
  });

  it("the same decided_at with a different decision: 409 DECISION_SUPERSEDED, nothing written", async () => {
    const m = make({ held: { state: "approved", timing: "same", sameDecision: false } });
    const err = await refusal(m.service.review(POSTING, decision({ state: "rejected" }), CALL));
    expect(err).toBeInstanceOf(ConflictException);
    expect(codeOf(err)).toBe("DECISION_SUPERSEDED");
    expectNothingStored(m);
  });

  it("an older decided_at: 409 DECISION_SUPERSEDED, even for the decision the row holds", async () => {
    const m = make({ held: { state: "approved", timing: "older", sameDecision: true } });
    expect(codeOf(await refusal(m.service.review(POSTING, decision(), CALL)))).toBe(
      "DECISION_SUPERSEDED",
    );
    expectNothingStored(m);
  });

  it("TIME BEFORE CONTENT: an older decision on changed content is DECISION_SUPERSEDED, not POSTING_CHANGED", async () => {
    const m = make({
      locked: target({ contentHash: OTHER_HASH }),
      held: { state: "rejected", timing: "older", sameDecision: false },
    });
    expect(codeOf(await refusal(m.service.review(POSTING, decision(), CALL)))).toBe(
      "DECISION_SUPERSEDED",
    );
  });

  it.each(["none", "newer"] as const)(
    "a current decision (%s) on changed content: 409 POSTING_CHANGED, nothing written",
    async (timing) => {
      const m = make({
        locked: target({ contentHash: OTHER_HASH }),
        held: { state: timing === "none" ? "pending" : "approved", timing, sameDecision: false },
      });
      expect(codeOf(await refusal(m.service.review(POSTING, decision(), CALL)))).toBe(
        "POSTING_CHANGED",
      );
      expect(m.repo.reviewStateNow).not.toHaveBeenCalled();
      expectNothingStored(m);
    },
  );

  it("a newer decided_at on the same content is a re-decision: written", async () => {
    const m = make({
      held: { state: "approved", timing: "newer", sameDecision: false },
      stateNow: "approved",
    });
    await m.service.review(POSTING, decision({ state: "rejected" }), CALL);
    expect(m.repo.writeDecision).toHaveBeenCalledTimes(1);
  });

  it("superseded and changed decisions are refused before their narrowing is judged", async () => {
    const superseded = make({ held: { state: "approved", timing: "older", sameDecision: false } });
    expect(
      codeOf(
        await refusal(superseded.service.review(POSTING, decision({ branch_ids: [9] }), CALL)),
      ),
    ).toBe("DECISION_SUPERSEDED");
    const changed = make({ locked: target({ contentHash: OTHER_HASH }) });
    expect(
      codeOf(await refusal(changed.service.review(POSTING, decision({ branch_ids: [9] }), CALL))),
    ).toBe("POSTING_CHANGED");
  });

  it("the write statement's own refusals store nothing: not applied is the floor on a pending row, a newer decision on a decided one; a moved hash POSTING_CHANGED", async () => {
    const floor = make({ write: { outcome: "not_applied", contentHash: HASH } });
    expect(codeOf(await refusal(floor.service.review(POSTING, decision(), CALL)))).toBe(
      "POSTING_CHANGED",
    );
    expect(floor.events.emit).not.toHaveBeenCalled();

    const late = make({
      held: { state: "approved", timing: "newer", sameDecision: false },
      write: { outcome: "not_applied", contentHash: HASH },
    });
    expect(codeOf(await refusal(late.service.review(POSTING, decision(), CALL)))).toBe(
      "DECISION_SUPERSEDED",
    );
    expect(late.events.emit).not.toHaveBeenCalled();
    expect(late.repo.writeAudit).not.toHaveBeenCalled();

    const moved = make({ write: { outcome: "posting_changed", contentHash: OTHER_HASH } });
    expect(codeOf(await refusal(moved.service.review(POSTING, decision(), CALL)))).toBe(
      "POSTING_CHANGED",
    );
    expect(moved.events.emit).not.toHaveBeenCalled();
  });

  it("the house lock order: posting, then review row, then the state read, then the write", async () => {
    const { service, repo } = make();
    await service.review(POSTING, decision(), CALL);
    const order = (fn: { mock: { invocationCallOrder: number[] } }) =>
      fn.mock.invocationCallOrder[0]!;
    expect(order(repo.lockTarget)).toBeLessThan(order(repo.lockReview));
    expect(order(repo.lockReview)).toBeLessThan(order(repo.reviewStateNow));
    expect(order(repo.reviewStateNow)).toBeLessThan(order(repo.writeDecision));
  });
});

describe("CampusPostingReviewService — narrowing", () => {
  it("accepts ids within the posting's own targeting, stored sorted and de-duplicated", async () => {
    const { service, repo } = make();
    await service.review(POSTING, decision({ branch_ids: [2, 1, 2] }), CALL);
    expect(repo.writeDecision.mock.calls[0]![1].branchIds).toEqual([1, 2]);
    // The same canonical lists are what the review row is compared with.
    expect(repo.lockReview.mock.calls[0]![1].branchIds).toEqual([1, 2]);
  });

  it("refuses an id outside the posting's own targeting: 400 VALIDATION_FAILED naming it", async () => {
    const m = make();
    const err = await refusal(m.service.review(POSTING, decision({ branch_ids: [1, 3] }), CALL));
    expect(err).toBeInstanceOf(BadRequestException);
    expect(codeOf(err)).toBe("VALIDATION_FAILED");
    expect(JSON.stringify(err.getResponse())).toContain("branch_ids");
    expect(JSON.stringify(err.getResponse())).toContain("3");
    expectNothingStored(m);
  });

  it("with the posting's own list empty (every course), each id must be an ACTIVE option", async () => {
    const { service, repo, options, tx } = make();
    await service.review(POSTING, decision({ course_ids: ["cnc"] }), CALL);
    expect(options.activeOptionRefs).toHaveBeenCalledWith("course", ["cnc"], tx);
    expect(repo.writeDecision.mock.calls[0]![1].courseIds).toEqual(["cnc"]);

    const refused = make();
    const err = await refusal(
      refused.service.review(POSTING, decision({ course_ids: ["cnc", "retired"] }), CALL),
    );
    expect(codeOf(err)).toBe("VALIDATION_FAILED");
    expect(JSON.stringify(err.getResponse())).toContain("retired");
  });

  it("with the posting's own list set, the options table is not consulted", async () => {
    const { service, options } = make();
    await service.review(POSTING, decision({ branch_ids: [1] }), CALL);
    expect(options.activeOptionRefs).not.toHaveBeenCalled();
  });

  it("not narrowed is stored as null, never as the posting's own list", async () => {
    const { service, repo } = make();
    await service.review(POSTING, decision(), CALL);
    const input = repo.writeDecision.mock.calls[0]![1];
    expect(input.branchIds).toBeNull();
    expect(input.courseIds).toBeNull();
  });

  it("a rejection may carry a narrowing (jpir_decision_chk allows it): validated and stored", async () => {
    const { service, repo } = make();
    await service.review(POSTING, decision({ state: "rejected", branch_ids: [1] }), CALL);
    expect(repo.writeDecision.mock.calls[0]![1]).toMatchObject({
      state: "rejected",
      branchIds: [1],
    });

    const refused = make();
    const err = await refusal(
      refused.service.review(POSTING, decision({ state: "rejected", branch_ids: [7] }), CALL),
    );
    expect(codeOf(err)).toBe("VALIDATION_FAILED");
  });
});

describe("CampusPostingReviewService — the write, its event and its audit row", () => {
  it("writes the decision with the reviewer's hash and decided_at", async () => {
    const { service, repo, tx } = make();
    await service.review(POSTING.toUpperCase(), decision({ branch_ids: [1] }), CALL);
    const expected = {
      jobPostingId: POSTING,
      state: "approved",
      reviewerRef: STAFF.toLowerCase(),
      reason: null,
      branchIds: [1],
      courseIds: null,
      expectedContentHash: HASH,
      decidedAt: DECIDED_AT,
    };
    // The reset floor's own tolerance (not the skew bound), to the lock and to the write statement.
    expect(repo.lockReview).toHaveBeenCalledWith(tx, expected, CAMPUS_RESET_FLOOR_TOLERANCE_MS);
    expect(repo.writeDecision).toHaveBeenCalledWith(tx, expected, {
      toleranceMs: CAMPUS_RESET_FLOOR_TOLERANCE_MS,
      insertedByThisCall: false,
    });
    expect(CAMPUS_RESET_FLOOR_TOLERANCE_MS).toBe(10 * 60 * 1000);
    expect(CAMPUS_RESET_FLOOR_TOLERANCE_MS).not.toBe(CAMPUS_MAX_CLOCK_SKEW_MS);
  });

  it("a row this call created reaches the write statement as exempt from the reset floor", async () => {
    const { service, repo, tx } = make({
      held: { state: "pending", timing: "none", sameDecision: false, insertedByThisCall: true },
    });
    await service.review(POSTING, decision(), CALL);
    expect(repo.writeDecision).toHaveBeenCalledWith(tx, expect.any(Object), {
      toleranceMs: CAMPUS_RESET_FLOOR_TOLERANCE_MS,
      insertedByThisCall: true,
    });
  });

  it("answers the posting, the state and decided_at as the review time", async () => {
    const { service } = make();
    expect(await service.review(POSTING, decision(), CALL)).toEqual({
      posting_id: POSTING,
      review_state: "approved",
      reviewed_at: DECIDED_AT,
    });
  });

  it("emits job_posting.rvm_reviewed v1 on the transaction: ids, enums, decided_at, never the reason", async () => {
    const { service, events, tx } = make({ stateNow: "approved" });
    await service.review(
      POSTING,
      decision({ state: "rejected", reason: "Pay below the floor", course_ids: ["cad"] }),
      CALL,
    );
    expect(events.emit).toHaveBeenCalledTimes(1);
    const emitted = (events.emit.mock.calls[0] as unknown[])[0] as Record<string, unknown>;
    expect(emitted).toMatchObject({
      event_name: "job_posting.rvm_reviewed",
      actor: { actor_type: "system", actor_id: null },
      subject: { subject_type: "job_posting", subject_id: POSTING },
      tx,
    });
    expect(emitted.payload).toEqual({
      job_posting_id: POSTING,
      institute_code: "rvm",
      state: "rejected",
      previous_state: "approved",
      reviewer_ref: STAFF.toLowerCase(),
      decided_at: DECIDED_AT,
      branch_ids: null,
      course_ids: ["cad"],
      has_reason: true,
      content_hash: HASH,
    });
    expect(JSON.stringify(emitted)).not.toContain("Pay below");
  });

  it("previous_state is the state read in its own statement after the row lock", async () => {
    const m = make({
      stateNow: "rejected",
      held: { state: "rejected", timing: "newer", sameDecision: false },
    });
    await m.service.review(POSTING, decision(), CALL);
    const payload = (
      (m.events.emit.mock.calls[0] as unknown[])[0] as {
        payload: { previous_state: unknown };
      }
    ).payload;
    expect(payload.previous_state).toBe("rejected");
  });

  it("writes the decision's audit_logs row on the transaction, actor = reviewer_ref", async () => {
    const { service, repo, tx } = make();
    await service.review(POSTING, decision({ reason: "secret note", branch_ids: [2] }), CALL);
    expect(repo.writeAudit).toHaveBeenCalledWith(tx, {
      jobPostingId: POSTING,
      reviewerRef: STAFF.toLowerCase(),
      metadata: {
        institute_code: "rvm",
        state: "approved",
        previous_state: "pending",
        decided_at: DECIDED_AT,
        narrowed_branch_ids: [2],
        narrowed_course_ids: null,
        has_reason: true,
        content_hash: HASH,
        campus_call_id: CALL_ID,
        event_id: "eeeeeeee-0000-4000-8000-000000000001",
      },
    });
    expect(JSON.stringify(repo.writeAudit.mock.calls)).not.toContain("secret note");
  });

  it("never touches reach: the service has no reach dependency at all", () => {
    expect(CampusPostingReviewService.length).toBe(5);
    const { service } = make();
    expect(Object.keys(service)).not.toContain("reach");
  });
});

describe("CampusPostingReviewService — the reason is stored clean and never logged", () => {
  it("strips control and format characters (keeps newlines) before storing and comparing", async () => {
    const { service, repo } = make();
    await service.review(
      POSTING,
      decision({ reason: `Pay ${RLO}low${ZWSP}${NEWLINE}see note` }),
      CALL,
    );
    expect(repo.writeDecision.mock.calls[0]![1].reason).toBe(`Pay low${NEWLINE}see note`);
    expect(repo.lockReview.mock.calls[0]![1].reason).toBe(`Pay low${NEWLINE}see note`);
  });

  it("a reason of hidden characters or joiners only is stored as no reason (has_reason false)", async () => {
    const ZWJ = String.fromCharCode(0x200d);
    const ZWNJ = String.fromCharCode(0x200c);
    const joiners = make();
    await joiners.service.review(POSTING, decision({ reason: `${ZWJ}${ZWNJ} ${ZWJ}` }), CALL);
    expect(joiners.repo.writeDecision.mock.calls[0]![1].reason).toBeNull();

    const { service, repo, events } = make();
    await service.review(POSTING, decision({ reason: `${ZWSP}${RLO}` }), CALL);
    expect(repo.writeDecision.mock.calls[0]![1].reason).toBeNull();
    const emitted = (events.emit.mock.calls[0] as unknown[])[0] as {
      payload: { has_reason: boolean };
    };
    expect(emitted.payload.has_reason).toBe(false);
  });

  it("no log line carries the reason text, on any outcome", async () => {
    const lines: string[] = [];
    const capture = (...args: unknown[]): void => {
      lines.push(args.map(String).join(" "));
    };
    vi.spyOn(Logger.prototype, "log").mockImplementation(capture);
    vi.spyOn(Logger.prototype, "warn").mockImplementation(capture);
    vi.spyOn(Logger.prototype, "error").mockImplementation(capture);
    vi.spyOn(Logger.prototype, "debug").mockImplementation(capture);
    vi.spyOn(Logger.prototype, "verbose").mockImplementation(capture);
    const reason = "do-not-log-this-note";
    await make().service.review(POSTING, decision({ reason }), CALL);
    await refusal(
      make({ locked: target({ contentHash: OTHER_HASH }) }).service.review(
        POSTING,
        decision({ reason }),
        CALL,
      ),
    );
    await make({ held: { state: "approved", timing: "same", sameDecision: true } }).service.review(
      POSTING,
      decision({ reason }),
      CALL,
    );
    await refusal(
      make({ held: { state: "approved", timing: "older", sameDecision: false } }).service.review(
        POSTING,
        decision({ reason }),
        CALL,
      ),
    );

    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join("\n")).not.toContain(reason);
    expect(lines.join("\n")).not.toContain(STAFF.toLowerCase());
  });
});
