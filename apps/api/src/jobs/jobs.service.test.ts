import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { ConflictException, NotFoundException } from "@nestjs/common";
import type { Job } from "@badabhai/db";
import { JobsService } from "./jobs.service";

const JOB_ID = "33333333-3333-4333-8333-333333333333";
const PAYER_ID = "44444444-4444-4444-8444-444444444444";
const CTX = { correlationId: "22222222-2222-4222-8222-222222222222", requestId: "req-1" };

/** A draft job row as the repo would return it. Override per-test. */
function draftJob(overrides: Partial<Job> = {}): Job {
  return {
    id: JOB_ID,
    payerId: PAYER_ID,
    title: "CNC Operator — Day Shift (PII-ish free text)",
    roleIds: ["vmc_operator"],
    domainId: null,
    city: null,
    locationLat: null,
    locationLng: null,
    maxTravelKm: null,
    minExperienceYears: null,
    maxExperienceYears: null,
    payMin: null,
    payMax: null,
    neededBy: null,
    vacancyCount: 2,
    applicantQuota: null,
    applicantsReceivedCount: 0,
    postingFeeInr: null,
    introExpiresAt: null,
    boostTier: "none",
    boostedAt: null,
    boostExpiresAt: null,
    status: "draft",
    pauseReason: null,
    activatedAt: null,
    pausedAt: null,
    closedAt: null,
    createdAt: new Date("2026-06-15T00:00:00.000Z"),
    updatedAt: new Date("2026-06-15T00:00:00.000Z"),
    ...overrides,
  };
}

function make(initial: Job) {
  // The repo holds one mutable row; update() merges the patch + restamps it.
  let row: Job = initial;
  const findById = vi.fn().mockImplementation(() => Promise.resolve(row));
  const create = vi.fn().mockImplementation((input: Partial<Job>) => {
    row = { ...row, ...input } as Job;
    return Promise.resolve(row);
  });
  const update = vi.fn().mockImplementation((_id: string, patch: Partial<Job>) => {
    row = { ...row, ...patch, updatedAt: new Date() };
    return Promise.resolve(row);
  });
  const list = vi.fn().mockResolvedValue([]);
  const emit = vi.fn().mockResolvedValue(undefined);

  const svc = new JobsService({ findById, create, update, list } as never, { emit } as never);
  return { svc, emit, findById, update, create, getRow: () => row };
}

/** Names of every event emitted, in order. */
function emittedNames(emit: ReturnType<typeof vi.fn>): string[] {
  return emit.mock.calls.map((c) => (c[0] as { event_name: string }).event_name);
}

/** Assert NO emitted event payload (or actor) carries the job title. */
function assertNoTitleInEvents(emit: ReturnType<typeof vi.fn>, title: string): void {
  for (const call of emit.mock.calls) {
    const serialized = JSON.stringify(call[0]);
    expect(serialized).not.toContain(title);
  }
}

describe("JobsService.create", () => {
  it("inserts a draft and emits job.created (keyed) without the title", async () => {
    const { svc, emit } = make(draftJob());
    const job = await svc.create(
      { payerId: PAYER_ID, title: draftJob().title, roleIds: ["vmc_operator"], vacancyCount: 2 },
      CTX as never,
    );
    expect(job.status).toBe("draft");

    expect(emit).toHaveBeenCalledOnce();
    const arg = emit.mock.calls[0]![0];
    expect(arg.event_name).toBe("job.created");
    expect(arg.actor).toEqual({ actor_type: "payer", actor_id: PAYER_ID });
    expect(arg.subject).toEqual({ subject_type: "job", subject_id: JOB_ID });
    expect(arg.idempotencyKey).toBe(`job.created:${JOB_ID}`);
    expect(arg.payload).not.toHaveProperty("title");
    assertNoTitleInEvents(emit, draftJob().title);
  });
});

describe("JobsService happy lifecycle: create → activate → pause → resume → close", () => {
  it("activate stamps applicant_quota = vacancy × 3 and walks the full path", async () => {
    const { svc, emit, getRow } = make(draftJob({ vacancyCount: 2 }));

    const activated = await svc.activate(JOB_ID, {}, CTX as never);
    expect(activated.status).toBe("active");
    // vacancyCount(2) × WAVE1_APPLICANT_MULTIPLIER(3) = 6
    expect(activated.applicantQuota).toBe(6);
    expect(activated.introExpiresAt).toBeInstanceOf(Date);
    expect(activated.activatedAt).toBeInstanceOf(Date);

    const paused = await svc.pause(JOB_ID, CTX as never);
    expect(paused.status).toBe("paused");
    expect(paused.pauseReason).toBe("manual");

    const resumed = await svc.resume(JOB_ID, CTX as never);
    expect(resumed.status).toBe("active");
    expect(resumed.pauseReason).toBeNull();
    expect(resumed.pausedAt).toBeNull();

    const closed = await svc.close(JOB_ID, { reason: "filled" }, CTX as never);
    expect(closed.status).toBe("closed");
    expect(closed.closedAt).toBeInstanceOf(Date);
    expect(getRow().status).toBe("closed");

    expect(emittedNames(emit)).toEqual([
      "job.activated",
      "job.paused",
      "job.resumed",
      "job.closed",
    ]);

    // job.activated carries the stamped quota + a keyed idempotency key.
    const activatedEvent = emit.mock.calls[0]![0];
    expect(activatedEvent.payload.applicant_quota).toBe(6);
    expect(activatedEvent.idempotencyKey).toBe(`job.activated:${JOB_ID}`);
    // pause/resume are repeatable → no idempotency key.
    expect(emit.mock.calls[1]![0].idempotencyKey).toBeUndefined();
    expect(emit.mock.calls[2]![0].idempotencyKey).toBeUndefined();
    // close is keyed.
    expect(emit.mock.calls[3]![0].idempotencyKey).toBe(`job.closed:${JOB_ID}`);
    expect(emit.mock.calls[3]![0].payload.reason).toBe("filled");

    assertNoTitleInEvents(emit, draftJob().title);
  });

  it("activate honours an applicantQuota override and a custom introDays", async () => {
    const { svc, emit } = make(draftJob({ vacancyCount: 5 }));
    const activated = await svc.activate(
      JOB_ID,
      { applicantQuota: 10, postingFeeInr: 499, introDays: 7 },
      CTX as never,
    );
    expect(activated.applicantQuota).toBe(10);
    expect(activated.postingFeeInr).toBe(499);
    const event = emit.mock.calls[0]![0];
    expect(event.payload.applicant_quota).toBe(10);
    expect(event.payload.posting_fee_inr).toBe(499);
  });
});

describe("JobsService invalid transitions (409)", () => {
  it("activate fails on a non-draft job and does not emit", async () => {
    const { svc, emit } = make(draftJob({ status: "active" }));
    await expect(svc.activate(JOB_ID, {}, CTX as never)).rejects.toBeInstanceOf(ConflictException);
    expect(emit).not.toHaveBeenCalled();
  });

  it("pause fails when not active", async () => {
    const { svc, emit } = make(draftJob({ status: "draft" }));
    await expect(svc.pause(JOB_ID, CTX as never)).rejects.toBeInstanceOf(ConflictException);
    expect(emit).not.toHaveBeenCalled();
  });

  it("resume fails when not paused", async () => {
    const { svc, emit } = make(draftJob({ status: "active" }));
    await expect(svc.resume(JOB_ID, CTX as never)).rejects.toBeInstanceOf(ConflictException);
    expect(emit).not.toHaveBeenCalled();
  });

  it("close fails when already closed", async () => {
    const { svc, emit } = make(draftJob({ status: "closed" }));
    await expect(svc.close(JOB_ID, { reason: "manual" }, CTX as never)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(emit).not.toHaveBeenCalled();
  });

  it("boost fails when closed", async () => {
    const { svc, emit } = make(draftJob({ status: "closed" }));
    await expect(
      svc.boost(JOB_ID, { boostTier: "standard" }, CTX as never),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(emit).not.toHaveBeenCalled();
  });

  it("recordApplicants fails when not active", async () => {
    const { svc, emit } = make(draftJob({ status: "paused" }));
    await expect(svc.recordApplicants(JOB_ID, { count: 1 }, CTX as never)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(emit).not.toHaveBeenCalled();
  });

  it("getOrThrow / activate 404 when the job is missing", async () => {
    const { svc } = make(draftJob());
    // Make the repo report no row.
    (svc as unknown as { jobs: { findById: ReturnType<typeof vi.fn> } }).jobs.findById = vi
      .fn()
      .mockResolvedValue(undefined);
    await expect(svc.getOrThrow(JOB_ID)).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe("JobsService auto-pause at quota", () => {
  it("crossing the quota flips to paused + emits job.paused reason=quota_reached (no key)", async () => {
    // active job, quota 6, already 5 received → +1 hits the quota.
    const { svc, emit, getRow } = make(
      draftJob({ status: "active", applicantQuota: 6, applicantsReceivedCount: 5 }),
    );

    const updated = await svc.recordApplicants(JOB_ID, { count: 1 }, CTX as never);
    expect(updated.applicantsReceivedCount).toBe(6);
    expect(updated.status).toBe("paused");
    expect(updated.pauseReason).toBe("quota_reached");
    expect(getRow().status).toBe("paused");

    expect(emittedNames(emit)).toEqual(["job.paused"]);
    const event = emit.mock.calls[0]![0];
    expect(event.event_name).toBe("job.paused");
    expect(event.payload.reason).toBe("quota_reached");
    expect(event.payload.applicants_received_count).toBe(6);
    expect(event.payload.applicant_quota).toBe(6);
    expect(event.idempotencyKey).toBeUndefined();
    assertNoTitleInEvents(emit, draftJob().title);
  });

  it("below quota: increments silently with NO event", async () => {
    const { svc, emit, getRow } = make(
      draftJob({ status: "active", applicantQuota: 6, applicantsReceivedCount: 1 }),
    );
    const updated = await svc.recordApplicants(JOB_ID, { count: 2 }, CTX as never);
    expect(updated.applicantsReceivedCount).toBe(3);
    expect(updated.status).toBe("active");
    expect(getRow().status).toBe("active");
    expect(emit).not.toHaveBeenCalled();
  });

  it("null quota never auto-pauses", async () => {
    const { svc, emit } = make(
      draftJob({ status: "active", applicantQuota: null, applicantsReceivedCount: 100 }),
    );
    const updated = await svc.recordApplicants(JOB_ID, { count: 50 }, CTX as never);
    expect(updated.applicantsReceivedCount).toBe(150);
    expect(updated.status).toBe("active");
    expect(emit).not.toHaveBeenCalled();
  });
});

describe("JobsService.boost", () => {
  it("sets boost tier + expiry and emits job.boosted (no key) on an active job", async () => {
    const { svc, emit } = make(draftJob({ status: "active" }));
    const updated = await svc.boost(
      JOB_ID,
      { boostTier: "premium", boostDurationDays: 14 },
      CTX as never,
    );
    expect(updated.boostTier).toBe("premium");
    expect(updated.boostExpiresAt).toBeInstanceOf(Date);
    const event = emit.mock.calls[0]![0];
    expect(event.event_name).toBe("job.boosted");
    expect(event.payload.boost_tier).toBe("premium");
    expect(event.payload.boost_expires_at).toEqual(expect.any(String));
    expect(event.idempotencyKey).toBeUndefined();
  });

  it("omitting duration leaves boost_expires_at null", async () => {
    const { svc, emit } = make(draftJob({ status: "draft" }));
    const updated = await svc.boost(JOB_ID, { boostTier: "standard" }, CTX as never);
    expect(updated.boostExpiresAt).toBeNull();
    expect(emit.mock.calls[0]![0].payload.boost_expires_at).toBeNull();
  });
});
