import "reflect-metadata";
import { describe, it, expect, vi } from "vitest";
import { NotFoundException } from "@nestjs/common";
import type { RequestContext } from "../common/request-context";
import type { EventsService } from "../events/events.service";
import { ApplicationsService } from "./applications.service";
import type { ApplicationsRepository } from "./applications.repository";
import type { RankSnapshot } from "../match/match-apply.service";

/**
 * ADR-0036 MOMENTS ④ AND ⑤ — the same `/feed`, `/apply`, `/skip` routes, with
 * `MATCH_V1_ENABLED` **TRUE**.
 *
 * The sibling `applications.service.test.ts` covers this class with the flag OFF and
 * asserts the V1 collaborators are never touched. This file is its mirror: every case
 * runs with the flag ON, and asserts the LEGACY collaborators are never touched. The
 * pair is the cutover contract — one route, two sources, and nothing in between.
 *
 * WHY THIS PATH DESERVES ITS OWN SUITE. Moment ⑤ is the one irreversible write in V1:
 * `application.match_tier / skill_months / industry_months / last_worked_at /
 * engine_version` are snapshotted at apply and FROZEN (E16). Three things here fail
 * silently if they regress, and all three are asserted below:
 *
 *   1. the reach row is the GATE — an ungated apply must never reach the write, and the
 *      404 must be indistinguishable from "no such posting" (no existence oracle);
 *   2. the snapshot handed to `upsertDecision` is the one `buildSnapshot` computed, not
 *      a re-derivation and not a null;
 *   3. the event's SUBJECT names `job_posting`, not `job`. The shipped `job_id` payload
 *      field carries a `job_postings.id` on this path, and the ENVELOPE is the only
 *      thing that says which id space it is — get it wrong and the audit spine
 *      silently mixes two id spaces under one name (invariant #1 is about a TRUE audit).
 */

const CTX: RequestContext = { correlationId: "corr-1", requestId: "req-1" };
const WORKER = "11111111-1111-4111-8111-111111111111";
const POSTING = "22222222-2222-4222-8222-222222222222";
const APP_ID = "33333333-3333-4333-8333-333333333333";

const SNAPSHOT: RankSnapshot = {
  matchTier: 2,
  skillMonths: 60,
  industryMonths: 72,
  lastWorkedAt: null,
  engineVersion: "v1.0",
};

function setup(opts: { existing?: { id: string; action: string } | undefined } = {}) {
  // The legacy collaborators. NOTHING on the V1 path may call these — the legacy
  // `jobs` table is not the served entity any more, and touching it would 404 a valid
  // posting (or, worse, bump a counter on an unrelated row in another id space).
  const repo = {
    findJobById: vi.fn(async () => undefined),
    findOpenJobs: vi.fn(async () => []),
    findDecision: vi.fn(async () => undefined),
    upsertDecision: vi.fn(),
    incrementApplicantsReceived: vi.fn(),
    findApplicantsByJob: vi.fn(async () => []),
    findApplicationsByWorker: vi.fn(async () => []),
  };
  const events = {
    emit: vi.fn(async (p: Record<string, unknown>) => p),
    emitMany: vi.fn(async (l: unknown[]) => l),
  };
  const matchFeed = { getFeed: vi.fn(async () => ({ jobs: [] })) };
  const matchApply = {
    buildSnapshot: vi.fn(async () => SNAPSHOT),
    findDecision: vi.fn(async () => opts.existing),
    upsertDecision: vi.fn(async (_input: Record<string, unknown>) => ({
      applicationId: APP_ID,
      inserted: true,
      flippedToApplied: false,
      snapshot: SNAPSHOT,
    })),
  };
  const svc = new ApplicationsService(
    repo as unknown as ApplicationsRepository,
    events as unknown as EventsService,
    matchFeed as never,
    matchApply as never,
    { MATCH_V1_ENABLED: true } as never,
  );
  return { svc, repo, events, matchFeed, matchApply };
}

/** Every legacy repository method that must stay untouched on the V1 path. */
function expectLegacyUntouched(repo: ReturnType<typeof setup>["repo"]) {
  expect(repo.findJobById, "legacy jobs lookup").not.toHaveBeenCalled();
  expect(repo.upsertDecision, "legacy applications upsert").not.toHaveBeenCalled();
  expect(repo.incrementApplicantsReceived, "legacy jobs counter").not.toHaveBeenCalled();
  expect(repo.findDecision, "legacy decision read").not.toHaveBeenCalled();
}

describe("getFeed with MATCH_V1_ENABLED — the source moves, the envelope does not", () => {
  it("serves from job_reach ⋈ job_postings and never scans the legacy jobs table", async () => {
    const { svc, repo, matchFeed } = setup();
    await svc.getFeed(WORKER, 10, { city: "Pune", shift: "night", payMin: 20000 }, CTX);

    expect(matchFeed.getFeed).toHaveBeenCalledOnce();
    expect(repo.findOpenJobs).not.toHaveBeenCalled();
  });

  it("does NOT forward trade_key — V1 has no trade dimension (Part 3)", async () => {
    const { svc, matchFeed } = setup();
    await svc.getFeed(WORKER, 10, { tradeKey: "cnc_operator", city: "Pune" }, CTX);

    // Reach ALREADY restricts the feed to skills the worker holds and wants. Layering a
    // legacy trade slug on top would be a second, weaker skill filter narrowing a feed
    // that the real gate already decided — "a filter must never narrow by default".
    expect(matchFeed.getFeed).toHaveBeenCalledWith(
      WORKER,
      10,
      { city: "Pune", shift: undefined, payMin: undefined },
      CTX,
    );
  });
});

describe("apply on the V1 path — the reach row is the gate (moment ⑤)", () => {
  it("builds the snapshot BEFORE anything is written, and writes nothing when it 404s", async () => {
    const { svc, repo, events, matchApply } = setup();
    matchApply.buildSnapshot.mockRejectedValueOnce(new NotFoundException("Job not found"));

    await expect(svc.apply(WORKER, POSTING, { rank: 3, source_surface: "feed" }, CTX)).rejects.toThrow(
      "Job not found",
    );
    // An apply that failed the gate must leave NO row and NO event: the worker was
    // never shown this posting, and a stored decision would put him in a paid
    // candidate list for a vacancy he was gated out of.
    expect(matchApply.upsertDecision).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();
    expectLegacyUntouched(repo);
  });

  it("hands upsertDecision the EXACT snapshot buildSnapshot produced (E16)", async () => {
    const { svc, matchApply } = setup();
    await svc.apply(WORKER, POSTING, { rank: 3, source_surface: "feed" }, CTX);

    expect(matchApply.buildSnapshot).toHaveBeenCalledWith(WORKER, POSTING);
    // Passing `null` here — or recomputing — would store an application with no rank
    // inputs. The list still renders; it is just ordered by columns nobody filled in,
    // and the row is unreplayable forever because the snapshot is frozen on write.
    expect(matchApply.upsertDecision).toHaveBeenCalledWith({
      workerId: WORKER,
      jobPostingId: POSTING,
      action: "applied",
      reason: null,
      sourceSurface: "feed",
      rank: 3,
      snapshot: SNAPSHOT,
      previousAction: null,
    });
  });

  it("carries the PREVIOUS action through, so the DB can tell a flip from a double-tap", async () => {
    const { svc, matchApply } = setup({ existing: { id: APP_ID, action: "skipped" } });
    await svc.apply(WORKER, POSTING, { rank: 1, source_surface: "feed" }, CTX);

    // `previousAction` is what drives the ON CONFLICT CASE that writes the snapshot on a
    // skip→apply flip and preserves it on a re-apply. Hard-coding null here would make
    // every apply look like a first apply.
    expect(matchApply.upsertDecision.mock.calls[0]![0]).toMatchObject({
      previousAction: "skipped",
    });
  });

  it("emits application.submitted with subject_type JOB_POSTING, not job", async () => {
    const { svc, events } = setup();
    await svc.apply(WORKER, POSTING, { rank: 3, source_surface: "feed" }, CTX);

    const ev = events.emit.mock.calls[0]![0];
    expect(ev.event_name).toBe("application.submitted");
    expect(ev.actor).toEqual({ actor_type: "worker", actor_id: WORKER });
    // THE disambiguator. `payload.job_id` is a `job_postings.id` on this path and a
    // `jobs.id` on the legacy one; only the envelope says which. Emitting
    // `subject_type: "job"` here would make the two id spaces indistinguishable in the
    // spine, and the LEARN corpus would join across them.
    expect(ev.subject).toEqual({ subject_type: "job_posting", subject_id: POSTING });
    expect(ev.payload).toEqual({
      worker_id: WORKER,
      job_id: POSTING,
      rank: 3,
      source_surface: "feed",
    });
    expect(ev.idempotencyKey).toBe(`application.submitted:${WORKER}:${POSTING}`);
    expect(ev.correlationId).toBe(CTX.correlationId);
    expect(ev.requestId).toBe(CTX.requestId);
  });

  it("returns the application id the V1 writer reported", async () => {
    const { svc } = setup();
    expect(await svc.apply(WORKER, POSTING, { rank: 3, source_surface: "feed" }, CTX)).toEqual({
      ok: true,
      application_id: APP_ID,
      action: "applied",
    });
  });

  it("never touches the legacy jobs table or its denormalized counter", async () => {
    const { svc, repo } = setup();
    await svc.apply(WORKER, POSTING, { rank: 3, source_surface: "feed" }, CTX);
    // `applicants_received` lives on `jobs`, keyed in a DIFFERENT id space. Bumping it
    // with a `job_postings.id` would increment an unrelated row, or none at all.
    expectLegacyUntouched(repo);
  });
});

describe("skip on the V1 path — same gate, no snapshot, no downgrade", () => {
  it("applies the reach gate to a SKIP too (no existence oracle by swiping left)", async () => {
    const { svc, events, matchApply } = setup();
    matchApply.buildSnapshot.mockRejectedValueOnce(new NotFoundException("Job not found"));

    await expect(svc.skip(WORKER, POSTING, { reason: "too_far" }, CTX)).rejects.toThrow(
      "Job not found",
    );
    // If skip were ungated while apply was gated, a client could enumerate the whole
    // board by skipping ids and reading which ones 404.
    expect(matchApply.upsertDecision).not.toHaveBeenCalled();
    expect(events.emit).not.toHaveBeenCalled();
  });

  it("writes a NULL snapshot — a skip is never ranked", async () => {
    const { svc, matchApply } = setup();
    await svc.skip(WORKER, POSTING, { reason: "low_pay" }, CTX);

    // `applications_rank_idx` is partial on `action='applied'`. Freezing rank inputs on
    // a skip would store numbers no reader consumes AND would then have to be protected
    // from rewrite on the flip to apply — which is exactly when the real snapshot is due.
    expect(matchApply.upsertDecision).toHaveBeenCalledWith({
      workerId: WORKER,
      jobPostingId: POSTING,
      action: "skipped",
      reason: "low_pay",
      sourceSurface: "feed",
      rank: null,
      snapshot: null,
      previousAction: null,
    });
  });

  it("TD73 — an APPLIED row is never downgraded to skipped", async () => {
    const { svc, events, matchApply } = setup({ existing: { id: APP_ID, action: "applied" } });
    const out = await svc.skip(WORKER, POSTING, { reason: "too_far" }, CTX);

    // A stray skip (a >500-decision upsert overwrite, a double swipe) must not erase a
    // real application the company may already have paid to unlock.
    expect(out).toEqual({ ok: true, application_id: APP_ID, action: "applied" });
    expect(matchApply.upsertDecision).not.toHaveBeenCalled();
    // ...and it must not emit a skip event for a decision that did not change.
    expect(events.emit).not.toHaveBeenCalled();
  });

  it("a previously SKIPPED row is re-skipped normally (only 'applied' is protected)", async () => {
    const { svc, matchApply } = setup({ existing: { id: APP_ID, action: "skipped" } });
    await svc.skip(WORKER, POSTING, { reason: "too_far" }, CTX);
    expect(matchApply.upsertDecision).toHaveBeenCalledOnce();
    expect(matchApply.upsertDecision.mock.calls[0]![0]).toMatchObject({
      previousAction: "skipped",
    });
  });

  it("emits application.skipped against the posting subject, with the coarse reason", async () => {
    const { svc, events } = setup();
    await svc.skip(WORKER, POSTING, { reason: "too_far" }, CTX);

    const ev = events.emit.mock.calls[0]![0];
    expect(ev.event_name).toBe("application.skipped");
    expect(ev.subject).toEqual({ subject_type: "job_posting", subject_id: POSTING });
    // A coarse enum, never free text — §2: no worker prose on the audit spine.
    expect(ev.payload).toEqual({ worker_id: WORKER, job_id: POSTING, reason: "too_far" });
    expect(ev.idempotencyKey).toBe(`application.skipped:${WORKER}:${POSTING}`);
  });

  it("returns the id the V1 writer reported and never touches the legacy table", async () => {
    const { svc, repo } = setup();
    expect(await svc.skip(WORKER, POSTING, { reason: "too_far" }, CTX)).toEqual({
      ok: true,
      application_id: APP_ID,
      action: "skipped",
    });
    expectLegacyUntouched(repo);
  });
});
