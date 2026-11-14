import "reflect-metadata";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
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
import type {
  CampusPostingReviewRepository,
  DecisionWrite,
  DecisionWriteResult,
  LockedReviewTarget,
  ReviewBefore,
} from "./campus-posting-review.repository";
import {
  CampusPostingReviewService,
  type CampusReviewDecision,
} from "./campus-posting-review.service";

/**
 * #2746 PR 5 — the review rules, with the repository, the switch, the tenancy resolver and the
 * events faked. The SQL (the locked hash read, the guarded upsert, the live-hash rule, the lock
 * order against a company edit) runs against Postgres in `campus-review.db.test.ts`.
 */

const POSTING = "bbbbbbbb-0000-4000-8000-000000000001";
const OWNER = "aaaaaaaa-0000-4000-8000-000000000001";
const ANCHOR = "aaaaaaaa-0000-4000-8000-0000000000aa";
const STAFF = "9A8B7C6D-5E4F-4A3B-8C2D-1E0F9A8B7C6D";
const CALL_ID = "cccccccc-0000-4000-8000-000000000001";
const HASH = "a".repeat(64);
const OTHER_HASH = "b".repeat(64);
const REVIEWED_AT = new Date("2026-11-14T10:00:00.000Z");
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
  return { state: "approved", reviewer_ref: STAFF, content_hash: HASH, ...over };
}

interface Setup {
  live?: boolean;
  enabled?: boolean;
  resolveError?: Error;
  unlocked?: LockedReviewTarget | undefined;
  locked?: LockedReviewTarget | undefined;
  before?: ReviewBefore | undefined;
  write?: DecisionWriteResult;
  activeCourses?: readonly string[];
}

function make(opts: Setup = {}) {
  const tx = { tx: true } as unknown as Database;
  const unlocked = "unlocked" in opts ? opts.unlocked : target();
  const locked = "locked" in opts ? opts.locked : unlocked;
  const repo = {
    findTarget: vi.fn(async () => unlocked),
    withTransaction: vi.fn(async <T>(work: (t: Database) => Promise<T>) => work(tx)),
    lockTarget: vi.fn(async () => locked),
    lockReviewBefore: vi.fn(async () => opts.before),
    writeDecision: vi.fn(
      async (_tx: Database, _input: DecisionWrite): Promise<DecisionWriteResult> =>
        opts.write ?? { outcome: "written", contentHash: HASH, reviewedAt: REVIEWED_AT },
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
  // A test may build a key from a literal: the brand guards production call sites, not fixtures.
  const scope: PayerTenantScope = {
    actorPayerId: OWNER,
    tenantKey: ANCHOR as TenantKey,
    orgId: null,
    orgRole: null,
    mode: "on",
  };
  const tenancy = {
    resolve: vi.fn(async () => {
      if (opts.resolveError) throw opts.resolveError;
      return scope;
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

afterEach(() => {
  vi.restoreAllMocks();
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
    // The stored owner, resolved exactly as that company's own request resolves it.
    expect(tenancy.resolve).toHaveBeenCalledWith(OWNER);
    expect(rollout.isEnabledFor).toHaveBeenCalledWith("job_audience", ANCHOR);
    expect(repo.withTransaction).not.toHaveBeenCalled();
  });

  it("a tenancy refusal for the owner fails closed as not live", async () => {
    const { service, rollout } = make({ resolveError: new ForbiddenException() });
    const err = await refusal(service.review(POSTING, decision(), CALL));
    expect(err).toBeInstanceOf(NotFoundException);
    expect(rollout.isEnabledFor).not.toHaveBeenCalled();
  });

  it("any other tenancy failure propagates (it is not a 404)", async () => {
    const { service } = make({ resolveError: new Error("db down") });
    await expect(service.review(POSTING, decision(), CALL)).rejects.toThrow("db down");
  });

  it.each([
    ["hidden since the pre-check", target({ hidden: true })],
    ["gone since the pre-check", undefined],
    ["owned by someone else under the lock", target({ ownerPayerId: ANCHOR })],
  ])("re-checked under the lock: %s", async (_name, locked) => {
    const { service, repo } = make({ locked });
    const err = await refusal(service.review(POSTING, decision(), CALL));
    expect(err).toBeInstanceOf(NotFoundException);
    expect(repo.writeDecision).not.toHaveBeenCalled();
  });
});

describe("CampusPostingReviewService — the 409s, decided under the posting's lock", () => {
  it("AUDIENCE_EXCLUDES_RVM for a BadaBhai-only posting", async () => {
    const { service, repo } = make({ locked: target({ audience: "badabhai_workers" }) });
    const err = await refusal(service.review(POSTING, decision(), CALL));
    expect(err).toBeInstanceOf(ConflictException);
    expect(codeOf(err)).toBe("AUDIENCE_EXCLUDES_RVM");
    expect(repo.writeDecision).not.toHaveBeenCalled();
  });

  it("POSTING_NOT_OPEN for a closed posting (terminal: a decision could never reach a student)", async () => {
    const { service, repo } = make({ locked: target({ status: "closed" }) });
    const err = await refusal(service.review(POSTING, decision(), CALL));
    expect(codeOf(err)).toBe("POSTING_NOT_OPEN");
    expect(repo.writeDecision).not.toHaveBeenCalled();
  });

  it.each(["paused", "suspended", "open"] as const)(
    "a %s posting is reviewable (it can be open again with the same content)",
    async (status) => {
      const { service, repo } = make({ locked: target({ status }) });
      await service.review(POSTING, decision(), CALL);
      expect(repo.writeDecision).toHaveBeenCalledTimes(1);
    },
  );

  it("POSTING_CHANGED when the body's content_hash is not the posting's hash under the lock", async () => {
    const { service, repo, events } = make({ locked: target({ contentHash: OTHER_HASH }) });
    const err = await refusal(service.review(POSTING, decision(), CALL));
    expect(err).toBeInstanceOf(ConflictException);
    expect(codeOf(err)).toBe("POSTING_CHANGED");
    expect(repo.lockReviewBefore).not.toHaveBeenCalled();
    expect(repo.writeDecision).not.toHaveBeenCalled();
    expect(repo.writeAudit).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();
  });

  it("a changed posting answers POSTING_CHANGED before its narrowing is judged", async () => {
    const { service } = make({ locked: target({ contentHash: OTHER_HASH }) });
    const err = await refusal(service.review(POSTING, decision({ branch_ids: [9] }), CALL));
    expect(codeOf(err)).toBe("POSTING_CHANGED");
  });

  it("POSTING_CHANGED from the write statement itself writes no event and no audit row", async () => {
    const { service, repo, events } = make({
      write: { outcome: "posting_changed", contentHash: OTHER_HASH },
    });
    const err = await refusal(service.review(POSTING, decision(), CALL));
    expect(codeOf(err)).toBe("POSTING_CHANGED");
    expect(events.emit).not.toHaveBeenCalled();
    expect(repo.writeAudit).not.toHaveBeenCalled();
  });

  it("takes the posting lock first, then the review row, then writes (the house lock order)", async () => {
    const { service, repo } = make();
    await service.review(POSTING, decision(), CALL);
    const order = (fn: { mock: { invocationCallOrder: number[] } }) =>
      fn.mock.invocationCallOrder[0]!;
    expect(order(repo.lockTarget)).toBeLessThan(order(repo.lockReviewBefore));
    expect(order(repo.lockReviewBefore)).toBeLessThan(order(repo.writeDecision));
  });
});

describe("CampusPostingReviewService — narrowing", () => {
  it("accepts ids within the posting's own targeting, stored sorted and de-duplicated", async () => {
    const { service, repo } = make();
    await service.review(POSTING, decision({ branch_ids: [2, 1, 2] }), CALL);
    expect(repo.writeDecision.mock.calls[0]![1].branchIds).toEqual([1, 2]);
  });

  it("refuses an id outside the posting's own targeting: 400 VALIDATION_FAILED naming it", async () => {
    const { service, repo } = make();
    const err = await refusal(service.review(POSTING, decision({ branch_ids: [1, 3] }), CALL));
    expect(err).toBeInstanceOf(BadRequestException);
    expect(codeOf(err)).toBe("VALIDATION_FAILED");
    expect(JSON.stringify(err.getResponse())).toContain("branch_ids");
    expect(JSON.stringify(err.getResponse())).toContain("3");
    expect(repo.writeDecision).not.toHaveBeenCalled();
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

  it("refuses a course id the review row cannot store (a line break), even if it is an option", async () => {
    const bad = `cnc${NEWLINE}x`;
    const { service, repo } = make({ activeCourses: [bad] });
    const err = await refusal(service.review(POSTING, decision({ course_ids: [bad] }), CALL));
    expect(codeOf(err)).toBe("VALIDATION_FAILED");
    expect(repo.writeDecision).not.toHaveBeenCalled();
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
  const before: ReviewBefore = { state: "pending", stateNow: "pending", reviewedAt: null };

  it("writes the decision with the reviewer's hash as the precondition", async () => {
    const { service, repo, tx } = make({ before });
    await service.review(POSTING.toUpperCase(), decision({ branch_ids: [1] }), CALL);
    expect(repo.writeDecision).toHaveBeenCalledWith(tx, {
      jobPostingId: POSTING,
      state: "approved",
      reviewerRef: STAFF.toLowerCase(),
      reason: null,
      branchIds: [1],
      courseIds: null,
      expectedContentHash: HASH,
    });
  });

  it("answers the posting, the state and the decision's time", async () => {
    const { service } = make({ before });
    expect(await service.review(POSTING, decision(), CALL)).toEqual({
      posting_id: POSTING,
      review_state: "approved",
      reviewed_at: REVIEWED_AT.toISOString(),
    });
  });

  it("emits job_posting.rvm_reviewed v1 on the transaction: ids and enums, never the reason", async () => {
    const { service, events, tx } = make({ before });
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
      previous_state: "pending",
      reviewer_ref: STAFF.toLowerCase(),
      branch_ids: null,
      course_ids: ["cad"],
      has_reason: true,
      content_hash: HASH,
    });
    expect(JSON.stringify(emitted)).not.toContain("Pay below");
  });

  it("previous_state is what a reader saw (live hash), and null for a posting with no row", async () => {
    const stale: ReviewBefore = { state: "approved", stateNow: "pending", reviewedAt: REVIEWED_AT };
    const withRow = make({ before: stale });
    await withRow.service.review(POSTING, decision(), CALL);
    const payloadOf = (m: ReturnType<typeof make>) =>
      ((m.events.emit.mock.calls[0] as unknown[])[0] as { payload: { previous_state: unknown } })
        .payload;
    expect(payloadOf(withRow).previous_state).toBe("pending");

    const noRow = make({ before: undefined });
    await noRow.service.review(POSTING, decision(), CALL);
    expect(payloadOf(noRow).previous_state).toBeNull();
  });

  it("writes the decision's audit_logs row on the transaction, actor = reviewer_ref", async () => {
    const { service, repo, tx } = make({ before });
    await service.review(POSTING, decision({ reason: "secret note", branch_ids: [2] }), CALL);
    expect(repo.writeAudit).toHaveBeenCalledWith(tx, {
      jobPostingId: POSTING,
      reviewerRef: STAFF.toLowerCase(),
      metadata: {
        institute_code: "rvm",
        state: "approved",
        previous_state: "pending",
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

  it("a replay of the stored decision writes nothing more and answers the stored decision", async () => {
    const stored: ReviewBefore = {
      state: "approved" as InstituteReviewState,
      stateNow: "approved",
      reviewedAt: REVIEWED_AT,
    };
    const { service, repo, events } = make({
      before: stored,
      write: { outcome: "unchanged", contentHash: HASH },
    });
    expect(await service.review(POSTING, decision(), CALL)).toEqual({
      posting_id: POSTING,
      review_state: "approved",
      reviewed_at: REVIEWED_AT.toISOString(),
    });
    expect(events.emit).not.toHaveBeenCalled();
    expect(repo.writeAudit).not.toHaveBeenCalled();
  });

  it("never touches reach: the service has no reach dependency at all", () => {
    expect(CampusPostingReviewService.length).toBe(5);
    const { service } = make();
    expect(Object.keys(service)).not.toContain("reach");
  });
});

describe("CampusPostingReviewService — the reason is stored clean and never logged", () => {
  it("strips control and format characters (keeps newlines) before storing", async () => {
    const { service, repo } = make();
    await service.review(
      POSTING,
      decision({ reason: `Pay ${RLO}low${ZWSP}${NEWLINE}see note` }),
      CALL,
    );
    expect(repo.writeDecision.mock.calls[0]![1].reason).toBe(`Pay low${NEWLINE}see note`);
  });

  it("a reason of hidden characters only is stored as no reason (has_reason false)", async () => {
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
    await make({
      before: { state: "approved", stateNow: "approved", reviewedAt: REVIEWED_AT },
      write: { outcome: "unchanged", contentHash: HASH },
    }).service.review(POSTING, decision({ reason }), CALL);
    await refusal(
      make({ resolveError: new ForbiddenException() }).service.review(
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
