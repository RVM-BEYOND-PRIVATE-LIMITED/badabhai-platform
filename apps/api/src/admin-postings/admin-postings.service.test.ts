import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { Job, JobPosting } from "@badabhai/db";
import type { RequestContext } from "../common/request-context";
import { ADMIN_ACTION_CODES } from "../admin/admin-action-codes";
import { AdminPostingsService } from "./admin-postings.service";

/**
 * #2566 — the admin posting-control contract, with the database and the domain services
 * faked. What is asserted here is the part the DB gate cannot see:
 *
 *   - every action writes the REASON, the `admin.action_performed` and a domain event, with
 *     the session admin as the actor, on the SAME transaction;
 *   - a twin id acts on the SOURCE agency job and converges its twin on that transaction;
 *   - idempotent repeats write and emit NOTHING;
 *   - `close` reports the state it actually left (paused/suspended), not a hardcoded `open`.
 */

const TX = { tx: true } as never;
const CTX: RequestContext = {
  correlationId: randomUUID(),
  requestId: `postings-unit-${randomUUID()}`,
};
const ADMIN = randomUUID();
const POSTING_ID = randomUUID();
const JOB_ID = randomUUID();

const REASON = {
  reason_code: "misleading" as const,
  reason_text: "Title promises a salary the posting does not state",
};
const VERIFY_REASON = {
  reason_code: "does_not_meet_standards" as const,
  reason_text: "The description carries a phone number the screen missed",
};

function posting(over: Partial<JobPosting> = {}): JobPosting {
  return {
    id: POSTING_ID,
    createdBy: randomUUID(),
    payerId: randomUUID(),
    orgLabel: "Acme Works",
    roleTitle: "CNC Operator",
    locationLabel: null,
    description: "Run the line.",
    vacancyBand: "1",
    status: "open",
    verificationStatus: "unverified",
    skillPhrases: [],
    skillIds: [],
    jobDomainId: null,
    matchSkillIds: [],
    reachSkillIds: [],
    untickedRelatedIds: [],
    city: "Pune",
    area: null,
    minExperienceYears: null,
    maxExperienceYears: null,
    benefits: null,
    requirements: null,
    payMin: null,
    payMax: null,
    payType: null,
    shift: null,
    neededBy: null,
    roleKind: null,
    tradeLevel: null,
    tradeAnswers: null,
    publishedAt: new Date("2026-10-01T00:00:00.000Z"),
    boostedUntil: null,
    createdAt: new Date("2026-10-01T00:00:00.000Z"),
    updatedAt: new Date("2026-10-01T00:00:00.000Z"),
    closedAt: null,
    previousStatus: null,
    syncSource: null,
    sourceJobId: null,
    hiddenAt: null,
    hiddenBy: null,
    hiddenReasonCode: null,
    hiddenReasonText: null,
    ...over,
  } as JobPosting;
}

function job(over: Partial<Job> = {}): Job {
  return {
    id: JOB_ID,
    tradeKey: "cnc_machining",
    title: "VMC Operator",
    city: "Pune",
    area: null,
    status: "open",
    verificationStatus: "unverified",
    payerId: randomUUID(),
    description: null,
    minExperienceYears: null,
    maxExperienceYears: null,
    payMin: null,
    payMax: null,
    payType: null,
    shift: null,
    neededBy: null,
    benefits: null,
    requirements: null,
    roleKind: null,
    matchSkillIds: [],
    tradeLevel: null,
    tradeAnswers: null,
    applicantsReceived: 0,
    createdAt: new Date("2026-10-01T00:00:00.000Z"),
    updatedAt: new Date("2026-10-01T00:00:00.000Z"),
    hiddenAt: null,
    hiddenBy: null,
    hiddenReasonCode: null,
    hiddenReasonText: null,
    ...over,
  } as Job;
}

function harness(
  over: {
    posting?: JobPosting | undefined;
    job?: Job | undefined;
  } = {},
) {
  const repo = {
    findPosting: vi.fn(async () => over.posting),
    findJob: vi.fn(async () => over.job),
    withTransaction: vi.fn(async (work: (tx: never) => Promise<unknown>) => work(TX)),
    updatePosting: vi.fn(async (_id: string, patch: Record<string, unknown>) =>
      posting({ ...(patch as Partial<JobPosting>) }),
    ),
    updateJob: vi.fn(async (_id: string, patch: Record<string, unknown>) =>
      job({ ...(patch as Partial<Job>) }),
    ),
    movePostingStatus: vi.fn(async (_id: string, _from: string, to: "paused" | "open") =>
      posting({ status: to }),
    ),
    moveJobStatus: vi.fn(async (_id: string, _from: string, to: "paused" | "open") =>
      job({ status: to }),
    ),
    closePosting: vi.fn(async () => posting({ status: "closed", closedAt: new Date() })),
    closeJob: vi.fn(async () => job({ status: "closed" })),
    hidePosting: vi.fn(async (_id: string, state: Record<string, unknown>) =>
      posting({ ...state }),
    ),
    unhidePosting: vi.fn(async () =>
      posting({ hiddenAt: null, hiddenBy: null, hiddenReasonCode: null, hiddenReasonText: null }),
    ),
    hideJob: vi.fn(async (_id: string, state: Record<string, unknown>) => job({ ...state })),
    unhideJob: vi.fn(async () =>
      job({ hiddenAt: null, hiddenBy: null, hiddenReasonCode: null, hiddenReasonText: null }),
    ),
    setPostingVerification: vi.fn(async (_id: string, _from: string, next: string) =>
      posting({ verificationStatus: next as JobPosting["verificationStatus"] }),
    ),
    setJobVerification: vi.fn(async (_id: string, _from: string, next: string) =>
      job({ verificationStatus: next as Job["verificationStatus"] }),
    ),
    writeAudit: vi.fn(async () => undefined),
  };
  const events = { emit: vi.fn(async () => ({})) };
  const jobPostings = {
    prepareAdminEdit: vi.fn(),
    materializeAfterAdminEdit: vi.fn(async () => undefined),
  };
  const agency = { prepareAdminEdit: vi.fn() };
  const agencyTwin = { syncWithin: vi.fn(async () => ({ kind: "unchanged" })) };
  const service = new AdminPostingsService(
    repo as never,
    events as never,
    jobPostings as never,
    agency as never,
    agencyTwin as never,
  );
  return { repo, events, jobPostings, agency, agencyTwin, service };
}

const emitted = (events: { emit: ReturnType<typeof vi.fn> }) =>
  events.emit.mock.calls.map(([arg]) => arg as Record<string, unknown>);

describe("#2566 admin posting control — one transaction per action", () => {
  it("hide writes the reason, the admin action and job_posting.hidden with the ADMIN actor", async () => {
    const h = harness({ posting: posting() });
    const result = await h.service.hide(ADMIN, POSTING_ID, REASON, CTX);

    expect(result).toEqual({ target_id: POSTING_ID, entity_type: "job_posting", changed: true });
    expect(h.repo.writeAudit).toHaveBeenCalledWith(
      TX,
      expect.objectContaining({
        adminId: ADMIN,
        action: ADMIN_ACTION_CODES.posting_hidden,
        entityType: "job_posting",
        entityId: POSTING_ID,
        reasonCode: REASON.reason_code,
        reasonText: REASON.reason_text,
      }),
    );
    const calls = emitted(h.events);
    expect(calls.map((c) => c.event_name)).toEqual([
      "job_posting.hidden",
      "admin.action_performed",
    ]);
    for (const call of calls) expect(call.actor).toEqual({ actor_type: "admin", actor_id: ADMIN });
    expect(calls[1]!.payload).toMatchObject({
      admin_id: ADMIN,
      action_code: ADMIN_ACTION_CODES.posting_hidden,
      target_type: "job_posting",
      target_id: POSTING_ID,
    });
  });

  it("a TWIN id acts on the source agency job and converges the twin on the same tx", async () => {
    const twin = posting({ syncSource: "agency_job", sourceJobId: JOB_ID, payerId: null });
    const h = harness({ posting: twin, job: job() });
    const result = await h.service.hide(ADMIN, POSTING_ID, REASON, CTX);

    expect(result).toEqual({ target_id: JOB_ID, entity_type: "job", changed: true });
    expect(h.repo.hidePosting).not.toHaveBeenCalled();
    expect(h.repo.hideJob).toHaveBeenCalled();
    expect(h.agencyTwin.syncWithin).toHaveBeenCalledWith(TX, JOB_ID);
    expect(emitted(h.events).map((c) => c.event_name)).toEqual([
      "job.hidden",
      "admin.action_performed",
    ]);
  });

  it("hiding an already-hidden posting is a no-op: no write, no event", async () => {
    const h = harness({ posting: posting({ hiddenAt: new Date(), hiddenBy: ADMIN }) });
    const result = await h.service.hide(ADMIN, POSTING_ID, REASON, CTX);

    expect(result.changed).toBe(false);
    expect(h.repo.withTransaction).not.toHaveBeenCalled();
    expect(h.repo.writeAudit).not.toHaveBeenCalled();
    expect(h.events.emit).not.toHaveBeenCalled();
  });

  it("unhide clears ALL four hidden columns and emits job_posting.unhidden", async () => {
    const h = harness({ posting: posting({ hiddenAt: new Date(), hiddenBy: ADMIN }) });
    const result = await h.service.unhide(ADMIN, POSTING_ID, REASON, CTX);

    expect(result.changed).toBe(true);
    expect(h.repo.unhidePosting).toHaveBeenCalledWith(POSTING_ID, TX);
    expect(emitted(h.events).map((c) => c.event_name)).toEqual([
      "job_posting.unhidden",
      "admin.action_performed",
    ]);
  });

  it("close reports the state it ACTUALLY left, not a hardcoded open", async () => {
    const h = harness({ posting: posting({ status: "paused" }) });
    await h.service.close(ADMIN, POSTING_ID, REASON, CTX);

    const hiddenEvent = emitted(h.events).find((c) => c.event_name === "job_posting.admin_closed");
    expect(hiddenEvent?.payload).toEqual({
      job_posting_id: POSTING_ID,
      previous_status: "paused",
      status: "closed",
    });
    expect(h.repo.closePosting).toHaveBeenCalledWith(POSTING_ID, "paused", expect.any(Date), TX);
  });

  it("verify moves the trust review, keeps the lifecycle status, and audits the reason", async () => {
    const h = harness({ posting: posting() });
    const result = await h.service.verify(ADMIN, POSTING_ID, VERIFY_REASON, CTX);

    expect(result.changed).toBe(true);
    expect(h.repo.setPostingVerification).toHaveBeenCalledWith(
      POSTING_ID,
      "unverified",
      "verified",
      TX,
    );
    const calls = emitted(h.events);
    expect(calls[0]).toMatchObject({
      event_name: "job_posting.verification_updated",
      payload: {
        job_posting_id: POSTING_ID,
        verification_status: "verified",
        previous_status: "unverified",
      },
    });
    expect(calls[1]!.payload).toMatchObject({
      action_code: ADMIN_ACTION_CODES.posting_verified,
    });
  });

  it("verifying an already-verified posting writes and emits nothing", async () => {
    const h = harness({ posting: posting({ verificationStatus: "verified" }) });
    const result = await h.service.verify(ADMIN, POSTING_ID, VERIFY_REASON, CTX);

    expect(result.changed).toBe(false);
    expect(h.repo.withTransaction).not.toHaveBeenCalled();
    expect(h.events.emit).not.toHaveBeenCalled();
  });

  it("pause and resume move open↔paused and emit the paired domain events", async () => {
    const paused = harness({ posting: posting() });
    await paused.service.pause(ADMIN, POSTING_ID, REASON, CTX);
    expect(paused.repo.movePostingStatus).toHaveBeenCalledWith(POSTING_ID, "open", "paused", TX);
    expect(emitted(paused.events)[0]).toMatchObject({ event_name: "job_posting.paused" });

    const resumed = harness({ posting: posting({ status: "paused" }) });
    await resumed.service.resume(ADMIN, POSTING_ID, REASON, CTX);
    expect(resumed.repo.movePostingStatus).toHaveBeenCalledWith(POSTING_ID, "paused", "open", TX);
    expect(emitted(resumed.events)[0]).toMatchObject({ event_name: "job_posting.resumed" });
  });

  it("refuses to pause a posting that is not open (suspended/closed are never widened)", async () => {
    const h = harness({ posting: posting({ status: "suspended" }) });
    await expect(h.service.pause(ADMIN, POSTING_ID, REASON, CTX)).rejects.toThrow(
      "Only an open posting can be paused",
    );
    expect(h.repo.withTransaction).not.toHaveBeenCalled();
  });

  it("edit delegates the PATCH to the posting service, then emits updated + action", async () => {
    const before = posting();
    const h = harness({ posting: before });
    h.jobPostings.prepareAdminEdit.mockResolvedValue({
      before,
      patch: { roleTitle: "CNC Machinist" },
      changedFields: ["role_title"],
      bandChanged: false,
      tradeDto: {},
    });
    h.repo.updatePosting.mockResolvedValue(
      posting({ roleTitle: "CNC Machinist", updatedAt: new Date() }),
    );

    const result = await h.service.edit(
      ADMIN,
      POSTING_ID,
      {
        ...REASON,
        changes: { role_title: "CNC Machinist" },
      },
      CTX,
    );

    expect(result.changed).toBe(true);
    expect(h.jobPostings.prepareAdminEdit).toHaveBeenCalledWith(
      POSTING_ID,
      { role_title: "CNC Machinist" },
      CTX,
    );
    const calls = emitted(h.events);
    expect(calls[0]).toMatchObject({
      event_name: "job_posting.updated",
      payload: {
        job_posting_id: POSTING_ID,
        changed_fields: ["role_title"],
        status: "open",
        vacancy_band: null,
      },
    });
    expect(h.jobPostings.materializeAfterAdminEdit).toHaveBeenCalled();
  });

  it("#2746 — the audience is read-only to an admin: an edit that sends one reaches the posting service without it", async () => {
    const before = posting({ audience: "both" } as Partial<JobPosting>);
    const h = harness({ posting: before });
    h.jobPostings.prepareAdminEdit.mockResolvedValue({
      before,
      patch: { roleTitle: "CNC Machinist" },
      changedFields: ["role_title"],
      bandChanged: false,
      tradeDto: {},
    });
    h.repo.updatePosting.mockResolvedValue(posting({ roleTitle: "CNC Machinist" }));

    await h.service.edit(
      ADMIN,
      POSTING_ID,
      {
        ...REASON,
        changes: {
          role_title: "CNC Machinist",
          audience: "badabhai_workers",
          rvm_branch_ids: [],
          rvm_course_ids: [],
        },
      },
      CTX,
    );
    // The shared edit schema stripped all three: the posting service never saw an audience.
    expect(h.jobPostings.prepareAdminEdit).toHaveBeenCalledWith(
      POSTING_ID,
      { role_title: "CNC Machinist" },
      CTX,
    );
  });

  it("#2746 — an audience-only admin edit is refused as no edit at all, writing nothing", async () => {
    const h = harness({ posting: posting() });
    await expect(
      h.service.edit(ADMIN, POSTING_ID, { ...REASON, changes: { audience: "rvm_students" } }, CTX),
    ).rejects.toThrow("Invalid posting changes");
    expect(h.jobPostings.prepareAdminEdit).not.toHaveBeenCalled();
    expect(h.repo.updatePosting).not.toHaveBeenCalled();
  });

  it("edit refuses status changes: pause/resume/close are the only status writers", async () => {
    const h = harness({ posting: posting() });
    await expect(
      h.service.edit(ADMIN, POSTING_ID, { ...REASON, changes: { status: "open" } }, CTX),
    ).rejects.toThrow("status is changed by the pause, resume and close actions");
    expect(h.repo.findPosting).not.toHaveBeenCalled();
  });

  it("a closed posting cannot be edited (terminal, no reopen)", async () => {
    const h = harness({ posting: posting({ status: "closed" }) });
    await expect(
      h.service.edit(ADMIN, POSTING_ID, { ...REASON, changes: { role_title: "X" } }, CTX),
    ).rejects.toThrow("A closed posting cannot be edited");
  });

  it("unknown ids are a neutral 404, with no write", async () => {
    const h = harness({});
    await expect(h.service.hide(ADMIN, POSTING_ID, REASON, CTX)).rejects.toThrow(
      "Posting not found",
    );
    expect(h.repo.withTransaction).not.toHaveBeenCalled();
  });
});
