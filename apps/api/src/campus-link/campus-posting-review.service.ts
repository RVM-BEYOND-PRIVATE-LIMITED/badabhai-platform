import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import type { PayloadInputOf } from "@badabhai/event-schema";
import {
  RVM_INSTITUTE_CODE,
  audienceReachesRvmStudents,
  type Database,
  type RvmTargetingKind,
} from "@badabhai/db";
import type { z } from "zod";
import { isCanonicalUuid } from "../common/uuid";
import { EventsService } from "../events/events.service";
import { FeatureRolloutService } from "../feature-rollout/feature-rollout.service";
import { PostingAudienceRepository } from "../job-postings/posting-audience.repository";
import { PayerTenantScopeService } from "../payers/payer-tenant-scope.service";
import type { CampusCall } from "./campus-call";
import { assertCampusTime } from "./campus-clock";
import {
  CAMPUS_MAX_CLOCK_SKEW_MS,
  type CampusErrorCode,
  type CampusReviewBodySchema,
  type CampusReviewResponseSchema,
} from "./campus-link.contract";
import {
  CampusPostingReviewRepository,
  type DecisionWrite,
  type ReviewTarget,
} from "./campus-posting-review.repository";
import { cleanReviewReason } from "./campus-review-reason";

/** The parsed body of `PUT job-postings/:id/review`. */
export type CampusReviewDecision = z.output<typeof CampusReviewBodySchema>;

/** The answer to `PUT job-postings/:id/review`. */
export type CampusReviewResult = z.input<typeof CampusReviewResponseSchema>;

/** The house neutral 404: nothing in it says whether the posting exists. */
function neutralNotFound(): NotFoundException {
  return new NotFoundException();
}

/** A 409 with the Campus `error.code`. */
function campusConflict(code: CampusErrorCode): ConflictException {
  return new ConflictException({ code });
}

/** Sorted and de-duplicated, so the stored narrowing (and a replay's comparison) is canonical. */
function canonical<T extends number | string>(ids: readonly T[]): T[] {
  return [...new Set(ids)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Can this posting be reviewed at all? Anything else is the neutral 404. */
function reviewable(target: ReviewTarget): target is ReviewTarget & { ownerPayerId: string } {
  return target.status !== "draft" && !target.hidden && target.ownerPayerId !== null;
}

/**
 * #2746 PR 5 — THE PLACEMENT TEAM REVIEWS THE RVM PART OF A POSTING (`PUT job-postings/:id/review`,
 * mounted only behind `CampusServiceGuard`).
 *
 * WHICH POSTINGS. A `decided_at` before `CAMPUS_EARLIEST_DECISION_TIME` or more than
 * `CAMPUS_MAX_CLOCK_SKEW_MS` ahead of BadaBhai's clock is 400 `VALIDATION_FAILED` before anything
 * is read. Neutral 404 (no `code`, no hint that the posting
 * exists): an id that is not a posting, a draft, a hidden posting, a posting with no owning company
 * (ops postings, agency twins), and every posting while `job_audience` is not live for its owner —
 * globally off, in `pilot` with the owner off the list, or tenancy not resolving the owner without
 * a write (`CAMPUS_LINK_ENABLED` off is the guard's 404). Then, under the posting's row lock:
 * 409 `AUDIENCE_EXCLUDES_RVM` for a BadaBhai-only audience, 409 `POSTING_NOT_OPEN` for a CLOSED
 * posting.
 *
 * CLOSED IS REFUSED, PAUSED AND SUSPENDED ARE NOT. `closed` is terminal (no edit, no reopen), so a
 * decision on it could never reach a student. A paused or suspended posting returns to `open` with
 * the same content, so its decision is kept and holds then.
 *
 * THE NEWEST DECISION WINS, BY `decided_at` (owner decision 2026-11-14), checked on the review row
 * under its lock, BEFORE the content hash:
 *   1. the same `decided_at` and the same decision (state, reviewer, reason, narrowing, hash) as
 *      the row holds: a replay — 200 with the stored decision, nothing written; but only while
 *      that decision still holds (its hash is the posting's hash now), else 409 `POSTING_CHANGED`;
 *   2. the same `decided_at` with anything different, an older one, or — on a row that was
 *      ALREADY pending — one older than when it became pending (`updated_at`) by more than
 *      `CAMPUS_MAX_CLOCK_SKEW_MS`: 409 `DECISION_SUPERSEDED`. That last floor is what stops a lost
 *      decision landing after a company edit reset the row and then restored the content
 *      (A→B→A, risk R84, closed); a row this call creates is exempt, so a first decision applies;
 *   3. the body's `content_hash` not the posting's hash now: 409 `POSTING_CHANGED`.
 * Time first: a decision older than the one held is obsolete whatever the content did, and saying
 * so stops Campus re-reviewing it; a current decision on changed content is then `POSTING_CHANGED`.
 * A write needs both to pass, and the write statement re-checks both, so neither can let the
 * other's stale case through. Inside the floor's 60 s tolerance a pending row's only guard is the
 * hash: the window R84's closure records.
 *
 * NARROWING. A narrowed `branch_ids` / `course_ids` replaces the posting's own for RVM students.
 * Each id must be within the posting's own list; when that list is `[]` (every branch / course),
 * each must be an ACTIVE `rvm_targeting_options` row of the kind instead. Otherwise 400
 * `VALIDATION_FAILED`. On a rejection the narrowing is validated and stored the same way, because
 * `jpir_decision_chk` allows it on either decision; it has no effect while the posting is rejected.
 *
 * THE WRITE: one transaction, posting `FOR SHARE` → review row ensured and `FOR UPDATE` → the
 * checks above → the state a reader saw, in its own statement → one guarded upsert storing
 * `decided_at` as `reviewed_at` and the hash it computes (`CampusPostingReviewRepository`, lock
 * order there). A decision that changed the row emits `job_posting.rvm_reviewed` v1 and writes its
 * `audit_logs` row (actor = `reviewer_ref`) in the same transaction. The `Idempotency-Key` is
 * required and checked, not stored: the same body again is the replay above. `job_reach` is never
 * touched: the RVM review does not change who among BadaBhai workers sees the posting.
 *
 * LOGS AND EVENTS CARRY IDS AND ENUMS: never the reason text, which goes to the review row alone.
 */
@Injectable()
export class CampusPostingReviewService {
  private readonly logger = new Logger(CampusPostingReviewService.name);

  constructor(
    private readonly repo: CampusPostingReviewRepository,
    private readonly options: PostingAudienceRepository,
    private readonly rollout: FeatureRolloutService,
    private readonly tenancy: PayerTenantScopeService,
    private readonly events: EventsService,
  ) {}

  async review(
    postingId: string,
    decision: CampusReviewDecision,
    call: CampusCall,
  ): Promise<CampusReviewResult> {
    // The body first: a time from BadaBhai's future would outrank every later decision.
    assertCampusTime("decided_at", decision.decided_at);
    // A malformed id cannot name a posting: the same 404 as an unknown one, before any read.
    if (!isCanonicalUuid(postingId)) throw neutralNotFound();
    // Off everywhere: no read at all. In `pilot` this is true for every company; the owner check
    // below is the pilot-list read.
    if (!this.rollout.isLiveForServiceCaller("job_audience")) throw neutralNotFound();

    const id = postingId.toLowerCase();
    const target = await this.repo.findTarget(id);
    if (target === undefined || !reviewable(target)) throw neutralNotFound();
    // Before the transaction: the tenancy and pilot reads use their own connections, and a
    // transaction holding a pool connection while waiting for another can starve the pool.
    if (!(await this.liveForOwner(target.ownerPayerId))) throw neutralNotFound();

    const reason = cleanReviewReason(decision.reason) ?? null;
    const write: DecisionWrite = {
      jobPostingId: id,
      state: decision.state,
      reviewerRef: decision.reviewer_ref.toLowerCase(),
      reason,
      branchIds: decision.branch_ids === undefined ? null : canonical(decision.branch_ids),
      courseIds: decision.course_ids === undefined ? null : canonical(decision.course_ids),
      expectedContentHash: decision.content_hash,
      decidedAt: decision.decided_at,
    };

    return this.repo.withTransaction(async (tx) => {
      const locked = await this.repo.lockTarget(id, tx);
      // Re-checked under the lock: a posting hidden (or re-owned) since the pre-check is a 404.
      if (
        locked === undefined ||
        !reviewable(locked) ||
        locked.ownerPayerId !== target.ownerPayerId
      ) {
        throw neutralNotFound();
      }
      if (!audienceReachesRvmStudents(locked.audience)) {
        throw campusConflict("AUDIENCE_EXCLUDES_RVM");
      }
      if (locked.status === "closed") throw campusConflict("POSTING_NOT_OPEN");

      // The review row, AFTER the posting (the house lock order), created pending if missing.
      // The skew bound is also the floor's tolerance for a decision made just before a reset.
      const held = await this.repo.lockReview(tx, write, CAMPUS_MAX_CLOCK_SKEW_MS);
      // 1–2. Time first (see the class note).
      if (held.timing === "same" && held.sameDecision) {
        // The replay answers the held decision only while it still holds: its stored hash (the
        // body's, by `sameDecision`) is the posting's hash NOW. A writer that changed the content
        // without a reset (an ops edit, a hand edit, a hash version bump) leaves a decision that
        // reads pending; the replay then says so the way any stale body is told: POSTING_CHANGED.
        if (locked.contentHash !== write.expectedContentHash) {
          this.logOutcome(id, write.state, "posting_changed");
          throw campusConflict("POSTING_CHANGED");
        }
        this.logOutcome(id, write.state, "unchanged");
        return { posting_id: id, review_state: held.state, reviewed_at: write.decidedAt };
      }
      if (held.timing === "same" || held.timing === "older" || held.timing === "before_reset") {
        this.logOutcome(id, write.state, "superseded");
        throw campusConflict("DECISION_SUPERSEDED");
      }
      // 3. Then the content.
      if (locked.contentHash !== write.expectedContentHash) {
        this.logOutcome(id, write.state, "posting_changed");
        throw campusConflict("POSTING_CHANGED");
      }
      await this.assertNarrowing("branch", write.branchIds, locked.rvmBranchIds, tx);
      await this.assertNarrowing("course", write.courseIds, locked.rvmCourseIds, tx);

      // Its own statement, after the row lock: a fresh snapshot that sees the decision committed
      // by whoever held the lock before us.
      const previousState = await this.repo.reviewStateNow(id, tx);
      const written = await this.repo.writeDecision(tx, write);
      switch (written.outcome) {
        case "missing":
          throw neutralNotFound();
        case "posting_changed":
          // Impossible under the posting's FOR SHARE lock; refused the same way if it happens.
          this.logOutcome(id, write.state, "posting_changed");
          throw campusConflict("POSTING_CHANGED");
        case "not_applied":
          // Impossible under the review row's FOR UPDATE lock; refused the same way if it happens.
          this.logOutcome(id, write.state, "superseded");
          throw campusConflict("DECISION_SUPERSEDED");
        case "written":
          await this.record(tx, write, previousState, written.contentHash, call);
          this.logOutcome(id, write.state, "written");
          return { posting_id: id, review_state: write.state, reviewed_at: write.decidedAt };
      }
    });
  }

  /**
   * Is `job_audience` live for the posting's OWNER? The owner's tenant key comes from
   * `PayerTenantScopeService.resolveReadOnly`: the same decision a request by that company makes,
   * but it never heals or creates a solo org, so a Campus call writes no tenancy row. No key (no
   * membership, a denial) fails closed as "not live".
   */
  private async liveForOwner(owner: string): Promise<boolean> {
    const scope = await this.tenancy.resolveReadOnly(owner);
    if (scope === null) return false;
    return this.rollout.isEnabledFor("job_audience", scope.tenantKey);
  }

  /** 400 `VALIDATION_FAILED` unless every narrowed id is within the posting's own targeting. */
  private async assertNarrowing(
    kind: RvmTargetingKind,
    narrowed: readonly (number | string)[] | null,
    own: readonly (number | string)[],
    tx: Database,
  ): Promise<void> {
    if (narrowed === null) return;
    const refs = narrowed.map(String);
    let outside: string[];
    if (own.length > 0) {
      const held = new Set(own.map(String));
      outside = refs.filter((ref) => !held.has(ref));
    } else {
      // `[]` = every branch / course: each id must then be one Campus currently offers.
      const active = await this.options.activeOptionRefs(kind, refs, tx);
      outside = refs.filter((ref) => !active.has(ref));
    }
    if (outside.length === 0) return;
    // Reference ids (RVM location / Scheduler course ids), never personal data: safe to name.
    throw new BadRequestException({
      code: "VALIDATION_FAILED" satisfies CampusErrorCode,
      message: "Validation failed",
      issues: [
        {
          path: `${kind}_ids`,
          message: `not within the posting's own ${kind} targeting: ${outside.join(", ")}`,
        },
      ],
    });
  }

  /** `job_posting.rvm_reviewed` and the decision's audit row, on the decision's transaction. */
  private async record(
    tx: Database,
    write: DecisionWrite,
    previousState: PayloadInputOf<"job_posting.rvm_reviewed">["previous_state"],
    contentHash: string,
    call: CampusCall,
  ): Promise<void> {
    const payload: PayloadInputOf<"job_posting.rvm_reviewed"> = {
      job_posting_id: write.jobPostingId,
      institute_code: RVM_INSTITUTE_CODE,
      state: write.state,
      previous_state: previousState,
      reviewer_ref: write.reviewerRef,
      decided_at: write.decidedAt,
      branch_ids: write.branchIds,
      course_ids: write.courseIds,
      has_reason: write.reason !== null,
      content_hash: contentHash,
    };
    const event = await this.events.emit({
      event_name: "job_posting.rvm_reviewed",
      // Campus is a service caller, not a BadaBhai principal (#2752's events do the same); the
      // staff member is `reviewer_ref` in the payload and the audit row's actor.
      actor: { actor_type: "system", actor_id: null },
      subject: { subject_type: "job_posting", subject_id: write.jobPostingId },
      payload,
      correlationId: call.ctx.correlationId,
      requestId: call.ctx.requestId,
      tx,
    });
    await this.repo.writeAudit(tx, {
      jobPostingId: write.jobPostingId,
      reviewerRef: write.reviewerRef,
      metadata: {
        institute_code: RVM_INSTITUTE_CODE,
        state: write.state,
        previous_state: previousState,
        decided_at: write.decidedAt,
        narrowed_branch_ids: write.branchIds,
        narrowed_course_ids: write.courseIds,
        has_reason: write.reason !== null,
        content_hash: contentHash,
        campus_call_id: call.callId,
        event_id: event.event_id,
      },
    });
  }

  /** Ids and enums only. */
  private logOutcome(id: string, state: string, outcome: string): void {
    this.logger.log(`campus review: posting=${id} state=${state} outcome=${outcome}`);
  }
}
